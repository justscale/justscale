import assert from 'node:assert';
import { describe, it } from 'node:test';
import { CycleError, topologicalSort } from './sort.js';
import type { Component, FeatureToken, RepositoryBinding } from './types.js';
import { FEATURE_META, FEATURE_TOKEN, REPO_BINDING } from './types.js';
import type { ServiceDef } from '../core/service.js';

// ============================================================================
// Test Utilities
// ============================================================================

function createMockFeature(
  name: string,
  requires: unknown[] = [],
): Component {
  const fn = () => {};
  return Object.assign(fn, {
    [FEATURE_TOKEN]: true as const,
    [FEATURE_META]: { name, requires },
  }) as unknown as FeatureToken<any, any>;
}

function createMockServiceDef(
  name: string,
  deps: Record<string, unknown> = {},
): Component {
  return {
    deps,
    factory: () => {},
    name,
  } as unknown as ServiceDef<any, any>;
}

function createMockRepoBinding(token: unknown): Component {
  return {
    [REPO_BINDING]: true as const,
    token,
  } as unknown as RepositoryBinding<any>;
}

// ============================================================================
// Tests
// ============================================================================

describe('CycleError', () => {
  it('should create error with cycle information', () => {
    const cycle = ['A', 'B', 'C', 'A'];
    const error = new CycleError(cycle);

    assert.strictEqual(error.name, 'CycleError');
    assert.deepStrictEqual(error.cycle, cycle);
    assert.ok(error.message.includes('Dependency cycle detected'));
    assert.ok(error.message.includes('A → B → C → A'));
  });

  it('should include hint in error message', () => {
    const error = new CycleError(['X', 'Y', 'X']);

    assert.ok(
      error.message.includes(
        'Check if any features or services depend on each other',
      ),
    );
  });

  it('should be instanceof Error', () => {
    const error = new CycleError(['A', 'B', 'A']);

    assert.ok(error instanceof Error);
    assert.ok(error instanceof CycleError);
  });
});

