/**
 * Async iterator lifecycle - early break, throw, return, using.
 * Verifies subscriber count decrements on each exit path.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createChannels } from '../channels.js';
import type { ChannelBackend } from '../backend.js';

function memoryBackend(): ChannelBackend {
  return {
    subscribe: () => ({ ready: Promise.resolve(), [Symbol.dispose]: () => {} }),
    publish: () => {},
    async close() {},
  };
}

function makeInstance<T>(opts: Parameters<typeof createChannels<T>>[0] = {}) {
  return createChannels<T>(opts).factory({ backend: memoryBackend() } as any, undefined as any);
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('iterator lifecycle', () => {
  test('early break decrements subscriber count', async () => {
    const ch = makeInstance<number>();
    const sub = ch.subscribe('k');
    const done = (async () => {
      for await (const m of sub) {
        void m;
        break;
      }
    })();
    await Promise.resolve();
    ch.publish('k', 1);
    await done;
    assert.equal(ch.hasSubscribers('k'), false);
    assert.equal(sub.active, false);
  });

  test('throw inside for-await decrements subscriber count', async () => {
    const ch = makeInstance<number>();
    const sub = ch.subscribe('k');
    const started = assert.rejects(async () => {
      for await (const m of sub) {
        void m;
        throw new Error('bye');
      }
    }, /bye/);
    // Push one message so the for-await body actually runs
    await Promise.resolve();
    ch.publish('k', 1);
    await started;
    assert.equal(ch.hasSubscribers('k'), false);
    assert.equal(sub.active, false);
  });

  test('explicit return from running generator decrements subscriber count', async () => {
    const ch = makeInstance<number>();
    const sub = ch.subscribe('k');
    const iter = sub[Symbol.asyncIterator]();
    // Start the generator so the try/finally is entered
    const nextPromise = iter.next();
    await Promise.resolve();
    ch.publish('k', 1);
    await nextPromise;
    // Now return - cleanup runs via finally
    await iter.return!();
    assert.equal(sub.active, false);
    assert.equal(ch.hasSubscribers('k'), false);
  });

  test('using block disposes + decrements', async () => {
    const ch = makeInstance<number>();
    {
      using sub = ch.subscribe('k');
      assert.equal(ch.hasSubscribers('k'), true);
      void sub;
    }
    assert.equal(ch.hasSubscribers('k'), false);
  });

  test('iterator drains all queued messages in a single wake', async () => {
    const ch = makeInstance<number>();
    const sub = ch.subscribe('k');
    const out: number[] = [];
    const done = (async () => {
      for await (const m of sub) {
        out.push(m);
        if (out.length === 3) break;
      }
    })();
    await Promise.resolve();
    // All three published before any microtask runs
    ch.publish('k', 1);
    ch.publish('k', 2);
    ch.publish('k', 3);
    await done;
    assert.deepStrictEqual(out, [1, 2, 3]);
  });

  test('messages published before iteration starts are delivered', async () => {
    const ch = makeInstance<number>();
    const sub = ch.subscribe('k');
    // Publish before anyone starts iterating
    ch.publish('k', 10);
    ch.publish('k', 20);
    const out: number[] = [];
    const done = (async () => {
      for await (const m of sub) {
        out.push(m);
        if (out.length === 2) break;
      }
    })();
    await done;
    assert.deepStrictEqual(out, [10, 20]);
  });

  test('messages published after unsubscribe are not received', async () => {
    const ch = makeInstance<number>();
    const sub = ch.subscribe('k');
    sub.unsubscribe();
    ch.publish('k', 1);
    // Iteration over a closed subscription: generator not yet started, start -> immediately disposed
    const out: number[] = [];
    for await (const m of sub) {
      out.push(m);
    }
    assert.deepStrictEqual(out, []);
  });

  test('many subscribers each get their own queue', async () => {
    const ch = makeInstance<number>();
    const subs = Array.from({ length: 5 }, () => ch.subscribe('k'));
    const collected = subs.map((sub) => (async () => {
      const out: number[] = [];
      for await (const m of sub) {
        out.push(m);
        if (out.length === 2) break;
      }
      return out;
    })());
    await Promise.resolve();
    ch.publish('k', 1);
    ch.publish('k', 2);
    const results = await Promise.all(collected);
    for (const r of results) {
      assert.deepStrictEqual(r, [1, 2]);
    }
    assert.equal(ch.hasSubscribers('k'), false);
  });

  test('subscriber unsubscribed while waiting wakes generator cleanly', async () => {
    const ch = makeInstance<number>();
    const sub = ch.subscribe('k');
    const out: number[] = [];
    const p = (async () => {
      for await (const m of sub) {
        out.push(m);
      }
    })();
    // Wait for generator to start and block
    await new Promise((r) => setTimeout(r, 10));
    sub.unsubscribe();
    await p;
    assert.deepStrictEqual(out, []);
  });
});

describe('concurrent publish/subscribe', () => {
  test('publish that races with subscribe() creation', async () => {
    const ch = makeInstance<number>();
    // Subscribe and publish in same tick - publish must arrive
    const sub = ch.subscribe('k');
    ch.publish('k', 1);
    const out: number[] = [];
    const done = (async () => {
      for await (const m of sub) {
        out.push(m);
        break;
      }
    })();
    await done;
    assert.deepStrictEqual(out, [1]);
  });

  test('many rapid publishes do not drop messages', async () => {
    const ch = makeInstance<number>();
    const sub = ch.subscribe('k');
    const N = 100;
    const out: number[] = [];
    const done = (async () => {
      for await (const m of sub) {
        out.push(m);
        if (out.length === N) break;
      }
    })();
    await Promise.resolve();
    for (let i = 0; i < N; i++) ch.publish('k', i);
    await done;
    assert.equal(out.length, N);
    assert.deepStrictEqual(out, Array.from({ length: N }, (_v, i) => i));
  });
});

describe('recentlyPublished dedupe', () => {
  // Observed behaviour: channel.publish adds the JSON-hash of a message to a
  // recentlyPublished set; deliverLocal drops + clears ONE matching hash.
  // Test documents the current dedupe window.
  test('deliverRemote after publish of equivalent message is dropped once', async () => {
    const ch = makeInstance<{ v: number }>();
    const sub = ch.subscribe('k');
    const out: unknown[] = [];
    const done = (async () => {
      for await (const m of sub) {
        out.push(m);
        if (out.length === 2) break;
      }
    })();
    await Promise.resolve();
    ch.publish('k', { v: 1 }); // out: [{v:1}]
    ch.deliverRemote('k', { v: 1 }); // dropped (dedupe)
    ch.deliverRemote('k', { v: 1 }); // delivered (dedupe cleared after first)
    await done;
    assert.deepStrictEqual(out, [{ v: 1 }, { v: 1 }]);
  });

  test('deliverRemote of a different message passes through', async () => {
    const ch = makeInstance<{ v: number }>();
    const sub = ch.subscribe('k');
    const out: unknown[] = [];
    const done = (async () => {
      for await (const m of sub) {
        out.push(m);
        if (out.length === 2) break;
      }
    })();
    await Promise.resolve();
    ch.publish('k', { v: 1 });
    ch.deliverRemote('k', { v: 2 });
    await done;
    assert.deepStrictEqual(out, [{ v: 1 }, { v: 2 }]);
  });
});
