import {describe, expect, it} from 'bun:test';
import Chiqq from '../src/index';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('taskDelay', () => {
	it('spaces task starts by taskDelay even with free slots', async () => {
		const queue = new Chiqq({concurrency: 4, taskDelay: 30});
		const starts: number[] = [];
		const t0 = Date.now();
		await Promise.all(
			Array.from({length: 4}, () =>
				queue.add(async () => {
					starts.push(Date.now() - t0);
					await delay(5);
				})
			)
		);
		expect(starts[0]).toBeLessThan(10);
		for (let i = 1; i < starts.length; i++) {
			expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(28);
		}
	});

	it('does not delay the first task', async () => {
		const queue = new Chiqq({taskDelay: 200});
		const t0 = Date.now();
		await queue.add(() => 1);
		expect(Date.now() - t0).toBeLessThan(20);
	});

	it('still respects concurrency while spacing starts', async () => {
		const queue = new Chiqq({concurrency: 2, taskDelay: 5});
		let active = 0;
		let peak = 0;
		await Promise.all(
			Array.from({length: 8}, () =>
				queue.add(async () => {
					peak = Math.max(peak, ++active);
					await delay(30);
					active--;
				})
			)
		);
		expect(peak).toBe(2);
	});

	it('a per-task taskDelay on an idle queue starts right away', async () => {
		const queue = new Chiqq();
		await queue.add(() => 1);
		const t0 = Date.now();
		await queue.add(() => 2, {taskDelay: 200});
		expect(Date.now() - t0).toBeLessThan(20);
	});

	it('a per-task taskDelay waits for the task that is already running', async () => {
		const queue = new Chiqq({concurrency: 2});
		const t0 = Date.now();
		const first = queue.add(() => delay(100));
		let startedAt = 0;
		await queue.add(
			() => {
				startedAt = Date.now() - t0;
			},
			{taskDelay: 50}
		);
		expect(startedAt).toBeGreaterThanOrEqual(49);
		// A later task without a delay is not held back.
		const t1 = Date.now();
		await queue.add(() => 3);
		expect(Date.now() - t1).toBeLessThan(20);
		await first;
	});

	it('clear() cancels a pending delayed start', async () => {
		const queue = new Chiqq({taskDelay: 50});
		let ran = 0;
		const first = queue.add(() => ran++);
		const second = queue.add(() => ran++);
		expect(queue.clear(true)).toBe(1);
		await first;
		expect(await second).toBeNull();
		await delay(70);
		expect(ran).toBe(1);
	});
});
