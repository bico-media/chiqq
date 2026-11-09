export interface Configuration {
	concurrency?: number;
	taskDelay?: number;
	paused?: boolean;
	retryMax?: number;
	retryCooling?: number;
	retryFactor?: number;
}

export interface ConfigTask {
	taskDelay?: number;
	retryMax?: number;
	retryCooling?: number;
	retryFactor?: number;
	addAsFirst?: boolean;
}

export interface ConfigBatch<T = unknown> extends ConfigTask {
	/** Called each time a task of the batch succeeds, with its position in the array. */
	onSuccess?: (value: T, index: number) => void;
	/**
	 * Called when a task of the batch fails after its last retry, or is cleared.
	 * With this set, failures don't reject the batch: it resolves once every
	 * task is done, with `undefined` at the failed positions.
	 */
	onError?: (error: unknown, index: number) => void;
}

interface ResolvedConfig {
	taskDelay: number;
	retryMax: number;
	retryCooling: number;
	retryFactor: number;
}

// Collects the results of addAll(): one promise for the whole batch.
class Batch {
	results: unknown[];
	left: number;
	done = false;
	resolve!: (value: unknown[]) => void;
	reject!: (reason?: unknown) => void;
	promise: Promise<unknown[]>;
	onSuccess: ((value: unknown, index: number) => void) | undefined;
	onError: ((error: unknown, index: number) => void) | undefined;

	constructor(n: number, conf: ConfigBatch | undefined) {
		this.results = new Array(n);
		this.left = n;
		this.onSuccess = conf?.onSuccess;
		this.onError = conf?.onError;
		this.promise = new Promise((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
		});
	}

	finishOne() {
		if (--this.left === 0 && !this.done) {
			this.done = true;
			this.resolve(this.results);
		}
	}
}

// Calls a user callback without letting a throw stall the queue: the error is
// rethrown on its own, like a throw from the onError() handler.
function callSafe<A, B>(cb: (a: A, b: B) => void, a: A, b: B) {
	try {
		cb(a, b);
	} catch (e) {
		queueMicrotask(() => {
			throw e;
		});
	}
}

// Stand in for resolve and reject on items of a batch. Chiqq always calls them
// as methods (item.resolve(value)), so `this` is the item.
function batchResolve(this: BatchItem, value: unknown) {
	const batch = this.batch;
	batch.results[this.index] = value;
	if (batch.onSuccess) callSafe(batch.onSuccess, value, this.index);
	batch.finishOne();
}

function batchReject(this: BatchItem, reason: unknown) {
	const batch = this.batch;
	if (batch.onError) {
		callSafe(batch.onError, reason, this.index);
		batch.finishOne();
	} else if (!batch.done) {
		batch.done = true;
		batch.reject(reason);
	}
}

// A class, not an object literal, so every item has the same shape from the start.
class QueueItem<T = unknown> {
	task: () => T | Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
	conf: ResolvedConfig;
	promise: Promise<T>;
	retried = 0;

	constructor(
		task: () => T | Promise<T>,
		resolve: (value: T) => void,
		reject: (reason?: unknown) => void,
		conf: ResolvedConfig,
		promise: Promise<T>
	) {
		this.task = task;
		this.resolve = resolve;
		this.reject = reject;
		this.conf = conf;
		this.promise = promise;
	}
}

// An item of an addAll() batch: the fields of QueueItem plus two of its own.
// A separate class rather than a subclass, so items from add() don't carry the
// extra fields, and without the cost of a super() call.
class BatchItem {
	task: () => unknown;
	resolve: (value: unknown) => void;
	reject: (reason?: unknown) => void;
	conf: ResolvedConfig;
	promise: Promise<unknown>;
	retried = 0;
	batch: Batch;
	index: number;

	constructor(task: () => unknown, conf: ResolvedConfig, batch: Batch, index: number) {
		this.task = task;
		this.resolve = batchResolve;
		this.reject = batchReject;
		this.conf = conf;
		this.promise = batch.promise;
		this.batch = batch;
		this.index = index;
	}
}

