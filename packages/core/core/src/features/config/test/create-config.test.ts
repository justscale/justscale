import { describe, it } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import JustScale, { defineService } from '../../../index.js';
import { createConfig, defineConfigPartial, Config, isConfigComponent } from '../index.js';

describe('createConfig', () => {
  it('returns an object branded as a ConfigComponent', () => {
    const p = defineConfigPartial('cc-brand', z.object({ v: z.string() }));
    const c = createConfig({
      provides: [p],
      factory: () => ({ [p.key]: { v: 'ok' } }),
    });
    assert.strictEqual(isConfigComponent(c), true);
    assert.strictEqual(c.__configComponent, true);
  });

  it('defaults provides and inject to empty when omitted', () => {
    const c = createConfig({ factory: () => ({}) });
    assert.deepStrictEqual(c.provides, []);
    assert.deepStrictEqual(c.inject, {});
  });

  it('end-to-end: partial → provider → service reads via Config.of', async () => {
    const AppConfig = defineConfigPartial('app.e2e', z.object({
      port: z.number().int(),
      host: z.string(),
    }));

    const Values = createConfig({
      provides: [AppConfig],
      factory: () => ({ [AppConfig.key]: { port: 8080, host: 'localhost' } }),
    });

    class PortReader extends defineService({
      inject: { cfg: Config.of(AppConfig) },
      factory: ({ cfg }) => ({ describe: () => `${cfg.host}:${cfg.port}` }),
    }) {}

    const app = JustScale().add(Values).add(PortReader).build();
    await app.compile().ready;

    const reader = await app.container.resolve(PortReader);
    assert.strictEqual(reader.describe(), 'localhost:8080');
  });

  it('zod validates factory output; invalid types reject at boot', async () => {
    const StrictCfg = defineConfigPartial('strict.cfg', z.object({
      maxRetries: z.number().int().min(0),
    }));

    const BadValues = createConfig({
      provides: [StrictCfg],
      factory: () => ({ [StrictCfg.key]: { maxRetries: -1 } }),
    });

    await assert.rejects(async () => {
      const app = JustScale().add(BadValues).build();
      await app.compile().ready;
    });
  });

  it('factory with no provides registers values as-is (no schema validation)', async () => {
    // Legacy codepath: without `provides`, builder registers whatever the
    // factory returned under whatever symbol(s) it used. No zod runs.
    const rogueKey = Symbol.for('config:rogue');
    const Rogue = createConfig({
      factory: () => ({ [rogueKey]: { anything: 'goes' } }),
    });

    class Rdr extends defineService({
      inject: {},
      factory: (_deps, resolver) => ({
        readRogue: async () => {
          // raw-symbol resolve — same pattern ConfigService uses internally
          return await (resolver as unknown as <T>(k: symbol) => Promise<T>)(rogueKey);
        },
      }),
    }) {}

    const app = JustScale().add(Rogue).add(Rdr).build();
    await app.compile().ready;
    const r = await app.container.resolve(Rdr);
    assert.deepStrictEqual(await r.readRogue(), { anything: 'goes' });
  });

  it('async factory resolves before services read', async () => {
    const P = defineConfigPartial('async.factory', z.object({ v: z.string() }));
    const slow = createConfig({
      provides: [P],
      factory: async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { [P.key]: { v: 'loaded' } };
      },
    });

    class R extends defineService({
      inject: { cfg: Config.of(P) },
      factory: ({ cfg }) => ({ get: () => cfg.v }),
    }) {}

    const app = JustScale().add(slow).add(R).build();
    await app.compile().ready;
    assert.strictEqual((await app.container.resolve(R)).get(), 'loaded');
  });

  it('two partials provided by one config component both resolve', async () => {
    const A = defineConfigPartial('multi.a', z.object({ a: z.string() }));
    const B = defineConfigPartial('multi.b', z.object({ b: z.number() }));

    const Both = createConfig({
      provides: [A, B],
      factory: () => ({
        [A.key]: { a: 'alpha' },
        [B.key]: { b: 42 },
      }),
    });

    class Rdr extends defineService({
      inject: { a: Config.of(A), b: Config.of(B) },
      factory: ({ a, b }) => ({ describe: () => `${a.a}-${b.b}` }),
    }) {}

    const app = JustScale().add(Both).add(Rdr).build();
    await app.compile().ready;
    assert.strictEqual((await app.container.resolve(Rdr)).describe(), 'alpha-42');
  });

  it('zod defaults fill in unset fields at validation time', async () => {
    const P = defineConfigPartial('defaults.cfg', z.object({
      host: z.string().default('127.0.0.1'),
      port: z.number().default(3000),
    }));

    const C = createConfig({
      provides: [P],
      // Partial input; zod defaults fill the rest
      factory: () => ({ [P.key]: { port: 9000 } }),
    });

    class Rdr extends defineService({
      inject: { cfg: Config.of(P) },
      factory: ({ cfg }) => ({ get: () => cfg }),
    }) {}

    const app = JustScale().add(C).add(Rdr).build();
    await app.compile().ready;
    const got = (await app.container.resolve(Rdr)).get();
    assert.deepStrictEqual(got, { host: '127.0.0.1', port: 9000 });
  });

  it('last provider wins when two components provide the same partial', async () => {
    const P = defineConfigPartial('override.cfg', z.object({ v: z.string() }));
    const first = createConfig({
      provides: [P],
      factory: () => ({ [P.key]: { v: 'first' } }),
    });
    const second = createConfig({
      provides: [P],
      factory: () => ({ [P.key]: { v: 'second' } }),
    });
    class Rdr extends defineService({
      inject: { cfg: Config.of(P) },
      factory: ({ cfg }) => ({ get: () => cfg.v }),
    }) {}

    const app = JustScale().add(first).add(second).add(Rdr).build();
    await app.compile().ready;
    assert.strictEqual((await app.container.resolve(Rdr)).get(), 'second');
  });

  it('isConfigComponent: narrows on arbitrary values', () => {
    assert.strictEqual(isConfigComponent(null), false);
    assert.strictEqual(isConfigComponent({}), false);
    assert.strictEqual(isConfigComponent({ __configComponent: true, provides: [], inject: {}, factory: () => ({}) }), true);
  });
});
