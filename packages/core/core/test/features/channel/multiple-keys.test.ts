/**
 * INVARIANT: Channel keys are isolated. Prefix-collision keys ('abc' vs 'abcd')
 * are distinct. Ref-shaped keys (`{ identifier: 'x' }`) unify with the
 * string 'x'.
 *
 * Why a silent failure would hurt:
 *   If 'abc' and 'abcd' cross-talked, a per-user channel could leak to the
 *   wrong user. If Ref(model, id) did not unify with the string identifier,
 *   callers would see phantom channels.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createChannels } from '../../../src/features/channel/channels.js';
import type { ChannelBackend } from '../../../src/features/channel/backend.js';
import { resolveChannelKey } from '../../../src/features/channel/types.js';

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

async function drain<T>(sub: AsyncIterable<T>, n: number, ms = 1000): Promise<T[]> {
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

describe('channels: multiple keys', () => {
  it('INVARIANT: subscribe(A) does not receive publish(B)', async () => {
    const channels = makeChannels<number>();
    const a = channels.subscribe('room-A');
    const b = channels.subscribe('room-B');

    const aGot: number[] = [];
    const bGot: number[] = [];
    const aRun = (async () => {
      for await (const m of a) {
        aGot.push(m);
        if (aGot.length >= 1) break;
      }
    })();
    const bRun = (async () => {
      for await (const m of b) {
        bGot.push(m);
        if (bGot.length >= 1) break;
      }
    })();

    channels.publish('room-A', 1);
    channels.publish('room-B', 2);
    await Promise.all([aRun, bRun]);

    assert.deepEqual(aGot, [1]);
    assert.deepEqual(bGot, [2]);
  });

  it('INVARIANT: prefix-colliding keys (abc vs abcd) are isolated - no cross-delivery', async () => {
    const channels = makeChannels<string>();
    const sub1 = channels.subscribe('abc');
    const sub2 = channels.subscribe('abcd');

    const got1: string[] = [];
    const got2: string[] = [];

    const run1 = (async () => {
      for await (const m of sub1) {
        got1.push(m);
        if (got1.length >= 1) break;
      }
    })();
    const run2 = (async () => {
      for await (const m of sub2) {
        got2.push(m);
        if (got2.length >= 1) break;
      }
    })();

    channels.publish('abc', 'short');
    channels.publish('abcd', 'long');
    await Promise.all([run1, run2]);

    assert.deepEqual(got1, ['short']);
    assert.deepEqual(got2, ['long']);
  });

  it('INVARIANT: Ref-shaped key { identifier } unifies with the string identifier', async () => {
    // This matches `resolveChannelKey` - a Ref<Model>-like value and the
    // plain string produce the same channel.
    const channels = makeChannels<number>();

    const refKey = { identifier: 'order-42' };
    assert.equal(resolveChannelKey(refKey), 'order-42');
    assert.equal(resolveChannelKey('order-42'), 'order-42');

    const subByRef = channels.subscribe(refKey);
    const got: number[] = [];
    const run = (async () => {
      for await (const m of subByRef) {
        got.push(m);
        if (got.length >= 1) break;
      }
    })();

    // Publish by STRING - must reach the subscriber that subscribed by REF.
    channels.publish('order-42', 7);
    await run;
    assert.deepEqual(got, [7]);
  });

  it('INVARIANT: unused keys do not accumulate in getActiveChannels()', async () => {
    const channels = makeChannels<number>();
    // publish without a subscriber creates a channel object internally (see
    // `getOrCreateChannel`), but with 0 subscribers. getActiveChannels must
    // filter to only keys with subscribers.
    channels.publish('ghost', 1);
    assert.deepEqual(channels.getActiveChannels(), []);

    const live = channels.subscribe('alive');
    assert.deepEqual(channels.getActiveChannels(), ['alive']);
    live.unsubscribe();
    assert.deepEqual(channels.getActiveChannels(), []);
  });
});