// One shared promise executor instead of a new closure per task: it hands
// resolve and reject over to add() through these two variables.
let nextResolve: (value: never) => void;
let nextReject: (reason?: unknown) => void;
const capture = (resolve: (value: never) => void, reject: (reason?: unknown) => void) => {
	nextResolve = resolve;
	nextReject = reject;
};

interface PendingRetryEntry {
	payload: QueueItem;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * FIFO ring buffer. head and tail only count up (unshift counts head down),
 * and the slot is the counter masked by the power-of-two capacity. Grows by
 * doubling when full, and drops back to a small array when it runs empty.
 */
class TaskQueue<T> {
	private items: (T | undefined)[] = new Array(16);
	private mask = 15;
	private head = 0;
	private tail = 0;

	get length(): number {
		return this.tail - this.head;
	}

	push(item: T) {
		if (this.tail - this.head > this.mask) this.grow();
		this.items[this.tail++ & this.mask] = item;
	}

	unshift(item: T) {
		if (this.tail - this.head > this.mask) this.grow();
		this.items[--this.head & this.mask] = item;
	}

	peek(): T | undefined {
		return this.head === this.tail ? undefined : this.items[this.head & this.mask];
	}

	shift(): T | undefined {
		if (this.head === this.tail) return undefined;
		const slot = this.head++ & this.mask;
		const item = this.items[slot];
		this.items[slot] = undefined;
		if (this.head === this.tail) {
			this.head = this.tail = 0;
			if (this.mask > 1023) {
				this.items = new Array(16);
				this.mask = 15;
			}
		}
		return item;
	}

	drain(): T[] {
		const out: T[] = [];
		while (this.head !== this.tail) out.push(this.shift() as T);
		return out;
	}

	private grow() {
		const len = this.tail - this.head;
		const next: (T | undefined)[] = new Array(this.items.length * 2);
		for (let i = 0; i < len; i++) next[i] = this.items[(this.head + i) & this.mask];
		this.items = next;
		this.mask = next.length - 1;
		this.head = 0;
		this.tail = len;
	}
}

export interface ChiqqStatus {
	/** Paused by `pause()` or held by an upstream queue in a chain. */
	isPaused: boolean;
	/** Nothing running, waiting or waiting to be retried. */
	isIdle: boolean;
	config: {
		concurrency: number;
		taskDelay: number;
		/** max is -1 when retrying forever. */
		retry: {max: number; cooling: number; factor: number};
	};
	tasks: {
		/** active + queued */
		total: number;
		/** running right now */
		active: number;
		/** waiting to start, including pendingRetry */
		queued: number;
		/** waiting out a retry cooldown before they try again */
		pendingRetry: number;
	};
}

export class ChiqqClearedError extends Error {
	constructor(message = 'Chiqq queue cleared') {
		super(message);
		this.name = 'ChiqqClearedError';
	}
}

// setTimeout fires immediately for delays above this.
const MAX_DELAY = 2 ** 31 - 1;

const noop = () => {};

const DEFAULTS: ResolvedConfig = {taskDelay: 0, retryMax: 0, retryCooling: 50, retryFactor: 0};

function toNumber(value: unknown, fallback: number): number {
	if (value === undefined || value === null) return fallback;
	const n = Number(value);
	return Number.isNaN(n) ? fallback : n;
}

const toDelay = (value: number) => Math.min(MAX_DELAY, Math.max(0, value));

function toConcurrency(value: unknown): number {
	return Math.max(1, Math.floor(toNumber(value, 1)));
}

function resolveConfig(conf: ConfigTask, base: ResolvedConfig): ResolvedConfig {
	const retryMax = Math.floor(toNumber(conf.retryMax, base.retryMax));
	return {
		taskDelay: toDelay(toNumber(conf.taskDelay, base.taskDelay)),
		// -1 = retry forever; Infinity and any negative value mean the same.
		retryMax: retryMax < 0 || retryMax === Number.POSITIVE_INFINITY ? -1 : retryMax,
		retryCooling: toDelay(toNumber(conf.retryCooling, base.retryCooling)),
		retryFactor: Math.max(0, toNumber(conf.retryFactor, base.retryFactor)),
	};
}

const hasOverrides = (conf: ConfigTask) =>
	conf.taskDelay !== undefined ||
	conf.retryMax !== undefined ||
	conf.retryCooling !== undefined ||
	conf.retryFactor !== undefined;

export class Chiqq {
	private limit: number;
	private conf: ResolvedConfig;
	private running: number;
	private paused: boolean;
	// Set by the upstream queue in a chain, separate from the user's own pause.
	private held: boolean;
	private q: TaskQueue<QueueItem>;
	private pauseCallback: (() => void) | null;
	private completeCallback: (() => void) | null;
	private errorCallback: ((error: unknown) => void) | null;
	private idleWaiters: (() => void)[];
	private retryTimers: Set<PendingRetryEntry>;
	private chained: Chiqq | null;
	private lastStart: number;
	// Start times are only recorded once some task uses taskDelay, saving a Date.now() per task.
	private timed: boolean;
	private delayTimer: ReturnType<typeof setTimeout> | null;

