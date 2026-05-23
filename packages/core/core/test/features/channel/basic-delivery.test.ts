/**
 * INVARIANT: Basic delivery semantics for channels.
 *
 * Why a silent failure would hurt:
 *   Channels are the primitive behind chat broadcasts, live dashboards, and the
 *   cluster event bus. If publish-before-subscribe silently buffered messages,
 *   we would leak memory forever. If subscribe-then-publish silently dropped,
 *   we would lose a subscriber's first message without noticing. Both have to
 *   be pinned.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createChannels } from '../../../src/features/channel/channels.js';
import type { ChannelBackend } from '../../../src/features/channel/backend.js';

/** Minimal passthrough backend: no remote delivery, no encoding roundtrip. */
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

/**
 * Consume at most `limit` messages with a deadline so the test fails loudly
 * if fewer arrive.
 */
async function collect<T>(
  sub: AsyncIterable<T>,
  limit: number,
  deadlineMs = 1000,
): Promise<T[]> {
  const out: T[] = [];
  const iter = (sub as any)[Symbol.asyncIterator]();
  const deadline = Date.now() + deadlineMs;
  while (out.length < limit && Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      iter.next(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), remaining),
      ),
    ]);
    if (result.done) break;
    out.push(result.value);
  }
  return out;
}

describe('channels: basic delivery', () => {
  it('INVARIANT: single publisher + single subscriber - subscriber receives the message', async () => {
    const channels = makeChannels<{ n: number }>();
    const sub = channels.subscribe('k');

    // schedule publish so that the subscriber's queue has work once it awaits
    queueMicrotask(() => channels.publish('k', { n: 1 }));

    const got = await collect(sub, 1);
    assert.deepEqual(got, [{ n: 1 }]);
    sub.unsubscribe();
  });

  it('INVARIANT: publish before any subscribe is dropped (no implicit buffering)', async () => {
    const channels = makeChannels<{ n: number }>();

    // Publish to a channel with no subscribers. By current design this must
    // drop silently - the channel may not even exist yet. If we ever start
    // buffering this, we leak memory forever per unknown key.
    channels.publish('k', { n: 1 });
    channels.publish('k', { n: 2 });

    // Now subscribe and publish a fresh one. The subscriber should see ONLY
    // the post-subscribe message.
    const sub = channels.subscribe('k');
    queueMicrotask(() => channels.publish('k', { n: 99 }));

    const got = await collect(sub, 1);
    assert.deepEqual(got, [{ n: 99 }]);
    sub.unsubscribe();
  });

  it('INVARIANT: subscribe -> unsubscribe -> publish yields nothing to the former subscriber', async () => {
    const channels = makeChannels<{ n: number }>();
    const sub = channels.subscribe('k');
    sub.unsubscribe();
    channels.publish('k', { n: 1 });

    // Re-subscribe with a fresh subscription. If the framework leaked the
    // prior queue, we'd see it here.
    const sub2 = channels.subscribe('k');
    queueMicrotask(() => channels.publish('k', { n: 2 }));
    const got = await collect(sub2, 1);
    assert.deepEqual(got, [{ n: 2 }]);
    sub2.unsubscribe();

    assert.equal(sub.active, false);
  });

  it('INVARIANT: same subscriber consumes multiple publishes in FIFO order', async () => {
    const channels = makeChannels<number>();
    const sub = channels.subscribe('k');

    queueMicrotask(() => {
      channels.publish('k', 1);
      channels.publish('k', 2);
      channels.publish('k', 3);
      channels.publish('k', 4);
      channels.publish('k', 5);
    });

    const got = await collect(sub, 5);
    assert.deepEqual(got, [1, 2, 3, 4, 5]);
    sub.unsubscribe();
  });

  it('INVARIANT: subscription.active flips false on unsubscribe', async () => {
    const channels = makeChannels<number>();
    const sub = channels.subscribe('k');
    assert.equal(sub.active, true);
    sub.unsubscribe();
    assert.equal(sub.active, false);
  });
});
