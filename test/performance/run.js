#!/usr/bin/env node
// Chiqq performance comparison.
//
//   node run.js                  run every scenario on every runtime found, write results.md
//   node run.js --runtimes node  limit to a comma separated list of runtimes (node,bun,deno)
//   node run.js --libs chiqq,p-queue
//   node run.js --scenarios sync-c1,backlog-100k
//   node run.js --procs 5        processes per case (default 3), samples are pooled
//   node run.js --out file.md    write somewhere else than results.md
//   node run.js --case <lib> <scenario>   (internal) run one case and print JSON
//
//   CHIQQ_VARIANTS=fast=/abs/path/index.ts,ring=/abs/other.ts node run.js --libs chiqq,chiqq-fast,chiqq-ring
//                                adds chiqq builds to compare against each other
//   CHIQQ_ADD_ALL=1              time variants that have addAll() through it
//
// Every (runtime, lib, scenario) case runs in its own child processes so JIT state and
// heap from one library cannot leak into the next measurement. Each case runs in several
// processes and all samples are pooled, so one unlucky process (JIT, GC, CPU clock)
// does not decide the result.

import {spawnSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CASE_TIMEOUT_MS = 60_000; // hard kill per case
const CASE_BUDGET_MS = 20_000; // stop repeating once a process has used this much time
const SLOW_MS = 1_000; // a case this slow gets no extra processes, the answer is clear
const WARMUP_RUNS = 5; // at least this many untimed runs per process
const WARMUP_MS = 300; // and keep warming up until this much time has passed

// ---------------------------------------------------------------------------
// Libraries. Each adapter returns {add(fn) => Promise} or {runAll(fns) => Promise}.
// ---------------------------------------------------------------------------

const LIBS = {
	chiqq: async () => {
		const {default: Chiqq} = await import(process.env.CHIQQ_ENTRY || '../../src/index.ts');
		return c => {
			const q = new Chiqq({concurrency: c});
			return {add: fn => q.add(fn)};
		};
	},
	...Object.fromEntries(
		(process.env.CHIQQ_VARIANTS || '')
			.split(',')
			.filter(Boolean)
			.map(pair => {
				const [name, entry] = pair.split('=');
				return [
					`chiqq-${name}`,
					async () => {
						const {default: Chiqq} = await import(entry);
						return c => {
							const q = new Chiqq({concurrency: c});
							// A variant with addAll() is timed through it, like promise-pool.
							if (process.env.CHIQQ_ADD_ALL && q.addAll) {
								return {add: fn => q.add(fn), runAll: fns => q.addAll(fns)};
							}
							return {add: fn => q.add(fn)};
						};
					},
				];
			})
	),
	'p-queue': async () => {
		const {default: PQueue} = await import('p-queue');
		return c => {
			const q = new PQueue({concurrency: c});
			return {add: fn => q.add(fn)};
		};
	},
	'p-limit': async () => {
		const {default: pLimit} = await import('p-limit');
		return c => {
			const limit = pLimit(c);
			return {add: fn => limit(fn)};
		};
	},
	fastq: async () => {
		const {default: fastq} = await import('fastq');
		return c => {
			// fastq.promise requires the worker to return a promise.
			const q = fastq.promise(async fn => fn(), c);
			return {add: fn => q.push(fn)};
		};
	},
	async: async () => {
		const {default: async} = await import('async');
		return c => {
			const q = async.queue(async fn => fn(), c);
			return {add: fn => q.pushAsync(fn)};
		};
	},
	bottleneck: async () => {
		const {default: Bottleneck} = await import('bottleneck');
		return c => {
			const limiter = new Bottleneck({maxConcurrent: c});
			return {add: fn => limiter.schedule(fn)};
		};
	},
	'promise-pool': async () => {
		const {PromisePool} = await import('@supercharge/promise-pool');
		return c => ({
			// Array based API: it pulls items lazily, so there is no per-task add().
			runAll: fns =>
				PromisePool.withConcurrency(c)
					.for(fns)
					.process(fn => fn()),
		});
	},
};

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const syncTask = i => () => i;
const microTask = i => async () => {
	await null;
	await null;
	await null;
	return i;
};
const immediate = () => new Promise(r => setImmediate(r));
const ioTask = i => async () => {
	await immediate();
	return i;
};

const SCENARIOS = {
	'sync-c1': {
		title: '10k sync tasks, concurrency 1',
		what: 'Pure per-task overhead of the queue, one at a time.',
		n: 10_000,
		concurrency: 1,
		make: syncTask,
		reps: 15,
	},
	'sync-c16': {
		title: '10k sync tasks, concurrency 16',
		what: 'Per-task overhead with a pool of slots.',
		n: 10_000,
		concurrency: 16,
		make: syncTask,
		reps: 15,
	},
	'async-c16': {
		title: '10k async tasks (3 microtask hops), concurrency 16',
		what: 'Tasks that actually await, but only on microtasks.',
		n: 10_000,
		concurrency: 16,
		make: microTask,
		reps: 15,
	},
	'io-c64': {
		title: '5k I/O-like tasks (setImmediate), concurrency 64',
		what: 'Each task yields to the event loop once, closest to real I/O.',
		n: 5_000,
		concurrency: 64,
		make: ioTask,
		reps: 10,
	},
	'backlog-100k': {
		title: '100k sync tasks queued at once, concurrency 16',
		what: 'Large backlog. Exposes O(n) dequeue (Array.shift) behaviour.',
		n: 100_000,
		concurrency: 16,
		make: syncTask,
		reps: 5,
		warmup: false,
	},
	'memory-100k': {
		title: 'Heap per queued task (100k waiting behind a blocked slot)',
		what: 'Retained heap per pending task, measured after a forced GC.',
		n: 100_000,
		concurrency: 1,
		memory: true,
	},
};

// ---------------------------------------------------------------------------
// Single case (child process)
// ---------------------------------------------------------------------------

const now = () => performance.now();
// Linear interpolation between closest ranks.
const quantile = (xs, q) => {
	const s = [...xs].sort((a, b) => a - b);
	const pos = (s.length - 1) * q;
	const lo = Math.floor(pos);
	return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo);
};
const median = xs => quantile(xs, 0.5);