	constructor(conf: Configuration = {}) {
		this.conf = resolveConfig(conf, DEFAULTS);
		this.limit = toConcurrency(conf.concurrency);
		this.paused = !!conf.paused;
		this.held = false;
		this.running = 0;
		this.q = new TaskQueue<QueueItem>();
		this.pauseCallback = null;
		this.completeCallback = null;
		this.errorCallback = null;
		this.idleWaiters = [];
		this.retryTimers = new Set();
		this.chained = null;
		this.lastStart = 0;
		this.timed = this.conf.taskDelay > 0;
		this.delayTimer = null;
	}

	private retryDelay(conf: ResolvedConfig, attempt: number): number {
		// attempt is 1-indexed (1 = first retry).
		// factor <= 1: constant cooling. factor > 1: exponential (cooling * factor^(attempt-1)).
		if (conf.retryFactor <= 1) return conf.retryCooling;
		return toDelay(conf.retryCooling * conf.retryFactor ** (attempt - 1));
	}

	// Rejects a task's promise. With an onError handler registered the promise
	// is marked as handled, so tasks nobody awaits cannot crash the process.
	private fail(item: QueueItem, error: unknown, report: boolean) {
		const cb = this.errorCallback;
		if (cb) {
			item.promise.catch(noop);
			if (report) {
				try {
					cb(error);
				} catch (e) {
					// Never let a throwing handler stall the queue.
					queueMicrotask(() => {
						throw e;
					});
				}
			}
		}
		item.reject(error);
	}

	private isDrained(): boolean {
		return this.running === 0 && this.q.length === 0 && this.retryTimers.size === 0;
	}

	private postTaskCheck() {
		if (this.pauseCallback && this.paused && this.running === 0) {
			const cb = this.pauseCallback;
			this.pauseCallback = null;
			cb();
		}
		if (this.isDrained()) {
			if (this.completeCallback) {
				const cb = this.completeCallback;
				this.completeCallback = null;
				cb();
			}
			if (this.idleWaiters.length) {
				const waiters = this.idleWaiters;
				this.idleWaiters = [];
				for (const resolve of waiters) resolve();
			}
		}
		// Chain handoff: when runnable and fully idle (pending retries do not
		// count), release the chained queue. The paused/held guard is essential so
		// a paused queue draining its in-flight task does not wake the chain.
		if (!this.paused && !this.held && this.running === 0 && this.q.length === 0) {
			this.chained?.release();
		}
	}

