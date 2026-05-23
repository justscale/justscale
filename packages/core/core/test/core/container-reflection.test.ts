/**
 * Tests for AbstractContainer — the queryable reflection surface bound
 * into every compiled scope's container.
 *
 * Scope: the AbstractContainer is resolvable post-compile, iterates
 * this scope's controllers, and survives filter queries.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import JustScale from '../../src/justscale.js';
import { defineService } from '../../src/core/service.js';
import { createController } from '../../src/core/controller.js';
import {
  AbstractContainer,
  type ContainerReflection,
} from '../../src/core/container-reflection.js';
import type { RouteHandler } from '../../src/core/plugin.js';
import type { RouteDef } from '../../src/builder/types.js';

// Minimal HTTP-ish route factory — this is a LOCAL mock, not the real
// `Get(...)` from `@justscale/http/builder`. `@justscale/core` is
// transport-agnostic and must not depend on any protocol package; these
// tests only need the shape `{ path, steps, responseSchemas, handler,
// method }` that `createController` consumes. Real HTTP routing is
// tested inside `@justscale/http`.
function Get<TDeps>(path: string, handler: RouteHandler<TDeps>): RouteDef<any, any, any> {
  return { path, steps: [], responseSchemas: new Map(), handler, method: 'GET' } as any;
}

describe('AbstractContainer', () => {
  it('is resolvable after compile and iterates the scope\'s controllers', async () => {
    const CtrlA = createController({
      inject: {},
      routes: () => ({
        x: Get('/a', ({ res }) => res.json({})) as any,
      }),
    });

    const CtrlB = createController({
      inject: {},
      routes: () => ({
        y: Get('/b', ({ res }) => res.json({})) as any,
      }),
    });

    const app = JustScale().add(CtrlA).add(CtrlB).build().compile();
    await app.ready;

    const reflection = await app.container.resolve(AbstractContainer as any) as ContainerReflection;
    const controllers = [...reflection.controllers()];

    assert.strictEqual(controllers.length, 2);
  });

  it('filters by hasGuards', async () => {
    const NoGuard = createController({
      inject: {},
      routes: () => ({ x: Get('/ng', ({ res }) => res.json({})) as any }),
    });
    const WithGuard = createController({
      inject: {},
      routes: () => ({
        x: {
          path: '/wg',
          steps: [{ type: 'guard', fn: () => true }],
          responseSchemas: new Map(),
          handler: () => {},
          method: 'GET',
        } as any,
      }),
    });

    const app = JustScale().add(NoGuard).add(WithGuard).build().compile();
    await app.ready;

    const reflection = await app.container.resolve(AbstractContainer as any) as ContainerReflection;

    const all = [...reflection.controllers()];
    const guarded = [...reflection.controllers({ hasGuards: true })];
    const unguarded = [...reflection.controllers({ hasGuards: false })];

    assert.strictEqual(all.length, 2);
    assert.strictEqual(guarded.length, 1);
    assert.strictEqual(unguarded.length, 1);
  });

  it('exposes get() for tokens bound in this scope', async () => {
    const MyService = defineService({
      inject: {},
      factory: () => ({ hello: () => 'world' }),
    });

    const app = JustScale().add(MyService).build().compile();
    await app.ready;

    const reflection = await app.container.resolve(AbstractContainer as any) as ContainerReflection;
    const resolved = await reflection.get(MyService);
    assert.ok(resolved);
    assert.strictEqual(resolved.hello(), 'world');
  });

  it('is injectable into a service as AbstractContainer token', async () => {
    const Ctrl = createController({
      inject: {},
      routes: () => ({ x: Get('/x', ({ res }) => res.json({})) as any }),
    });

    let observedCount = -1;
    const Reflector = defineService({
      inject: { container: AbstractContainer },
      factory: ({ container }) => ({
        snapshot() {
          observedCount = [...container.controllers()].length;
          return observedCount;
        },
      }),
    });

    const app = JustScale().add(Ctrl).add(Reflector).build().compile();
    await app.ready;

    const svc = await app.container.resolve(Reflector);
    assert.strictEqual(svc.snapshot(), 1);
    assert.strictEqual(observedCount, 1);
  });
});
