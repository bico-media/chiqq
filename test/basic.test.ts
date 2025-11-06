import {describe, it, expect, beforeEach} from 'bun:test';
import Chiqq from '../src/index';

describe('Chiqq Basic Functionality', () => {
	it('should create a queue with default configuration', () => {
		const queue = new Chiqq({});
		const insight = queue.insight();

		expect(insight.concurrency).toBe(1);
		expect(insight.chill).toBe(1);
		expect(insight.paused).toBe(false);
		expect(insight.retryMax).toBe(0);
		expect(insight.retryCooling).toBe(50);
		expect(insight.retryFactor).toBe(0);
		expect(insight.running).toBe(0);
		expect(insight.qLength).toBe(0);
	});

	it('should create a queue with custom configuration', () => {
		const queue = new Chiqq({
			concurrency: 3,
			chill: 100,
			paused: true,
			retryMax: 5,
			retryCooling: 1000,
			retryFactor: 2,
		});

		const insight = queue.insight();
		expect(insight.concurrency).toBe(3);
		expect(insight.chill).toBe(100);
		expect(insight.paused).toBe(true);
		expect(insight.retryMax).toBe(5);
		expect(insight.retryCooling).toBe(1000);
		expect(insight.retryFactor).toBe(2);
	});

	it('should execute a simple task and return result', async () => {
		const queue = new Chiqq({});

		const task = async () => {
			await new Promise(resolve => setTimeout(resolve, 10));
			return 'All done';
		};

		const result = await queue.add(task);
		expect(result).toBe('All done');
	});

	it('should handle multiple tasks sequentially', async () => {
		const queue = new Chiqq({});
		const results: string[] = [];

		const tasks = Array.from({length: 3}, (_, i) =>
			queue.add(async () => {
				await new Promise(resolve => setTimeout(resolve, 10));
				return `Task ${i + 1}`;
			})
		);

		for (const task of tasks) {
			results.push((await task) as string);
		}

		expect(results).toEqual(['Task 1', 'Task 2', 'Task 3']);
	});

	it('should throw error when task is not a function', () => {
		const queue = new Chiqq({});

		expect(() => {
			queue.add('not a function' as any);
		}).toThrow('Please pass a function');
	});

	it('should handle task failures', async () => {
		const queue = new Chiqq({});
		const error = new Error('Task failed');

		const task = async () => {
			throw error;
		};

		await expect(queue.add(task)).rejects.toThrow('Task failed');
	});
});
