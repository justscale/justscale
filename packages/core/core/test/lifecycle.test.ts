/**
 * Lifecycle Service Tests
 *
 * Tests for the Lifecycle service including:
 * - LifecycleImpl unit tests (register, runHook, LIFO order)
 * - Error isolation in handlers
 * - Integration with JustScale() app
 * - Builder .override() method
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import JustScale, { defineService, Lifecycle, getServiceId, SERVICE_STABLE_ID } from '../src/index.js';
import { LifecycleImpl } from '../src/core/lifecycle-impl.js';
import { InMemoryLockFeature } from '../src/features/memory/index.js';
import { InMemoryProcessFeature } from '../src/process/index.js';

// Module augmentation to add a test hook (simulating what @justscale/http does)
declare module '../src/index.js' {
  interface LifecycleHooks {
    testServing(): Promise<void> | void
  }
}

// ============================================================================
// LifecycleImpl Unit Tests
// ============================================================================

describe('LifecycleImpl', () => {
  describe('register()', () => {
    it('should register a stop handler', async () => {
      const lifecycle = new LifecycleImpl();
      let called = false;

      lifecycle.register('stop', () => {
        called = true;
      });

      await lifecycle.runHook('stop');
      assert.strictEqual(called, true);
    });

    it('should register multiple handlers for the same hook', async () => {
      const lifecycle = new LifecycleImpl();
      const calls: number[] = [];

      lifecycle.register('stop', () => { calls.push(1); });
      lifecycle.register('stop', () => { calls.push(2); });
      lifecycle.register('stop', () => { calls.push(3); });

      await lifecycle.runHook('stop');
      assert.strictEqual(calls.length, 3);
    });

    it('should throw when registering during the same hook execution', async () => {
      const lifecycle = new LifecycleImpl();

      lifecycle.register('stop', () => {
        // Try to register during stop - should throw
        assert.throws(
          () => lifecycle.register('stop', () => {}),
          /Cannot register 'stop' handler while 'stop' phase is running/
        );
      });

      await lifecycle.runHook('stop');
    });
  });

  describe('isInPhase()', () => {
    it('should return false when no hook is running', () => {
      const lifecycle = new LifecycleImpl();
      assert.strictEqual(lifecycle.isInPhase('stop'), false);
    });

    it('should return true during hook execution', async () => {
      const lifecycle = new LifecycleImpl();
      let wasInPhase = false;

      lifecycle.register('stop', () => {
        wasInPhase = lifecycle.isInPhase('stop');
      });

      await lifecycle.runHook('stop');
      assert.strictEqual(wasInPhase, true);
    });

    it('should return false after hook completes', async () => {
      const lifecycle = new LifecycleImpl();
      lifecycle.register('stop', () => {});

      await lifecycle.runHook('stop');
      assert.strictEqual(lifecycle.isInPhase('stop'), false);
    });
  });

  describe('runHook()', () => {
    it('should run stop handlers in LIFO order', async () => {
      const lifecycle = new LifecycleImpl();
      const order: string[] = [];

      lifecycle.register('stop', () => { order.push('first'); });
      lifecycle.register('stop', () => { order.push('second'); });
      lifecycle.register('stop', () => { order.push('third'); });

      await lifecycle.runHook('stop');

      // LIFO: last registered runs first
      assert.deepStrictEqual(order, ['third', 'second', 'first']);
    });

    it('should handle async handlers', async () => {
      const lifecycle = new LifecycleImpl();
      const order: string[] = [];

      lifecycle.register('stop', async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push('async1');
      });
      lifecycle.register('stop', async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push('async2');
      });

      await lifecycle.runHook('stop');

      // LIFO order, async2 was registered last
      assert.deepStrictEqual(order, ['async2', 'async1']);
    });

    it('should continue running handlers after one throws', async () => {
      const lifecycle = new LifecycleImpl();
      const calls: string[] = [];

      lifecycle.register('stop', () => { calls.push('first'); });
      lifecycle.register('stop', () => {
        throw new Error('Handler error');
      });
      lifecycle.register('stop', () => { calls.push('third'); });

      // Capture console.error to suppress expected error output
      const originalError = console.error;
      console.error = () => {};

      await lifecycle.runHook('stop');

      console.error = originalError;

      // All handlers should have been called (error in middle doesn't stop others)
      // LIFO order: third, error, first
      assert.deepStrictEqual(calls, ['third', 'first']);
    });

    it('should run no handlers if none registered', async () => {
      const lifecycle = new LifecycleImpl();
      // Should not throw
      await lifecycle.runHook('stop');
    });

    // Existing test covers 1 throw mid-chain. The hardening cases below
    // pin behavior the audit flagged as untested.

    it('should run ALL remaining handlers when MULTIPLE throw', async () => {
      const lifecycle = new LifecycleImpl();
      const calls: string[] = [];
      const errors = new Set<string>();
      const origError = console.error;
      console.error = (..._args: unknown[]) => {
        // Capture which handler errors got logged so we can assert all
        // throws were observed (not just the first).
        for (const a of _args) {
          if (a instanceof Error) errors.add(a.message);
        }
      };

      lifecycle.register('stop', () => { calls.push('a'); });
      lifecycle.register('stop', () => { throw new Error('boom-b'); });
      lifecycle.register('stop', () => { calls.push('c'); });
      lifecycle.register('stop', () => { throw new Error('boom-d'); });
      lifecycle.register('stop', () => { calls.push('e'); });

      await lifecycle.runHook('stop');
      console.error = origError;

      // LIFO: e, throw-d, c, throw-b, a — all non-throwing handlers ran.
      assert.deepStrictEqual(calls, ['e', 'c', 'a']);
      // Both errors surfaced (no early-return after first).
      assert.ok(errors.has('boom-b'), 'first error should be logged');
      assert.ok(errors.has('boom-d'), 'second error should be logged');
    });

    it('should reset currentPhase when ALL handlers throw', async () => {
      const lifecycle = new LifecycleImpl();
      const origError = console.error;
      console.error = () => {};

      lifecycle.register('stop', () => { throw new Error('a'); });
      lifecycle.register('stop', () => { throw new Error('b'); });

      await lifecycle.runHook('stop');
      console.error = origError;

      // currentPhase must come back to null even though every handler threw,
      // otherwise the next runHook call would think we're still in stop.
      assert.strictEqual(lifecycle.isInPhase('stop'), false);
    });

    it('should not crash when a handler throws synchronously inside an async function', async () => {
      const lifecycle = new LifecycleImpl();
      const origError = console.error;
      console.error = () => {};

      lifecycle.register('stop', async () => {
        // sync throw inside async → becomes rejected promise → must be caught
        throw new Error('sync-in-async');
      });

      // Must not propagate.
      await assert.doesNotReject(() => lifecycle.runHook('stop'));
      console.error = origError;
      assert.strictEqual(lifecycle.isInPhase('stop'), false);
    });
  });
});

// ============================================================================
// JustScale Integration Tests
// ============================================================================

describe('Lifecycle Integration', () => {
  describe('Lifecycle injection', () => {
    it('should inject Lifecycle into services', async () => {
      let injectedLifecycle: Lifecycle | undefined;

      class TestService extends defineService({
        inject: { lifecycle: Lifecycle },
        factory: ({ lifecycle }) => {
          injectedLifecycle = lifecycle;
          return { ok: true };
        },
      }) {}

      const app = JustScale()
        .add(InMemoryLockFeature)
        .add(InMemoryProcessFeature)
        .add(TestService)
        .build();

      await app.container.resolve(TestService);

      assert.ok(injectedLifecycle, 'Lifecycle should be injected');
      assert.strictEqual(typeof injectedLifecycle!.register, 'function');
      assert.strictEqual(typeof injectedLifecycle!.isInPhase, 'function');
    });
  });

  describe('app.stop() lifecycle hooks', () => {
    it('should call stop hooks when app.stop() is called', async () => {
      let stopCalled = false;

      class TestService extends defineService({
        inject: { lifecycle: Lifecycle },
        factory: ({ lifecycle }) => {
          lifecycle.register('stop', () => {
            stopCalled = true;
          });
          return { ok: true };
        },
      }) {}

      const app = JustScale()
        .add(InMemoryLockFeature)
        .add(InMemoryProcessFeature)
        .add(TestService)
        .build();

      await app.container.resolve(TestService);
      await app.stop();

      assert.strictEqual(stopCalled, true);
    });

    it('should call stop hooks in LIFO order across services', async () => {
      const order: string[] = [];

      class ServiceA extends defineService({
        inject: { lifecycle: Lifecycle },
        factory: ({ lifecycle }) => {
          lifecycle.register('stop', () => { order.push('A'); });
          return { name: 'A' };
        },
      }) {}

      class ServiceB extends defineService({
        inject: { lifecycle: Lifecycle, a: ServiceA },
        factory: ({ lifecycle }) => {
          lifecycle.register('stop', () => { order.push('B'); });
          return { name: 'B' };
        },
      }) {}

      const app = JustScale()
        .add(InMemoryLockFeature)
        .add(InMemoryProcessFeature)
        .add(ServiceA)
        .add(ServiceB)
        .build();

      // Resolve B which will also resolve A
      await app.container.resolve(ServiceB);
      await app.stop();

      // A registered first (as dependency), B registered second
      // LIFO: B stops first, then A
      assert.deepStrictEqual(order, ['B', 'A']);
    });
  });
});

// ============================================================================
// Custom Lifecycle Hooks (Module Augmentation) Tests
// ============================================================================

describe('Custom Lifecycle Hooks (Module Augmentation)', () => {
  it('should run non-stop hooks in FIFO order', async () => {
    const lifecycle = new LifecycleImpl();
    const order: string[] = [];

    // testServing is added via module augmentation at top of file
    // (simulating what @justscale/http does with httpServing)
    lifecycle.register('testServing', () => { order.push('first'); });
    lifecycle.register('testServing', () => { order.push('second'); });
    lifecycle.register('testServing', () => { order.push('third'); });

    await lifecycle.runHook('testServing');

    // Non-stop hooks use FIFO order
    assert.deepStrictEqual(order, ['first', 'second', 'third']);
  });

  it('should handle mixed stop and custom hooks correctly', async () => {
    const lifecycle = new LifecycleImpl();
    const stopOrder: string[] = [];
    const servingOrder: string[] = [];

    lifecycle.register('stop', () => { stopOrder.push('A'); });
    lifecycle.register('testServing', () => { servingOrder.push('1'); });
    lifecycle.register('stop', () => { stopOrder.push('B'); });
    lifecycle.register('testServing', () => { servingOrder.push('2'); });

    await lifecycle.runHook('testServing');
    await lifecycle.runHook('stop');

    // testServing: FIFO (non-stop hooks)
    assert.deepStrictEqual(servingOrder, ['1', '2']);
    // stop: LIFO
    assert.deepStrictEqual(stopOrder, ['B', 'A']);
  });
});

// ============================================================================
// Builder .override() Tests
// ============================================================================

describe('Builder .override()', () => {
  it('should override a service with a custom implementation', async () => {
    class OriginalService extends defineService({
      inject: {},
      factory: () => ({ value: 'original' }),
    }) {}

    class CustomService extends defineService({
      inject: {},
      factory: () => ({ value: 'custom' }),
    }) {}

    class ConsumerService extends defineService({
      inject: { original: OriginalService },
      factory: ({ original }) => ({ consumed: original.value }),
    }) {}

    const app = JustScale()
      .add(InMemoryLockFeature)
      .add(InMemoryProcessFeature)
      .add(OriginalService)
      .add(ConsumerService)
      .override(OriginalService, CustomService)
      .build();

    const consumer = await app.container.resolve(ConsumerService);

    // Consumer should get the overridden service
    assert.strictEqual(consumer.consumed, 'custom');
  });

  it('should allow overriding with bindService pattern', async () => {
    class ConcreteServiceA extends defineService({
      inject: {},
      factory: () => ({
        getValue: () => 'A',
      }),
    }) {}

    class ConcreteServiceB extends defineService({
      inject: {},
      factory: () => ({
        getValue: () => 'B',
      }),
    }) {}

    class ConsumerService extends defineService({
      inject: { svc: ConcreteServiceA },
      factory: ({ svc }) => ({
        result: svc.getValue(),
      }),
    }) {}

    const app = JustScale()
      .add(InMemoryLockFeature)
      .add(InMemoryProcessFeature)
      .add(ConcreteServiceA)
      .add(ConsumerService)
      // Override ConcreteServiceA with ConcreteServiceB
      .add(ConcreteServiceB)
      .override(ConcreteServiceA, ConcreteServiceB)
      .build();

    const consumer = await app.container.resolve(ConsumerService);

    // Consumer should get the overridden service (B)
    assert.strictEqual(consumer.result, 'B');
  });
});

// ============================================================================
// Hot Reload (HMR) Tests
// ============================================================================

describe('Hot Reload Support', () => {
  describe('LifecycleImpl hotReload handlers', () => {
    it('should register hotReload handler with service context', async () => {
      const lifecycle = new LifecycleImpl();
      const serviceId = 'test/service.ts#TestService';

      lifecycle.setServiceContext(serviceId);
      lifecycle.register('hotReload', () => ({ preserved: true }));
      lifecycle.setServiceContext(null);

      assert.strictEqual(lifecycle.hasHotReloadHandler(serviceId), true);
    });

    it('should not register hotReload handler without service context', async () => {
      const lifecycle = new LifecycleImpl();

      // Capture console.warn
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (msg: string) => warnings.push(msg);

      lifecycle.register('hotReload', () => ({ preserved: true }));

      console.warn = originalWarn;

      assert.strictEqual(warnings.length, 1);
      assert.ok(warnings[0].includes('hotReload handler registered without service context'));
    });

    it('should run hotReload handler and return state', async () => {
      const lifecycle = new LifecycleImpl();
      const serviceId = 'test/service.ts#TestService';

      lifecycle.setServiceContext(serviceId);
      lifecycle.register('hotReload', () => ({
        cache: new Map([['key', 'value']]),
        counter: 42,
      }));
      lifecycle.setServiceContext(null);

      const state = await lifecycle.runHotReload(serviceId) as any;

      assert.ok(state);
      assert.strictEqual(state.counter, 42);
      assert.strictEqual(state.cache.get('key'), 'value');
    });

    it('should return undefined for service without hotReload handler', async () => {
      const lifecycle = new LifecycleImpl();

      const state = await lifecycle.runHotReload('nonexistent/service.ts#X');

      assert.strictEqual(state, undefined);
    });

    it('should handle errors in hotReload handler', async () => {
      const lifecycle = new LifecycleImpl();
      const serviceId = 'test/service.ts#ErrorService';

      lifecycle.setServiceContext(serviceId);
      lifecycle.register('hotReload', () => {
        throw new Error('State extraction failed');
      });
      lifecycle.setServiceContext(null);

      // Capture console.error
      const originalError = console.error;
      console.error = () => {};

      const state = await lifecycle.runHotReload(serviceId);

      console.error = originalError;

      // Should return undefined on error, not throw
      assert.strictEqual(state, undefined);
    });

    it('should clear hotReload handler', async () => {
      const lifecycle = new LifecycleImpl();
      const serviceId = 'test/service.ts#TestService';

      lifecycle.setServiceContext(serviceId);
      lifecycle.register('hotReload', () => ({}));
      lifecycle.setServiceContext(null);

      assert.strictEqual(lifecycle.hasHotReloadHandler(serviceId), true);

      lifecycle.clearHotReloadHandler(serviceId);

      assert.strictEqual(lifecycle.hasHotReloadHandler(serviceId), false);
    });
  });

  describe('getServiceId()', () => {
    it('should return stable ID if present', () => {
      class TestService extends defineService({
        inject: {},
        factory: () => ({}),
        __serviceId: 'src/services/test.ts#TestService',
      }) {}

      const id = getServiceId(TestService);
      assert.strictEqual(id, 'src/services/test.ts#TestService');
    });

    it('should fall back to counter-based ID if no stable ID', () => {
      class TestService extends defineService({
        inject: {},
        factory: () => ({}),
      }) {}

      const id = getServiceId(TestService);
      // Falls back to class name + counter-based ID
      assert.ok(id.includes('#'), `Expected 'Name#X' pattern but got '${id}'`);
      assert.ok(/^.+#\d+$/.test(id), `Expected 'Name#X' pattern but got '${id}'`);
    });
  });

  describe('Container hotReload', () => {
    it('should store HMR state during full reload', async () => {
      let hotReloadCalled = false;
      const preservedData = { cache: ['item1', 'item2'], count: 5 };

      class CacheService extends defineService({
        inject: { lifecycle: Lifecycle },
        __serviceId: 'src/cache.ts#CacheService',
        factory: ({ lifecycle }) => {
          lifecycle.register('hotReload', () => {
            hotReloadCalled = true;
            return preservedData;
          });
          return { items: [] as string[] };
        },
      }) {}

      const app = JustScale()
        .add(InMemoryLockFeature)
        .add(InMemoryProcessFeature)
        .add(CacheService)
        .build();

      // Resolve to trigger factory
      await app.container.resolve(CacheService);

      // Trigger full reload
      await app.container.hotReload('src/cache.ts#CacheService', 'full-reload');

      assert.strictEqual(hotReloadCalled, true);

      // State should be in registry
      assert.strictEqual(app.container.hasHmrState('src/cache.ts#CacheService'), true);

      // Get state clears it
      const state = app.container.getHmrState('src/cache.ts#CacheService');
      assert.deepStrictEqual(state, preservedData);
      assert.strictEqual(app.container.hasHmrState('src/cache.ts#CacheService'), false);
    });

    it('should patch methods in place during method-patch mode', async () => {
      class CounterService extends defineService({
        inject: {},
        __serviceId: 'src/counter.ts#CounterService',
        factory: () => {
          let count = 0;
          return {
            increment: () => ++count,
            getCount: () => count,
          };
        },
      }) {}

      const app = JustScale()
        .add(InMemoryLockFeature)
        .add(InMemoryProcessFeature)
        .add(CounterService)
        .build();

      const service = await app.container.resolve(CounterService);

      // Use the service to build up state
      service.increment();
      service.increment();
      assert.strictEqual(service.getCount(), 2);

      // Trigger method patch (simulates file change where only increment changed)
      // This will re-run factory but only patch the specified method
      await app.container.hotReload('src/counter.ts#CounterService', 'method-patch', ['increment']);

      // The instance reference should be the same
      const serviceAfter = await app.container.resolve(CounterService);
      assert.strictEqual(service, serviceAfter, 'Instance should be the same object');

      // Note: In real HMR, the patched method would come from the new module.
      // Here we just test that the mechanism works - the method was replaced.
      // The actual behavior depends on the factory returning new closures.
    });
  });

  describe('Integration with JustScale app', () => {
    it('should set service context during factory execution', async () => {
      let capturedServiceId: string | null = null;

      class TestService extends defineService({
        inject: { lifecycle: Lifecycle },
        __serviceId: 'src/test.ts#TestService',
        factory: ({ lifecycle }) => {
          // The LifecycleImpl has methods not on the public interface
          capturedServiceId = (lifecycle as LifecycleImpl).getServiceContext();
          return { ok: true };
        },
      }) {}

      const app = JustScale()
        .add(InMemoryLockFeature)
        .add(InMemoryProcessFeature)
        .add(TestService)
        .build();

      await app.container.resolve(TestService);

      // Service context should have been set during factory execution
      assert.strictEqual(capturedServiceId, 'src/test.ts#TestService');
    });
  });
});
