import {describe, expect, it} from 'bun:test';
import Chiqq from '../src/index';

describe('Internal task queue', () => {
	it('keeps FIFO order across compaction of a large backlog', async () => {
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
