import {describe, expect, it} from 'bun:test';
import Chiqq from '../src/index';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('onIdle()', () => {
	it('resolves right away when the queue is idle', async () => {
		const queue = new Chiqq();
		let resolved = false;
		queue.onIdle().then(() => {
			resolved = true;
		});
		await null;
		expect(resolved).toBe(true);
	});

	it('resolves after all tasks finish', async () => {
		const queue = new Chiqq({concurrency: 2});
		let done = 0;
		for (let i = 0; i < 5; i++) {
			queue.add(async () => {
				await delay(5);
				done++;
			});
		}
		await queue.onIdle();
		expect(done).toBe(5);
		expect(queue.status().tasks.total).toBe(0);
	});

	it('resolves every waiter', async () => {
		const queue = new Chiqq();
		queue.add(() => delay(5));
		const results = await Promise.all([queue.onIdle(), queue.onIdle(), queue.onIdle()]);
		expect(results.length).toBe(3);
	});

	it('waits for pending retries', async () => {
		const queue = new Chiqq({retryMax: 1, retryCooling: 30});
		let attempts = 0;
		queue.add(() => {
			if (++attempts === 1) throw new Error('once');
		});
		await queue.onIdle();
		expect(attempts).toBe(2);
	});

	it('resolves when the backlog is cleared', async () => {
		const queue = new Chiqq({paused: true});
		queue.add(() => 1);
		const idle = queue.onIdle();
		queue.clear(true);
		await idle;
		expect(queue.status().tasks.total).toBe(0);
	});

	it('does not resolve while a paused queue holds tasks', async () => {
		const queue = new Chiqq({paused: true});
		queue.add(() => 1);
		let resolved = false;
		queue.onIdle().then(() => {
			resolved = true;
		});
		await delay(10);
		expect(resolved).toBe(false);
		queue.resume();
		await delay(0);
		expect(resolved).toBe(true);
	});
});
