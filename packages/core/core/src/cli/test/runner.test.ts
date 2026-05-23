/**
 * Edge-case tests for the CLI runner (run + invoke + buildRouteMap).
 *
 * Uses a lightweight test harness that skips the full JustScale
 * builder — just enough to exercise route discovery and execution.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
// Importing from ../factory.js triggers a circular TDZ through ../index.js
// -> features/config/cli -> cli/index.ts. Use the builder module directly.
import { Cli } from '../builder/create-cli-builder.js';
import { invoke, run, buildRouteMap, createClient } from '../runner.js';
import { createMockIO, type CliIO } from '../io.js';
import type { App } from '../../index.js';

function makeApp(controllers: any[]): App {
  return {
    controllers: controllers.map((c) => ({ ...c, deps: {}, routes: c.routes })),
    container: null as any,
    adapters: [],
    subApps: [],
    ready: Promise.resolve(),
    match: () => null,
    execute: async () => {},
  } as unknown as App;
}

function makeController(routes: any[], command?: string) {
  return { settings: command ? { command } : {}, routes };
}

describe('CLI runner — buildRouteMap', () => {
  it('collects routes with prefix + path', () => {
    const r1 = Cli('login').handle(() => {});
    const r2 = Cli('logout').handle(() => {});
    const app = makeApp([makeController([r1, r2], 'auth')]);
    const routes = buildRouteMap(app);
    assert.ok(routes.has('auth login'));
    assert.ok(routes.has('auth logout'));
  });

  it('treats empty prefix as top-level command', () => {
    const r = Cli('status').handle(() => {});
    const app = makeApp([makeController([r])]);
    const routes = buildRouteMap(app);
    assert.ok(routes.has('status'));
  });

  it('ignores non-CLI routes in the same controller', () => {
    const cliRoute = Cli('foo').handle(() => {});
    const fakeHttp = { method: 'GET', path: '/foo', segments: ['foo'] };
    const app = makeApp([makeController([cliRoute, fakeHttp])]);
    const routes = buildRouteMap(app);
    assert.equal(routes.size, 1);
    assert.ok(routes.has('foo'));
  });

  it('preserves description via .describe()', () => {
    const r = Cli('status').describe('Show status').handle(() => {});
    const app = makeApp([makeController([r])]);
    const routes = buildRouteMap(app);
    assert.equal(routes.get('status')?.description, 'Show status');
  });
});

describe('CLI runner — run() help + completion', () => {
  it('no argv prints help and succeeds', async () => {
    const r = Cli('hi').handle(() => {});
    const app = makeApp([makeController([r])]);
    const io = createMockIO();
    const result = await run(app, { argv: [], io, exitOnError: false });
    assert.equal(result.success, true);
    assert.ok(io.output.some((o) => /Commands:|Usage:/.test(o)));
  });

  it('--help at root prints help', async () => {
    const r = Cli('hi').handle(() => {});
    const app = makeApp([makeController([r])]);
    const io = createMockIO();
    const result = await run(app, { argv: ['--help'], io, exitOnError: false });
    assert.equal(result.success, true);
  });

  it('-h alias works at root', async () => {
    const r = Cli('hi').handle(() => {});
    const app = makeApp([makeController([r])]);
    const io = createMockIO();
    const result = await run(app, { argv: ['-h'], io, exitOnError: false });
    assert.equal(result.success, true);
  });

  it('--help for a specific command prints per-command help', async () => {
    const r = Cli('build').describe('Build it').input(z.object({ src: z.string() })).handle(() => {});
    const app = makeApp([makeController([r])]);
    const io = createMockIO();
    const result = await run(app, { argv: ['build', '--help'], io, exitOnError: false });
    assert.equal(result.success, true);
    const out = io.output.join('\n');
    assert.match(out, /Build it/);
    assert.match(out, /Usage: build/);
  });

  it('__complete emits candidates', async () => {
    const r = Cli('status').handle(() => {});
    const app = makeApp([makeController([r])]);
    const io = createMockIO();
    const result = await run(app, { argv: ['__complete', '0', ''], io, exitOnError: false });
    assert.equal(result.success, true);
    assert.ok(io.output.includes('status'));
  });
});

describe('CLI runner — run() error paths', () => {
  it('unknown command returns success=false (exitOnError: false)', async () => {
    const r = Cli('status').handle(() => {});
    const app = makeApp([makeController([r])]);
    const io = createMockIO();
    const result = await run(app, { argv: ['does', 'not', 'exist'], io, exitOnError: false });
    assert.equal(result.success, false);
    assert.ok(io.errors.length > 0);
  });

  it('validation errors surface a generic usage hint', async () => {
    const r = Cli('foo').input(z.object({ email: z.string().email() })).handle(() => {});
    const app = makeApp([makeController([r])]);
    const io = createMockIO();
    const result = await run(app, { argv: ['foo', 'not-an-email'], io, exitOnError: false });
    assert.equal(result.success, false);
    assert.ok(io.errors.some((e) => /email/i.test(e)));
  });

  it('handler throwing surfaces as failure', async () => {
    const r = Cli('boom').handle(() => {
      throw new Error('kapow');
    });
    const app = makeApp([makeController([r])]);
    const io = createMockIO();
    const result = await run(app, { argv: ['boom'], io, exitOnError: false });
    assert.equal(result.success, false);
    assert.ok(io.errors.some((e) => /kapow/.test(e)));
  });

  it('parser error (unknown flag) fails fast', async () => {
    const r = Cli('foo').input(z.object({ x: z.string() })).handle(() => {});
    const app = makeApp([makeController([r])]);
    const io = createMockIO();
    const result = await run(app, { argv: ['foo', '--unknown'], io, exitOnError: false });
    assert.equal(result.success, false);
  });
});

describe('CLI runner — run() execution', () => {
  it('positional arg is passed through', async () => {
    let received: unknown;
    const r = Cli('greet').input(z.object({ who: z.string() })).handle((ctx) => {
      received = ctx.args.who;
    });
    const app = makeApp([makeController([r])]);
    const io = createMockIO();
    await run(app, { argv: ['greet', 'world'], io, exitOnError: false });
    assert.equal(received, 'world');
  });

  it('defaults flow through when flags omitted', async () => {
    let received: unknown;
    const schema = z.object({ env: z.string().default('dev') });
    const r = Cli('deploy').input(schema).handle((ctx) => {
      received = ctx.args.env;
    });
    const app = makeApp([makeController([r])]);
    const io = createMockIO();
    await run(app, { argv: ['deploy'], io, exitOnError: false });
    assert.equal(received, 'dev');
  });

  it('multi-segment command resolves via longest-match', async () => {
    let called = '';
    const a = Cli('user').handle(() => {
      called = 'user';
    });
    const b = Cli('user add').handle(() => {
      called = 'user-add';
    });
    const app = makeApp([makeController([a, b])]);
    const io = createMockIO();
    await run(app, { argv: ['user', 'add'], io, exitOnError: false });
    assert.equal(called, 'user-add');
  });

  it('top-level alphabetical grouping lists commands in groups', async () => {
    const r1 = Cli('user add').describe('add user').handle(() => {});
    const r2 = Cli('user rm').describe('remove user').handle(() => {});
    const r3 = Cli('db migrate').describe('migrate').handle(() => {});
    const app = makeApp([makeController([r1, r2, r3])]);
    const io = createMockIO();
    await run(app, { argv: ['--help'], io, exitOnError: false, name: 'j' });
    const out = io.output.join('\n');
    assert.match(out, /^user:/m);
    assert.match(out, /^db:/m);
  });
});

describe('CLI runner — invoke()', () => {
  it('returns result passed to io.result()', async () => {
    const r = Cli('build').input(z.object({ src: z.string() })).handle((ctx) => {
      (ctx.io as CliIO<any>).result({ ok: true, src: ctx.args.src });
    });
    const app = makeApp([makeController([r])]);
    const out: any = await invoke(app, 'build', { src: 'x' });
    assert.deepEqual(out, { ok: true, src: 'x' });
  });

  it('rejects on unknown command', async () => {
    const app = makeApp([makeController([])]);
    await assert.rejects(() => invoke(app, 'nope'), /Unknown command/);
  });

  it('rejects on invalid args (schema)', async () => {
    const r = Cli('serve').input(z.object({ port: z.number().min(1024) })).handle(() => {});
    const app = makeApp([makeController([r])]);
    await assert.rejects(() => invoke(app, 'serve', { port: 10 }));
  });

  it('accepts validated/coerced args', async () => {
    let received: unknown;
    const r = Cli('serve').input(z.object({ port: z.number() })).handle((ctx) => {
      received = ctx.args.port;
    });
    const app = makeApp([makeController([r])]);
    await invoke(app, 'serve', { port: 3000 });
    assert.equal(received, 3000);
  });

  it('invocation with missing optional args uses defaults', async () => {
    let received: unknown;
    const r = Cli('foo').input(z.object({ x: z.string().default('y') })).handle((ctx) => {
      received = ctx.args.x;
    });
    const app = makeApp([makeController([r])]);
    await invoke(app, 'foo', {});
    assert.equal(received, 'y');
  });
});

describe('CLI runner — createClient()', () => {
  it('routes list contains full command names', () => {
    const r1 = Cli('alpha').handle(() => {});
    const r2 = Cli('beta').handle(() => {});
    const app = makeApp([makeController([r1, r2])]);
    const client = createClient(app);
    assert.deepEqual([...client.routes].sort(), ['alpha', 'beta']);
  });

  it('client.invoke proxies to invoke()', async () => {
    const r = Cli('echo').input(z.object({ msg: z.string() })).handle((ctx) => {
      (ctx.io as CliIO<any>).result(ctx.args.msg);
    });
    const app = makeApp([makeController([r])]);
    const client = createClient(app);
    const result = await client.invoke<string>('echo', { msg: 'hi' });
    assert.equal(result, 'hi');
  });
});
