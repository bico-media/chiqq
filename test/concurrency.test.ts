import {describe, expect, it} from 'bun:test';
import Chiqq from '../src/index';

describe('Chiqq Concurrency Control', () => {
	it('should limit concurrent task execution', async () => {
		const queue = new Chiqq({concurrency: 2});
		let runningCount = 0;
		let maxRunning = 0;

		const createTask = (id: number) => async () => {
			runningCount++;
			maxRunning = Math.max(maxRunning, runningCount);
			await new Promise(resolve => setTimeout(resolve, 50));
			runningCount--;
			return `Task ${id}`;
		};

		const tasks = Array.from({length: 5}, (_, i) => queue.add(createTask(i + 1)));

		await Promise.all(tasks);
		expect(maxRunning).toBeLessThanOrEqual(2);
	});

	it('should respect concurrency setting', async () => {
		const queue = new Chiqq({concurrency: 3});
		const status = queue.status();

		expect(status.config.concurrency).toBe(3);

		// Add tasks and verify concurrency is respected
		const runningTasks: Promise<string>[] = [];
		let currentRunning = 0;

		const task = async () => {
			currentRunning++;
			const running = currentRunning;
			await new Promise(resolve => setTimeout(resolve, 20));
			currentRunning--;
			return `Running: ${running}`;
		};

		// Add 5 tasks
		for (let i = 0; i < 5; i++) {
			runningTasks.push(queue.add(task) as Promise<string>);
		}

		const results = await Promise.all(runningTasks);

		// Verify no task reported more than 3 concurrent executions
		const maxConcurrentReported = Math.max(...results.map(r => parseInt(r.split(': ')[1], 10)));
		expect(maxConcurrentReported).toBeLessThanOrEqual(3);
	});

	it('should handle zero taskDelay (no delay)', async () => {
		const queue = new Chiqq({taskDelay: 0, concurrency: 2});
		const startTime = Date.now();

		const task = async () => {
			await new Promise(resolve => setTimeout(resolve, 10));
			return 'fast';
		};

		await queue.add(task);
		await queue.add(task);

		const endTime = Date.now();
		const duration = endTime - startTime;

		// Should complete quickly without taskDelay delays
		expect(duration).toBeLessThan(100);
	});

	it('should respect taskDelay between tasks', async () => {
		const queue = new Chiqq({taskDelay: 50, concurrency: 2});
		const startTime = Date.now();

		// Create tasks that run longer to ensure overlap for taskDelay to take effect
		const longTask = async () => {
			await new Promise(resolve => setTimeout(resolve, 30));
			return 'slow';
		};

		// Add tasks that will overlap, triggering taskDelay behavior
		const promises = [queue.add(longTask), queue.add(longTask), queue.add(longTask)];

		await Promise.all(promises);

		const endTime = Date.now();
		const duration = endTime - startTime;

		// Should include some taskDelay delays due to task overlap
		expect(duration).toBeGreaterThan(80);
	});
});
