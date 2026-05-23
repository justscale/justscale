import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  defineModel,
  field,
  Reference,
  References,
  isReference,
  isReferences,
  SET_RESOLVER,
  HYDRATE,
  TransientRef,
  isTransientRef,
  PERSISTENT,
  ADAPTER_KEY,
} from '../index.js';

// ----------------------------------------------------------------------------
// Reference — basic identity, toString, isLoaded, value
// ----------------------------------------------------------------------------

describe('Reference — basic API', () => {
  test('exposes the identifier', () => {
    const r = new Reference<unknown>('abc');
    assert.equal(r.identifier, 'abc');
  });

  test('stores and exposes an optional model name', () => {
    const r = new Reference<unknown>('abc', 'User');
    assert.equal(r.modelName, 'User');
  });

  test('modelName is undefined when not supplied', () => {
    const r = new Reference<unknown>('abc');
    assert.equal(r.modelName, undefined);
  });

  test('toString returns the identifier', () => {
    const r = new Reference<unknown>('abc');
    assert.equal(String(r), 'abc');
    assert.equal(`${r}`, 'abc');
    assert.equal(r.toString(), 'abc');
  });

  test('isLoaded is false before hydration and resolve', () => {
    const r = new Reference<unknown>('abc');
    assert.equal(r.isLoaded, false);
  });

  test('value throws before hydration', () => {
    const r = new Reference<unknown>('abc');
    assert.throws(() => r.value, /Reference not loaded/);
  });

  test('valueOrNull is null before hydration', () => {
    const r = new Reference<unknown>('abc');
    assert.equal(r.valueOrNull, null);
  });

  test('HYDRATE makes isLoaded true and value accessible', () => {
    const r = new Reference<{ name: string }>('abc');
    r[HYDRATE]({ name: 'alice', [PERSISTENT]: true } as any);
    assert.equal(r.isLoaded, true);
    assert.equal((r.value as any).name, 'alice');
    assert.notEqual(r.valueOrNull, null);
  });

  test('isReference type guard', () => {
    const r = new Reference<unknown>('abc');
    assert.equal(isReference(r), true);
    assert.equal(isReference(null), false);
    assert.equal(isReference(undefined), false);
    assert.equal(isReference('abc'), false);
    assert.equal(isReference({ identifier: 'abc' }), false);
  });
});

// ----------------------------------------------------------------------------
// Reference — identity semantics
// ----------------------------------------------------------------------------

describe('Reference identity', () => {
  test('two Reference instances for the same id via constructor are distinct (no global cache)', () => {
    const a = new Reference<unknown>('same');
    const b = new Reference<unknown>('same');
    assert.notEqual(a, b, 'Raw ctor does not memoize');
    assert.equal(a.identifier, b.identifier);
  });

  test('Model.ref memoizes same-id refs so === works', () => {
    const M = defineModel({ fields: { x: field.string() } });
    assert.equal(M.ref('id'), M.ref('id'));
  });

  test('rebuilding a Reference from its identifier round-trips via Model.ref', () => {
    const M = defineModel({ fields: { x: field.string() } });
    const a = M.ref('round-trip-id');
    const wire = a.identifier;
    const b = M.ref(wire);
    assert.equal(a, b);
  });
});

// ----------------------------------------------------------------------------
// Reference — awaiting and resolver
// ----------------------------------------------------------------------------

describe('Reference — PromiseLike behaviour', () => {
  test('await on a hydrated ref returns the value synchronously (via Promise.resolve)', async () => {
    const r = new Reference<{ name: string }>('abc');
    r[HYDRATE]({ name: 'alice', [PERSISTENT]: true } as any);
    const v = await r;
    assert.equal((v as any).name, 'alice');
  });

  test('await without resolver and without hydration rejects', async () => {
    const r = new Reference<unknown>('abc');
    await assert.rejects(async () => { await r; }, /Reference has no resolver/);
  });

  test('SET_RESOLVER allows awaiting', async () => {
    const r = new Reference<{ name: string }>('abc');
    r[SET_RESOLVER](async (id: string) => ({ name: `n-${id}`, [PERSISTENT]: true } as any));
    const v = await r;
    assert.equal((v as any).name, 'n-abc');
  });

  test('resolve() caches the resolved value', async () => {
    let calls = 0;
    const r = new Reference<{ name: string }>('abc');
    r[SET_RESOLVER](async (id: string) => {
      calls++;
      return { name: `n-${id}`, [PERSISTENT]: true } as any;
    });
    await r.resolve();
    await r.resolve();
    await r;
    assert.equal(calls, 1, 'resolver called exactly once');
  });

  test('resolve() returns undefined when resolver returns null', async () => {
    const r = new Reference<unknown>('missing');
    r[SET_RESOLVER](async () => null);
    const v = await r.resolve();
    assert.equal(v, undefined);
    // Not-found: still not loaded
    assert.equal(r.isLoaded, false);
  });
});

