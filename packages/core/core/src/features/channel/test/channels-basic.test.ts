/**
 * Basic createChannels behaviour - subscribe/publish/close, key resolution, isolation.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createChannels } from '../channels.js';
import type { ChannelBackend } from '../backend.js';
import { resolveChannelKey } from '../types.js';

function memoryBackend(): ChannelBackend {
  return {
    subscribe: () => ({ ready: Promise.resolve(), [Symbol.dispose]: () => {} }),
    publish: () => {},
    async close() {},
  };
}

function makeInstance<T>(opts: Parameters<typeof createChannels<T>>[0] = {}) {
  const def = createChannels<T>(opts);
  // Factory bypasses DI - call directly
  return def.factory({ backend: memoryBackend() } as any, undefined as any);
}

describe('createChannels - factory + instance', () => {
  test('returns a def with deps, factory, withHooks', () => {
    const def = createChannels<string>();
    assert.ok(def.deps);
    assert.equal(typeof def.factory, 'function');
    assert.equal(typeof def.withHooks, 'function');
  });

  test('withHooks returns a new def without mutating the original', () => {
    const a = createChannels<string>();
    const b = a.withHooks({ onPublish: () => {} });
    assert.notEqual(a, b);
    assert.equal(typeof b.withHooks, 'function');
  });

  test('instance exposes all documented methods', () => {
    const ch = makeInstance<string>();
    assert.equal(typeof ch.configureHooks, 'function');
    assert.equal(typeof ch.subscribe, 'function');
    assert.equal(typeof ch.publish, 'function');
    assert.equal(typeof ch.deliverRemote, 'function');
    assert.equal(typeof ch.getChannel, 'function');
    assert.equal(typeof ch.hasSubscribers, 'function');
    assert.equal(typeof ch.getActiveChannels, 'function');
    assert.equal(typeof ch.close, 'function');
  });
});

describe('resolveChannelKey', () => {
  test('returns string unchanged', () => {
    assert.equal(resolveChannelKey('abc'), 'abc');
  });
  test('returns identifier property for object keys', () => {
    assert.equal(resolveChannelKey({ identifier: 'xyz' }), 'xyz');
  });
  test('empty string is a valid key', () => {
    assert.equal(resolveChannelKey(''), '');
  });
  test('identifier can be empty string', () => {
    assert.equal(resolveChannelKey({ identifier: '' }), '');
  });
});

describe('ChannelKey - string vs {identifier}', () => {
  test('string and {identifier:x} resolve to the same logical channel', async () => {
    const ch = makeInstance<string>();
    const sub = ch.subscribe({ identifier: 'room-1' });
    const messages: string[] = [];

    const consume = (async () => {
      for await (const m of sub) {
        messages.push(m);
        if (messages.length === 2) break;
      }
    })();

    await Promise.resolve();
    ch.publish('room-1', 'via-string');
    ch.publish({ identifier: 'room-1' }, 'via-object');
    await consume;

    assert.deepStrictEqual(messages, ['via-string', 'via-object']);
  });

  test('hasSubscribers works for both key forms', () => {
    const ch = makeInstance<string>();
    const sub = ch.subscribe('k1');
    assert.equal(ch.hasSubscribers('k1'), true);
    assert.equal(ch.hasSubscribers({ identifier: 'k1' }), true);
    sub.unsubscribe();
    assert.equal(ch.hasSubscribers('k1'), false);
    assert.equal(ch.hasSubscribers({ identifier: 'k1' }), false);
  });
});

describe('subscribe - AsyncIterable + Disposable', () => {
  test('subscription is AsyncIterable', () => {
    const ch = makeInstance<number>();
    const sub = ch.subscribe('k');
    assert.equal(typeof sub[Symbol.asyncIterator], 'function');
    sub.unsubscribe();
  });

  test('subscription is Disposable (Symbol.dispose defined)', () => {
    const ch = makeInstance<number>();
    const sub = ch.subscribe('k');
    assert.equal(typeof sub[Symbol.dispose], 'function');
    sub[Symbol.dispose]();
  });

  test('active flips to false on unsubscribe', () => {
    const ch = makeInstance<number>();
    const sub = ch.subscribe('k');
    assert.equal(sub.active, true);
    sub.unsubscribe();
    assert.equal(sub.active, false);
  });

  test('channelKey mirrors the key', () => {
    const ch = makeInstance<number>();
    const sub = ch.subscribe({ identifier: 'zzz' });
    assert.equal(sub.channelKey, 'zzz');
    sub.unsubscribe();
  });

  test('calling unsubscribe twice is safe', () => {
    const ch = makeInstance<number>();
    const sub = ch.subscribe('k');
    sub.unsubscribe();
    sub.unsubscribe();
    assert.equal(sub.active, false);
  });

  test('using block auto-disposes', () => {
    const ch = makeInstance<number>();
    {
      using sub = ch.subscribe('auto');
      assert.equal(sub.active, true);
      assert.equal(ch.hasSubscribers('auto'), true);
    }
    assert.equal(ch.hasSubscribers('auto'), false);
  });
});

describe('publish + multi-subscriber delivery', () => {
  test('single subscriber receives published messages', async () => {
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
    ch.publish('k', 1);
    ch.publish('k', 2);
    ch.publish('k', 3);
    await done;
    assert.deepStrictEqual(out, [1, 2, 3]);
  });

  test('multiple subscribers to same key all receive', async () => {
    const ch = makeInstance<string>();
    const a = ch.subscribe('room');
    const b = ch.subscribe('room');
    const c = ch.subscribe('room');

    const collect = (sub: typeof a) => (async () => {
      const out: string[] = [];
      for await (const m of sub) {
        out.push(m);
        if (out.length === 2) break;
      }
      return out;
    })();

    const p = Promise.all([collect(a), collect(b), collect(c)]);
    await Promise.resolve();
    ch.publish('room', 'hi');
    ch.publish('room', 'there');
    const [ra, rb, rc] = await p;
    assert.deepStrictEqual(ra, ['hi', 'there']);
    assert.deepStrictEqual(rb, ['hi', 'there']);
    assert.deepStrictEqual(rc, ['hi', 'there']);
  });

  test('subscribers on different keys are isolated', async () => {
    const ch = makeInstance<string>();
    const roomA = ch.subscribe('A');
    const roomB = ch.subscribe('B');
    const outA: string[] = [];
    const outB: string[] = [];
    const ap = (async () => {
      for await (const m of roomA) {
        outA.push(m);
        if (outA.length === 2) break;
      }
    })();
    const bp = (async () => {
      for await (const m of roomB) {
        outB.push(m);
        if (outB.length === 1) break;
      }
    })();
    await Promise.resolve();
    ch.publish('A', 'a1');
    ch.publish('B', 'b1');
    ch.publish('A', 'a2');
    await Promise.all([ap, bp]);
    assert.deepStrictEqual(outA, ['a1', 'a2']);
    assert.deepStrictEqual(outB, ['b1']);
  });

  test('late subscribers do not see prior messages', async () => {
    const ch = makeInstance<string>();
    // publish with no subscriber
    ch.publish('k', 'early-1');
    ch.publish('k', 'early-2');

    const sub = ch.subscribe('k');
    const out: string[] = [];
    const p = (async () => {
      for await (const m of sub) {
        out.push(m);
        if (out.length === 1) break;
      }
    })();
    await Promise.resolve();
    ch.publish('k', 'after-subscribe');
    await p;
    assert.deepStrictEqual(out, ['after-subscribe']);
  });

  test('publish to key with no subscribers does not throw', () => {
    const ch = makeInstance<number>();
    assert.doesNotThrow(() => ch.publish('nobody', 42));
  });

  test('publish to key with no subscribers still creates channel lazily', () => {
    const ch = makeInstance<number>();
    ch.publish('lazy', 1);
    // publish creates channel, but no subscribers - hasSubscribers false
    assert.equal(ch.hasSubscribers('lazy'), false);
  });
});

describe('hasSubscribers + getActiveChannels + getChannel', () => {
  test('hasSubscribers false for unknown key', () => {
    const ch = makeInstance<number>();
    assert.equal(ch.hasSubscribers('nope'), false);
  });

  test('hasSubscribers transitions with subscribe/unsubscribe', () => {
    const ch = makeInstance<number>();
    assert.equal(ch.hasSubscribers('k'), false);
    const s1 = ch.subscribe('k');
    assert.equal(ch.hasSubscribers('k'), true);
    const s2 = ch.subscribe('k');
    assert.equal(ch.hasSubscribers('k'), true);
    s1.unsubscribe();
    assert.equal(ch.hasSubscribers('k'), true); // s2 still alive
    s2.unsubscribe();
    assert.equal(ch.hasSubscribers('k'), false);
  });

  test('getActiveChannels lists only keys with subscribers', () => {
    const ch = makeInstance<number>();
    const a = ch.subscribe('a');
    ch.subscribe('b').unsubscribe(); // created + immediately removed
    const c = ch.subscribe('c');
    const active = ch.getActiveChannels().sort();
    assert.deepStrictEqual(active, ['a', 'c']);
    a.unsubscribe();
    c.unsubscribe();
    assert.deepStrictEqual(ch.getActiveChannels(), []);
  });

  test('getChannel creates on demand and returns same instance for same key', () => {
    const ch = makeInstance<number>();
    const a = ch.getChannel('k');
    const b = ch.getChannel('k');
    assert.equal(a, b);
    assert.equal(a.key, 'k');
  });

  test('getChannel accepts {identifier} form', () => {
    const ch = makeInstance<number>();
    const a = ch.getChannel({ identifier: 'x' });
    const b = ch.getChannel('x');
    assert.equal(a, b);
  });
});

describe('close()', () => {
  test('clears all subscriptions and backend subs', () => {
    const ch = makeInstance<number>();
    ch.subscribe('a');
    ch.subscribe('b');
    assert.equal(ch.getActiveChannels().length, 2);
    ch.close();
    assert.deepStrictEqual(ch.getActiveChannels(), []);
  });

  test('close() is idempotent', () => {
    const ch = makeInstance<number>();
    ch.subscribe('a');
    ch.close();
    assert.doesNotThrow(() => ch.close());
  });
});
