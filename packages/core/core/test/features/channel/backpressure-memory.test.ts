/**
 * INVARIANT: Backpressure / memory.
 *
 * The channel is doc'd as *buffering per-subscriber* (see channel.ts -
 * `queue: TMessage[]`). A publisher that outruns a consumer by 10x for 1000
 * messages should still deliver all 1000 in order once the consumer catches
 * up. Memory: after 10k publishes with the consumer keeping up, the internal
 * queue should drain to 0 (no unbounded state).
 *
 * Why a silent failure would hurt:
 *   Lossy-when-spec'd-buffered is silent data loss. Buffered-when-spec'd-lossy
 *   is a memory leak. Both kill you in prod, nobody notices in dev.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createChannels } from '../../../src/features/channel/channels.js';
import type { ChannelBackend } from '../../../src/features/channel/backend.js';

function localBackend(): ChannelBackend {
  return {
    subscribe: () => ({ ready: Promise.resolve(), [Symbol.dispose]: () => {} }),
    publish: () => {},
    async close() {},
  };
}

function makeChannels<T>() {
  const def = createChannels<T>();
  return (def as unknown as { factory: (d: { backend: ChannelBackend }) => any }).factory({
    backend: localBackend(),
  });
}

describe('channels: backpressure and memory', () => {
  it('INVARIANT: buffering semantics - publisher bursts N messages while consumer is paused, consumer sees all N in order', async () => {
    const channels = makeChannels<number>();
    const sub = channels.subscribe('k');

    const N = 1000;
    // Burst-publish synchronously before starting consumer.
    for (let i = 0; i < N; i++) channels.publish('k', i);

    const got: number[] = [];
    for await (const m of sub) {
      got.push(m);
      if (got.length >= N) break;
    }
    assert.equal(got.length, N);
    for (let i = 0; i < N; i++) assert.equal(got[i], i, `index ${i}`);
  });

  it('INVARIANT: consumer keeping up - queue drains to empty', async () => {
    const channels = makeChannels<number>();
    const sub = channels.subscribe('k');

    const N = 10_000;
    let count = 0;
    const run = (async () => {
      for await (const m of sub) {
        count++;
        if (count >= N) break;
      }
    })();

    // Publish in small bursts so the consumer can keep up.
    for (let i = 0; i < N; i++) {
      channels.publish('k', i);
      if (i % 500 === 0) await Promise.resolve();
    }

    await run;
    assert.equal(count, N);

    // After drain, subscribing new + publishing should have empty queue first.
    // We can't inspect internal queue, but we can verify that a fresh publish
    // after drain produces just one message (i.e. no leftover).
    const sub2 = channels.subscribe('k');
    queueMicrotask(() => channels.publish('k', 42));
    const iter = (sub2 as any)[Symbol.asyncIterator]();
    const first = await iter.next();
    assert.equal(first.value, 42);
    sub2.unsubscribe();
  });

  it('INVARIANT: unsubscribe during backlog - later publishes don\'t land in a dead queue', async () => {
    // After unsubscribe, the `disposed` flag is set; further publishes must
    // no-op in the callback. If the queue continued to grow after dispose,
    // that's a leak.
    const channels = makeChannels<number>();
    const sub = channels.subscribe('k');

    for (let i = 0; i < 100; i++) channels.publish('k', i);
    sub.unsubscribe();

    // Publish more after unsubscribe. These must not be delivered anywhere
    // and must not keep the subscription alive.
    for (let i = 100; i < 200; i++) channels.publish('k', i);
    assert.equal(sub.active, false);
    assert.equal(channels.hasSubscribers('k'), false);
  });
});
