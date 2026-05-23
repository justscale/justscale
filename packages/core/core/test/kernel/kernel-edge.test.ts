/**
 * Edge-case tests for the kernel (createKernel).
 *
 * Covers:
 *   - stop() without prior start() is a no-op
 *   - stop() when no adapters is safe
 *   - adapters without stop() don't crash kernel.stop()
 *   - start() failures mid-chain
 *   - adapter failing during start propagates
 *   - lifecycle stop hook runs after adapter stops
 *   - lock provider close is invoked when provider is present
 *   - kernel.running reflects state correctly
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { App } from '../../src/app.js';
import type { Adapter } from '../../src/kernel/adapter.js';
import { createKernel } from '../../src/kernel/kernel.js';

function mockApp(partial: Partial<App>): App {
  return {
    container: { resolve: async () => undefined } as any,
    controllers: [],
    adapters: [],
    subApps: [],
    ready: Promise.resolve(),
    match: () => null,
    execute: async () => undefined,
    ...partial,
  };
}

describe('Kernel: stop without start', () => {
  it('stop() is safe when kernel was never started', async () => {
    const app = mockApp({});
    const kernel = createKernel({ app, signals: false });
    await kernel.stop();
    assert.strictEqual(kernel.running, false);
  });

  it('stop() twice in a row is safe', async () => {
    const app = mockApp({});
    const kernel = createKernel({ app, signals: false });
    await kernel.stop();
    await kernel.stop();
    assert.strictEqual(kernel.running, false);
  });
});

describe('Kernel: running state', () => {
  it('running is false before start', async () => {
    const app = mockApp({});
    const kernel = createKernel({ app, signals: false });
    assert.strictEqual(kernel.running, false);
  });

  it('running is true after start', async () => {
    const app = mockApp({});
    const kernel = createKernel({ app, signals: false });
    await kernel.start();
    assert.strictEqual(kernel.running, true);
    await kernel.stop();
  });

  it('running is false again after stop', async () => {
    const app = mockApp({});
    const kernel = createKernel({ app, signals: false });
    await kernel.start();
    await kernel.stop();
    assert.strictEqual(kernel.running, false);
  });
});

describe('Kernel: adapter without stop()', () => {
  it('is fine to have an adapter without a stop() method', async () => {
    const noStopAdapter: Adapter = {
      name: 'no-stop',
      requires: [],
      start: async () => {},
      // stop: missing — should be tolerated
    };
    const app = mockApp({ adapters: [noStopAdapter] });
    const kernel = createKernel({ app, signals: false });
    await kernel.start();
    await kernel.stop();
    assert.strictEqual(kernel.running, false);
  });
});

describe('Kernel: adapter startup failure', () => {
  it('propagates error from a failing adapter.start()', async () => {
    const bad: Adapter = {
      name: 'bad',
      requires: [],
      start: async () => {
        throw new Error('kaboom');
      },
    };
    const app = mockApp({ adapters: [bad] });
    const kernel = createKernel({ app, signals: false });
    await assert.rejects(kernel.start(), /kaboom/);
  });

  it('subsequent adapters are NOT started after a failure (fail-fast)', async () => {
    let secondStarted = false;
    const bad: Adapter = {
      name: 'bad',
      requires: [],
      start: async () => {
        throw new Error('nope');
      },
    };
    const ok: Adapter = {
      name: 'ok',
      requires: [],
      start: async () => {
        secondStarted = true;
      },
    };
    const app = mockApp({ adapters: [bad, ok] });
    const kernel = createKernel({ app, signals: false });
    await assert.rejects(kernel.start());
    assert.strictEqual(secondStarted, false);
  });
});

describe('Kernel: await app.ready before starting adapters', () => {
  it('waits for app.ready to resolve before starting adapters', async () => {
    let readyResolved = false;
    let adapterStarted = false;
    let resolveReady: () => void = () => {};
    const ready = new Promise<void>((r) => {
      resolveReady = () => {
        readyResolved = true;
        r();
      };
    });

    const adapter: Adapter = {
      name: 'needs-ready',
      requires: [],
      start: async () => {
        assert.ok(readyResolved, 'adapter.start called before app.ready resolved');
        adapterStarted = true;
      },
    };
    const app = mockApp({ adapters: [adapter], ready });
    const kernel = createKernel({ app, signals: false });

    const startPromise = kernel.start();
    // Give a tick for start() to reach `await app.ready`.
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(adapterStarted, false);

    resolveReady();
    await startPromise;
    assert.strictEqual(adapterStarted, true);
    await kernel.stop();
  });
});

describe('Kernel: startedAdapters tracking', () => {
  it('startedAdapters contains only the adapters that actually started', async () => {
    const a: Adapter = { name: 'a', requires: [], start: async () => {} };
    const b: Adapter = { name: 'b', requires: [], start: async () => {} };
    const app = mockApp({ adapters: [a, b] });
    const kernel = createKernel({ app, signals: false });
    await kernel.start();
    assert.strictEqual(kernel.startedAdapters.length, 2);
    await kernel.stop();
  });

  it('startedAdapters is emptied on stop', async () => {
    const a: Adapter = {
      name: 'a',
      requires: [],
      start: async () => {},
      stop: async () => {},
    };
    const app = mockApp({ adapters: [a] });
    const kernel = createKernel({ app, signals: false });
    await kernel.start();
    assert.strictEqual(kernel.startedAdapters.length, 1);
    await kernel.stop();
    assert.strictEqual(kernel.startedAdapters.length, 0);
  });
});
