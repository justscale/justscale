/**
 * Invariant tests: HTTP guard composition.
 *
 * Pins:
 *  - `.guard(A).guard(B)` - both must pass; first failure wins (order matters)
 *  - A guard returning `stop()` short-circuits the chain; later guards and
 *    the handler do NOT run
 *  - A guard returning `false` (truthy-deny) also short-circuits. executeRoute
 *    returns false in that case; the HTTP server translates it to 403.
 *  - A guard returning `undefined` passes
 *  - Guards see context built by prior `.use()` steps (e.g. auth middleware
 *    before guard - guard sees ctx.user)
 *  - Arrays of GuardDef are OR-semantics (handled by resolveSteps before
 *    executeRoute; verified indirectly via controller test in integration)
 *  - Guards can throw - error propagates out of executeRoute
 *  - `.use(auth).guard(isAdmin)` - guard sees auth-added ctx.user regardless
 *    of being declared before/after in source, because declaration order
 *    determines actual execution order (NOT some "guards run last" semantic)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { executeRoute } from '@justscale/core';
import { Get } from '../src/builder/create-http-builder.js';

function mockRes() {
  const res: any = {
    _pendingStatus: 200,
    _responded: null as null | { status: number; body: unknown },
    json(data: unknown) { res._responded = { status: res._pendingStatus, body: data }; },
    status(code: number) {
      res._pendingStatus = code;
      return {
        json(data: unknown) { res._responded = { status: code, body: data }; },
        end() { res._responded = { status: code, body: undefined }; },
      };
    },
    error(msg: string, code = 400) { res._responded = { status: code, body: { error: msg } }; },
  };
  return res;
}

describe('HTTP guard - composition', () => {
  it('both guards pass when both return undefined', async () => {
    let handler_ran = false;
    const route = Get('/x')
      .guard(() => undefined)
      .guard(() => undefined)
      .handle(() => { handler_ran = true; });

    const completed = await executeRoute(route, { res: mockRes() });
    assert.strictEqual(completed, true);
    assert.strictEqual(handler_ran, true);
  });

  it('first guard returning stop() aborts - second guard + handler skipped', async () => {
    const order: string[] = [];
    const res = mockRes();
    const route = Get('/x')
      .guard((ctx: any) => { order.push('g1'); return ctx.stop(); })
      .guard(() => { order.push('g2'); })
      .handle(() => { order.push('h'); });

    const completed = await executeRoute(route, { res });
    assert.strictEqual(completed, false, 'executeRoute should report not completed');
    assert.deepStrictEqual(order, ['g1']);
  });

  it('second guard stops - first guard still ran', async () => {
    const order: string[] = [];
    const route = Get('/x')
      .guard(() => { order.push('g1'); })
      .guard((ctx: any) => { order.push('g2'); return ctx.stop(); })
      .handle(() => { order.push('h'); });

    const completed = await executeRoute(route, { res: mockRes() });
    assert.strictEqual(completed, false);
    assert.deepStrictEqual(order, ['g1', 'g2']);
  });

  it('guard returning `false` short-circuits - executeRoute returns false', async () => {
    // Executing raw `false` means "denied but no response sent". The HTTP
    // server translates that into a 403. Pin both halves here.
    let handler_ran = false;
    const route = Get('/x')
      .guard(() => false)
      .handle(() => { handler_ran = true; });

    const res = mockRes();
    const completed = await executeRoute(route, { res });
    assert.strictEqual(completed, false);
    assert.strictEqual(handler_ran, false);
    // `false` does NOT call res.json - executeRoute returns false and leaves
    // response-writing to the HTTP adapter.
    assert.strictEqual(res._responded, null);
  });

  it('guard throwing aborts chain and propagates error', async () => {
    let handler_ran = false;
    const route = Get('/x')
      .guard(() => { throw new Error('denied'); })
      .handle(() => { handler_ran = true; });

    await assert.rejects(() => executeRoute(route, { res: mockRes() }), /denied/);
    assert.strictEqual(handler_ran, false);
  });

  it('guard sees ctx additions from earlier .use() middleware', async () => {
    let guard_user: any = null;
    const route = Get('/x')
      .use(() => ({ user: { id: 'alice', role: 'admin' } }))
      .guard((ctx: any) => {
        guard_user = ctx.user;
        if (ctx.user.role !== 'admin') return ctx.stop();
      })
      .handle(() => {});

    const completed = await executeRoute(route, { res: mockRes() });
    assert.deepStrictEqual(guard_user, { id: 'alice', role: 'admin' });
    assert.strictEqual(completed, true);
  });

  it('ORDERING PIN: guard declared BEFORE auth middleware cannot see ctx.user', async () => {
    // This pins a sharp edge: guards do NOT "run after all middleware".
    // They run in declaration order. Authors who write:
    //   .guard(isAdmin).use(auth)  // WRONG: isAdmin runs without ctx.user
    // will see isAdmin receive undefined user.
    let guard_user: any = 'not-set';
    const route = Get('/x')
      .guard((ctx: any) => { guard_user = ctx.user; })
      .use(() => ({ user: { id: 'alice' } }))
      .handle(() => {});

    await executeRoute(route, { res: mockRes() });
    assert.strictEqual(guard_user, undefined, 'guard ran before .use(auth), so ctx.user was undefined');
  });

  it('guard that returns any truthy non-Stop value is treated as PASS', async () => {
    // executeRoute only blocks on `isStop(result)` or `result === false`.
    // Any other truthy value (including `true`, a string, an object) passes.
    let handler_ran = false;
    const route = Get('/x')
      .guard(() => true as any)
      .guard(() => 'yes' as any)
      .guard(() => ({ some: 'object' }) as any)
      .handle(() => { handler_ran = true; });

    const completed = await executeRoute(route, { res: mockRes() });
    assert.strictEqual(completed, true);
    assert.strictEqual(handler_ran, true);
  });

  it('guard can mutate ctx (though this is NOT the documented API)', async () => {
    // The guard receives ctx; assigning to it mutates. Whether this is
    // supported long-term is unclear, but currently it works. Pin it.
    let handler_saw: any = null;
    const route = Get('/x')
      .guard((ctx: any) => { ctx.sideEffect = 'injected-by-guard'; })
      .handle((ctx: any) => { handler_saw = ctx.sideEffect; });

    await executeRoute(route, { res: mockRes() });
    assert.strictEqual(handler_saw, 'injected-by-guard');
  });

  it('guard after stop() does NOT run - context.stop is deleted cleanly', async () => {
    // When guard1 stops, executeRoute early-returns; the `delete ctx.stop`
    // path is skipped. Subsequent guard2 never runs, so no dangling stop
    // on ctx. Pin by asserting second guard never observes ctx.stop.
    let g2_ran = false;
    const route = Get('/x')
      .guard((ctx: any) => ctx.stop())
      .guard(() => { g2_ran = true; })
      .handle(() => {});

    await executeRoute(route, { res: mockRes() });
    assert.strictEqual(g2_ran, false);
  });
});
