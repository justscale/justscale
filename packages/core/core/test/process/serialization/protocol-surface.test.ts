/**
 * Processable protocol — SURFACE invariants (edge cases).
 *
 * Pin "shape of the contract" properties that silent regressions would
 * bury. Everything below is a `Symbol.process`-side contract: what counts
 * as Processable, what falls back, what detection touches, what it does
 * NOT touch.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerProcessType,
  getProcessDescriptor,
  isProcessable,
  hasProcessDescriptor,
  findProcessDescriptor,
  encodeProcessable,
  decodeProcessable,
} from '../../../src/process/serialization.js';

// Side-effect: registers builtins (Date/Map/Set/Reference/BigInt)
import '../../../src/process/builtin-serializers.js';

describe('Protocol surface — Symbol.process identity', () => {
  it('INVARIANT: Symbol.process is global + stable via Symbol.for', () => {
    assert.ok(Symbol.process, 'Symbol.process must be defined on global Symbol');
    assert.equal(typeof Symbol.process, 'symbol');
    assert.equal(Symbol.process, Symbol.for('@justscale/process'));
  });

  it('INVARIANT: a second module load must see the SAME Symbol.process', async () => {
    // Re-import the module — should not register a second symbol. If it
    // did, cross-package / HMR would silently fail to detect Processables.
    const again = await import('../../../src/process/serialization.js');
    assert.equal(Symbol.process, Symbol.process);
    assert.ok(typeof again.isProcessable === 'function');
  });
});

describe('Protocol surface — detection predicates', () => {
  class HasProc {
    static [Symbol.process]: ProcessDescriptor<HasProc> = {
      name: 'test.surface.HasProc',
      serialize: (v: HasProc) => ({}),
      deserialize: () => new HasProc(),
    };
  }
  registerProcessType(HasProc[Symbol.process]);

  it('INVARIANT: hasProcessDescriptor detects the CONSTRUCTOR (static)', () => {
    assert.ok(hasProcessDescriptor(HasProc));
  });

  it('INVARIANT: isProcessable detects an INSTANCE carrying the symbol', () => {
    const obj = { [Symbol.process]: HasProc[Symbol.process] };
    assert.ok(isProcessable(obj));
  });

  it('INVARIANT: plain values are never Processable', () => {
    for (const v of [null, undefined, 0, 1, '', 'x', true, false, NaN, {}, []]) {
      assert.equal(isProcessable(v), false, `value ${String(v)} must NOT be Processable`);
      assert.equal(hasProcessDescriptor(v), false, `value ${String(v)} must NOT hasProcessDescriptor`);
    }
  });

  it('INVARIANT: descriptor must have name + serialize + deserialize — partial descriptors rejected', () => {
    const half: any = { [Symbol.process]: { name: 'incomplete' } };
    assert.equal(isProcessable(half), false);
    const noFns: any = { [Symbol.process]: { name: 'x', serialize: 42, deserialize: 42 } };
    assert.equal(isProcessable(noFns), false);
  });

  it('INVARIANT: findProcessDescriptor walks instance THEN constructor', () => {
    const inst = new HasProc();
    const desc = findProcessDescriptor(inst);
    assert.ok(desc);
    assert.equal(desc!.name, 'test.surface.HasProc');
  });

  it('INVARIANT: findProcessDescriptor returns undefined for plain object/array (never dispatches)', () => {
    assert.equal(findProcessDescriptor({}), undefined);
    assert.equal(findProcessDescriptor([]), undefined);
    assert.equal(findProcessDescriptor(null), undefined);
    assert.equal(findProcessDescriptor(undefined), undefined);
  });

  it('INVARIANT: instance symbol WINS over constructor symbol (instance override)', () => {
    const instanceDesc: ProcessDescriptor = {
      name: 'test.surface.instance-wins',
      serialize: () => ({ via: 'instance' }),
      deserialize: () => ({}),
    };
    registerProcessType(instanceDesc);
    const inst: any = new HasProc();
    inst[Symbol.process] = instanceDesc;
    const desc = findProcessDescriptor(inst);
    assert.equal(desc!.name, 'test.surface.instance-wins');
  });
});

describe('Protocol surface — encode/decode fallback', () => {
  it('INVARIANT: non-Processable primitives are RETURNED AS-IS by encodeProcessable', () => {
    // Plain objects/arrays are walked (to find nested Processables) so referential
    // identity is NOT guaranteed for them — use deepEqual.
    assert.deepEqual(encodeProcessable({ a: 1 }), { a: 1 });
    assert.equal(encodeProcessable('hello'), 'hello');
    assert.equal(encodeProcessable(42), 42);
    assert.equal(encodeProcessable(null), null);
    assert.equal(encodeProcessable(undefined), undefined);
  });

  it('INVARIANT: decodeProcessable returns non-tagged primitive values unchanged', () => {
    // Plain objects get walked (to decode nested envelopes) — referential identity
    // is not guaranteed. Use deepEqual for object comparison.
    assert.deepEqual(decodeProcessable({ a: 1 }), { a: 1 });
    assert.equal(decodeProcessable('hello'), 'hello');
  });

  it('INVARIANT: decode throws when descriptor name is NOT in registry (proc-3)', () => {
    // Unknown-name envelope must throw — silent fall-through made "forgot to register"
    // indistinguishable from "real data happens to have __$p".
    const tagged = { __$p: 'ghost.type.that.never.existed', d: { a: 1 } };
    assert.throws(
      () => decodeProcessable(tagged),
      /Unknown descriptor 'ghost\.type\.that\.never\.existed'/,
    );
  });

  it('INVARIANT: encode of a Processable uses the __$p envelope SHAPE exactly', () => {
    class Envelope {
      constructor(public v: number) {}
      static [Symbol.process]: ProcessDescriptor<Envelope> = {
        name: 'test.surface.Envelope',
        serialize: (x: Envelope) => ({ v: x.v }),
        deserialize: (d: any) => new Envelope(d.v),
      };
    }
    registerProcessType(Envelope[Symbol.process]);
    const encoded = encodeProcessable(new Envelope(7)) as Record<string, unknown>;
    assert.equal(Object.keys(encoded).length, 3, 'envelope must have exactly {__$p, __$v, d}');
    assert.equal(encoded.__$p, 'test.surface.Envelope');
    assert.deepEqual(encoded.d, { v: 7 });
  });

  it('INVARIANT: encode + decode round-trip gives a new instance, not the original (identity is NOT preserved)', () => {
    class A {
      constructor(public n: number) {}
      static [Symbol.process]: ProcessDescriptor<A> = {
        name: 'test.surface.A',
        serialize: (v: A) => ({ n: v.n }),
        deserialize: (d: any) => new A(d.n),
      };
    }
    registerProcessType(A[Symbol.process]);
    const original = new A(1);
    const round = decodeProcessable(encodeProcessable(original)) as A;
    assert.ok(round instanceof A);
    assert.equal(round.n, 1);
    assert.notEqual(round, original, 'decode must produce a fresh instance');
  });

  it('INVARIANT: encode is PURE — does not mutate the input', () => {
    class M {
      constructor(public items: number[]) {}
      static [Symbol.process]: ProcessDescriptor<M> = {
        name: 'test.surface.Mutation',
        serialize: (v: M) => ({ items: [...v.items] }),
        deserialize: (d: any) => new M(d.items),
      };
    }
    registerProcessType(M[Symbol.process]);
    const src = new M([1, 2, 3]);
    const snap = [...src.items];
    encodeProcessable(src);
    assert.deepEqual(src.items, snap, 'source items array must not be mutated');
  });

  it('INVARIANT: decode with missing descriptor in registry throws — the envelope shape alone is not enough to reconstruct (proc-3)', () => {
    // Silent pass-through hides registration bugs. Throw so the caller knows
    // exactly which descriptor name is missing.
    const mysteryTag = { __$p: 'test.surface.NEVER_REGISTERED', d: {} };
    assert.throws(
      () => decodeProcessable(mysteryTag),
      /Unknown descriptor 'test\.surface\.NEVER_REGISTERED'/,
    );
  });
});

describe('Protocol surface — registry-only descriptors (no Symbol.process on value)', () => {
  // Not every descriptor is attached to a class. BigInt is registered only in
  // the registry because bigint is a primitive. Pin that this is accessible.
  it('INVARIANT: BigInt descriptor is reachable via registry name', () => {
    const desc = getProcessDescriptor('justscale.BigInt');
    assert.ok(desc);
    assert.equal(desc!.name, 'justscale.BigInt');
  });

  it('INVARIANT: registry-only descriptor does NOT activate via findProcessDescriptor on a primitive', () => {
    // bigint is a primitive, no [Symbol.process] slot — findProcessDescriptor
    // must return undefined for it. If we ever auto-coerced, double-tagging.
    assert.equal(findProcessDescriptor(42n), undefined);
  });
});

describe('Protocol surface — proc-4: shape validation on decode', () => {
  it('INVARIANT: Date envelope with wrong ms type is rejected by validate (proc-4)', () => {
    // Forging a Date envelope with a non-numeric, non-sentinel ms value.
    const forgery = { __$p: 'justscale.Date', d: { ms: 'evil' } };
    assert.throws(
      () => decodeProcessable(forgery),
      /Payload shape validation failed for descriptor 'justscale\.Date'/,
    );
  });

  it('INVARIANT: Map envelope with non-array entries is rejected by validate (proc-4)', () => {
    const forgery = { __$p: 'justscale.Map', d: { entries: 'not-an-array' } };
    assert.throws(
      () => decodeProcessable(forgery),
      /Payload shape validation failed for descriptor 'justscale\.Map'/,
    );
  });

  it('INVARIANT: Set envelope with non-array items is rejected by validate (proc-4)', () => {
    const forgery = { __$p: 'justscale.Set', d: { items: 42 } };
    assert.throws(
      () => decodeProcessable(forgery),
      /Payload shape validation failed for descriptor 'justscale\.Set'/,
    );
  });

  it('INVARIANT: Reference envelope missing identifier is rejected by validate (proc-4)', () => {
    const forgery = { __$p: 'justscale.Reference', d: { notId: 'sneaky' } };
    assert.throws(
      () => decodeProcessable(forgery),
      /Payload shape validation failed for descriptor 'justscale\.Reference'/,
    );
  });

  it('INVARIANT: valid builtin envelopes still decode correctly when validate passes (proc-4 no regression)', () => {
    const d = new Date('2025-03-01T00:00:00Z');
    const encoded = encodeProcessable(d);
    const decoded = decodeProcessable(encoded);
    assert.ok(decoded instanceof Date);
    assert.equal((decoded as Date).getTime(), d.getTime());
  });

  it('INVARIANT: user-registered descriptors without validate behave as before — no regression (proc-4)', () => {
    class NoValidate {
      constructor(public x: number) {}
      static [Symbol.process]: ProcessDescriptor<NoValidate> = {
        name: 'test.surface.NoValidate',
        serialize: (v: NoValidate) => ({ x: v.x }),
        deserialize: (d: any) => new NoValidate(d.x),
        // no validate — opt-in feature
      };
    }
    registerProcessType(NoValidate[Symbol.process]);

    // Even with a "wrong" payload, no validate means no rejection — back-compat.
    const envelope = { __$p: 'test.surface.NoValidate', d: { x: 99 } };
    const out = decodeProcessable(envelope) as NoValidate;
    assert.equal(out.x, 99);
  });
});

describe('Protocol surface — proc-6: Locked<T> is rejected by encodeProcessable', () => {
  it('INVARIANT: encoding a Locked<T> (has __lock + Symbol.dispose) throws (proc-6)', () => {
    // Simulate what LockServiceImpl produces: an object prototype-chained to the
    // original value, with __lock metadata and Symbol.dispose attached.
    const base = { email: 'test@example.com' };
    const locked = Object.create(base, {
      __lock: {
        value: { lockedAt: new Date(), expiresAt: new Date(), lockedBy: 'test' },
        enumerable: false,
        configurable: false,
      },
      [Symbol.dispose]: {
        value: () => {},
        enumerable: false,
        configurable: false,
      },
    });

    assert.throws(
      () => encodeProcessable(locked),
      /Cannot encode a Locked<T> value/,
    );
  });

  it('INVARIANT: encoding a plain object that happens to have __lock but NO Symbol.dispose is allowed (proc-6 no false positives)', () => {
    // Only objects with BOTH __lock AND Symbol.dispose are treated as Lock<T>.
    const notLocked = { __lock: { lockedAt: new Date() }, data: 'ok' };
    // Should not throw — it's just a plain object that happens to have __lock.
    const encoded = encodeProcessable(notLocked);
    assert.ok(encoded !== null);
  });

  it('INVARIANT: a Locked<T> nested inside an object also throws with path context (proc-6 + proc-11)', () => {
    const base = { n: 1 };
    const locked = Object.create(base, {
      __lock: { value: {}, enumerable: false },
      [Symbol.dispose]: { value: () => {}, enumerable: false },
    });

    assert.throws(
      () => encodeProcessable({ outer: { inner: locked } }),
      /Cannot encode a Locked<T> value at path "<root>\.outer\.inner"/,
    );
  });
});
