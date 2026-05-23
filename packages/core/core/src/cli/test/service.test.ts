/**
 * Tests for CliService, LazyCliService, and createCliService.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Cli } from '../factory.js';
import { createMockIO } from '../io.js';
import { CliService, LazyCliService, createCliService } from '../service.js';
import type { App } from '../../index.js';

// Route defs produced directly by the builder don't have `segments`
// (that field is added when routes are compiled inside a controller).
// createCliService reads `route.segments.join(' ')`, so we simulate the
// compiled form here.
function compile(route: any) {
  const path = route.path as string;
  return { ...route, segments: path.split(' ') };
}

function makeApp(controllers: any[]): App {
  return {
    controllers: controllers.map((c) => ({
      ...c,
      deps: {},
      routes: c.routes.map(compile),
    })),
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

describe('LazyCliService', () => {
  it('throws when used before setImplementation', () => {
    const svc = new LazyCliService();
    assert.throws(() => svc.listCommands(), /not initialized/);
  });

  it('delegates to real impl after setImplementation', () => {
    const svc = new LazyCliService();
    svc.setImplementation({
      listCommands: () => ['a', 'b'],
      execute: async () => ({ ok: true }),
      help: () => 'HELP',
      helpFor: () => null,
    });
    assert.deepEqual(svc.listCommands(), ['a', 'b']);
    assert.equal(svc.help(), 'HELP');
  });

  it('CliService is a class (abstract at the TS type level only)', () => {
    // Abstract in TS is a compile-time check — at runtime `new CliService()`
    // succeeds. We document the current behaviour here rather than asserting
    // a runtime guard that doesn't exist.
    assert.equal(typeof CliService, 'function');
  });
});

describe('createCliService', () => {
  it('listCommands includes every CLI route', () => {
    const r1 = Cli('status').handle(() => {});
    const r2 = Cli('stop').handle(() => {});
    const app = makeApp([makeController([r1, r2])]);
    const svc = createCliService(app);
    const cmds = svc.listCommands();
    assert.ok(cmds.includes('status'));
    assert.ok(cmds.includes('stop'));
  });

  it('listCommands uses segments (space-joined)', () => {
    const r = Cli('auth login').handle(() => {});
    const app = makeApp([makeController([r])]);
    const svc = createCliService(app);
    // Note: Cli('auth login') stores segments as ['auth login'] (one entry).
    // The service joins with a space, so the command path is still 'auth login'.
    const cmds = svc.listCommands();
    assert.ok(cmds.some((c) => c.includes('auth') && c.includes('login')));
  });

  it('execute throws for unknown command', async () => {
    const app = makeApp([makeController([])]);
    const svc = createCliService(app);
    const io = createMockIO();
    await assert.rejects(() => svc.execute('missing', {}, io), /Unknown command/);
  });

  it('help returns a human-readable string', () => {
    const r = Cli('foo').describe('a foo').handle(() => {});
    const app = makeApp([makeController([r])]);
    const svc = createCliService(app);
    const help = svc.help();
    assert.ok(typeof help === 'string');
    assert.ok(help.includes('foo'));
  });

  it('helpFor unknown command returns null', () => {
    const app = makeApp([makeController([])]);
    const svc = createCliService(app);
    assert.equal(svc.helpFor('bogus'), null);
  });

  it('helpFor known command returns the usage string', () => {
    const r = Cli('foo').input(z.object({ x: z.string() })).handle(() => {});
    const app = makeApp([makeController([r])]);
    const svc = createCliService(app);
    const text = svc.helpFor('foo');
    assert.ok(typeof text === 'string');
    assert.match(text!, /Usage: foo/);
  });

  it('helpFor normalises whitespace', () => {
    const r = Cli('foo').handle(() => {});
    const app = makeApp([makeController([r])]);
    const svc = createCliService(app);
    assert.ok(svc.helpFor('  foo   ') !== null);
  });
});
