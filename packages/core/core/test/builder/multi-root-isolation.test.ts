/**
 * Multi-root isolation: two separate `JustScale()` apps in the same
 * process don't share DI state.
 *
 * Per CORE_PHILOSOPHY §7, async context (AsyncLocalStorage) is the
 * framework's scope primitive. Two roots boot side-by-side in the same
 * Node process for tests, multi-tenant setups, or embedded workflows.
 *
 * If they shared anything mutable at module-level (per
 * `feedback-no-global-state`), tenant A would see tenant B's cache,
 * tenant A's signals would reach tenant B's processes, etc. — disaster.
 *
 * Properties pinned:
 *
 *   - Two roots give two distinct containers.
 *   - Services resolved through each are distinct instances.
 *   - `JustScale.apps` registry tracks all roots (for graceful shutdown).
 *   - State in one root's service does NOT bleed into the other.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import JustScale from '../../src/justscale.js';
import { defineService } from '../../src/core/service.js';

describe('multi-root isolation', () => {
  it('two roots produce two distinct containers', async () => {
    // INVARIANT: two JustScale() calls never share a container. A
    // module-level container cache would break here.
    const Counter = defineService({
      inject: {},
      factory: () => {
        let n = 0;
        return {
          tick: () => ++n,
          get: () => n,
        };
      },
    });

    const rootA = JustScale().add(Counter).build().compile();
    const rootB = JustScale().add(Counter).build().compile();
    await Promise.all([rootA.ready, rootB.ready]);

    assert.notStrictEqual(rootA.container, rootB.container);
  });

  it('each root resolves its own instance of the same ServiceDef', async () => {
    // INVARIANT: the same ServiceDef resolved through two different
    // containers yields two different instances with independent state.
    // Critical for tests: test A can mutate its Counter without test B
    // seeing it.
    const Counter = defineService({
      inject: {},
      factory: () => {
        let n = 0;
        return {
          tick: () => ++n,
          get: () => n,
        };
      },
    });

    const rootA = JustScale().add(Counter).build().compile();
    const rootB = JustScale().add(Counter).build().compile();
    await Promise.all([rootA.ready, rootB.ready]);

    const a = await rootA.container.resolve(Counter);
    const b = await rootB.container.resolve(Counter);

    assert.notStrictEqual(a, b, 'distinct instances');

    a.tick();
    a.tick();
    a.tick();
    b.tick();

    assert.strictEqual(a.get(), 3);
    assert.strictEqual(b.get(), 1, 'B\'s counter is not affected by A\'s ticks');
  });

  it('JustScale.apps tracks every built root (WeakRefSet)', () => {
    // INVARIANT: the apps registry exists so `JustScale.shutdown()` can
    // gracefully stop every running app. If the registry stopped
    // tracking new builds, `SIGTERM` would leak sockets / connections
    // for un-registered apps.
    //
    // We can't count precisely (other tests in the same process add
    // apps too, and WeakRefSet entries may be GC'd). But we can check
    // that a new build ADDS an entry and that the new entry is present.
    const before = new Set<unknown>();
    for (const a of JustScale.apps) before.add(a);

    const app = JustScale().build();
    let found = false;
    for (const a of JustScale.apps) {
      if (a === app) found = true;
    }
    assert.ok(found, 'new built app is tracked in JustScale.apps');
    assert.ok(!before.has(app), 'the entry was added by this .build() call');
  });

  it('JustScale.shutdown() only stops apps that are .isServing', async () => {
    // INVARIANT: shutdown() iterates apps and filters by isServing.
    // Calling it while no app is serving must not throw.
    // We avoid actually calling serve() — that binds sockets and
    // requires cleanup.
    const app = JustScale().build();
    assert.strictEqual(app.isServing, false);
    // Should resolve without throwing even if many apps exist:
    await JustScale.shutdown();
    // Still not serving, still no harm:
    assert.strictEqual(app.isServing, false);
  });

  it('two roots resolving an abstract token via bindService: no cross-pollution', async () => {
    // INVARIANT: bindService in root A doesn't register anything in
    // root B. Proves there's no hidden module-level binding registry.
    const { defineAbstract } = await import('../../src/core/service.js');
    const { bindService } = await import('../../src/builder/builder.js');

    abstract class AbstractGreeter extends defineAbstract<{
      greet(): string
    }>('AbstractGreeter') {}

    const ImplA = defineService({
      inject: {},
      factory: () => ({ greet: () => 'A' }),
    });
    const ImplB = defineService({
      inject: {},
      factory: () => ({ greet: () => 'B' }),
    });

    const rootA = JustScale()
      .add(ImplA)
      .add(bindService(AbstractGreeter, ImplA))
      .build()
      .compile();
    const rootB = JustScale()
      .add(ImplB)
      .add(bindService(AbstractGreeter, ImplB))
      .build()
      .compile();
    await Promise.all([rootA.ready, rootB.ready]);

    const gA = await rootA.container.resolve(AbstractGreeter);
    const gB = await rootB.container.resolve(AbstractGreeter);

    assert.strictEqual(gA.greet(), 'A');
    assert.strictEqual(gB.greet(), 'B');
    assert.notStrictEqual(gA, gB);
  });
});
