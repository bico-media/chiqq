/**
 * Configuration options for the Chiqq queue manager.
 */
export interface ChiqqConfiguration {
	/** Maximum number of concurrent tasks to execute. Defaults to 1. */
	concurrency?: number;
	/** Delay in milliseconds between task executions when queue is active. Defaults to 1. */
	chill?: number;
	/** Whether to start the queue in a paused state. Defaults to false. */
	paused?: boolean;
	/** Maximum number of retry attempts for failed tasks. Defaults to 0 (no retries). */
	retryMax?: number;
	/** Base delay in milliseconds before retrying a failed task. Defaults to 50. */
	retryCooling?: number;
	/** Multiplier for retry delay on subsequent attempts. Defaults to 0. */
	retryFactor?: number;
}

/**
 * Per-task configuration options that override the global queue settings.
 */
export interface TaskConfiguration {
	/** Task-specific delay in milliseconds. Overrides global chill setting. */
	chill?: number;
	/** Task-specific retry delay. Overrides global retryCooling setting. */
	retryCooling?: number;
	/** Whether to add this task to the front of the queue. Defaults to false. */
	addAsFirst?: boolean;
}

/**
 * Runtime statistics and current state of the queue.
 */
export interface QueueInsight {
	/** Maximum concurrent tasks allowed. */
	concurrency: number;
	/** Whether the queue is currently paused. */
	paused: boolean;
	/** Number of tasks currently waiting in the queue. */
	qLength: number;
	/** Number of tasks currently executing. */
	running: number;
	/** Current chill setting in milliseconds. */
	chill: number;
	/** Maximum retry attempts allowed. */
	retryMax: number;
	/** Base retry delay in milliseconds. */
	retryCooling: number;
	/** Retry delay multiplier. */
	retryFactor: number;
}

/**
 * Internal task payload stored in the queue.
 * @template T The type of value the task resolves to.
 * @internal
 */
export interface TaskPayload<T = unknown> {
	/** The async function to execute. */
	task: () => Promise<T>;
	/** Promise resolver function. */
	resolve: (value: T) => void;
	/** Promise rejecter function. */
	reject: (reason?: unknown) => void;
	/** Number of times this task has been retried. */
	retried: number;
	/** Merged configuration for this specific task. */
	conf: Required<TaskConfiguration>;
}
