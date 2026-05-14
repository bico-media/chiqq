import {describe, expect, it} from 'bun:test';
import Chiqq from '../src/index';

describe('Chiqq Retry Mechanism', () => {
	it('should not retry tasks by default', async () => {
		const queue = new Chiqq({retryMax: 0});
		let attemptCount = 0;

		const task = async () => {
			attemptCount++;
			throw new Error('Always fails');
		};

		await expect(queue.add(task)).rejects.toThrow('Always fails');
		expect(attemptCount).toBe(1);
	});

	it('should retry failed tasks up to retryMax', async () => {
		const queue = new Chiqq({retryMax: 3, retryCooling: 10});
		let attemptCount = 0;

		const task = async () => {
			attemptCount++;
			if (attemptCount < 3) {
				throw new Error(`Attempt ${attemptCount} failed`);
			}
			return 'success';
		};

		const result = await queue.add(task);
		expect(result).toBe('success');
		expect(attemptCount).toBe(3);
	});

	it('should fail after exceeding retryMax', async () => {
		const queue = new Chiqq({retryMax: 2, retryCooling: 10});
		let attemptCount = 0;

		const task = async () => {
			attemptCount++;
			throw new Error(`Attempt ${attemptCount} failed`);
		};

		await expect(queue.add(task)).rejects.toThrow('Attempt 3 failed');
		expect(attemptCount).toBe(3); // 1 initial + 2 retries
	});

	it('should respect retryCooling delay', async () => {
		const queue = new Chiqq({retryMax: 1, retryCooling: 100});
		const startTime = Date.now();
		let attemptCount = 0;

		const task = async () => {
			attemptCount++;
			if (attemptCount === 1) {
				throw new Error('First attempt fails');
			}
			return 'success';
		};

		const result = await queue.add(task);
		const endTime = Date.now();
		const duration = endTime - startTime;

		expect(result).toBe('success');
		expect(attemptCount).toBe(2);
		expect(duration).toBeGreaterThan(90); // Should include retry cooling
	});

	it('should apply retryFactor for exponential backoff', async () => {
		const queue = new Chiqq({
			retryMax: 2,
			retryCooling: 50,
			retryFactor: 2,
		});
		const startTime = Date.now();
		let attemptCount = 0;

		const task = async () => {
			attemptCount++;
			if (attemptCount < 3) {
				throw new Error(`Attempt ${attemptCount} failed`);
			}
			return 'success';
		};

		const result = await queue.add(task);
		const endTime = Date.now();
		const duration = endTime - startTime;

		expect(result).toBe('success');
		expect(attemptCount).toBe(3);
		// Exponential: retry 1 = 50ms, retry 2 = 100ms (total ~150ms).
		expect(duration).toBeGreaterThan(140);
	});

	it('uses constant cooling when retryFactor <= 1', async () => {
		const queue = new Chiqq({retryMax: 2, retryCooling: 40, retryFactor: 0});
		const start = Date.now();
		let attempts = 0;

		await queue.add(async () => {
			attempts++;
			if (attempts < 3) throw new Error('fail');
			return 'ok';
		});

		const duration = Date.now() - start;
		expect(attempts).toBe(3);
		// Two retries at constant 40ms each = ~80ms. Should NOT exceed exponential ~120ms.
		expect(duration).toBeGreaterThanOrEqual(70);
		expect(duration).toBeLessThan(150);
	});

	it('should allow per-task retry configuration override', async () => {
		const queue = new Chiqq({retryMax: 0, retryCooling: 10});
		let attemptCount = 0;

		const task = async () => {
			attemptCount++;
			if (attemptCount < 2) {
				throw new Error('Fail first time');
			}
			return 'success';
		};

		// Note: retryMax cannot be overridden per task, only retryCooling
		// This test verifies that global retryMax is still respected
		await expect(queue.add(task, {retryCooling: 5})).rejects.toThrow('Fail first time');
		expect(attemptCount).toBe(1);
	});
});
