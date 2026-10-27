import {describe, expect, it} from 'bun:test';
import Chiqq from '../src/index';

const failTimes = (n: number) => {
	let calls = 0;
	return {
		task: async () => {
			calls++;
			if (calls <= n) throw new Error(`fail ${calls}`);
			return calls;
		},
		calls: () => calls,
	};
};

describe('Configuration', () => {
	it('keeps a fractional retryFactor', () => {
		expect(new Chiqq({retryFactor: 1.5}).status().config.retry.factor).toBe(1.5);
	});

	it('grows the cooldown with a fractional retryFactor', async () => {
		const queue = new Chiqq({retryMax: 2, retryCooling: 40, retryFactor: 1.5});
		const t = failTimes(2);
		const start = Date.now();
		await queue.add(t.task);
		// 40ms + 60ms. A constant cooldown would take 80ms.
		expect(Date.now() - start).toBeGreaterThanOrEqual(95);
	});

	it('treats retryMax Infinity as retry forever', async () => {
		const queue = new Chiqq({retryMax: Number.POSITIVE_INFINITY, retryCooling: 0});
		expect(queue.status().config.retry.max).toBe(-1);
		const t = failTimes(5);
		expect(await queue.add(t.task)).toBe(6);
	});

	it('treats any negative retryMax as retry forever', async () => {
		const queue = new Chiqq({retryMax: -5, retryCooling: 0});
		expect(queue.status().config.retry.max).toBe(-1);
	});

	it('validates per-task overrides like queue config', async () => {
		const queue = new Chiqq();
		const t = failTimes(10);
		await expect(queue.add(t.task, {retryMax: 2.7, retryCooling: -5})).rejects.toThrow('fail 3');
		// retryMax 2.7 is floored to 2 retries, so 3 attempts.
		expect(t.calls()).toBe(3);
	});

	it('caps delays at the setTimeout maximum', () => {
		const queue = new Chiqq({retryCooling: 3_000_000_000, taskDelay: 3_000_000_000});
		expect(queue.status().config.retry.cooling).toBe(2 ** 31 - 1);
		expect(queue.status().config.taskDelay).toBe(2 ** 31 - 1);
	});

	it('falls back to defaults for values that are not numbers', () => {
		const queue = new Chiqq({concurrency: 'x' as any, retryCooling: 'y' as any});
		expect(queue.status().config.concurrency).toBe(1);
		expect(queue.status().config.retry.cooling).toBe(50);
	});

	it('accepts Infinity concurrency', async () => {
		const queue = new Chiqq({concurrency: Number.POSITIVE_INFINITY});
		let active = 0;
		let peak = 0;
		const task = async () => {
			peak = Math.max(peak, ++active);
			await new Promise(r => setTimeout(r, 5));
			active--;
		};
		await Promise.all(Array.from({length: 50}, () => queue.add(task)));
		expect(peak).toBe(50);
	});

	it('accepts setConcurrency(Infinity)', async () => {
		const queue = new Chiqq({concurrency: 1});
		const gate = Promise.withResolvers<void>();
		const promises = Array.from({length: 20}, () => queue.add(() => gate.promise));
		queue.setConcurrency(Number.POSITIVE_INFINITY);
		expect(queue.status().tasks.active).toBe(20);
		gate.resolve();
		await Promise.all(promises);
	});
});
