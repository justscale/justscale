/**
 * Processable protocol — CYCLES + DEEP NESTING edge cases.
 *
 * The state-serializer is the realistic entry point — it walks nested
 * structures. Pin how it handles cycles (self-reference, parent-child)
 * and deep nesting (hang? stack overflow? success?). A silent bug here
 * corrupts every durable process that tries to persist a recursive
 * structure.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { serializeState, deserializeState } from '../../../src/runtime/process/state-serializer.js';
import { encodeProcessable } from '../../../src/process/serialization.js';

// Side-effect: registers builtins
import '../../../src/process/builtin-serializers.js';

const rtState = (vars: Record<string, unknown>) =>
  deserializeState(JSON.parse(JSON.stringify(serializeState(vars))));

describe('Cycles — self-reference', () => {
  it('INVARIANT: direct self-reference is rejected — encodeProcessable throws with cycle path (proc-10)', () => {
    const a: any = { name: 'a' };
    a.self = a;
    // proc-10: the error message must include the path where the cycle was detected.
    assert.throws(
      () => encodeProcessable(a),
      (err: Error) => /cycle at/i.test(err.message),
      'direct cycle must throw with path info',
    );
  });

  it('INVARIANT: indirect cycle (a ↔ b) throws with cycle path (proc-10)', () => {
    const a: any = { name: 'a' };
    const b: any = { name: 'b' };
    a.partner = b;
    b.partner = a;
    assert.throws(
      () => encodeProcessable(a),
      (err: Error) => /cycle at/i.test(err.message),
      'indirect cycle must throw with path info',
    );
  });

  it('INVARIANT: cycle inside an Array element throws with cycle path', () => {
    const a: any = { name: 'a' };
    a.list = [a];
    assert.throws(
      () => encodeProcessable(a),
      (err: Error) => /cycle at/i.test(err.message),
    );
  });

  it('INVARIANT: cycle error message names the offending path segment (proc-10)', () => {
    const a: any = {};
    a.self = a;
    let caught: Error | null = null;
    try {
      encodeProcessable(a, new Set(), 'myObj');
    } catch (e) {
      caught = e as Error;
    }
    assert.ok(caught, 'must throw');
    // The cycle happens at myObj.self which points back to myObj.
    // The error message must include the path to identify where.
    assert.ok(
      /cycle at/i.test(caught.message),
      `error must contain path info. Got: ${caught.message}`,
    );
    assert.ok(
      /myObj.self/i.test(caught.message),
      `error must name the offending path. Got: ${caught.message}`,
    );
  });

  it('INVARIANT: serializeState with circular structure throws (may be RangeError or cycle error)', () => {
    const a: any = { name: 'cycle-in-state' };
    a.self = a;
    // serializeState uses its own traversal — it may throw RangeError (stack overflow)
    // or a cycle error, but must NOT silently succeed.
    assert.throws(
      () => serializeState({ a }),
      (err: Error) =>
        err instanceof RangeError ||
        /call stack|Maximum/i.test(err.message) ||
        /circular|cycle/i.test(err.message),
    );
  });

  it('INVARIANT: cycle inside a Map VALUE throws', () => {
    const a: any = { name: 'cycle-in-map' };
    const m = new Map<string, unknown>();
    m.set('self', a);
    a.m = m;
    // When the cycle is routed through a Map, we expect a throw as well.
    assert.throws(
      () => serializeState({ container: a }),
      (err: Error) =>
        err instanceof RangeError ||
        /call stack|Maximum/i.test(err.message) ||
        /circular|cycle/i.test(err.message),
    );
  });
});

describe('Deep nesting', () => {
  function makeNest(depth: number): Record<string, unknown> {
    let node: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < depth; i++) {
      node = { next: node };
    }
    return node;
  }

  it('INVARIANT: 10-level nesting is preserved', () => {
    const nest = makeNest(10);
    const round = rtState({ root: nest }) as { root: any };
    let cur = round.root;
    for (let i = 0; i < 10; i++) {
      assert.ok(cur.next !== undefined, `level ${i} must have next`);
      cur = cur.next;
    }
    assert.equal(cur.leaf, true);
  });

  it('INVARIANT: 50-level nesting still preserved', () => {
    const nest = makeNest(50);
    const round = rtState({ root: nest }) as { root: any };
    let cur = round.root;
    for (let i = 0; i < 50; i++) {
      cur = cur.next;
    }
    assert.equal(cur.leaf, true);
  });

  it('INVARIANT: 1000-level nesting survives OR fails cleanly — no silent corruption', () => {
    // The node default call-stack can handle ~10k pure function frames.
    // 1000 deep is comfortably within budget; if it ever fails it should
    // throw a RangeError, not silently emit a wrong structure.
    const nest = makeNest(1000);
    let round: any;
    try {
      round = rtState({ root: nest });
    } catch (e) {
      // If it throws, pin that it's a RangeError (no silent corruption).
      assert.ok(
        e instanceof RangeError || /call stack/i.test((e as Error).message),
        'deep nesting failure must be a stack-overflow, not a wrong result',
      );
      return;
    }
    // If it succeeded, the structure must be intact.
    let cur: any = round.root;
    for (let i = 0; i < 1000; i++) {
      cur = cur.next;
    }
    assert.equal(cur.leaf, true);
  });
});

describe('Nested structures — mixed builtins deep inside objects', () => {
  it('INVARIANT: Map inside Object inside Array preserves the innermost type', () => {
    const vars = {
      list: [
        { inner: new Map<string, Set<number>>([['s', new Set([1, 2, 3])]]) },
      ],
    };
    const round = rtState(vars) as { list: { inner: Map<string, Set<number>> }[] };
    const m = round.list[0].inner;
    assert.ok(m instanceof Map);
    const s = m.get('s');
    assert.ok(s instanceof Set);
    assert.deepEqual([...s!], [1, 2, 3]);
  });

  it('INVARIANT: Date nested 5 levels deep still round-trips as Date', () => {
    const d = new Date('2025-09-09T09:09:09.009Z');
    const vars = { a: { b: { c: { d: { e: d } } } } };
    const round = rtState(vars) as any;
    assert.ok(round.a.b.c.d.e instanceof Date);
    assert.equal(round.a.b.c.d.e.getTime(), d.getTime());
  });

  it('INVARIANT: Set of Maps of Dates preserves all three levels of types', () => {
    const d1 = new Date('2025-01-01');
    const d2 = new Date('2025-02-01');
    const m = new Map<string, Date>([
      ['a', d1],
      ['b', d2],
    ]);
    const s = new Set([m]);
    const round = rtState({ data: s }) as { data: Set<Map<string, Date>> };
    assert.ok(round.data instanceof Set);
    const firstMap = [...round.data][0];
    assert.ok(firstMap instanceof Map);
    assert.ok(firstMap.get('a') instanceof Date);
    assert.equal(firstMap.get('a')!.getTime(), d1.getTime());
    assert.equal(firstMap.get('b')!.getTime(), d2.getTime());
  });
});

describe('Array edge cases', () => {
  it('INVARIANT: array with mixed primitives + Dates round-trips', () => {
    const arr = [1, 'x', true, null, new Date(0), 42n];
    const round = rtState({ arr }) as { arr: unknown[] };
    assert.equal(round.arr[0], 1);
    assert.equal(round.arr[1], 'x');
    assert.equal(round.arr[2], true);
    assert.equal(round.arr[3], null);
    assert.ok(round.arr[4] instanceof Date);
    assert.equal(round.arr[5], 42n);
  });

  it('INVARIANT: empty array round-trips as empty array', () => {
    const round = rtState({ arr: [] }) as { arr: unknown[] };
    assert.ok(Array.isArray(round.arr));
    assert.equal(round.arr.length, 0);
  });

  it('INVARIANT: array-of-arrays preserves shape', () => {
    const arr = [[1, 2], [3, 4], [5, 6]];
    const round = rtState({ arr }) as { arr: number[][] };
    assert.deepEqual(round.arr, arr);
  });

  it('todo: sparse arrays lose holes — JSON.stringify converts holes to null; pin current limit', () => {
    const sparse: unknown[] = [];
    sparse[0] = 'a';
    sparse[2] = 'c'; // index 1 is a hole
    const round = rtState({ sparse }) as { sparse: unknown[] };
    assert.equal(round.sparse[0], 'a');
    // Hole → null after JSON round-trip. Pin this explicitly.
    assert.equal(round.sparse[1], null);
    assert.equal(round.sparse[2], 'c');
  });
});

describe('Object key edge cases', () => {
  it('INVARIANT: keys with special characters are preserved literally', () => {
    const vars = { 'weird.key/with spaces': 'v1', '__$type': 'user-value' };
    // Note: the serializer has to pass through __$type as user data when
    // it's a primitive string value (not a tag).
    const round = rtState({ wrap: vars }) as { wrap: Record<string, string> };
    assert.equal(round.wrap['weird.key/with spaces'], 'v1');
  });

  it('INVARIANT: numeric-string keys round-trip', () => {
    const vars = { '123': 'one-two-three', '456': 'four-five-six' };
    const round = rtState({ wrap: vars }) as { wrap: Record<string, string> };
    assert.equal(round.wrap['123'], 'one-two-three');
    assert.equal(round.wrap['456'], 'four-five-six');
  });
});
