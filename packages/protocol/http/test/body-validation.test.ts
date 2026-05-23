/**
 * Invariant tests: `.body(schema)` / `body()` plugin.
 *
 * Pins:
 *  - Invalid body -> 400 with `{ errors: <zod fieldErrors> }` shape
 *  - Missing required field -> error keyed by field name
 *  - Empty body on required-body route -> 400 (not 500)
 *  - Nested zod errors still appear in fieldErrors
 *  - Handler does NOT run when body is invalid
 *  - Body schema registers a 400 response schema (OpenAPI contract)
 *  - `.body()` == `.apply(body(schema))` - shorthand produces same steps
 *  - Only ONE body() call per route - second call replaces first's context key
 *    (actually: both run as separate guards/use - pin current behavior)
 *  - Coerce schemas (z.coerce.number) work on incoming string values
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import { executeRoute } from '@justscale/core';
import { Post } from '../src/builder/create-http-builder.js';
import { ValidationErrorSchema } from '../src/builder/plugins/body.js';

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

describe('HTTP body validation', () => {
  it('valid body passes and is exposed as ctx.body', async () => {
    let handler_saw: any = null;
    const route = Post('/x')
      .body(z.object({ name: z.string(), age: z.number() }))
      .handle((ctx: any) => { handler_saw = ctx.body; });

    await executeRoute(route, {
      rawBody: { name: 'alice', age: 30 },
      res: mockRes(),
    });
    assert.deepStrictEqual(handler_saw, { name: 'alice', age: 30 });
  });

  it('invalid body -> 400 with errors keyed by field name', async () => {
    let handler_ran = false;
    const res = mockRes();
    const route = Post('/x')
      .body(z.object({ name: z.string(), email: z.string().email() }))
      .handle(() => { handler_ran = true; });

    await executeRoute(route, { rawBody: { name: 123, email: 'not-an-email' }, res });
    assert.strictEqual(handler_ran, false);
    assert.strictEqual(res._responded!.status, 400);
    const body = res._responded!.body as any;
    assert.ok(body.errors, 'body should have errors key');
    // At least one of the failed fields is named.
    assert.ok(body.errors.name || body.errors.email);
  });

  it('missing required field -> 400 with that field in errors', async () => {
    const res = mockRes();
    const route = Post('/x')
      .body(z.object({ required_thing: z.string() }))
      .handle(() => {});

    await executeRoute(route, { rawBody: {}, res });
    assert.strictEqual(res._responded!.status, 400);
    const errors = (res._responded!.body as any).errors;
    assert.ok(errors.required_thing, 'missing field should appear in fieldErrors');
  });

  it('empty body ({}) on required-body route -> 400 (not 500)', async () => {
    // This pins that a missing body does NOT crash with a zod internal error
    // or pass through. The HTTP server sends `{}` for an empty body on
    // non-multipart requests; this must resolve to a clean 400.
    const res = mockRes();
    const route = Post('/x')
      .body(z.object({ x: z.string() }))
      .handle(() => {});

    await executeRoute(route, { rawBody: {}, res });
    assert.strictEqual(res._responded!.status, 400);
  });

  it('nested schema - fieldErrors are flattened (zod .flatten() behavior)', async () => {
    // zod .flatten().fieldErrors only returns top-level field errors.
    // Nested errors are attached to the top-level field. Pin that shape.
    const res = mockRes();
    const route = Post('/x')
      .body(z.object({ user: z.object({ email: z.string().email() }) }))
      .handle(() => {});

    await executeRoute(route, { rawBody: { user: { email: 'bad' } }, res });
    assert.strictEqual(res._responded!.status, 400);
    const errors = (res._responded!.body as any).errors;
    assert.ok(errors.user, 'top-level `user` key gets the nested error');
  });

  it('.body() registers 400 response schema (ValidationErrorSchema)', () => {
    const route = Post('/x')
      .body(z.object({ x: z.string() }))
      .handle(() => {});
    assert.strictEqual(route.responseSchemas.get(400), ValidationErrorSchema);
  });

  it('z.coerce - body coerces strings to numbers', async () => {
    let handler_saw: any = null;
    const route = Post('/x')
      .body(z.object({ age: z.coerce.number() }))
      .handle((ctx: any) => { handler_saw = ctx.body; });

    await executeRoute(route, { rawBody: { age: '42' }, res: mockRes() });
    assert.strictEqual(handler_saw.age, 42);
    assert.strictEqual(typeof handler_saw.age, 'number');
  });

  it('.body() adds exactly 2 steps - a guard + a use (plugin internal)', () => {
    const route = Post('/x')
      .body(z.object({ x: z.string() }))
      .handle(() => {});
    assert.strictEqual(route.steps.length, 2);
    assert.strictEqual(route.steps[0].type, 'guard');
    assert.strictEqual(route.steps[1].type, 'use');
  });

  it('handler sees ctx.body, not ctx.rawBody mutated', async () => {
    // Plugin exposes `body: result.data`, NOT in-place mutation of rawBody.
    let seen: any = null;
    const route = Post('/x')
      .body(z.object({ a: z.string() }))
      .handle((ctx: any) => { seen = { body: ctx.body, rawBody: ctx.rawBody }; });

    await executeRoute(route, { rawBody: { a: 'hello' }, res: mockRes() });
    assert.strictEqual(seen.body.a, 'hello');
    // rawBody remains the original object.
    assert.deepStrictEqual(seen.rawBody, { a: 'hello' });
  });

  it('two .body() calls back-to-back: second validation runs, second wins in ctx.body', async () => {
    // Pin current behavior: both plugins run in order, each is an independent
    // guard+use pair. Second body() overwrites ctx.body (Object.assign merge
    // replaces same key). If the first validates and the second fails, second
    // wins (handler sees 400).
    const res = mockRes();
    const route = Post('/x')
      .body(z.object({ a: z.string() }))
      .body(z.object({ b: z.number() }))
      .handle(() => {});

    await executeRoute(route, { rawBody: { a: 'ok' /* no b */ }, res });
    // Second validation fails - 400.
    assert.strictEqual(res._responded!.status, 400);
    const errors = (res._responded!.body as any).errors;
    assert.ok(errors.b);
  });

  it('body validation is a GUARD (not a use) - error response stops later steps', async () => {
    let later_mw_ran = false;
    const route = Post('/x')
      .body(z.object({ a: z.string() }))
      .use(() => { later_mw_ran = true; return {}; })
      .handle(() => {});

    await executeRoute(route, { rawBody: { a: 123 }, res: mockRes() });
    assert.strictEqual(later_mw_ran, false);
  });
});
