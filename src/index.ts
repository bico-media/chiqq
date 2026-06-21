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
}

interface PendingRetryEntry {
	payload: QueueItem;
	timer: ReturnType<typeof setTimeout>;
}

export class ChiqqClearedError extends Error {
	constructor(message = 'Chiqq queue cleared') {
		super(message);
		this.name = 'ChiqqClearedError';
	}
}

export default class Chiqq {
	concurrency: number;
	conf: ResolvedConfig;
	running: number;
	paused: boolean;
	q: QueueItem[];
	pauseCallback: (() => void) | null;
	completeCallback: (() => void) | null;
	pendingRetry: Set<PendingRetryEntry>;

	constructor(conf: Configuration = {}) {
		this.conf = {
			taskDelay: conf.taskDelay !== undefined ? Math.max(0, conf.taskDelay | 0) : 0,
			retryMax: conf.retryMax !== undefined ? conf.retryMax | 0 : 0,
			retryCooling: conf.retryCooling !== undefined ? Math.max(0, conf.retryCooling | 0) : 50,
			retryFactor: conf.retryFactor !== undefined ? Math.max(0, conf.retryFactor | 0) : 0,
		};
		this.concurrency = Math.max(1, (conf.concurrency || 1) | 0);
		this.paused = !!conf.paused;
		this.running = 0;
		this.q = [];
		this.pauseCallback = null;
		this.completeCallback = null;
		this.pendingRetry = new Set();
	}

	private retryDelay(conf: ResolvedConfig, attempt: number): number {
		// attempt is 1-indexed (1 = first retry).
		// factor <= 1: constant cooling. factor > 1: exponential (cooling * factor^(attempt-1)).
		if (conf.retryFactor <= 1) return conf.retryCooling;
		return conf.retryCooling * conf.retryFactor ** (attempt - 1);
	}

	private postTaskCheck() {
		if (this.pauseCallback && this.paused && this.running === 0) {
			const cb = this.pauseCallback;
			this.pauseCallback = null;
			cb();
		}
		if (
			this.completeCallback &&
			this.running === 0 &&
			this.q.length === 0 &&
			this.pendingRetry.size === 0
		) {
			const cb = this.completeCallback;
			this.completeCallback = null;
			cb();
		}
	}

	private tick() {
		if (this.paused) return;
		if (this.concurrency <= this.running) return;

		const payload = this.q.shift();
		if (!payload) return;

		this.running++;
		const conf = payload.conf;

		const run = async () => {
			try {
				const result = await payload.task();
				this.running--;
				payload.resolve(result);
				this.postTaskCheck();
				this.next(conf);
			} catch (e) {
				this.running--;

				if (conf.retryMax < 0 || payload.retried < conf.retryMax) {
					payload.retried++;
					const wait = this.retryDelay(conf, payload.retried);
					const entry: PendingRetryEntry = {payload, timer: undefined as never};
					entry.timer = setTimeout(() => {
						this.pendingRetry.delete(entry);
						this.q.unshift(payload);
						this.tick();
					}, wait);
					this.pendingRetry.add(entry);
					this.postTaskCheck();
					this.next(conf);
					return;
				}

				payload.reject(e);
				this.postTaskCheck();
				this.next(conf);
			}
		};

		if (conf.taskDelay) {
			setTimeout(run, 0);
		} else {
			run();
		}
	}

	add<T = unknown>(task: () => T | Promise<T>, configObj: ConfigTask = {}): Promise<T> {
		if (typeof task !== 'function') throw new Error('Please pass a function');
		const conf: ResolvedConfig = {...this.conf, ...configObj};
		return new Promise<T>((resolve, reject) => {
			const item: QueueItem<T> = {task, resolve, reject, retried: 0, conf};
			if (configObj.addAsFirst) {
				this.q.unshift(item as QueueItem);
			} else {
				this.q.push(item as QueueItem);
			}

			if (conf.taskDelay && this.running) {
				setTimeout(() => this.tick(), conf.taskDelay * this.running);
			} else {
				this.tick();
			}
		});
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
		// If already idle, fire on a microtask so behavior is consistent.
		if (callback && this.running === 0) {
			this.pauseCallback = null;
			Promise.resolve().then(callback);
		}
	}

	resume() {
		this.paused = false;
		this.pauseCallback = null;
		while (this.q.length && this.running < this.concurrency) {
			this.tick();
		}
	}

	/**
	 * Updates the concurrency limit and immediately attempts to utilize the new capacity.
	 * If the new limit is higher than the current running tasks, additional tasks will be started.
	 * If the new limit is lower, no running tasks are interrupted - the limit will take effect
	 * as tasks complete naturally.
	 */
	setConcurrency(concurrency: number) {
		this.concurrency = Math.max(1, concurrency | 0);
		this.resume();
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
		const queued = this.q.splice(0, this.q.length);
		const retries = Array.from(this.pendingRetry);
		this.pendingRetry.clear();
		for (const entry of retries) clearTimeout(entry.timer);

		const all = [...queued, ...retries.map(e => e.payload)];
		for (const item of all) {
			if (silent) {
				item.resolve(null as never);
			} else {
				item.reject(new ChiqqClearedError());
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

	private next(configObj: ConfigTask = {}) {
		const conf = {...this.conf, ...configObj};
		if (conf.taskDelay && this.running) {
			setTimeout(() => this.tick(), conf.taskDelay);
			return;
		}
		this.tick();
	}

	status() {
		return {
			isPaused: this.paused,
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
