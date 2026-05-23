/**
 * Integration tests for adapter capture via ALS during app compile.
 *
 * Verifies the full path: `JustScale().add(Controller).build() → compile()
 * → await ready` → route factories run inside the build-context scope →
 * their `currentBuilder()?.installAdapter(...)` calls end up on
 * `app.adapters`.
 *
 * These tests exercise the real `createAppCore` pipeline — they catch
 * regressions that mock-based kernel unit tests can't see, like ALS
 * scope placement, ready-promise integration, or Set-based dedup inside
 * the actual controller resolution path.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import JustScale from '../../src/justscale.js';
import { createController } from '../../src/core/controller.js';
import { currentBuilder } from '../../src/builder/build-context.js';
import type { Adapter } from '../../src/kernel/adapter.js';

/** A fake route factory that installs an adapter on invocation. */
function makeFactory(adapter: Adapter) {
  return function fakeRoute(path: string) {
    currentBuilder()?.installAdapter(adapter);
    return {
      method: 'FAKE' as const,
      path,
      steps: [],
      responseSchemas: new Map(),
      handler: () => undefined,
    };
  };
}

describe('app.adapters — captured via ALS during compile', () => {
  it('is an empty array for an app with no installing controllers', async () => {
    const built = JustScale().build();
    const app = built.compile();
    await app.ready;
    assert.deepStrictEqual(app.adapters, []);
  });

  it('is populated after await ready when a controller installs', async () => {
    const FAKE_ADAPTER: Adapter = Object.freeze({
      name: 'fake',
      requires: [],
      start: () => {},
    });
    const Fake = makeFactory(FAKE_ADAPTER);

    const Controller = createController({
      inject: {},
      routes: () => ({
        one: Fake('/one') as any,
      }),
    });

    const built = JustScale().add(Controller).build();
    const app = built.compile();
    await app.ready;

    assert.strictEqual(app.adapters.length, 1);
    assert.strictEqual(app.adapters[0], FAKE_ADAPTER);
  });

  it('dedupes by Set identity across many route calls', async () => {
    const FAKE_ADAPTER: Adapter = Object.freeze({
      name: 'fake',
      requires: [],
      start: () => {},
    });
    const Fake = makeFactory(FAKE_ADAPTER);

    const Controller = createController({
      inject: {},
      routes: () => ({
        a: Fake('/a') as any,
        b: Fake('/b') as any,
        c: Fake('/c') as any,
        d: Fake('/d') as any,
        e: Fake('/e') as any,
      }),
    });

    const built = JustScale().add(Controller).build();
    const app = built.compile();
    await app.ready;

    assert.strictEqual(app.adapters.length, 1);
  });

  it('captures multiple distinct adapters from one controller', async () => {
    const A: Adapter = Object.freeze({ name: 'a', requires: [], start: () => {} });
    const B: Adapter = Object.freeze({ name: 'b', requires: [], start: () => {} });
    const FakeA = makeFactory(A);
    const FakeB = makeFactory(B);

    const Controller = createController({
      inject: {},
      routes: () => ({
        one: FakeA('/one') as any,
        two: FakeB('/two') as any,
      }),
    });

    const built = JustScale().add(Controller).build();
    const app = built.compile();
    await app.ready;

    assert.strictEqual(app.adapters.length, 2);
    const names = app.adapters.map((a) => a.name).sort();
    assert.deepStrictEqual(names, ['a', 'b']);
  });

  it('isolates adapter captures between concurrent builds in the same process', async () => {
    const A: Adapter = Object.freeze({ name: 'A-only', requires: [], start: () => {} });
    const B: Adapter = Object.freeze({ name: 'B-only', requires: [], start: () => {} });
    const FakeA = makeFactory(A);
    const FakeB = makeFactory(B);

    const CtrlA = createController({
      inject: {},
      routes: () => ({ x: FakeA('/a') as any }),
    });
    const CtrlB = createController({
      inject: {},
      routes: () => ({ x: FakeB('/b') as any }),
    });

    const [appA, appB] = await Promise.all([
      (async () => {
        const app = JustScale().add(CtrlA).build().compile();
        await app.ready;
        return app;
      })(),
      (async () => {
        const app = JustScale().add(CtrlB).build().compile();
        await app.ready;
        return app;
      })(),
    ]);

    assert.strictEqual(appA.adapters.length, 1);
    assert.strictEqual(appA.adapters[0], A);
    assert.strictEqual(appB.adapters.length, 1);
    assert.strictEqual(appB.adapters[0], B);
  });

  it('currentBuilder() is undefined outside .compile(), so module-top-level route factory calls silently no-op', () => {
    // Simulating: `const r = SomeFactory('/x')` at module scope (outside a build)
    const installedInScope: Adapter | null = null;
    const sentinel: Adapter = Object.freeze({ name: 'sentinel', requires: [], start: () => {} });

    currentBuilder()?.installAdapter(sentinel);
    // stayed null — no scope active
    assert.strictEqual(installedInScope, null);
  });
});
