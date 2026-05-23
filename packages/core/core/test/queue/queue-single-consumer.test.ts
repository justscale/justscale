/**
 * Queue — single-consumer invariant.
 *
 * The Queue primitive is explicitly single-consumer. The design docs say
 * "multi-consumer competing workers" does NOT exist — this file pins that
 * absence, so nobody silently adds lossy multi-consumer behaviour without
 * touching the invariant tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createQueue } from '../../src/queue/index.js';

describe('Queue single-consumer invariant', () => {
  it('two concurrent for-await loops: second throws synchronously', () => {
    const q = createQueue<number>();
    const iter = q[Symbol.asyncIterator]();
    assert.throws(() => q[Symbol.asyncIterator](), /single-consumer/);
    iter.return!();
  });

  it('iterator.return() releases the single-consumer lock', () => {
    const q = createQueue<number>();
    const iter1 = q[Symbol.asyncIterator]();
    iter1.return!();
    // Re-entry allowed
    const iter2 = q[Symbol.asyncIterator]();
    assert.ok(iter2);
    iter2.return!();
  });

  it('natural completion (close + drain) releases the consumer lock', async () => {
    const q = createQueue<number>([1]);
    q.close();
    for await (const _ of q) { /* drain */ }
    // Queue is closed, but the iterator slot must be free.
    // We can't meaningfully iterate again after close, but attempting
    // must not throw the single-consumer error (it should yield done immediately).
    const iter = q[Symbol.asyncIterator]();
    const r = await iter.next();
    assert.strictEqual(r.done, true);
  });

  it('abandoning iteration WITHOUT return() keeps the lock (pins current bug-shape)', async () => {
    // If a caller drops the iterator reference without break/return, the
    // `consuming` flag stays true forever. This is a known foot-gun. Pins it.
    const q = createQueue<number>();
    void q[Symbol.asyncIterator](); // no return() called, no break, no loop
    assert.throws(() => q[Symbol.asyncIterator](), /single-consumer/);
    // todo(queue): consider weak-ref or GC-driven release, or document this
    // footgun in the Queue class doc-comment.
  });

  it('return() is safe to call multiple times', async () => {
    const q = createQueue<number>();
    const iter = q[Symbol.asyncIterator]();
    await iter.return!();
    await iter.return!();
    await iter.return!();
    const next = q[Symbol.asyncIterator]();
    next.return!();
  });

  it('return() during a pending next() resolves that next() with done=true', async () => {
    const q = createQueue<number>();
    const iter = q[Symbol.asyncIterator]();
    const pending = iter.next();
    await iter.return!();
    const r = await pending;
    assert.strictEqual(r.done, true);
  });
});