function gc() {
	if (typeof globalThis.Bun !== 'undefined') return globalThis.Bun.gc(true);
	if (typeof globalThis.gc === 'function') return globalThis.gc();
}

const heapUsed = () => process.memoryUsage().heapUsed;

async function runOnce(factory, sc) {
	const fns = new Array(sc.n);
	for (let i = 0; i < sc.n; i++) fns[i] = sc.make(i);
	const q = factory(sc.concurrency);
	const t0 = now();
	if (q.runAll) {
		await q.runAll(fns);
	} else {
		const ps = new Array(sc.n);
		for (let i = 0; i < sc.n; i++) ps[i] = q.add(fns[i]);
		await Promise.all(ps);
	}
	return now() - t0;
}

async function runMemory(factory, sc) {
	const q = factory(sc.concurrency);
	if (!q.add) return {skipped: 'array based API, no per-task queue'};
	if (!globalThis.Bun && typeof globalThis.gc !== 'function') return {skipped: 'no gc() exposed'};
	const fns = new Array(sc.n);
	for (let i = 0; i < sc.n; i++) fns[i] = syncTask(i);
	const ps = new Array(sc.n);
	let open;
	const gate = new Promise(r => {
		open = r;
	});
	const blocker = q.add(() => gate);
	await null;
	gc();
	const before = heapUsed();
	for (let i = 0; i < sc.n; i++) ps[i] = q.add(fns[i]);
	gc();
	const after = heapUsed();
	open();
	await Promise.all([blocker, ...ps]);
	return {bytesPerTask: (after - before) / sc.n};
}

