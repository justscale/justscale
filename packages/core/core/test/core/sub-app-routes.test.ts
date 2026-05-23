/**
 * Sub-app route delegation — parent's `app.match()` falls through to
 * each sub-app's `match()` when its own controllers don't match.
 *
 * Verifies:
 *   - A route declared in a sub-app is reachable via the parent's
 *     `match(method, path)`.
 *   - The matched route carries the sub-app's container as
 *     `owningContainer`, so `execute()` runs the handler in the
 *     sub-app's async scope (i.e. `getContainer()` inside the handler
 *     reads the sub-app's container, not the parent's).
 *   - Parent routes win over sub-app routes on path collision.
 *   - Multi-level nesting (sub-app inside sub-app) delegates correctly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import JustScale from '../../src/justscale.js';
import { defineService } from '../../src/core/service.js';
import { createController } from '../../src/core/controller.js';
import { getContainer } from '../../src/core/context.js';
import type { RouteDef } from '../../src/builder/types.js';
import type { Container } from '../../src/core/service.js';

// Minimal HTTP-ish mock — real Get() lives in @justscale/http which
// core doesn't depend on.
function Get(
  path: string,
  handler: (ctx: any) => any,
): RouteDef<any, any, any> {
  return {
    path,
    steps: [],
    responseSchemas: new Map(),
    handler,
    method: 'GET',
  } as any;
}

describe('Sub-app route delegation', () => {
  it('parent match() falls through to sub-app controllers', async () => {
    const SubCtrl = createController({
      inject: {},
      routes: () => ({
        hello: Get('/sub/hello', ({ res }) => res.json({ from: 'sub' })) as any,
      }),
    });

    const ParentCtrl = createController({
      inject: {},
      routes: () => ({
        ping: Get('/ping', ({ res }) => res.json({ from: 'parent' })) as any,
      }),
    });

    const SubApp = JustScale().add(SubCtrl).build();
    const parent = JustScale().add(ParentCtrl).add(SubApp).build();
    const parentApp = parent.compile();
    await parentApp.ready;

    const local = parentApp.match('GET', '/ping');
    const remote = parentApp.match('GET', '/sub/hello');
    const miss = parentApp.match('GET', '/nowhere');

    assert.ok(local, 'parent route should match');
    assert.ok(remote, 'sub-app route should match via delegation');
    assert.strictEqual(miss, null, 'unknown paths still miss');
  });

  it('delegated match carries the sub-app container as owningContainer', async () => {
    const SubCtrl = createController({
      inject: {},
      routes: () => ({
        x: Get('/sub/x', ({ res }) => res.json({})) as any,
      }),
    });

    const SubApp = JustScale().add(SubCtrl).build();
    const parent = JustScale().add(SubApp).build();
    const parentApp = parent.compile();
    await parentApp.ready;

    const matched = parentApp.match('GET', '/sub/x');
    assert.ok(matched);
    assert.notStrictEqual(
      matched.owningContainer,
      parentApp.container,
      'owningContainer should be sub-app container, not parent',
    );
  });

  it('execute() runs sub-app route in the sub-app container scope', async () => {
    let observedContainer: Container | undefined;

    const SubCtrl = createController({
      inject: {},
      routes: () => ({
        observe: Get('/sub/observe', () => {
          observedContainer = getContainer();
          return { ok: true };
        }) as any,
      }),
    });

    const SubApp = JustScale().add(SubCtrl).build();
    const parent = JustScale().add(SubApp).build();
    const parentApp = parent.compile();
    await parentApp.ready;

    const matched = parentApp.match('GET', '/sub/observe');
    assert.ok(matched);

    // Fake a minimal HTTP context
    await parentApp.execute(matched, { res: { json: (x: unknown) => x } });

    assert.ok(observedContainer, 'handler should have captured a container');
    assert.notStrictEqual(
      observedContainer,
      parentApp.container,
      'handler should have run in the sub-app scope, not parent',
    );
    assert.strictEqual(
      observedContainer,
      matched.owningContainer,
      'captured container matches the matched route owner',
    );
  });

  it('parent routes win over sub-app routes on path collision', async () => {
    let which: 'parent' | 'sub' | null = null;

    const SubCtrl = createController({
      inject: {},
      routes: () => ({
        x: Get('/shared', () => {
          which = 'sub';
          return {};
        }) as any,
      }),
    });

    const ParentCtrl = createController({
      inject: {},
      routes: () => ({
        x: Get('/shared', () => {
          which = 'parent';
          return {};
        }) as any,
      }),
    });

    const SubApp = JustScale().add(SubCtrl).build();
    const parent = JustScale().add(ParentCtrl).add(SubApp).build();
    const parentApp = parent.compile();
    await parentApp.ready;

    const matched = parentApp.match('GET', '/shared');
    assert.ok(matched);
    await parentApp.execute(matched, { res: { json: (x: unknown) => x } });
    assert.strictEqual(which, 'parent', 'parent handler should execute, not sub-app');
  });

  it('multi-level nesting: grandchild route resolves via recursive delegation', async () => {
    const Service = defineService({
      inject: {},
      factory: () => ({ tag: () => 'grandchild' }),
    });

    const GrandCtrl = createController({
      inject: { svc: Service },
      routes: ({ svc }) => ({
        deep: Get('/gc/deep', () => ({ tag: svc.tag() })) as any,
      }),
    });

    const Grandchild = JustScale().add(Service).add(GrandCtrl).build();
    const Child = JustScale().add(Grandchild).build();
    const parent = JustScale().add(Child).build();
    const parentApp = parent.compile();
    await parentApp.ready;

    const matched = parentApp.match('GET', '/gc/deep');
    assert.ok(matched, 'grandchild route should be reachable through two levels');
  });
});
