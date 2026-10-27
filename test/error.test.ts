import {describe, expect, it} from 'bun:test';
import {join} from 'node:path';
import Chiqq, {ChiqqClearedError} from '../src/index';

const entry = join(import.meta.dir, '../src/index.ts');

// Runs a script in a fresh process, so unhandled rejections can be observed
// without taking down the test runner.
function runScript(body: string) {
	const script = `import Chiqq from ${JSON.stringify(entry)};\n${body}`;
	const r = Bun.spawnSync([process.execPath, '-e', script], {stderr: 'pipe', stdout: 'pipe'});
	return {code: r.exitCode, out: r.stdout.toString().trim()};
}

describe('onError()', () => {
	it('receives the final error after retries run out', async () => {
		const queue = new Chiqq({retryMax: 2, retryCooling: 0});
		const errors: unknown[] = [];
		queue.onError(e => errors.push(e));
		let attempts = 0;
		await queue
			.add(() => {
				throw new Error(`fail ${++attempts}`);
			})
			.catch(() => {});
		expect(errors.length).toBe(1);
		expect((errors[0] as Error).message).toBe('fail 3');
	});

	it('is not called when a retry succeeds', async () => {
		const queue = new Chiqq({retryMax: 1, retryCooling: 0});
		let called = false;
		queue.onError(() => {
			called = true;
		});
		let attempts = 0;
		await queue.add(() => {
			if (++attempts === 1) throw new Error('once');
		});
		expect(called).toBe(false);
	});

	it('still rejects awaited promises', async () => {
		const queue = new Chiqq();
		queue.onError(() => {});
		await expect(
			queue.add(() => {
				throw new Error('boom');
			})
		).rejects.toThrow('boom');
	});

	it('is not called for cleared tasks', async () => {
		const queue = new Chiqq({paused: true});
		let called = false;
		queue.onError(() => {
			called = true;
		});
		const p = queue.add(() => 1);
		queue.clear();
		await expect(p).rejects.toBeInstanceOf(ChiqqClearedError);
		expect(called).toBe(false);
	});

	it('can be removed with null', async () => {
		const queue = new Chiqq();
		let called = false;
		queue.onError(() => {
			called = true;
		});
		queue.onError(null);
		await queue
			.add(() => {
				throw new Error('boom');
			})
			.catch(() => {});
		expect(called).toBe(false);
	});

	it('keeps unawaited failures and clears from crashing the process', () => {
		const r = runScript(`
			const q = new Chiqq({concurrency: 1});
			q.onError(() => {});
			q.add(() => { throw new Error('boom'); });
			q.add(() => new Promise(r => setTimeout(r, 10)));
			q.add(() => 1);
			q.clear();
			setTimeout(() => console.log('alive'), 30);
		`);
		expect(r.out).toBe('alive');
		expect(r.code).toBe(0);
	});

	it('without a handler, an unawaited failure is an unhandled rejection', () => {
		const r = runScript(`
			const q = new Chiqq();
			q.add(() => { throw new Error('boom'); });
			setTimeout(() => console.log('alive'), 30);
		`);
		expect(r.code).not.toBe(0);
	});

	it('a throwing handler does not stall the queue', () => {
		const r = runScript(`
			process.on('uncaughtException', e => console.log('uncaught ' + e.message));
			const q = new Chiqq({concurrency: 1});
			q.onError(() => { throw new Error('handler'); });
			q.add(() => { throw new Error('boom'); });
			q.add(() => 'next').then(v => console.log(v));
		`);
		expect(r.out.split('\n').sort()).toEqual(['next', 'uncaught handler']);
	});
});
