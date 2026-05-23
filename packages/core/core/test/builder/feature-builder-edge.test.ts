/**
 * Edge-case tests for createFeatureBuilder and feature composition inside
 * a JustScale() builder.
 *
 * Covers:
 *   - feature without name
 *   - feature with service requirements
 *   - feature that requires another feature (transitive provides)
 *   - feature metadata access (name, requires, onStart, onStop)
 *   - onStart/onStop hooks attached to metadata
 *   - feature providing services into a parent builder
 *   - feature validation: missing requires surfaces at build
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  createFeatureBuilder,
  getFeatureMetadata,
  getFeatureName,
  getFeatureRequirements,
} from '../../src/builder/feature-builder.js';
import { isFeatureToken } from '../../src/builder/types.js';
import JustScale from '../../src/justscale.js';
import { defineService } from '../../src/core/service.js';
import { DependencyError } from '../../src/builder/validation.js';

describe('createFeatureBuilder', () => {
  it('creates a feature with no requirements', () => {
    const feat = createFeatureBuilder().provides((b) => b);
    assert.ok(isFeatureToken(feat));
    assert.deepStrictEqual(getFeatureRequirements(feat), []);
  });

  it('feature with no name has name=undefined in metadata', () => {
    const feat = createFeatureBuilder().provides((b) => b);
    assert.strictEqual(getFeatureName(feat), undefined);
  });

  it('named feature carries the name in metadata', () => {
    const feat = createFeatureBuilder().name('MyFeature').provides((b) => b);
    assert.strictEqual(getFeatureName(feat), 'MyFeature');
  });

  it('onStart hook is stored in metadata', () => {
    const fn = async () => {};
    const feat = createFeatureBuilder().onStart(fn).provides((b) => b);
    const meta = getFeatureMetadata(feat);
    assert.strictEqual(meta.onStart, fn);
  });

  it('onStop hook is stored in metadata', () => {
    const fn = async () => {};
    const feat = createFeatureBuilder().onStop(fn).provides((b) => b);
    const meta = getFeatureMetadata(feat);
    assert.strictEqual(meta.onStop, fn);
  });

  it('chained onStart/onStop preserves both hooks', () => {
    const onStart = async () => {};
    const onStop = async () => {};
    const feat = createFeatureBuilder()
      .onStart(onStart)
      .onStop(onStop)
      .provides((b) => b);
    const meta = getFeatureMetadata(feat);
    assert.strictEqual(meta.onStart, onStart);
    assert.strictEqual(meta.onStop, onStop);
  });

  it('only the last name() call wins (immutable state, last-write semantics)', () => {
    const feat = createFeatureBuilder()
      .name('first')
      .name('second')
      .name('third')
      .provides((b) => b);
    assert.strictEqual(getFeatureName(feat), 'third');
  });

  it('feature with single requirement stores it in metadata', () => {
    const Dep = defineService({ inject: {}, factory: () => ({}) });
    const feat = createFeatureBuilder().requires(Dep).provides((b) => b);
    const reqs = getFeatureRequirements(feat);
    assert.strictEqual(reqs.length, 1);
    assert.strictEqual(reqs[0], Dep);
  });

  it('feature with multiple requirements accumulates them in order', () => {
    const A = defineService({ inject: {}, factory: () => ({}) });
    const B = defineService({ inject: {}, factory: () => ({}) });
    const C = defineService({ inject: {}, factory: () => ({}) });
    const feat = createFeatureBuilder()
      .requires(A)
      .requires(B)
      .requires(C)
      .provides((b) => b);
    const reqs = getFeatureRequirements(feat);
    assert.strictEqual(reqs.length, 3);
    assert.strictEqual(reqs[0], A);
    assert.strictEqual(reqs[1], B);
    assert.strictEqual(reqs[2], C);
  });

  it('feature builder is immutable (each call returns new builder)', () => {
    const b1 = createFeatureBuilder();
    const b2 = b1.name('X');
    const b3 = b2.name('Y');
    assert.notStrictEqual(b1, b2);
    assert.notStrictEqual(b2, b3);
  });
});

describe('Feature + JustScale integration', () => {
  it('adds a feature that registers services into the parent builder', async () => {
    const Logger = defineService({
      inject: {},
      factory: () => ({ log: (m: string) => m }),
    });

    const LogFeature = createFeatureBuilder()
      .name('logging')
      .provides((b) => b.add(Logger));

    const built = JustScale().add(LogFeature).build();
    const log = await built.resolve(Logger);
    assert.strictEqual(log.log('hi'), 'hi');
  });

  it('feature with requires builds when the parent provides the token', async () => {
    const Db = defineService({
      inject: {},
      factory: () => ({ query: () => 'ok' }),
    });

    const User = defineService({
      inject: { db: Db },
      factory: ({ db }) => ({ get: () => db.query() }),
    });

    const UserFeature = createFeatureBuilder()
      .name('user')
      .requires(Db)
      .provides((b) => b.add(User));

    const built = JustScale().add(Db).add(UserFeature).build();
    const u = await built.resolve(User);
    assert.strictEqual(u.get(), 'ok');
  });

  it('feature without its required dep surfaces as DependencyError', () => {
    const Missing = defineService({ inject: {}, factory: () => ({}) });
    const F = createFeatureBuilder()
      .name('needs-missing')
      .requires(Missing)
      .provides((b) => b);

    assert.throws(
      // @ts-expect-error — Missing not provided
      () => JustScale().add(F).build(),
      (err: unknown) => err instanceof DependencyError,
    );
  });

  it('feature that `.requires(anotherFeature)` builds when the other feature is also added', async () => {
    // `expandFeatureProvides` must register a feature's own token in the
    // provided set, so a downstream `.requires(otherFeature)` is satisfied
    // by the parent calling `.add(otherFeature)`. If the feature token is
    // not self-provided, the token-level requirement never matches and
    // build() throws DependencyError even though the inner services are
    // available.
    const Base = defineService({
      inject: {},
      factory: () => ({ base: 1 }),
    });

    const BaseFeature = createFeatureBuilder()
      .name('base')
      .provides((b) => b.add(Base));

    const ConsumerFeature = createFeatureBuilder()
      .name('consumer')
      .requires(BaseFeature)
      .provides((b) => b);

    // feature-requires-feature: type-level affordance pulls BaseFeature's
    // provides into TAvailable, but the runtime demands the feature-token
    // itself — same gap pinned in feature-graph-requires-provides.
    // @ts-expect-error — MissingDepsError: ConsumerFeature.requires(BaseFeature) not recognised by builder type-check
    const built = JustScale().add(BaseFeature).add(ConsumerFeature).build();
    const base = await built.resolve(Base);
    assert.strictEqual(base.base, 1);
  });

  it('two different features providing two different services coexist', async () => {
    const A = defineService({ inject: {}, factory: () => ({ tag: 'A' }) });
    const B = defineService({ inject: {}, factory: () => ({ tag: 'B' }) });
    const FA = createFeatureBuilder().name('FA').provides((b) => b.add(A));
    const FB = createFeatureBuilder().name('FB').provides((b) => b.add(B));

    const built = JustScale().add(FA).add(FB).build();
    const a = await built.resolve(A);
    const b = await built.resolve(B);
    assert.strictEqual(a.tag, 'A');
    assert.strictEqual(b.tag, 'B');
  });

  it('adding the same feature twice registers services once (last wins semantics for dedup)', async () => {
    let count = 0;
    const S = defineService({
      inject: {},
      factory: () => {
        count++;
        return { n: count };
      },
    });

    const F = createFeatureBuilder()
      .name('dup')
      .provides((b) => b.add(S));

    // Adding the same feature twice — the factory set for S is the same
    // ServiceDef, so the container stores one entry and it resolves once.
    const built = JustScale().add(F).add(F).build();
    const r1 = await built.resolve(S);
    const r2 = await built.resolve(S);
    assert.strictEqual(r1, r2);
    assert.strictEqual(count, 1);
  });
});