describe('Reference.resolved factory', () => {
  test('creates an already-loaded reference', () => {
    const entity = { email: 'a@b', [PERSISTENT]: true } as any;
    const r = Reference.resolved('id-1', entity);
    assert.equal(r.identifier, 'id-1');
    assert.equal(r.isLoaded, true);
    assert.equal(r.value, entity);
  });

  test('awaiting the factory-produced ref resolves to the entity synchronously', async () => {
    const entity = { email: 'a@b', [PERSISTENT]: true } as any;
    const r = Reference.resolved('id-1', entity);
    const v = await r;
    assert.equal(v, entity);
  });
});

// ----------------------------------------------------------------------------
// References (plural)
// ----------------------------------------------------------------------------

describe('References — basic API', () => {
  test('length / identifiers', () => {
    const rs = new References<unknown>(['a', 'b', 'c']);
    assert.equal(rs.length, 3);
    assert.deepEqual([...rs.identifiers], ['a', 'b', 'c']);
  });

  test('empty References', () => {
    const rs = new References<unknown>([]);
    assert.equal(rs.length, 0);
    assert.deepEqual([...rs.identifiers], []);
  });

  test('values throws before load', () => {
    const rs = new References<unknown>(['a']);
    assert.throws(() => rs.values, /References not loaded/);
  });

  test('valuesOrNull is null before load', () => {
    const rs = new References<unknown>(['a']);
    assert.equal(rs.valuesOrNull, null);
  });

  test('isLoaded flips after HYDRATE', () => {
    const rs = new References<{ id: string }>(['a', 'b']);
    rs[HYDRATE]([{ id: 'a', [PERSISTENT]: true } as any, { id: 'b', [PERSISTENT]: true } as any]);
    assert.equal(rs.isLoaded, true);
    assert.equal(rs.values.length, 2);
  });

  test('isReferences type guard', () => {
    const rs = new References<unknown>([]);
    assert.equal(isReferences(rs), true);
    assert.equal(isReferences(null), false);
    assert.equal(isReferences([]), false);
    assert.equal(isReferences(new Reference<unknown>('x')), false);
  });
});

