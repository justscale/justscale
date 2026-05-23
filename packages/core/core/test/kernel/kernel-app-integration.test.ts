/**
 * Integration tests for the kernel against a real JustScale app.
 *
 * Covers lifecycle behavior the pure-mock kernel tests can't: adapter
 * requires actually resolve from the DI container, Lifecycle stop hooks
 * run after adapters stop, and concurrent/repeated serve cycles behave
 * deterministically.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import JustScale from '../../src/justscale.js';
import { defineService, Lifecycle } from '../../src/index.js';
import { currentBuilder } from '../../src/builder/build-context.js';
import { createController } from '../../src/core/controller.js';
import { createKernel } from '../../src/kernel/kernel.js';
import type { Adapter } from '../../src/kernel/adapter.js';

function installingRoute(adapter: Adapter) {
  return (path: string) => {
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

describe('kernel + app integration', () => {
  it('resolves adapter requires from the app\'s container', async () => {
    class ConfigA {
      readonly tag = 'A' as const;
    }
    class ConfigB {
      readonly tag = 'B' as const;
    }

    const ConfigAService = defineService({
      inject: {},
      factory: () => new ConfigA(),
    });
    const ConfigBService = defineService({
      inject: {},
      factory: () => new ConfigB(),
    });

    let captured: unknown[] = [];
    const ADAPTER: Adapter = Object.freeze({
      name: 'requires-resolver',
      requires: [ConfigAService as any, ConfigBService as any],
      start: (_app: unknown, ...resolved: unknown[]) => {
        captured = resolved;
      },
    });
    const Fake = installingRoute(ADAPTER);

    const Ctrl = createController({
      inject: {},
      routes: () => ({ r: Fake('/r') as any }),
    });

    const built = JustScale()
      .add(ConfigAService)
      .add(ConfigBService)
      .add(Ctrl)
      .build();
    const app = built.compile();
    await app.ready;

    const kernel = createKernel({ app, signals: false });
    await kernel.start();

    assert.strictEqual(captured.length, 2);
    assert.strictEqual((captured[0] as ConfigA).tag, 'A');
    assert.strictEqual((captured[1] as ConfigB).tag, 'B');

    await kernel.stop();
  });

  it('runs Lifecycle stop hooks before adapters stop, LIFO order', async () => {
    const events: string[] = [];

    const ADAPTER: Adapter = Object.freeze({
      name: 'ordered',
      requires: [],
      start: () => { events.push('adapter.start'); },
      stop: () => { events.push('adapter.stop'); },
    });

    const HookRegistrar = defineService({
      inject: { lifecycle: Lifecycle },
      factory: ({ lifecycle }) => {
        lifecycle.register('stop', () => { events.push('hook.first-registered'); });
        lifecycle.register('stop', () => { events.push('hook.second-registered'); });
        return {};
      },
    });

    const Fake = installingRoute(ADAPTER);
    const Ctrl = createController({
      inject: {},
      routes: () => ({ r: Fake('/r') as any }),
    });

    const built = JustScale().add(HookRegistrar).add(Ctrl).build();
    const app = built.compile();
    await app.ready;

    const kernel = createKernel({ app, signals: false });
    await kernel.start();
    await kernel.stop();

    // Stop hooks run LIFO (second-registered then first), then adapters stop.
    // Hooks-before-adapters lets stop logic use adapter resources (e.g. issue
    // a final query against a still-live postgres pool); the previous order
    // tore down adapters first and made hooks effectively post-mortem.
    assert.deepStrictEqual(events, [
      'adapter.start',
      'hook.second-registered',
      'hook.first-registered',
      'adapter.stop',
    ]);
  });

  it('start+stop cycles leave the kernel reusable (new kernel per cycle)', async () => {
    const counts = { start: 0, stop: 0 };
    const ADAPTER: Adapter = Object.freeze({
      name: 'cyclic',
      requires: [],
      start: () => { counts.start++; },
      stop: () => { counts.stop++; },
    });

    const Fake = installingRoute(ADAPTER);
    const Ctrl = createController({
      inject: {},
      routes: () => ({ r: Fake('/r') as any }),
    });

    const built = JustScale().add(Ctrl).build();
    const app = built.compile();
    await app.ready;

    for (let i = 0; i < 3; i++) {
      const kernel = createKernel({ app, signals: false });
      await kernel.start();
      await kernel.stop();
    }

    assert.strictEqual(counts.start, 3);
    assert.strictEqual(counts.stop, 3);
  });

  it('kernel.stop() is safe when no lifecycle / lock provider is registered', async () => {
    const ADAPTER: Adapter = Object.freeze({
      name: 'bare',
      requires: [],
      start: () => {},
      stop: () => {},
    });
    const Fake = installingRoute(ADAPTER);
    const Ctrl = createController({
      inject: {},
      routes: () => ({ r: Fake('/r') as any }),
    });

    const built = JustScale().add(Ctrl).build();
    const app = built.compile();
    await app.ready;

    const kernel = createKernel({ app, signals: false });
    await kernel.start();
    // Should not throw on any of: no Lifecycle registered (it is — built-in),
    // no lock provider registered.
    await kernel.stop();
  });

  it('BuiltApp.serve() delegates to the kernel and starts app adapters', async () => {
    const started: string[] = [];
    const ADAPTER: Adapter = Object.freeze({
      name: 'built-app-serve',
      requires: [],
      start: () => { started.push('started'); },
      stop: () => { started.push('stopped'); },
    });

    const Fake = installingRoute(ADAPTER);
    const Ctrl = createController({
      inject: {},
      routes: () => ({ r: Fake('/r') as any }),
    });

    const built = JustScale().add(Ctrl).build();

    await built.serve({ noSocket: true });
    assert.deepStrictEqual(started, ['started']);

    await built.stop();
    assert.deepStrictEqual(started, ['started', 'stopped']);
  });
});
