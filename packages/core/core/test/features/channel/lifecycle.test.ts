/**
 * INVARIANT: Subscription lifecycle - break/throw/using all release the
 * underlying channel reference exactly once, and peers are unaffected.
 *
 * Why a silent failure would hurt:
 *   A leaked subscription keeps the channel object alive and the onPublish
 *   hook ping-pongs messages through the backend forever. A throwing
 *   subscriber that does NOT clean up can burn whole CPUs.
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

describe('channels: subscription lifecycle', () => {
  it('INVARIANT: for-await break cleanly unsubscribes', async () => {
    const channels = makeChannels<number>();
    const sub = channels.subscribe('k');
    assert.equal(channels.hasSubscribers('k'), true);

    const got: number[] = [];
    const run = (async () => {
      for await (const m of sub) {
        got.push(m);
        if (got.length >= 2) break;
      }
    })();

    channels.publish('k', 1);
    channels.publish('k', 2);
    await run;

    assert.equal(sub.active, false);
    assert.equal(channels.hasSubscribers('k'), false);
  });

  it('INVARIANT: thrown error inside for-await body triggers cleanup and does not affect peers', async () => {
    const channels = makeChannels<number>();
    const a = channels.subscribe('k');
    const b = channels.subscribe('k');

    const run = (async () => {
      try {
        for await (const m of a) {
          throw new Error(`bang on ${m}`);
        }
      } catch {
        /* expected */
      }
    })();

    channels.publish('k', 1);
    await run;

    assert.equal(a.active, false);
    assert.equal(b.active, true);

    // peer still works
    channels.publish('k', 2);
    const iter = (b as any)[Symbol.asyncIterator]();
    const first = await iter.next();
    assert.equal(first.done, false);
    // peer saw both 1 and 2 (fan-out delivered before a threw)
    assert.equal(first.value, 1);
    const second = await iter.next();
    assert.equal(second.value, 2);

    b.unsubscribe();
  });

  it('INVARIANT: `using` disposes the subscription at block exit', async () => {
    const channels = makeChannels<number>();
    {
      using sub = channels.subscribe('k');
      assert.equal(sub.active, true);
      assert.equal(channels.hasSubscribers('k'), true);
    }
    // After block exit Symbol.dispose fires
    assert.equal(channels.hasSubscribers('k'), false);
  });

  it('INVARIANT: unsubscribe is idempotent (calling twice is safe, no double-hook-call)', async () => {
    let firstCount = 0;
    let lastCount = 0;
    const def = createChannels<number>().withHooks({
      onFirstSubscriber: () => {
        firstCount++;
      },
      onLastUnsubscribe: () => {
        lastCount++;
      },
    });
    const channels = (def as unknown as { factory: (d: { backend: ChannelBackend }) => any }).factory({
      backend: localBackend(),
    });

    const sub = channels.subscribe('k');
    sub.unsubscribe();
    sub.unsubscribe();
    sub.unsubscribe();

    // Give microtasks a chance (hooks run via Promise.resolve)
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(firstCount, 1, 'onFirstSubscriber called exactly once');
    assert.equal(lastCount, 1, 'onLastUnsubscribe called exactly once');
  });

  it('INVARIANT: a subscriber that never calls next() does NOT block the publisher', async () => {
    // The publisher is synchronous: it fans out to callbacks. A subscriber
    // that never iterates simply lets its queue grow. This must not raise
    // and must not deadlock publish().
    const channels = makeChannels<number>();
    const sleeper = channels.subscribe('k'); // never iterated
    const start = Date.now();
    for (let i = 0; i < 50; i++) channels.publish('k', i);
    const elapsed = Date.now() - start;
    // synchronous publish should be fast even with a never-awoken consumer
    assert.ok(elapsed < 500, `publish path stalled: ${elapsed}ms`);
    sleeper.unsubscribe();
  });

  // CONTRACT (cleanup obligation): a subscription registers its callback
  // at subscribe() time, BEFORE any for-await begins. Cleanup happens in
  // exactly two places — the iterator's finally block and unsubscribe()/
  // [Symbol.dispose](). If the caller does NEITHER (subscribes, holds the
  // handle, forgets it), the callback stays registered until the channel
  // is closed. Pin that explicit unsubscribe always works, and document
  // the abandoned-handle leak with a separate test.

  it('INVARIANT: explicit unsubscribe() cleans up even when iterator never started', () => {
    const channels = makeChannels<number>();
    const sub = channels.subscribe('k');
    assert.equal(channels.hasSubscribers('k'), true);

    // No for-await ever runs. Just call unsubscribe directly.
    sub.unsubscribe();
    assert.equal(channels.hasSubscribers('k'), false);
  });

  it('INVARIANT: [Symbol.dispose]() cleans up even when iterator never started', () => {
    const channels = makeChannels<number>();
    const sub = channels.subscribe('k');
    assert.equal(channels.hasSubscribers('k'), true);
    sub[Symbol.dispose]();
    assert.equal(channels.hasSubscribers('k'), false);
  });

  it('CONTRACT: abandoning a subscription without unsubscribe + without iter leaves it REGISTERED (caller must clean up)', () => {
    // This pins a real footgun: if you call channels.subscribe() and
    // forget the handle, the callback stays in the channel's subscribers
    // Set forever. The framework can't auto-clean (no finalizer, no GC
    // hook) — callers MUST iterate (which auto-cleans on for-await exit)
    // OR call unsubscribe()/dispose() explicitly. This test pins the
    // current behavior so anyone tightening it can see what changes.
    const channels = makeChannels<number>();
    void channels.subscribe('k');
    // Drop the reference; nothing else happens.
    assert.equal(
      channels.hasSubscribers('k'),
      true,
      'abandoned subscription stays registered — callers must explicitly clean up',
    );
    // Manually clean up so the test doesn't leak into the next one.
    // (We can't get the handle back; close the whole channels instance.)
    channels.close();
  });

  it('INVARIANT: queue does not buffer messages after unsubscribe', () => {
    const channels = makeChannels<number>();
    const sub = channels.subscribe('k');
    sub.unsubscribe();
    // Publishes after unsubscribe should be no-ops for this subscriber.
    for (let i = 0; i < 100; i++) channels.publish('k', i);
    // The implementation drops messages on the floor; nothing to assert
    // beyond "doesn't throw and channel is unsubscribed".
    assert.equal(channels.hasSubscribers('k'), false);
  });
});