describe('References — awaiting and resolution', () => {
  test('await on hydrated refs returns the values', async () => {
    const rs = new References<{ id: string }>(['a']);
    const entity = { id: 'a', [PERSISTENT]: true } as any;
    rs[HYDRATE]([entity]);
    const v = await rs;
    assert.deepEqual(v, [entity]);
  });

  test('await without resolver rejects', async () => {
    const rs = new References<unknown>(['a']);
    await assert.rejects(async () => { await rs; }, /References have no resolver/);
  });

  test('resolveAll preserves order per the original id list', async () => {
    const rs = new References<{ id: string }>(['c', 'a', 'b']);
    const store: Record<string, any> = {
      a: { id: 'a', [PERSISTENT]: true },
      b: { id: 'b', [PERSISTENT]: true },
      c: { id: 'c', [PERSISTENT]: true },
    };
    rs[SET_RESOLVER](async (id: string) => store[id] ?? null);
    const v = await rs.resolveAll();
    assert.deepEqual(v.map((e) => e.id), ['c', 'a', 'b']);
  });

  test('resolveAll skips nulls returned by the resolver', async () => {
    const rs = new References<{ id: string }>(['a', 'missing', 'b']);
    const store: Record<string, any> = {
      a: { id: 'a', [PERSISTENT]: true },
      b: { id: 'b', [PERSISTENT]: true },
    };
    rs[SET_RESOLVER](async (id: string) => store[id] ?? null);
    const v = await rs.resolveAll();
    assert.deepEqual(v.map((e) => e.id), ['a', 'b']);
  });

  // Batch-resolver path is a separate code branch (reference.ts:378-392)
  // from the single-resolver path. Pin its behavior matches the single
  // path's contract: order preserved, nulls filtered, length may shrink.
  // Callers expecting 1:1 input-to-output mapping must NOT rely on
  // result.length === ids.length.

  test('batch resolveAll preserves order per the original id list', async () => {
    const rs = new References<{ id: string }>(['c', 'a', 'b']);
    const store: Record<string, any> = {
      a: { id: 'a', [PERSISTENT]: true },
      b: { id: 'b', [PERSISTENT]: true },
      c: { id: 'c', [PERSISTENT]: true },
    };
    rs[SET_RESOLVER](async (id: string) => store[id] ?? null);
    rs.setBatchResolver(async (ids: string[]) => {
      const m = new Map<string, any>();
      for (const id of ids) {
        if (store[id]) m.set(id, store[id]);
      }
      return m;
    });
    const v = await rs.resolveAll();
    assert.deepEqual(v.map((e) => e.id), ['c', 'a', 'b']);
  });

  test('batch resolveAll skips nulls (same contract as single resolver)', async () => {
    const rs = new References<{ id: string }>(['a', 'missing', 'b']);
    const store: Record<string, any> = {
      a: { id: 'a', [PERSISTENT]: true },
      b: { id: 'b', [PERSISTENT]: true },
    };
    rs[SET_RESOLVER](async (id: string) => store[id] ?? null);
    rs.setBatchResolver(async (ids: string[]) => {
      const m = new Map<string, any>();
      for (const id of ids) {
        if (store[id]) m.set(id, store[id]);
        else m.set(id, null);
      }
      return m;
    });
    const v = await rs.resolveAll();
    assert.deepEqual(v.map((e) => e.id), ['a', 'b']);
    // CONTRACT: result.length is < ids.length when any are missing.
    // Callers expecting 1:1 must check or use a different API.
    assert.strictEqual(v.length, 2, 'length is filtered, not 1:1 with input');
  });

  test('batch resolveAll: missing key in result map (undefined) treated same as null', async () => {
    // The batch resolver might return a Map that simply omits missing
    // keys (vs explicitly mapping to null). Both must be filtered.
    const rs = new References<{ id: string }>(['a', 'gone', 'b']);
    rs[SET_RESOLVER](async () => null); // unused
    rs.setBatchResolver(async (_ids: string[]) => {
      const m = new Map<string, any>();
      m.set('a', { id: 'a', [PERSISTENT]: true });
      // 'gone' is omitted entirely (not even set to null).
      m.set('b', { id: 'b', [PERSISTENT]: true });
      return m;
    });
    const v = await rs.resolveAll();
    assert.deepEqual(v.map((e) => e.id), ['a', 'b']);
  });

  test('batch resolveAll: all-null result returns empty array, not error', async () => {
    const rs = new References<{ id: string }>(['x', 'y', 'z']);
    rs[SET_RESOLVER](async () => null);
    rs.setBatchResolver(async () => new Map());
    const v = await rs.resolveAll();
    assert.deepEqual(v, []);
  });

  test('resolveAll caches after the first call', async () => {
    let calls = 0;
    const rs = new References<{ id: string }>(['a']);
    rs[SET_RESOLVER](async (id: string) => {
      calls++;
      return { id, [PERSISTENT]: true } as any;
    });
    await rs.resolveAll();
    await rs.resolveAll();
    assert.equal(calls, 1);
  });

  test('batch resolver takes precedence when set', async () => {
    let singleCalls = 0;
    let batchCalls = 0;
    const rs = new References<{ id: string }>(['a', 'b']);
    rs[SET_RESOLVER](async (id: string) => {
      singleCalls++;
      return { id, [PERSISTENT]: true } as any;
    });
    rs.setBatchResolver(async (ids: string[]) => {
      batchCalls++;
      const out = new Map<string, any>();
      for (const id of ids) out.set(id, { id, [PERSISTENT]: true });
      return out;
    });
    const v = await rs.resolveAll();
    assert.equal(v.length, 2);
    assert.equal(batchCalls, 1);
    assert.equal(singleCalls, 0);
  });

  test('batch resolver — entries mapped to null are skipped', async () => {
    const rs = new References<{ id: string }>(['a', 'missing', 'b']);
    rs[SET_RESOLVER](async () => null);
    rs.setBatchResolver(async (ids: string[]) => {
      const m = new Map<string, any>();
      m.set('a', { id: 'a', [PERSISTENT]: true });
      m.set('missing', null);
      m.set('b', { id: 'b', [PERSISTENT]: true });
      return m;
    });
    const v = await rs.resolveAll();
    assert.deepEqual(v.map((e) => e.id), ['a', 'b']);
  });
});