	// Starts the next task if a slot is free. Returns false when nothing was started.
	private tick(): boolean {
		if (this.paused || this.held || this.limit <= this.running) return false;

		const payload = this.q.peek();
		if (!payload) return false;

		if (payload.conf.taskDelay) {
			const wait = this.lastStart + payload.conf.taskDelay - Date.now();
			if (wait > 0) {
				this.delayTimer ??= setTimeout(() => {
					this.delayTimer = null;
					this.fill();
				}, wait);
				return false;
			}
		}

		this.q.shift();
		this.running++;
		if (this.timed) this.lastStart = Date.now();

		// I have work, so hold my chained queue
		if (this.chained && !this.chained.held) this.chained.hold();

		this.run(payload);
		return true;
	}

	// Runs a task without an async function, with the same timing as
	// `await payload.task()`: a throw is handled right away, a promise gets one
	// .then(), and a plain value is wrapped up on the next microtask.
	private run(payload: QueueItem) {
		let result: unknown;
		try {
			result = payload.task();
		} catch (e) {
			this.settle(payload, false, e);
			return;
		}
		let thenable: boolean;
		try {
			thenable = typeof (result as PromiseLike<unknown> | null)?.then === 'function';
		} catch {
			// A throwing `then` getter: Promise.resolve() rejects with it, like `await`.
			thenable = true;
		}
		if (thenable) {
			// Promise.resolve() returns a native promise as is, and adopts any
			// other thenable the way `await` does.
			Promise.resolve(result).then(
				value => this.settle(payload, true, value),
				error => this.settle(payload, false, error)
			);
		} else {
			queueMicrotask(() => this.settle(payload, true, result));
		}
	}

	private settle(payload: QueueItem, ok: boolean, value: unknown) {
		this.running--;
		if (ok) {
			payload.resolve(value);
		} else {
			const conf = payload.conf;
			if (conf.retryMax < 0 || payload.retried < conf.retryMax) {
				payload.retried++;
				const entry: PendingRetryEntry = {payload, timer: undefined as never};
				entry.timer = setTimeout(
					() => {
						this.retryTimers.delete(entry);
						this.q.unshift(payload);
						this.tick();
					},
					this.retryDelay(conf, payload.retried)
				);
				this.retryTimers.add(entry);
			} else {
				this.fail(payload, value, true);
			}
		}
		this.postTaskCheck();
		this.tick();
	}

	add<T = unknown>(task: () => T | Promise<T>, configObj?: ConfigTask): Promise<T> {
		return this.enqueue(task, configObj, !!configObj?.addAsFirst);
	}

	/**
	 * Adds a task at the front of the queue so it runs as soon as a slot is
	 * available, ahead of any tasks added before it. Same as `add()` with
	 * `addAsFirst: true`.
	 */
	addNext<T = unknown>(task: () => T | Promise<T>, configObj?: ConfigTask): Promise<T> {
		return this.enqueue(task, configObj, true);
	}

	/**
	 * Adds many tasks with one promise for the whole batch, which resolves with
	 * the results in the same order as `tasks`. Cheaper than calling `add()` for
	 * each task. Every task still retries on its own.
	 *
	 * Without `onError`, the batch rejects with the first error that survives
	 * its retries, like `Promise.all()`. The other tasks keep running. With
	 * `onError`, every failure goes there instead and the batch always resolves.
	 */
	addAll<T = unknown>(
		tasks: readonly (() => T | Promise<T>)[],
		configObj: ConfigBatch<T> & {onError: (error: unknown, index: number) => void}
	): Promise<(T | undefined)[]>;
	addAll<T = unknown>(
		tasks: readonly (() => T | Promise<T>)[],
		configObj?: ConfigBatch<T>
	): Promise<T[]>;
	addAll<T = unknown>(
		tasks: readonly (() => T | Promise<T>)[],
		configObj?: ConfigBatch<T>
	): Promise<(T | undefined)[]> {
		for (const task of tasks) {
			if (typeof task !== 'function') throw new Error('Please pass a function');
		}
		const conf = this.taskConf(configObj);
		const n = tasks.length;
		const batch = new Batch(n, configObj as ConfigBatch | undefined);
		if (n === 0) batch.resolve([]);
		const first = !!configObj?.addAsFirst;
		// With addAsFirst, add from the back so the batch keeps its order at the front.
		for (let k = 0; k < n; k++) {
			const i = first ? n - 1 - k : k;
			const item = new BatchItem(tasks[i], conf, batch, i);
			if (first) {
				this.q.unshift(item);
			} else {
				this.q.push(item);
			}
		}
		while (this.tick()) {}
		return batch.promise as Promise<T[]>;
	}

