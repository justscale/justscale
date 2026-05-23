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

describe('kernel', () => {
  it('starts adapters in registration order, stops in reverse', async () => {
    const events: string[] = [];
    const a: Adapter = {
      name: 'a',
      requires: [],
      start: async () => { events.push('a.start'); },
      stop: async () => { events.push('a.stop'); },
    };
    const b: Adapter = {
      name: 'b',
      requires: [],
      start: async () => { events.push('b.start'); },
      stop: async () => { events.push('b.stop'); },
    };

    const app = mockApp({ adapters: [a, b] });
    const kernel = createKernel({ app, signals: false });

    await kernel.start();
    assert.strictEqual(kernel.running, true);
    assert.deepStrictEqual(events, ['a.start', 'b.start']);

    await kernel.stop();
    assert.strictEqual(kernel.running, false);
    assert.deepStrictEqual(events, ['a.start', 'b.start', 'b.stop', 'a.stop']);
  });

  it('dedupes adapters with same reference', async () => {
    let startCount = 0;
    const a: Adapter = {
      name: 'http',
      requires: [],
      start: async () => { startCount++; },
    };

    const app = mockApp({ adapters: [a, a, a] });
    const kernel = createKernel({ app, signals: false });
    await kernel.start();
    assert.strictEqual(startCount, 1, 'same-ref adapter should start once');
    await kernel.stop();
  });

  it('warns and keeps first when two adapters share a name but differ by ref', async () => {
    const warnings: string[] = [];
    const logger = {
      warn: (msg: string) => warnings.push(msg),
      error: () => {},
      info: () => {},
      log: () => {},
    };

    const a1: Adapter = { name: 'http', requires: [], start: async () => {} };
    const a2: Adapter = { name: 'http', requires: [], start: async () => {} };

    const app = mockApp({ adapters: [a1, a2] });
    const kernel = createKernel({ app, signals: false, logger });
    await kernel.start();
    assert.strictEqual(kernel.startedAdapters.length, 1);
    assert.strictEqual(kernel.startedAdapters[0], a1);
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0]!, /two adapters registered under 'http'/);
    await kernel.stop();
  });

  it('resolves adapter requires from container before start', async () => {
    const resolved: unknown[] = [];
    const TOKEN_A = Symbol('token-a');
    const TOKEN_B = Symbol('token-b');
    const container = {
      resolve: async (token: unknown) => {
        if (token === TOKEN_A) return { kind: 'a' };
        if (token === TOKEN_B) return { kind: 'b' };
        return undefined;
      },
    };

    const adapter: Adapter = {
      name: 'multi-req',
      requires: [TOKEN_A as any, TOKEN_B as any],
      start: async (_app, ...args) => { resolved.push(...args); },
    };

    const app = mockApp({ adapters: [adapter], container: container as any });
    const kernel = createKernel({ app, signals: false });
    await kernel.start();
    assert.deepStrictEqual(resolved, [{ kind: 'a' }, { kind: 'b' }]);
    await kernel.stop();
  });

  it('stop() is idempotent and returns same promise for concurrent calls', async () => {
    let stopCount = 0;
    const a: Adapter = {
      name: 'x',
      requires: [],
      start: async () => {},
      stop: async () => { stopCount++; },
    };

    const app = mockApp({ adapters: [a] });
    const kernel = createKernel({ app, signals: false });
    await kernel.start();

    const p1 = kernel.stop();
    const p2 = kernel.stop();
    await Promise.all([p1, p2]);
    assert.strictEqual(stopCount, 1);
  });

  it('start() throws if already running', async () => {
    const app = mockApp({});
    const kernel = createKernel({ app, signals: false });
    await kernel.start();
    await assert.rejects(kernel.start(), /already running/);
    await kernel.stop();
  });

  it('continues stopping remaining adapters if one fails', async () => {
    const stopped: string[] = [];
    const a: Adapter = {
      name: 'a',
      requires: [],
      start: async () => {},
      stop: async () => { stopped.push('a'); },
    };
    const b: Adapter = {
      name: 'b',
      requires: [],
      start: async () => {},
      stop: async () => { throw new Error('b boom'); },
    };
    const c: Adapter = {
      name: 'c',
      requires: [],
      start: async () => {},
      stop: async () => { stopped.push('c'); },
    };

    const app = mockApp({ adapters: [a, b, c] });
    const kernel = createKernel({
      app,
      signals: false,
      logger: { warn: () => {}, error: () => {}, info: () => {}, log: () => {} },
    });
    await kernel.start();
    await kernel.stop();
    assert.deepStrictEqual(stopped, ['c', 'a']);
  });
});