describe('References.resolved factory', () => {
  test('creates pre-loaded References', async () => {
    const entities = [
      { id: 'a', [PERSISTENT]: true } as any,
      { id: 'b', [PERSISTENT]: true } as any,
    ];
    const rs = References.resolved(['a', 'b'], entities);
    assert.equal(rs.length, 2);
    assert.equal(rs.isLoaded, true);
    const v = await rs;
    assert.deepEqual(v, entities);
  });
});

// ----------------------------------------------------------------------------
// TransientRef
// ----------------------------------------------------------------------------

describe('TransientRef', () => {
  test('wraps a target entity, always loaded', () => {
    const t = new TransientRef({ x: 1 });
    assert.equal(t.isLoaded, true);
    assert.deepEqual(t.target, { x: 1 });
    assert.deepEqual(t.value, { x: 1 });
    assert.deepEqual(t.valueOrNull, { x: 1 });
  });

  test('isTransientRef type guard', () => {
    const t = new TransientRef({ x: 1 });
    assert.equal(isTransientRef(t), true);
    assert.equal(isTransientRef({}), false);
    assert.equal(isTransientRef(null), false);
  });

  test('await returns the wrapped target', async () => {
    const target = { name: 'alice' };
    const t = new TransientRef(target);
    const v = await t;
    assert.equal(v, target);
  });

  test('toReference throws if entity has no ADAPTER_KEY', () => {
    const t = new TransientRef({ name: 'alice' });
    assert.throws(() => t.toReference(), /no adapter key/);
  });

  test('canConvert returns false for un-persisted entity', () => {
    const t = new TransientRef({ name: 'alice' });
    assert.equal(t.canConvert(), false);
  });

  test('canConvert returns true once adapter key is set', () => {
    const entity: any = { name: 'alice', [ADAPTER_KEY]: 'uuid-1' };
    const t = new TransientRef(entity);
    assert.equal(t.canConvert(), true);
  });

  test('toReference creates a resolved Reference with the adapter key', () => {
    const entity: any = { name: 'alice', [ADAPTER_KEY]: 'uuid-1', [PERSISTENT]: true };
    const t = new TransientRef(entity);
    const r = t.toReference();
    assert.equal(r.identifier, 'uuid-1');
    assert.equal(r.isLoaded, true);
    assert.equal(r.value, entity);
  });

  test('canConvert also true when entity is PERSISTENT-marked (even without adapter key)', () => {
    const entity: any = { name: 'alice', [PERSISTENT]: true };
    const t = new TransientRef(entity);
    // canConvert uses `entity[ADAPTER_KEY] ?? entity[PERSISTENT]` — truthy on PERSISTENT.
    assert.equal(t.canConvert(), true);
  });
});

// ----------------------------------------------------------------------------
// Locked<T> vs Ref<T> vs Persistent<T> discrimination
// ----------------------------------------------------------------------------

describe('type discriminators (runtime guards)', () => {
  test('isReference distinguishes Reference from References and TransientRef', () => {
    const r = new Reference<unknown>('a');
    const rs = new References<unknown>(['a']);
    const t = new TransientRef({});
    assert.equal(isReference(r), true);
    assert.equal(isReference(rs), false);
    assert.equal(isReference(t), false);
  });

  test('isReferences distinguishes References from Reference and TransientRef', () => {
    const r = new Reference<unknown>('a');
    const rs = new References<unknown>(['a']);
    const t = new TransientRef({});
    assert.equal(isReferences(rs), true);
    assert.equal(isReferences(r), false);
    assert.equal(isReferences(t), false);
  });
});