	private taskConf(configObj: ConfigTask | undefined): ResolvedConfig {
		const conf =
			configObj && hasOverrides(configObj) ? resolveConfig(configObj, this.conf) : this.conf;
		if (conf.taskDelay && !this.timed) {
			// First task with a delay on this queue: earlier starts were not recorded,
			// so space it from now if something is running.
			this.timed = true;
			if (this.running) this.lastStart = Date.now();
		}
		return conf;
	}

	private enqueue<T>(
		task: () => T | Promise<T>,
		configObj: ConfigTask | undefined,
		first: boolean
	): Promise<T> {
		if (typeof task !== 'function') throw new Error('Please pass a function');
		const conf = this.taskConf(configObj);
		const promise = new Promise<T>(capture);
		const item = new QueueItem<T>(
			task,
			nextResolve as (value: T) => void,
			nextReject,
			conf,
			promise
		) as QueueItem;
		if (first) {
			this.q.unshift(item);
		} else {
			this.q.push(item);
		}
		this.tick();
		return promise;
	}

	pause(callback?: () => void) {
		this.paused = true;
		this.pauseCallback = callback || null;
		// Hold the rest of the chain (cascades through empty links).
		this.chained?.hold();
		// If already idle, fire on a microtask so behavior is consistent.
		if (callback && this.running === 0) {
			this.pauseCallback = null;
			Promise.resolve().then(callback);
		}
	}

	resume() {
		this.paused = false;
		this.held = false;
		this.pauseCallback = null;
		this.fill();
	}

	private hold() {
		this.held = true;
		this.chained?.hold();
	}

	private release() {
		this.held = false;
		this.fill();
	}

	private fill() {
		if (this.paused || this.held) return;
		while (this.tick()) {}
		// If I have nothing to run, pass the baton forward so the chain flows
		// past empty links instead of stalling here.
		if (this.running === 0 && this.q.length === 0) {
			this.chained?.release();
		}
	}

	/**
	 * Links a lower-priority follower queue. While this queue has work it holds
	 * the chained queue paused; when this queue goes idle it resumes the chained
	 * queue, forming a longer prioritised queue. Pause/resume signals cascade
	 * forward through the chain, even across empty links. Links are forward-only
	 * (a chained queue has no reference to its upstream); the developer should
	 * resume only the top of the chain. Returns the chained queue so links can be
	 * built fluently: `a.chain(b).chain(c)` builds `a -> b -> c`.
	 */
	chain(queue: Chiqq): Chiqq {
		for (let link: Chiqq | null = queue; link; link = link.chained) {
			if (link === this) throw new Error('Chiqq chain would create a cycle');
		}
		this.chained = queue;
		return queue;
	}

	/**
	 * Updates the concurrency limit and immediately attempts to utilize the new capacity.
	 * If the new limit is higher than the current running tasks, additional tasks will be started.
	 * If the new limit is lower, no running tasks are interrupted - the limit will take effect
	 * as tasks complete naturally.
	 */
	setConcurrency(concurrency: number) {
		this.limit = toConcurrency(concurrency);
		this.fill();
	}

