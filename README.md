# Chiqq

Chiqq is an async task pool and queue manager built for high throughput with first-class TypeScript support. It was originally developed as an internal tool at Bico.Media to manage the flow of creating and distributing files as transactions. We're open-sourcing it because it's proven to be incredibly useful for turning chaotic asynchronous jobs into a calm, controlled process.

It's small (about 9 kB, no dependencies) and fast: see [Performance](#performance) for how it compares to p-queue, p-limit, fastq and friends.

## Installation

Chiqq is available on npm with zero dependencies. It runs on Node 18+, Bun, Deno and in the browser.

```bash
bun add chiqq
# or
yarn add chiqq
# or
npm install chiqq
```

Chiqq ships as both ES module and CommonJS, with types for both:

```typescript
import Chiqq from 'chiqq';            // or: import {Chiqq} from 'chiqq';
const Chiqq = require('chiqq');       // or: const {Chiqq} = require('chiqq');
import Chiqq from 'npm:chiqq';        // Deno
```

## Examples

The best way to understand Chiqq is to see it in action. Let's say you have a massive list of URLs for API calls to process. You can't start them all at once or you'll overwhelm your system. With Chiqq you can pretend you're processing them all at once while controlling concurrency and retry behaviour.

```typescript
import Chiqq from 'chiqq';

const q = new Chiqq({ concurrency: 8, retryMax: 3, retryCooling: 5000 });

const urls = [
	'https://api.example.com/data/1',
	'https://api.example.com/data/2',
	'https://api.example.com/data/3',
	// ... 997 more URLs
];

// Loop through all URLs and add them to the queue
const promises = urls.map(url => {
	return q.add(async () => {
		const response = await fetch(url);
		if (!response.ok) throw new Error(`${response.status} for ${url}`);
		return [url, await response.json()];
	});
});

// Wait for all requests to complete
const results = await Promise.all(promises);
console.log(`Processed ${results.length} API calls`);
```

In this example you queue up 1000s of requests but only up to 8 will run at any time. If a request fails, Chiqq will retry it up to 3 times with a 5 second cooldown.

Chiqq retries when your task throws (or its promise rejects), so you decide what counts as a failure. That's why the example throws on a bad status code: `fetch()` only rejects on network errors, and a `500` would otherwise count as a success.

### A whole batch at once

If you have the tasks up front and only need the results at the end, hand them over with `addAll()`. You get one promise for the batch instead of one per task, which is less work for Chiqq. Every task still retries on its own.

```typescript
let done = 0;

const results = await q.addAll(
	urls.map(url => () => fetchJson(url)), // fetch plus the status check from above
	{
		onSuccess: (data, index) => console.log(`${++done}/${urls.length} done`),
		onError: (error, index) => log.warn(`${urls[index]} failed after its retries`, error),
	}
);
// results[i] belongs to urls[i], and is undefined where the task failed
```

Without `onError`, the batch rejects with the first error that survives its retries, just like `Promise.all()`. The other tasks keep running. With `onError`, every failure goes there and the batch always resolves once all tasks are done.

## Retry Logic

Chiqq can automatically retry failed tasks with configurable cooling and exponential backoff.

```typescript
import Chiqq from 'chiqq';

const q = new Chiqq({
	concurrency: 5,
	retryMax: 10,
	retryCooling: 5000, // 5 seconds base delay
	retryFactor: 2,     // 5s, 10s, 20s, 40s, ...
});
```
When `retryFactor <= 1` the cooldown is constant. Fractional factors like `1.5` work too. `retryMax: -1` (or `Infinity`) will retry forever or until you clear the queue.

## TypeScript Support

`add()` is generic, so you get fully typed return values without casting.

```typescript
import Chiqq, { Configuration, ConfigTask } from 'chiqq';

const config: Configuration = {
	concurrency: 3,
	retryMax: 2,
	retryCooling: 1000,
};

const queue = new Chiqq(config);

const greeting = await queue.add<string>(async () => 'Hello, TypeScript!');
//    ^? string

const score = await queue.add<number>(async () => Math.floor(Math.random() * 100));
//    ^? number

interface UserData { id: number; name: string; }
const user = await queue.add<UserData>(async () => ({ id: 1, name: 'John Doe' }));

// Per-task overrides
await queue.add(async () => doWork(), { retryCooling: 500 });

// Same as add() but places the task at the front of the queue to be picked up next, instead of at the back.
await queue.addNext(async () => urgentWork());

// Current queue status
console.log(`Active ${queue.active}/${queue.concurrency}, queued ${queue.queued}, of those ${queue.pendingRetry} to retry`);
const s = queue.status(); // everything at once, as a ChiqqStatus object
```

