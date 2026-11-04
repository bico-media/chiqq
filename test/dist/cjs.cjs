// Smoke test of the built CommonJS file, resolved through package.json "exports".
const assert = require('node:assert/strict');
const Chiqq = require('chiqq');
const {Chiqq: Named, ChiqqClearedError} = require('chiqq');

assert.equal(typeof Chiqq, 'function');
assert.equal(Chiqq.default, Chiqq);
assert.equal(Named, Chiqq);
assert.equal(typeof ChiqqClearedError, 'function');

const q = new Chiqq({concurrency: 2});
Promise.all([1, 2, 3].map(n => q.add(async () => n * 2)))
	.then(results => {
		assert.deepEqual(results, [2, 4, 6]);
		return q.addAll([() => 1, async () => 2]);
	})
	.then(results => {
		assert.deepEqual(results, [1, 2]);
		console.log('cjs ok');
	});
