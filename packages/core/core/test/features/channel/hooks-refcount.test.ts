/**
 * INVARIANT: Reference-counting hooks fire exactly once per 0<->1 transition.
 *
 * Why a silent failure would hurt:
 *   onFirstSubscriber is how the Redis/Postgres backend does `SUBSCRIBE`. If
 *   it fires twice we open two LISTEN backends and get duplicate deliveries.
 *   onLastUnsubscribe is how we stop listening; if it fires too early we stop
 *   receiving messages while still having subscribers. Both are silent: you
 *   won't find out until someone files a bug from prod.
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

function withHooksInstance<T>(hooks: {
  onFirstSubscriber?: (k: string) => void | Promise<void>
  onLastUnsubscribe?: (k: string) => void | Promise<void>
  onPublish?: (k: string, m: unknown) => void | Promise<void>
}) {
  const def = createChannels<T>().withHooks(hooks);
  return (def as unknown as { factory: (d: { backend: ChannelBackend }) => any }).factory({
    backend: localBackend(),
  });
}

describe('channels: hooks and refcount', () => {
  it('INVARIANT: onFirstSubscriber fires exactly once on 0->1, not on 1->2', async () => {
    const first: string[] = [];
    const last: string[] = [];
    const channels = withHooksInstance<number>({
      onFirstSubscriber: (k) => {
        first.push(k);
      },
      onLastUnsubscribe: (k) => {
        last.push(k);
      },
    });

    const a = channels.subscribe('k');
    const b = channels.subscribe('k');
    const c = channels.subscribe('k');
    await Promise.resolve();

    assert.equal(first.length, 1, 'onFirstSubscriber fires once');
    assert.deepEqual(first, ['k']);

    a.unsubscribe();
    b.unsubscribe();
    await Promise.resolve();
    assert.equal(last.length, 0, 'not fired while subscribers remain');

    c.unsubscribe();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(last.length, 1, 'onLastUnsubscribe fires on 1->0');
  });

  it('INVARIANT: rapid churn of 100 subscribers yields sane hook counts (not 100 each)', async () => {
    const first: string[] = [];
    const last: string[] = [];
    const channels = withHooksInstance<number>({
      onFirstSubscriber: (k) => {
        first.push(k);
      },
      onLastUnsubscribe: (k) => {
        last.push(k);
      },
    });

    // Churn: subscribe-unsubscribe-subscribe-... keeping at least one alive.
    const anchor = channels.subscribe('k');
    const subs: Array<{ unsubscribe(): void }> = [];
    for (let i = 0; i < 100; i++) {
      subs.push(channels.subscribe('k'));
    }
    for (const s of subs) s.unsubscribe();
    anchor.unsubscribe();

    // Microtasks for hook promises
    for (let i = 0; i < 5; i++) await Promise.resolve();

    assert.equal(first.length, 1, `onFirstSubscriber fired ${first.length} times, want 1`);
    assert.equal(last.length, 1, `onLastUnsubscribe fired ${last.length} times, want 1`);
  });

  it('INVARIANT: onPublish fires once per publish() call regardless of subscriber count', async () => {
    const pubs: Array<{ k: string; m: unknown }> = [];
    const channels = withHooksInstance<number>({
      onPublish: (k, m) => {
        pubs.push({ k, m });
      },
    });

    const subs = Array.from({ length: 5 }, () => channels.subscribe('k'));

    channels.publish('k', 1);
    channels.publish('k', 2);

    // Hook runs through Promise.resolve wrapper - allow it to settle
    for (let i = 0; i < 3; i++) await Promise.resolve();

    assert.equal(pubs.length, 2);
    assert.deepEqual(pubs.map((p) => p.m), [1, 2]);

    subs.forEach((s) => s.unsubscribe());
  });

  it('INVARIANT: a subscriber that throws during iteration does NOT prevent the last-unsubscribe hook', async () => {
    let lastCount = 0;
    const channels = withHooksInstance<number>({
      onLastUnsubscribe: () => {
        lastCount++;
      },
    });

    const sub = channels.subscribe('k');
    const run = (async () => {
      try {
        for await (const _ of sub) {
          throw new Error('boom');
        }
      } catch {
        /* expected */
      }
    })();

    channels.publish('k', 1);
    await run;

    for (let i = 0; i < 3; i++) await Promise.resolve();
    assert.equal(lastCount, 1, 'last-unsubscribe must fire exactly once even after subscriber threw');
    assert.equal(channels.hasSubscribers('k'), false);
  });

  it('INVARIANT: re-subscribing after onLastUnsubscribe fires onFirstSubscriber again (proper 0->1 transition)', async () => {
    const first: string[] = [];
    const last: string[] = [];
    const channels = withHooksInstance<number>({
      onFirstSubscriber: (k) => {
        first.push(k);
      },
      onLastUnsubscribe: (k) => {
        last.push(k);
      },
    });

    const a = channels.subscribe('k');
    a.unsubscribe();
    for (let i = 0; i < 3; i++) await Promise.resolve();

    const b = channels.subscribe('k');
    b.unsubscribe();
    for (let i = 0; i < 3; i++) await Promise.resolve();

    assert.deepEqual(first, ['k', 'k']);
    assert.deepEqual(last, ['k', 'k']);
  });
});