async function runCase(libName, scenarioName) {
	const factory = await LIBS[libName]();
	const sc = SCENARIOS[scenarioName];
	if (sc.memory) return runMemory(factory, sc);
	const start = now();
	const times = [];
	if (sc.warmup !== false) {
		// The JIT keeps tiering up for several runs, so warm up for a while.
		for (let i = 0; i < WARMUP_RUNS || now() - start < WARMUP_MS; i++) {
			const warm = await runOnce(factory, sc);
			// Very slow libraries: one run is already a clear enough answer.
			if (warm > CASE_BUDGET_MS / 4) {
				times.push(warm);
				break;
			}
		}
	}
	while (times.length < sc.reps && (times.length === 0 || now() - start < CASE_BUDGET_MS)) {
		times.push(await runOnce(factory, sc));
	}
	return {times};
}

// Pools the samples of all processes of a case into one result.
function summarize(times, n) {
	const ms = median(times);
	// Half the interquartile range, relative to the median: "most runs are within +-x%".
	const spread = (quantile(times, 0.75) - quantile(times, 0.25)) / 2 / ms;
	return {ms, opsPerSec: (n / ms) * 1000, runs: times.length, spread};
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

const RUNTIMES = {
	node: {cmd: 'node', args: ['--expose-gc', '--no-warnings'], version: ['--version']},
	bun: {cmd: 'bun', args: [], version: ['--version']},
	deno: {cmd: 'deno', args: ['run', '-A', '--v8-flags=--expose-gc'], version: ['--version']},
};

function runtimeVersion(rt) {
	const r = spawnSync(RUNTIMES[rt].cmd, RUNTIMES[rt].version, {encoding: 'utf8'});
	if (r.error || r.status !== 0) return null;
	return r.stdout.split('\n')[0].trim();
}

function spawnCase(rt, lib, scenario) {
	const {cmd, args} = RUNTIMES[rt];
	const r = spawnSync(cmd, [...args, join(here, 'run.js'), '--case', lib, scenario], {
		cwd: here,
		encoding: 'utf8',
		timeout: CASE_TIMEOUT_MS,
		env: process.env,
	});
	if (r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM') {
		return {timeout: true};
	}
	const line = r.stdout.trim().split('\n').pop();
	try {
		return JSON.parse(line);
	} catch {
		return {error: (r.stderr || r.stdout || 'no output').trim().split('\n')[0]};
	}
}

function argList(flag) {
	const i = process.argv.indexOf(flag);
	return i > 0 ? process.argv[i + 1].split(',') : null;
}

// Runs a case in up to `procs` processes and pools the samples.
function measureCase(rt, lib, sc, procs) {
	const times = [];
	for (let p = 0; p < procs; p++) {
		const res = spawnCase(rt, lib, sc);
		if (!res.times) return res;
		times.push(...res.times);
		if (median(times) > SLOW_MS) break;
	}
	return summarize(times, SCENARIOS[sc].n);
}

function libVersion(lib) {
	if (lib.startsWith('chiqq-')) return 'variant';
	if (lib === 'chiqq') {
		return `${JSON.parse(readFileSync(join(here, '../../package.json'), 'utf8')).version} (src)`;
	}
	const pkg = {'promise-pool': '@supercharge/promise-pool'}[lib] || lib;
	return JSON.parse(readFileSync(join(here, 'node_modules', pkg, 'package.json'), 'utf8')).version;
}

const fmtMs = ms => (ms < 10 ? ms.toFixed(2) : ms < 100 ? ms.toFixed(1) : ms.toFixed(0));
function cell(res, best, memory) {
	if (!res) return '-';
	if (res.timeout) return `timeout (>${CASE_TIMEOUT_MS / 1000}s)`;
	if (res.error) return `error: ${res.error.slice(0, 40)}`;
	if (res.skipped) return 'n/a';
	if (memory) return `${Math.round(res.bytesPerTask)} B`;
	const rel = (res.ms / best).toFixed(2);
	return `${rel}x ${fmtMs(res.ms)} ms ±${Math.round(res.spread * 100)}%`;
}

async function orchestrate() {
	const runtimes = (argList('--runtimes') || Object.keys(RUNTIMES)).filter(rt => {
		const v = runtimeVersion(rt);
		if (!v) console.error(`skip runtime ${rt}: not found`);
		return v;
	});
	const libs = argList('--libs') || Object.keys(LIBS);
	const scenarios = argList('--scenarios') || Object.keys(SCENARIOS);
	const procs = Number(argList('--procs')?.[0] || 3);
	const outFile = argList('--out')?.[0] || join(here, 'results.md');
	const results = {};

	for (const sc of scenarios) {
		for (const rt of runtimes) {
			for (const lib of libs) {
				process.stderr.write(`${sc.padEnd(14)} ${rt.padEnd(5)} ${lib.padEnd(13)} `);
				const res = SCENARIOS[sc].memory ? spawnCase(rt, lib, sc) : measureCase(rt, lib, sc, procs);
				results[`${sc}|${rt}|${lib}`] = res;
				process.stderr.write(
					`${res.ms !== undefined ? `${fmtMs(res.ms)} ms` : res.bytesPerTask !== undefined ? `${Math.round(res.bytesPerTask)} B/task` : JSON.stringify(res)}\n`
				);
			}
		}
	}

	const out = [];
	out.push('# Chiqq performance results', '');
	out.push('Generated by `test/performance/run.sh` (`node run.js`). Do not edit by hand.', '');
	out.push(`- Date: ${new Date().toISOString().slice(0, 10)}`);
	out.push(
		`- Machine: ${os.cpus()[0].model}, ${os.cpus().length} cores, ${Math.round(os.totalmem() / 2 ** 30)} GB, ${os.platform()} ${os.release()}`
	);
	out.push(`- Runtimes: ${runtimes.map(rt => `${rt} ${runtimeVersion(rt)}`).join(', ')}`);
	out.push(`- Libraries: ${libs.map(l => `${l} ${libVersion(l)}`).join(', ')}`);
	out.push(
		`- Each case runs in ${procs} fresh processes: ${WARMUP_RUNS}+ warmup runs (at least ${WARMUP_MS} ms) each, then up to N timed runs (capped at a ${CASE_BUDGET_MS / 1000}s budget per process, killed after ${CASE_TIMEOUT_MS / 1000}s). Cases slower than ${SLOW_MS / 1000}s get a single process.`,
		'- Each cell: time relative to the fastest library on that runtime (1.00x is the fastest, 1.50x took one and a half times as long), then the median time over all pooled runs, then the spread: half the interquartile range, so most runs land within that many percent of the median. Differences smaller than the spread are noise.'
	);
	out.push('');

	for (const sc of scenarios) {
		const def = SCENARIOS[sc];
		out.push(`## ${def.title}`, '', `\`${sc}\` - ${def.what}`, '');
		out.push(`| Library | ${runtimes.join(' | ')} |`);
		out.push(`| --- | ${runtimes.map(() => '---').join(' | ')} |`);
		const best = {};
		for (const rt of runtimes) {
			const vals = libs.map(l => results[`${sc}|${rt}|${l}`]?.ms).filter(v => v !== undefined);
			best[rt] = Math.min(...vals);
		}
		for (const lib of libs) {
			const cells = runtimes.map(rt => cell(results[`${sc}|${rt}|${lib}`], best[rt], def.memory));
			out.push(`| ${lib} | ${cells.join(' | ')} |`);
		}
		out.push('');
	}

	writeFileSync(outFile, out.join('\n'));
	console.error(`\nwrote ${outFile}`);
}

if (process.argv[2] === '--case') {
	const res = await runCase(process.argv[3], process.argv[4]);
	console.log(JSON.stringify(res));
	process.exit(0);
} else {
	await orchestrate();
}
