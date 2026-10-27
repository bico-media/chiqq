import {describe, expect, it} from 'bun:test';
import Chiqq from '../src/index';

describe('Status getters', () => {
	it('reports active, queued and isIdle', async () => {
		const queue = new Chiqq({concurrency: 2});
		expect(queue.isIdle).toBe(true);
		const gate = Promise.withResolvers<void>();
		const promises = Array.from({length: 5}, () => queue.add(() => gate.promise));
		expect(queue.active).toBe(2);
		expect(queue.queued).toBe(3);
		expect(queue.isIdle).toBe(false);
		gate.resolve();
		await Promise.all(promises);
		expect(queue.active).toBe(0);
		expect(queue.queued).toBe(0);
		expect(queue.isIdle).toBe(true);
	});

	it('counts pending retries as queued', async () => {
		const queue = new Chiqq({retryMax: 1, retryCooling: 20});
		let attempts = 0;
		const p = queue.add(() => {
			if (++attempts === 1) throw new Error('once');
		});
		await null;
		await null;
		expect(queue.active).toBe(0);
		expect(queue.queued).toBe(1);
		await p;
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
