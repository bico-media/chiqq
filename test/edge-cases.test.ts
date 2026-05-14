import {describe, expect, it} from 'bun:test';
import Chiqq from '../src/index';

describe('Chiqq Edge Cases', () => {
	it('addNext() jumps a task ahead of already-queued ones', async () => {
		const order: string[] = [];
		const queue = new Chiqq({concurrency: 1, paused: true, taskDelay: 0});

		const make = (name: string) => async () => {
			order.push(name);
			await new Promise(resolve => setTimeout(resolve, 5));
			return name;
		};

		const pA = queue.add(make('A'));
		const pB = queue.add(make('B'));
		const pC = queue.addNext(make('C'));

		// Nothing has run yet.
		expect(order).toEqual([]);
		expect(queue.status().tasks.queued).toBe(3);

		queue.resume();
		await Promise.all([pA, pB, pC]);

		expect(order).toEqual(['C', 'A', 'B']);
	});

	it('respects per-task taskDelay override on add()', async () => {
		// Constructor taskDelay is 0; we expect no built-in delay between adds...
		const queue = new Chiqq({concurrency: 2, taskDelay: 0});

		// First task occupies one slot for long enough to overlap.
		const first = queue.add(async () => {
			await new Promise(resolve => setTimeout(resolve, 150));
			return 'first';
		});

		// Let the first task actually start.
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(queue.status().tasks.active).toBe(1);

		const start = Date.now();
		let secondStartedAt = 0;
		const second = queue.add(
			async () => {
				secondStartedAt = Date.now() - start;
				return 'second';
			},
			{taskDelay: 80}
		);

		await second;
		await first;

		// add() awaits `taskDelay * running` before triggering tick(), so the
		// second task should not start before ~80ms despite a free slot.
		expect(secondStartedAt).toBeGreaterThanOrEqual(70);
	});

	it('respects per-task retryCooling override', async () => {
		// Big global retryCooling; the per-task override should make this fast.
		const queue = new Chiqq({retryMax: 1, retryCooling: 500});
		let attempts = 0;

		const start = Date.now();
		const result = await queue.add(
			async () => {
				attempts++;
				if (attempts === 1) throw new Error('fail once');
				return 'ok';
			},
			{retryCooling: 20}
		);
		const duration = Date.now() - start;

		expect(result).toBe('ok');
		expect(attempts).toBe(2);
		// If the override worked we waited ~20ms, not ~500ms.
		expect(duration).toBeLessThan(250);
	});

	it('retryMax < 0 keeps retrying until success', async () => {
		const queue = new Chiqq({retryMax: -1, retryCooling: 5});
		let attempts = 0;

		const result = await queue.add(async () => {
			attempts++;
			if (attempts < 5) throw new Error(`still failing on ${attempts}`);
			return 'finally';
		});

		expect(result).toBe('finally');
		expect(attempts).toBe(5);
	});

	it('status() reflects queued and active mid-flight', async () => {
		const queue = new Chiqq({concurrency: 1, paused: true, taskDelay: 0});

		const promises = [
			queue.add(async () => {
				await new Promise(resolve => setTimeout(resolve, 40));
			}),
			queue.add(async () => {
				await new Promise(resolve => setTimeout(resolve, 40));
			}),
			queue.add(async () => {
				await new Promise(resolve => setTimeout(resolve, 40));
			}),
		];

		let snapshot = queue.status();
		expect(snapshot.isPaused).toBe(true);
		expect(snapshot.tasks.queued).toBe(3);
		expect(snapshot.tasks.active).toBe(0);

		queue.resume();
		// Let the first task actually pick up.
		await new Promise(resolve => setTimeout(resolve, 10));

		snapshot = queue.status();
		expect(snapshot.isPaused).toBe(false);
		expect(snapshot.tasks.active).toBe(1);
		expect(snapshot.tasks.queued).toBe(2);

		await Promise.all(promises);

		snapshot = queue.status();
		expect(snapshot.tasks.active).toBe(0);
		expect(snapshot.tasks.queued).toBe(0);
	});

	it('paused: true at construct time blocks tasks until resume()', async () => {
		const queue = new Chiqq({concurrency: 2, paused: true, taskDelay: 0});
		let started = false;

		const task = queue.add(async () => {
			started = true;
			return 'go';
		});

		// Plenty of time for it to start, if it were going to.
		await new Promise(resolve => setTimeout(resolve, 30));
		expect(started).toBe(false);
		expect(queue.status().tasks.queued).toBe(1);

		queue.resume();
		const result = await task;
		expect(result).toBe('go');
		expect(started).toBe(true);
	});

	it('floors non-positive concurrency to 1 (regression for negative input)', async () => {
		const queue = new Chiqq({concurrency: -3});
		expect(queue.status().config.concurrency).toBe(1);

		// And it actually still processes tasks.
		const result = await queue.add(async () => 'works');
		expect(result).toBe('works');
	});
});
