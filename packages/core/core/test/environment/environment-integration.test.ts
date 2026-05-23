import { describe, test } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import JustScale, {
  defineService,
  defineSecretPartial,
  createSecretProvider,
  Secret,
  AbstractVaultClient,
  HardcodedVault,
  EnvVarVault,
  createEnvironment,
  type EnvContract,
} from '../../src/index.js';

describe('environment + vaults integration', () => {
  test('HardcodedVault + SecretProvider end-to-end via createEnvironment', async () => {
    const PgSecrets = defineSecretPartial('env.pg', z.object({
      connectionString: z.string(),
    }));

    const DevSecrets = createSecretProvider({
      provides: [PgSecrets],
      inject: { vault: AbstractVaultClient },
      factory: async ({ vault }) => ({
        [PgSecrets.key]: { connectionString: await vault.read('postgres/url') },
      }),
    });

    class DbClient extends defineService({
      inject: { sec: Secret.of(PgSecrets) },
      factory: ({ sec }) => ({ url: () => sec.connectionString }),
    }) {}

    type LocalEnv = EnvContract<{ secrets: [typeof PgSecrets] }>;
    const env = createEnvironment<LocalEnv>({
      name: 'dev-local',
      type: 'development',
      services: [HardcodedVault({
        'postgres/url': 'postgres://postgres:postgres@localhost:5432/dev',
      })],
      providers: [DevSecrets],
    });

    const app = JustScale().add(env).add(DbClient).build();
    await app.compile().ready;

    const client = await app.container.resolve(DbClient);
    assert.strictEqual(client.url(), 'postgres://postgres:postgres@localhost:5432/dev');
  });

  test('EnvVarVault reads from process.env', async () => {
    process.env.DEMO_SECRET_KEY = 'from-env';
    try {
      const DemoSecrets = defineSecretPartial('env.demo', z.object({ key: z.string() }));

      const Provider = createSecretProvider({
        provides: [DemoSecrets],
        inject: { vault: AbstractVaultClient },
        factory: async ({ vault }) => ({
          [DemoSecrets.key]: { key: await vault.read('demo-secret-key') },
        }),
      });

      const env = createEnvironment({
        name: 'prod',
        type: 'production',
        services: [EnvVarVault],
        providers: [Provider],
      });

      const app = JustScale().add(env).build();
      await app.compile().ready;

      const secrets = await app.container.resolve(AbstractVaultClient);
      assert.strictEqual(await secrets.read('demo-secret-key'), 'from-env');
    } finally {
      delete process.env.DEMO_SECRET_KEY;
    }
  });

  test('vault policy: HardcodedVault blocked in production (runtime)', () => {
    const env = createEnvironment({
      name: 'prod',
      type: 'production',
      services: [
        // @ts-expect-error — compile-time check also flags this, but we want to verify runtime fallback
        HardcodedVault({ 'foo': 'bar' }),
      ],
      providers: [],
    });

    assert.throws(
      () => JustScale().add(env).build(),
      (err: Error) => {
        assert.match(err.message, /disallows vault kind 'hardcoded'/);
        return true;
      },
    );
  });

  test('vault policy: HardcodedVault blocked in ci (runtime)', () => {
    const env = createEnvironment({
      name: 'ci',
      type: 'ci',
      services: [
        // @ts-expect-error — same compile-time protection as production
        HardcodedVault({ 'foo': 'bar' }),
      ],
      providers: [],
    });

    assert.throws(() => JustScale().add(env).build(), /hardcoded/);
  });

  test('vault policy: explicit extend (warn) fires boot-time warning', () => {
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (msg: string) => warnings.push(msg);

    try {
      const env = createEnvironment({
        name: 'integration',
        type: 'test',
        vaultPolicy: { extend: { warn: ['hardcoded'] } },
        services: [HardcodedVault({ 'foo': 'bar' })],
        providers: [],
      });

      // Does not throw
      const app = JustScale().add(env).build();
      assert.ok(app);
      // Warning was logged
      assert.ok(warnings.some((w) => w.includes("'hardcoded'")));
    } finally {
      console.warn = originalWarn;
    }
  });

  test('public values are stored on environment and accessible at runtime', () => {
    const env = createEnvironment({
      name: 'prod',
      type: 'production',
      public: { siteUrl: 'https://example.com', logLevel: 'warn' },
    });

    assert.strictEqual(env.public.siteUrl, 'https://example.com');
    assert.strictEqual(env.public.logLevel, 'warn');
  });

  test('compile-time vault policy: HardcodedVault in production rejected by TS', () => {
    createEnvironment({
      name: 'prod',
      type: 'production',
      services: [
        // @ts-expect-error — HardcodedVault branded as VaultAllowedIn<'development'|'test'>; 'production' rejects at type level
        HardcodedVault({ 'foo': 'bar' }),
      ],
    });
  });

  test('compile-time vault policy: HardcodedVault in test is accepted by TS', () => {
    // No @ts-expect-error — development/test environments accept it.
    const env = createEnvironment({
      name: 'local',
      type: 'development',
      services: [HardcodedVault({ 'foo': 'bar' })],
    });
    assert.ok(env);
  });

  test('vault policy: test environment allows HardcodedVault by default', () => {
    const env = createEnvironment({
      name: 'unit-test',
      type: 'test',
      services: [HardcodedVault({ 'foo': 'bar' })],
      providers: [],
    });

    // Does not throw
    const app = JustScale().add(env).build();
    assert.ok(app);
  });

  test('cannot register two environments', () => {
    const a = createEnvironment({ name: 'a', type: 'development' });
    const b = createEnvironment({ name: 'b', type: 'development' });

    assert.throws(
      () => JustScale().add(a).add(b).build(),
      /Only one environment may be registered/,
    );
  });
});
