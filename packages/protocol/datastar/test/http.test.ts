import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createQueue } from '@justscale/core';

import { handleWatch, isWatchRoute } from '../src/http.js';
import { Watch, WATCH_ROUTE } from '../src/watch.js';

interface FakeReq extends IncomingMessage {
  emit(event: string): boolean
}

function fakeReq(urlStr = '/watch'): FakeReq {
  const emitter = new EventEmitter();
  const req = Object.assign(emitter, {
    url: urlStr,
    headers: { host: 'localhost' },
  });
  return req as unknown as FakeReq;
}

interface FakeRes {
  res: ServerResponse
  chunks: string[]
  headerCalls: Array<{ status: number; headers: Record<string, string> }>
  isEnded(): boolean
  emit(event: string): boolean
  markDestroyed(): void
  failWrites(): void
}

function fakeRes(): FakeRes {
  const emitter = new EventEmitter();
  const chunks: string[] = [];
  const headerCalls: Array<{ status: number; headers: Record<string, string> }> = [];
  let ended = false;
  let writeFails = false;
  const res = Object.assign(emitter, {
    statusCode: 200,
    headersSent: false,
    destroyed: false,
    writable: true,
    writeHead(status: number, headers: Record<string, string>) {
      headerCalls.push({ status, headers });
      (res as unknown as { headersSent: boolean }).headersSent = true;
    },
    write(chunk: string) {
      if (writeFails) throw new Error('socket closed');
      chunks.push(chunk);
      return true;
    },
    end() { ended = true; },
  }) as unknown as ServerResponse;
  return {
    res,
    chunks,
    headerCalls,
    isEnded: () => ended,
    emit: (event: string) => emitter.emit(event),
    markDestroyed() {
      (res as unknown as { destroyed: boolean; writable: boolean }).destroyed = true;
      (res as unknown as { destroyed: boolean; writable: boolean }).writable = false;
    },
    failWrites() { writeFails = true; },
  };
}

describe('isWatchRoute', () => {
  it('returns true for a route produced by Watch()', () => {
    const route = Watch('/x', async function* () { /* empty */ });
    assert.equal(isWatchRoute(route), true);
  });

  it('returns false for a plain object / null / wrong shape', () => {
    assert.equal(isWatchRoute(null), false);
    assert.equal(isWatchRoute({}), false);
    assert.equal(isWatchRoute({ method: 'GET' }), false);
  });

  it('the marker symbol is exported so external code can detect it', () => {
    const route = Watch('/y', async function* () { /* empty */ });
    assert.equal((route as Record<symbol, unknown>)[WATCH_ROUTE], true);
  });
});

describe('handleWatch — driving Watch through a fake ServerResponse', () => {
  it('writes SSE headers, a merge-signals frame per yield, and ends the response', async () => {
    const route = Watch('/ticks', async function* () {
      yield { count: 1 };
      yield { count: 2 };
    });

    const fake = fakeRes();
    await handleWatch(fakeReq('/ticks'), fake.res, { route, params: {}, deps: {} });

    // Headers
    assert.equal(fake.headerCalls.length, 1);
    assert.equal(fake.headerCalls[0].status, 200);
    assert.equal(fake.headerCalls[0].headers['Content-Type'], 'text/event-stream');
    assert.equal(fake.headerCalls[0].headers['Cache-Control'], 'no-cache');
    assert.equal(fake.headerCalls[0].headers['Connection'], 'keep-alive');
    assert.equal(fake.headerCalls[0].headers['X-Accel-Buffering'], 'no');

    // Payload
    assert.deepEqual(fake.chunks, [
      'event: datastar-merge-signals\ndata: signals {"count":1}\n\n',
      'event: datastar-merge-signals\ndata: signals {"count":2}\n\n',
    ]);

    // End
    assert.equal(fake.isEnded(), true);
  });

  it('forwards params and deps into the generator', async () => {
    let captured: { params: unknown; deps: unknown; signals: unknown } | undefined;

    const route = Watch('/items/:id', async function* (ctx) {
      captured = { params: ctx.params, deps: ctx.deps, signals: ctx.signals };
    });

    const { res } = fakeRes();
    await handleWatch(
      fakeReq('/items/42'),
      res,
      { route, params: { id: '42' }, deps: { svc: { tag: 'X' } } },
    );

    assert.ok(captured);
    assert.deepEqual(captured!.params, { id: '42' });
    assert.deepEqual(captured!.deps, { svc: { tag: 'X' } });
    // signals is injected by the HTTP handler as an empty object for now.
    assert.deepEqual(captured!.signals, {});
  });

  it('lets the Watch handler use the richer stream methods too', async () => {
    const route = Watch('/rich', async function* (ctx) {
      const s = ctx.stream as {
        mergeFragments: (h: string, o?: { selector?: string; mergeMode?: string }) => void
        removeSignals: (p: string[]) => void
      };
      s.mergeFragments('<b>hi</b>', { selector: '#t', mergeMode: 'append' });
      s.removeSignals(['a', 'b']);
    });

    const { res, chunks } = fakeRes();
    await handleWatch(fakeReq('/rich'), res, { route, params: {}, deps: {} });

    assert.deepEqual(chunks, [
      'event: datastar-merge-fragments\n'
      + 'data: selector #t\n'
      + 'data: mergeMode append\n'
      + 'data: fragments <b>hi</b>\n'
      + '\n',
      'event: datastar-remove-signals\ndata: paths a b\n\n',
    ]);
  });

  it('catches handler errors and writes a best-effort error signals frame before ending', async () => {
    const route = Watch('/boom', async function* () {
      yield { phase: 'before' };
      throw new Error('kaboom');
    });

    const fake = fakeRes();
    // Suppress the `console.error` the generator loop uses internally.
    const origError = console.error;
    console.error = () => {};
    try {
      await handleWatch(fakeReq('/boom'), fake.res, { route, params: {}, deps: {} });
    } finally {
      console.error = origError;
    }

    // The generator yields once (rendered as merge-signals), throws, and the
    // Watch route factory itself swallows the error and logs it. Because the
    // route factory never re-raises, the HTTP handler does NOT see the error
    // and so does not emit a secondary error frame. The response is still
    // ended cleanly.
    assert.deepEqual(fake.chunks, [
      'event: datastar-merge-signals\ndata: signals {"phase":"before"}\n\n',
    ]);
    assert.equal(fake.isEnded(), true);
  });
});