## Lifecycle

```typescript
const q = new Chiqq({ concurrency: 4 });

// ... add tasks to the queue ...

// Wait until the queue is fully drained (no running, no queued and no retrying tasks).
await q.onIdle();

// Or fire a function once when the queue is drained next time.
q.onComplete(() => console.log('all done'));

// Pause: in-flight tasks will keep running, queued and retrying tasks will not start.
q.pause(() => console.log('No more running tasks in the paused queue'));
q.resume();

// Cancel everything that hasn't started yet (queued + pending retries).
// Each cancelled task's promise rejects with a ChiqqClearedError.
const cancelled = q.clear();
console.log(`Cancelled ${cancelled} pending tasks`);

// Or silently discard them - cleared promises resolve with `null`
// instead of rejecting, so awaiting them won't throw.
q.clear(true);
```

To tell a cancelled task apart from one that failed, check for `ChiqqClearedError`:

```typescript
import Chiqq, { ChiqqClearedError } from 'chiqq';

try {
	await q.add(() => work());
} catch (error) {
	if (error instanceof ChiqqClearedError) return; // cancelled by clear(), not a real failure
	throw error;
}
```

### Errors from tasks you don't await

Like any promise, a rejected `add()` promise that nobody awaits or catches is an unhandled rejection, and Node exits on those. That includes tasks cancelled by `clear()`. If you fire and forget, register an error handler:

```typescript
q.onError(error => log.warn('task failed', error));

q.add(() => sendEmail(user)); // no await needed, failures go to onError
```

While a handler is set, Chiqq marks its rejected promises as handled, so they can't crash the process. Awaited promises still reject as usual.

## Priority Chains

`chain()` links a lower-priority follower queue, letting you compose several queues into one longer prioritised pipeline. A queue holds its chained queue paused while it has work, and resumes it once it goes idle - so everything in the upstream queue finishes before the downstream queue gets a turn.

```typescript
const high = new Chiqq({ concurrency: 4 });
const low = new Chiqq({ concurrency: 4 });

high.chain(low);

// While `high` has work, `low` is held. As soon as `high` drains, `low` runs.
high.add(() => urgentWork());
low.add(() => backgroundWork()); // waits for `high` to finish first
```

Links are forward-only and compose to any depth. `chain()` returns the chained queue, so you can build a pipeline fluently:

```typescript
a.chain(b).chain(c).chain(d); // priority order: a -> b -> c -> d
```

Key behaviours:
- When work arrives in an upstream queue, it holds all downstream queues. In-flight tasks will finish in the downstream queues. Notice how concurrency is maintained within each queue and NOT across all queues.
- Retries don't block the chain: a task waiting out its retry cooldown does not hold the chain - the downstream runs during the gap and is held again when the retry fires.
- Signals flow downward, so resuming the top of the chain flows down to the first queue with tasks. Resuming a middle queue starts its tasks or passes the resume on as if it was the top of the chain.
- A chain hold is separate from your own `pause()`: a downstream queue you paused yourself stays paused (and keeps its pause callback) when the upstream drains.
- `chain()` throws if the link would create a cycle.

## API Reference

### `new Chiqq(config?)`

| Property      | Type    | Default | Description |
| ---           | ---     | ---     | --- |
| concurrency   | number  | 1       | Maximum tasks to run concurrently |
| taskDelay     | number  | 0       | Minimum delay between task starts (ms) |
| paused        | boolean | false   | Start queue in paused state |
| retryMax      | number  | 0       | Maximum retries for failed tasks (`-1` or `Infinity` = forever) |
| retryCooling  | number  | 50      | Base delay before retrying failed tasks (ms) |
| retryFactor   | number  | 0       | Exponential growth factor (`<=1` means constant cooldown) |

### `add<T>(task, configObj?) => Promise<T>`

Adds a task to the queue. Returns a promise that resolves with the task's result.

`configObj` (`ConfigTask`) accepts: `taskDelay`, `retryMax`, `retryCooling`, `retryFactor`, `addAsFirst`. Each overrides the queue-level setting for this task only, and is validated the same way as the queue config.

The returned promise may also resolve with `null` if the task was discarded via `clear(true)`.

If a slot is free, the task starts synchronously inside `add()`, before `add()` returns.

`add()` throws right away (it does not return a rejected promise) if `task` is not a function.

### `addNext<T>(task, configObj?) => Promise<T>`

Thin proxy over `add()` with `addAsFirst: true`. The task is placed at the front of the queue and runs as soon as a slot is free, ahead of anything queued before it.

