/**
 * createContribution + multi-impl abstract tokens.
 *
 * `defineContribution<T>` declares an abstract token that accepts
 * multiple self-registering implementations. At boot the framework
 * auto-registers a default aggregator; each `createContribution(T, {...})`
 * injects the aggregator, calls its register(), and returns the impl.
 *
 * This is where the DI graph gets interesting: the contribution service
 * declares a SPECIAL dep (`__contributionParent`) that causes the
 * builder to auto-register the default aggregator. If that auto-register
 * mechanic breaks, users who just `.add(MyContribution)` without also
 * adding the aggregator get a silent empty-list behavior.
 *
 * Pinned here:
 *   - Auto-registration of the default aggregator on first
 *     `.add(contribution)`.
 *   - Multiple contributions aggregate correctly.
 *   - `bindService(AbstractContribution, MonolithicImpl)` wins — the
 *     default aggregator is skipped, and contributions bound after are
 *     silently dropped (documented footgun).
 *   - Scope: a contribution added to a sub-app doesn't auto-bleed
 *     into the parent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import JustScale from '../../src/justscale.js';
import {
  defineContribution,
  createContribution,
} from '../../src/core/contribution.js';
import { defineService, defineAbstract } from '../../src/core/service.js';
import { bindService } from '../../src/builder/builder.js';

// Shared contribution token used by every test.
interface Greeting {
  greet(name: string): string
}

abstract class AbstractGreetings extends defineContribution<Greeting>(
  'AbstractGreetings',
  {
    aggregate: (contribs) => ({
      greet(name: string) {
        return contribs.map((c) => c.greet(name)).join(' | ');
      },
    }),
  },
) {}

describe('feature graph: contributions', () => {
  it('adding a single contribution auto-registers the default aggregator', async () => {
    // INVARIANT: the user only types `.add(MyContribution)`; the framework
    // takes care of binding the default aggregator. Without this, the
    // first `.add(contribution)` would blow up with "no provider for
    // AbstractGreetings" because nothing registered the parent.
    const FormalGreeting = createContribution(AbstractGreetings, {
      inject: {},
      factory: () => ({ greet: (n) => `Hello ${n}.` }),
    });

    const app = JustScale().add(FormalGreeting).build().compile();
    await app.ready;

    const agg = await app.container.resolve(AbstractGreetings);
    assert.strictEqual(agg.greet('world'), 'Hello world.');
  });

  it('multiple contributions are aggregated in add-order', async () => {
    // INVARIANT: `aggregate` receives contributions in insertion order
    // (i.e. the order they were .add()-ed and resolved). Order-sensitive
    // aggregators (middleware chains, principal resolvers, etc.) depend
    // on this. If a future change makes ordering non-deterministic,
    // behavior silently drifts.
    const Formal = createContribution(AbstractGreetings, {
      inject: {},
      factory: () => ({ greet: (n) => `Hello ${n}.` }),
    });
    const Casual = createContribution(AbstractGreetings, {
      inject: {},
      factory: () => ({ greet: (n) => `hey ${n}` }),
    });

    const app = JustScale().add(Formal).add(Casual).build().compile();
    await app.ready;
    // Resolve contributions so they register with the aggregator.
    // (The container resolves on-demand — `.resolve(AbstractGreetings)`
    // alone won't pull the contributions in. This is a subtle behavior
    // worth pinning: contributions must be reachable from something
    // that gets resolved.)
    await app.container.resolve(Formal);
    await app.container.resolve(Casual);

    const agg = await app.container.resolve(AbstractGreetings);
    assert.strictEqual(agg.greet('x'), 'Hello x. | hey x');
  });

  it('bindService(AbstractGreetings, Monolith): replaces the default aggregator; contributions silently dropped', async () => {
    // INVARIANT (documented footgun): if a user both adds contributions
    // AND binds a monolithic impl of the abstract, the monolith wins
    // and the contributions never end up in an aggregator. The
    // contributions' factories still run, but their .register() calls
    // hit the MONOLITH, not the aggregator — and the monolith is
    // expected to ignore .register() (it's an internal concern).
    //
    // todo: this is a user footgun with no warning. Either (a) throw
    //   when both paths are active, or (b) let the monolith opt-in to
    //   receiving .register() calls. For now, pin the silent-drop.
    const Formal = createContribution(AbstractGreetings, {
      inject: {},
      factory: () => ({ greet: (n) => `Hello ${n}.` }),
    });

    const MonolithImpl = defineService({
      inject: {},
      factory: () => ({
        greet: (n: string) => `[monolith] ${n}`,
        register: () => { /* ignored */ },
      }),
    });

    const app = JustScale()
      .add(Formal)
      .add(MonolithImpl)
      .add(bindService(AbstractGreetings as any, MonolithImpl))
      .build()
      .compile();
    await app.ready;

    const agg = await app.container.resolve(AbstractGreetings);
    // Monolith wins — contribution not present in output.
    assert.strictEqual(agg.greet('x'), '[monolith] x');
  });

  it('contribution in a sub-app does not auto-register a parent aggregator', async () => {
    // INVARIANT: auto-registration happens in the SCOPE where the
    // contribution is added. A sub-app adding a contribution gets its
    // own aggregator; the parent's scope is untouched unless the parent
    // also adds one.
    const SubGreeting = createContribution(AbstractGreetings, {
      inject: {},
      factory: () => ({ greet: (n) => `sub-${n}` }),
    });

    const SubApp = JustScale().add(SubGreeting).build();
    const parent = JustScale().add(SubApp).build();
    const parentApp = parent.compile();
    await parentApp.ready;

    // Resolve contribution so it registers.
    await (SubApp as any).container.resolve(SubGreeting);
    const subAgg = await (SubApp as any).container.resolve(AbstractGreetings);
    assert.strictEqual(subAgg.greet('x'), 'sub-x');

    // Parent has no AbstractGreetings bound — resolving it on parent's
    // container falls through to defineAbstract's `new(...)` path
    // (known bug — see sub-app-scoping.test.ts todo).
    const parentAgg = await parentApp.container.resolve(AbstractGreetings);
    // Today: empty-subclass instance, so no greet method.
    assert.strictEqual(
      typeof parentAgg.greet,
      'undefined',
      'parent has no aggregator; defineAbstract bug returns empty instance',
    );
  });
});

describe('feature graph: contributions — wiring error surfaces', () => {
  it('createContribution(token) with a non-contribution token throws at construction', () => {
    // INVARIANT: createContribution does a runtime check that the given
    // token is a contribution-marked abstract. A plain defineAbstract
    // token (single-impl) must be rejected with a message pointing at
    // bindService as the alternative.
    abstract class PlainAbstract extends defineAbstract<{
      hi(): string
    }>('PlainAbstract') {}

    assert.throws(
      () =>
        createContribution(PlainAbstract as any, {
          inject: {},
          factory: () => ({ hi: () => '' }),
        }),
      (err: unknown) => {
        assert.ok(err instanceof TypeError);
        // Hint must point at bindService:
        assert.match((err as Error).message, /bindService/);
        return true;
      },
    );
  });
});
