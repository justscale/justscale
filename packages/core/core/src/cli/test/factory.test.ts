/**
 * Tests for the CLI route builder (what Cli(name) returns) via the
 * builder module. Importing ../factory.js directly triggers a circular
 * import TDZ through ../index.js → features/config/cli → cli/index.ts
 * (which calls registerRouteFactory('Cli', Cli) while Cli is still
 * uninitialised). The builder module avoids that cycle.
 *
 * The factory's overload forms (Cli(name, schema), Cli(name, schema,
 * handler)) are only reachable through cli/factory.ts and are covered
 * separately in the integration suite under test/cli/.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  Cli,
  INPUT_SCHEMA,
  getInputSchema,
} from '../builder/create-cli-builder.js';

describe('Cli builder', () => {
  it('Cli("name") returns a builder exposing use/guard/input/handle', () => {
    const b = Cli('status');
    assert.equal(typeof (b as any).handle, 'function');
    assert.equal(typeof (b as any).input, 'function');
    assert.equal(typeof (b as any).use, 'function');
    assert.equal(typeof (b as any).guard, 'function');
    assert.equal(typeof (b as any).describe, 'function');
  });

  it('.input(schema).handle(fn) produces a CLI RouteDef', () => {
    const schema = z.object({ src: z.string() });
    const route = Cli('build').input(schema).handle(() => {}) as any;
    assert.equal(route.method, 'CLI');
    assert.equal(route.path, 'build');
    assert.equal(route.inputSchema, schema);
    assert.equal(getInputSchema(route), schema);
    assert.equal((route as any)[INPUT_SCHEMA], schema);
  });

  it('.describe(text) attaches one-line description', () => {
    const route = Cli('deploy').describe('Ship it').handle(() => {}) as any;
    assert.equal(route.description, 'Ship it');
  });

  it('.returns(status) adds a response schema entry (status key)', () => {
    const route = Cli('foo').returns(0).handle(() => {}) as any;
    assert.ok(route.responseSchemas instanceof Map);
    assert.ok(route.responseSchemas.has(0));
  });

  it('.returns(status, schema) stores the schema', () => {
    const schema = z.object({ ok: z.boolean() });
    const route = Cli('foo').returns(0, schema).handle(() => {}) as any;
    assert.equal(route.responseSchemas.get(0), schema);
  });

  it('.use adds a middleware step and preserves order with .guard', () => {
    const route = Cli('foo')
      .use((_c) => ({ a: 1 }))
      .guard((_c) => {})
      .use((_c) => ({ b: 2 }))
      .handle(() => {}) as any;
    const kinds = (route.steps as any[]).map((s: any) => s.type);
    assert.deepEqual(kinds, ['use', 'guard', 'use']);
  });

  it('multi-segment command name is preserved literally in route.path', () => {
    const route = Cli('user add').handle(() => {}) as any;
    assert.equal(route.path, 'user add');
  });

  it('empty steps default to [] after handle', () => {
    const route = Cli('noop').handle(() => {}) as any;
    assert.ok(Array.isArray(route.steps));
    assert.equal(route.steps.length, 0);
  });

  it('method is CLI regardless of whether input/describe are set', () => {
    const minimal = Cli('x').handle(() => {}) as any;
    const full = Cli('y').input(z.object({})).describe('Y').handle(() => {}) as any;
    assert.equal(minimal.method, 'CLI');
    assert.equal(full.method, 'CLI');
  });

  it('handler reference is stored on the route def', () => {
    const handler = () => {};
    const route = Cli('h').handle(handler) as any;
    assert.equal(route.handler, handler);
  });

  it('same command name yields distinct route defs per call', () => {
    const a = Cli('same').handle(() => {}) as any;
    const b = Cli('same').handle(() => {}) as any;
    assert.notEqual(a, b);
    assert.notEqual(a.handler, b.handler);
  });
});
