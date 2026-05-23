/**
 * Processable protocol encoding for cross-node delivery.
 * Verifies that descriptor-based and auto-detected encodings round-trip.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createChannels } from '../channels.js';
import type { BackendSubscription, ChannelBackend } from '../backend.js';
import { registerProcessType } from '../../../process/serialization.js';

class CapturingBackend implements ChannelBackend {
  published: Array<{ key: string; message: unknown }> = [];
  cbs = new Map<string, (m: unknown) => void>();
  subscribe(key: string, onMessage: (m: unknown) => void): BackendSubscription {
    this.cbs.set(key, onMessage);
    return {
      ready: Promise.resolve(),
      [Symbol.dispose]: () => { this.cbs.delete(key); },
    };
  }
  publish(key: string, message: unknown): void {
    this.published.push({ key, message });
  }
  async close(): Promise<void> {}
  simulate(key: string, message: unknown): void {
    this.cbs.get(key)?.(message);
  }
}

// Ensure Symbol.process is present on Symbol (module augments on import)
// but the SymbolConstructor type augmentation requires a side-effect import
// of serialization.ts - which createChannels imports.

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('Processable encoding via explicit descriptor', () => {
  test('explicit descriptor is used to encode publish message for backend', () => {
    const be = new CapturingBackend();
    const descriptor: ProcessDescriptor<{ v: number }> = {
      name: 'test.Explicit',
      serialize: (v) => ({ vv: v.v }),
      deserialize: (d) => ({ v: (d as { vv: number }).vv }),
    };
    const ch = createChannels<{ v: number }>({ descriptor }).factory({ backend: be } as any, undefined as any);
    ch.publish('k', { v: 42 });
    assert.equal(be.published.length, 1);
    const wire = be.published[0].message as Record<string, unknown>;
    assert.equal(wire['__$p'], 'test.Explicit');
    assert.deepStrictEqual(wire['d'], { vv: 42 });
  });

  test('descriptor round-trips: encoded message decodes back on deliverRemote', async () => {
    const be = new CapturingBackend();
    const descriptor: ProcessDescriptor<{ v: number }> = {
      name: 'test.RoundTrip',
      serialize: (v) => ({ vv: v.v }),
      deserialize: (d) => ({ v: (d as { vv: number }).vv }),
    };
    const ch = createChannels<{ v: number }>({ descriptor }).factory({ backend: be } as any, undefined as any);
    const sub = ch.subscribe('k');
    await tick();
    const out: unknown[] = [];
    const done = (async () => {
      for await (const m of sub) {
        out.push(m);
        if (out.length === 1) break;
      }
    })();
    await Promise.resolve();
    // Simulate the same wire shape arriving from backend
    be.simulate('k', { ['__$p']: 'test.RoundTrip', d: { vv: 99 } });
    await done;
    assert.deepStrictEqual(out, [{ v: 99 }]);
  });

  test('deliverRemote decodes encoded payload via explicit descriptor', async () => {
    const be = new CapturingBackend();
    const descriptor: ProcessDescriptor<{ v: number }> = {
      name: 'test.DR',
      serialize: (v) => ({ vv: v.v }),
      deserialize: (d) => ({ v: (d as { vv: number }).vv }),
    };
    const ch = createChannels<{ v: number }>({ descriptor }).factory({ backend: be } as any, undefined as any);
    const sub = ch.subscribe('k');
    const out: unknown[] = [];
    const done = (async () => {
      for await (const m of sub) {
        out.push(m);
        if (out.length === 1) break;
      }
    })();
    await Promise.resolve();
    ch.deliverRemote('k', { ['__$p']: 'test.DR', d: { vv: 7 } } as any);
    await done;
    assert.deepStrictEqual(out, [{ v: 7 }]);
  });
});

describe('Auto-detect Processable on publish', () => {
  test('class with static [Symbol.process] is auto-encoded for backend', () => {
    class Money {
      constructor(public cents: number) {}
      static [Symbol.process]: ProcessDescriptor<Money> = {
        name: 'test.Money',
        serialize: (v: Money) => ({ c: v.cents }),
        deserialize: (d: any) => new Money(d.c),
      };
    }
    registerProcessType(Money[Symbol.process]);
    const be = new CapturingBackend();
    const ch = createChannels<Money>().factory({ backend: be } as any, undefined as any);
    ch.publish('k', new Money(500));
    assert.equal(be.published.length, 1);
    const wire = be.published[0].message as Record<string, unknown>;
    assert.equal(wire['__$p'], 'test.Money');
    assert.deepStrictEqual(wire['d'], { c: 500 });
  });

  test('plain object without descriptor is passed through unchanged', () => {
    const be = new CapturingBackend();
    const ch = createChannels<Record<string, unknown>>().factory({ backend: be } as any, undefined as any);
    const msg = { type: 'hello', v: 1 };
    ch.publish('k', msg);
    assert.deepStrictEqual(be.published[0].message, msg);
  });

  test('auto-encoded message round-trips through deliverRemote', async () => {
    class Widget {
      constructor(public label: string) {}
      static [Symbol.process]: ProcessDescriptor<Widget> = {
        name: 'test.Widget',
        serialize: (v: Widget) => ({ l: v.label }),
        deserialize: (d: any) => new Widget(d.l),
      };
    }
    registerProcessType(Widget[Symbol.process]);
    const be = new CapturingBackend();
    const ch = createChannels<Widget>().factory({ backend: be } as any, undefined as any);
    const sub = ch.subscribe('k');
    const out: unknown[] = [];
    const done = (async () => {
      for await (const m of sub) {
        out.push(m);
        if (out.length === 1) break;
      }
    })();
    await Promise.resolve();
    ch.deliverRemote('k', { ['__$p']: 'test.Widget', d: { l: 'hello' } } as any);
    await done;
    assert.equal(out.length, 1);
    const w = out[0] as Widget;
    assert.equal(w.label, 'hello');
    assert.ok(w instanceof Widget);
  });
});

describe('Decode fallback', () => {
  test('unknown descriptor name throws at delivery (proc-3 contract)', async () => {
    const be = new CapturingBackend();
    const ch = createChannels<unknown>().factory({ backend: be } as any, undefined as any);
    // Subscribe so the channel actually attempts to deliver.
    void ch.subscribe('k');
    await Promise.resolve();
    assert.throws(
      () => ch.deliverRemote('k', { ['__$p']: 'does.not.exist', d: { x: 1 } }),
      /Unknown descriptor 'does\.not\.exist'/,
    );
  });
});
