/**
 * INVARIANT (BUG PROBE): The channel's internal Set iteration in `publish()`
 * must not deliver THIS publish to subscribers added DURING fan-out.
 *
 * Why: This is the exact shape of the InMemorySignalBus bug (map iteration
 * visits entries added mid-iteration -> duplicate delivery). `channel.ts`
 * does:
 *
 *   for (const callback of subscribers) {
 *     callback(message);
 *   }
 *
 * If `callback(message)` calls `channels.subscribe(same-key)` synchronously,
 * JavaScript Set iteration DOES visit the newly-added entry. The new
 * subscriber would then receive the in-flight publish, which it pre-dates.
 *
 * To hit it we bypass the async iterator (which decouples via queue) and use
 * a raw listener via `getChannel().subscribe()` - or we write a subscriber
 * callback that immediately calls `.next()` on its iterator to observe the
 * synchronous delivery path. Actually the callback is internal and not
 * accessible. Instead we observe indirectly: create a subscription, and in
 * its for-await body synchronously call `channels.subscribe()` and then
 * publish AGAIN - and check whether the freshly created subscription
 * received the PREVIOUS publish.
 *
 * The cleanest probe is:
 *  1. Create sub-A.
 *  2. Start consuming sub-A; on first message, synchronously create sub-B.
 *  3. Publish once. sub-A should receive. sub-B must NOT.
 *
 * But because async-iterator decouples, sub-B is created AFTER publish has
 * already returned (we only run the consumer callback after the publish's
 * sync fan-out completes). So the probe above cannot actually reach into
 * publish's loop. The REAL attack surface is a custom backend that, on
 * `backend.subscribe`, synchronously calls its `onMessage` callback from
 * inside the publish path - which the channels layer does in
 * `onFirstSubscriber` via backend.subscribe(...). Let's hit THAT.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createChannels } from '../../../src/features/channel/channels.js';
import type { ChannelBackend } from '../../../src/features/channel/backend.js';

describe('channels: Set-iteration reentrance probe', () => {
  it('INVARIANT: a backend that synchronously re-enters onMessage during a publish does NOT cause duplicate delivery', async () => {
    // Simulate a buggy / aggressive backend that delivers the published
    // message back to onMessage synchronously (e.g. a loopback variant of
    // LISTEN/NOTIFY that short-circuits). If the channels factory's
    // `deliverLocal` doesn't de-dup, we get the message twice.
    //
    // This is exactly the risk: `channel.publish()` calls each subscriber
    // (delivering message locally, push to queue), then fires `onPublish`
    // hook which calls `backend.publish()`. If the backend's `publish`
    // synchronously triggers its subscribe callback (registered via
    // `onFirstSubscriber`), that callback runs `deliverLocal` which iterates
    // the same `subscribers` Set AGAIN and pushes AGAIN to the same queue.
    //
    // The current code has a `recentlyPublished` Set hash-dedup in
    // channel.ts -> deliverLocal() that SHOULD catch this. We verify it.

    const listeners = new Map<string, (m: unknown) => void>();
    const loopbackBackend: ChannelBackend = {
      subscribe(key, onMessage) {
        listeners.set(key, onMessage);
        return {
          ready: Promise.resolve(),
          [Symbol.dispose]: () => listeners.delete(key),
        };
      },
      publish(key, message) {
        // Synchronously loop back - this is the attack: deliver from inside
        // publish.
        const cb = listeners.get(key);
        if (cb) cb(message);
      },
      async close() {},
    };

    const def = createChannels<{ n: number }>();
    const channels = (def as unknown as { factory: (d: { backend: ChannelBackend }) => any })
      .factory({ backend: loopbackBackend });

    const sub = channels.subscribe('k');
    const got: Array<{ n: number }> = [];
    const run = (async () => {
      for await (const m of sub) {
        got.push(m);
        if (got.length >= 1) break;
      }
    })();

    // Publish once. The publish will:
    //   1) deliver to sub (queue += [{n:1}])
    //   2) fire onPublish -> backend.publish -> loopback cb
    //   3) loopback cb goes through decodeFromBackend -> channel.deliverLocal
    //      -> which checks `recentlyPublished.has(hash)` and should SKIP.
    channels.publish('k', { n: 1 });

    await run;
    assert.equal(got.length, 1, `got ${got.length} deliveries; want exactly 1 (dedup must skip loopback)`);
    assert.deepEqual(got[0], { n: 1 });

    sub.unsubscribe();
  });

  it('INVARIANT: two identical synchronous publishes with async loopback each get exactly one echo suppressed', async () => {
    // The `recentlyPublished` multiset counter (Map<hash, count>) means two
    // identical sync publishes each increment the counter to 2. Each loopback
    // echo decrements by 1 and is suppressed. The subscriber sees exactly 2
    // deliveries (the local ones) and zero leaked echoes.
    //
    // Previously: Set<hash> collapsed both publishes into one entry so only
    // the first echo was suppressed; the second leaked through as a duplicate.

    const pending: Array<[string, unknown]> = [];
    const listeners = new Map<string, (m: unknown) => void>();
    const asyncLoopbackBackend: ChannelBackend = {
      subscribe(key, onMessage) {
        listeners.set(key, onMessage);
        return {
          ready: Promise.resolve(),
          [Symbol.dispose]: () => listeners.delete(key),
        };
      },
      publish(key, message) {
        pending.push([key, message]);
      },
      async close() {},
    };
    const flush = async () => {
      // deliver all queued backend publishes as remote messages
      while (pending.length) {
        const [key, msg] = pending.shift()!;
        const cb = listeners.get(key);
        if (cb) cb(msg);
        await Promise.resolve();
      }
    };

    const def = createChannels<{ n: number }>();
    const channels = (def as unknown as { factory: (d: { backend: ChannelBackend }) => any })
      .factory({ backend: asyncLoopbackBackend });

    const sub = channels.subscribe('k');
    const got: Array<{ n: number }> = [];
    // Drain the iterator continuously - do not break early, so we catch
    // any duplicate deliveries after the expected two.
    const run = (async () => {
      for await (const m of sub) {
        got.push(m);
      }
    })();

    // Publish the SAME message twice synchronously.
    channels.publish('k', { n: 1 });
    channels.publish('k', { n: 1 });

    // Let the local deliveries land.
    await new Promise((r) => setTimeout(r, 10));

    // Now deliver the loopback echoes async.
    await flush();

    // Settle for a moment so any leaked echo materializes.
    await new Promise((r) => setTimeout(r, 100));

    sub.unsubscribe();
    await run;

    // Expected: exactly 2 deliveries (the two original publishes). If the
    // async-loopback dedup is broken we see 3 (or 4).
    assert.equal(
      got.length,
      2,
      `got ${got.length} deliveries for 2 identical publishes via async loopback; expected exactly 2`,
    );
  });
});
