import {describe, expect, it} from 'bun:test';
import Chiqq from '../src/index';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Builds a task that waits `ms` then records its name in the shared order array.
const makeTask = (order: string[], name: string, ms = 5) => async () => {
	await delay(ms);
	order.push(name);
	return name;
};

const swallow = () => undefined;

describe('Chiqq.chain() - 2 queues', () => {
	it('runs upstream tasks before downstream tasks (priority)', async () => {
		const a = new Chiqq();
		const b = new Chiqq();
		a.chain(b);

		const order: string[] = [];
		// Adding to `a` pauses `b` synchronously, so b1 is queued, not started.
		const pa = a.add(makeTask(order, 'a1'));
		const pb = b.add(makeTask(order, 'b1'));

		await Promise.all([pa, pb]);
		expect(order).toEqual(['a1', 'b1']);
	});

	it('cascades a manual pause to the chained queue', () => {
		const a = new Chiqq();
		const b = new Chiqq();
		a.chain(b);

		a.pause();
		expect(b.status().isPaused).toBe(true);
	});

	it('chain() returns the chained queue and does not pause it', () => {
		const a = new Chiqq();
		const b = new Chiqq();

		const returned = a.chain(b);
		expect(returned).toBe(b);
		expect(b.status().isPaused).toBe(false);
	});
});

describe('Chiqq.chain() - 3 queues', () => {
	it('runs in priority order a -> b -> c', async () => {
		const a = new Chiqq();
		const b = new Chiqq();
		const c = new Chiqq();
		a.chain(b).chain(c);

		const order: string[] = [];
		const pa = a.add(makeTask(order, 'a1'));
		const pb = b.add(makeTask(order, 'b1'));
		const pc = c.add(makeTask(order, 'c1'));

		await Promise.all([pa, pb, pc]);
		expect(order).toEqual(['a1', 'b1', 'c1']);
	});

	it('cascades a pause through all links', () => {
		const a = new Chiqq();
		const b = new Chiqq();
		const c = new Chiqq();
		a.chain(b).chain(c);

		a.pause();
		expect(b.status().isPaused).toBe(true);
		expect(c.status().isPaused).toBe(true);
	});

	it('resume flows past an empty middle queue (b empty)', async () => {
		const a = new Chiqq();
		const b = new Chiqq();
		const c = new Chiqq();
		a.chain(b).chain(c);

		const order: string[] = [];
		const pa = a.add(makeTask(order, 'a1'));
		const pc = c.add(makeTask(order, 'c1'));

		await Promise.all([pa, pc]);
		expect(order).toEqual(['a1', 'c1']);
	});
});

describe('Chiqq.chain() - 4 queues', () => {
	it('runs in priority order a -> b -> c -> d', async () => {
		const a = new Chiqq();
		const b = new Chiqq();
		const c = new Chiqq();
		const d = new Chiqq();
		a.chain(b).chain(c).chain(d);

		const order: string[] = [];
		const pa = a.add(makeTask(order, 'a1'));
		const pb = b.add(makeTask(order, 'b1'));
		const pc = c.add(makeTask(order, 'c1'));
		const pd = d.add(makeTask(order, 'd1'));

		await Promise.all([pa, pb, pc, pd]);
		expect(order).toEqual(['a1', 'b1', 'c1', 'd1']);
	});

	it('cascades a pause to every queue', () => {
		const a = new Chiqq();
		const b = new Chiqq();
		const c = new Chiqq();
		const d = new Chiqq();
		a.chain(b).chain(c).chain(d);

		a.pause();
		expect(b.status().isPaused).toBe(true);
		expect(c.status().isPaused).toBe(true);
		expect(d.status().isPaused).toBe(true);
	});

	it('pause propagates through empty middle queues (add to d, then a)', async () => {
		const a = new Chiqq();
		const b = new Chiqq();
		const c = new Chiqq();
		const d = new Chiqq();
		a.chain(b).chain(c).chain(d);

		const order: string[] = [];
		// d has no upstream work yet, so it starts immediately.
		const pd = d.add(makeTask(order, 'd1', 30));
		// a starting its task must pause b, c AND d - even though b and c are empty.
		const pa = a.add(makeTask(order, 'a1', 5));

		expect(d.status().isPaused).toBe(true);

		await Promise.all([pd, pa]);
	});

	it('resume propagates through empty middle queues (tasks only in a and d)', async () => {
		const a = new Chiqq();
		const b = new Chiqq();
		const c = new Chiqq();
		const d = new Chiqq();
		a.chain(b).chain(c).chain(d);

		const order: string[] = [];
		const pa = a.add(makeTask(order, 'a1'));
		const pd = d.add(makeTask(order, 'd1'));

		await Promise.all([pa, pd]);
		expect(order).toEqual(['a1', 'd1']);
	});
});

describe('Chiqq.chain() - behaviour', () => {
	it('reclaims priority: new upstream work re-pauses a running chain', async () => {
		const a = new Chiqq();
		const b = new Chiqq();
		a.chain(b);

		const order: string[] = [];
		// a drains quickly, handing off to b.
		await a.add(makeTask(order, 'a1', 5));

		// b is now free; start a slow b task.
		const pb1 = b.add(makeTask(order, 'b1', 50));
		await delay(10);
		expect(b.status().isPaused).toBe(false);

		// New upstream work reclaims priority and re-pauses b.
		const pa2 = a.add(makeTask(order, 'a2', 5));
		expect(b.status().isPaused).toBe(true);

		await Promise.all([pb1, pa2]);
		// a2 jumped ahead of the in-flight b1.
		expect(order).toEqual(['a1', 'a2', 'b1']);
	});

	it('retry cooldown does NOT hold the chain', async () => {
		const a = new Chiqq({retryMax: 1, retryCooling: 40});
		const b = new Chiqq();
		a.chain(b);

		const order: string[] = [];
		let attempts = 0;
		const pa = a.add(async () => {
			attempts++;
			if (attempts === 1) throw new Error('boom');
			order.push('a-final');
			return 'a-final';
		});
		const pb = b.add(makeTask(order, 'b1', 5));

		await Promise.all([pa, pb]);
		expect(attempts).toBe(2);
		// b ran during a's cooldown, then a's retry completed.
		expect(order).toEqual(['b1', 'a-final']);
	});

	it('clearing the upstream backlog lets the chain take its turn', async () => {
		const a = new Chiqq({concurrency: 1});
		const b = new Chiqq();
		a.chain(b);

		const order: string[] = [];
		a.add(makeTask(order, 'a1', 50)).catch(swallow); // running, holds b
		a.add(makeTask(order, 'a2', 5)).catch(swallow); // queued
		const pb = b.add(makeTask(order, 'b1', 5)); // queued behind a

		await delay(10);
		expect(b.status().isPaused).toBe(true);

		expect(a.clear()).toBe(1); // removes the queued a2

		await pb;
		expect(order).toEqual(['a1', 'b1']);
	});

	it('resuming a middle queue starts it immediately (resume only the top)', async () => {
		const a = new Chiqq();
		const b = new Chiqq();
		a.chain(b);

		const order: string[] = [];
		a.add(makeTask(order, 'a1', 50)).catch(swallow); // running, holds b
		const pb = b.add(makeTask(order, 'b1', 5)); // queued

		await delay(10);
		expect(b.status().isPaused).toBe(true);

		// Resuming a middle queue directly starts it out of priority order.
		b.resume();
		await pb;
		expect(order).toContain('b1');
	});
});
