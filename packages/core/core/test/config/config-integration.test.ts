import { describe, test } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import JustScale, { defineService } from '../../src/index.js';
import {
  defineConfigPartial,
  createConfig,
  Config,
} from '../../src/features/config/index.js';

describe('config integration — partial → createConfig → .add() → Config.of()', () => {
  test('synchronous factory: inject resolves to partial value', async () => {
    const AppConfig = defineConfigPartial('app.integration.sync', z.object({
      siteUrl: z.string(),
      logLevel: z.enum(['info', 'warn', 'error']),
    }));

    const AppConfigProvider = createConfig({
      provides: [AppConfig],
      factory: () => ({
        [AppConfig.key]: {
          siteUrl: 'https://example.com',
          logLevel: 'warn' as const,
        },
      }),
    });

    class AppService extends defineService({
      inject: { cfg: Config.of(AppConfig) },
      factory: ({ cfg }) => ({
        getUrl: () => cfg.siteUrl,
        getLevel: () => cfg.logLevel,
      }),
    }) {}

    const app = JustScale()
      .add(AppConfigProvider)
      .add(AppService)
      .build();

    await app.compile().ready;

    const svc = await app.container.resolve(AppService);
    assert.strictEqual(svc.getUrl(), 'https://example.com');
    assert.strictEqual(svc.getLevel(), 'warn');
  });

  test('async factory: waits for factory to complete before service resolves', async () => {
    const DbConfig = defineConfigPartial('db.integration.async', z.object({
      poolSize: z.number(),
    }));

    const DbConfigProvider = createConfig({
      provides: [DbConfig],
      factory: async () => {
        // Simulate async load (vault read, file read, etc.)
        await new Promise((r) => setTimeout(r, 10));
        return {
          [DbConfig.key]: { poolSize: 20 },
        };
      },
    });

    class DbService extends defineService({
      inject: { cfg: Config.of(DbConfig) },
      factory: ({ cfg }) => ({ size: cfg.poolSize }),
    }) {}

    const app = JustScale()
      .add(DbConfigProvider)
      .add(DbService)
      .build();

    await app.compile().ready;

    const svc = await app.container.resolve(DbService);
    assert.strictEqual(svc.size, 20);
  });

  test('validation: factory output is validated against zod schema when provides is set', async () => {
    const StrictConfig = defineConfigPartial('strict.integration', z.object({
      port: z.number().int().positive(),
    }));

    const BadProvider = createConfig({
      provides: [StrictConfig],
      factory: () => ({
        [StrictConfig.key]: { port: -1 }, // invalid per schema
      }),
    });

    await assert.rejects(
      async () => {
        const app = JustScale().add(BadProvider).build();
        await app.compile().ready;
      },
      (err: Error) => {
        assert.match(err.message, /port/i);
        return true;
      },
    );
  });

  test('multiple partials from one factory', async () => {
    const A = defineConfigPartial('multi.a', z.object({ value: z.string() }));
    const B = defineConfigPartial('multi.b', z.object({ count: z.number() }));

    const Provider = createConfig({
      provides: [A, B],
      factory: () => ({
        [A.key]: { value: 'hello' },
        [B.key]: { count: 42 },
      }),
    });

    class Consumer extends defineService({
      inject: { a: Config.of(A), b: Config.of(B) },
      factory: ({ a, b }) => ({ combined: `${a.value}:${b.count}` }),
    }) {}

    const app = JustScale().add(Provider).add(Consumer).build();
    await app.compile().ready;

    const svc = await app.container.resolve(Consumer);
    assert.strictEqual(svc.combined, 'hello:42');
  });

  test('factory with inject: depends on another service', async () => {
    class Logger extends defineService({
      inject: {},
      factory: () => ({ msgs: [] as string[], log: function (m: string) { this.msgs.push(m); } }),
    }) {}

    const LoggedConfig = defineConfigPartial('logged.integration', z.object({
      loaded: z.boolean(),
    }));

    const Provider = createConfig({
      provides: [LoggedConfig],
      inject: { logger: Logger },
      factory: ({ logger }) => {
        logger.log('config loaded');
        return { [LoggedConfig.key]: { loaded: true } };
      },
    });

    class Consumer extends defineService({
      inject: { cfg: Config.of(LoggedConfig), logger: Logger },
      factory: ({ cfg, logger }) => ({
        isLoaded: () => cfg.loaded,
        logs: () => logger.msgs.slice(),
      }),
    }) {}

    const app = JustScale().add(Logger).add(Provider).add(Consumer).build();
    await app.compile().ready;

    const svc = await app.container.resolve(Consumer);
    assert.strictEqual(svc.isLoaded(), true);
    assert.deepStrictEqual(svc.logs(), ['config loaded']);
  });
});
