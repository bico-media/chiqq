import {describe, expect, it} from 'bun:test';
import Chiqq from '../src/index';

describe('Status getters', () => {
	it('reports active, size and isIdle', async () => {
		const queue = new Chiqq({concurrency: 2});
		expect(queue.isIdle).toBe(true);
		const gate = Promise.withResolvers<void>();
		const promises = Array.from({length: 5}, () => queue.add(() => gate.promise));
		expect(queue.active).toBe(2);
		expect(queue.size).toBe(3);
		expect(queue.isIdle).toBe(false);
		gate.resolve();
		await Promise.all(promises);
		expect(queue.active).toBe(0);
		expect(queue.size).toBe(0);
		expect(queue.isIdle).toBe(true);
	});

	it('counts pending retries in size and pendingRetry', async () => {
		const queue = new Chiqq({retryMax: 1, retryCooling: 20});
		let attempts = 0;
		const p = queue.add(() => {
			if (++attempts === 1) throw new Error('once');
		});
		await null;
		await null;
		expect(queue.active).toBe(0);
		expect(queue.size).toBe(1);
		expect(queue.pendingRetry).toBe(1);
		expect(queue.total).toBe(1);
		await p;
		expect(queue.pendingRetry).toBe(0);
	});

	it('reports total as active plus size', () => {
		const queue = new Chiqq({concurrency: 2});
		for (let i = 0; i < 5; i++) queue.add(() => new Promise(() => {}));
		expect(queue.active).toBe(2);
		expect(queue.size).toBe(3);
		expect(queue.total).toBe(5);
	});

	it('reports the config under the names of the constructor options', () => {
		const queue = new Chiqq({taskDelay: 10, retryMax: 3, retryCooling: 500, retryFactor: 1.5});
		expect(queue.taskDelay).toBe(10);
		expect(queue.retryMax).toBe(3);
		expect(queue.retryCooling).toBe(500);
		expect(queue.retryFactor).toBe(1.5);
		expect(new Chiqq({retryMax: Infinity}).retryMax).toBe(-1);
	});

	it('status() holds the same values as the getters', () => {
		const queue = new Chiqq({
			concurrency: 2,
			taskDelay: 5,
			retryMax: 2,
			retryCooling: 50,
			retryFactor: 2,
		});
		for (let i = 0; i < 4; i++) queue.add(() => new Promise(() => {}));
		expect(queue.status()).toEqual({
			isPaused: queue.isPaused,
			isIdle: queue.isIdle,
			config: {
				concurrency: queue.concurrency,
				taskDelay: queue.taskDelay,
				retry: {max: queue.retryMax, cooling: queue.retryCooling, factor: queue.retryFactor},
			},
			tasks: {
				total: queue.total,
				active: queue.active,
				size: queue.size,
				pendingRetry: queue.pendingRetry,
			},
		});
		expect(queue.status().config.retry.max).toBe(2);
		expect(queue.status().tasks.total).toBe(4);
	});

	it('reports isPaused for a user pause and a chain hold', () => {
		const a = new Chiqq();
		const b = new Chiqq();
		a.chain(b);
		expect(b.isPaused).toBe(false);
		a.add(() => new Promise(() => {}));
		expect(b.isPaused).toBe(true);
		const c = new Chiqq();
		c.pause();
		expect(c.isPaused).toBe(true);
		c.resume();
		expect(c.isPaused).toBe(false);
	});

	it('reports concurrency and follows setConcurrency', () => {
		const queue = new Chiqq({concurrency: 3});
		expect(queue.concurrency).toBe(3);
		queue.setConcurrency(7);
		expect(queue.concurrency).toBe(7);
	});
});
