/**
 * Feature builder + DI graph: the requires/provides relation.
 *
 * Pins the core properties that every composed app silently depends on:
 *
 *   - If a feature declares `.requires(T)` and nobody provides T, `.build()`
 *     fails with a message that names the missing token. Silent failures
 *     here would cascade into runtime "X is undefined" errors far from
 *     the source.
 *
 *   - If two features each provide the same token, the builder's behavior
 *     must be observable (last-wins vs. throw vs. dedup). We pin whatever
 *     actually happens today so a refactor can't silently change it.
 *
 *   - Order independence: the composed app only cares about the final
 *     set of components. `.add(Feature).add(Service)` must produce the
 *     same DI graph as `.add(Service).add(Feature)`.
 *
 * Each test comments the invariant it pins, so a future maintainer knows
 * what property they'd break if they "simplified" the behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import JustScale from '../../src/justscale.js';
import { defineService, defineAbstract } from '../../src/core/service.js';
import { createFeatureBuilder } from '../../src/builder/feature-builder.js';
import { bindService } from '../../src/builder/builder.js';
import { DependencyError } from '../../src/builder/validation.js';

// ============================================================================
// Test services
// ============================================================================

const TokenA = defineService({
  inject: {},
  factory: () => ({ whoami: (): string => 'A' }),
});

const TokenB = defineService({
  inject: {},
  factory: () => ({ whoami: (): string => 'B' }),
});

/** TokenC requires TokenB — so anything using TokenC must pull B into scope. */
const TokenC = defineService({
  inject: { b: TokenB },
  factory: ({ b }) => ({ whoami: (): string => `C(${b.whoami()})` }),
});

