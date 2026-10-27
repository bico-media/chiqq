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

interface ResolvedConfig {
	taskDelay: number;
	retryMax: number;
	retryCooling: number;
	retryFactor: number;
}

interface QueueItem<T = unknown> {
	task: () => T | Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
	retried: number;
	conf: ResolvedConfig;
	promise: Promise<T>;
}

interface PendingRetryEntry {
	payload: QueueItem;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * FIFO queue with O(1) shift. Array.prototype.shift() is O(n) in V8 for large
 * arrays, so reads advance a head index instead, and the consumed prefix is
 * sliced off once it is over half the array (and over 1024 items).
 */
class TaskQueue<T> {
	private items: (T | undefined)[] = [];
	private head = 0;

	get length(): number {
		return this.items.length - this.head;
	}

	push(item: T) {
		this.items.push(item);
	}

	unshift(item: T) {
		if (this.head > 0) {
			this.items[--this.head] = item;
		} else {
			this.items.unshift(item);
		}
	}

	peek(): T | undefined {
		return this.items[this.head];
	}

	shift(): T | undefined {
		if (this.head === this.items.length) return undefined;
		const item = this.items[this.head];
		this.items[this.head++] = undefined;
		if (this.head === this.items.length) {
			this.items = [];
			this.head = 0;
		} else if (this.head > 1024 && this.head * 2 >= this.items.length) {
			this.items = this.items.slice(this.head);
			this.head = 0;
		}
		return item;
	}

	drain(): T[] {
		const items = this.items.slice(this.head) as T[];
		this.items = [];
		this.head = 0;
		return items;
	}
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

export default class Chiqq {
	concurrency: number;
	conf: ResolvedConfig;
	running: number;
	paused: boolean;
	// Set by the upstream queue in a chain, separate from the user's own pause.
	held: boolean;
	q: TaskQueue<QueueItem>;
	pauseCallback: (() => void) | null;
	completeCallback: (() => void) | null;
	errorCallback: ((error: unknown) => void) | null;
	idleWaiters: (() => void)[];
	pendingRetry: Set<PendingRetryEntry>;
	chained: Chiqq | null;
	lastStart: number;
	delayTimer: ReturnType<typeof setTimeout> | null;

	constructor(conf: Configuration = {}) {
		this.conf = resolveConfig(conf, DEFAULTS);
		this.concurrency = toConcurrency(conf.concurrency);
		this.paused = !!conf.paused;
		this.held = false;
		this.running = 0;
		this.q = new TaskQueue<QueueItem>();
		this.pauseCallback = null;
		this.completeCallback = null;
		this.errorCallback = null;
		this.idleWaiters = [];
		this.pendingRetry = new Set();
		this.chained = null;
		this.lastStart = 0;
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
		return this.running === 0 && this.q.length === 0 && this.pendingRetry.size === 0;
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
		if (this.paused || this.held || this.concurrency <= this.running) return false;

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
		this.lastStart = Date.now();

		// I have work, so hold my chained queue
		if (this.chained && !this.chained.held) this.chained.hold();

		this.run(payload);
		return true;
	}

	private async run(payload: QueueItem) {
		const conf = payload.conf;
		try {
			const result = await payload.task();
			this.running--;
			payload.resolve(result);
		} catch (e) {
			this.running--;

			if (conf.retryMax < 0 || payload.retried < conf.retryMax) {
				payload.retried++;
				const entry: PendingRetryEntry = {payload, timer: undefined as never};
				entry.timer = setTimeout(
					() => {
						this.pendingRetry.delete(entry);
						this.q.unshift(payload);
						this.tick();
					},
					this.retryDelay(conf, payload.retried)
				);
				this.pendingRetry.add(entry);
			} else {
				this.fail(payload, e, true);
			}
		}
		this.postTaskCheck();
		this.tick();
	}

	add<T = unknown>(task: () => T | Promise<T>, configObj: ConfigTask = {}): Promise<T> {
		if (typeof task !== 'function') throw new Error('Please pass a function');
		const conf = hasOverrides(configObj) ? resolveConfig(configObj, this.conf) : this.conf;
		let item!: QueueItem<T>;
		const promise = new Promise<T>((resolve, reject) => {
			item = {task, resolve, reject, retried: 0, conf, promise: undefined as never};
		});
		item.promise = promise;
		if (configObj.addAsFirst) {
			this.q.unshift(item as QueueItem);
		} else {
			this.q.push(item as QueueItem);
		}
		this.tick();
		return promise;
	}

	/**
	 * Adds a task at the front of the queue so it runs as soon as a slot is
	 * available, ahead of any tasks added before it. Thin proxy over `add()`
	 * with `addAsFirst: true`.
	 */
	addNext<T = unknown>(task: () => T | Promise<T>, configObj: ConfigTask = {}): Promise<T> {
		return this.add<T>(task, {...configObj, addAsFirst: true});
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
		this.concurrency = toConcurrency(concurrency);
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
		const retries = Array.from(this.pendingRetry);
		this.pendingRetry.clear();
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

	status() {
		return {
			isPaused: this.paused || this.held,
			config: {
				concurrency: this.concurrency,
				taskDelay: this.conf.taskDelay,
				retry: {
					max: this.conf.retryMax,
					cooling: this.conf.retryCooling,
					factor: this.conf.retryFactor,
				},
			},
			tasks: {
				total: this.q.length + this.running + this.pendingRetry.size,
				active: this.running,
				queued: this.q.length + this.pendingRetry.size,
			},
		};
	}
}
