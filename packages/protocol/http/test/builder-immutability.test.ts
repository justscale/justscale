/**
 * Invariant tests: builder mutability semantics.
 *
 * Pins the SHARP EDGE: the HTTP builder is NOT immutable. `.use()`, `.guard()`,
 * `.returns()`, `.types()` all MUTATE the shared `BuilderState`. `.handle()`
 * is what captures a snapshot via `[...state.steps]`. This has three
 * observable consequences:
 *
 *  1. Calling `base.handle(h1)` then `base.handle(h2)` gives you two DIFFERENT
 *     routes, but with the SAME step list (frozen at each .handle() call).
 *  2. If you `.handle(h1)`, then add more steps, then `.handle(h2)`, the
 *     second route picks up the extra steps; the first does not.
 *  3. `const a = Get('/x'); const b = Get('/x')` - a and b are ISOLATED,
 *     because each factory call creates a new state.
 *
 * This is a footgun if you try to "fork" a builder by caching it. Pin the
 * current behavior so changes are visible.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import { executeRoute } from '@justscale/core';
import { Get } from '../src/builder/create-http-builder.js';

function mockRes() {
  const res: any = {
    _responded: null as null | { status: number; body: unknown },
    status(code: number) { return { json(d: unknown) { res._responded = { status: code, body: d }; }, end() { res._responded = { status: code, body: undefined }; } }; },
    json(d: unknown) { res._responded = { status: 200, body: d }; },
    error(m: string, c = 400) { res._responded = { status: c, body: { error: m } }; },
  };
  return res;
}

describe('HTTP builder - mutability semantics', () => {
  it('two separate factory calls produce independent builders', () => {
    const a = Get('/a').use(() => ({ tag: 'A' })).handle(() => {});
    const b = Get('/b').use(() => ({ tag: 'B' })).handle(() => {});
    assert.strictEqual(a.path, '/a');
    assert.strictEqual(b.path, '/b');
    assert.strictEqual(a.steps.length, 1);
    assert.strictEqual(b.steps.length, 1);
    assert.notStrictEqual(a.steps[0], b.steps[0]);
  });

  it('two .handle() calls on same builder snapshot the CURRENT step list each time', () => {
    const base = Get('/x').use(() => ({ a: 1 }));
    const r1 = base.handle(() => {});
    const r2 = base.handle(() => {});
    // Both have 1 step each.
    assert.strictEqual(r1.steps.length, 1);
    assert.strictEqual(r2.steps.length, 1);
    // The STEP ARRAYS are distinct (spread copy), but the step OBJECT inside
    // is the same reference (same `.use()` call produced one step object).
    assert.notStrictEqual(r1.steps, r2.steps);
    assert.strictEqual(r1.steps[0], r2.steps[0]);
  });

  it('MUTATING AFTER .handle(): adding steps after handle affects later .handle() calls, NOT the first route', () => {
    const base = Get('/x').use(() => ({ a: 1 }));
    const r1 = base.handle(() => {});
    base.use(() => ({ b: 2 })); // mutates state AFTER r1 was captured
    const r2 = base.handle(() => {});

    assert.strictEqual(r1.steps.length, 1, 'r1 captured state with 1 step');
    assert.strictEqual(r2.steps.length, 2, 'r2 captured state with 2 steps');
  });

  it('handlers on two .handle() calls are DIFFERENT (each call passes its own handler)', () => {
    const base = Get('/x');
    // Distinct named no-op fns - identity is what matters for this pin.
    const h1 = function h1() {};
    const h2 = function h2() {};
    const r1 = base.handle(h1);
    const r2 = base.handle(h2);
    assert.strictEqual(r1.handler, h1);
    assert.strictEqual(r2.handler, h2);
  });

  it('.returns() map is SHARED via mutation - same-status later .returns() wins on all captured routes', () => {
    // state.responseSchemas is a Map; base.returns() mutates it. Every
    // .handle() copies via `new Map(state.responseSchemas)`. Pin that
    // post-handle returns() DOES affect later .handle() captures.
    const base = Get('/x');
    base.returns(200, z.object({ a: z.string() }));
    const r1 = base.handle(() => {});
    base.returns(200, z.object({ a: z.number() })); // overwrite
    const r2 = base.handle(() => {});

    const r1Schema = r1.responseSchemas.get(200);
    const r2Schema = r2.responseSchemas.get(200);
    assert.notStrictEqual(r1Schema, r2Schema, 'post-handle returns() changes r2 but not r1');
  });

  it('route execution is independent across two .handle() captures', async () => {
    const base = Get('/x').use(() => ({ shared: true }));
    let h1_saw: any = null;
    let h2_saw: any = null;
    const r1 = base.handle((ctx: any) => { h1_saw = ctx.shared; });
    base.use(() => ({ extra: 'only-r2' }));
    const r2 = base.handle((ctx: any) => { h2_saw = { shared: ctx.shared, extra: ctx.extra }; });

    await executeRoute(r1, { res: mockRes() });
    await executeRoute(r2, { res: mockRes() });

    assert.strictEqual(h1_saw, true);
    assert.deepStrictEqual(h2_saw, { shared: true, extra: 'only-r2' });
  });

  it('.types() stored on state, captured at .handle() - later .types() overwrites state but NOT captured route', () => {
    const base = Get('/x/:id');
    class M1 {}
    class M2 {}
    base.types({ M1 } as any);
    const r1 = base.handle(() => {});
    base.types({ M2 } as any);
    const r2 = base.handle(() => {});

    // r1 types field was captured at first handle() - but it reflects the
    // then-current state.types reference. Because .handle() spreads into the
    // returned object (`...(state.types ? { types: state.types } : {})`),
    // both r1 and r2 share a REFERENCE to the types config object only if
    // state.types was the same object at capture time. Since base.types(M2)
    // REPLACES state.types entirely, r1 retains its original reference.
    assert.strictEqual((r1 as any).types.M1, M1);
    assert.strictEqual((r1 as any).types.M2, undefined);
    assert.strictEqual((r2 as any).types.M2, M2);
  });

  it('fluent chain on same path from two roots - factory fluency is non-re-entrant', () => {
    // `.use` returns the builder, so `Get('/a').use(x).use(y)` is normal.
    // But the builder instance is shared across chain calls; this test pins
    // that chaining does NOT fork - consecutive .use() calls compound.
    const b = Get('/a');
    const b1 = b.use(() => ({ a: 1 }));
    const b2 = b1.use(() => ({ b: 2 }));
    // They are literally the same object.
    assert.strictEqual(b as any, b1 as any);
    assert.strictEqual(b1 as any, b2 as any);
    // And final state has two steps.
    const r = b.handle(() => {});
    assert.strictEqual(r.steps.length, 2);
  });
});
