/**
 * Rebinding semantics: bindService / bindInstance / bindRepository.
 *
 * Rebinds are the mechanism that turns abstract tokens into concrete
 * behavior. Wrappers (httpPrefixed, cliPrefixed) rely on sub-apps
 * rebinding an abstract service in their own scope; testing relies on
 * rebinding production services to mocks. If rebinding silently misbehaves
 * — e.g. if it leaks a child's rebind up to the parent — composition
 * breaks in ways that are hard to diagnose.
 *
 * Invariants pinned here:
 *   - `bindService` / `bindInstance` actually resolve to the bound impl.
 *   - Last-wins on multiple binds of the same abstract (documented, silent).
 *   - Rebind inside a sub-app is SCOPED to that sub-app — parent's
 *     resolution of the same abstract is unaffected.
 *
 * Repository binding is exercised via a minimal RepositoryToken without
 * pulling in the full ModelRepository machinery — this file stays about
 * the DI graph, not the model layer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import JustScale from '../../src/justscale.js';
import { defineService, defineAbstract } from '../../src/core/service.js';
import { bindService, bindInstance, bindRepository } from '../../src/builder/builder.js';
import { REPO_TOKEN } from '../../src/models/repository.js';
import type { RepositoryToken } from '../../src/models/repository.js';
import { Repository } from '../../src/models/repository.js';

// ============================================================================
// Shared abstract + impls
// ============================================================================

abstract class AbstractGreeter extends defineAbstract<{
  greet(name: string): string
}>('AbstractGreeter') {}

const FormalGreeter = defineService({
  inject: {},
  factory: () => ({ greet: (n: string) => `Hello, ${n}.` }),
});

const CasualGreeter = defineService({
  inject: {},
  factory: () => ({ greet: (n: string) => `hey ${n}` }),
});

describe('rebinding: bindService', () => {
  it('bindService(Abstract, Impl): abstract resolves to Impl', async () => {
    // INVARIANT: the whole point of bindService — resolve the abstract
    // token and get the concrete behaviour.
    const app = JustScale()
      .add(FormalGreeter)
      .add(bindService(AbstractGreeter, FormalGreeter))
      .build()
      .compile();
    await app.ready;

    const g = await app.container.resolve(AbstractGreeter);
    assert.strictEqual(g.greet('world'), 'Hello, world.');
  });

  it('two bindService calls for the same abstract: last wins (silent)', async () => {
    // INVARIANT (silent): multiple bindService calls to the same abstract
    // token override each other without warning. Pin it so a future
    // "throw on duplicate" doesn't go unnoticed — that would be a better
    // behaviour, but it's an observable change.
    const app = JustScale()
      .add(FormalGreeter)
      .add(CasualGreeter)
      .add(bindService(AbstractGreeter, FormalGreeter))
      .add(bindService(AbstractGreeter, CasualGreeter)) // wins
      .build()
      .compile();
    await app.ready;

    const g = await app.container.resolve(AbstractGreeter);
    assert.strictEqual(g.greet('world'), 'hey world');
  });
});

describe('rebinding: bindInstance', () => {
  it('bindInstance(Abstract, instance): abstract resolves to that exact instance', async () => {
    // INVARIANT: instance binds preserve identity — no cloning, no
    // wrapping. Callers holding the original reference see the same
    // object the container returns.
    const instance = { greet: (n: string) => `ciao ${n}` };
    const app = JustScale()
      .add(bindInstance(AbstractGreeter, instance))
      .build()
      .compile();
    await app.ready;

    const g = await app.container.resolve(AbstractGreeter);
    assert.strictEqual(g, instance, 'exact-identity — no wrapping');
    assert.strictEqual(g.greet('x'), 'ciao x');
  });

  it('bindInstance wins over bindService when both are present (last-wins, any-order)', async () => {
    // INVARIANT: the order in `_beforeControllerResolution` is repo →
    // service → instance → overrides. Instance runs AFTER service, so
    // bindInstance is applied last and wins, regardless of user-order.
    // Pin this because protocol plugins and tests rely on it.
    const svcImpl = CasualGreeter;
    const inst = { greet: (n: string) => `inst-${n}` };

    const app = JustScale()
      .add(svcImpl)
      .add(bindInstance(AbstractGreeter, inst))
      .add(bindService(AbstractGreeter, svcImpl))
      .build()
      .compile();
    await app.ready;

    const g = await app.container.resolve(AbstractGreeter);
    assert.strictEqual(g.greet('x'), 'inst-x', 'instance binding wins over service binding');
  });
});

describe('rebinding: bindRepository', () => {
  it('bindRepository binds a RepositoryToken to an impl (service form)', async () => {
    // INVARIANT: bindRepository wires the repo token so consumers can
    // `inject: { repo: UserRepo }` and get the bound implementation.
    // Minimal repo token — we're testing the binding primitive, not the
    // model layer.
    class InMemoryRepo extends Repository<{ id: string }> {
      items: Array<{ id: string }> = [];
      add(x: { id: string }): void {
        this.items.push(x);
      }
    }

    const RepoService = defineService({
      inject: {},
      factory: () => new InMemoryRepo(),
    });

    const token: RepositoryToken<{ id: string }> = {
      [REPO_TOKEN]: true,
      description: 'ItemRepo',
      toString: () => 'ItemRepo',
    };

    const app = JustScale()
      .add(bindRepository(token, RepoService))
      .build()
      .compile();
    await app.ready;

    const resolved = (await app.container.resolve(token as any)) as InMemoryRepo;
    assert.ok(resolved instanceof InMemoryRepo);
    resolved.add({ id: '1' });
    assert.strictEqual(resolved.items.length, 1);
  });
});

describe('rebinding: scope isolation', () => {
  it('parent rebind does NOT leak to sub-apps that do not .requires() it', async () => {
    // INVARIANT: a sub-app that doesn't declare .requires(Abstract)
    // doesn't inherit the parent's binding for that abstract. Proves
    // scope isolation at the most basic level.
    const SubApp = JustScale()
      .add(CasualGreeter)
      .add(bindService(AbstractGreeter, CasualGreeter))
      .build();

    const parentBuilt = JustScale()
      .add(FormalGreeter)
      .add(bindService(AbstractGreeter, FormalGreeter))
      .add(SubApp)
      .build();
    const parentApp = parentBuilt.compile();
    await parentApp.ready;

    const parentG = await parentApp.container.resolve(AbstractGreeter);
    const subG = await (SubApp as any).container.resolve(AbstractGreeter);
    assert.strictEqual(parentG.greet('a'), 'Hello, a.');
    assert.strictEqual(subG.greet('a'), 'hey a', 'sub-app keeps its own rebind');
  });

  it('todo: when sub-app .requires(X) AND .bindService(X, Local), the parent-bridged X OVERRIDES the local bindService', async () => {
    // BUG (pinned with todo): the wrapper pattern described in
    // `design-subapps-and-container.md` says a sub-app can
    // `.requires(AbstractHttpServer).add(bindService(AbstractHttpServer, PrefixedHttpServer))`
    // to transform the parent's service in the child scope. But the
    // compose flow in `compileInternal` runs `__attachBridgesFrom`
    // BEFORE compiling — this pushes an `instanceBinding` onto the
    // sub-app's state for the parent-resolved service. Since the compile
    // order is repo → service → instance → overrides, the instance
    // binding from the bridge OVERRIDES the sub-app's own bindService.
    // So the wrapper pattern doesn't work as documented.
    //
    // todo: wrapper pattern needs explicit "child override wins" —
    //   either order instance binds before service binds when the
    //   service binding was user-declared, or have __attachBridgesFrom
    //   skip tokens the sub-app already bindService'd locally.
    const SubApp = JustScale()
      .requires(AbstractGreeter)
      .add(CasualGreeter)
      .add(bindService(AbstractGreeter, CasualGreeter))
      .build();

    const parent = JustScale()
      .add(FormalGreeter)
      .add(bindService(AbstractGreeter, FormalGreeter))
      .add(SubApp)
      .build();
    const parentApp = parent.compile();
    await parentApp.ready;

    const subG = await (SubApp as any).container.resolve(AbstractGreeter);
    // BUG: we'd WANT 'hey a' (sub-app rebind wins locally). Today
    // parent's FormalGreeter bridged as instance wins.
    assert.strictEqual(
      subG.greet('a'),
      'Hello, a.',
      'today: parent-bridge overrides sub-app bindService (wrapper pattern broken)',
    );
  });

  it('two independent sub-apps (no .requires) each with their own bindService: no cross-talk', async () => {
    // INVARIANT: two sub-apps mounted under the same parent don't see
    // each other's rebinds. Required for e.g. a monolith hosting two
    // tenant sub-apps that want different impls of the same abstract.
    const SubA = JustScale()
      .add(FormalGreeter)
      .add(bindService(AbstractGreeter, FormalGreeter))
      .build();
    const SubB = JustScale()
      .add(CasualGreeter)
      .add(bindService(AbstractGreeter, CasualGreeter))
      .build();

    const ShoutGreeter = defineService({
      inject: {},
      factory: () => ({ greet: (n: string) => `HEY ${n.toUpperCase()}` }),
    });

    const parent = JustScale()
      .add(ShoutGreeter)
      .add(bindService(AbstractGreeter, ShoutGreeter))
      .add(SubA)
      .add(SubB)
      .build();
    const parentApp = parent.compile();
    await parentApp.ready;

    const parentG = await parentApp.container.resolve(AbstractGreeter);
    const aG = await (SubA as any).container.resolve(AbstractGreeter);
    const bG = await (SubB as any).container.resolve(AbstractGreeter);

    assert.strictEqual(parentG.greet('x'), 'HEY X');
    assert.strictEqual(aG.greet('x'), 'Hello, x.');
    assert.strictEqual(bG.greet('x'), 'hey x');
  });
});