describe('handleWatch — heartbeat scheduling', () => {
  it('writes a heartbeat frame every heartbeat interval under fake timers', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    t.after(() => t.mock.timers.reset());

    // Generator holds open via a deferred promise — the test controls teardown
    // and the heartbeat timer is free to tick while the handler awaits.
    let release: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });

    const route = Watch('/hb').heartbeat(100).handle(async function* () {
      await done;
    });

    const fake = fakeRes();
    const p = handleWatch(fakeReq('/hb'), fake.res, { route, params: {}, deps: {} });

    // Advance through three heartbeat intervals. Each tick runs the interval
    // callback synchronously, which calls stream.heartbeat() -> res.write().
    t.mock.timers.tick(100);
    t.mock.timers.tick(100);
    t.mock.timers.tick(100);

    const heartbeatFrames = fake.chunks.filter((c) => c.startsWith(': heartbeat'));
    assert.equal(heartbeatFrames.length, 3);
    assert.equal(heartbeatFrames[0], ': heartbeat\n\n');

    release!();
    await p;
  });

  it('stops heartbeats when the handler returns normally', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    t.after(() => t.mock.timers.reset());

    const route = Watch('/hb-return').heartbeat(50).handle(async function* () {
      // Return immediately, no awaits — handler exits before any timer tick.
    });

    const fake = fakeRes();
    await handleWatch(fakeReq('/hb-return'), fake.res, { route, params: {}, deps: {} });

    // Advancing time after the handler returned must NOT produce more writes.
    const beforeTicks = fake.chunks.length;
    t.mock.timers.tick(500);
    assert.equal(fake.chunks.length, beforeTicks);
    assert.equal(fake.isEnded(), true);
  });

  it('stops heartbeats when the handler throws', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    t.after(() => t.mock.timers.reset());

    const origError = console.error;
    console.error = () => {};

    const route = Watch('/hb-throw').heartbeat(50).handle(async function* () {
      throw new Error('kaboom');
    });

    const fake = fakeRes();
    try {
      await handleWatch(fakeReq('/hb-throw'), fake.res, { route, params: {}, deps: {} });
    } finally {
      console.error = origError;
    }

    const beforeTicks = fake.chunks.length;
    t.mock.timers.tick(500);
    assert.equal(fake.chunks.length, beforeTicks);
    assert.equal(fake.isEnded(), true);
  });

  it('stops heartbeats when the request aborts mid-stream', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    t.after(() => t.mock.timers.reset());

    let release: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });

    const route = Watch('/hb-abort').heartbeat(100).handle(async function* () {
      await done;
    });

    const fake = fakeRes();
    const req = fakeReq('/hb-abort');
    const p = handleWatch(req, fake.res, { route, params: {}, deps: {} });

    // One heartbeat fires, then the client aborts; further ticks must be quiet.
    t.mock.timers.tick(100);
    assert.equal(fake.chunks.filter((c) => c.startsWith(': heartbeat')).length, 1);

    req.emit('aborted');

    const before = fake.chunks.length;
    t.mock.timers.tick(500);
    assert.equal(fake.chunks.length, before);

    release!();
    await p;
  });

  it('stops heartbeats and does not crash when write() throws after disconnect', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    t.after(() => t.mock.timers.reset());

    let release: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });

    const route = Watch('/hb-write-fail').heartbeat(100).handle(async function* () {
      await done;
    });

    const fake = fakeRes();
    const p = handleWatch(fakeReq('/hb-write-fail'), fake.res, { route, params: {}, deps: {} });

    // Simulate the socket getting torn down: subsequent writes throw.
    fake.failWrites();

    // The next tick tries to write and catches — must not surface.
    t.mock.timers.tick(100);
    // And subsequent ticks must be no-ops (timer cleared).
    const before = fake.chunks.length;
    t.mock.timers.tick(500);
    assert.equal(fake.chunks.length, before);

    release!();
    await p;
  });

  it('does not schedule a heartbeat when heartbeat(0) is set', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    t.after(() => t.mock.timers.reset());

    let release: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });

    const route = Watch('/no-hb').heartbeat(0).handle(async function* () {
      await done;
    });

    const fake = fakeRes();
    const p = handleWatch(fakeReq('/no-hb'), fake.res, { route, params: {}, deps: {} });

    // Advance a lot — no heartbeat should appear.
    t.mock.timers.tick(60_000);
    assert.equal(fake.chunks.filter((c) => c.startsWith(': heartbeat')).length, 0);

    release!();
    await p;
  });

  it('also treats heartbeat(false) as disabled', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    t.after(() => t.mock.timers.reset());

    let release: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });

    const route = Watch('/no-hb-false').heartbeat(false).handle(async function* () {
      await done;
    });

    const fake = fakeRes();
    const p = handleWatch(fakeReq('/no-hb-false'), fake.res, { route, params: {}, deps: {} });

    t.mock.timers.tick(60_000);
    assert.equal(fake.chunks.filter((c) => c.startsWith(': heartbeat')).length, 0);

    release!();
    await p;
  });
});

