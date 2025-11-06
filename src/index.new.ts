import {ChiqqConfiguration, TaskConfiguration, QueueInsight, TaskPayload} from './types.js';

/**
 * Creates a delay promise that resolves after the specified timeout.
 * @param timeout - Delay in milliseconds.
 * @returns Promise that resolves after the timeout.
 */
const delay = (timeout: number): Promise<void> => {
	return new Promise(resolve => {
		setTimeout(resolve, timeout);
	});
};

/**
 * High throughput async task pool / queue manager with retry support.
 *
 * @template T Default type for task return values. Can be overridden per task.
 *
 * @example
 * ```typescript
 * const queue = new Chiqq({ concurrency: 5, retryMax: 3 });
 *
 * // Add a task that returns a string
 * const result1 = await queue.add(async () => {
 *   return "Hello World";
 * });
 *
 * // Add a task with specific configuration
 * const result2 = await queue.add(async () => {
 *   return fetchUserData(userId);
 * }, { addAsFirst: true, retryMax: 5 });
 * ```
 */
export default class Chiqq<T = unknown> {
	/** Maximum number of concurrent tasks. */
	public readonly concurrency: number;

	/** Internal configuration object. */
	private readonly conf: Required<Omit<ChiqqConfiguration, 'paused' | 'concurrency'>>;

	/** Current number of running tasks. */
	private running: number = 0;

	/** Whether the queue is paused. */
	private paused: boolean = false;

	/** Internal task queue. */
	private q: TaskPayload<unknown>[] = [];

	/**
	 * Creates a new Chiqq queue instance.
	 * @param conf - Configuration options for the queue.
	 */
	constructor(conf: ChiqqConfiguration = {}) {
		this.conf = {
			chill: Math.max(0, Math.floor(conf.chill ?? 1)),
			retryMax: Math.max(0, Math.floor(conf.retryMax ?? 0)),
			retryCooling: Math.max(0, Math.floor(conf.retryCooling ?? 50)),
			retryFactor: Math.max(0, Math.floor(conf.retryFactor ?? 0)),
		};
		this.concurrency = Math.max(1, Math.floor(conf.concurrency ?? 1));
		this.paused = conf.paused ?? false;
	}

	/**
	 * Processes the next task in the queue if conditions are met.
	 * @internal
	 */
	private async tick(): Promise<void> {
		if (this.paused) return;
		if (this.concurrency <= this.running) return;

		const payload = this.q.shift();
		if (!payload) return;

		this.running++;

		const conf = {...this.conf, ...payload.conf};

		const run = async (): Promise<void> => {
			let result: unknown;

			try {
				result = await payload.task();
			} catch (error) {
				this.running--;

				if (conf.retryMax < 0 || payload.retried++ < conf.retryMax) {
					const retryDelay =
						conf.retryCooling + conf.retryCooling * conf.retryFactor * payload.retried;
					setTimeout(() => {
						this.q.unshift(payload);
						void this.tick();
					}, retryDelay);
				} else {
					payload.reject(error);
				}
				return void this.next();
			}

			this.running--;
			payload.resolve(result as any);
			return void this.next(conf);
		};

		if (conf.chill > 0) {
			void Promise.resolve().then(() => setTimeout(run, 0));
		} else {
			void Promise.resolve().then(run);
		}
	}

	/**
	 * Adds a task to the queue.
	 *
	 * @template TResult The return type of the task function.
	 * @param task - The async function to execute.
	 * @param configObj - Optional configuration overrides for this specific task.
	 * @returns Promise that resolves with the task's result or rejects on failure.
	 *
	 * @throws {Error} If task is not a function.
	 *
	 * @example
	 * ```typescript
	 * const result = await queue.add(async () => {
	 *   return await fetch('https://api.example.com/data');
	 * }, { addAsFirst: true });
	 * ```
	 */
	public add<TResult = T>(
		task: () => Promise<TResult>,
		configObj: TaskConfiguration = {}
	): Promise<TResult> {
		if (typeof task !== 'function') {
			throw new Error('Task must be a function');
		}

		return new Promise<TResult>(async (resolve, reject) => {
			const conf: Required<TaskConfiguration> = {
				chill: configObj.chill ?? this.conf.chill,
				retryCooling: configObj.retryCooling ?? this.conf.retryCooling,
				addAsFirst: configObj.addAsFirst ?? false,
			};

			const payload: TaskPayload<TResult> = {
				task,
				resolve,
				reject,
				retried: 0,
				conf,
			};

			if (conf.addAsFirst) {
				this.q.unshift(payload as TaskPayload<unknown>);
			} else {
				this.q.push(payload as TaskPayload<unknown>);
			}

			if (conf.chill > 0 && this.running > 0) {
				await delay(conf.chill * this.running);
			}

			void this.tick();
		});
	}

	/**
	 * Pauses the queue, preventing new tasks from starting.
	 * Currently running tasks will continue to completion.
	 */
	public pause(): void {
		this.paused = true;
	}

	/**
	 * Resumes the queue, allowing tasks to start processing.
	 * Will immediately start processing tasks if capacity is available.
	 */
	public resume(): void {
		if (!this.paused) return;

		this.paused = false;

		// Start processing tasks immediately
		const maxStart = Math.min(this.q.length, this.concurrency - this.running);
		for (let i = 0; i < maxStart; i++) {
			void this.tick();
		}
	}

	/**
	 * Triggers the next task processing cycle with optional configuration.
	 * @param configObj - Optional configuration for this cycle.
	 * @returns Timeout handle if delayed, undefined otherwise.
	 * @internal
	 */
	private next(configObj: TaskConfiguration = {}): ReturnType<typeof setTimeout> | undefined {
		const conf = {...this.conf, ...configObj};

		if (conf.chill > 0 && this.running > 0) {
			return setTimeout(() => {
				void this.tick();
			}, conf.chill);
		}

		void this.tick();
		return undefined;
	}

	/**
	 * Returns current queue statistics and state.
	 * @returns Object containing queue insights and current configuration.
	 *
	 * @example
	 * ```typescript
	 * const stats = queue.insight();
	 * console.log(`Running: ${stats.running}, Queued: ${stats.qLength}`);
	 * ```
	 */
	public insight(): QueueInsight {
		return {
			concurrency: this.concurrency,
			paused: this.paused,
			qLength: this.q.length,
			running: this.running,
			chill: this.conf.chill,
			retryMax: this.conf.retryMax,
			retryCooling: this.conf.retryCooling,
			retryFactor: this.conf.retryFactor,
		};
	}
}

// Export types for convenience
export type {ChiqqConfiguration, TaskConfiguration, QueueInsight, TaskPayload};
