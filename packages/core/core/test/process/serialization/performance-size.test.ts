/**
 * Processable protocol — PERFORMANCE + SIZE invariants.
 *
 * These are NOT latency benchmarks (we have no budget for that). They pin
 * properties that silent regressions would bury:
 *   - Does serialize complete at all for a 10k-item array? (no hang)
 *   - Does the output size grow LINEARLY, not pathologically?
 *   - Does a large Map preserve every entry?
 *
 * We avoid timing assertions — instead we assert "completes" (bounded
 * time-wait) and "size is proportional to input".
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeProcessable,
  decodeProcessable,
  registerProcessType,
} from '../../../src/process/serialization.js';
import { serializeState, deserializeState } from '../../../src/runtime/process/state-serializer.js';

// Side-effect: registers builtins
import '../../../src/process/builtin-serializers.js';

const rtState = (vars: Record<string, unknown>) =>
  deserializeState(JSON.parse(JSON.stringify(serializeState(vars))));

describe('Large arrays', () => {
  it('INVARIANT: 10 000 primitives round-trip without loss', () => {
    const arr = Array.from({ length: 10_000 }, (_, i) => i);
    const round = rtState({ arr }) as { arr: number[] };
    assert.equal(round.arr.length, 10_000);
    assert.equal(round.arr[0], 0);
    assert.equal(round.arr[5000], 5000);
    assert.equal(round.arr[9999], 9999);
  });

  it('INVARIANT: 10 000 Date instances round-trip every millisecond', () => {
    const arr = Array.from({ length: 10_000 }, (_, i) => new Date(i * 1000));
    const round = rtState({ arr }) as { arr: Date[] };
    assert.equal(round.arr.length, 10_000);
    assert.ok(round.arr[0] instanceof Date);
    assert.equal(round.arr[0].getTime(), 0);
    assert.ok(round.arr[9999] instanceof Date);
    assert.equal(round.arr[9999].getTime(), 9999 * 1000);
  });

  it('INVARIANT: 10 000 objects with mixed types preserve structure', () => {
    const arr = Array.from({ length: 10_000 }, (_, i) => ({
      id: `x-${i}`,
      created: new Date(i),
      count: BigInt(i),
    }));
    const round = rtState({ arr }) as { arr: { id: string; created: Date; count: bigint }[] };
    assert.equal(round.arr.length, 10_000);
    const pick = round.arr[4321];
    assert.equal(pick.id, 'x-4321');
    assert.ok(pick.created instanceof Date);
    assert.equal(pick.count, 4321n);
  });
});

describe('Large Maps', () => {
  it('INVARIANT: 1 000-key Map preserves every entry', () => {
    const m = new Map<string, number>();
    for (let i = 0; i < 1000; i++) m.set(`k-${i}`, i);
    const round = rtState({ m }) as { m: Map<string, number> };
    assert.ok(round.m instanceof Map);
    assert.equal(round.m.size, 1000);
    for (let i = 0; i < 1000; i++) {
      assert.equal(round.m.get(`k-${i}`), i);
    }
  });

  it('INVARIANT: 1 000-item Set preserves every item', () => {
    const s = new Set<number>();
    for (let i = 0; i < 1000; i++) s.add(i);
    const round = rtState({ s }) as { s: Set<number> };
    assert.ok(round.s instanceof Set);
    assert.equal(round.s.size, 1000);
    for (let i = 0; i < 1000; i++) {
      assert.ok(round.s.has(i));
    }
  });
});

describe('Output size — no pathological blowup', () => {
  it('INVARIANT: serialized size is LINEAR in number of items, not quadratic', () => {
    // Measure size at n=100, n=200, n=400. If we ever got quadratic behavior
    // (e.g., stringifying nested state redundantly), the ratios would diverge.
    const size = (n: number) => {
      const arr = Array.from({ length: n }, (_, i) => ({ v: i }));
      return JSON.stringify(serializeState({ arr })).length;
    };
    const s100 = size(100);
    const s200 = size(200);
    const s400 = size(400);

    // Linear ratio should be ~2x each step. Allow 1.5x - 3x window.
    const r1 = s200 / s100;
    const r2 = s400 / s200;
    assert.ok(r1 > 1.5 && r1 < 3, `size(200)/size(100) ratio ${r1} must be linear`);
    assert.ok(r2 > 1.5 && r2 < 3, `size(400)/size(200) ratio ${r2} must be linear`);
  });

  it('INVARIANT: size of serialized Processable payload is bounded near the size of its data', () => {
    // Overhead of the __$p envelope must be bounded. For a 1000-char string
    // payload, the envelope should add <100 bytes, not 1000+.
    class BigString {
      constructor(public s: string) {}
      static [Symbol.process]: ProcessDescriptor<BigString> = {
        name: 'test.perf.BigString',
        serialize: (v: BigString) => ({ s: v.s }),
        deserialize: (d: any) => new BigString(d.s),
      };
    }
    registerProcessType(BigString[Symbol.process]);

    const payload = 'x'.repeat(1000);
    const obj = new BigString(payload);
    const encoded = JSON.stringify(encodeProcessable(obj));
    // Envelope structure: {"__$p":"test.perf.BigString","d":{"s":"xxx..."}}
    // Overhead upper bound: 100 chars
    assert.ok(
      encoded.length < payload.length + 100,
      `envelope overhead should be <100 chars, got ${encoded.length - payload.length}`,
    );
  });
});

describe('Large state round-trip', () => {
  it('INVARIANT: a state with 100 keys, each carrying a 100-item array, round-trips fully', () => {
    const vars: Record<string, unknown> = {};
    for (let k = 0; k < 100; k++) {
      vars[`key${k}`] = Array.from({ length: 100 }, (_, i) => ({
        idx: i,
        label: `item-${k}-${i}`,
      }));
    }
    const round = rtState(vars) as Record<string, { idx: number; label: string }[]>;
    assert.equal(Object.keys(round).length, 100);
    assert.equal(round.key42[7].label, 'item-42-7');
    assert.equal(round.key99[99].idx, 99);
  });

  it('INVARIANT: a state with 1 000 heterogeneous keys round-trips', () => {
    const vars: Record<string, unknown> = {};
    for (let i = 0; i < 1000; i++) {
      if (i % 4 === 0) vars[`k${i}`] = `string-${i}`;
      else if (i % 4 === 1) vars[`k${i}`] = i;
      else if (i % 4 === 2) vars[`k${i}`] = new Date(i);
      else vars[`k${i}`] = BigInt(i);
    }
    const round = rtState(vars);
    assert.equal(Object.keys(round).length, 1000);
    assert.equal(round.k0, 'string-0');
    assert.equal(round.k5, 5);
    assert.ok(round.k6 instanceof Date);
    assert.equal(round.k7, 7n);
  });
});
