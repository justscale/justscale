/**
 * Queue — FIFO / lifecycle edge cases.
 *
 * Each test pins a specific invariant about push/pop ordering, waiter
 * resolution timing, and close/return semantics. These are the behaviours
 * that silently break if someone "optimises" the inner queue in the future.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createQueue } from '../../src/queue/index.js';

describe('Queue FIFO edges', () => {
  it('push during waiter resolution goes to buffer, not direct delivery', async () => {
    // Invariant: once a waiter is consumed (paired with a push), the NEXT
    // push must land in the buffer — not resolve a stale waiter.
    const q = createQueue<number>();

    const seen: number[] = [];
    const consumer = (async () => {
      for await (const item of q) {
        seen.push(item);
        if (seen.length >= 2) break;
      }
    })();

    // Microtask ordering: consumer awaits -> waiter installed
    await Promise.resolve();
    q.push(1);              // resolves waiter
    q.push(2);              // should buffer; waiter already consumed
    // After the first next() resolves, the iterator's next call should pick
    // up item 2 from the buffer, not hang.
    await consumer;
    assert.deepStrictEqual(seen, [1, 2]);
  });

  it('empty dequeue blocks (does not return null or throw)', async () => {
    // Pins: dequeue on empty queue blocks indefinitely until push or close.
    // Does NOT return null, does NOT throw.
    const q = createQueue<string>();
    const iter = q[Symbol.asyncIterator]();

    let settled = false;
    const p = iter.next().then(() => { settled = true; });

    // Give event loop several turns — should still not be settled
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(settled, false, 'empty dequeue must block');

    // Clean up so the test can exit
    q.close();
    await p;
    assert.strictEqual(settled, true);
  });

  it('push after close is silently dropped (not thrown)', () => {
    // Pins: post-close push is a no-op. If someone changes this to throw,
    // downstream callers that race push/close will start blowing up.
    const q = createQueue<string>();
    q.close();
    q.push('a');
    q.push('b');
    assert.strictEqual(q.length, 0);
  });

  it('close with pending waiter resolves with done=true (not with a value)', async () => {
    const q = createQueue<number>();
    const iter = q[Symbol.asyncIterator]();
    const pending = iter.next();
    q.close();
    const result = await pending;
    assert.strictEqual(result.done, true);
    assert.strictEqual(result.value, undefined);
  });

  it('close drains buffered items before ending', async () => {
    const q = createQueue<number>([1, 2, 3]);
    q.close();
    const seen: number[] = [];
    for await (const v of q) seen.push(v);
    assert.deepStrictEqual(seen, [1, 2, 3]);
  });

  it('close is idempotent', () => {
    const q = createQueue<number>();
    q.close();
    q.close(); // must not throw
    q.close();
    assert.strictEqual(q.length, 0);
  });

  it('1000-item FIFO preserves exact order under interleaved push/pop', async () => {
    // Stress the ordering invariant. No assumptions about scheduling beyond
    // "push N items, consume N items, list equals [0..N-1]".
    const N = 1000;
    const q = createQueue<number>();
    for (let i = 0; i < N; i++) q.push(i);
    const seen: number[] = [];
    for await (const v of q) {
      seen.push(v);
      if (seen.length === N) break;
    }
    assert.strictEqual(seen.length, N);
    for (let i = 0; i < N; i++) assert.strictEqual(seen[i], i);
  });

  it('interleaved push/consume preserves FIFO across waiter boundary', async () => {
    // Producer pushes items between consumer pulls. The transition point
    // between "buffered" and "delivered via waiter" must not reorder.
    const q = createQueue<number>();
    const seen: number[] = [];

    const consumer = (async () => {
      for await (const v of q) {
        seen.push(v);
        if (seen.length === 6) break;
      }
    })();

    q.push(0);
    q.push(1);
    await Promise.resolve();
    q.push(2);
    await new Promise((r) => setTimeout(r, 5));
    q.push(3);
    q.push(4);
    q.push(5);

    await consumer;
    assert.deepStrictEqual(seen, [0, 1, 2, 3, 4, 5]);
  });

  it('break inside for-await does NOT drop remaining buffered items', async () => {
    // Pins: iterator.return() only stops iteration — it does not clear the
    // backing buffer. A second iteration must see the leftovers.
    const q = createQueue<number>([10, 20, 30, 40]);
    for await (const _v of q) break;
    assert.strictEqual(q.length, 3);

    const rest: number[] = [];
    for await (const v of q) {
      rest.push(v);
      if (rest.length === 3) break;
    }
    assert.deepStrictEqual(rest, [20, 30, 40]);
  });

  it('second iterator throws while first is live, not after return()', () => {
    const q = createQueue<number>();
    const iter1 = q[Symbol.asyncIterator]();
    assert.throws(() => q[Symbol.asyncIterator](), /single-consumer/);
    iter1.return!();
    // After return, a new iterator must succeed
    const iter2 = q[Symbol.asyncIterator]();
    assert.ok(iter2);
    iter2.return!();
  });

  it('constructor copies initialItems (does not alias external array)', () => {
    // Pins: external mutations to the seeded array must not leak into the queue.
    const src = [1, 2, 3];
    const q = createQueue<number>(src);
    src.push(4);
    src[0] = 999;
    assert.strictEqual(q.length, 3);
    // descriptor.serialize reveals internal items
    const descriptor = (q.constructor as any)[Symbol.process];
    assert.deepStrictEqual(descriptor.serialize(q), { items: [1, 2, 3] });
  });
});
