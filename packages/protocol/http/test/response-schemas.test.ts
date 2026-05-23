/**
 * Invariant tests: `.returns(status, schema)` - response schema declarations.
 *
 * Pins:
 *  - `.returns(200, S)` registers schema in route.responseSchemas, keyed by status
 *  - Multiple `.returns(...)` - all schemas are kept, indexed by status
 *  - Same status twice - last wins (Map.set overwrites)
 *  - `.returns(status)` (no schema) registers `null` - still present in map
 *  - DOCUMENTATION-ONLY: response schema is NOT enforced at runtime. The
 *    handler can send whatever it wants; `.returns()` feeds OpenAPI only.
 *    This is a conscious trade-off - pin it so regressions are obvious.
 *  - Missing `.returns(...)` - route.responseSchemas is empty; response still sent
 *  - Permission-scoped `.returns(status, schema, permission)` populates
 *    `route.permissionReturns` but unpermissioned `.returns(200, S)` does not
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import { executeRoute } from '@justscale/core';
import { Get } from '../src/builder/create-http-builder.js';

function mockRes() {
  const res: any = {
    _responded: null as null | { status: number; body: unknown },
    status(code: number) {
      return {
        json(data: unknown) { res._responded = { status: code, body: data }; },
        end() { res._responded = { status: code, body: undefined }; },
      };
    },
    json(data: unknown) { res._responded = { status: 200, body: data }; },
    error(msg: string, code = 400) { res._responded = { status: code, body: { error: msg } }; },
  };
  return res;
}

describe('.returns() response schemas', () => {
  it('single returns(status, schema) registers in responseSchemas map', () => {
    const schema = z.object({ ok: z.boolean() });
    const route = Get('/x').returns(200, schema).handle(() => {});
    assert.strictEqual(route.responseSchemas.get(200), schema);
  });

  it('multiple returns() - all distinct statuses preserved', () => {
    const A = z.object({ a: z.string() });
    const B = z.object({ b: z.number() });
    const route = Get('/x')
      .returns(200, A)
      .returns(404, B)
      .returns(500)
      .handle(() => {});
    assert.strictEqual(route.responseSchemas.size, 3);
    assert.strictEqual(route.responseSchemas.get(200), A);
    assert.strictEqual(route.responseSchemas.get(404), B);
    assert.strictEqual(route.responseSchemas.get(500), null);
  });

  it('same-status .returns() twice - last one wins (Map overwrite)', () => {
    const A = z.object({ a: z.string() });
    const B = z.object({ a: z.number() });
    const route = Get('/x')
      .returns(200, A)
      .returns(200, B)
      .handle(() => {});
    assert.strictEqual(route.responseSchemas.size, 1);
    assert.strictEqual(route.responseSchemas.get(200), B);
  });

  it('.returns(status) without schema stores null (not missing)', () => {
    const route = Get('/x').returns(204).handle(() => {});
    assert.strictEqual(route.responseSchemas.has(204), true);
    assert.strictEqual(route.responseSchemas.get(204), null);
  });

  it('no .returns() calls - responseSchemas is empty map', () => {
    const route = Get('/x').handle(() => {});
    assert.strictEqual(route.responseSchemas.size, 0);
  });

  it('RUNTIME NOT ENFORCED: handler returning wrong shape is accepted silently', async () => {
    // Pin the core trade-off: `.returns()` declares, it does NOT gate.
    // If this ever changes (runtime validation), flip this test to expect
    // a thrown error or 500.
    const res = mockRes();
    const route = Get('/x')
      .returns(200, z.object({ expected: z.string() }))
      .handle((ctx: any) => {
        // Wildly wrong shape - framework does NOT notice.
        ctx.res.json({ totally: 'different' });
      });

    await executeRoute(route, { res });
    assert.deepStrictEqual(res._responded, {
      status: 200,
      body: { totally: 'different' },
    });
  });

  it('RUNTIME NOT ENFORCED: handler sending undeclared status code is accepted', async () => {
    const res = mockRes();
    const route = Get('/x')
      .returns(200, z.object({ ok: z.boolean() }))
      .handle((ctx: any) => {
        ctx.res.status(418).json({ teapot: true });
      });

    await executeRoute(route, { res });
    assert.strictEqual(res._responded!.status, 418);
  });

  it('permission-scoped .returns() populates permissionReturns', () => {
    const admin = { name: 'admin' as const };
    const schema = z.object({ secret: z.string() });
    const route = Get('/x')
      .returns(200, schema, admin)
      .handle(() => {});
    assert.ok(route.permissionReturns);
    assert.strictEqual(route.permissionReturns!.length, 1);
    assert.strictEqual(route.permissionReturns![0].permission.name, 'admin');
  });

  it('unpermissioned .returns() does NOT populate permissionReturns', () => {
    const route = Get('/x')
      .returns(200, z.object({ ok: z.boolean() }))
      .handle(() => {});
    assert.strictEqual(route.permissionReturns, undefined);
  });

  it('mixed permission + unpermissioned: only permissioned entries in permissionReturns', () => {
    const admin = { name: 'admin' as const };
    const route = Get('/x')
      .returns(200, z.object({ a: z.string() }), admin)
      .returns(404, z.object({ err: z.string() }))
      .handle(() => {});
    assert.strictEqual(route.permissionReturns!.length, 1);
    assert.strictEqual(route.permissionReturns![0].status, 200);
    // But responseSchemas still has both.
    assert.strictEqual(route.responseSchemas.size, 2);
  });

  it('.returns() does not add executable steps', () => {
    const route = Get('/x')
      .returns(200, z.object({ ok: z.boolean() }))
      .returns(404)
      .handle(() => {});
    // .returns() is metadata only, not a step.
    assert.strictEqual(route.steps.length, 0);
  });
});
