/**
 * Invariant tests: HTTP middleware chain ordering and composition.
 *
 * Pins:
 *  - `.use(a).use(b).handle(h)` runs a before b before h (declaration order)
 *  - Each middleware sees the context built by predecessors (Object.assign merge)
 *  - Async middleware is awaited (not fire-and-forget)
 *  - Middleware cannot short-circuit by responding - `executeRoute` keeps going
 *    unless a guard returns Stop. The `res.json()` side-effect does NOT stop
 *    later middleware or the handler. This is load-bearing: auth-via-middleware
 *    that "early-returns 401" does NOT prevent a downstream handler from running,
 *    which is a security footgun worth pinning.
 *  - Middleware throwing aborts the chain; the error propagates out of
 *    executeRoute (caller translates to 500).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { executeRoute } from '@justscale/core';
import { Get, Post } from '../src/builder/create-http-builder.js';

function mockRes() {
  const calls: Array<{ kind: string; args: unknown[] }> = [];
  const res = {
    _calls: calls,
    _pendingStatus: 200,
    json(data: unknown) {
      calls.push({ kind: 'json', args: [res._pendingStatus, data] });
    },
    status(code: number) {
      res._pendingStatus = code;
      return {
        json(data: unknown) {
          calls.push({ kind: 'status.json', args: [code, data] });
        },
        end() {
          calls.push({ kind: 'status.end', args: [code] });
        },
      };
    },
    error(msg: string, code = 400) {
      calls.push({ kind: 'error', args: [code, msg] });
    },
  };
  return res;
}

describe('HTTP middleware - chain ordering', () => {
  it('runs .use() middleware in declaration order', async () => {
    const order: string[] = [];
    const route = Get('/x')
      .use(() => { order.push('a'); return { a: 1 }; })
      .use(() => { order.push('b'); return { b: 2 }; })
      .use(() => { order.push('c'); return { c: 3 }; })
      .handle(() => { order.push('h'); });

    await executeRoute(route, { res: mockRes() });
    assert.deepStrictEqual(order, ['a', 'b', 'c', 'h']);
  });

  it('each middleware sees context additions from predecessors', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const route = Get('/x')
      .use(() => ({ first: 1 }))
      .use((ctx: any) => {
        seen.push({ first: ctx.first });
        return { second: ctx.first + 1 };
      })
      .use((ctx: any) => {
        seen.push({ first: ctx.first, second: ctx.second });
        return {};
      })
      .handle((ctx: any) => {
        seen.push({ first: ctx.first, second: ctx.second });
      });

    await executeRoute(route, { res: mockRes() });
    assert.deepStrictEqual(seen, [
      { first: 1 },
      { first: 1, second: 2 },
      { first: 1, second: 2 },
    ]);
  });

  it('async middleware is awaited sequentially (no interleaving)', async () => {
    const order: string[] = [];
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const route = Get('/x')
      .use(async () => { await sleep(20); order.push('a-done'); return { a: 1 }; })
      .use(async () => { await sleep(10); order.push('b-done'); return { b: 2 }; })
      .use(async () => { await sleep(5); order.push('c-done'); return { c: 3 }; })
      .handle(async () => { await sleep(5); order.push('h-done'); });

    await executeRoute(route, { res: mockRes() });
    // If any middleware ran in parallel, b/c would finish before a.
    assert.deepStrictEqual(order, ['a-done', 'b-done', 'c-done', 'h-done']);
  });

  it('middleware throwing aborts chain and propagates error', async () => {
    let b_ran = false;
    let handler_ran = false;
    const route = Get('/x')
      .use(() => { throw new Error('boom'); })
      .use(() => { b_ran = true; return {}; })
      .handle(() => { handler_ran = true; });

    await assert.rejects(
      () => executeRoute(route, { res: mockRes() }),
      /boom/,
    );
    assert.strictEqual(b_ran, false);
    assert.strictEqual(handler_ran, false);
  });

  it('SECURITY PIN: middleware writing a response does NOT short-circuit the chain', async () => {
    // This pins a foot-gun: if auth-as-middleware writes `ctx.res.status(401).json(...)`
    // without also running as a guard (or throwing), the framework happily keeps
    // running later middleware AND the handler. The handler can then write a second
    // response. The HTTP server's `responded` flag prevents the second response from
    // going on the wire, but the handler still executes side-effects (DB writes etc).
    //
    // Correct usage: do auth via `.guard(...)` which returns Stop, not `.use(...)`.
    // When this invariant changes (framework starts tracking "already responded"
    // at the executeRoute level), flip this test.

    const order: string[] = [];
    const route = Get('/x')
      .use((ctx: any) => { order.push('auth'); ctx.res.status(401).json({ error: 'nope' }); return {}; })
      .use(() => { order.push('later-mw'); return {}; })
      .handle(() => { order.push('handler'); });

    await executeRoute(route, { res: mockRes() });
    // Pin: all three ran.
    assert.deepStrictEqual(order, ['auth', 'later-mw', 'handler']);
  });

  it('executeRoute returns true when all steps + handler completed', async () => {
    const route = Get('/x').use(() => ({ a: 1 })).handle(() => {});
    const result = await executeRoute(route, { res: mockRes() });
    assert.strictEqual(result, true);
  });

  it('returning no object from .use() leaves ctx untouched', async () => {
    // Object.assign(ctx, undefined) is a no-op in Node; pin that behavior.
    let seen: any = null;
    const route = Get('/x')
      .use(() => undefined as any)
      .use(() => ({ b: 2 }))
      .handle((ctx: any) => { seen = ctx; });

    await executeRoute(route, { res: mockRes(), initial: 'ok' });
    assert.strictEqual(seen.initial, 'ok');
    assert.strictEqual(seen.b, 2);
  });

  it('.use().guard().use() - interleaved steps preserve declaration order', async () => {
    const order: string[] = [];
    const route = Post('/x')
      .use(() => { order.push('u1'); return {}; })
      .guard(() => { order.push('g1'); })
      .use(() => { order.push('u2'); return {}; })
      .guard(() => { order.push('g2'); })
      .use(() => { order.push('u3'); return {}; })
      .handle(() => { order.push('h'); });

    await executeRoute(route, { res: mockRes() });
    assert.deepStrictEqual(order, ['u1', 'g1', 'u2', 'g2', 'u3', 'h']);
  });

  it('PIN: stop() is removed from ctx between guards - guards cannot see each other\'s stop()', async () => {
    // After each guard runs, executeRoute does `delete ctx.stop`. Pin that the
    // next guard re-receives a fresh stop (separate function identity).
    const stops: Array<unknown> = [];
    const route = Get('/x')
      .guard((ctx: any) => { stops.push(ctx.stop); })
      .use(() => ({}))
      .guard((ctx: any) => { stops.push(ctx.stop); })
      .handle(() => {});

    await executeRoute(route, { res: mockRes() });
    assert.strictEqual(typeof stops[0], 'function');
    assert.strictEqual(typeof stops[1], 'function');
    // Each guard gets a fresh stop function (createStopFn() per call).
    assert.notStrictEqual(stops[0], stops[1]);
  });
});
