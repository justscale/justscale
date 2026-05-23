/**
 * Sub-app build-context inheritance — adapters installed by a sub-app's
 * route factories (e.g. `Get()` from `@justscale/http` calling
 * `currentBuilder()?.installAdapter(HTTP_ADAPTER)`) should land on the
 * *root* app's adapter set, not a per-sub-app one. This keeps the tree
 * running under a single kernel / single HTTP server.
 *
 * This file uses a hand-rolled adapter-installing controller so the
 * test stays inside `@justscale/core` without pulling in HTTP.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import JustScale from '../../src/justscale.js';
import { createController } from '../../src/core/controller.js';
import { currentBuilder } from '../../src/builder/build-context.js';
import type { Adapter } from '../../src/kernel/adapter.js';
import type { RouteDef } from '../../src/builder/types.js';

/**
 * Minimal no-op adapter used as a unique marker. Installing it records
 * its presence on whichever build context is active — we use this to
 * verify sub-app installs propagate to the parent.
 */
const TEST_ADAPTER: Adapter = Object.freeze({
  name: 'test-adapter',
  requires: [] as const,
  start: () => {},
});

/**
 * Route factory that mimics `Get()`: on invocation it installs the
 * adapter via the current build context (same mechanism as the HTTP
 * package). We never actually match/execute these routes — the test
 * only checks what got installed.
 */
function TestRoute(path: string): RouteDef<any, any, any> {
  currentBuilder()?.installAdapter(TEST_ADAPTER);
  return {
    path,
    steps: [],
    responseSchemas: new Map(),
    handler: () => {},
    method: 'GET',
  } as any;
}

describe('Sub-app build-context inheritance', () => {
  it('sub-app adapter installs land on parent app adapters', async () => {
    const SubCtrl = createController({
      inject: {},
      routes: () => ({
        x: TestRoute('/sub/x') as any,
      }),
    });

    const SubApp = JustScale().add(SubCtrl).build();
    const parent = JustScale().add(SubApp).build();
    const parentApp = parent.compile();
    await parentApp.ready;

    const parentHas = parentApp.adapters.some((a) => a === TEST_ADAPTER);
    assert.ok(parentHas, 'parent.adapters should contain the adapter installed by the sub-app');
  });

  it('adapter dedup: multiple sub-apps installing the same adapter yield one entry', async () => {
    const CtrlA = createController({
      inject: {},
      routes: () => ({ x: TestRoute('/a') as any }),
    });
    const CtrlB = createController({
      inject: {},
      routes: () => ({ x: TestRoute('/b') as any }),
    });

    const SubA = JustScale().add(CtrlA).build();
    const SubB = JustScale().add(CtrlB).build();
    const parent = JustScale().add(SubA).add(SubB).build();
    const parentApp = parent.compile();
    await parentApp.ready;

    const count = parentApp.adapters.filter((a) => a === TEST_ADAPTER).length;
    assert.strictEqual(count, 1, 'adapter should be deduped to a single entry');
  });

  it('multi-level nesting: grandchild install bubbles to root', async () => {
    const GrandCtrl = createController({
      inject: {},
      routes: () => ({ x: TestRoute('/gc') as any }),
    });

    const Grandchild = JustScale().add(GrandCtrl).build();
    const Child = JustScale().add(Grandchild).build();
    const parent = JustScale().add(Child).build();
    const parentApp = parent.compile();
    await parentApp.ready;

    assert.ok(
      parentApp.adapters.some((a) => a === TEST_ADAPTER),
      'adapter installed in a grandchild should propagate all the way up',
    );
  });
});
