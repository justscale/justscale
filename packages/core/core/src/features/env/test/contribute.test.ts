import { describe, it } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import JustScale, { defineService } from '../../../index.js';
import {
  config,
  secret,
  flag,
  fromVault,
  buildProviders,
} from '../contribute.js';
import { defineConfigPartial, Config } from '../../config/index.js';
import { defineSecretPartial, Secret } from '../../secrets/index.js';
import { defineFeatureFlagPartial, FeatureFlag } from '../../feature-flags/index.js';
import { HardcodedVault } from '../../vault/hardcoded-vault.js';

describe('env contributions — buildProviders', () => {
  it('partitions config/secret/flag contributions into three provider components', () => {
    const C = defineConfigPartial('c.partition', z.object({ v: z.string().default('x') }));
    const S = defineSecretPartial('s.partition', z.object({ token: z.string() }));
    const F = defineFeatureFlagPartial('f.partition', z.object({ on: z.boolean().default(false) }));

    const [cfg, sec, fl] = buildProviders([
      config(C, { v: 'ok' }),
      secret(S, () => ({ token: 'abc' })),
      flag(F, { on: true }),
    ]);
    assert.strictEqual(cfg.__configComponent, true);
    assert.strictEqual(sec.__secretComponent, true);
    assert.strictEqual(fl.provides.length, 1);
  });

  it('static config source flows through to Config.of', async () => {
    const C = defineConfigPartial('env.static', z.object({ port: z.number() }));
    const [cfg, sec, fl] = buildProviders([config(C, { port: 4000 })]);
    class R extends defineService({
      inject: { c: Config.of(C) },
      factory: ({ c }) => ({ port: c.port }),
    }) {}
    const app = JustScale()
      .add(HardcodedVault({})) // vault is always injected into the config factory
      .add(cfg)
      .add(sec)
      .add(fl)
      .add(R)
      .build();
    await app.compile().ready;
    assert.strictEqual((await app.container.resolve(R)).port, 4000);
  });

  it('function config source receives the vault client as dep', async () => {
    const C = defineConfigPartial('env.fnsource', z.object({ x: z.string() }));
    const [cfg, sec, fl] = buildProviders([
      config(C, async ({ vault }) => ({ x: await vault.read('the/path') })),
    ]);
    class R extends defineService({
      inject: { c: Config.of(C) },
      factory: ({ c }) => ({ x: c.x }),
    }) {}
    const app = JustScale()
      .add(HardcodedVault({ 'the/path': 'vaulted-value' }))
      .add(cfg).add(sec).add(fl).add(R)
      .build();
    await app.compile().ready;
    assert.strictEqual((await app.container.resolve(R)).x, 'vaulted-value');
  });

  it('secret factory receives the vault client', async () => {
    const S = defineSecretPartial('env.secret-factory', z.object({ k: z.string() }));
    const [cfg, sec, fl] = buildProviders([
      secret(S, async ({ vault }) => ({ k: await vault.read('s/key') })),
    ]);
    class R extends defineService({
      inject: { s: Secret.of(S) },
      factory: ({ s }) => ({ k: s.k }),
    }) {}
    const app = JustScale()
      .add(HardcodedVault({ 's/key': 'secret-sauce' }))
      .add(cfg).add(sec).add(fl).add(R)
      .build();
    await app.compile().ready;
    assert.strictEqual((await app.container.resolve(R)).k, 'secret-sauce');
  });

  it('flag contribution exposes value via FeatureFlag.of', async () => {
    const F = defineFeatureFlagPartial('env.flag', z.object({ beta: z.boolean() }));
    const [cfg, sec, fl] = buildProviders([flag(F, { beta: true })]);
    class R extends defineService({
      inject: { f: FeatureFlag.of(F) },
      factory: ({ f }) => ({ beta: f.beta }),
    }) {}
    const app = JustScale()
      .add(HardcodedVault({}))
      .add(cfg).add(sec).add(fl).add(R)
      .build();
    await app.compile().ready;
    assert.strictEqual((await app.container.resolve(R)).beta, true);
  });

  it('empty contribution list produces three no-op provider components', async () => {
    const [cfg, sec, fl] = buildProviders([]);
    assert.deepStrictEqual(cfg.provides, []);
    assert.deepStrictEqual(sec.provides, []);
    assert.deepStrictEqual(fl.provides, []);
  });

  it('config without any values still honors zod defaults', async () => {
    const C = defineConfigPartial('env.defaults', z.object({
      timeout: z.number().default(1000),
    }));
    const [cfg, sec, fl] = buildProviders([config(C)]);
    class R extends defineService({
      inject: { c: Config.of(C) },
      factory: ({ c }) => ({ t: c.timeout }),
    }) {}
    const app = JustScale()
      .add(HardcodedVault({}))
      .add(cfg).add(sec).add(fl).add(R)
      .build();
    await app.compile().ready;
    assert.strictEqual((await app.container.resolve(R)).t, 1000);
  });
});

