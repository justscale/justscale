/**
 * Feature lifecycle hooks — `.onStart(...)` / `.onStop(...)`.
 *
 * The feature builder accepts lifecycle hooks. Per the docstring
 * (`feature-builder.ts`), `onStart` runs "when the cluster starts"
 * and receives a resolver to pull services from the container.
 * `onStop` runs when the cluster stops.
 *
 * What this file pins:
 *
 *   1. Metadata stores hooks correctly — this part works.
 *
 *   2. Lifecycle hooks execute when the app becomes ready and when it stops.
 *
 * The invariants worth pinning:
 *   - `getFeatureMetadata(feat).onStart` returns the exact hook.
 *   - Running the app end-to-end invokes the hook once.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import JustScale from '../../src/justscale.js';
import { defineService } from '../../src/core/service.js';
import {
  createFeatureBuilder,
  getFeatureMetadata,
} from '../../src/builder/feature-builder.js';

const TokenA = defineService({
  inject: {},
  factory: () => ({ v: () => 42 }),
});

describe('feature lifecycle hooks', () => {
  it('onStart hook is stored on feature metadata', () => {
    // INVARIANT: metadata is the source of truth for tools that want
    // to reason about hooks (future: HMR visualizers, monitoring).
    let called = 0;
    const hook = async () => {
      called++;
    };

    const Feat = createFeatureBuilder()
      .name('with-start')
      .onStart(hook)
      .provides((b) => b.add(TokenA));

    const meta = getFeatureMetadata(Feat);
    assert.strictEqual(meta.onStart, hook, 'metadata carries the exact hook reference');
    assert.strictEqual(called, 0, 'not called yet');
  });

  it('onStop hook is stored on feature metadata', () => {
    // INVARIANT: same story for onStop — presence/identity in metadata.
    let called = 0;
    const hook = async () => {
      called++;
    };

    const Feat = createFeatureBuilder()
      .name('with-stop')
      .onStop(hook)
      .provides((b) => b.add(TokenA));

    const meta = getFeatureMetadata(Feat);
    assert.strictEqual(meta.onStop, hook);
    assert.strictEqual(called, 0);
  });

  it('onStart is called once when the app is ready and can resolve services', async () => {
    let onStartCalled = 0;
    let resolvedValue = 0;

    const Feat = createFeatureBuilder()
      .name('start-hook')
      .onStart(async ({ resolve }) => {
        onStartCalled++;
        const a = await resolve(TokenA);
        resolvedValue = a.v();
      })
      .provides((b) => b.add(TokenA));

    const app = JustScale().add(Feat).build().compile();
    await app.ready;

    // Resolve the service the feature provides — the hook should not run again.
    const a = await app.container.resolve(TokenA);
    assert.ok(a);

    assert.strictEqual(
      onStartCalled,
      1,
      'onStart should run exactly once when the app becomes ready.',
    );
    assert.strictEqual(resolvedValue, 42);
  });

  it('onStop is called once during app.stop()', async () => {
    let onStopCalled = 0;

    const Feat = createFeatureBuilder()
      .name('stop-hook')
      .onStop(async () => {
        onStopCalled++;
      })
      .provides((b) => b.add(TokenA));

    const built = JustScale().add(Feat).build();
    const app = built.compile();
    await app.ready;

    await built.stop();

    assert.strictEqual(
      onStopCalled,
      1,
      'feature onStop should run during app.stop().',
    );
  });

  it('multiple hooks within a feature: only one onStart/onStop can be set (last wins, silent)', () => {
    // INVARIANT: `createFeatureBuilder().onStart(hook1).onStart(hook2)`
    // keeps only hook2 in metadata. Today there's no way to declare
    // multiple onStart per feature. Pin it so we notice if someone
    // changes it to accumulate.
    const h1 = async () => {};
    const h2 = async () => {};
    const Feat = createFeatureBuilder()
      .name('two-hooks')
      .onStart(h1)
      .onStart(h2)
      .provides((b) => b.add(TokenA));

    const meta = getFeatureMetadata(Feat);
    assert.strictEqual(meta.onStart, h2, 'last onStart wins');
    // No ghost of h1 anywhere:
    assert.notStrictEqual(meta.onStart, h1);
  });

  it('hook identity: separate builders of the same feature factory share no hook state', () => {
    // INVARIANT: feature builders are immutable between chained calls
    // (each method returns a new builder instance). Calling `.onStart`
    // on one builder does not affect another branching from the same
    // parent.
    const base = createFeatureBuilder().name('base');
    const h1 = async () => {};
    const h2 = async () => {};

    const F1 = base.onStart(h1).provides((b) => b.add(TokenA));
    const F2 = base.onStart(h2).provides((b) => b.add(TokenA));

    assert.strictEqual(getFeatureMetadata(F1).onStart, h1);
    assert.strictEqual(getFeatureMetadata(F2).onStart, h2);
    assert.notStrictEqual(
      getFeatureMetadata(F1).onStart,
      getFeatureMetadata(F2).onStart,
    );
  });
});
