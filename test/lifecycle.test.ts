import {describe, expect, it} from 'bun:test';
import Chiqq, {ChiqqClearedError} from '../src/index';

describe('Chiqq.clear()', () => {
	it('rejects all queued tasks with ChiqqClearedError', async () => {
		const queue = new Chiqq({concurrency: 1, paused: true});

		const a = queue.add(async () => 'A');
		const b = queue.add(async () => 'B');
		const c = queue.add(async () => 'C');

		const cleared = queue.clear();
		expect(cleared).toBe(3);
		expect(queue.status().tasks.queued).toBe(0);

		await expect(a).rejects.toBeInstanceOf(ChiqqClearedError);
		await expect(b).rejects.toBeInstanceOf(ChiqqClearedError);
		await expect(c).rejects.toBeInstanceOf(ChiqqClearedError);
	});

	it('does not affect currently running tasks', async () => {
		const queue = new Chiqq({concurrency: 1});
		let finished = false;

		const running = queue.add(async () => {
			await new Promise(r => setTimeout(r, 50));
			finished = true;
			return 'done';
		});

		// Let it actually start.
		await new Promise(r => setTimeout(r, 5));
		const queued = queue.add(async () => 'queued');

		expect(queue.clear()).toBe(1);
		await expect(queued).rejects.toBeInstanceOf(ChiqqClearedError);

		const result = await running;
		expect(result).toBe('done');
		expect(finished).toBe(true);
	});

	it('silent=true resolves cleared queued tasks with null', async () => {
		const queue = new Chiqq({concurrency: 1, paused: true});

		const a = queue.add(async () => 'A');
		const b = queue.add(async () => 'B');

		expect(queue.clear(true)).toBe(2);
		expect(await a).toBe(null);
		expect(await b).toBe(null);
	});

	it('silent=true resolves cleared pending retries with null', async () => {
		const queue = new Chiqq({retryMax: 5, retryCooling: 200});

		const failing = queue.add(async () => {
			throw new Error('always fails');
		});

		await new Promise(r => setTimeout(r, 20));
		expect(queue.status().tasks.queued).toBe(1);

		expect(queue.clear(true)).toBe(1);
		expect(await failing).toBe(null);
	});

	it('rejects pending retries and cancels their timers', async () => {
		const queue = new Chiqq({retryMax: 5, retryCooling: 200});
		let attempts = 0;

		const failing = queue.add(async () => {
			attempts++;
			throw new Error('always fails');
		});

		// Wait for first attempt to fail and the retry timer to be scheduled.
		await new Promise(r => setTimeout(r, 20));
		// Pending retries are reported as queued.
		expect(queue.status().tasks.queued).toBe(1);
		expect(queue.status().tasks.active).toBe(0);

		expect(queue.clear()).toBe(1);
		await expect(failing).rejects.toBeInstanceOf(ChiqqClearedError);
		expect(queue.status().tasks.queued).toBe(0);

		// Verify no further attempts happen after clear.
		const before = attempts;
		await new Promise(r => setTimeout(r, 250));
		expect(attempts).toBe(before);
	});
});

describe('Chiqq.onComplete()', () => {
	it('fires after queue drains', async () => {
		const queue = new Chiqq({concurrency: 2});
		let called = false;

		queue.add(async () => {
			await new Promise(r => setTimeout(r, 20));
		});
		queue.add(async () => {
			await new Promise(r => setTimeout(r, 30));
		});

		await new Promise<void>(resolve => {
			queue.onComplete(() => {
				called = true;
				resolve();
			});
		});

		expect(called).toBe(true);
		expect(queue.status().tasks.total).toBe(0);
	});

	it('does not fire when registered against an already-idle queue', async () => {
		const queue = new Chiqq({});
		let called = false;

		queue.onComplete(() => {
			called = true;
		});

		// Give microtasks/timers a chance.
		await new Promise(r => setTimeout(r, 10));
		expect(called).toBe(false);

		// It only fires once a task runs and the queue drains again.
		await queue.add(async () => 'work');
		await new Promise(r => setTimeout(r, 0));
		expect(called).toBe(true);
	});

	it('waits for pending retries to complete', async () => {
		const queue = new Chiqq({retryMax: 2, retryCooling: 30});
		let attempts = 0;
		let completedAt = 0;
		const start = Date.now();

		queue.add(async () => {
			attempts++;
			if (attempts < 3) throw new Error('fail');
			return 'ok';
		});

		await new Promise<void>(resolve => {
			queue.onComplete(() => {
				completedAt = Date.now() - start;
				resolve();
			});
		});

		expect(attempts).toBe(3);
		// Two retries at 30ms = ~60ms minimum.
		expect(completedAt).toBeGreaterThanOrEqual(50);
	});

	it('replaces previous callback if onComplete is called again', async () => {
		const queue = new Chiqq({concurrency: 1});
		let a = 0;
		let b = 0;

		queue.add(async () => {
			await new Promise(r => setTimeout(r, 10));
		});

		queue.onComplete(() => {
			a++;
		});
		queue.onComplete(() => {
			b++;
		});

		await new Promise(r => setTimeout(r, 30));
		expect(a).toBe(0);
		expect(b).toBe(1);

		// One-shot: draining again should NOT re-fire.
		queue.add(async () => {
			await new Promise(r => setTimeout(r, 10));
		});
		await new Promise(r => setTimeout(r, 30));
		expect(b).toBe(1);
	});

	it('fires after clear() drains the queue', async () => {
		const queue = new Chiqq({concurrency: 1, paused: true});
		let called = false;

		const swallow = (_e: unknown) => undefined;
		queue.add(async () => 'a').catch(swallow);
		queue.add(async () => 'b').catch(swallow);

		queue.onComplete(() => {
			called = true;
		});

		queue.clear();
		await new Promise(r => setTimeout(r, 0));
		expect(called).toBe(true);
	});
});
