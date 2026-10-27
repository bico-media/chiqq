// src/index.ts
class TaskQueue {
	items = [];
	head = 0;
	get length() {
		return this.items.length - this.head;
	}
	push(item) {
		this.items.push(item);
	}
	unshift(item) {
		if (this.head > 0) {
			this.items[--this.head] = item;
		} else {
			this.items.unshift(item);
		}
	}
	peek() {
		return this.items[this.head];
	}
	shift() {
		if (this.head === this.items.length)
			return;
		const item = this.items[this.head];
		this.items[this.head++] = undefined;
		if (this.head === this.items.length) {
			this.items = [];
			this.head = 0;
		} else if (this.head > 1024 && this.head * 2 >= this.items.length) {
			this.items = this.items.slice(this.head);
			this.head = 0;
		}
		return item;
	}
	drain() {
		const items = this.items.slice(this.head);
		this.items = [];
		this.head = 0;
		return items;
	}
}

class ChiqqClearedError extends Error {
	constructor(message = "Chiqq queue cleared") {
		super(message);
		this.name = "ChiqqClearedError";
	}
}
var MAX_DELAY = 2 ** 31 - 1;
var noop = () => {};
var DEFAULTS = { taskDelay: 0, retryMax: 0, retryCooling: 50, retryFactor: 0 };
function toNumber(value, fallback) {
	if (value === undefined || value === null)
		return fallback;
	const n = Number(value);
	return Number.isNaN(n) ? fallback : n;
}
var toDelay = (value) => Math.min(MAX_DELAY, Math.max(0, value));
function toConcurrency(value) {
	return Math.max(1, Math.floor(toNumber(value, 1)));
}
function resolveConfig(conf, base) {
	const retryMax = Math.floor(toNumber(conf.retryMax, base.retryMax));
	return {
		taskDelay: toDelay(toNumber(conf.taskDelay, base.taskDelay)),
		retryMax: retryMax < 0 || retryMax === Number.POSITIVE_INFINITY ? -1 : retryMax,
		retryCooling: toDelay(toNumber(conf.retryCooling, base.retryCooling)),
		retryFactor: Math.max(0, toNumber(conf.retryFactor, base.retryFactor))
	};
}
var hasOverrides = (conf) => conf.taskDelay !== undefined || conf.retryMax !== undefined || conf.retryCooling !== undefined || conf.retryFactor !== undefined;