### `addAll<T>(tasks, configObj?) => Promise<T[]>`

Adds an array of tasks and returns one promise that resolves with their results, in the same order as `tasks`. Cheaper than calling `add()` for each task, and every task still retries on its own.

`configObj` (`ConfigBatch`) takes the same options as `add()`, applied to every task of the batch, plus:

| Property  | Type                              | Description |
| ---       | ---                               | --- |
| onSuccess | `(value: T, index: number) => void` | Called each time a task succeeds. Handy for progress reports. |
| onError   | `(error, index: number) => void`  | Called when a task fails after its last retry, or is cleared. With it set, the batch never rejects and resolves with `undefined` at the failed positions (the return type is then `Promise<(T \| undefined)[]>`). |

Without `onError`, the batch rejects with the first final error, like `Promise.all()`, and `clear()` rejects it with a `ChiqqClearedError`. The other tasks keep running. With `clear(true)`, cleared tasks give `null` at their positions, and `onSuccess` is not called for them. The queue-level `onError()` handler still hears about every failure. A callback that throws doesn't stall the queue: the error is rethrown on its own, like a throwing `onError()` handler.

With `addAsFirst: true`, the batch goes to the front of the queue and keeps its own order there. `addAll()` throws right away, before adding anything, if one of the tasks is not a function.

### `pause(callback?)`

Pauses queue processing. Currently running tasks will complete; no new tasks start. Retry cooldowns keep counting down while paused, but a retry whose cooldown ends waits at the front of the queue until you resume. The optional callback fires once when all running tasks have completed. Calling `pause()` again replaces the callback, or removes it if you pass none. Calling `resume()` will clear a pause callback.

### `resume()`

Resumes a paused queue and immediately fills the pool of active tasks up to `concurrency`.

### `chain(queue) => Chiqq object`