	/**
	 * Removes all queued and pending-retry tasks. Currently running tasks
	 * are not affected.
	 *
	 * - `clear()` / `clear(false)` (default): cleared tasks reject with a
	 *   `ChiqqClearedError`.
	 * - `clear(true)`: cleared tasks resolve with `null`. Use this when you
	 *   want to discard the work and don't care about results, so awaited
	 *   promises don't reject.
	 *
	 * Returns the number of tasks cleared.
	 */
	clear(silent = false): number {
		const queued = this.q.drain();
		if (this.delayTimer) {
			clearTimeout(this.delayTimer);
			this.delayTimer = null;
		}
		const retries = Array.from(this.retryTimers);
		this.retryTimers.clear();
		for (const entry of retries) clearTimeout(entry.timer);

		const all = [...queued, ...retries.map(e => e.payload)];
		for (const item of all) {
			if (silent) {
				item.resolve(null as never);
			} else {
				this.fail(item, new ChiqqClearedError(), false);
			}
		}

		this.postTaskCheck();
		return all.length;
	}

	/**
	 * Registers a one-shot callback that fires the next time the queue
	 * transitions to drained (no running tasks, no queued tasks, no pending
	 * retries) as a result of a task completing or being cleared. If the
	 * queue is already idle the callback waits for the next drain.
	 * Calling onComplete again before the callback fires replaces it.
	 */
	onComplete(callback: () => void) {
		this.completeCallback = callback;
	}

	/**
	 * Registers a handler for tasks that fail after their last retry. While a
	 * handler is set, rejected task promises (failed or cleared) are marked as
	 * handled, so `add()` without `await` or `.catch()` cannot crash the
	 * process with an unhandled rejection. Awaited promises still reject.
	 * Pass `null` to remove the handler.
	 */
	onError(callback: ((error: unknown) => void) | null) {
		this.errorCallback = callback;
	}

	/**
	 * Returns a promise that resolves once the queue is drained (no running
	 * tasks, no queued tasks, no pending retries). Resolves right away if the
	 * queue is already idle. A paused queue with queued tasks is not idle.
	 */
	onIdle(): Promise<void> {
		if (this.isDrained()) return Promise.resolve();
		return new Promise(resolve => this.idleWaiters.push(resolve));
	}

	/** Maximum number of tasks running at once. */
	get concurrency(): number {
		return this.limit;
	}

	/** Number of tasks running right now. */
	get active(): number {
		return this.running;
	}

	/** Number of tasks waiting to start, including tasks waiting to be retried. */
	get queued(): number {
		return this.q.length + this.retryTimers.size;
	}

	/** Number of failed tasks waiting out their retry cooldown before they try again. */
	get pendingRetry(): number {
		return this.retryTimers.size;
	}

	/** Running plus waiting tasks: `active + queued`. */
	get total(): number {
		return this.running + this.q.length + this.retryTimers.size;
	}

	/** Minimum time between task starts (ms). */
	get taskDelay(): number {
		return this.conf.taskDelay;
	}

	/** Maximum retries per task. -1 means retry forever. */
	get retryMax(): number {
		return this.conf.retryMax;
	}

	/** Base delay before a retry (ms). */
	get retryCooling(): number {
		return this.conf.retryCooling;
	}

	/** Growth factor of the retry delay. 1 or less means a constant delay. */
	get retryFactor(): number {
		return this.conf.retryFactor;
	}

	/** True when paused by `pause()` or held by an upstream queue in a chain. */
	get isPaused(): boolean {
		return this.paused || this.held;
	}

	/** True when nothing is running, queued or waiting to be retried. */
	get isIdle(): boolean {
		return this.isDrained();
	}

	status(): ChiqqStatus {
		return {
			isPaused: this.paused || this.held,
			isIdle: this.isDrained(),
			config: {
				concurrency: this.limit,
				taskDelay: this.conf.taskDelay,
				retry: {
					max: this.conf.retryMax,
					cooling: this.conf.retryCooling,
					factor: this.conf.retryFactor,
				},
			},
			tasks: {
				total: this.running + this.q.length + this.retryTimers.size,
				active: this.running,
				queued: this.q.length + this.retryTimers.size,
				pendingRetry: this.retryTimers.size,
			},
		};
	}
}

export default Chiqq;