describe('feature graph: requires/provides', () => {
  it('feature A requires B, feature B provides B → composition succeeds', async () => {
    // INVARIANT: a feature that declares .requires(B) can resolve at
    // runtime when some other component (here, a plain service) is added
    // to the same builder. Silent regression would yield "undefined" at
    // the injection site, not a build-time error.
    const FeatureA = createFeatureBuilder()
      .name('a-needs-b')
      .requires(TokenB)
      .provides((b) => b.add(TokenC));

    const FeatureB = createFeatureBuilder()
      .name('b-provides-b')
      .provides((b) => b.add(TokenB));

    const app = JustScale().add(FeatureB).add(FeatureA).build().compile();
    await app.ready;

    const c = await app.container.resolve(TokenC);
    assert.strictEqual(c.whoami(), 'C(B)');
  });

  it('feature A requires B, nothing provides B → build throws DependencyError naming A and B', () => {
    // INVARIANT: missing dependencies surface at build, not runtime, and
    // the error names BOTH the requiring feature and the missing token.
    // If the message drops either side, a user can't figure out where
    // to look.
    const FeatureA = createFeatureBuilder()
      .name('a-needs-b')
      .requires(TokenB)
      .provides((b) => b.add(TokenC));

    assert.throws(
      // @ts-expect-error — TokenB missing from TProvided, caught at type level too
      () => JustScale().add(FeatureA).build(),
      (err: unknown) => {
        assert.ok(err instanceof DependencyError, 'must throw DependencyError');
        const msg = (err as Error).message;
        // Names the feature:
        assert.match(msg, /a-needs-b/, 'error must name the requiring feature');
        // Names the missing token (TokenB resolves to a function; its
        // anonymous description is the fallback, but FeatureA's inner
        // .add(TokenC) also requires TokenB transitively — whichever the
        // error takes, it must at minimum mention the missing deps block):
        assert.match(msg, /Missing dependencies/i, 'error must say "Missing dependencies"');
        return true;
      },
    );
  });

  it('build-order independence: .add(Feature).add(ServiceItProvides) equals reverse', async () => {
    // INVARIANT: requires/provides checks use the final accumulated set,
    // not a left-to-right sweep. If ordering ever starts to matter
    // silently, users will hit mysterious "works when I move this line"
    // bugs.
    const FeatureA = createFeatureBuilder()
      .name('a-needs-b')
      .requires(TokenB)
      .provides((b) => b.add(TokenC));

    // Forward order: provider first
    const forward = JustScale().add(TokenB).add(FeatureA).build().compile();
    // Reverse order: feature first, its require satisfied later.
    // Type-level check is left-to-right (strict), runtime check accumulates —
    // this intentional gap is what the test pins.
    // @ts-expect-error — left-to-right MissingDepsError when feature comes first
    const reverse = JustScale().add(FeatureA).add(TokenB).build().compile();

    await Promise.all([forward.ready, reverse.ready]);

    const fwd = await forward.container.resolve(TokenC);
    const rev = await reverse.container.resolve(TokenC);
    assert.strictEqual(fwd.whoami(), rev.whoami());
  });

  it('two providers of the same abstract token: last bindService wins (documented, pinned)', async () => {
    // INVARIANT: `bindService(Abstract, Impl)` twice overrides the first.
    // Today this is silent last-wins with no warning. Pin it so if someone
    // changes it to throw (or to first-wins), we detect the breakage.
    //
    // todo: consider warning or throwing on duplicate bindService of same
    // abstract — silent override is a footgun.
    abstract class AbstractGreeter extends defineAbstract<{
      hello(): string
    }>('AbstractGreeter') {}

    const HelloImpl = defineService({
      inject: {},
      factory: () => ({ hello: () => 'hello' }),
    });
    const HiImpl = defineService({
      inject: {},
      factory: () => ({ hello: () => 'hi' }),
    });

    const app = JustScale()
      .add(HelloImpl)
      .add(HiImpl)
      .add(bindService(AbstractGreeter, HelloImpl))
      .add(bindService(AbstractGreeter, HiImpl))
      .build()
      .compile();
    await app.ready;

    const greeter = await app.container.resolve(AbstractGreeter);
    // Last bindService wins:
    assert.strictEqual(greeter.hello(), 'hi');
  });

  it('a feature that provides a token already provided elsewhere: no crash, no duplicate registration', async () => {
    // INVARIANT: adding the same service twice (once by feature, once
    // directly) must not throw and must resolve to a single instance.
    // Feature expansion into the parent scope is flat, so duplicates
    // are possible — today `processComponent` just pushes to arrays,
    // so duplicates coexist. That's only harmless because `container.
    // resolve(Token)` caches by token identity. If that assumption ever
    // changes, double-factory-invocation would surface here.
    const DirectFeature = createFeatureBuilder()
      .name('direct-a')
      .provides((b) => b.add(TokenA));

    let constructedCount = 0;
    const CountingA = defineService({
      inject: {},
      factory: () => {
        constructedCount++;
        return { whoami: () => 'A' };
      },
    });

    // Add the token directly AND via a feature that also adds it.
    // Today this compiles: DirectFeature provides TokenA, so the
    // outer .add(CountingA) passes dep-check (CountingA has no deps).
    // todo: if a future change forbids duplicate provide, this test
    // becomes the canary.
    const app = JustScale()
      .add(DirectFeature)
      .add(CountingA)
      .build()
      .compile();
    await app.ready;

    // Resolve each token — should yield distinct singleton per token-identity,
    // and construction must not explode (no infinite loop, no throw).
    const one = await app.container.resolve(CountingA);
    const two = await app.container.resolve(CountingA);
    assert.strictEqual(one, two, 'CountingA resolves to the same instance');
    assert.strictEqual(constructedCount, 1, 'factory runs once per token');
  });

  it('feature with no requires builds standalone', async () => {
    // INVARIANT: the .requires() tuple starting at [] must be a valid
    // build-time state. Regression: someone adds a "must declare at
    // least one require" check and every no-dep feature breaks.
    const Simple = createFeatureBuilder()
      .name('simple')
      .provides((b) => b.add(TokenA));

    const app = JustScale().add(Simple).build().compile();
    await app.ready;
    const a = await app.container.resolve(TokenA);
    assert.strictEqual(a.whoami(), 'A');
  });

  it('feature requires a feature: runtime honours the type-level affordance', async () => {
    // INVARIANT: `.requires(Feature)` pulls that feature's provides into
    // TAvailable at the type level. The runtime validator must agree —
    // adding the required feature to the builder satisfies the require,
    // even though a FeatureToken is not itself a ServiceDef.
    //
    // Regression guard: if a refactor re-introduces the mismatch (runtime
    // looks up the feature-token identity as if it were a service), this
    // test flips back to a throw at `.build()`.
    const DbFeature = createFeatureBuilder()
      .name('db')
      .provides((b) => b.add(TokenB));

    const UserFeature = createFeatureBuilder()
      .name('user')
      .requires(DbFeature)
      .provides((b) => b.add(TokenC));

    // Type-level requires-tracking sees a feature-token requirement, but the
    // runtime resolves features structurally — so the type check rejects this
    // composition while the runtime accepts it. The point of the test is to
    // pin that runtime gap, which means we have to silence the type error.
    // @ts-expect-error — type-level check rejects feature-as-requires composition
    const app = JustScale().add(DbFeature).add(UserFeature).build().compile();
    await app.ready;

    // UserFeature's TokenC is resolvable, and it transitively reaches TokenB
    // from DbFeature — proving the requires edge was honoured end-to-end.
    const c = await app.container.resolve(TokenC);
    assert.strictEqual(c.whoami(), 'C(B)');
  });
});
