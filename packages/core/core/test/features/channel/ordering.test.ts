/**
 * INVARIANT: Ordering is FIFO per channel and is consistent across subscribers.
 *
 * Why a silent failure would hurt:
 *   Chat ordering, state-replication streams, and event buses all assume
 *   "what I published in this order is what every consumer sees in this
 *   order". If two concurrent publishers produced an interleaving that
 *   different subscribers saw DIFFERENTLY, you get split-brain clients.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createChannels } from '../../../src/features/channel/channels.js';
import type { ChannelBackend } from '../../../src/features/channel/backend.js';
import type { ChannelsInstance } from '../../../src/features/channel/types.js';

function localBackend(): ChannelBackend {
  return {
    subscribe: () => ({ ready: Promise.resolve(), [Symbol.dispose]: () => {} }),
    publish: () => {},
    async close() {},
  };
}

function makeChannels<T>(): ChannelsInstance<T> {
  const def = createChannels<T>();
  return (def as unknown as { factory: (d: { backend: ChannelBackend }) => ChannelsInstance<T> }).factory({
    backend: localBackend(),
  });
}

async function drain<T>(sub: AsyncIterable<T>, n: number, ms = 2000): Promise<T[]> {
  const out: T[] = [];
  const iter = (sub as any)[Symbol.asyncIterator]();
  const deadline = Date.now() + ms;
  while (out.length < n && Date.now() < deadline) {
    const result = await Promise.race([
      iter.next(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now()),
      ),
    ]);
    if (result.done) break;
    out.push(result.value);
  }
  return out;
}

describe('channels: ordering', () => {
  it('INVARIANT: rapid A,B,C,... from one publisher arrive in order', async () => {
    const channels = makeChannels<number>();
    const sub = channels.subscribe('k');

    const N = 500;
    queueMicrotask(() => {
      for (let i = 0; i < N; i++) channels.publish('k', i);
    });

    const got = await drain(sub, N);
    assert.equal(got.length, N);
    for (let i = 0; i < N; i++) assert.equal(got[i], i, `index ${i}`);
    sub.unsubscribe();
  });

  it('INVARIANT: two concurrent publishers produce SOME valid interleaving (no duplicates, no loss, tag order preserved per-publisher)', async () => {
    const channels = makeChannels<{ tag: 'A' | 'B'; i: number }>();
    const sub = channels.subscribe('k');

    const N = 200;

    // Publish from two "publishers" interleaved via microtasks.
    const pubA = (async () => {
      for (let i = 0; i < N; i++) {
        channels.publish('k', { tag: 'A', i });
        if (i % 7 === 0) await Promise.resolve();
      }
    })();
    const pubB = (async () => {
      for (let i = 0; i < N; i++) {
        channels.publish('k', { tag: 'B', i });
        if (i % 11 === 0) await Promise.resolve();
      }
    })();

    await Promise.all([pubA, pubB]);

    const got = await drain(sub, 2 * N);
    assert.equal(got.length, 2 * N, 'no messages lost');

    // Per-publisher order must be monotonic
    let lastA = -1;
    let lastB = -1;
    const seen = new Set<string>();
    for (const m of got) {
      const key = `${m.tag}:${m.i}`;
      assert.ok(!seen.has(key), `duplicate delivery for ${key}`);
      seen.add(key);
      if (m.tag === 'A') {
        assert.ok(m.i > lastA, `A out of order: ${m.i} after ${lastA}`);
        lastA = m.i;
      } else {
        assert.ok(m.i > lastB, `B out of order: ${m.i} after ${lastB}`);
        lastB = m.i;
      }
    }
    assert.equal(lastA, N - 1);
    assert.equal(lastB, N - 1);
    sub.unsubscribe();
  });

  it('INVARIANT: multiple subscribers on one channel observe the SAME total order', async () => {
    const channels = makeChannels<number>();
    const subA = channels.subscribe('k');
    const subB = channels.subscribe('k');
    const subC = channels.subscribe('k');

    const N = 100;
    queueMicrotask(() => {
      for (let i = 0; i < N; i++) channels.publish('k', i);
    });

    const [a, b, c] = await Promise.all([
      drain(subA, N),
      drain(subB, N),
      drain(subC, N),
    ]);
    assert.equal(a.length, N);
    assert.deepEqual(a, b);
    assert.deepEqual(a, c);
    subA.unsubscribe();
    subB.unsubscribe();
    subC.unsubscribe();
  });
});
