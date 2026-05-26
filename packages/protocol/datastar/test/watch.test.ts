import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Watch } from '../src/watch.js';
import type { DatastarStream, WatchContext } from '../src/types.js';

type MergeSignalsCall = Record<string, unknown>;

function fakeStream(): { stream: DatastarStream; merges: MergeSignalsCall[] } {
  const merges: MergeSignalsCall[] = [];
  const stream: DatastarStream = {
    mergeSignals(data) { merges.push(data); },
    mergeFragments() {},
    removeFragments() {},
    removeSignals() {},
    executeScript() {},
  };
  return { stream, merges };
}

describe('Watch route factory', () => {
  it('returns a route def with method GET, the given path, empty steps, and a handler', () => {
    const route = Watch('/items/:id', async function* () {
      // never yields
    }) as { method: string; path: string; steps: unknown[]; responseSchemas: Map<unknown, unknown>; handler: Function };

    assert.equal(route.method, 'GET');
    assert.equal(route.path, '/items/:id');
    assert.deepEqual(route.steps, []);
    assert.ok(route.responseSchemas instanceof Map);
    assert.equal(route.responseSchemas.size, 0);
    assert.equal(typeof route.handler, 'function');
  });

  it('forwards each yielded record to stream.mergeSignals and terminates', async () => {
    const { stream, merges } = fakeStream();

    const route = Watch('/ticks', async function* () {
      yield { count: 1 };
      yield { count: 2, label: 'two' };
      yield { count: 3 };
    }) as { handler: (ctx: unknown) => Promise<void> };

    await route.handler({ deps: {}, params: {}, signals: {}, stream });

    assert.equal(merges.length, 3);
    assert.deepEqual(merges[0], { count: 1 });
    assert.deepEqual(merges[1], { count: 2, label: 'two' });
    assert.deepEqual(merges[2], { count: 3 });
  });

  it('passes deps, signals, params, and an aborted promise into the generator ctx', async () => {
    const { stream } = fakeStream();
    const deps = { svc: { value: 'marker' } };
    const params = { id: 'abc' };
    const signals = { existing: true };

    let captured: WatchContext<typeof deps, typeof params> | undefined;

    const route = Watch('/items/:id', async function* (ctx: WatchContext<typeof deps, typeof params>) {
      captured = ctx;
      // yield nothing; exit immediately
    }) as { handler: (ctx: unknown) => Promise<void> };

    await route.handler({ deps, params, signals, stream });

    assert.ok(captured, 'generator should have been invoked');
    const ctx = captured as WatchContext<typeof deps, typeof params>;
    assert.equal(ctx.deps, deps);
    assert.equal(ctx.params, params);
    assert.equal(ctx.signals, signals);
    assert.equal(ctx.stream, stream);
    assert.ok(ctx.aborted instanceof Promise);
  });

  it('runs the generators finally block when the handler tears down', async () => {
    const { stream } = fakeStream();
    let finallyRan = false;
    let yielded = 0;

    const route = Watch('/once', async function* () {
      try {
        yield { n: 1 };
        yielded++;
      } finally {
        finallyRan = true;
      }
    }) as { handler: (ctx: unknown) => Promise<void> };

    await route.handler({ deps: {}, params: {}, signals: {}, stream });
    assert.equal(finallyRan, true, 'generator finally must run on teardown');
    // The handler iterates once, then the generator exits via its own return
    // point on the next pull — we don't care about `yielded`, only that
    // teardown happened cleanly.
    void yielded;
  });

  it('resolves the aborted promise after the handler returns', async () => {
    const { stream } = fakeStream();
    let abortedPromise: Promise<void> | undefined;

    const route = Watch('/x', async function* (ctx: WatchContext<unknown, Record<string, string>>) {
      abortedPromise = ctx.aborted;
    }) as { handler: (ctx: unknown) => Promise<void> };

    await route.handler({ deps: {}, params: {}, signals: {}, stream });

    assert.ok(abortedPromise, 'aborted promise must be captured');
    // If this never resolves, node:test will time out the test.
    await (abortedPromise as Promise<void>);
  });

  it('swallows a generator error whose message is exactly "aborted"', async () => {
    const { stream, merges } = fakeStream();

    const route = Watch('/err', async function* () {
      yield { ok: 1 };
      throw new Error('aborted');
    }) as { handler: (ctx: unknown) => Promise<void> };

    // Must not reject — the handler treats "aborted" as a normal disconnect.
    await route.handler({ deps: {}, params: {}, signals: {}, stream });

    assert.equal(merges.length, 1);
    assert.deepEqual(merges[0], { ok: 1 });
  });

  it('does not throw for generic generator errors (logged, not re-raised)', async () => {
    const { stream } = fakeStream();
    const origError = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => { logged.push(args); };

    try {
      const route = Watch('/boom', async function* () {
        throw new Error('kaboom');
      }) as { handler: (ctx: unknown) => Promise<void> };

      await route.handler({ deps: {}, params: {}, signals: {}, stream });
    } finally {
      console.error = origError;
    }

    // The handler catches and console.errors instead of re-throwing.
    assert.ok(
      logged.some(args => String(args[0]).includes('Watch generator error')),
      'expected the generator error to be logged',
    );
  });
});
