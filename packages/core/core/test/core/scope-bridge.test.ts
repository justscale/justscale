/**
 * Tests for `createScopedBridge` — the scope-switching proxy that
 * sub-app composition uses to bridge services from a parent scope.
 *
 * This test exercises the primitive in isolation (no sub-app builder
 * yet). It verifies:
 *   - Function calls on the bridge run with `getContainer()`
 *     returning the *parent*'s container, not whatever scope the
 *     caller happens to be in.
 *   - Non-function properties pass through unchanged.
 *   - State is shared — the bridge is not a copy; mutations made via
 *     the bridge are visible on the original (and vice versa).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import JustScale from '../../src/justscale.js';
import { defineService, Container } from '../../src/core/service.js';
import {
  getContainer,
  runWithContainer,
} from '../../src/core/context.js';
import {
  createScopedBridge,
  wrapWithScope,
} from '../../src/core/scope-bridge.js';

describe('createScopedBridge', () => {
  it('routes function calls through the parent\'s async scope', async () => {
    // A service whose method reads the currently-scoped container.
    const Observer = defineService({
      inject: {},
      factory: () => ({
        whichContainer(): Container | undefined {
          return getContainer();
        },
      }),
    });

    // Parent app — holds the real service instance.
    const parent = JustScale().add(Observer).build().compile();
    await parent.ready;

    // A completely separate container, simulating "sub-app scope".
    const subScope = new Container();

    // The bridge: same instance, but calls re-enter parent's scope.
    const bridged = await createScopedBridge(parent.container, Observer);

    // Baseline: inside `subScope`, without a bridge, reads return subScope.
    const baselineFromSub = runWithContainer(subScope, () => getContainer());
    assert.strictEqual(baselineFromSub, subScope, 'sanity: raw call inside sub scope sees sub scope');

    // Via bridge: inside `subScope`, calling `bridged.whichContainer()`
    // should still see *parent*'s container — the bridge switched scopes.
    const observedViaProxy = runWithContainer(subScope, () => bridged.whichContainer());
    assert.strictEqual(observedViaProxy, parent.container, 'bridge re-enters parent scope on call');
  });

  it('passes through non-function properties unchanged', async () => {
    const Constants = defineService({
      inject: {},
      factory: () => ({
        version: 'v1',
        limits: { max: 100 },
        describe(): string {
          return 'constants';
        },
      }),
    });

    const parent = JustScale().add(Constants).build().compile();
    await parent.ready;

    const bridged = await createScopedBridge(parent.container, Constants);

    // Plain data passes through without wrapping.
    assert.strictEqual(bridged.version, 'v1');
    assert.deepStrictEqual(bridged.limits, { max: 100 });
    // Function still works (and returns scope-wrapped).
    assert.strictEqual(bridged.describe(), 'constants');
  });

  it('shares state with the parent instance (not a copy)', async () => {
    const Counter = defineService({
      inject: {},
      factory: () => {
        let count = 0;
        return {
          incr(): number {
            count++;
            return count;
          },
          read(): number {
            return count;
          },
        };
      },
    });

    const parent = JustScale().add(Counter).build().compile();
    await parent.ready;

    const direct = await parent.container.resolve(Counter);
    const bridged = await createScopedBridge(parent.container, Counter);

    direct.incr();
    direct.incr();
    assert.strictEqual(bridged.read(), 2, 'bridge reads parent state');

    bridged.incr();
    assert.strictEqual(direct.read(), 3, 'parent reads bridge mutations');
  });

  it('wrapWithScope works on any object, not just resolved services', () => {
    const container = new Container();
    const target = {
      value: 42,
      read(): Container | undefined {
        return getContainer();
      },
    };

    const wrapped = wrapWithScope(target, container);

    // Outside any scope, raw call sees no container.
    assert.strictEqual(getContainer(), undefined);
    // Wrapped call enters `container`.
    assert.strictEqual(wrapped.read(), container);
    // Data property untouched.
    assert.strictEqual(wrapped.value, 42);
  });
});
