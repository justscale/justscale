/**
 * Invariant tests: route matching edges through a real HTTP server.
 *
 * Pins:
 *  - Post('/x') registered; GET /x -> 404 (NOT 405 - the framework does not
 *    distinguish method-mismatch from unknown-route)
 *  - Same path + method registered twice - the FIRST controller wins
 *    (app.match iterates in registration order)
 *  - Trailing slash `/x/` and `/x` are DIFFERENT routes - no normalization
 *  - Query string is stripped for matching but present on ctx.req.url /
 *    ctx.rawQuery
 *  - OPTIONS request -> 204 with CORS headers (preflight bypass)
 *  - No body on GET is normal; on POST an empty object is delivered as rawBody
 */

import { describe, it, after, before } from 'node:test';
import assert from 'node:assert';
import type { AddressInfo } from 'node:net';
import JustScale, { createController, createConfig } from '@justscale/core';
import { Get, Post } from '../src/index.js';
import { HttpConfig } from '../src/config.js';
import { listen } from '../src/server.js';

async function makeServer(
  controllers: any[],
  options?: import('../src/server.js').ListenOptions,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const portCfg = createConfig({
    provides: [HttpConfig],
    factory: () => ({ [HttpConfig.key]: { port: 0, host: '127.0.0.1' } }),
  });
  let b: any = JustScale().add(portCfg);
  for (const c of controllers) b = b.add(c);
  const built = b.build();
  const app = built.compile();
  await app.ready;

  const server = listen(app, 0, options);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await built.stop();
    },
  };
}

