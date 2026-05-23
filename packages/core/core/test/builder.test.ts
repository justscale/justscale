import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isStop, createStopFn } from '../src/builder/stop.js';
import { createBuilderState, createBaseBuilder } from '../src/builder/create-builder.js';
import { executeRoute } from '../src/builder/execute.js';
import { createPlugin, isPlugin, PLUGIN_SYMBOL } from '../src/builder/plugin.js';
import type { RouteDef } from '../src/builder/types.js';
import { z } from 'zod';

// ============================================================================
// Stop Mechanism Tests
// ============================================================================

describe('Stop Mechanism', () => {
  describe('isStop', () => {
    it('should return true for stop signal', () => {
      const stop = createStopFn();
      const signal = stop();
      assert.strictEqual(isStop(signal), true);
    });

    it('should return false for other values', () => {
      assert.strictEqual(isStop(null), false);
      assert.strictEqual(isStop(undefined), false);
      assert.strictEqual(isStop(false), false);
      assert.strictEqual(isStop(true), false);
      assert.strictEqual(isStop(0), false);
      assert.strictEqual(isStop('stop'), false);
      assert.strictEqual(isStop({}), false);
      assert.strictEqual(isStop([]), false);
      assert.strictEqual(isStop(Symbol('other')), false);
    });

    it("should return false for Symbol.for('justscale:stop')", () => {
      // Using Symbol() not Symbol.for() ensures uniqueness
      const fakeStop = Symbol.for('justscale:stop');
      assert.strictEqual(isStop(fakeStop), false);
    });
  });

  describe('createStopFn', () => {
    it('should return a function that produces stop signals', () => {
      const stop = createStopFn();
      assert.strictEqual(typeof stop, 'function');

      const signal = stop();
      assert.strictEqual(isStop(signal), true);
    });

    it('should return the same symbol from multiple calls', () => {
      const stop = createStopFn();
      const signal1 = stop();
      const signal2 = stop();

      assert.strictEqual(signal1, signal2);
      assert.strictEqual(isStop(signal1), true);
      assert.strictEqual(isStop(signal2), true);
    });

    it('should return different functions with same symbol', () => {
      const stop1 = createStopFn();
      const stop2 = createStopFn();

      // Functions are different
      assert.notStrictEqual(stop1, stop2);

      // But they produce the same symbol
      assert.strictEqual(stop1(), stop2());
    });
  });
});

// ============================================================================
// Builder Creation Tests
// ============================================================================