class Chiqq {
	limit;
	conf;
	running;
	paused;
	held;
	q;
	pauseCallback;
	completeCallback;
	errorCallback;
	idleWaiters;
	pendingRetry;
	chained;
	lastStart;
	delayTimer;
	constructor(conf = {}) {
		this.conf = resolveConfig(conf, DEFAULTS);
		this.limit = toConcurrency(conf.concurrency);
		this.paused = !!conf.paused;
		this.held = false;
		this.running = 0;
		this.q = new TaskQueue;
		this.pauseCallback = null;
		this.completeCallback = null;
		this.errorCallback = null;
		this.idleWaiters = [];
		this.pendingRetry = new Set;
		this.chained = null;
		this.lastStart = 0;
		this.delayTimer = null;
	}
	retryDelay(conf, attempt) {
		if (conf.retryFactor <= 1)
			return conf.retryCooling;
		return toDelay(conf.retryCooling * conf.retryFactor ** (attempt - 1));
	}
	fail(item, error, report) {
		const cb = this.errorCallback;
		if (cb) {
			item.promise.catch(noop);
			if (report) {
				try {
					cb(error);
				} catch (e) {
					queueMicrotask(() => {
						throw e;
					});
				}
			}
		}
		item.reject(error);
	}
	isDrained() {
		return this.running === 0 && this.q.length === 0 && this.pendingRetry.size === 0;
	}
	postTaskCheck() {
		if (this.pauseCallback && this.paused && this.running === 0) {
			const cb = this.pauseCallback;
			this.pauseCallback = null;
			cb();
		}
		if (this.isDrained()) {
			if (this.completeCallback) {
				const cb = this.completeCallback;
				this.completeCallback = null;
				cb();
			}
			if (this.idleWaiters.length) {
				const waiters = this.idleWaiters;
				this.idleWaiters = [];
				for (const resolve of waiters)
					resolve();
			}
		}
		if (!this.paused && !this.held && this.running === 0 && this.q.length === 0) {
			this.chained?.release();
		}
	}
	tick() {
		if (this.paused || this.held || this.limit <= this.running)
			return false;
		const payload = this.q.peek();
		if (!payload)
			return false;
		if (payload.conf.taskDelay) {
			const wait = this.lastStart + payload.conf.taskDelay - Date.now();
			if (wait > 0) {
				this.delayTimer ??= setTimeout(() => {
					this.delayTimer = null;
					this.fill();
				}, wait);
				return false;
			}
		}
		this.q.shift();
		this.running++;
		this.lastStart = Date.now();
		if (this.chained && !this.chained.held)
			this.chained.hold();
		this.run(payload);
		return true;
	}
	async run(payload) {
		const conf = payload.conf;
		try {
			const result = await payload.task();
			this.running--;
			payload.resolve(result);
		} catch (e) {
			this.running--;
			if (conf.retryMax < 0 || payload.retried < conf.retryMax) {
				payload.retried++;
				const entry = { payload, timer: undefined };
				entry.timer = setTimeout(() => {
					this.pendingRetry.delete(entry);
					this.q.unshift(payload);
					this.tick();
				}, this.retryDelay(conf, payload.retried));
				this.pendingRetry.add(entry);
			} else {
				this.fail(payload, e, true);
			}
		}
		this.postTaskCheck();
		this.tick();
	}
	add(task, configObj = {}) {
		if (typeof task !== "function")
			throw new Error("Please pass a function");
		const conf = hasOverrides(configObj) ? resolveConfig(configObj, this.conf) : this.conf;
		let item;
		const promise = new Promise((resolve, reject) => {
			item = { task, resolve, reject, retried: 0, conf, promise: undefined };
		});
		item.promise = promise;
		if (configObj.addAsFirst) {
			this.q.unshift(item);
		} else {
			this.q.push(item);
		}
		this.tick();
		return promise;
	}
	addNext(task, configObj = {}) {
		return this.add(task, { ...configObj, addAsFirst: true });
	}
	pause(callback) {
		this.paused = true;
		this.pauseCallback = callback || null;
		this.chained?.hold();
		if (callback && this.running === 0) {
			this.pauseCallback = null;
			Promise.resolve().then(callback);
		}
	}
	resume() {
		this.paused = false;
		this.held = false;
		this.pauseCallback = null;
		this.fill();
	}
	hold() {
		this.held = true;
		this.chained?.hold();
	}
	release() {
		this.held = false;
		this.fill();
	}
	fill() {
		if (this.paused || this.held)
			return;
		while (this.tick()) {}
		if (this.running === 0 && this.q.length === 0) {
			this.chained?.release();
		}
	}
	chain(queue) {
		for (let link = queue;link; link = link.chained) {
			if (link === this)
				throw new Error("Chiqq chain would create a cycle");
		}
		this.chained = queue;
		return queue;
	}
	setConcurrency(concurrency) {
		this.limit = toConcurrency(concurrency);
		this.fill();
	}
	clear(silent = false) {
		const queued = this.q.drain();
		if (this.delayTimer) {
			clearTimeout(this.delayTimer);
			this.delayTimer = null;
		}
		const retries = Array.from(this.pendingRetry);
		this.pendingRetry.clear();
		for (const entry of retries)
			clearTimeout(entry.timer);
		const all = [...queued, ...retries.map((e) => e.payload)];
		for (const item of all) {
			if (silent) {
				item.resolve(null);
			} else {
				this.fail(item, new ChiqqClearedError, false);
			}
		}
		this.postTaskCheck();
		return all.length;
	}
	onComplete(callback) {
		this.completeCallback = callback;
	}
	onError(callback) {
		this.errorCallback = callback;
	}
	onIdle() {
		if (this.isDrained())
			return Promise.resolve();
		return new Promise((resolve) => this.idleWaiters.push(resolve));
	}
	get concurrency() {
		return this.limit;
	}
	get active() {
		return this.running;
	}
	get queued() {
		return this.q.length + this.pendingRetry.size;
	}
	get isPaused() {
		return this.paused || this.held;
	}
	get isIdle() {
		return this.isDrained();
	}
	status() {
		return {
			isPaused: this.paused || this.held,
			config: {
				concurrency: this.limit,
				taskDelay: this.conf.taskDelay,
				retry: {
					max: this.conf.retryMax,
					cooling: this.conf.retryCooling,
					factor: this.conf.retryFactor
				}
			},
			tasks: {
				total: this.q.length + this.running + this.pendingRetry.size,
				active: this.running,
				queued: this.q.length + this.pendingRetry.size
			}
		};
	}
}
var src_default = Chiqq;
export {
	Chiqq,
	ChiqqClearedError,
	src_default as default
};