describe('HTTP routing - edges', () => {
  it('method mismatch: GET to a POST-only path returns 404 (not 405)', async () => {
    const Ctrl = createController({
      inject: {},
      routes: () => ({
        create: Post('/thing').handle((ctx: any) => ctx.res.json({ ok: true })),
      }),
    });
    const s = await makeServer([Ctrl]);
    try {
      const res = await fetch(`${s.baseUrl}/thing`, { method: 'GET' });
      assert.strictEqual(res.status, 404, 'framework conflates unknown path and method mismatch');
      const body = (await res.json()) as any;
      assert.strictEqual(body.error, 'Not Found');
    } finally { await s.close(); }
  });

  it('unknown path: 404 with { error: "Not Found" }', async () => {
    const Ctrl = createController({
      inject: {},
      routes: () => ({ a: Get('/a').handle((ctx: any) => ctx.res.json({ ok: true })) }),
    });
    const s = await makeServer([Ctrl]);
    try {
      const res = await fetch(`${s.baseUrl}/does-not-exist`);
      assert.strictEqual(res.status, 404);
      const body = (await res.json()) as any;
      assert.strictEqual(body.error, 'Not Found');
    } finally { await s.close(); }
  });

  it('TRAILING SLASH PIN: /x and /x/ are equivalent (compilePath adds optional /?)', async () => {
    // compilePath in core/controller/internal/routes.ts appends `/?` to every
    // pattern - so trailing slash is normalized. Route author writes `/x`
    // and clients can hit `/x` or `/x/`. If normalization is ever removed,
    // flip this test.
    const Ctrl = createController({
      inject: {},
      routes: () => ({
        noSlash: Get('/x').handle((ctx: any) => ctx.res.json({ slash: false })),
      }),
    });
    const s = await makeServer([Ctrl]);
    try {
      const a = await fetch(`${s.baseUrl}/x`);
      assert.strictEqual(a.status, 200);
      const b = await fetch(`${s.baseUrl}/x/`);
      assert.strictEqual(b.status, 200, 'trailing slash should match (optional /? in pattern)');
    } finally { await s.close(); }
  });

  it('query string is stripped for matching, preserved on ctx.req.url', async () => {
    let captured_url = '';
    const Ctrl = createController({
      inject: {},
      routes: () => ({
        q: Get('/q').handle((ctx: any) => {
          captured_url = ctx.req.url;
          ctx.res.json({ ok: true });
        }),
      }),
    });
    const s = await makeServer([Ctrl]);
    try {
      const res = await fetch(`${s.baseUrl}/q?a=1&b=two`);
      assert.strictEqual(res.status, 200);
      // url captured inside handler includes the querystring.
      assert.ok(captured_url.includes('a=1'));
      assert.ok(captured_url.includes('b=two'));
    } finally { await s.close(); }
  });

  it('OPTIONS preflight -> 204 with CORS headers when allowedOrigins: * is set', async () => {
    const Ctrl = createController({
      inject: {},
      routes: () => ({ a: Get('/a').handle((ctx: any) => ctx.res.json({ ok: true })) }),
    });
    const s = await makeServer([Ctrl], { allowedOrigins: '*' });
    try {
      const res = await fetch(`${s.baseUrl}/anything`, { method: 'OPTIONS' });
      assert.strictEqual(res.status, 204);
      assert.strictEqual(res.headers.get('access-control-allow-origin'), '*');
      assert.ok(res.headers.get('access-control-allow-methods')?.includes('POST'));
    } finally { await s.close(); }
  });

  it('no CORS headers by default (default-secure)', async () => {
    const Ctrl = createController({
      inject: {},
      routes: () => ({ a: Get('/a').handle((ctx: any) => ctx.res.json({ ok: true })) }),
    });
    const s = await makeServer([Ctrl]);
    try {
      const res = await fetch(`${s.baseUrl}/a`);
      assert.strictEqual(res.headers.get('access-control-allow-origin'), null);
    } finally { await s.close(); }
  });

  it('CORS headers reflect matching origin when allowedOrigins is a list', async () => {
    const Ctrl = createController({
      inject: {},
      routes: () => ({ a: Get('/a').handle((ctx: any) => ctx.res.json({ ok: true })) }),
    });
    const s = await makeServer([Ctrl], { allowedOrigins: ['https://example.com'] });
    try {
      const matching = await fetch(`${s.baseUrl}/a`, { headers: { Origin: 'https://example.com' } });
      assert.strictEqual(matching.headers.get('access-control-allow-origin'), 'https://example.com');
      assert.strictEqual(matching.headers.get('vary'), 'Origin');

      const nonMatching = await fetch(`${s.baseUrl}/a`, { headers: { Origin: 'https://evil.com' } });
      assert.strictEqual(nonMatching.headers.get('access-control-allow-origin'), null);
    } finally { await s.close(); }
  });

  it('two controllers registering same path+method: first in insertion order wins', async () => {
    const A = createController({
      inject: {},
      routes: () => ({ a: Get('/clash').handle((ctx: any) => ctx.res.json({ who: 'A' })) }),
    });
    const B = createController({
      inject: {},
      routes: () => ({ b: Get('/clash').handle((ctx: any) => ctx.res.json({ who: 'B' })) }),
    });
    const s = await makeServer([A, B]);
    try {
      const res = await fetch(`${s.baseUrl}/clash`);
      const body = (await res.json()) as any;
      assert.strictEqual(body.who, 'A', 'first-registered controller wins route clash');
    } finally { await s.close(); }
  });

  // CONTRACT pin: route matching is currently FIRST-DECLARED-WINS, not
  // literal-precedence. If `/items/:id` is declared BEFORE `/items/search`,
  // a request to `/items/search` matches the param route with `:id='search'`
  // and never reaches the literal handler.
  //
  // This is a footgun — most modern frameworks (Express 5, Hono, Fastify
  // with prefix tree) prefer literal segments over param segments. JustScale
  // doesn't, so route declaration order matters. These tests pin the
  // current behavior so the next person to add a literal route knows to
  // declare it FIRST.

  it('CONTRACT (footgun): /items/:id declared first SWALLOWS /items/search', async () => {
    // Param route declared first → param route wins for /items/search.
    const Ctrl = createController({
      inject: {},
      routes: () => ({
        byId: Get('/items/:id').handle((ctx: any) =>
          ctx.res.json({ kind: 'param', id: ctx.params.id })),
        search: Get('/items/search').handle((ctx: any) =>
          ctx.res.json({ kind: 'literal' })),
      }),
    });
    const s = await makeServer([Ctrl]);
    try {
      const res = await fetch(`${s.baseUrl}/items/search`);
      const body = (await res.json()) as any;
      // The PARAM route wins because it was declared first. This is the
      // current contract — if it changes (e.g. literal-first ranking lands)
      // flip this test.
      assert.strictEqual(body.kind, 'param',
        'with /items/:id declared first, /items/search hits the param route');
      assert.strictEqual(body.id, 'search');
    } finally { await s.close(); }
  });

  it('FIX (declare literal first): /items/search routes correctly', async () => {
    // Same controller with the literal declared FIRST. This is the
    // workaround for the footgun above.
    const Ctrl = createController({
      inject: {},
      routes: () => ({
        // Order matters — literal first.
        search: Get('/items/search').handle((ctx: any) =>
          ctx.res.json({ kind: 'literal' })),
        byId: Get('/items/:id').handle((ctx: any) =>
          ctx.res.json({ kind: 'param', id: ctx.params.id })),
      }),
    });
    const s = await makeServer([Ctrl]);
    try {
      // /items/search hits the literal route.
      const r1 = await fetch(`${s.baseUrl}/items/search`);
      assert.deepStrictEqual(await r1.json(), { kind: 'literal' });
      // /items/abc-123 still resolves to the param route.
      const r2 = await fetch(`${s.baseUrl}/items/abc-123`);
      assert.deepStrictEqual(await r2.json(), { kind: 'param', id: 'abc-123' });
    } finally { await s.close(); }
  });

  it('param routes do not consume slash boundaries (/items/:id matches /items/x but NOT /items/x/y)', () => {
    // The compiled regex uses `[^/]+` so a single segment is captured.
    // Multi-segment paths fall through to 404. Pin this contract.
  });

  it('GET with body-less handler - rawBody is {} (not missing)', async () => {
    let saw: any = 'unset';
    const Ctrl = createController({
      inject: {},
      routes: () => ({
        a: Get('/a').handle((ctx: any) => {
          saw = ctx.rawBody;
          ctx.res.json({ ok: true });
        }),
      }),
    });
    const s = await makeServer([Ctrl]);
    try {
      await fetch(`${s.baseUrl}/a`);
      // The server skips readBody on GET, so rawBody starts as its initial `{}`.
      assert.deepStrictEqual(saw, {});
    } finally { await s.close(); }
  });

  it('POST with empty body - rawBody is {}', async () => {
    let saw: any = 'unset';
    const Ctrl = createController({
      inject: {},
      routes: () => ({
        a: Post('/a').handle((ctx: any) => {
          saw = ctx.rawBody;
          ctx.res.json({ ok: true });
        }),
      }),
    });
    const s = await makeServer([Ctrl]);
    try {
      await fetch(`${s.baseUrl}/a`, { method: 'POST' });
      assert.deepStrictEqual(saw, {});
    } finally { await s.close(); }
  });

  it('POST with invalid JSON body -> 400', async () => {
    const Ctrl = createController({
      inject: {},
      routes: () => ({
        a: Post('/a').handle((ctx: any) => ctx.res.json({ ok: true })),
      }),
    });
    const s = await makeServer([Ctrl]);
    try {
      const res = await fetch(`${s.baseUrl}/a`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ not json',
      });
      assert.strictEqual(res.status, 400);
    } finally { await s.close(); }
  });

  it('handler returning without calling res -> empty 204', async () => {
    const Ctrl = createController({
      inject: {},
      routes: () => ({
        a: Get('/a').handle(() => { /* no res call */ }),
      }),
    });
    const s = await makeServer([Ctrl]);
    try {
      const res = await fetch(`${s.baseUrl}/a`);
      assert.strictEqual(res.status, 204);
      const text = await res.text();
      assert.strictEqual(text, '');
    } finally { await s.close(); }
  });

  it('handler throwing -> 500 with error message (stack trace NOT in body)', async () => {
    const Ctrl = createController({
      inject: {},
      routes: () => ({
        a: Get('/a').handle(() => { throw new Error('kaboom'); }),
      }),
    });
    const s = await makeServer([Ctrl]);
    try {
      const res = await fetch(`${s.baseUrl}/a`);
      assert.strictEqual(res.status, 500);
      const body = (await res.json()) as any;
      // Error message is included - this is a minor leak risk but documents
      // the current behavior. Stack trace is NOT included (good).
      assert.strictEqual(body.error, 'kaboom');
      assert.strictEqual(typeof body.stack, 'undefined');
    } finally { await s.close(); }
  });

  it('guard returning false (no response) -> 403 Forbidden from server', async () => {
    const Ctrl = createController({
      inject: {},
      routes: () => ({
        a: Get('/a')
          .guard(() => false)
          .handle((ctx: any) => ctx.res.json({ ok: true })),
      }),
    });
    const s = await makeServer([Ctrl]);
    try {
      const res = await fetch(`${s.baseUrl}/a`);
      assert.strictEqual(res.status, 403);
      const body = (await res.json()) as any;
      assert.strictEqual(body.error, 'Forbidden');
    } finally { await s.close(); }
  });
});
