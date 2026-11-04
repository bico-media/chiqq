import {describe, expect, it} from 'bun:test';
import Chiqq from '../src/index';

// A minimal non-native thenable, like the ones some older libraries return.
// Typed as a Promise only so add() accepts it.
const thenable = <T>(settle: (ok: (v: T) => void, fail: (e: unknown) => void) => void) =>
	({
		then(ok: (v: T) => void, fail: (e: unknown) => void) {
			setTimeout(() => settle(ok, fail), 1);
		},
	}) as unknown as Promise<T>;

describe('Task results', () => {
	it('wraps up a plain value on the next microtask, not inside add()', async () => {
		const queue = new Chiqq({concurrency: 1});
		const order: string[] = [];
		queue.add(() => order.push('a'));
		queue.add(() => order.push('b'));
		// a has run, but its slot is only freed after this code is done.
		expect(order).toEqual(['a']);
		expect(queue.active).toBe(1);
		expect(queue.isIdle).toBe(false);
		await queue.onIdle();
		expect(order).toEqual(['a', 'b']);
	});

	it('handles a synchronous throw inside add()', async () => {
		const queue = new Chiqq({concurrency: 1});
		const failed = queue.add(() => {
			throw new Error('sync');
		});
		// The slot is already free again, and the error is already decided.
		expect(queue.active).toBe(0);
		expect(queue.isIdle).toBe(true);
		await expect(failed).rejects.toThrow('sync');
	});

	it('adopts a non-native thenable', async () => {
		const queue = new Chiqq();
		expect(await queue.add(() => thenable<number>(ok => ok(7)))).toBe(7);
	});

	it('retries a rejecting non-native thenable', async () => {
		const queue = new Chiqq({retryMax: 2, retryCooling: 1});
		let calls = 0;
		const result = await queue.add(() =>
			thenable<string>((ok, fail) => (++calls < 3 ? fail(new Error('no')) : ok('yes')))
		);
		expect(result).toBe('yes');
		expect(calls).toBe(3);
	});

	it('retries a task that throws synchronously', async () => {
		const queue = new Chiqq({retryMax: 1, retryCooling: 1});
		let calls = 0;
		const result = await queue.add(() => {
			if (++calls === 1) throw new Error('first');
			return 'second';
		});
		expect(result).toBe('second');
		expect(calls).toBe(2);
	});

	it('rejects with the error from a thenable whose then getter throws', async () => {
		const queue = new Chiqq({retryMax: 0});
		const bad = {
			get then() {
				throw new Error('getter');
			},
		};
		await expect(queue.add(() => bad)).rejects.toThrow('getter');
	});
});
