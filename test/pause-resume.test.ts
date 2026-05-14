import {describe, expect, it} from 'bun:test';
import Chiqq from '../src/index';

describe('Chiqq Pause and Resume', () => {
	it('should start in running state by default', () => {
		const queue = new Chiqq({});
		const status = queue.status();
		expect(status.isPaused).toBe(false);
	});

	it('should start in paused state when configured', () => {
		const queue = new Chiqq({paused: true});
		const status = queue.status();
		expect(status.isPaused).toBe(true);
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
		expect(queue.status().isPaused).toBe(true);

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
		expect(queue.status().isPaused).toBe(false);

		// Wait for tasks to complete
		await Promise.all(promises);
		expect(results).toEqual(['task1', 'task2', 'task3']);
	});

	it('should handle multiple resume calls gracefully', () => {
		const queue = new Chiqq({paused: true});

		queue.resume();
		queue.resume(); // Should not cause issues
		queue.resume();

		expect(queue.status().isPaused).toBe(false);
	});

	it('should handle multiple pause calls gracefully', () => {
		const queue = new Chiqq({});

		queue.pause();
		queue.pause(); // Should not cause issues
		queue.pause();

		expect(queue.status().isPaused).toBe(true);
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

	it('should call pause callback when all tasks finish', async () => {
		const queue = new Chiqq({concurrency: 2});
		let callbackCalled = false;

		const task = async () => {
			await new Promise(resolve => setTimeout(resolve, 20));
			return 'done';
		};

		// Add tasks while queue is running
		const promises = [queue.add(task), queue.add(task)];

		// Wait for tasks to start
		await new Promise(resolve => setTimeout(resolve, 5));

		// Pause with callback
		queue.pause(() => {
			callbackCalled = true;
		});

		// Wait for tasks to complete
		await Promise.all(promises);

		// Callback should be called when all tasks finish
		expect(callbackCalled).toBe(true);
	});

	it('should not call pause callback if tasks are still running', async () => {
		const queue = new Chiqq({concurrency: 1});
		let callbackCalled = false;

		const longTask = async () => {
			await new Promise(resolve => setTimeout(resolve, 100));
			return 'done';
		};

		// Add task
		const longPromise = queue.add(longTask);

		// Pause with callback
		queue.pause(() => {
			callbackCalled = true;
		});

		// Wait a bit - callback should not be called yet
		await new Promise(resolve => setTimeout(resolve, 50));
		expect(callbackCalled).toBe(false);

		// Wait for task to complete
		await longPromise;

		// Now callback should be called
		expect(callbackCalled).toBe(true);
	});

	it('should clear pause callback on resume', async () => {
		const queue = new Chiqq({concurrency: 2});
		let callbackCalled = false;

		const task = async () => {
			await new Promise(resolve => setTimeout(resolve, 20));
			return 'done';
		};

		// Add tasks
		const promises = [queue.add(task), queue.add(task)];

		// Pause with callback
		queue.pause(() => {
			callbackCalled = true;
		});

		// Resume before tasks finish
		await new Promise(resolve => setTimeout(resolve, 10));
		queue.resume();

		// Wait for tasks to complete
		await Promise.all(promises);

		// Callback should not be called since we resumed
		expect(callbackCalled).toBe(false);
	});

	it('should return new status properties', () => {
		const queue = new Chiqq({concurrency: 3});
		const status = queue.status();

		expect(status.isPaused).toBe(false);
		expect(status.config.concurrency).toBe(3);
		expect(status.tasks.total).toBe(0);
		expect(status.tasks.active).toBe(0);
		expect(status.tasks.queued).toBe(0);
	});
});
