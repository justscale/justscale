/**
 * Hook semantics - onFirstSubscriber, onLastUnsubscribe, onPublish.
 * Also verifies deliverRemote does NOT trigger onPublish (no cluster echo loop).
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

// Helper: wait for microtasks/macrotasks so fire-and-forget hooks run
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('onFirstSubscriber hook', () => {
  test('fires when first subscriber arrives', async () => {
    const calls: string[] = [];
    const ch = makeInstance<number>({
      hooks: { onFirstSubscriber: (k) => { calls.push(k); } },
    });
    const sub = ch.subscribe('k');
    await tick();
    assert.deepStrictEqual(calls, ['k']);
    sub.unsubscribe();
  });

  test('does NOT fire for second subscriber on same key', async () => {
    const calls: string[] = [];
    const ch = makeInstance<number>({
      hooks: { onFirstSubscriber: (k) => { calls.push(k); } },
    });
    const s1 = ch.subscribe('k');
    await tick();
    const s2 = ch.subscribe('k');
    await tick();
    assert.deepStrictEqual(calls, ['k']);
    s1.unsubscribe();
    s2.unsubscribe();
  });

  test('fires again after count returns to 0 and new sub arrives', async () => {
    const calls: string[] = [];
    const ch = makeInstance<number>({
      hooks: { onFirstSubscriber: (k) => { calls.push(k); } },
    });
    const s1 = ch.subscribe('k');
    await tick();
    s1.unsubscribe();
    await tick();
    const s2 = ch.subscribe('k');
    await tick();
    assert.deepStrictEqual(calls, ['k', 'k']);
    s2.unsubscribe();
  });

  test('fires independently per channel key', async () => {
    const calls: string[] = [];
    const ch = makeInstance<number>({
      hooks: { onFirstSubscriber: (k) => { calls.push(k); } },
    });
    const a = ch.subscribe('a');
    const b = ch.subscribe('b');
    await tick();
    assert.deepStrictEqual(calls.sort(), ['a', 'b']);
    a.unsubscribe();
    b.unsubscribe();
  });

  test('hook receives the raw string key (not the object form)', async () => {
    const calls: string[] = [];
    const ch = makeInstance<number>({
      hooks: { onFirstSubscriber: (k) => { calls.push(k); } },
    });
    const s = ch.subscribe({ identifier: 'resolved' });
    await tick();
    assert.deepStrictEqual(calls, ['resolved']);
    s.unsubscribe();
  });

  test('async onFirstSubscriber is called but not awaited (fire-and-forget)', async () => {
    let resolved = false;
    const ch = makeInstance<number>({
      hooks: {
        onFirstSubscriber: async (_k) => {
          await new Promise((r) => setTimeout(r, 20));
          resolved = true;
        },
      },
    });
    const sub = ch.subscribe('k');
    // subscribe returns immediately even though hook is async
    assert.equal(sub.active, true);
    assert.equal(resolved, false);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(resolved, true);
    sub.unsubscribe();
  });

  // Sync throws in user hooks are swallowed - user hooks are transport-side
  // observability and must never crash the framework's pub/sub path.
  test('sync throws in onFirstSubscriber do NOT propagate', () => {
    const ch = makeInstance<number>({
      hooks: {
        onFirstSubscriber: () => {
          throw new Error('boom');
        },
      },
    });
    let sub: ReturnType<typeof ch.subscribe> | undefined;
    assert.doesNotThrow(() => { sub = ch.subscribe('k'); });
    assert.equal(sub!.active, true);
    sub!.unsubscribe();
  });

  // Async rejections in user hooks must not produce unhandledRejection events
  // (which would kill the process under node >= 20).
  test('async rejected onFirstSubscriber does not fire unhandledRejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const ch = makeInstance<number>({
        hooks: {
          onFirstSubscriber: async () => {
            throw new Error('async-boom');
          },
        },
      });
      const sub = ch.subscribe('k');
      assert.equal(sub.active, true);
      // Wait long enough for any unhandledRejection to surface
      await new Promise((r) => setTimeout(r, 20));
      assert.deepStrictEqual(unhandled, []);
      sub.unsubscribe();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('onLastUnsubscribe hook', () => {
  test('fires when subscriber count returns to 0', async () => {
    const calls: string[] = [];
    const ch = makeInstance<number>({
      hooks: { onLastUnsubscribe: (k) => { calls.push(k); } },
    });
    const s = ch.subscribe('k');
    await tick();
    s.unsubscribe();
    await tick();
    assert.deepStrictEqual(calls, ['k']);
  });

  test('does NOT fire if subscribers remain', async () => {
    const calls: string[] = [];
    const ch = makeInstance<number>({
      hooks: { onLastUnsubscribe: (k) => { calls.push(k); } },
    });
    const s1 = ch.subscribe('k');
    const s2 = ch.subscribe('k');
    s1.unsubscribe();
    await tick();
    assert.deepStrictEqual(calls, []);
    s2.unsubscribe();
    await tick();
    assert.deepStrictEqual(calls, ['k']);
  });

  test('fires on Symbol.dispose too', async () => {
    const calls: string[] = [];
    const ch = makeInstance<number>({
      hooks: { onLastUnsubscribe: (k) => { calls.push(k); } },
    });
    const s = ch.subscribe('k');
    s[Symbol.dispose]();
    await tick();
    assert.deepStrictEqual(calls, ['k']);
  });

  // Sync throws in user hooks are swallowed - unsubscribe must succeed.
  test('sync throws in onLastUnsubscribe do NOT propagate', () => {
    const ch = makeInstance<number>({
      hooks: {
        onLastUnsubscribe: () => {
          throw new Error('boom');
        },
      },
    });
    const s = ch.subscribe('k');
    assert.doesNotThrow(() => s.unsubscribe());
    assert.equal(s.active, false);
  });

  // Async rejections must not produce unhandledRejection events.
  test('async rejected onLastUnsubscribe does not fire unhandledRejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const ch = makeInstance<number>({
        hooks: {
          onLastUnsubscribe: async () => {
            throw new Error('async-boom');
          },
        },
      });
      const s = ch.subscribe('k');
      s.unsubscribe();
      assert.equal(s.active, false);
      await new Promise((r) => setTimeout(r, 20));
      assert.deepStrictEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('onPublish hook', () => {
  test('fires per publish with (key, message)', async () => {
    const calls: Array<[string, unknown]> = [];
    const ch = makeInstance<number>({
      hooks: { onPublish: (k, m) => { calls.push([k, m]); } },
    });
    ch.subscribe('k');
    ch.publish('k', 42);
    ch.publish('k', 43);
    await tick();
    assert.deepStrictEqual(calls, [['k', 42], ['k', 43]]);
  });

  test('fires even with no subscribers', async () => {
    const calls: Array<[string, unknown]> = [];
    const ch = makeInstance<number>({
      hooks: { onPublish: (k, m) => { calls.push([k, m]); } },
    });
    ch.publish('nobody', 99);
    await tick();
    assert.deepStrictEqual(calls, [['nobody', 99]]);
  });

  test('receives raw key string even if published via {identifier}', async () => {
    const calls: Array<[string, unknown]> = [];
    const ch = makeInstance<number>({
      hooks: { onPublish: (k, m) => { calls.push([k, m]); } },
    });
    ch.publish({ identifier: 'obj' }, 1);
    await tick();
    assert.deepStrictEqual(calls, [['obj', 1]]);
  });

  test('receives original (decoded) message, not the encoded wire form', async () => {
    const calls: unknown[] = [];
    const ch = makeInstance<{ type: string; v: number }>({
      hooks: { onPublish: (_k, m) => { calls.push(m); } },
    });
    const msg = { type: 'hello', v: 1 };
    ch.publish('k', msg);
    await tick();
    assert.deepStrictEqual(calls, [msg]);
  });

  // Sync throws in user hooks are swallowed - publish must succeed.
  test('sync throws in onPublish do NOT propagate', () => {
    const ch = makeInstance<number>({
      hooks: { onPublish: () => { throw new Error('boom'); } },
    });
    assert.doesNotThrow(() => ch.publish('k', 1));
  });

  // Async rejections must not produce unhandledRejection events.
  test('async rejected onPublish does not fire unhandledRejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const ch = makeInstance<number>({
        hooks: {
          onPublish: async () => {
            throw new Error('async-boom');
          },
        },
      });
      assert.doesNotThrow(() => ch.publish('k', 1));
      await new Promise((r) => setTimeout(r, 20));
      assert.deepStrictEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('deliverRemote - no onPublish echo', () => {
  test('deliverRemote does NOT call onPublish', async () => {
    const calls: Array<[string, unknown]> = [];
    const ch = makeInstance<number>({
      hooks: { onPublish: (k, m) => { calls.push([k, m]); } },
    });
    const sub = ch.subscribe('k');
    const out: number[] = [];
    const done = (async () => {
      for await (const m of sub) {
        out.push(m);
        if (out.length === 1) break;
      }
    })();
    await Promise.resolve();
    ch.deliverRemote('k', 99);
    await done;
    await tick();
    assert.deepStrictEqual(out, [99]);
    assert.deepStrictEqual(calls, []);
  });

  test('deliverRemote with no local subscribers is a no-op', () => {
    const calls: unknown[] = [];
    const ch = makeInstance<number>({
      hooks: { onPublish: (_k, m) => { calls.push(m); } },
    });
    assert.doesNotThrow(() => ch.deliverRemote('k', 1));
    assert.deepStrictEqual(calls, []);
  });

  test('deliverRemote reaches multiple local subscribers', async () => {
    const ch = makeInstance<string>();
    const a = ch.subscribe('k');
    const b = ch.subscribe('k');
    const collect = (sub: typeof a) => (async () => {
      const out: string[] = [];
      for await (const m of sub) {
        out.push(m);
        if (out.length === 1) break;
      }
      return out;
    })();
    const p = Promise.all([collect(a), collect(b)]);
    await Promise.resolve();
    ch.deliverRemote('k', 'remote!');
    const [ra, rb] = await p;
    assert.deepStrictEqual(ra, ['remote!']);
    assert.deepStrictEqual(rb, ['remote!']);
  });
});

describe('withHooks chaining', () => {
  test('withHooks on a def carries hooks to the new factory', async () => {
    const calls: string[] = [];
    const def = createChannels<number>().withHooks({
      onFirstSubscriber: (k) => { calls.push(k); },
    });
    const instance = def.factory({ backend: memoryBackend() } as any, undefined as any);
    const s = instance.subscribe('wh');
    await tick();
    assert.deepStrictEqual(calls, ['wh']);
    s.unsubscribe();
  });

  test('withHooks overrides previously-set hooks', async () => {
    const calls: string[] = [];
    const def = createChannels<number>({
      hooks: { onFirstSubscriber: (_k) => { calls.push('first'); } },
    }).withHooks({
      onFirstSubscriber: (_k) => { calls.push('second'); },
    });
    const instance = def.factory({ backend: memoryBackend() } as any, undefined as any);
    const s = instance.subscribe('k');
    await tick();
    assert.deepStrictEqual(calls, ['second']);
    s.unsubscribe();
  });
});
