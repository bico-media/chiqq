// Fails when a large queue gets dramatically slower, like the quadratic Array.shift() of 2.2.0
// or the stack overflow with throwing tasks. Not a benchmark: the limits are more than ten times
// the normal time, so only a real regression trips them. Runs on the built files, so build first.
//   bun run build && node test/performance/guard.js
import Chiqq from '../../dist/chiqq.js';

const N = 100_000;
// One shared error: creating 100k errors with stack traces would take longer than the queue.
const boom = new Error('x');

const cases = {
	'100k tasks queued at once': {
		limit: 1000,
		run: async () => {
			const q = new Chiqq({concurrency: 16});
			const all = [];
			for (let i = 0; i < N; i++) all.push(q.add(() => i));
			await Promise.all(all);
		},
	},
	'100k addNext() on a paused queue': {
		limit: 1000,
		run: async () => {
			const q = new Chiqq({paused: true});
			const all = [];
			for (let i = 0; i < N; i++) all.push(q.addNext(() => i));
			q.resume();
			await Promise.all(all);
		},
	},
	'100k tasks that throw': {
		limit: 1000,
		run: async () => {
			const q = new Chiqq({paused: true});
			const all = [];
			for (let i = 0; i < N; i++) {
				all.push(
					q
						.add(() => {
							throw boom;
						})
						.catch(() => {})
				);
			}
			q.resume();
			await Promise.all(all);
		},
	},
	'100k tasks through addAll()': {
		limit: 1000,
		run: async () => {
			const q = new Chiqq({concurrency: 16});
			await q.addAll(Array.from({length: N}, (_, i) => () => i));
		},
	},
};

let failed = false;
for (const [name, {limit, run}] of Object.entries(cases)) {
	// Best of three, so one slow run from other work on the machine does not count.
	let best = Number.POSITIVE_INFINITY;
	try {
		for (let i = 0; i < 3; i++) {
			const start = performance.now();
			await run();
			best = Math.min(best, performance.now() - start);
		}
	} catch (error) {
		console.log(`FAIL ${name}: ${error.message}`);
		failed = true;
		continue;
	}
	const ok = best < limit;
	if (!ok) failed = true;
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${best.toFixed(1)} ms (limit ${limit} ms)`);
}
if (failed) process.exit(1);
