# Chiqq

> High throughput async task pool / queue manager with excellent TypeScript support

Chiqq is originally built as an internal tool [Bico.Media](http://add.bico.media) to manage the flow of creating and distributing files as transactions. We're open-sourcing it because it's proven to be incredibly useful for turning chaotic asynchronous jobs into a calm, controlled process.

## 📦 Bundled Output

This package includes pre-built bundles for different environments:

- `dist/index.es5.js` - ES5 (CommonJS) bundle (2.17 KB)
- `dist/index.es6.js` - ES6 (ESM) bundle (1.69 KB)
- `index.d.ts` - TypeScript definitions at root level

## 🎯 TypeScript Features

Chiqq is built with **first-class TypeScript support** and provides:

- **Full type safety** with strict TypeScript configuration
- **Generic task types** for type-safe return values
- **Comprehensive JSDoc documentation** with examples
- **Exported interfaces** for public API typing
- **Zero `any` types** in the public API
- **Intelligent autocomplete** and IDE support

### TypeScript Example

```typescript
import Chiqq, { ChiqqConfiguration, TaskConfiguration, QueueInsight } from 'chiqq';

// Fully typed queue configuration
const config: ChiqqConfiguration = {
  concurrency: 3,
  retryMax: 2,
  retryCooling: 1000
};

// Queue with default return type (string)
const stringQueue = new Chiqq<string>(config);

// Task that returns a string - fully typed!
const result: Promise<string> = stringQueue.add(async () => {
  return "Hello, TypeScript!";
});

// Queue with different return types per task
const mixedQueue = new Chiqq({ concurrency: 2 });

// Task returning number with type override
const numberResult: Promise<number> = mixedQueue.add<number>(async () => {
  return Math.floor(Math.random() * 100);
});

// Task with custom interface
interface UserData {
  id: number;
  name: string;
}

const userResult: Promise<UserData> = mixedQueue.add<UserData>(async () => {
  return { id: 1, name: "John Doe" };
});

// Type-safe queue monitoring
const insight: QueueInsight = mixedQueue.insight();
console.log(`Queue running: ${insight.running}/${insight.concurrency}`);
```

## Installation

It's on npm. Zero dependencies.

```bash
bun add chiqq
# or
yarn add chiqq
# or 
npm install chiqq
```

### TypeScript Support

Chiqq includes built-in TypeScript definitions. No additional packages needed:

```typescript
import Chiqq, { ChiqqConfiguration, TaskConfiguration, QueueInsight } from 'chiqq';
```

For development with the latest TypeScript features, you can also install from source:

```bash
git clone https://github.com/bicomedia/chiqq.git
cd chiqq
yarn install
yarn build
```

## Let's See It in Action

The best way to get to know Chiqq is to watch it work. Let's start simple.

### Example 1: The Basics

First, we create a queue. Then, we give it tasks to look after. A task is just an async function.

```typescript
import Chiqq from 'chiqq';

// Create a new queue. By default, it runs one task at a time.
const q = new Chiqq();

// A simple task that waits for a second.
const myFirstTask = async () => {
  console.log("Task is starting...");
  await new Promise(resolve => setTimeout(resolve, 1000));
  console.log("...task finished!");
  return "All done";
};

// Add the task to the queue.
q.add(myFirstTask)
  .then(result => {
    console.log(`The task returned: "${result}"`);
  });

console.log("Task was added to the queue.");
```

### Example 2: Limiting Concurrency

Doing things one by one is safe, but sometimes you want to pick up the pace. Let's ask Chiqq to handle two tasks at the same time (`concurrency: 2`).

```typescript
import Chiqq from 'chiqq';

// This queue will run up to 2 tasks in parallel.
const q = new Chiqq({ concurrency: 2 });

const createTask = (id: number) => async () => {
  console.log(`Task ${id} has started.`);
  // Simulate work with a random delay
  const delay = 1000 + Math.random() * 1000;
  await new Promise(resolve => setTimeout(resolve, delay));
  console.log(` ---> Task ${id} finished.`);
};

// Add 5 tasks to the queue.
// Notice how tasks 1 and 2 start immediately.
// Then, as each task finishes, a new one starts. Chiqq never exceeds 2 running at once.
for (let i = 1; i <= 5; i++) {
  q.add(createTask(i));
}
```

### Example 3: A Real-World Scenario

Now let's see its true power. Imagine we need to run a maximum of 5 tasks at a time. If a task fails, we should ask Chiqq to try it up to 10 more times. We'll have it wait 5 seconds before the first retry, and then double that waiting time for each subsequent retry (`retryFactor: 2`).

```typescript
import Chiqq from 'chiqq';

// A powerful queue configuration
const q = new Chiqq({
  concurrency: 5,
  retryMax: 10,
  retryCooling: 5000, // 5 seconds
  retryFactor: 2      // Wait 5s, then 10s, then 20s, etc.
});

// This is an example of how you might use it inside your application logic
async function handleInput(data: any) {
  // ... some logic ...

  console.log('Adding a complex task to the queue...');
  const result = await q.add(async () => {
    // This is where your actual async work happens
    // e.g., return uploadFile(data) or processImage(data)
    return `Processed ${data}`;
  });

  doSomethingElse(result);

  // ... more logic ...
}

function doSomethingElse(result: string) {
  console.log(`The task completed and returned: ${result}`);
}

handleInput("some-data");
```

## API Reference

### Types and Interfaces

```typescript
interface ChiqqConfiguration {
  concurrency?: number;    // Default: 1
  chill?: number;          // Default: 1 (ms)
  paused?: boolean;        // Default: false
  retryMax?: number;       // Default: 0
  retryCooling?: number;   // Default: 50 (ms)
  retryFactor?: number;    // Default: 0
}

interface TaskConfiguration {
  chill?: number;          // Override global chill
  retryCooling?: number;   // Override global retryCooling
  addAsFirst?: boolean;    // Default: false
}

interface QueueInsight {
  concurrency: number;
  paused: boolean;
  qLength: number;         // Number of queued tasks
  running: number;         // Number of running tasks
  chill: number;
  retryMax: number;
  retryCooling: number;
  retryFactor: number;
}
```

### `new Chiqq<T = unknown>(configuration?: ChiqqConfiguration)`

Creates a new Chiqq instance with optional generic type and configuration.

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `concurrency` | `number` | `1` | Maximum tasks to run concurrently |
| `chill` | `number` | `1` | Default delay between starting tasks (ms) |
| `paused` | `boolean` | `false` | Start queue in paused state |
| `retryMax` | `number` | `0` | Maximum retry attempts for failed tasks |
| `retryCooling`| `number` | `50` | Base delay before retrying failed tasks (ms) |
| `retryFactor` | `number` | `0` | Multiplier for retry delay on subsequent attempts |

### `add<TResult = T>(task: () => Promise<TResult>, configObj?: TaskConfiguration): Promise<TResult>`

Adds a typed task to the queue. Returns a promise that resolves with the task's result.

**Task Configuration:**
| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `chill` | `number` | `(from constructor)` | Override chill time for this task |
| `retryCooling`| `number` | `(from constructor)` | Override retry cooling time |
| `addAsFirst` | `boolean`| `false` | Add task to front of queue |

### `pause(): void`

Pauses queue processing. Currently running tasks complete, but no new tasks start.

### `resume(): void`

Resumes a paused queue, immediately starting tasks if capacity is available.

### `insight(): QueueInsight`

Returns current queue state with all configuration and runtime statistics.