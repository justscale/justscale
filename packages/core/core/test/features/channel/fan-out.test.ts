/**
 * INVARIANT: Fan-out.
 *
 * Why a silent failure would hurt:
 *   The whole point of channels is one-to-many broadcast. If a slow subscriber
 *   stalls others, a misbehaving browser tab takes down a room. If a
 *   subscriber that `return`s early corrupts the publisher's iterator, we have
 *   a UAF waiting to be triggered.
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

describe('channels: fan-out', () => {
  it('INVARIANT: N subscribers each receive every publish', async () => {
    const channels = makeChannels<number>();
    const N = 10;
    const subs = Array.from({ length: N }, () => channels.subscribe('k'));

    const M = 20;
    queueMicrotask(() => {
      for (let i = 0; i < M; i++) channels.publish('k', i);
    });

    const results = await Promise.all(subs.map((s) => drain(s, M)));
    for (const [i, got] of results.entries()) {
      assert.equal(got.length, M, `subscriber ${i} received wrong count`);
      for (let j = 0; j < M; j++) assert.equal(got[j], j);
    }
    subs.forEach((s) => s.unsubscribe());
  });

  it('INVARIANT: a slow subscriber does not block a fast subscriber', async () => {
    const channels = makeChannels<number>();
    const slow = channels.subscribe('k');
    const fast = channels.subscribe('k');

    const M = 50;
    queueMicrotask(() => {
      for (let i = 0; i < M; i++) channels.publish('k', i);
    });

    // Fast consumes immediately, slow never next()s. Fast must not be blocked.
    const fastResult = await drain(fast, M, 1500);
    assert.equal(fastResult.length, M);
    for (let i = 0; i < M; i++) assert.equal(fastResult[i], i);
    slow.unsubscribe();
    fast.unsubscribe();
  });

  it('INVARIANT: subscriber that breaks its for-await does not affect peers', async () => {
    const channels = makeChannels<number>();
    const quitter = channels.subscribe('k');
    const peer = channels.subscribe('k');

    const quitterReceived: number[] = [];
    const quitterPromise = (async () => {
      for await (const m of quitter) {
        quitterReceived.push(m);
        if (quitterReceived.length >= 2) break;
      }
    })();

    // Send 2 messages, wait for quitter to exit, then send more.
    channels.publish('k', 1);
    channels.publish('k', 2);
    await quitterPromise;
    assert.equal(quitter.active, false);

    channels.publish('k', 3);
    channels.publish('k', 4);
    channels.publish('k', 5);

    const peerReceived = await drain(peer, 5);
    assert.deepEqual(peerReceived, [1, 2, 3, 4, 5]);
    peer.unsubscribe();
  });

  it('INVARIANT: disposing one subscription does not perturb another subscription created from the same subscribe() path', async () => {
    const channels = makeChannels<string>();
    const a = channels.subscribe('k');
    const b = channels.subscribe('k');

    a.unsubscribe();
    queueMicrotask(() => channels.publish('k', 'hi'));
    const got = await drain(b, 1);
    assert.deepEqual(got, ['hi']);
    b.unsubscribe();
  });
});