// ---------------------------------------------------------------------------
// fromVault() — schema-aware coercion
// ---------------------------------------------------------------------------
describe('fromVault() coercion', () => {
  it('coerces numeric strings to numbers', async () => {
    const C = defineConfigPartial('fv.num', z.object({ port: z.number() }));
    const [cfg, sec, fl] = buildProviders([
      config(C, fromVault(C, { port: 'x/port' })),
    ]);
    class R extends defineService({
      inject: { c: Config.of(C) },
      factory: ({ c }) => ({ port: c.port }),
    }) {}
    const app = JustScale()
      .add(HardcodedVault({ 'x/port': '1234' }))
      .add(cfg).add(sec).add(fl).add(R)
      .build();
    await app.compile().ready;
    assert.strictEqual((await app.container.resolve(R)).port, 1234);
  });

  it('throws with a helpful message on non-numeric string for a number field', async () => {
    const C = defineConfigPartial('fv.num.bad', z.object({ port: z.number() }));
    const [cfg, sec, fl] = buildProviders([
      config(C, fromVault(C, { port: 'x/port' })),
    ]);
    const app = JustScale()
      .add(HardcodedVault({ 'x/port': 'not-a-number' }))
      .add(cfg).add(sec).add(fl).build();
    await assert.rejects(
      () => app.compile().ready,
      (err: Error) => /fromVault: failed to parse 'fv.num.bad.port'.*not a valid number/.test(err.message),
    );
  });

  it('coerces boolean strings', async () => {
    const C = defineConfigPartial('fv.bool', z.object({
      on: z.boolean(),
      off: z.boolean(),
      one: z.boolean(),
      zero: z.boolean(),
    }));
    const [cfg, sec, fl] = buildProviders([
      config(C, fromVault(C, { on: 'b/on', off: 'b/off', one: 'b/one', zero: 'b/zero' })),
    ]);
    class R extends defineService({
      inject: { c: Config.of(C) },
      factory: ({ c }) => ({ c }),
    }) {}
    const app = JustScale()
      .add(HardcodedVault({ 'b/on': 'true', 'b/off': 'false', 'b/one': '1', 'b/zero': '0' }))
      .add(cfg).add(sec).add(fl).add(R).build();
    await app.compile().ready;
    const c = (await app.container.resolve(R)).c;
    assert.deepStrictEqual(c, { on: true, off: false, one: true, zero: false });
  });

  it('throws on a non-boolean string for a boolean field', async () => {
    const C = defineConfigPartial('fv.bool.bad', z.object({ on: z.boolean() }));
    const [cfg, sec, fl] = buildProviders([
      config(C, fromVault(C, { on: 'b/on' })),
    ]);
    const app = JustScale()
      .add(HardcodedVault({ 'b/on': 'maybe' }))
      .add(cfg).add(sec).add(fl).build();
    await assert.rejects(
      () => app.compile().ready,
      (err: Error) => /not a valid boolean/.test(err.message),
    );
  });

  it('coerces bigint strings', async () => {
    const C = defineConfigPartial('fv.bigint', z.object({ n: z.bigint() }));
    const [cfg, sec, fl] = buildProviders([
      config(C, fromVault(C, { n: 'big/n' })),
    ]);
    class R extends defineService({
      inject: { c: Config.of(C) },
      factory: ({ c }) => ({ n: c.n }),
    }) {}
    const app = JustScale()
      .add(HardcodedVault({ 'big/n': '9007199254740993' }))
      .add(cfg).add(sec).add(fl).add(R).build();
    await app.compile().ready;
    assert.strictEqual((await app.container.resolve(R)).n, 9007199254740993n);
  });

  it('coerces date strings', async () => {
    const C = defineConfigPartial('fv.date', z.object({ d: z.date() }));
    const [cfg, sec, fl] = buildProviders([
      config(C, fromVault(C, { d: 'when' })),
    ]);
    class R extends defineService({
      inject: { c: Config.of(C) },
      factory: ({ c }) => ({ d: c.d }),
    }) {}
    const app = JustScale()
      .add(HardcodedVault({ 'when': '2024-01-15T00:00:00Z' }))
      .add(cfg).add(sec).add(fl).add(R).build();
    await app.compile().ready;
    const d = (await app.container.resolve(R)).d;
    assert.strictEqual(d.getUTCFullYear(), 2024);
  });

  it('parses JSON for array fields', async () => {
    const C = defineConfigPartial('fv.arr', z.object({ tags: z.array(z.string()) }));
    const [cfg, sec, fl] = buildProviders([
      config(C, fromVault(C, { tags: 'tags/list' })),
    ]);
    class R extends defineService({
      inject: { c: Config.of(C) },
      factory: ({ c }) => ({ c }),
    }) {}
    const app = JustScale()
      .add(HardcodedVault({ 'tags/list': '["a","b","c"]' }))
      .add(cfg).add(sec).add(fl).add(R).build();
    await app.compile().ready;
    assert.deepStrictEqual((await app.container.resolve(R)).c.tags, ['a', 'b', 'c']);
  });

  it('parses JSON for object fields', async () => {
    const C = defineConfigPartial('fv.obj', z.object({
      meta: z.object({ n: z.number(), s: z.string() }),
    }));
    const [cfg, sec, fl] = buildProviders([
      config(C, fromVault(C, { meta: 'meta/blob' })),
    ]);
    class R extends defineService({
      inject: { c: Config.of(C) },
      factory: ({ c }) => ({ c }),
    }) {}
    const app = JustScale()
      .add(HardcodedVault({ 'meta/blob': '{"n":1,"s":"a"}' }))
      .add(cfg).add(sec).add(fl).add(R).build();
    await app.compile().ready;
    assert.deepStrictEqual((await app.container.resolve(R)).c.meta, { n: 1, s: 'a' });
  });

  it('string field passes through untouched', async () => {
    const C = defineConfigPartial('fv.str', z.object({ msg: z.string() }));
    const [cfg, sec, fl] = buildProviders([config(C, fromVault(C, { msg: 'm' }))]);
    class R extends defineService({
      inject: { c: Config.of(C) },
      factory: ({ c }) => ({ c }),
    }) {}
    const app = JustScale()
      .add(HardcodedVault({ 'm': 'hello world' }))
      .add(cfg).add(sec).add(fl).add(R).build();
    await app.compile().ready;
    assert.strictEqual((await app.container.resolve(R)).c.msg, 'hello world');
  });

  it('enum field passes through untouched', async () => {
    const C = defineConfigPartial('fv.enum', z.object({
      level: z.enum(['debug', 'info', 'error']),
    }));
    const [cfg, sec, fl] = buildProviders([config(C, fromVault(C, { level: 'log/level' }))]);
    class R extends defineService({
      inject: { c: Config.of(C) },
      factory: ({ c }) => ({ c }),
    }) {}
    const app = JustScale()
      .add(HardcodedVault({ 'log/level': 'info' }))
      .add(cfg).add(sec).add(fl).add(R).build();
    await app.compile().ready;
    assert.strictEqual((await app.container.resolve(R)).c.level, 'info');
  });

  it('missing optional path silently drops (zod default wins)', async () => {
    const C = defineConfigPartial('fv.optional.default', z.object({
      x: z.string().default('fallback'),
    }));
    const [cfg, sec, fl] = buildProviders([config(C, fromVault(C, { x: 'x/absent' }))]);
    class R extends defineService({
      inject: { c: Config.of(C) },
      factory: ({ c }) => ({ c }),
    }) {}
    const app = JustScale()
      .add(HardcodedVault({}))
      .add(cfg).add(sec).add(fl).add(R).build();
    await app.compile().ready;
    assert.strictEqual((await app.container.resolve(R)).c.x, 'fallback');
  });

  it('missing required path throws at boot', async () => {
    const C = defineConfigPartial('fv.required', z.object({ x: z.string() }));
    const [cfg, sec, fl] = buildProviders([config(C, fromVault(C, { x: 'x/absent' }))]);
    const app = JustScale()
      .add(HardcodedVault({}))
      .add(cfg).add(sec).add(fl).build();
    await assert.rejects(() => app.compile().ready);
  });

  it('optional field: wrapped in z.optional() silently drops', async () => {
    const C = defineConfigPartial('fv.optional', z.object({
      maybe: z.string().optional(),
      present: z.string(),
    }));
    const [cfg, sec, fl] = buildProviders([
      config(C, fromVault(C, { maybe: 'missing', present: 'here' })),
    ]);
    class R extends defineService({
      inject: { c: Config.of(C) },
      factory: ({ c }) => ({ c }),
    }) {}
    const app = JustScale()
      .add(HardcodedVault({ 'here': 'yes' }))
      .add(cfg).add(sec).add(fl).add(R).build();
    await app.compile().ready;
    const c = (await app.container.resolve(R)).c;
    assert.strictEqual(c.maybe, undefined);
    assert.strictEqual(c.present, 'yes');
  });

  it('nullable field: missing vault value injects null so zod accepts it', async () => {
    // Users intuit .nullable() as "absence is fine". The null-vs-undefined
    // boundary is an implementation detail; fromVault collapses absent
    // nullable keys to `null` so the partial validates cleanly.
    const C = defineConfigPartial('fv.nullable', z.object({
      n: z.string().nullable(),
    }));
    const [cfg, sec, fl] = buildProviders([config(C, fromVault(C, { n: 'absent' }))]);
    class R extends defineService({
      inject: { c: Config.of(C) },
      factory: ({ c }) => ({ c }),
    }) {}
    const app = JustScale()
      .add(HardcodedVault({}))
      .add(cfg).add(sec).add(fl).add(R).build();
    await app.compile().ready;
    const c = (await app.container.resolve(R)).c;
    assert.strictEqual(c.n, null);
  });

  it('nullable+optional field: missing stays undefined (optional wins)', async () => {
    // When a user explicitly opts into both, .optional() gets the first
    // shot — the field is simply omitted, not forced to null. Matches how
    // a missing .optional() already works.
    const C = defineConfigPartial('fv.nullable.optional', z.object({
      n: z.string().nullable().optional(),
    }));
    const [cfg, sec, fl] = buildProviders([config(C, fromVault(C, { n: 'absent' }))]);
    class R extends defineService({
      inject: { c: Config.of(C) },
      factory: ({ c }) => ({ c }),
    }) {}
    const app = JustScale()
      .add(HardcodedVault({}))
      .add(cfg).add(sec).add(fl).add(R).build();
    await app.compile().ready;
    const c = (await app.container.resolve(R)).c;
    assert.strictEqual(c.n, undefined);
  });

  it('throws when a mapped field is not in the schema', async () => {
    const C = defineConfigPartial('fv.unknown', z.object({ x: z.string() }));
    const [cfg, sec, fl] = buildProviders([
      config(C, fromVault(C, { x: 'x', bogus: 'b' } as unknown as Partial<Record<'x', string>>)),
    ]);
    const app = JustScale()
      .add(HardcodedVault({ 'x': 'hi', 'b': 'bye' }))
      .add(cfg).add(sec).add(fl).build();
    await assert.rejects(
      () => app.compile().ready,
      (err: Error) => /field 'bogus' is not in the 'fv.unknown' schema/.test(err.message),
    );
  });

  it('mapping entries with undefined paths are skipped', async () => {
    const C = defineConfigPartial('fv.skip', z.object({
      x: z.string().default('d'),
      y: z.string().default('e'),
    }));
    const [cfg, sec, fl] = buildProviders([
      config(C, fromVault(C, { x: undefined, y: 'the/y' })),
    ]);
    class R extends defineService({
      inject: { c: Config.of(C) },
      factory: ({ c }) => ({ c }),
    }) {}
    const app = JustScale()
      .add(HardcodedVault({ 'the/y': 'yValue' }))
      .add(cfg).add(sec).add(fl).add(R).build();
    await app.compile().ready;
    const c = (await app.container.resolve(R)).c;
    assert.deepStrictEqual(c, { x: 'd', y: 'yValue' });
  });

  it('throws when called with a non-object schema', async () => {
    // fromVault requires a ZodObject at the partial level.
    const bad = defineConfigPartial('bad', z.string() as unknown as z.ZodObject<z.ZodRawShape>);
    const fn = fromVault(bad, {});
    await assert.rejects(
      () => fn({ vault: { read: async () => '', readOptional: async () => undefined } }),
      (err: Error) => /must be a ZodObject/.test(err.message),
    );
  });
});
