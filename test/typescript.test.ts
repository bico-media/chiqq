import {describe, it, expect} from 'bun:test';
import Chiqq, {Configuration, ConfigTask} from '../src/index';

describe('Chiqq TypeScript Features', () => {
	it('should support generic return types', async () => {
		const stringQueue = new Chiqq({});

		const stringResult = await stringQueue.add(async () => {
			return 'Hello TypeScript';
		});

		// TypeScript should infer this is string
		const uppercased = (stringResult as string).toUpperCase();
		expect(uppercased).toBe('HELLO TYPESCRIPT');
	});

	it('should support per-task type overrides', async () => {
		const queue = new Chiqq({});

		const numberResult = await queue.add(async () => {
			return 42;
		});

		const doubled = (numberResult as number) * 2;
		expect(doubled).toBe(84);
	});

	it('should support complex object types', async () => {
		interface UserData {
			id: number;
			name: string;
			email: string;
		}

		const queue = new Chiqq({});

		const userResult = (await queue.add(async () => {
			return {
				id: 123,
				name: 'John Doe',
				email: 'john@example.com',
			};
		})) as UserData;

		expect(userResult.id).toBe(123);
		expect(userResult.name).toBe('John Doe');
		expect(userResult.email).toBe('john@example.com');
	});

	it('should export proper TypeScript interfaces', () => {
		const config: Configuration = {
			concurrency: 3,
			chill: 100,
			retryMax: 2,
		};

		const taskConfig: ConfigTask = {
			addAsFirst: true,
			chill: 50,
		};

		const queue = new Chiqq(config);
		const insight = queue.insight();

		expect(insight.concurrency).toBe(3);
		expect(insight.chill).toBe(100);
		expect(insight.retryMax).toBe(2);
	});

	it('should maintain type safety with mixed return types', async () => {
		const queue = new Chiqq({});

		// String task
		const stringTask = queue.add(async () => 'string result');

		// Number task
		const numberTask = queue.add(async () => 123);

		// Boolean task
		const booleanTask = queue.add(async () => true);

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

		const arrayResult = await queue.add(async () => {
			return [1, 2, 3, 4, 5];
		});

		expect(arrayResult).toEqual([1, 2, 3, 4, 5]);
		expect(Array.isArray(arrayResult)).toBe(true);
	});

	it('should handle Promise return types', async () => {
		const queue = new Chiqq({});

		const promiseResult = await queue.add(async () => {
			const innerPromise = Promise.resolve('nested promise');
			return await innerPromise;
		});

		expect(promiseResult).toBe('nested promise');
	});
});
