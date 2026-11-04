// Smoke test of the built ESM file, resolved through package.json "exports".
import assert from 'node:assert/strict';
import Chiqq, {Chiqq as Named, ChiqqClearedError} from 'chiqq';

assert.equal(typeof Chiqq, 'function');
assert.equal(Named, Chiqq);
assert.equal(typeof ChiqqClearedError, 'function');

const q = new Chiqq({concurrency: 2});
const results = await Promise.all([1, 2, 3].map(n => q.add(async () => n * 2)));
assert.deepEqual(results, [2, 4, 6]);
assert.deepEqual(await q.addAll([() => 1, async () => 2]), [1, 2]);
await q.onIdle();
console.log('esm ok');
