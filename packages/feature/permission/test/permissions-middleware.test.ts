/**
 * End-to-end runtime tests for the permissions middleware.
 *
 * Verifies the middleware function directly:
 * - Wraps res with .permission matching the highest-priority match
 * - Falls through to undefined when no principal matches
 * - Reuses principals already in AsyncLocalStorage
 * - Picks the first matching permission by declaration order
 * - Does not add .permission when there are no permission-scoped returns
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { runWithPrincipals } from '@justscale/core';
import { permissions } from '../src/middleware/permissions.js';
import { permit } from '../src/permit.js';
import type { Principal, SinglePermissionDef } from '../src/types.js';

// ============================================================================
// Test fixtures
// ============================================================================

class Agent {
  declare name: string;
}

class Customer {
  declare name: string;
}

const agentRef = { identifier: 'agent-1' } as any;
const customerRef = { identifier: 'customer-1' } as any;

// Build real permission defs via permit() — they have proper factory functions.
// Stamp .name (defineModel normally does this from the permissions record key).
const fullAccess = permit(Agent).always() as unknown as SinglePermissionDef & { name: string };
(fullAccess as any).name = 'fullAccess';
const viewOnly = permit(Customer).always() as unknown as SinglePermissionDef & { name: string };
(viewOnly as any).name = 'view';

/**
 * Resolve the middleware against a provider that returns the given principals.
 * Returns the middleware function ready to be called with ctx.
 */
function resolveMiddleware(principals: Principal[]) {
  const provider = {
    resolve: async () => principals,
  };
  return permissions.factory({ provider } as any);
}

/** Build a mock ctx with a minimal res and optional __route. */
function makeCtx(permReturns?: Array<{ status: number; schema: unknown; permission: any }>) {
  const res = {
    json: () => {},
    status: () => ({ json: () => {}, end: () => {} }),
  };
  return {
    res,
    params: {},
    __route: permReturns ? { permissionReturns: permReturns } : undefined,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('permissions middleware', () => {
  it('wraps res.permission with the matched permission name', async () => {
    const mw = resolveMiddleware([{ type: Agent, ref: agentRef } as Principal]);
    const ctx = makeCtx([
      { status: 200, schema: null, permission: fullAccess },
      { status: 200, schema: null, permission: viewOnly },
    ]);

    const result = await mw(ctx);

    assert.ok(result);
    assert.ok(result.res, 'middleware returns a wrapped res');
    assert.strictEqual((result.res as any).permission, 'fullAccess');
  });

  it('.permission is undefined when no principal matches', async () => {
    const mw = resolveMiddleware([]); // no principals
    const ctx = makeCtx([
      { status: 200, schema: null, permission: fullAccess },
      { status: 200, schema: null, permission: viewOnly },
    ]);

    const result = await mw(ctx);

    assert.ok(result?.res);
    assert.strictEqual((result!.res as any).permission, undefined);
  });

  it('picks the first matching permission in declaration order', async () => {
    const mw = resolveMiddleware([
      { type: Customer, ref: customerRef } as Principal,
      { type: Agent, ref: agentRef } as Principal,
    ]);

    // fullAccess (Agent) listed FIRST — should win even though Customer is earlier in principals
    const ctx = makeCtx([
      { status: 200, schema: null, permission: fullAccess },
      { status: 200, schema: null, permission: viewOnly },
    ]);

    const result = await mw(ctx);
    assert.strictEqual((result!.res as any).permission, 'fullAccess');
  });

  it('reuses principals already in AsyncLocalStorage', async () => {
    let resolveCalls = 0;
    const provider = {
      resolve: async () => {
        resolveCalls++;
        return [{ type: Agent, ref: agentRef }];
      },
    };
    const mw = permissions.factory({ provider } as any);

    const ctx = makeCtx([{ status: 200, schema: null, permission: fullAccess }]);

    await runWithPrincipals(
      [{ type: Agent, ref: agentRef }] as any,
      async () => mw(ctx),
    );

    assert.strictEqual(
      resolveCalls,
      0,
      'provider.resolve should NOT be called when principals already in ALS',
    );
  });

  it('does not add .permission when route has no permission-scoped returns', async () => {
    const mw = resolveMiddleware([{ type: Agent, ref: agentRef } as Principal]);
    // No __route.permissionReturns
    const ctx = makeCtx();

    const result = await mw(ctx);
    assert.strictEqual((result!.res as any).permission, undefined);
  });

  it('preserves original res methods via prototype chain', async () => {
    const jsonSpy: unknown[] = [];
    const mw = resolveMiddleware([{ type: Agent, ref: agentRef } as Principal]);
    const ctx: any = {
      res: {
        json: (data: unknown) => jsonSpy.push(data),
        status: () => ({ json: () => {}, end: () => {} }),
      },
      __route: {
        permissionReturns: [
          { status: 200, schema: null, permission: fullAccess },
        ],
      },
    };

    const result = await mw(ctx);
    (result!.res as any).json({ ok: true });

    assert.deepStrictEqual(jsonSpy, [{ ok: true }]);
  });

  it('also exposes principals on the returned context', async () => {
    const principals = [{ type: Agent, ref: agentRef }];
    const mw = resolveMiddleware(principals as Principal[]);
    const ctx = makeCtx();

    const result = await mw(ctx);
    assert.deepStrictEqual(result!.principals, principals);
  });

  it('propagates errors from a permission check (does not silently fall through)', async () => {
    // If a permission's check function throws, the middleware MUST propagate
    // the error rather than silently treating it as "no match" and moving on.
    // Silently swallowing would let a buggy permission accidentally allow
    // a less-restrictive later permission to win.
    const explodingPermission = {
      name: 'exploding',
      factory: () => async () => {
        throw new Error('permission-check-failed');
      },
    } as unknown as SinglePermissionDef & { name: string };

    const mw = resolveMiddleware([{ type: Agent, ref: agentRef } as Principal]);
    const ctx = makeCtx([
      { status: 200, schema: null, permission: explodingPermission },
      // If the throw were silently skipped, fullAccess would match an Agent.
      { status: 200, schema: null, permission: fullAccess },
    ]);

    await assert.rejects(async () => { await mw(ctx); }, /permission-check-failed/);
  });

  it('iterates entries in declaration order even with empty principals', async () => {
    // Empty principals (anonymous request) — the middleware still walks the
    // entries; whichever one allows-anonymous first wins. Pin the order so a
    // refactor can't quietly reorder.
    const allowAnonymous = {
      name: 'public',
      factory: () => async () => true,
    } as unknown as SinglePermissionDef & { name: string };
    const requiresAgent = fullAccess;

    const mw = resolveMiddleware([]); // anonymous

    // requiresAgent first → won't match (no principals) → public matches second
    const ctxA = makeCtx([
      { status: 200, schema: null, permission: requiresAgent },
      { status: 200, schema: null, permission: allowAnonymous },
    ]);
    const resA = await mw(ctxA);
    assert.strictEqual((resA!.res as any).permission, 'public');

    // public first → matches immediately
    const ctxB = makeCtx([
      { status: 200, schema: null, permission: allowAnonymous },
      { status: 200, schema: null, permission: requiresAgent },
    ]);
    const resB = await mw(ctxB);
    assert.strictEqual((resB!.res as any).permission, 'public');
  });
});
