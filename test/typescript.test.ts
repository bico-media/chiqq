import {describe, expect, it} from 'bun:test';
import Chiqq, {type ConfigTask, type Configuration} from '../src/index';

describe('Chiqq TypeScript Features', () => {
	it('should support generic return types', async () => {
		const stringQueue = new Chiqq({});

		const stringResult = await stringQueue.add<string>(async () => {
			return 'Hello TypeScript';
		});

		// TypeScript infers string from the generic.
		const uppercased = stringResult.toUpperCase();
		expect(uppercased).toBe('HELLO TYPESCRIPT');
	});

	it('should support per-task type overrides', async () => {
		const queue = new Chiqq({});

		const numberResult = await queue.add<number>(async () => {
			return 42;
		});

		const doubled = numberResult * 2;
		expect(doubled).toBe(84);
	});

	it('should support complex object types', async () => {
		interface UserData {
			id: number;
			name: string;
			email: string;
		}

		const queue = new Chiqq({});

		const userResult = await queue.add<UserData>(async () => {
			return {
				id: 123,
				name: 'John Doe',
				email: 'john@example.com',
			};
		});

		expect(userResult.id).toBe(123);
		expect(userResult.name).toBe('John Doe');
		expect(userResult.email).toBe('john@example.com');
	});

	it('should export proper TypeScript interfaces', () => {
		const config: Configuration = {
			concurrency: 3,
			taskDelay: 100,
			retryMax: 2,
		};

		const taskConfig: ConfigTask = {
			addAsFirst: true,
			taskDelay: 50,
		};

		const queue = new Chiqq(config);
		const status = queue.status();

		expect(status.config.concurrency).toBe(3);
		expect(status.config.taskDelay).toBe(100);
		expect(status.config.retry.max).toBe(2);

		// Exercise the ConfigTask shape so the variable isn't unused
		// and so the per-task type-checks at the call site.
		expect(taskConfig.addAsFirst).toBe(true);
		expect(taskConfig.taskDelay).toBe(50);
	});

	it('should maintain type safety with mixed return types', async () => {
		const queue = new Chiqq({});

		// String task
		const stringTask = queue.add<string>(async () => 'string result');

		// Number task
		const numberTask = queue.add<number>(async () => 123);

		// Boolean task
		const booleanTask = queue.add<boolean>(async () => true);

		const [str, num, bool] = await Promise.all([stringTask, numberTask, booleanTask]);

		expect(str).toBe('string result');
		expect(num).toBe(123);
		expect(bool).toBe(true);

		// TypeScript should know the types
		expect(typeof str).toBe('string');
		expect(typeof num).toBe('number');
		expect(typeof bool).toBe('boolean');
	});

	it('should handle array return types', async () => {
		const queue = new Chiqq({});

		const arrayResult = await queue.add<number[]>(async () => {
			return [1, 2, 3, 4, 5];
		});

		expect(arrayResult).toEqual([1, 2, 3, 4, 5]);
		expect(Array.isArray(arrayResult)).toBe(true);
	});

	it('should handle Promise return types', async () => {
		const queue = new Chiqq({});

		const promiseResult = await queue.add<string>(async () => {
			const innerPromise = Promise.resolve('nested promise');
			return await innerPromise;
		});

		expect(promiseResult).toBe('nested promise');
	});
});
