/**
 * Tests for service instantiation behavior
 *
 * Ensures that ALL registered services get instantiated during app startup,
 * even if they're not dependencies of any controller. This is important for
 * services that provide side effects like hooks, listeners, seeders, etc.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import JustScale from '../src/justscale.js';
import { defineService } from '../src/core/service.js';
import { createController } from '../src/core/controller.js';
import { Lifecycle } from '../src/core/lifecycle.js';
import type { RouteHandler } from '../src/core/plugin.js';
import type { RouteDef } from '../src/builder/types.js';

// Mock HTTP route builder for testing
function Get<TDeps>(path: string, handler: RouteHandler<TDeps>): RouteDef<any, any, any> {
  return { path, steps: [], responseSchemas: new Map(), handler, method: 'GET' } as any;
}

describe('Service Instantiation on App Startup', () => {
  describe('services without controller dependencies', () => {
    it('should instantiate a service that has no dependents', async () => {
      let serviceInstantiated = false;

      const OrphanService = defineService({
        inject: {},
        factory: () => {
          serviceInstantiated = true;
          return { initialized: true };
        },
      });

      const app = JustScale()
        .add(OrphanService)
        .build();

      // Before app.ready, service may not be instantiated
      assert.strictEqual(serviceInstantiated, false);

      // Wait for app to be ready
      await app.compile().ready;

      // Service should be instantiated now
      assert.strictEqual(serviceInstantiated, true);
    });

    it('should instantiate multiple services without dependents', async () => {
      const instantiated: string[] = [];

      const ServiceA = defineService({
        inject: {},
        factory: () => {
          instantiated.push('A');
          return { name: 'A' };
        },
      });

      const ServiceB = defineService({
        inject: {},
        factory: () => {
          instantiated.push('B');
          return { name: 'B' };
        },
      });

      const ServiceC = defineService({
        inject: {},
        factory: () => {
          instantiated.push('C');
          return { name: 'C' };
        },
      });

      const app = JustScale()
        .add(ServiceA)
        .add(ServiceB)
        .add(ServiceC)
        .build();

      await app.compile().ready;

      // All services should be instantiated
      assert.strictEqual(instantiated.length, 3);
      assert.ok(instantiated.includes('A'));
      assert.ok(instantiated.includes('B'));
      assert.ok(instantiated.includes('C'));
    });

    it('should instantiate defineService services without dependents', async () => {
      let serviceInstantiated = false;

      class StandaloneService extends defineService({
        inject: {},
        factory: () => {
          serviceInstantiated = true;
          return { standalone: true };
        },
      }) {}

      const app = JustScale()
        .add(StandaloneService)
        .build();

      await app.compile().ready;

      assert.strictEqual(serviceInstantiated, true);
    });
  });

  describe('services that register lifecycle hooks', () => {
    it('should instantiate hook-registering service before serve', async () => {
      let hookRegistered = false;
      let hookExecuted = false;

      const HookService = defineService({
        inject: { lifecycle: Lifecycle },
        factory: ({ lifecycle }) => {
          hookRegistered = true;
          lifecycle.register('stop', async () => {
            hookExecuted = true;
          });
          return { registered: true };
        },
      });

      const app = JustScale()
        .add(HookService)
        .build();

      await app.compile().ready;

      // Hook should be registered during app startup
      assert.strictEqual(hookRegistered, true);

      // Stop the app to trigger the hook
      await app.stop();

      assert.strictEqual(hookExecuted, true);
    });

    it('should instantiate multiple hook services', async () => {
      const hooksRegistered: string[] = [];
      const hooksExecuted: string[] = [];

      const HookServiceA = defineService({
        inject: { lifecycle: Lifecycle },
        factory: ({ lifecycle }) => {
          hooksRegistered.push('A');
          lifecycle.register('stop', async () => {
            hooksExecuted.push('A');
          });
          return {};
        },
      });

      const HookServiceB = defineService({
        inject: { lifecycle: Lifecycle },
        factory: ({ lifecycle }) => {
          hooksRegistered.push('B');
          lifecycle.register('stop', async () => {
            hooksExecuted.push('B');
          });
          return {};
        },
      });

      const app = JustScale()
        .add(HookServiceA)
        .add(HookServiceB)
        .build();

      await app.compile().ready;

      // Both hooks should be registered
      assert.strictEqual(hooksRegistered.length, 2);
      assert.ok(hooksRegistered.includes('A'));
      assert.ok(hooksRegistered.includes('B'));

      await app.stop();

      // Both hooks should have executed
      assert.strictEqual(hooksExecuted.length, 2);
    });
  });

  describe('mixed services with and without controller dependencies', () => {
    it('should instantiate both dependent and independent services', async () => {
      const instantiated: string[] = [];

      // Service used by controller
      const UsedService = defineService({
        inject: {},
        factory: () => {
          instantiated.push('UsedService');
          return { used: true };
        },
      });

      // Service NOT used by controller
      const UnusedService = defineService({
        inject: {},
        factory: () => {
          instantiated.push('UnusedService');
          return { unused: true };
        },
      });

      const TestController = createController('/test', {
        inject: { used: UsedService },
        routes: ({ used }) => ({
          get: Get('/', () => {}),
        }),
      });

      const app = JustScale()
        .add(UsedService)
        .add(UnusedService)
        .add(TestController)
        .build();

      await app.compile().ready;

      // Both services should be instantiated
      assert.strictEqual(instantiated.length, 2);
      assert.ok(instantiated.includes('UsedService'));
      assert.ok(instantiated.includes('UnusedService'));
    });

    it('should instantiate background worker service', async () => {
      let workerStarted = false;
      let workerStopped = false;

      // Simulates a background worker that starts on instantiation
      const BackgroundWorkerService = defineService({
        inject: { lifecycle: Lifecycle },
        factory: ({ lifecycle }) => {
          workerStarted = true;

          // Register cleanup
          lifecycle.register('stop', async () => {
            workerStopped = true;
          });

          return {
            isRunning: () => workerStarted && !workerStopped,
          };
        },
      });

      // A controller that doesn't use the worker
      const ApiController = createController('/api', {
        inject: {},
        routes: () => ({
          health: Get('/health', () => {}),
        }),
      });

      const app = JustScale()
        .add(BackgroundWorkerService)
        .add(ApiController)
        .build();

      await app.compile().ready;

      // Worker should have started
      assert.strictEqual(workerStarted, true);

      await app.stop();

      // Worker should have stopped
      assert.strictEqual(workerStopped, true);
    });
  });

  describe('service with async factory', () => {
    it('should await async service factory', async () => {
      let asyncServiceResolved = false;

      const AsyncService = defineService({
        inject: {},
        factory: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          asyncServiceResolved = true;
          return { async: true };
        },
      });

      const app = JustScale()
        .add(AsyncService)
        .build();

      await app.compile().ready;

      assert.strictEqual(asyncServiceResolved, true);
    });

    it('should instantiate async services without dependents', async () => {
      const instantiated: string[] = [];

      const AsyncServiceA = defineService({
        inject: {},
        factory: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          instantiated.push('A');
          return { name: 'A' };
        },
      });

      const AsyncServiceB = defineService({
        inject: {},
        factory: async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          instantiated.push('B');
          return { name: 'B' };
        },
      });

      const app = JustScale()
        .add(AsyncServiceA)
        .add(AsyncServiceB)
        .build();

      await app.compile().ready;

      assert.strictEqual(instantiated.length, 2);
      assert.ok(instantiated.includes('A'));
      assert.ok(instantiated.includes('B'));
    });
  });

  describe('service singleton behavior', () => {
    it('should not re-instantiate services already resolved by controllers', async () => {
      let instantiationCount = 0;

      const SharedService = defineService({
        inject: {},
        factory: () => {
          instantiationCount++;
          return { count: instantiationCount };
        },
      });

      const ControllerA = createController('/a', {
        inject: { shared: SharedService },
        routes: ({ shared }) => ({
          get: Get('/', () => {}),
        }),
      });

      const ControllerB = createController('/b', {
        inject: { shared: SharedService },
        routes: ({ shared }) => ({
          get: Get('/', () => {}),
        }),
      });

      const app = JustScale()
        .add(SharedService)
        .add(ControllerA)
        .add(ControllerB)
        .build();

      await app.compile().ready;

      // Service should only be instantiated once despite:
      // 1. Being used by ControllerA
      // 2. Being used by ControllerB
      // 3. resolveAll() being called
      assert.strictEqual(instantiationCount, 1);
    });

    it('should maintain singleton across resolve calls', async () => {
      let instanceId = 0;

      const SingletonService = defineService({
        inject: {},
        factory: () => {
          return { id: ++instanceId };
        },
      });

      const app = JustScale()
        .add(SingletonService)
        .build();

      await app.compile().ready;

      // Resolve multiple times using container directly
      const container = app.compile().container;
      const instance1 = await container.resolve(SingletonService);
      const instance2 = await container.resolve(SingletonService);
      const instance3 = await container.resolve(SingletonService);

      // All should be the same instance
      assert.strictEqual(instance1.id, instance2.id);
      assert.strictEqual(instance2.id, instance3.id);
      assert.strictEqual(instanceId, 1);
    });
  });

  describe('service dependency chains', () => {
    it('should instantiate full dependency chain for orphan service', async () => {
      const instantiated: string[] = [];

      const BaseService = defineService({
        inject: {},
        factory: () => {
          instantiated.push('Base');
          return { base: true };
        },
      });

      const MiddleService = defineService({
        inject: { base: BaseService },
        factory: ({ base }) => {
          instantiated.push('Middle');
          return { middle: true, base };
        },
      });

      // Top service has no dependents (orphan)
      const TopService = defineService({
        inject: { middle: MiddleService },
        factory: ({ middle }) => {
          instantiated.push('Top');
          return { top: true, middle };
        },
      });

      const app = JustScale()
        .add(BaseService)
        .add(MiddleService)
        .add(TopService)
        .build();

      await app.compile().ready;

      // All services in the chain should be instantiated
      assert.strictEqual(instantiated.length, 3);
      assert.ok(instantiated.includes('Base'));
      assert.ok(instantiated.includes('Middle'));
      assert.ok(instantiated.includes('Top'));
    });
  });
});
