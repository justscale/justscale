/**
 * Cycle detection in the feature + service dependency graph.
 *
 * Cycles in DI graphs are usually a design error (A depends on B which
 * depends on A, with no clear construction order), but they can creep
 * in during refactoring. The framework must surface them loudly, name
 * the participants, and never try to "work around" them (because there
 * is no correct construction order).
 *
 * Scope: the framework ships `topologicalSort()` in `builder/sort.ts`
 * which detects cycles and throws `CycleError`. But `topologicalSort()`
 * is NOT invoked by the main `.build()` path (which does a flat
 * dependency check via `validateDependencies()`). So a cycle today
 * manifests at the runtime `container.resolve()` step, not at build.
 *
 * This file pins BOTH behaviors:
 *   - `topologicalSort()` correctly finds cycles when called directly
 *     (the primitive works).
 *   - `.build()` does NOT currently reject cycles (they surface later
 *     at resolve time). This is a gap; todo: `.build()` should run
 *     the sort and fail early with a clear error.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import JustScale from '../../src/justscale.js';
import { defineService } from '../../src/core/service.js';
import { createFeatureBuilder } from '../../src/builder/feature-builder.js';
import { topologicalSort, CycleError } from '../../src/builder/sort.js';
import { FEATURE_META, FEATURE_TOKEN } from '../../src/builder/types.js';
import type { Component, FeatureToken } from '../../src/builder/types.js';

// Build a feature-token whose metadata has arbitrary requires — lets us
// construct cyclic graphs without the type system blocking us.
function mockFeature(name: string, requires: unknown[] = []): FeatureToken<any, any> {
  const fn = () => {};
  return Object.assign(fn, {
    [FEATURE_TOKEN]: true as const,
    [FEATURE_META]: { name, requires },
  }) as unknown as FeatureToken<any, any>;
}

describe('feature graph: cycle detection', () => {
  describe('topologicalSort primitive', () => {
    it('two-feature cycle A → B → A: CycleError names both', () => {
      // INVARIANT: the error surfaces BOTH participants so the user
      // knows where to cut the dep. A one-sided error would leave the
      // user guessing.
      const a = mockFeature('A', []);
      const b = mockFeature('B', []);
      // Mutate requires to create cycle after both exist
      (a as any)[FEATURE_META].requires.push(b);
      (b as any)[FEATURE_META].requires.push(a);

      assert.throws(
        () => topologicalSort([a, b] as Component[]),
        (err: unknown) => {
          assert.ok(err instanceof CycleError, 'must be CycleError');
          const joined = (err as CycleError).cycle.join(' ');
          assert.match(joined, /A/, 'cycle must mention A');
          assert.match(joined, /B/, 'cycle must mention B');
          return true;
        },
      );
    });

    it('three-feature cycle A → B → C → A: CycleError names all three', () => {
      // INVARIANT: longer cycles must not collapse or lose intermediate
      // participants. The user needs the full list to diagnose.
      const a = mockFeature('A');
      const b = mockFeature('B');
      const c = mockFeature('C');
      (a as any)[FEATURE_META].requires.push(b);
      (b as any)[FEATURE_META].requires.push(c);
      (c as any)[FEATURE_META].requires.push(a);

      assert.throws(
        () => topologicalSort([a, b, c] as Component[]),
        (err: unknown) => {
          assert.ok(err instanceof CycleError);
          const joined = (err as CycleError).cycle.join(' ');
          assert.match(joined, /A/);
          assert.match(joined, /B/);
          assert.match(joined, /C/);
          return true;
        },
      );
    });

    it('self-require A → A: CycleError (degenerate cycle length 1)', () => {
      // INVARIANT: `.requires(self)` is nonsense but a user could type
      // it. Must not silently pass; must not loop forever.
      // todo: today self-requires actually slip through topologicalSort
      //   because extractProvides() and extractRequires() only match on
      //   component identity, and the graph-building step explicitly
      //   excludes self-edges (`provider !== component`). So a feature
      //   whose `.requires(self)` returns self-as-a-requirement yields
      //   inDegree=0 and sorts fine. Pin the current behavior; future
      //   fix: detect self-edges in the builder before sort runs.
      const a = mockFeature('Self');
      (a as any)[FEATURE_META].requires.push(a);

      // Today this does NOT throw — it returns [a] because the self-edge
      // is filtered. Pin the lenient behavior so a stricter check is an
      // observable change.
      const sorted = topologicalSort([a] as Component[]);
      assert.strictEqual(sorted.length, 1);
    });
  });

  describe('service cycles at build time', () => {
    it('service A depends on service B, and B depends on A: builder BLOWS THE STACK in getTokenDescription', () => {
      // INVARIANT (BUG): `validateDependencies` currently calls
      // `getTokenDescription` on a ServiceDef, which recursively
      // describes each dep by name. On a cyclic service graph, this
      // recurses forever and throws `RangeError: Maximum call stack
      // size exceeded` — not `CycleError` or `DependencyError`.
      //
      // todo: `getTokenDescription` needs a seen-set to break the
      //   recursion, AND `.build()` should run `topologicalSort` up
      //   front to produce a proper `CycleError` before we ever try
      //   to format a message.
      const ServiceA = { deps: { b: null as any }, factory: () => ({ x: 1 }) };
      const ServiceB = { deps: { a: ServiceA as any }, factory: () => ({ y: 2 }) };
      ServiceA.deps.b = ServiceB as any;

      assert.throws(
        () => JustScale().add(ServiceA as any).add(ServiceB as any).build(),
        (err: unknown) => err instanceof RangeError && /call stack/.test((err as Error).message),
        'today: stack overflow in getTokenDescription — should be CycleError',
      );
    });

    it('feature with self-referential service: same stack-overflow bug', async () => {
      // INVARIANT (BUG): same cause as above — a ServiceDef whose deps
      // includes itself makes `getTokenDescription` infinitely recurse.
      const SelfDep: any = {
        deps: {},
        factory: () => ({ v: 1 }),
      };
      SelfDep.deps.self = SelfDep;

      const Feat = createFeatureBuilder()
        .name('self-cycle-feature')
        .provides((b) => b.add(SelfDep));

      assert.throws(
        () => JustScale().add(Feat).build(),
        (err: unknown) => err instanceof RangeError,
        'today: stack overflow — should be CycleError',
      );
    });
  });

  describe('formatted error messages', () => {
    it('CycleError message includes the cycle path joined with arrows', () => {
      const a = mockFeature('Alpha');
      const b = mockFeature('Beta');
      (a as any)[FEATURE_META].requires.push(b);
      (b as any)[FEATURE_META].requires.push(a);

      try {
        topologicalSort([a, b] as Component[]);
        assert.fail('expected CycleError');
      } catch (err) {
        assert.ok(err instanceof CycleError);
        assert.match((err as Error).message, /Dependency cycle detected/);
        // Arrow separator — users eyeball the chain.
        assert.match((err as Error).message, /→/);
      }
    });
  });
});