describe('handleWatch — signal hydration from ?datastar= query param', () => {
  it('parses a JSON object into ctx.signals', async () => {
    let captured: Record<string, unknown> | undefined;
    const route = Watch('/sig', async function* (ctx) {
      captured = ctx.signals;
    });

    const fake = fakeRes();
    const raw = encodeURIComponent(JSON.stringify({ k: 1, nested: { a: 'b' } }));
    await handleWatch(
      fakeReq(`/sig?datastar=${raw}`),
      fake.res,
      { route, params: {}, deps: {} },
    );

    assert.deepEqual(captured, { k: 1, nested: { a: 'b' } });
  });

  it('missing datastar param -> ctx.signals === {}', async () => {
    let captured: Record<string, unknown> | undefined;
    const route = Watch('/sig-missing', async function* (ctx) {
      captured = ctx.signals;
    });

    const fake = fakeRes();
    await handleWatch(fakeReq('/sig-missing'), fake.res, { route, params: {}, deps: {} });

    assert.deepEqual(captured, {});
  });

  it('empty datastar param -> ctx.signals === {}', async () => {
    let captured: Record<string, unknown> | undefined;
    const route = Watch('/sig-empty', async function* (ctx) {
      captured = ctx.signals;
    });

    const fake = fakeRes();
    await handleWatch(fakeReq('/sig-empty?datastar='), fake.res, { route, params: {}, deps: {} });

    assert.deepEqual(captured, {});
  });

  it('invalid JSON in datastar param -> ctx.signals === {}, no throw', async () => {
    let captured: Record<string, unknown> | undefined;
    const route = Watch('/sig-bad', async function* (ctx) {
      captured = ctx.signals;
    });

    const fake = fakeRes();
    await handleWatch(
      fakeReq('/sig-bad?datastar=not%20json'),
      fake.res,
      { route, params: {}, deps: {} },
    );

    assert.deepEqual(captured, {});
  });

  it('JSON null in datastar param -> ctx.signals === {}', async () => {
    let captured: Record<string, unknown> | undefined;
    const route = Watch('/sig-null', async function* (ctx) {
      captured = ctx.signals;
    });

    const fake = fakeRes();
    await handleWatch(
      fakeReq(`/sig-null?datastar=${encodeURIComponent('null')}`),
      fake.res,
      { route, params: {}, deps: {} },
    );

    assert.deepEqual(captured, {});
  });

  it('JSON array in datastar param -> ctx.signals === {}', async () => {
    let captured: Record<string, unknown> | undefined;
    const route = Watch('/sig-arr', async function* (ctx) {
      captured = ctx.signals;
    });

    const fake = fakeRes();
    await handleWatch(
      fakeReq(`/sig-arr?datastar=${encodeURIComponent('[1,2,3]')}`),
      fake.res,
      { route, params: {}, deps: {} },
    );

    assert.deepEqual(captured, {});
  });
});

