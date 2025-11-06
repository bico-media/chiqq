var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __moduleCache = /* @__PURE__ */ new WeakMap;
var __toCommonJS = (from) => {
  var entry = __moduleCache.get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function")
    __getOwnPropNames(from).map((key) => !__hasOwnProp.call(entry, key) && __defProp(entry, key, {
      get: () => from[key],
      enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
    }));
  __moduleCache.set(from, entry);
  return entry;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: (newValue) => all[name] = () => newValue
    });
};

// src/index.ts
var exports_src = {};
__export(exports_src, {
  default: () => Chiqq
});
module.exports = __toCommonJS(exports_src);
var delay = async (timeout) => {
  return new Promise((resolve) => {
    setTimeout(() => resolve(null), timeout);
  });
};

class Chiqq {
  concurrency;
  conf;
  running;
  paused;
  q;
  constructor(conf) {
    this.conf = {
      chill: (conf.chill || 1) | 0,
      retryMax: (conf.retryMax || 0) | 0,
      retryCooling: (conf.retryCooling || 50) | 0,
      retryFactor: (conf.retryFactor || 0) | 0
    };
    this.concurrency = (conf.concurrency || 1) | 0;
    this.paused = !!conf.paused || false;
    this.running = 0;
    this.q = [];
  }
  async tick() {
    if (this.paused)
      return;
    if (this.concurrency <= this.running)
      return;
    const payload = this.q.shift();
    if (!payload)
      return;
    this.running++;
    let conf = { ...this.conf, ...payload.conf };
    const run = async () => {
      let result;
      try {
        result = await payload.task();
      } catch (e) {
        this.running--;
        if (conf.retryMax < 0 || payload.retried++ < conf.retryMax) {
          setTimeout(() => {
            this.q.unshift(payload);
            this.tick();
          }, conf.retryCooling + conf.retryCooling * conf.retryFactor);
        } else {
          payload.reject(e);
        }
        return this.next();
      }
      this.running--;
      payload.resolve(result);
      return this.next(conf);
    };
    if (conf.chill) {
      Promise.resolve(setTimeout(() => run(), 0));
    } else {
      Promise.resolve(run());
    }
  }
  add(task, configObj = {}) {
    if (typeof task !== "function")
      throw new Error("Please pass a function");
    return new Promise(async (resolve, reject) => {
      let conf = { ...this.conf, ...configObj };
      if (conf.addAsFirst) {
        this.q.unshift({ task, resolve, reject, retried: 0, conf });
      } else {
        this.q.push({ task, resolve, reject, retried: 0, conf });
      }
      if (conf.chill && this.running) {
        await delay(conf.chill * this.running);
      }
      this.tick();
    });
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
    while (this.q.length && this.running < this.concurrency) {
      this.tick();
    }
  }
  next(configObj = {}) {
    let conf = { ...this.conf, ...configObj };
    if (conf.chill && this.running) {
      return setTimeout(() => {
        this.tick();
      }, conf.chill);
    }
    return this.tick();
  }
  insight() {
    return {
      concurrency: this.concurrency,
      paused: this.paused,
      qLength: this.q.length,
      running: this.running,
      chill: this.conf.chill,
      retryMax: this.conf.retryMax,
      retryCooling: this.conf.retryCooling,
      retryFactor: this.conf.retryFactor
    };
  }
}
