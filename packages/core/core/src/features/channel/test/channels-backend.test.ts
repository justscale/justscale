/**
 * Backend integration - prefix, subscribe/publish plumbing, descriptor encoding.
 * Uses a fake backend to observe what the channels layer sends.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createChannels } from '../channels.js';
import type { BackendSubscription, ChannelBackend } from '../backend.js';
import { MemoryChannelBackend } from '../backend.js';

class FakeBackend implements ChannelBackend {
  subscribeCalls: Array<{ key: string; cb: (m: unknown) => void }> = [];
  publishCalls: Array<{ key: string; message: unknown }> = [];
  closeCalls = 0;
  disposeCalls: string[] = [];

  subscribe(key: string, onMessage: (m: unknown) => void): BackendSubscription {
    this.subscribeCalls.push({ key, cb: onMessage });
    const self = this;
    return {
      ready: Promise.resolve(),
      [Symbol.dispose]: () => {
        self.disposeCalls.push(key);
      },
    };
  }

  publish(key: string, message: unknown): void {
    this.publishCalls.push({ key, message });
  }

  async close(): Promise<void> {
    this.closeCalls++;
  }

  // Simulate remote arrival
  simulateRemote(key: string, message: unknown): void {
    for (const { key: k, cb } of this.subscribeCalls) {
      if (k === key) cb(message);
    }
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('backend subscribe', () => {
  test('first subscriber triggers backend.subscribe with raw channel key', async () => {
    const be = new FakeBackend();
    const ch = createChannels<number>().factory({ backend: be } as any, undefined as any);
    const s = ch.subscribe('k');
    await tick();
    assert.equal(be.subscribeCalls.length, 1);
    assert.equal(be.subscribeCalls[0].key, 'k');
    s.unsubscribe();
  });

  test('second subscriber on same key does NOT re-subscribe backend', async () => {
    const be = new FakeBackend();
    const ch = createChannels<number>().factory({ backend: be } as any, undefined as any);
    const s1 = ch.subscribe('k');
    const s2 = ch.subscribe('k');
    await tick();
    assert.equal(be.subscribeCalls.length, 1);
    s1.unsubscribe();
    s2.unsubscribe();
  });

  test('last unsubscribe disposes the backend subscription', async () => {
    const be = new FakeBackend();
    const ch = createChannels<number>().factory({ backend: be } as any, undefined as any);
    const s = ch.subscribe('k');
    await tick();
    s.unsubscribe();
    await tick();
    assert.deepStrictEqual(be.disposeCalls, ['k']);
  });

  test('backend.subscribe is applied the prefix when configured', async () => {
    const be = new FakeBackend();
    const ch = createChannels<number>({ prefix: 'room:' })
      .factory({ backend: be } as any, undefined as any);
    const s = ch.subscribe('42');
    await tick();
    assert.equal(be.subscribeCalls[0].key, 'room:42');
    s.unsubscribe();
  });

  test('backend.publish is called on publish with prefix', () => {
    const be = new FakeBackend();
    const ch = createChannels<number>({ prefix: 'room:' })
      .factory({ backend: be } as any, undefined as any);
    ch.publish('42', 7);
    assert.equal(be.publishCalls.length, 1);
    assert.equal(be.publishCalls[0].key, 'room:42');
  });

  test('publish to no subscribers still hits backend (for remote-only consumers)', () => {
    const be = new FakeBackend();
    const ch = createChannels<number>().factory({ backend: be } as any, undefined as any);
    ch.publish('k', 123);
    assert.equal(be.publishCalls.length, 1);
    assert.equal(be.publishCalls[0].key, 'k');
  });

  test('backend callback routes remote messages to local subscribers', async () => {
    const be = new FakeBackend();
    const ch = createChannels<number>().factory({ backend: be } as any, undefined as any);
    const sub = ch.subscribe('k');
    await tick();
    const out: number[] = [];
    const done = (async () => {
      for await (const m of sub) {
        out.push(m);
        if (out.length === 1) break;
      }
    })();
    await Promise.resolve();
    be.simulateRemote('k', 42);
    await done;
    assert.deepStrictEqual(out, [42]);
  });

  test('backend callback with no subscribers is a no-op (no crash)', async () => {
    const be = new FakeBackend();
    const ch = createChannels<number>().factory({ backend: be } as any, undefined as any);
    const sub = ch.subscribe('k');
    await tick();
    sub.unsubscribe();
    await tick();
    // After unsubscribe, backend.subscribe is disposed; still robust if another callback fires
    assert.doesNotThrow(() => {
      for (const entry of be.subscribeCalls) entry.cb(99);
    });
  });

  test('close() disposes all backend subs', async () => {
    const be = new FakeBackend();
    const ch = createChannels<number>().factory({ backend: be } as any, undefined as any);
    ch.subscribe('a');
    ch.subscribe('b');
    await tick();
    assert.equal(be.subscribeCalls.length, 2);
    ch.close();
    assert.deepStrictEqual(be.disposeCalls.sort(), ['a', 'b']);
  });
});

describe('MemoryChannelBackend', () => {
  test('factory produces subscribe/publish/close', () => {
    const be = MemoryChannelBackend.factory({} as any, undefined as any) as ChannelBackend;
    assert.equal(typeof be.subscribe, 'function');
    assert.equal(typeof be.publish, 'function');
    assert.equal(typeof be.close, 'function');
  });

  test('subscribe returns a Disposable (no-op)', () => {
    const be = MemoryChannelBackend.factory({} as any, undefined as any) as ChannelBackend;
    const d = be.subscribe('k', () => {});
    assert.equal(typeof d[Symbol.dispose], 'function');
    assert.doesNotThrow(() => d[Symbol.dispose]());
  });

  test('publish is a no-op and does not error', () => {
    const be = MemoryChannelBackend.factory({} as any, undefined as any) as ChannelBackend;
    assert.doesNotThrow(() => be.publish('k', { a: 1 }));
  });

  test('close resolves', async () => {
    const be = MemoryChannelBackend.factory({} as any, undefined as any) as ChannelBackend;
    await assert.doesNotReject(be.close());
  });
});
