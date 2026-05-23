/**
 * INVARIANT: Error paths - non-serializable payloads, publish/subscribe on a
 * closed instance.
 *
 * Why a silent failure would hurt:
 *   A circular structure in a Datastar/WS broadcast could crash the whole
 *   process if hashMessage throws and we don't catch it. Publishing after
 *   close() with no error is a subtle footgun: the app silently stops
 *   broadcasting.
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

describe('channels: error paths', () => {
  it('INVARIANT: publishing a circular structure - delivery to local subscribers works (pass-through) even though JSON.stringify would throw', async () => {
    // Current design: local delivery does not serialize; only the backend
    // encodes. A circular local message should still be deliverable.
    // hashMessage() has a try/catch that falls back to String(message), so
    // this must NOT throw.
    const channels = makeChannels<object>();
    const sub = channels.subscribe('k');

    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = { a };
    a.b = b; // circular

    let delivered: object | undefined;
    const run = (async () => {
      for await (const m of sub) {
        delivered = m;
        break;
      }
    })();

    assert.doesNotThrow(() => channels.publish('k', a));
    await run;
    assert.strictEqual(delivered, a, 'circular object delivered by reference to local subscriber');
  });

  it('INVARIANT: close() - after close, hasSubscribers and getActiveChannels show empty', async () => {
    const channels = makeChannels<number>();
    const sub = channels.subscribe('k');
    channels.publish('k', 1);
    assert.equal(channels.hasSubscribers('k'), true);

    channels.close();

    assert.equal(channels.hasSubscribers('k'), false);
    assert.deepEqual(channels.getActiveChannels(), []);
    // sub is now orphaned - the internal channel map was cleared. The sub
    // object itself was not notified (that is the current behavior); pin it.
    assert.equal(sub.active, true, 'close() does not currently flip subscription.active - pin this shape');
  });

  it('INVARIANT: subscribing after close() - creates a fresh channel (current behavior), does not throw', async () => {
    const channels = makeChannels<number>();
    channels.close();

    // The factory doesn't record a `closed` flag - getChannel just creates
    // a new Channel. This is the CURRENT shape; if design changes to throw,
    // update this test intentionally.
    // todo: closed-instance semantics are undefined; decide whether to
    // throw or to remain lazy/reusable.
    const sub = channels.subscribe('k');
    assert.equal(sub.active, true);

    queueMicrotask(() => channels.publish('k', 7));
    const iter = (sub as any)[Symbol.asyncIterator]();
    const next = await Promise.race([
      iter.next(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), 200),
      ),
    ]);
    // Post-close subscribe + publish still works locally (no guardrails).
    assert.equal(next.done, false);
    assert.equal(next.value, 7);
    sub.unsubscribe();
  });

  it('INVARIANT: publishing on a key with zero subscribers does not throw and does not create a leaked subscription', () => {
    const channels = makeChannels<number>();
    for (let i = 0; i < 5; i++) {
      assert.doesNotThrow(() => channels.publish(`nobody-${i}`, i));
    }
    assert.deepEqual(channels.getActiveChannels(), []);
  });
});
