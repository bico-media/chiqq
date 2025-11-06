import {describe, it, expect, beforeEach} from 'bun:test';
import Chiqq from '../src/index';

describe('Chiqq Pause and Resume', () => {
	it('should start in running state by default', () => {
		const queue = new Chiqq({});
		const insight = queue.insight();
		expect(insight.paused).toBe(false);
	});

	it('should start in paused state when configured', () => {
		const queue = new Chiqq({paused: true});
		const insight = queue.insight();
		expect(insight.paused).toBe(true);
	});

	it('should pause queue processing', async () => {
		const queue = new Chiqq({concurrency: 1});
		let firstTaskStarted = false;
		let secondTaskStarted = false;

		const firstTask = async () => {
			firstTaskStarted = true;
			await new Promise(resolve => setTimeout(resolve, 50));
			return 'first';
		};

		const secondTask = async () => {
			secondTaskStarted = true;
			return 'second';
		};

		// Start first task
		const firstPromise = queue.add(firstTask);

		// Pause queue
		queue.pause();
		expect(queue.insight().paused).toBe(true);

		// Add second task (should not start)
		const secondPromise = queue.add(secondTask);

		// Wait a bit to ensure second task doesn't start
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(firstTaskStarted).toBe(true);
		expect(secondTaskStarted).toBe(false);

		// Complete first task
		await firstPromise;

		// Second task should still not start
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(secondTaskStarted).toBe(false);

		// Resume and complete second task
		queue.resume();
		const result = await secondPromise;
		expect(result).toBe('second');
	});

	it('should resume queue processing', async () => {
		const queue = new Chiqq({concurrency: 2, paused: true});
		const results: string[] = [];

		const task = (name: string) => async () => {
			await new Promise(resolve => setTimeout(resolve, 20));
			results.push(name);
			return name;
		};

		// Add tasks while paused
		const promises = [queue.add(task('task1')), queue.add(task('task2')), queue.add(task('task3'))];

		// Tasks should not start
		await new Promise(resolve => setTimeout(resolve, 30));
		expect(results.length).toBe(0);

		// Resume queue
		queue.resume();
		expect(queue.insight().paused).toBe(false);

		// Wait for tasks to complete
		await Promise.all(promises);
		expect(results).toEqual(['task1', 'task2', 'task3']);
	});

	it('should handle multiple resume calls gracefully', () => {
		const queue = new Chiqq({paused: true});

		queue.resume();
		queue.resume(); // Should not cause issues
		queue.resume();

		expect(queue.insight().paused).toBe(false);
	});

	it('should handle multiple pause calls gracefully', () => {
		const queue = new Chiqq({});

		queue.pause();
		queue.pause(); // Should not cause issues
		queue.pause();

		expect(queue.insight().paused).toBe(true);
	});

	it('should allow completing running tasks when paused', async () => {
		const queue = new Chiqq({concurrency: 2});
		let taskCompleted = false;

		const longTask = async () => {
			await new Promise(resolve => setTimeout(resolve, 50));
			taskCompleted = true;
			return 'completed';
		};

		const taskPromise = queue.add(longTask);

		// Pause after task starts
		await new Promise(resolve => setTimeout(resolve, 10));
		queue.pause();

		// Task should still complete
		const result = await taskPromise;
		expect(result).toBe('completed');
		expect(taskCompleted).toBe(true);
	});
});
