import {describe, expect, it} from 'bun:test';
import {join} from 'node:path';
import Chiqq, {ChiqqClearedError} from '../src/index';

const entry = join(import.meta.dir, '../src/index.ts');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Runs a script in a fresh process, so uncaught errors can be observed
// without taking down the test runner.
function runScript(body: string) {
	const script = `import Chiqq from ${JSON.stringify(entry)};\n${body}`;
	const r = Bun.spawnSync([process.execPath, '-e', script], {stderr: 'pipe', stdout: 'pipe'});
	return {code: r.exitCode, out: r.stdout.toString().trim()};
}

describe('addAll()', () => {
	it('resolves with the results in the order of the tasks', async () => {
		const queue = new Chiqq({concurrency: 4});
		const tasks = [30, 5, 20, 1, 10].map((ms, i) => async () => {
			await sleep(ms);
			return i;
		});
		expect(await queue.addAll(tasks)).toEqual([0, 1, 2, 3, 4]);
	});

	it('respects the concurrency limit', async () => {
		const queue = new Chiqq({concurrency: 3});
		let active = 0;
		let peak = 0;
		const tasks = Array.from({length: 12}, () => async () => {
			peak = Math.max(peak, ++active);
			await sleep(2);
			active--;
		});
		await queue.addAll(tasks);
		expect(peak).toBe(3);
	});

	it('resolves an empty batch with an empty array', async () => {
		const queue = new Chiqq();
		expect(await queue.addAll([])).toEqual([]);
	});

	it('throws before adding anything if a task is not a function', () => {
		const queue = new Chiqq({paused: true});
		const tasks = [() => 1, 'nope' as unknown as () => number];
		expect(() => queue.addAll(tasks)).toThrow('Please pass a function');
		expect(queue.queued).toBe(0);
	});

	it('retries each task on its own', async () => {
		const queue = new Chiqq({retryMax: 2, retryCooling: 1});
		const calls = [0, 0];
		const results = await queue.addAll([
			() => {
				if (++calls[0] < 3) throw new Error('flaky');
				return 'a';
			},
			() => {
				calls[1]++;
				return 'b';
			},
		]);
		expect(results).toEqual(['a', 'b']);
		expect(calls).toEqual([3, 1]);
	});

	it('takes per-batch retry options', async () => {
		const queue = new Chiqq();
		let calls = 0;
		const results = await queue.addAll(
			[
				() => {
					if (++calls < 2) throw new Error('flaky');
					return 'ok';
				},
			],
			{retryMax: 1, retryCooling: 1}
		);
		expect(results).toEqual(['ok']);
	});

	it('rejects with the first final error, and the other tasks keep running', async () => {
		const queue = new Chiqq({concurrency: 1});
		const ran: number[] = [];
		const batch = queue.addAll([
			() => ran.push(0),
			() => {
				throw new Error('second');
			},
			() => {
				throw new Error('third');
			},
			() => ran.push(3),
		]);
		await expect(batch).rejects.toThrow('second');
		await queue.onIdle();
		expect(ran).toEqual([0, 3]);
	});

	it('sends failures to onError and resolves with undefined at their positions', async () => {
		const queue = new Chiqq();
		const errors: [string, number][] = [];
		const results = await queue.addAll(
			[
				() => 'a',
				() => {
					throw new Error('b failed');
				},
				async () => 'c',
			],
			{onError: (error, index) => errors.push([(error as Error).message, index])}
		);
		expect(results).toEqual(['a', undefined, 'c']);
		expect(errors).toEqual([['b failed', 1]]);
	});

	it('calls onSuccess for each task, so progress can be reported', async () => {
		const queue = new Chiqq({concurrency: 2});
		const progress: string[] = [];
		let done = 0;
		const tasks = [10, 1, 5].map(ms => async () => {
			await sleep(ms);
			return ms;
		});
		await queue.addAll(tasks, {
			onSuccess: (value, index) => progress.push(`${++done}/3: task ${index} gave ${value}`),
		});
		expect(progress).toEqual(['1/3: task 1 gave 1', '2/3: task 2 gave 5', '3/3: task 0 gave 10']);
	});

	it('still reports failures to the queue onError() handler', async () => {
		const queue = new Chiqq();
		const seen: unknown[] = [];
		queue.onError(e => seen.push(e));
		const results = await queue.addAll(
			[
				() => {
					throw new Error('x');
				},
			],
			{onError: () => {}}
		);
		expect(results).toEqual([undefined]);
		expect(seen.length).toBe(1);
	});

	it('runs ahead of queued tasks with addAsFirst, in its own order', async () => {
		const queue = new Chiqq({paused: true});
		const order: string[] = [];
		const single = queue.add(() => order.push('single'));
		const batch = queue.addAll([() => order.push('a'), () => order.push('b')], {addAsFirst: true});
		queue.resume();
		await Promise.all([single, batch]);
		expect(order).toEqual(['a', 'b', 'single']);
	});

	it('rejects with ChiqqClearedError when cleared', async () => {
		const queue = new Chiqq({paused: true});
		const batch = queue.addAll([() => 1, () => 2]);
		queue.clear();
		await expect(batch).rejects.toBeInstanceOf(ChiqqClearedError);
	});

	it('sends cleared tasks to onError when it is set', async () => {
		const queue = new Chiqq({concurrency: 1});
		const errors: [unknown, number][] = [];
		const results = await queue.addAll(
			[
				() => {
					queue.clear();
					return 'first';
				},
				() => 'second',
			],
			{onError: (error, index) => errors.push([error, index])}
		);
		expect(results).toEqual(['first', undefined]);
		expect(errors.length).toBe(1);
		expect(errors[0][0]).toBeInstanceOf(ChiqqClearedError);
		expect(errors[0][1]).toBe(1);
	});

	it('resolves cleared tasks with null on clear(true)', async () => {
		const queue = new Chiqq({paused: true});
		const batch = queue.addAll([() => 1, () => 2]);
		queue.clear(true);
		// Like add(), the type doesn't show the nulls from clear(true).
		expect(await batch).toEqual([null, null] as unknown as number[]);
	});

	it('infers the result type', async () => {
		const queue = new Chiqq();
		const results: number[] = await queue.addAll([() => 1, async () => 2]);
		expect(results).toEqual([1, 2]);
		// With onError, failed positions are undefined, and the type says so.
		const maybe: (number | undefined)[] = await queue.addAll([() => 1], {onError: () => {}});
		expect(maybe).toEqual([1]);
		// @ts-expect-error a batch with onError can have holes
		const strict: number[] = await queue.addAll([() => 1], {onError: () => {}});
		expect(strict).toEqual([1]);
	});

	it('a throwing onSuccess does not stall the queue', () => {
		const r = runScript(`
			process.on('uncaughtException', e => console.log('uncaught ' + e.message));
			const q = new Chiqq({concurrency: 1});
			q.addAll([() => 1, () => 2], {onSuccess: () => { throw new Error('callback'); }})
				.then(v => console.log(v.join(',')));
		`);
		expect(r.out.split('\n').sort()).toEqual(['1,2', 'uncaught callback', 'uncaught callback']);
	});
});