describe('Watch builder form', () => {
  it('Watch(path).handle(gen) produces a Watch route with the default heartbeat', () => {
    const route = Watch('/chain').handle(async function* () { /* empty */ }) as Record<
      string | symbol,
      unknown
    >;
    assert.equal(route.method, 'GET');
    assert.equal(route.path, '/chain');
    assert.equal(isWatchRoute(route), true);
  });

  it('heartbeat chain is idempotent (last call wins)', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    t.after(() => t.mock.timers.reset());

    let release: () => void;
    const done = new Promise<void>((resolve) => { release = resolve; });

    // Set 1000ms, then override with 50ms. Ticking 100ms should fire twice.
    const route = Watch('/override').heartbeat(1000).heartbeat(50).handle(async function* () {
      await done;
    });

    const fake = fakeRes();
    const p = handleWatch(fakeReq('/override'), fake.res, { route, params: {}, deps: {} });
    t.mock.timers.tick(100);
    assert.equal(fake.chunks.filter((c) => c.startsWith(': heartbeat')).length, 2);
    release!();
    await p;
  });
});

describe('handleWatch — client disconnect (regression)', () => {
  it('resolves ctx.aborted, runs the generator finally, and completes the handler', async () => {
    // The canonical long-lived pattern: stream from a source, and close that
    // source when the client goes away. Before the fix `aborted` never fired,
    // the source never closed, and this handler hung forever (test timeout).
    const q = createQueue<number>();
    let abortedFired = false;
    let finallyRan = false;

    const route = Watch('/live').heartbeat(false).handle(async function* ({ aborted }) {
      aborted.then(() => { abortedFired = true; q.close(); });
      try {
        for await (const n of q) yield { n };
      } finally {
        finallyRan = true;
      }
    });

    const fake = fakeRes();
    const req = fakeReq('/live');
    const handlerDone = handleWatch(req, fake.res, { route, params: {}, deps: {} });

    // Stream one frame, then the client disconnects.
    q.push(1);
    await new Promise((r) => setTimeout(r, 10));
    req.emit('close');

    // Must not hang — if it does, node:test times the test out.
    await handlerDone;

    assert.equal(abortedFired, true, 'ctx.aborted must resolve on disconnect');
    assert.equal(finallyRan, true, 'generator finally must run after disconnect');
    assert.equal(fake.isEnded(), true);
    assert.deepEqual(fake.chunks, [
      'event: datastar-merge-signals\ndata: signals {"n":1}\n\n',
    ]);
  });

  it('res "close" also resolves ctx.aborted (not just req close)', async () => {
    let abortedFired = false;
    const route = Watch('/res-close').heartbeat(false).handle(async function* ({ aborted }) {
      await aborted;
      abortedFired = true;
    });
    const fake = fakeRes();
    const done = handleWatch(fakeReq('/res-close'), fake.res, { route, params: {}, deps: {} });
    await new Promise((r) => setTimeout(r, 10));
    fake.emit('close');
    await done;
    assert.equal(abortedFired, true);
  });
});

describe('handleWatch — reserved ctx fields (regression)', () => {
  it('a dependency named "stream" does not clobber the real ctx.stream', async () => {
    let captured: unknown;
    let capturedDep: unknown;

    const route = Watch('/clobber').handle(async function* ({ stream, deps }) {
      captured = stream;
      capturedDep = (deps as Record<string, unknown>).stream;
    });

    const fake = fakeRes();
    await handleWatch(fakeReq('/clobber'), fake.res, {
      route,
      params: {},
      deps: { stream: { notTheStream: true } },
    });

    assert.equal(
      typeof (captured as { mergeSignals?: unknown }).mergeSignals,
      'function',
      'ctx.stream must be the DatastarStream, not the injected dep',
    );
    assert.deepEqual(
      capturedDep,
      { notTheStream: true },
      'the injected dep is still reachable via ctx.deps',
    );
  });
});

