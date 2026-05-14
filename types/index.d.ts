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
export declare class ChiqqClearedError extends Error {
    constructor(message?: string);
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
    constructor(conf?: Configuration);
    private retryDelay;
    private postTaskCheck;
    private tick;
    add<T = unknown>(task: () => T | Promise<T>, configObj?: ConfigTask): Promise<T>;
    /**
     * Adds a task at the front of the queue so it runs as soon as a slot is
     * available, ahead of any tasks added before it. Thin proxy over `add()`
     * with `addAsFirst: true`.
     */
    addNext<T = unknown>(task: () => T | Promise<T>, configObj?: ConfigTask): Promise<T>;
    pause(callback?: () => void): void;
    resume(): void;
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
    clear(silent?: boolean): number;
    /**
     * Registers a one-shot callback that fires the next time the queue
     * transitions to drained (no running tasks, no queued tasks, no pending
     * retries) as a result of a task completing or being cleared. If the
     * queue is already idle the callback waits for the next drain.
     * Calling onComplete again before the callback fires replaces it.
     */
    onComplete(callback: () => void): void;
    private next;
    status(): {
        isPaused: boolean;
        config: {
            concurrency: number;
            taskDelay: number;
            retry: {
                max: number;
                cooling: number;
                factor: number;
            };
        };
        tasks: {
            total: number;
            active: number;
            queued: number;
        };
    };
}
export {};