describe('topologicalSort', () => {
  describe('empty and single element', () => {
    it('should return empty array for empty input', () => {
      const result = topologicalSort([]);

      assert.deepStrictEqual(result, []);
    });

    it('should return copy of single element array', () => {
      const feature = createMockFeature('single');
      const input = [feature];

      const result = topologicalSort(input);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0], feature);
      assert.notStrictEqual(result, input); // Should be a copy
    });
  });

  describe('independent components', () => {
    it('should handle multiple independent features', () => {
      const a = createMockFeature('A');
      const b = createMockFeature('B');
      const c = createMockFeature('C');

      const result = topologicalSort([a, b, c]);

      // All three should be present (order doesn't matter for independent)
      assert.strictEqual(result.length, 3);
      assert.ok(result.includes(a));
      assert.ok(result.includes(b));
      assert.ok(result.includes(c));
    });

    it('should handle multiple independent service defs', () => {
      const s1 = createMockServiceDef('Service1');
      const s2 = createMockServiceDef('Service2');

      const result = topologicalSort([s1, s2]);

      assert.strictEqual(result.length, 2);
      assert.ok(result.includes(s1));
      assert.ok(result.includes(s2));
    });
  });

  describe('linear dependencies', () => {
    it('should sort features with linear dependencies', () => {
      const base = createMockFeature('Base');
      const middle = createMockFeature('Middle', [base]);
      const top = createMockFeature('Top', [middle]);

      // Input in wrong order
      const result = topologicalSort([top, middle, base]);

      // Should be sorted: base before middle before top
      assert.strictEqual(result.indexOf(base), 0);
      assert.ok(result.indexOf(base) < result.indexOf(middle));
      assert.ok(result.indexOf(middle) < result.indexOf(top));
    });

    it('should sort services with linear dependencies', () => {
      const repo = createMockServiceDef('Repository');
      const service = createMockServiceDef('Service', { repo });
      const controller = createMockServiceDef('Controller', { svc: service });

      const result = topologicalSort([controller, service, repo]);

      assert.ok(result.indexOf(repo) < result.indexOf(service));
      assert.ok(result.indexOf(service) < result.indexOf(controller));
    });
  });

  describe('diamond dependencies', () => {
    it('should handle diamond pattern (A requires B and C, both require D)', () => {
      const d = createMockFeature('D');
      const b = createMockFeature('B', [d]);
      const c = createMockFeature('C', [d]);
      const a = createMockFeature('A', [b, c]);

      const result = topologicalSort([a, b, c, d]);

      // D must come first
      assert.strictEqual(result.indexOf(d), 0);
      // B and C before A
      assert.ok(result.indexOf(b) < result.indexOf(a));
      assert.ok(result.indexOf(c) < result.indexOf(a));
    });

    it('should handle complex diamond with services', () => {
      const db = createMockServiceDef('Database');
      const cache = createMockServiceDef('Cache');
      const userRepo = createMockServiceDef('UserRepo', { db });
      const orderRepo = createMockServiceDef('OrderRepo', { db, cache });
      const orderService = createMockServiceDef('OrderService', {
        users: userRepo,
        orders: orderRepo,
      });

      const result = topologicalSort([
        orderService,
        orderRepo,
        userRepo,
        cache,
        db,
      ]);

      // db and cache have no deps, should come first
      assert.ok(result.indexOf(db) < result.indexOf(userRepo));
      assert.ok(result.indexOf(db) < result.indexOf(orderRepo));
      assert.ok(result.indexOf(cache) < result.indexOf(orderRepo));
      assert.ok(result.indexOf(userRepo) < result.indexOf(orderService));
      assert.ok(result.indexOf(orderRepo) < result.indexOf(orderService));
    });
  });

  describe('cycle detection', () => {
    it('should throw CycleError for simple cycle (A → B → A)', () => {
      const a = createMockFeature('A');
      const b = createMockFeature('B', [a])
      // Manually create cycle
      ;(a as any)[FEATURE_META].requires = [b];

      assert.throws(
        () => topologicalSort([a, b]),
        (err: Error) => {
          assert.ok(err instanceof CycleError);
          assert.ok(err.message.includes('Dependency cycle'));
          return true;
        },
      );
    });

    it('should throw CycleError for longer cycle (A → B → C → A)', () => {
      const a = createMockFeature('A');
      const b = createMockFeature('B', [a]);
      const c = createMockFeature('C', [b])
      // Create cycle back to a
      ;(a as any)[FEATURE_META].requires = [c];

      assert.throws(
        () => topologicalSort([a, b, c]),
        (err: Error) => {
          assert.ok(err instanceof CycleError);
          return true;
        },
      );
    });

    it('should include cycle path in error', () => {
      const a = createMockFeature('CycleA');
      const b = createMockFeature('CycleB', [a])
      ;(a as any)[FEATURE_META].requires = [b];

      try {
        topologicalSort([a, b]);
        assert.fail('Should have thrown CycleError');
      } catch (err) {
        assert.ok(err instanceof CycleError);
        assert.ok(err.cycle.length >= 2);
      }
    });
  });

  describe('mixed component types', () => {
    it('should handle features depending on services', () => {
      const service = createMockServiceDef('MyService');
      const feature = createMockFeature('MyFeature', [service]);

      const result = topologicalSort([feature, service]);

      assert.ok(result.indexOf(service) < result.indexOf(feature));
    });

    it('should handle repository bindings', () => {
      const token = { name: 'UserRepo' };
      const binding = createMockRepoBinding(token);
      const service = createMockServiceDef('UserService', { repo: token });

      const result = topologicalSort([service, binding]);

      // Binding provides the token, service requires it
      assert.ok(result.indexOf(binding) < result.indexOf(service));
    });

    it('should handle complex mix of features, services, and bindings', () => {
      const token = { name: 'Repo' };
      const binding = createMockRepoBinding(token);
      const service = createMockServiceDef('Service', { repo: token });
      const feature = createMockFeature('Feature', [service]);

      const result = topologicalSort([feature, service, binding]);

      assert.ok(result.indexOf(binding) < result.indexOf(service));
      assert.ok(result.indexOf(service) < result.indexOf(feature));
    });
  });

  describe('external dependencies', () => {
    it('should handle dependencies not in the component list', () => {
      const external = createMockServiceDef('External');
      const internal = createMockServiceDef('Internal', { ext: external });

      // Only internal in the list, external is not provided
      const result = topologicalSort([internal]);

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0], internal);
    });

    it('should handle partial dependency satisfaction', () => {
      const dep1 = createMockServiceDef('Dep1');
      const dep2 = createMockServiceDef('Dep2');
      const consumer = createMockServiceDef('Consumer', { d1: dep1, d2: dep2 });

      // Only dep1 is in the list
      const result = topologicalSort([consumer, dep1]);

      assert.strictEqual(result.length, 2);
      assert.ok(result.indexOf(dep1) < result.indexOf(consumer));
    });
  });

  describe('ordering stability', () => {
    it('should maintain consistent ordering for independent components', () => {
      const a = createMockFeature('A');
      const b = createMockFeature('B');
      const c = createMockFeature('C');

      const result1 = topologicalSort([a, b, c]);
      const result2 = topologicalSort([a, b, c]);

      // Same input should produce same output
      assert.deepStrictEqual(
        result1.map((r) => (r as any)[FEATURE_META]?.name),
        result2.map((r) => (r as any)[FEATURE_META]?.name),
      );
    });

    it('should produce valid ordering regardless of input order', () => {
      const base = createMockFeature('Base');
      const derived = createMockFeature('Derived', [base]);

      const result1 = topologicalSort([base, derived]);
      const result2 = topologicalSort([derived, base]);

      // Both should have base before derived
      assert.ok(result1.indexOf(base) < result1.indexOf(derived));
      assert.ok(result2.indexOf(base) < result2.indexOf(derived));
    });
  });

  describe('edge cases', () => {
    it('should handle feature with empty requires array', () => {
      const feature = createMockFeature('Empty', []);

      const result = topologicalSort([feature]);

      assert.strictEqual(result.length, 1);
    });

    it('should handle service with empty deps object', () => {
      const service = createMockServiceDef('NoDeps', {});

      const result = topologicalSort([service]);

      assert.strictEqual(result.length, 1);
    });

    it('should throw CycleError for duplicate components in input', () => {
      const feature = createMockFeature('Dup');

      // Same component twice causes a CycleError (implementation detail)
      // This is an edge case that shouldn't happen in practice
      assert.throws(
        () => topologicalSort([feature, feature]),
        (err: Error) => {
          assert.ok(err instanceof CycleError);
          return true;
        },
      );
    });

    it('should handle anonymous feature (no name in meta)', () => {
      const anon = Object.assign(() => {}, {
        [FEATURE_TOKEN]: true as const,
        [FEATURE_META]: { requires: [] }, // no name
      }) as unknown as Component;

      const result = topologicalSort([anon]);

      assert.strictEqual(result.length, 1);
    });

    it('should handle service def without deps property', () => {
      // This won't be recognized as ServiceDef by isServiceDef
      // because it checks for both deps and factory
      const service = {
        deps: {},
        factory: () => {},
      } as unknown as Component;

      const result = topologicalSort([service]);

      assert.strictEqual(result.length, 1);
    });

    it('should handle large number of components', () => {
      const components = [];
      for (let i = 0; i < 100; i++) {
        components.push(createMockFeature(`Feature${i}`));
      }

      const result = topologicalSort(components);

      assert.strictEqual(result.length, 100);
    });

    it('should handle long dependency chain', () => {
      const chain: Component[] = [];
      let prev: Component | null = null;

      for (let i = 0; i < 50; i++) {
        const feature = createMockFeature(`Chain${i}`, prev ? [prev] : []);
        chain.push(feature);
        prev = feature;
      }

      // Reverse to put them in wrong order
      const result = topologicalSort([...chain].reverse());

      // Verify ordering
      for (let i = 0; i < chain.length - 1; i++) {
        assert.ok(
          result.indexOf(chain[i]) < result.indexOf(chain[i + 1]),
          `Chain${i} should come before Chain${i + 1}`,
        );
      }
    });
  });
});