describe('Builder Creation', () => {
  describe('createBuilderState', () => {
    it('should return empty state', () => {
      const state = createBuilderState();

      assert.ok(Array.isArray(state.steps));
      assert.strictEqual(state.steps.length, 0);
      assert.ok(state.responseSchemas instanceof Map);
      assert.strictEqual(state.responseSchemas.size, 0);
    });

    it('should return new state each time', () => {
      const state1 = createBuilderState();
      const state2 = createBuilderState();

      assert.notStrictEqual(state1, state2);
      assert.notStrictEqual(state1.steps, state2.steps);
      assert.notStrictEqual(state1.responseSchemas, state2.responseSchemas);
    });
  });

  describe('createBaseBuilder', () => {
    it('should return a builder with all methods', () => {
      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      assert.ok(typeof builder.use === 'function');
      assert.ok(typeof builder.guard === 'function');
      assert.ok(typeof builder.apply === 'function');
      assert.ok(typeof builder.returns === 'function');
      assert.ok(typeof builder.handle === 'function');
    });

    it('.use() should add steps to state', () => {
      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      const middleware = (ctx: any) => ({ added: true });
      builder.use(middleware);

      assert.strictEqual(state.steps.length, 1);
      assert.strictEqual(state.steps[0].type, 'use');
      assert.strictEqual(state.steps[0].fn, middleware);
    });

    it('.guard() should add steps to state', () => {
      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      const guard = (ctx: any) => {};
      builder.guard(guard);

      assert.strictEqual(state.steps.length, 1);
      assert.strictEqual(state.steps[0].type, 'guard');
      assert.strictEqual(state.steps[0].fn, guard);
    });

    it('.returns() should add to responseSchemas with schema', () => {
      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      const schema = z.object({ message: z.string() });
      builder.returns(200, schema);

      assert.strictEqual(state.responseSchemas.size, 1);
      assert.strictEqual(state.responseSchemas.get(200), schema);
    });

    it('.returns() should add to responseSchemas without schema', () => {
      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      builder.returns(204);

      assert.strictEqual(state.responseSchemas.size, 1);
      assert.strictEqual(state.responseSchemas.get(204), null);
    });

    it('.returns(status, schema, permission) should populate permissionReturns', () => {
      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      const schema = z.object({ name: z.string() });
      const perm = { name: 'fullAccess' } as const;

      builder.returns(200, schema, perm);

      assert.ok(state.permissionReturns);
      assert.strictEqual(state.permissionReturns.length, 1);
      assert.strictEqual(state.permissionReturns[0].status, 200);
      assert.strictEqual(state.permissionReturns[0].schema, schema);
      assert.strictEqual(state.permissionReturns[0].permission, perm);
    });

    it('multiple permission-scoped .returns() on same status accumulate', () => {
      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      const fullSchema = z.object({ name: z.string(), salary: z.string() });
      const limitedSchema = z.object({ name: z.string() });
      const fullPerm = { name: 'fullAccess' } as const;
      const viewPerm = { name: 'view' } as const;

      builder
        .returns(200, fullSchema, fullPerm)
        .returns(200, limitedSchema, viewPerm);

      assert.ok(state.permissionReturns);
      assert.strictEqual(state.permissionReturns.length, 2);
      assert.strictEqual(state.permissionReturns[0].permission, fullPerm);
      assert.strictEqual(state.permissionReturns[1].permission, viewPerm);
    });

    it('.handle() carries permissionReturns onto RouteDef', () => {
      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');
      const schema = z.object({ name: z.string() });
      const perm = { name: 'fullAccess' } as const;

      const route = builder
        .returns(200, schema, perm)
        .handle(() => {});

      assert.ok(route.permissionReturns);
      assert.strictEqual(route.permissionReturns.length, 1);
      assert.strictEqual(route.permissionReturns[0].permission, perm);
    });

    it('.handle() omits permissionReturns when no permission-scoped returns', () => {
      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      const route = builder
        .returns(200, z.object({ ok: z.boolean() }))
        .handle(() => {});

      assert.strictEqual(route.permissionReturns, undefined);
    });

    it('.handle() should return RouteDef with copied state', () => {
      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      const middleware = (ctx: any) => ({ added: true });
      const guard = (ctx: any) => {};
      const schema = z.object({ message: z.string() });
      const handler = (ctx: any) => {};

      builder.use(middleware);
      builder.guard(guard);
      builder.returns(200, schema);
      const route = builder.handle(handler);

      // Check route structure
      assert.strictEqual(route.path, '/test');
      assert.strictEqual(route.handler, handler);
      assert.strictEqual(route.steps.length, 2);
      assert.strictEqual(route.responseSchemas.size, 1);

      // Steps should be copied
      assert.notStrictEqual(route.steps, state.steps);
      assert.strictEqual(route.steps[0].type, 'use');
      assert.strictEqual(route.steps[1].type, 'guard');

      // Response schemas should be copied
      assert.notStrictEqual(route.responseSchemas, state.responseSchemas);
      assert.strictEqual(route.responseSchemas.get(200), schema);
    });

    it('should support method chaining', () => {
      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      const route = builder
        .use((ctx) => ({ step1: true }))
        .guard((ctx) => {})
        .use((ctx) => ({ step2: true }))
        .returns(200, z.object({ ok: z.boolean() }))
        .returns(400)
        .handle((ctx) => {});

      assert.strictEqual(route.steps.length, 3);
      assert.strictEqual(route.responseSchemas.size, 2);
    });

    it('should preserve step order', () => {
      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      const use1 = (ctx: any) => ({ use1: true });
      const guard1 = (ctx: any) => {};
      const use2 = (ctx: any) => ({ use2: true });
      const guard2 = (ctx: any) => {};

      const route = builder
        .use(use1)
        .guard(guard1)
        .use(use2)
        .guard(guard2)
        .handle((ctx) => {});

      assert.strictEqual(route.steps[0].type, 'use');
      assert.strictEqual(route.steps[0].fn, use1);
      assert.strictEqual(route.steps[1].type, 'guard');
      assert.strictEqual(route.steps[1].fn, guard1);
      assert.strictEqual(route.steps[2].type, 'use');
      assert.strictEqual(route.steps[2].fn, use2);
      assert.strictEqual(route.steps[3].type, 'guard');
      assert.strictEqual(route.steps[3].fn, guard2);
    });
  });
});

