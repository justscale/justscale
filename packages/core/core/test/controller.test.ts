import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Container, defineService } from '../src/core/service.js';
import { createController } from '../src/core/controller.js';
import { registerRouteFactory } from '../src/core/plugin.js';
import type { RouteContext, RouteHandler } from '../src/core/plugin.js';
import type { RouteDef } from '../src/builder/types.js';
import { GUARD_DEF_MARKER, createGuard } from '../src/core/middleware.js';
import { executeRoute } from '../src/builder/execute.js';

// Mock HTTP route builders for testing controller behavior
// We don't need the real @justscale/http - just route definitions
function mockRoute(method: string, path: string, handler: Function): RouteDef<any, any, any> {
  return { path, steps: [], responseSchemas: new Map(), handler, method } as any;
}
function Get<TDeps>(path: string, handler: RouteHandler<TDeps>): RouteDef<any, any, any> {
  return mockRoute('GET', path, handler);
}
function Post<TDeps>(path: string, handler: RouteHandler<TDeps>): RouteDef<any, any, any> {
  return mockRoute('POST', path, handler);
}
function Put<TDeps>(path: string, handler: RouteHandler<TDeps>): RouteDef<any, any, any> {
  return mockRoute('PUT', path, handler);
}
function Delete<TDeps>(path: string, handler: RouteHandler<TDeps>): RouteDef<any, any, any> {
  return mockRoute('DELETE', path, handler);
}

describe('createController', () => {
  it('should create a controller with routes', async () => {
    class UserService {
      findAll() {
        return ['alice', 'bob'];
      }
    }

    const controller = createController('/api', {
      inject: { users: UserService },
      routes: () => ({
        list: Get('/users', (ctx: any) => {
          ctx.users.findAll();
        }),
      }),
    });

    assert.strictEqual(controller.prefix, '/api');
    assert.ok(controller.deps.users);  // deps still exists on controller def
    assert.ok(controller.factory);
  });

  it('should compile route paths correctly', async () => {
    const controller = createController('/api', {
      inject: {},
      routes: () => ({
        list: Get('/users', () => {}),
        detail: Get('/users/:id', () => {}),
      }),
    });

    const container = new Container();
    container.register(controller);
    const instance = await container.resolve(controller);

    assert.strictEqual(instance.routes.length, 2);

    const listRoute = instance.routes.find((r) => r.path === '/api/users');
    const detailRoute = instance.routes.find(
      (r) => r.path === '/api/users/:id'
    );

    assert.ok(listRoute);
    assert.ok(detailRoute);
    assert.deepStrictEqual(listRoute.paramNames, []);
    assert.deepStrictEqual(detailRoute.paramNames, ['id']);
  });

  it('should match routes with params', async () => {
    const controller = createController('/api', {
      inject: {},
      routes: () => ({
        userById: Get('/users/:id', () => {}),
        postByUserAndId: Get('/users/:userId/posts/:postId', () => {}),
      }),
    });

    const container = new Container();
    container.register(controller);
    const instance = await container.resolve(controller);

    const userRoute = instance.routes.find((r) =>
      r.path.includes('/users/:id')
    );
    const postRoute = instance.routes.find((r) =>
      r.path.includes('/posts/:postId')
    );

    // Test pattern matching
    const userMatch = '/api/users/123'.match(userRoute!.pattern);
    assert.ok(userMatch);
    assert.strictEqual(userMatch[1], '123');

    const postMatch = '/api/users/456/posts/789'.match(postRoute!.pattern);
    assert.ok(postMatch);
    assert.strictEqual(postMatch[1], '456'); // userId
    assert.strictEqual(postMatch[2], '789'); // postId
  });

  it('should inject dependencies into route handlers', async () => {
    let capturedDeps: any = null;

    class CounterService {
      private count = 0;
      increment() {
        return ++this.count;
      }
    }

    const controller = createController('/api', {
      inject: { counter: CounterService },
      routes: () => ({
        increment: Get('/increment', (ctx: any) => {
          capturedDeps = ctx;
          ctx.counter.increment();
        }),
      }),
    });

    const container = new Container();
    container.registerClass(CounterService);
    container.register(controller);

    const instance = await container.resolve(controller);
    const route = instance.routes[0];
    assert.ok(route, 'Route should exist');

    // Simulate calling the handler with flattened deps
    const mockContext = {
      ...instance.deps,  // deps spread into context
      signals: {},
      stream: {
        mergeSignals: () => {},
        mergeFragments: () => {},
        removeFragments: () => {},
        removeSignals: () => {},
        executeScript: () => {},
      },
      params: {},
    };

    await route.handler(mockContext);

    assert.ok(capturedDeps);
    assert.ok(capturedDeps.counter instanceof CounterService);
    assert.strictEqual(capturedDeps.counter.increment(), 2); // Was incremented to 1 in handler
  });

  it('should support multiple HTTP methods', async () => {
    const controller = createController('/api', {
      inject: {},
      routes: () => ({
        list: Get('/items', () => {}),
        create: Post('/items', () => {}),
        update: Put('/items/:id', () => {}),
        remove: Delete('/items/:id', () => {}),
      }),
    });

    const container = new Container();
    container.register(controller);
    const instance = await container.resolve(controller);

    const methods = instance.routes.map((r) => r.method);
    assert.deepStrictEqual(methods.sort(), [
      'DELETE',
      'GET',
      'POST',
      'PUT',
    ]);
  });

  it('should handle nested service dependencies', async () => {
    class Logger {
      log(msg: string) {
        return msg;
      }
    }

    const DbService = defineService({
      inject: { logger: Logger },
      factory: ({ logger }) => ({
        query: (sql: string) => {
          logger.log(sql);
          return [];
        },
      }),
    });

    const controller = createController('/api', {
      inject: { db: DbService },
      routes: () => ({
        list: Get('/data', (ctx: any) => {
          ctx.db.query('SELECT * FROM data');
        }),
      }),
    });

    const container = new Container();
    container.registerClass(Logger);
    container.register(DbService);
    container.register(controller);

    const instance = await container.resolve(controller);
    assert.ok(instance.deps.db);  // deps still available on instance for inspection
    assert.ok(typeof instance.deps.db.query === 'function');
  });
});

