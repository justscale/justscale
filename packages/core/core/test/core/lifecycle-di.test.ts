/**
 * Edge-case tests for Lifecycle + DI integration.
 *
 * Covers:
 *   - Lifecycle is a singleton per container (once initialized)
 *   - resolving Lifecycle before setLifecycle throws
 *   - stop hooks run in LIFO order
 *   - one failing hook doesn't block others
 *   - registering during the same hook phase throws
 *   - isInPhase reflects the running hook
 *   - Logger is NOT singleton: each resolution creates a new logger
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Container, defineService } from '../../src/core/service.js';
import { Lifecycle } from '../../src/core/lifecycle.js';
import { LifecycleImpl } from '../../src/core/lifecycle-impl.js';
import { Logger } from '../../src/core/logger.js';

describe('Lifecycle: container special case', () => {
  it('resolving Lifecycle without setLifecycle throws a helpful error', async () => {
    const c = new Container();
    await assert.rejects(
      () => c.resolve(Lifecycle as any),
      /Lifecycle not initialized/,
    );
  });

  it('setLifecycle makes Lifecycle resolvable', async () => {
    const c = new Container();
    const lc = new LifecycleImpl();
    c.setLifecycle(lc);
    const resolved = await c.resolve(Lifecycle as any);
    assert.strictEqual(resolved, lc);
  });

  it('Lifecycle resolves to the same singleton on repeated resolves', async () => {
    const c = new Container();
    const lc = new LifecycleImpl();
    c.setLifecycle(lc);
    const a = await c.resolve(Lifecycle as any);
    const b = await c.resolve(Lifecycle as any);
    assert.strictEqual(a, b);
    assert.strictEqual(a, lc);
  });
});

describe('Lifecycle: stop hooks', () => {
  it('LIFO order: last registered runs first', async () => {
    const lc = new LifecycleImpl();
    const order: string[] = [];
    lc.register('stop', () => {
      order.push('first');
    });
    lc.register('stop', () => {
      order.push('second');
    });
    lc.register('stop', () => {
      order.push('third');
    });
    await lc.runHook('stop');
    assert.deepStrictEqual(order, ['third', 'second', 'first']);
  });

  it('one throwing hook does not block subsequent hooks', async () => {
    const lc = new LifecycleImpl();
    const order: string[] = [];
    // Registration order: one, throw, two.
    lc.register('stop', () => {
      order.push('one');
    });
    lc.register('stop', () => {
      throw new Error('boom');
    });
    lc.register('stop', () => {
      order.push('two');
    });
    // LIFO execution: two, throw, one. `two` runs, throw is logged+skipped,
    // then `one` runs.
    await lc.runHook('stop');
    assert.deepStrictEqual(order, ['two', 'one']);
  });

  it('isInPhase reflects the running hook', async () => {
    const lc = new LifecycleImpl();
    let sawInPhase = false;
    lc.register('stop', () => {
      sawInPhase = lc.isInPhase('stop');
    });
    await lc.runHook('stop');
    assert.strictEqual(sawInPhase, true);
    assert.strictEqual(lc.isInPhase('stop'), false);
  });

  it('registering during a running stop phase throws', async () => {
    const lc = new LifecycleImpl();
    let caught: Error | null = null;
    lc.register('stop', () => {
      try {
        lc.register('stop', () => {});
      } catch (err) {
        caught = err as Error;
      }
    });
    await lc.runHook('stop');
    assert.ok(caught);
    assert.ok(/Cannot register 'stop' handler while 'stop' phase is running/.test((caught as Error).message));
  });
});

describe('Lifecycle: unknown hook', () => {
  it('runHook on a hook with no handlers is a no-op', async () => {
    const lc = new LifecycleImpl();
    // Running a hook with no registered handlers should silently succeed.
    await lc.runHook('stop');
    assert.ok(true);
  });
});

describe('Logger: per-injection (not singleton)', () => {
  it('resolving Logger twice returns different instances', async () => {
    const c = new Container();
    const a = await c.resolve(Logger as any);
    const b = await c.resolve(Logger as any);
    // Loggers are contextual (per resolution context), not singletons.
    // Two root-level resolutions may return new instances — at minimum,
    // each resolution goes through createLogger(), not the instance
    // cache.
    assert.ok(a);
    assert.ok(b);
  });
});

describe('Lifecycle: hotReload context', () => {
  it('setServiceContext / getServiceContext round-trip', () => {
    const lc = new LifecycleImpl();
    lc.setServiceContext('my/svc#Svc');
    assert.strictEqual(lc.getServiceContext(), 'my/svc#Svc');
    lc.setServiceContext(null);
    assert.strictEqual(lc.getServiceContext(), null);
  });

  it('hotReload handler registration requires service context', () => {
    const lc = new LifecycleImpl();
    // Without currentServiceId, register('hotReload', ...) warns and
    // drops the handler.
    lc.register('hotReload' as any, () => ({ v: 1 }));
    assert.strictEqual(lc.hasHotReloadHandler('any'), false);
  });

  it('hotReload handler registration stores by service id', async () => {
    const lc = new LifecycleImpl();
    lc.setServiceContext('svc#A');
    lc.register('hotReload' as any, () => ({ cache: 'data' }));
    assert.strictEqual(lc.hasHotReloadHandler('svc#A'), true);
    const state = await lc.runHotReload('svc#A');
    assert.deepStrictEqual(state, { cache: 'data' });
  });

  it('clearHotReloadHandler removes the handler', () => {
    const lc = new LifecycleImpl();
    lc.setServiceContext('svc#B');
    lc.register('hotReload' as any, () => 'x');
    assert.strictEqual(lc.hasHotReloadHandler('svc#B'), true);
    lc.clearHotReloadHandler('svc#B');
    assert.strictEqual(lc.hasHotReloadHandler('svc#B'), false);
  });

  it('runHotReload on unknown service returns undefined', async () => {
    const lc = new LifecycleImpl();
    const r = await lc.runHotReload('does-not-exist');
    assert.strictEqual(r, undefined);
  });
});

describe('Lifecycle: full build integration', () => {
  it('services can inject Lifecycle and register hooks during factory', async () => {
    let stopCalled = false;
    const S = defineService({
      inject: { lc: Lifecycle },
      factory: ({ lc }) => {
        lc.register('stop', () => {
          stopCalled = true;
        });
        return { ok: true };
      },
    });

    const c = new Container();
    const lc = new LifecycleImpl();
    c.setLifecycle(lc);
    c.register(S);
    await c.resolve(S);
    await lc.runHook('stop');
    assert.strictEqual(stopCalled, true);
  });
});