Links `queue` as a lower-priority follower of this queue (see [Priority Chains](#priority-chains)). While this queue has work the chained queue is held paused; when this queue goes idle the chained queue resumes. Returns the chained queue, so links can be built fluently: `a.chain(b).chain(c)`.

### `clear(silent?: boolean) => number`

Removes all tasks not currently in progress (queued + pending retries). Currently running tasks are not affected. Returns the number of tasks cleared.

- `clear()` / `clear(false)` (default): cleared tasks reject with a `ChiqqClearedError`.
- `clear(true)`: cleared tasks resolve with `null` instead. Use this when you want to discard work and don't care about results, so awaited promises don't reject.

### `setConcurrency(concurrency)`

Changes the concurrency limit. A higher limit starts queued tasks right away. A lower limit never interrupts running tasks; it takes effect as they finish.

### `onIdle() => Promise<void>`

Resolves once the queue is drained (no running tasks, no queued tasks, no pending retries). Resolves right away if the queue is already idle. A paused queue with queued tasks is not idle.

### `onError(callback | null)`

Registers a handler for tasks that fail after their last retry (not for cleared tasks). While a handler is set, rejected task promises are marked as handled, so unawaited tasks can't cause unhandled rejections. Pass `null` to remove it.

### `onComplete(callback)`

Registers a one-shot callback that fires the next time the queue transitions to drained (no running tasks, no queued tasks, no pending retries). If the queue is already idle when you register, the callback waits for the next drain - it does not fire immediately. Calling `onComplete` again before the callback fires replaces it.

### Getters

Every value has one name. A setting reads back under the name of its constructor option, and `status()` holds the same values in two groups.

| Getter          | Type    | In `status()`          | Description |
| ---             | ---     | ---                    | --- |
| `isPaused`      | boolean | `isPaused`             | Paused by `pause()` or held by an upstream queue in a chain |
| `isIdle`        | boolean | `isIdle`               | Nothing running, waiting or waiting to be retried |
| `concurrency`   | number  | `config.concurrency`   | Maximum tasks running at once. Change it with `setConcurrency()` |
| `taskDelay`     | number  | `config.taskDelay`     | Minimum time between task starts (ms) |
| `retryMax`      | number  | `config.retry.max`     | Maximum retries per task, `-1` for retry forever |
| `retryCooling`  | number  | `config.retry.cooling` | Base delay before a retry (ms) |
| `retryFactor`   | number  | `config.retry.factor`  | Growth factor of the retry delay |
| `total`         | number  | `tasks.total`          | `active + queued` |
| `active`        | number  | `tasks.active`         | Tasks running right now |
| `queued`        | number  | `tasks.queued`         | Tasks waiting to start, including `pendingRetry` |
| `pendingRetry`  | number  | `tasks.pendingRetry`   | Failed tasks waiting out their cooldown before they try again |

### `status() => ChiqqStatus`

All of the above in one object, handy for logging:

```typescript
q.status();
// {
//   isPaused: false,
//   isIdle: false,
//   config: { concurrency: 8, taskDelay: 0, retry: { max: 3, cooling: 5000, factor: 2 } },
//   tasks: { total: 42, active: 8, queued: 34, pendingRetry: 1 },
// }
```

## Performance

Chiqq is intentionally tiny and unopinionated. Adding and starting a task is O(1), also for queues with hundreds of thousands of tasks, and so is `addNext()`. It keeps less memory per waiting task than any of the other libraries we could measure.

We benchmark it against p-queue, p-limit, fastq, async, Bottleneck and promise-pool on Node, Bun and Deno. Here are the Node 24 numbers. The fastest library in each row is 1.00x, and the others show how long they took compared to it, so 2.00x took twice as long:

| Scenario | chiqq | p-queue | p-limit | fastq | async | promise-pool |
| --- | --- | --- | --- | --- | --- | --- |
| 10k sync tasks, concurrency 1 | 1.00x | 7.81x | 2.94x | 1.27x | 1.84x | 4.77x |
| 10k sync tasks, concurrency 16 | 1.00x | 8.25x | 3.15x | 1.26x | 1.54x | 3.07x |
| 10k async tasks, concurrency 16 | 1.00x | 5.56x | 2.62x | 1.25x | 1.50x | 2.22x |
| 5k I/O-like tasks, concurrency 64 | 1.00x | 3.25x | 1.57x | 1.17x | 1.30x | 29.89x |
| 100k tasks queued at once | 1.00x | 7.21x | 2.73x | 2.59x | 1.81x | 1.79x |
| Heap per waiting task | 291 B | 885 B | 696 B | 640 B | 408 B | n/a |

Chiqq's own times for those rows were 1.53, 1.58, 3.07, 2.59 and 30 ms.

Chiqq comes out fastest in every scenario on all three runtimes. The closest is fastq, which took 1.17x-1.27x the time of Chiqq on Node. Bottleneck is left out of the table: it's built for rate limiting rather than raw throughput, and spent about 2.8 ms per task in these tests, so it isn't a fair fight.

All of those rows call `add()` once per task. Handing the same tasks over with `addAll()` is cheaper still: on Node the sync rows took about 0.49x the time of `add()`, the async and I/O rows 0.84x-0.86x, and the 100k backlog 0.41x.

Also keep in mind that these numbers measure the queue itself. As soon as your tasks do real work (an HTTP call takes milliseconds, not microseconds), the queue overhead disappears in the noise for all of these libraries.

The full results for all three runtimes, with timings and how much they vary between runs, are in [`test/performance/results.md`](test/performance/results.md). Run `test/performance/run.sh` to reproduce them on your own machine.

### Concurrency Tuning

For I/O-bound work (HTTP, disk, DB), try concurrency between 5 and 50. Ramp up while watching tail latency and downstream errors. For CPU-bound work, keep concurrency at or below your physical core count. Node and Bun are single-threaded for user code, so oversubscribing only adds scheduling overhead. The concurrency value is floored to a whole number of at least 1; passing 0 or a negative number is treated as 1. `Infinity` is allowed.

### Task Delay Cost

`taskDelay` defaults to 0 (no artificial delays). Set it when you need to deliberately stagger task starts, e.g. against a rate-limited API: a task with `taskDelay: 100` starts no sooner than 100ms after the previous task started, even if a slot is free. The queue uses at most one timer for this, however many tasks are waiting.

### Pause Semantics

In-flight tasks finish; only new picks are blocked. This is useful for graceful shutdown: call `pause()`, wait for in-flight work via `pause(callback)`, then exit (or `clear()` the rest). Adding tasks while paused queues them normally; they start when you call `resume()`.

## Tests

```bash
bun test                    # test suite, one file per feature in test/
bun run typecheck           # types for src and tests
bun run build && bun run test-dist   # import/require the built files with Node
test/performance/run.sh     # compare with similar libs, writes test/performance/results.md
```

## Releasing

```bash
yarn release
```

Runs `yarn version`: checks for a clean tree, installs, typechecks, tests and logs in to npm, then builds `dist` and `types` into the version commit, publishes to npm, and pushes the commit and tag.

## Contributing

Contributions are welcome. Please feel free to submit a pull request. For bigger changes, opening an issue first saves us both some time. Please add a test for what you change (one file per feature in `test/`), and run `bun test` and `bun run format` before you push. There is no linter, only the formatter.

## License

MIT