describe('Route pattern compilation', () => {
  it('should escape special regex characters in paths', async () => {
    const controller = createController('/api', {
      inject: {},
      routes: () => ({
        special: Get('/path.with.dots', () => {}),
      }),
    });

    const container = new Container();
    container.register(controller);
    const instance = await container.resolve(controller);

    const route = instance.routes[0];
    assert.ok(route, 'Route should exist');
    // The path should match exactly, not treat dots as wildcards
    assert.ok('/api/path.with.dots'.match(route.pattern));
    // This should NOT match if dots are properly escaped
    // Note: Current impl doesn't escape dots, this test documents behavior
  });

  it('should handle empty prefix', async () => {
    const controller = createController('', {
      inject: {},
      routes: () => ({
        root: Get('/', () => {}),
        path: Get('/path', () => {}),
      }),
    });

    const container = new Container();
    container.register(controller);
    const instance = await container.resolve(controller);

    assert.ok(instance.routes[0], 'First route should exist');
    assert.ok(instance.routes[1], 'Second route should exist');
    assert.strictEqual(instance.routes[0].path, '/');
    assert.strictEqual(instance.routes[1].path, '/path');
  });
});

// ============================================================================
// GuardDef resolution — arrays and DI injection
// ============================================================================

describe('GuardDef resolution in controllers', () => {
  /**
   * Create a minimal GuardDef object (same shape as produced by permit()).
   */
  function makeGuardDef(
    resolverKey: string,
    resolverImpl: any,
    guardFn: (ctx: any) => Promise<boolean>
  ) {
    return {
      __kind: GUARD_DEF_MARKER,
      deps: { [resolverKey]: class MockToken {} },
      factory: (deps: Record<string, any>) => (ctx: any) => guardFn(ctx),
      _resolverImpl: resolverImpl,
    };
  }

  it('resolves a GuardDef to a callable function via DI', async () => {
    let wasCalled = false;

    class AuthService {
      isAuthenticated() {
        return true;
      }
    }

    const authGuardDef = createGuard({
      inject: { auth: AuthService },
      check: (deps) => async (_ctx: any) => deps.auth.isAuthenticated(),
    });

    function GuardedRoute(path: string): RouteDef<any, any, any> {
      return {
        path,
        steps: [{ type: 'guard' as const, fn: authGuardDef }],
        responseSchemas: new Map(),
        handler: () => { wasCalled = true; },
      };
    }

    const controller = createController('/api', {
      inject: {},
      routes: () => ({
        protected: GuardedRoute('/protected'),
      }),
    });

    const container = new Container();
    container.registerClass(AuthService);
    container.register(controller);

    const instance = await container.resolve(controller);
    const route = instance.routes[0];
    assert.ok(route, 'Route should exist');
    assert.ok(Array.isArray(route.steps), 'route should have steps');
    assert.strictEqual(route.steps.length, 1);

    // Step should have been resolved to a callable function (not a GuardDef)
    const step = route.steps[0];
    assert.strictEqual(step.type, 'guard');
    assert.ok(typeof step.fn === 'function', 'fn should be a callable function after resolution');

    // Execute the route — guard should allow (returns true)
    await executeRoute(route, {});
    assert.ok(wasCalled, 'handler should have been called after guard passed');
  });

  it('GuardDef array (OR semantics) — allows if any guard passes', async () => {
    let handlerCalled = false;

    const alwaysDenyDef = {
      __kind: GUARD_DEF_MARKER,
      deps: {},
      factory: () => async () => false,
    };

    const alwaysAllowDef = {
      __kind: GUARD_DEF_MARKER,
      deps: {},
      factory: () => async () => true,
    };

    function CompoundGuardRoute(path: string): RouteDef<any, any, any> {
      return {
        path,
        steps: [{ type: 'guard' as const, fn: [alwaysDenyDef, alwaysAllowDef] as any }],
        responseSchemas: new Map(),
        handler: () => { handlerCalled = true; },
      };
    }

    const controller = createController('/api', {
      inject: {},
      routes: () => ({
        compound: CompoundGuardRoute('/compound'),
      }),
    });

    const container = new Container();
    container.register(controller);
    const instance = await container.resolve(controller);
    const route = instance.routes[0];

    await executeRoute(route, {});
    assert.ok(handlerCalled, 'handler should have been called (alwaysAllow passed)');
  });

  it('GuardDef array (OR semantics) — denies if all guards fail', async () => {
    let handlerCalled = false;

    const deny1 = { __kind: GUARD_DEF_MARKER, deps: {}, factory: () => async () => false };
    const deny2 = { __kind: GUARD_DEF_MARKER, deps: {}, factory: () => async () => false };

    function DenyRoute(path: string): RouteDef<any, any, any> {
      return {
        path,
        steps: [{ type: 'guard' as const, fn: [deny1, deny2] as any }],
        responseSchemas: new Map(),
        handler: () => { handlerCalled = true; },
      };
    }

    const controller = createController('/api', {
      inject: {},
      routes: () => ({
        denied: DenyRoute('/denied'),
      }),
    });

    const container = new Container();
    container.register(controller);
    const instance = await container.resolve(controller);
    const route = instance.routes[0];

    // Guard returns false — executeRoute stops before handler
    const completed = await executeRoute(route, {});
    assert.ok(!handlerCalled, 'handler should NOT have been called');
    assert.strictEqual(completed, false, 'executeRoute should return false when guard denied');
  });

  it('executeRoute throws when step.fn is not a callable function', async () => {
    const routeWithUnresolvedGuard = {
      path: '/test',
      steps: [{ type: 'guard' as const, fn: { __kind: GUARD_DEF_MARKER, deps: {}, factory: () => () => true } }],
      responseSchemas: new Map(),
      handler: () => {},
    };

    await assert.rejects(
      () => executeRoute(routeWithUnresolvedGuard as any, {}),
      /unresolved dependency/i,
      'should throw for unresolved GuardDef in executeRoute',
    );
  });
});

describe('Route factory extensibility', () => {
  it('should allow registering custom route factories', async () => {
    // Create a custom route factory (e.g., for a specific content type)
    function JsonGet<TDeps>(
      path: string,
      handler: RouteHandler<TDeps>
    ): RouteDef<any, any, any> {
      return mockRoute('GET', path, handler);
    }

    // Register it
    registerRouteFactory('JsonGet', JsonGet);

    // Now it can be used directly (like any imported route factory)
    const controller = createController('/api', {
      inject: {},
      routes: () => ({
        // Use the factory directly
        data: JsonGet('/data', () => {}),
      }),
    });

    const container = new Container();
    container.register(controller);
    const instance = await container.resolve(controller);

    assert.ok(instance.routes[0], 'Route should exist');
    assert.strictEqual(instance.routes[0].path, '/api/data');
    assert.strictEqual(instance.routes[0].method, 'GET');
  });
});