// ============================================================================
// Route Execution Tests
// ============================================================================

describe('Route Execution', () => {
  describe('executeRoute', () => {
    it('should run use() steps and merge context', async () => {
      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      const route = builder
        .use((ctx) => ({ step1: 'value1' }))
        .use((ctx) => ({ step2: 'value2' }))
        .handle((ctx) => {
          // Handler receives merged context
          assert.strictEqual((ctx as any).step1, 'value1');
          assert.strictEqual((ctx as any).step2, 'value2');
        });

      const ctx = { initial: 'data' };
      await executeRoute(route, ctx);

      // Context should be mutated with additions
      assert.strictEqual((ctx as any).initial, 'data');
      assert.strictEqual((ctx as any).step1, 'value1');
      assert.strictEqual((ctx as any).step2, 'value2');
    });

    it('should run guard() steps with stop() injected', async () => {
      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      let hasTestData = false;
      let hasStopFunction = false;
      let stopProducesStopSignal = false;

      const route = builder
        .guard((ctx: any) => {
          hasTestData = ctx.test === 'data';
          hasStopFunction = typeof ctx.stop === 'function';
          if (hasStopFunction) {
            stopProducesStopSignal = isStop(ctx.stop());
          }
        })
        .handle((ctx) => {});

      const ctx = { test: 'data' };
      await executeRoute(route, ctx);

      assert.ok(hasTestData);
      assert.ok(hasStopFunction);
      assert.ok(stopProducesStopSignal);
    });

    it('should stop when guard returns stop signal', async () => {
      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      let handlerCalled = false;
      let use2Called = false;

      const route = builder
        .use((ctx) => ({ step1: true }))
        .guard((ctx) => {
          // First guard stops
          return ctx.stop();
        })
        .use((ctx) => {
          // This should not run
          use2Called = true;
          return { step2: true };
        })
        .handle((ctx) => {
          // Handler should not run
          handlerCalled = true;
        });

      const ctx = {};
      await executeRoute(route, ctx);

      assert.strictEqual(handlerCalled, false);
      assert.strictEqual(use2Called, false);
      assert.strictEqual((ctx as any).step1, true);
    });

    it('should run handler after all steps pass', async () => {
      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      let handlerCalled = false;
      let handlerContext: any = null;

      const route = builder
        .use((ctx) => ({ step1: true }))
        .guard((ctx) => {
          // Guard passes (no stop)
        })
        .use((ctx) => ({ step2: true }))
        .handle((ctx) => {
          handlerCalled = true;
          handlerContext = ctx;
        });

      const ctx = { initial: 'value' };
      await executeRoute(route, ctx);

      assert.strictEqual(handlerCalled, true);
      assert.ok(handlerContext);
      assert.strictEqual(handlerContext.initial, 'value');
      assert.strictEqual(handlerContext.step1, true);
      assert.strictEqual(handlerContext.step2, true);
    });

    it('should run steps in declaration order (use, guard, use)', async () => {
      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      const executionOrder: string[] = [];

      const route = builder
        .use((ctx) => {
          executionOrder.push('use1');
          return { use1: true };
        })
        .guard((ctx) => {
          executionOrder.push('guard1');
        })
        .use((ctx) => {
          executionOrder.push('use2');
          return { use2: true };
        })
        .guard((ctx) => {
          executionOrder.push('guard2');
        })
        .handle((ctx) => {
          executionOrder.push('handler');
        });

      await executeRoute(route, {});

      assert.deepStrictEqual(executionOrder, [
        'use1',
        'guard1',
        'use2',
        'guard2',
        'handler',
      ]);
    });

    it('should support async middleware', async () => {
      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      const route = builder
        .use(async (ctx) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { async1: true };
        })
        .use(async (ctx) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { async2: true };
        })
        .handle((ctx) => {
          assert.strictEqual((ctx as any).async1, true);
          assert.strictEqual((ctx as any).async2, true);
        });

      await executeRoute(route, {});
    });

    it('should support async guards', async () => {
      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      let guardCalled = false;

      const route = builder
        .guard(async (ctx) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          guardCalled = true;
        })
        .handle((ctx) => {});

      await executeRoute(route, {});
      assert.strictEqual(guardCalled, true);
    });

    it('should support async guard that returns stop', async () => {
      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      let handlerCalled = false;

      const route = builder
        .guard(async (ctx: any) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return ctx.stop();
        })
        .handle((ctx) => {
          handlerCalled = true;
        });

      await executeRoute(route, {});
      assert.strictEqual(handlerCalled, false);
    });

    it('should not expose stop() to use middleware', async () => {
      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      let useContext: any = null;

      const route = builder
        .use((ctx) => {
          useContext = ctx;
          return {};
        })
        .handle((ctx) => {});

      await executeRoute(route, {});

      assert.ok(useContext);
      assert.strictEqual(useContext.stop, undefined);
    });

    it('should handle complex interleaved steps', async () => {
      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      const log: string[] = [];

      const route = builder
        .use((ctx) => {
          log.push('use1');
          return { count: 1 };
        })
        .guard((ctx) => {
          log.push('guard1');
          assert.strictEqual((ctx as any).count, 1);
        })
        .use((ctx) => {
          log.push('use2');
          return { count: (ctx as any).count + 1 };
        })
        .guard((ctx) => {
          log.push('guard2');
          assert.strictEqual((ctx as any).count, 2);
        })
        .use((ctx) => {
          log.push('use3');
          return { count: (ctx as any).count + 1 };
        })
        .handle((ctx) => {
          log.push('handler');
          assert.strictEqual((ctx as any).count, 3);
        });

      await executeRoute(route, {});

      assert.deepStrictEqual(log, [
        'use1',
        'guard1',
        'use2',
        'guard2',
        'use3',
        'handler',
      ]);
    });
  });
});

