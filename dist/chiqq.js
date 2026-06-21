// src/index.ts
class ChiqqClearedError extends Error {
	constructor(message = "Chiqq queue cleared") {
		super(message);
		this.name = "ChiqqClearedError";
	}
}

class Chiqq {
	concurrency;
	conf;
	running;
	paused;
	q;
	pauseCallback;
	completeCallback;
	pendingRetry;
	chained;
	constructor(conf = {}) {
		this.conf = {
			taskDelay: conf.taskDelay !== undefined ? Math.max(0, conf.taskDelay | 0) : 0,
			retryMax: conf.retryMax !== undefined ? conf.retryMax | 0 : 0,
			retryCooling: conf.retryCooling !== undefined ? Math.max(0, conf.retryCooling | 0) : 50,
			retryFactor: conf.retryFactor !== undefined ? Math.max(0, conf.retryFactor | 0) : 0
		};
		this.concurrency = Math.max(1, (conf.concurrency || 1) | 0);
		this.paused = !!conf.paused;
		this.running = 0;
		this.q = [];
		this.pauseCallback = null;
		this.completeCallback = null;
		this.pendingRetry = new Set;
		this.chained = null;
	}
	retryDelay(conf, attempt) {
		if (conf.retryFactor <= 1)
			return conf.retryCooling;
		return conf.retryCooling * conf.retryFactor ** (attempt - 1);
	}
	postTaskCheck() {
		if (this.pauseCallback && this.paused && this.running === 0) {
			const cb = this.pauseCallback;
			this.pauseCallback = null;
			cb();
		}
		if (this.completeCallback && this.running === 0 && this.q.length === 0 && this.pendingRetry.size === 0) {
			const cb = this.completeCallback;
			this.completeCallback = null;
			cb();
		}
		if (!this.paused && this.running === 0 && this.q.length === 0) {
			this.chained?.resume();
		}
	}
	tick() {
		if (this.paused)
			return;
		if (this.concurrency <= this.running)
			return;
		const payload = this.q.shift();
		if (!payload)
			return;
		this.chained?.pause();
		this.running++;
		const conf = payload.conf;
		const run = async () => {
			try {
				const result = await payload.task();
				this.running--;
				payload.resolve(result);
				this.postTaskCheck();
				this.next(conf);
			} catch (e) {
				this.running--;
				if (conf.retryMax < 0 || payload.retried < conf.retryMax) {
					payload.retried++;
					const wait = this.retryDelay(conf, payload.retried);
					const entry = { payload, timer: undefined };
					entry.timer = setTimeout(() => {
						this.pendingRetry.delete(entry);
						this.q.unshift(payload);
						this.tick();
					}, wait);
					this.pendingRetry.add(entry);
					this.postTaskCheck();
					this.next(conf);
					return;
				}
				payload.reject(e);
				this.postTaskCheck();
				this.next(conf);
			}
		};
		if (conf.taskDelay) {
			setTimeout(run, 0);
		} else {
			run();
		}
	}
	add(task, configObj = {}) {
		if (typeof task !== "function")
			throw new Error("Please pass a function");
		const conf = { ...this.conf, ...configObj };
		return new Promise((resolve, reject) => {
			const item = { task, resolve, reject, retried: 0, conf };
			if (configObj.addAsFirst) {
				this.q.unshift(item);
			} else {
				this.q.push(item);
			}
			if (conf.taskDelay && this.running) {
				setTimeout(() => this.tick(), conf.taskDelay * this.running);
			} else {
				this.tick();
			}
		});
	}
	addNext(task, configObj = {}) {
		return this.add(task, { ...configObj, addAsFirst: true });
	}
	pause(callback) {
		this.paused = true;
		this.pauseCallback = callback || null;
		this.chained?.pause();
		if (callback && this.running === 0) {
			this.pauseCallback = null;
			Promise.resolve().then(callback);
		}
	}
	resume() {
		this.paused = false;
		this.pauseCallback = null;
		while (this.q.length && this.running < this.concurrency) {
			this.tick();
		}
		if (this.running === 0 && this.q.length === 0) {
			this.chained?.resume();
		}
	}
	chain(queue) {
		this.chained = queue;
		return queue;
	}
	setConcurrency(concurrency) {
		this.concurrency = Math.max(1, concurrency | 0);
		let diff = this.concurrency - this.running;
		while (0 < diff--) {
			this.tick();
		}
	}
	clear(silent = false) {
		const queued = this.q.splice(0, this.q.length);
		const retries = Array.from(this.pendingRetry);
		this.pendingRetry.clear();
		for (const entry of retries)
			clearTimeout(entry.timer);
		const all = [...queued, ...retries.map((e) => e.payload)];
		for (const item of all) {
			if (silent) {
				item.resolve(null);
			} else {
				item.reject(new ChiqqClearedError);
			}
		}
		this.postTaskCheck();
		return all.length;
	}
	onComplete(callback) {
		this.completeCallback = callback;
	}
	next(configObj = {}) {
		const conf = { ...this.conf, ...configObj };
		if (conf.taskDelay && this.running) {
			setTimeout(() => this.tick(), conf.taskDelay);
			return;
		}
		this.tick();
	}
	status() {
		return {
			isPaused: this.paused,
			config: {
				concurrency: this.concurrency,
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
export {
	Chiqq as default,
	ChiqqClearedError
};
