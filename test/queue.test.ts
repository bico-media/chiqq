import {describe, expect, it} from 'bun:test';
import Chiqq from '../src/index';

describe('Internal task queue', () => {
	it('keeps FIFO order while the buffer grows', async () => {
		const queue = new Chiqq({concurrency: 1});
		const order: number[] = [];
		const promises: Promise<number>[] = [];
		for (let i = 0; i < 5000; i++) {
			promises.push(queue.add(() => order.push(i) && i));
		}
		await Promise.all(promises);
		expect(order).toEqual(Array.from({length: 5000}, (_, i) => i));
	});

	it('keeps addNext() at the front after the head has moved', async () => {
		const queue = new Chiqq({concurrency: 1});
		const order: string[] = [];
		const promises: Promise<unknown>[] = [];
		for (let i = 0; i < 3000; i++) {
			promises.push(
				queue.add(() => {
					order.push(`t${i}`);
					// Midway through the backlog, jump the queue.
					if (i === 1500) promises.push(queue.addNext(() => order.push('next')));
				})
			);
		}
		await Promise.all(promises);
		expect(order.indexOf('next')).toBe(order.indexOf('t1500') + 1);
		expect(order.length).toBe(3001);
	});

	it('clears a backlog whose head has moved', async () => {
		const queue = new Chiqq({concurrency: 1});
		let ran = 0;
		const promises: Promise<unknown>[] = [];
		for (let i = 0; i < 3000; i++) {
			promises.push(
				queue.add(() => {
					ran++;
					if (i === 2000) queue.clear(true);
				})
			);
		}
		const results = await Promise.all(promises);
		expect(ran).toBe(2001);
		expect(results.filter(r => r === null).length).toBe(999);
		expect(queue.status().tasks.total).toBe(0);
	});

	it('keeps order when add() and addNext() wrap around the buffer', async () => {
		const queue = new Chiqq({paused: true});
		const order: string[] = [];
		const promises: Promise<unknown>[] = [];
		// addNext() on an empty queue writes to the last slot, add() to the first.
		for (let i = 0; i < 40; i++) {
			promises.push(queue.addNext(() => order.push(`n${i}`)));
			promises.push(queue.add(() => order.push(`a${i}`)));
		}
		queue.resume();
		await Promise.all(promises);
		const expected = [
			...Array.from({length: 40}, (_, i) => `n${39 - i}`),
			...Array.from({length: 40}, (_, i) => `a${i}`),
		];
		expect(order).toEqual(expected);
	});

	it('runs 100k addNext() calls in linear time', async () => {
		const queue = new Chiqq({paused: true});
		const order: number[] = [];
		const promises: Promise<unknown>[] = [];
		const start = performance.now();
		for (let i = 0; i < 100_000; i++) promises.push(queue.addNext(() => order.push(i)));
		queue.resume();
		await Promise.all(promises);
		expect(performance.now() - start).toBeLessThan(3000);
		expect(order[0]).toBe(99_999);
		expect(order[99_999]).toBe(0);
	});

	it('runs 100k tasks that throw synchronously without overflowing the stack', async () => {
		const queue = new Chiqq({paused: true});
		let failed = 0;
		const promises: Promise<unknown>[] = [];
		for (let i = 0; i < 100_000; i++) {
			promises.push(
				queue
					.add(() => {
						throw new Error('x');
					})
					.catch(() => failed++)
			);
		}
		// Used to throw RangeError: Maximum call stack size exceeded, here or later.
		queue.resume();
		await Promise.all(promises);
		expect(failed).toBe(100_000);
		expect(queue.isIdle).toBe(true);
	});

	it('drains 200k queued tasks in linear time', async () => {
		const queue = new Chiqq({concurrency: 16});
		const start = performance.now();
		const promises: Promise<number>[] = [];
		for (let i = 0; i < 200_000; i++) promises.push(queue.add(() => i));
		await Promise.all(promises);
		// Quadratic dequeue took about 28s on Node for this; linear is well under 1s.
		expect(performance.now() - start).toBeLessThan(3000);
	});
});