// ============================================================================
// Plugin System Tests
// ============================================================================

describe('Plugin System', () => {
  describe('isPlugin', () => {
    it('should identify plugins', () => {
      const plugin = createPlugin({
        build: () => (builder) => builder,
      });

      assert.strictEqual(isPlugin(plugin), true);
    });

    it('should return false for regular functions', () => {
      const fn = () => {};
      assert.strictEqual(isPlugin(fn), false);
    });

    it('should return false for non-functions', () => {
      assert.strictEqual(isPlugin(null), false);
      assert.strictEqual(isPlugin(undefined), false);
      assert.strictEqual(isPlugin({}), false);
      assert.strictEqual(isPlugin([]), false);
      assert.strictEqual(isPlugin('plugin'), false);
    });

    it('should return false for objects with PLUGIN_SYMBOL set to false', () => {
      const fake = (() => {}) as any;
      fake[PLUGIN_SYMBOL] = false;
      assert.strictEqual(isPlugin(fake), false);
    });
  });

  describe('createPlugin', () => {
    it('should create a plugin with PLUGIN_SYMBOL', () => {
      const plugin = createPlugin({
        build: () => (builder) => builder,
      });

      assert.strictEqual(typeof plugin, 'function');
      assert.strictEqual((plugin as any)[PLUGIN_SYMBOL], true);
    });

    it('should transform builder correctly', () => {
      const plugin = createPlugin({
        build: () => (builder) => {
          return builder
            .use((ctx) => ({ pluginData: true }))
            .guard((ctx) => {});
        },
      });

      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      // Resolve deps (no dependencies in this case)
      (plugin as any).resolve({ resolve: () => null });

      // Apply plugin
      const transformed = builder.apply(plugin);

      // Plugin should have added steps
      assert.strictEqual(state.steps.length, 2);
      assert.strictEqual(state.steps[0].type, 'use');
      assert.strictEqual(state.steps[1].type, 'guard');
    });

    it('should store requirements when inject is provided', () => {
      class TestService {
        getData() {
          return 'test';
        }
      }

      const plugin = createPlugin({
        inject: { service: TestService as any },
        build: ({ service }) => (builder) => builder,
      });

      assert.ok((plugin as any).requirements);
      assert.ok((plugin as any).requirements.service);
    });

    it('should not have requirements when inject is omitted', () => {
      const plugin = createPlugin({
        build: () => (builder) => builder,
      });

      assert.strictEqual((plugin as any).requirements, undefined);
    });

    it('should throw if used before resolve() is called', () => {
      class TestService {
        getData() {
          return 'test';
        }
      }

      const plugin = createPlugin({
        inject: { service: TestService as any },
        build: ({ service }) => (builder) => builder,
      });

      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      // Should throw because resolve not called yet
      assert.throws(
        () => builder.apply(plugin),
        /Plugin dependencies not resolved/
      );
    });

    it('should work after resolve() is called', () => {
      class TestService {
        getData() {
          return 'test';
        }
      }

      const mockContainer = {
        resolve: (token: any) => new TestService(),
      };

      let capturedService: TestService | null = null;

      const plugin = createPlugin({
        inject: { service: TestService as any },
        build: (({ service }: { service: TestService }) => {
          capturedService = service;
          return (builder: ReturnType<typeof createBaseBuilder>) => builder.use((ctx) => ({ fromPlugin: service.getData() }));
        }) as any,
      });

      // Resolve dependencies
      (plugin as any).resolve(mockContainer);

      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      // Now it should work
      builder.apply(plugin);

      assert.ok(capturedService);
      assert.strictEqual((capturedService as any).getData(), 'test');
    });

    it('should support plugins without dependencies', () => {
      const plugin = createPlugin({
        build: () => (builder) => {
          return builder
            .use((ctx) => ({ noDeps: true }))
            .returns(200, z.object({ ok: z.boolean() }));
        },
      });

      // Resolve with empty deps
      (plugin as any).resolve({ resolve: () => null });

      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      builder.apply(plugin).handle((ctx) => {});

      assert.strictEqual(state.steps.length, 1);
      assert.strictEqual(state.responseSchemas.size, 1);
    });

    it('should support chaining multiple plugins', () => {
      const plugin1 = createPlugin({
        build: () => (builder) => builder.use((ctx) => ({ plugin1: true })),
      });

      const plugin2 = createPlugin({
        build: () => (builder) => builder.use((ctx) => ({ plugin2: true })),
      });

      const plugin3 = createPlugin({
        build: () => (builder) => builder.guard((ctx) => {}),
      });

      // Resolve all plugins
      (plugin1 as any).resolve({ resolve: () => null });
      (plugin2 as any).resolve({ resolve: () => null });
      (plugin3 as any).resolve({ resolve: () => null });

      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      builder.apply(plugin1).apply(plugin2).apply(plugin3).handle((ctx) => {});

      assert.strictEqual(state.steps.length, 3);
      assert.strictEqual(state.steps[0].type, 'use');
      assert.strictEqual(state.steps[1].type, 'use');
      assert.strictEqual(state.steps[2].type, 'guard');
    });

    it('should pass dependencies to build function', async () => {
      class AuthService {
        validate(token: string) {
          return token === 'valid-token';
        }
      }

      const mockContainer = {
        resolve: (token: any) => new AuthService(),
      };

      const authPlugin = createPlugin({
        inject: { auth: AuthService as any },
        build: (({ auth }: { auth: AuthService }) => (builder: ReturnType<typeof createBaseBuilder>) => {
          return builder
            .guard((ctx: any) => {
              const token = ctx.token;
              if (!auth.validate(token)) {
                return ctx.stop();
              }
            });
        }) as any,
      });

      // Resolve dependencies
      (authPlugin as any).resolve(mockContainer);

      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');

      let handlerCalled = false;
      const route = builder
        .use((ctx) => ({ token: 'valid-token' }))
        .apply(authPlugin)
        .handle((ctx) => {
          handlerCalled = true;
        });

      await executeRoute(route, {});
      assert.strictEqual(handlerCalled, true);
    });

    it('should resolve multiple dependencies', () => {
      class ServiceA {
        a() {
          return 'a';
        }
      }

      class ServiceB {
        b() {
          return 'b';
        }
      }

      const mockContainer = {
        resolve: (token: any) => {
          if (token === ServiceA) return new ServiceA();
          if (token === ServiceB) return new ServiceB();
          throw new Error('Unknown token');
        },
      };

      let capturedA: any = null;
      let capturedB: any = null;

      const plugin = createPlugin({
        inject: {
          serviceA: ServiceA as any,
          serviceB: ServiceB as any,
        },
        build: ({ serviceA, serviceB }) => {
          capturedA = serviceA;
          capturedB = serviceB;
          return (builder) => builder;
        },
      });

      (plugin as any).resolve(mockContainer);

      const state = createBuilderState();
      const builder = createBaseBuilder(state, '/test');
      builder.apply(plugin);

      assert.ok(capturedA instanceof ServiceA);
      assert.ok(capturedB instanceof ServiceB);
    });
  });
});
