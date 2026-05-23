/**
 * Tests for typed CLI arguments: arg(), cliArgs(),
 * extractCliMeta, getPositionalArgs, getFlagArgs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  arg,
  cliArgs,
  extractCliMeta,
  getCliMeta,
  hasCliMeta,
  getPositionalArgs,
  getFlagArgs,
} from '../args.js';

describe('arg() + cliArgs()', () => {
  it('arg() attaches CLI metadata via .meta()', () => {
    const a = arg(z.string(), { prompt: 'Name', flags: ['-n'] });
    const m = getCliMeta(a);
    assert.ok(m);
    assert.equal(m!.prompt, 'Name');
    assert.deepEqual(m!.flags, ['-n']);
  });

  it('hasCliMeta reflects presence of metadata', () => {
    assert.equal(hasCliMeta(arg(z.string(), { prompt: 'x' })), true);
    assert.equal(hasCliMeta(z.string()), false);
  });

  it('cliArgs produces a ZodObject with shape preserved', () => {
    const schema = cliArgs({
      email: arg(z.string(), { prompt: 'Email', flags: ['-e', '--email'] }),
      verbose: arg(z.boolean().default(false), { prompt: 'Verbose', flags: ['-v'] }),
    });
    const parsed = schema.parse({ email: 'a@b.c', verbose: true });
    assert.deepEqual(parsed, { email: 'a@b.c', verbose: true });
  });

  it('extractCliMeta returns a Map of fieldName -> meta', () => {
    const schema = cliArgs({
      email: arg(z.string(), { prompt: 'Email' }),
      name: arg(z.string(), { prompt: 'Name', position: 0 }),
    });
    const metaMap = extractCliMeta(schema);
    assert.equal(metaMap.size, 2);
    assert.equal(metaMap.get('email')?.prompt, 'Email');
    assert.equal(metaMap.get('name')?.position, 0);
  });

  it('getPositionalArgs returns only fields with position, sorted', () => {
    const schema = cliArgs({
      team: arg(z.string(), { prompt: 'Team', position: 1 }),
      name: arg(z.string(), { prompt: 'Name', position: 0 }),
      admin: arg(z.boolean().default(false), { prompt: 'Admin' }),
    });
    const pos = getPositionalArgs(schema);
    assert.deepEqual(
      pos.map(([n]) => n),
      ['name', 'team'],
    );
  });

  it('getFlagArgs returns only fields without position', () => {
    const schema = cliArgs({
      email: arg(z.string(), { prompt: 'Email' }),
      name: arg(z.string(), { prompt: 'Name', position: 0 }),
    });
    const flags = getFlagArgs(schema);
    assert.equal(flags.length, 1);
    assert.equal(flags[0]![0], 'email');
  });

  it('plain object schema returns empty meta map', () => {
    const schema = z.object({ x: z.string(), y: z.number() });
    assert.equal(extractCliMeta(schema).size, 0);
  });
});
