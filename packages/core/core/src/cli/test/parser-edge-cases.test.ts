/**
 * Edge-case tests for the CLI argument parser.
 *
 * Covers: positional vs flag detection, boolean flags (incl. --no-x),
 * = form, short flags, combined short flags, arrays, kebab-case, defaults,
 * numeric coercion, unknown flag handling, the -- separator, completions,
 * and help text generation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  extractArgDefs,
  parseArgv,
  generateHelp,
  generateCompletions,
  matchCommand,
} from '../parser.js';
import { arg, cliArgs } from '../args.js';

describe('CLI parser — extractArgDefs', () => {
  it('undefined schema returns empty array', () => {
    assert.deepEqual(extractArgDefs(undefined), []);
  });

  it('non-object schema returns empty array', () => {
    assert.deepEqual(extractArgDefs(z.string()), []);
  });

  it('required field -> positional, defaulted -> flag', () => {
    const defs = extractArgDefs(
      z.object({
        src: z.string(),
        verbose: z.boolean().default(false),
      }),
    );
    const src = defs.find((d) => d.name === 'src')!;
    const verbose = defs.find((d) => d.name === 'verbose')!;
    assert.equal(src.type, 'positional');
    assert.equal(verbose.type, 'flag');
    assert.equal(verbose.hasDefault, true);
    assert.equal(verbose.defaultValue, false);
  });

  it('optional field -> flag (not required)', () => {
    const defs = extractArgDefs(z.object({ name: z.string().optional() }));
    assert.equal(defs[0]!.type, 'flag');
    assert.equal(defs[0]!.required, false);
  });

  it('nullable field -> flag', () => {
    const defs = extractArgDefs(z.object({ tag: z.string().nullable() }));
    assert.equal(defs[0]!.type, 'flag');
  });

  it('positional order follows declaration order by default', () => {
    const defs = extractArgDefs(
      z.object({ first: z.string(), second: z.string(), flag: z.boolean().default(false) }),
    );
    const positional = defs.filter((d) => d.type === 'positional').map((d) => d.name);
    assert.deepEqual(positional, ['first', 'second']);
  });

  it('explicit position metadata overrides declaration order', () => {
    const schema = cliArgs({
      team: arg(z.string(), { prompt: 'Team', position: 1 }),
      name: arg(z.string(), { prompt: 'Name', position: 0 }),
    });
    const defs = extractArgDefs(schema);
    const positional = defs.filter((d) => d.type === 'positional').map((d) => d.name);
    assert.deepEqual(positional, ['name', 'team']);
  });

  it('detects array type on flag', () => {
    const defs = extractArgDefs(z.object({ include: z.array(z.string()).optional() }));
    assert.equal(defs[0]!.isArray, true);
    assert.equal(defs[0]!.type, 'flag');
  });

  it('detects boolean flag', () => {
    const defs = extractArgDefs(z.object({ verbose: z.boolean().default(false) }));
    assert.equal(defs[0]!.isBoolean, true);
  });

  it('arg() with flags metadata stays a flag even without default', () => {
    const schema = cliArgs({
      email: arg(z.string().email(), { prompt: 'Email', flags: ['-e', '--email'] }),
    });
    const defs = extractArgDefs(schema);
    assert.equal(defs[0]!.type, 'flag');
    assert.deepEqual(defs[0]!.flags, ['-e', '--email']);
    assert.equal(defs[0]!.short, 'e');
  });
});

describe('CLI parser — parseArgv basic', () => {
  it('parses a single positional', () => {
    const defs = extractArgDefs(z.object({ src: z.string() }));
    const parsed = parseArgv(['./hello'], defs);
    assert.equal(parsed.args.src, './hello');
    assert.deepEqual(parsed.errors, []);
  });

  it('applies default when flag missing', () => {
    const defs = extractArgDefs(z.object({ verbose: z.boolean().default(false) }));
    const parsed = parseArgv([], defs);
    assert.equal(parsed.args.verbose, false);
  });

  it('--flag alone sets boolean true', () => {
    const defs = extractArgDefs(z.object({ verbose: z.boolean().default(false) }));
    const parsed = parseArgv(['--verbose'], defs);
    assert.equal(parsed.args.verbose, true);
  });

  it('--no-flag sets boolean false', () => {
    const defs = extractArgDefs(z.object({ verbose: z.boolean().default(true) }));
    const parsed = parseArgv(['--no-verbose'], defs);
    assert.equal(parsed.args.verbose, false);
  });

  it('--flag=value form works for strings', () => {
    const defs = extractArgDefs(z.object({ output: z.string().default('out') }));
    const parsed = parseArgv(['--output=./dist'], defs);
    assert.equal(parsed.args.output, './dist');
  });

  it('--flag value form works for strings', () => {
    const defs = extractArgDefs(z.object({ output: z.string().default('out') }));
    const parsed = parseArgv(['--output', './dist'], defs);
    assert.equal(parsed.args.output, './dist');
  });

  it('unknown long flag is reported as an error', () => {
    const defs = extractArgDefs(z.object({ src: z.string() }));
    const parsed = parseArgv(['--bogus'], defs);
    assert.ok(parsed.errors.some((e) => /Unknown flag/.test(e)));
  });

  it('flag without value reports error', () => {
    const defs = extractArgDefs(z.object({ output: z.string().default('o') }));
    const parsed = parseArgv(['--output'], defs);
    assert.ok(parsed.errors.some((e) => /requires a value/.test(e)));
  });
});

describe('CLI parser — short flags', () => {
  it('-v works from inferred short meta', () => {
    const schema = cliArgs({
      verbose: arg(z.boolean().default(false), { prompt: 'Verbose', flags: ['-v', '--verbose'] }),
    });
    const defs = extractArgDefs(schema);
    const parsed = parseArgv(['-v'], defs);
    assert.equal(parsed.args.verbose, true);
  });

  it('-o value form', () => {
    const schema = cliArgs({
      output: arg(z.string().default('.'), { prompt: 'Out', flags: ['-o', '--output'] }),
    });
    const defs = extractArgDefs(schema);
    const parsed = parseArgv(['-o', './dist'], defs);
    assert.equal(parsed.args.output, './dist');
  });

  it('-o=value form', () => {
    const schema = cliArgs({
      output: arg(z.string().default('.'), { prompt: 'Out', flags: ['-o', '--output'] }),
    });
    const defs = extractArgDefs(schema);
    const parsed = parseArgv(['-o=./dist'], defs);
    assert.equal(parsed.args.output, './dist');
  });

  it('combined short booleans like -abc set all', () => {
    const schema = cliArgs({
      a: arg(z.boolean().default(false), { prompt: 'A', flags: ['-a', '--a-flag'] }),
      b: arg(z.boolean().default(false), { prompt: 'B', flags: ['-b', '--b-flag'] }),
      c: arg(z.boolean().default(false), { prompt: 'C', flags: ['-c', '--c-flag'] }),
    });
    const defs = extractArgDefs(schema);
    const parsed = parseArgv(['-abc'], defs);
    assert.equal(parsed.args.a, true);
    assert.equal(parsed.args.b, true);
    assert.equal(parsed.args.c, true);
  });

  it('unknown short flag reported', () => {
    const defs = extractArgDefs(z.object({ src: z.string() }));
    const parsed = parseArgv(['-z'], defs);
    assert.ok(parsed.errors.some((e) => /Unknown short flag/.test(e)));
  });
});

describe('CLI parser — numeric coercion', () => {
  it('coerces number strings on flags', () => {
    const defs = extractArgDefs(z.object({ steps: z.number().default(1) }));
    const parsed = parseArgv(['--steps', '42'], defs);
    assert.equal(parsed.args.steps, 42);
  });

  it('positional args coerce using the schema — same as flags', () => {
    // Positionals go through the same setValue/coerceValue path as flags,
    // so `cmd 42` (positional number) yields 42 just like `cmd --n 42`.
    const defs = extractArgDefs(z.object({ n: z.number() }));
    const parsed = parseArgv(['7'], defs);
    assert.equal(parsed.args.n, 7);
  });

  it('positional with string schema stays a string', () => {
    const defs = extractArgDefs(z.object({ name: z.string() }));
    const parsed = parseArgv(['42'], defs);
    assert.equal(parsed.args.name, '42');
  });

  it('returns value string when non-numeric for number', () => {
    const defs = extractArgDefs(z.object({ steps: z.number().default(1) }));
    const parsed = parseArgv(['--steps', 'abc'], defs);
    // coerceValue returns original string for NaN
    assert.equal(parsed.args.steps, 'abc');
  });
});

describe('CLI parser — arrays', () => {
  it('collects repeat --include into array', () => {
    const defs = extractArgDefs(
      z.object({ include: z.array(z.string()).optional() }),
    );
    const parsed = parseArgv(['--include=a', '--include=b', '--include=c'], defs);
    assert.deepEqual(parsed.args.include, ['a', 'b', 'c']);
  });

  it('absent optional array becomes []', () => {
    const defs = extractArgDefs(z.object({ include: z.array(z.string()).optional() }));
    const parsed = parseArgv([], defs);
    assert.deepEqual(parsed.args.include, []);
  });
});

describe('CLI parser — -- separator & kebab-case', () => {
  it('treats everything after -- as positional', () => {
    const defs = extractArgDefs(
      z.object({ src: z.string(), verbose: z.boolean().default(false) }),
    );
    const parsed = parseArgv(['--', '--verbose'], defs);
    assert.equal(parsed.args.src, '--verbose');
  });

  it('kebab-cases camel field names for long flags', () => {
    const defs = extractArgDefs(
      z.object({ dryRun: z.boolean().default(false) }),
    );
    const parsed = parseArgv(['--dry-run'], defs);
    assert.equal(parsed.args.dryRun, true);
  });
});

describe('CLI parser — generateHelp', () => {
  it('includes positional + options + defaults', () => {
    const defs = extractArgDefs(
      z.object({
        src: z.string(),
        verbose: z.boolean().default(false),
      }),
    );
    const help = generateHelp('build', defs, 'Build from source.');
    assert.match(help, /Build from source\./);
    assert.match(help, /Usage: build/);
    assert.match(help, /<src>/);
    assert.match(help, /--verbose/);
    assert.match(help, /default: false/);
  });

  it('surfaces examples from zod .meta({examples})', () => {
    const defs = extractArgDefs(
      z.object({
        host: z.string().meta({ examples: ['localhost', '0.0.0.0'] }).default('localhost'),
      }),
    );
    const help = generateHelp('serve', defs);
    assert.match(help, /"localhost", "0\.0\.0\.0"/);
  });
});

describe('CLI parser — generateCompletions', () => {
  const routes = [
    { fullCommand: 'user add', argDefs: extractArgDefs(z.object({ email: z.string() })) },
    { fullCommand: 'user delete', argDefs: extractArgDefs(z.object({ email: z.string() })) },
    { fullCommand: 'db migrate', argDefs: extractArgDefs(z.object({ steps: z.number().default(1) })) },
  ];

  it('empty prefix suggests top-level command words', () => {
    const out = generateCompletions([''], 0, routes);
    assert.ok(out.includes('user'));
    assert.ok(out.includes('db'));
  });

  it('prefix "user" suggests next words', () => {
    const out = generateCompletions(['user', ''], 1, routes);
    assert.ok(out.includes('add'));
    assert.ok(out.includes('delete'));
  });

  it('full command match suggests its flags', () => {
    const out = generateCompletions(['db', 'migrate', ''], 2, routes);
    assert.ok(out.some((s) => s.startsWith('--steps')));
  });
});

describe('CLI parser — matchCommand', () => {
  it('prefers longest match', () => {
    const routes = new Map<string, unknown>([
      ['db', {}],
      ['db migrate', {}],
      ['db migrate up', {}],
    ]);
    const m = matchCommand(['db', 'migrate', 'up', '--force'], routes);
    assert.equal(m?.path, 'db migrate up');
    assert.deepEqual(m?.argv, ['--force']);
  });

  it('returns null on no match', () => {
    const routes = new Map<string, unknown>([['db', {}]]);
    assert.equal(matchCommand(['auth', 'login'], routes), null);
  });
});
