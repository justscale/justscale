import { describe, test } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import JustScale, {
  defineService,
  defineSecretPartial,
  createSecretProvider,
  Secret,
  SecretServiceDef,
} from '../../src/index.js';

describe('secrets integration — partial → provider → Secret.of', () => {
  test('synchronous provider: service injects Secret.of() and reads value', async () => {
    const PostgresSecrets = defineSecretPartial('pg.sync', z.object({
      connectionString: z.string(),
    }));

    const DevSecrets = createSecretProvider({
      provides: [PostgresSecrets],
      factory: () => ({
        [PostgresSecrets.key]: { connectionString: 'postgres://localhost:5432/dev' },
      }),
    });

    class DbClient extends defineService({
      inject: { sec: Secret.of(PostgresSecrets) },
      factory: ({ sec }) => ({ url: () => sec.connectionString }),
    }) {}

    const app = JustScale().add(DevSecrets).add(DbClient).build();
    await app.compile().ready;

    const client = await app.container.resolve(DbClient);
    assert.strictEqual(client.url(), 'postgres://localhost:5432/dev');
  });

  test('async provider with injected vault client', async () => {
    class VaultClient extends defineService({
      inject: {},
      factory: () => ({
        read: async (path: string): Promise<string> => {
          const store: Record<string, string> = {
            'postgres/url': 'postgres://vault-host/prod',
            'jwt/key': 'super-secret-jwt-key',
          };
          await new Promise((r) => setTimeout(r, 5));
          return store[path]!;
        },
      }),
    }) {}

    const PostgresSecrets = defineSecretPartial('pg.async', z.object({
      connectionString: z.string(),
    }));
    const JwtSecrets = defineSecretPartial('jwt.async', z.object({
      signingKey: z.string(),
    }));

    const ProdSecrets = createSecretProvider({
      provides: [PostgresSecrets, JwtSecrets],
      inject: { vault: VaultClient },
      factory: async ({ vault }) => ({
        [PostgresSecrets.key]: { connectionString: await vault.read('postgres/url') },
        [JwtSecrets.key]: { signingKey: await vault.read('jwt/key') },
      }),
    });

    class AuthService extends defineService({
      inject: {
        pg: Secret.of(PostgresSecrets),
        jwt: Secret.of(JwtSecrets),
      },
      factory: ({ pg, jwt }) => ({
        describe: () => `${pg.connectionString}|${jwt.signingKey}`,
      }),
    }) {}

    const app = JustScale()
      .add(VaultClient)
      .add(ProdSecrets)
      .add(AuthService)
      .build();
    await app.compile().ready;

    const svc = await app.container.resolve(AuthService);
    assert.strictEqual(svc.describe(), 'postgres://vault-host/prod|super-secret-jwt-key');
  });

  test('zod validation: invalid secret shape is rejected at boot', async () => {
    const StrictSecret = defineSecretPartial('strict.secret', z.object({
      token: z.string().min(10),
    }));

    const BadProvider = createSecretProvider({
      provides: [StrictSecret],
      factory: () => ({
        [StrictSecret.key]: { token: 'short' },
      }),
    });

    await assert.rejects(async () => {
      const app = JustScale().add(BadProvider).build();
      await app.compile().ready;
    });
  });

  test('SecretService.read() works for dynamically-chosen partials', async () => {
    const ApiSecret = defineSecretPartial('api.dyn', z.object({ key: z.string() }));

    const Provider = createSecretProvider({
      provides: [ApiSecret],
      factory: () => ({ [ApiSecret.key]: { key: 'abc123' } }),
    });

    class ApiClient extends defineService({
      inject: { secrets: SecretServiceDef },
      factory: ({ secrets }) => ({
        fetch: async () => {
          const s = await secrets.read(ApiSecret);
          return s.key;
        },
      }),
    }) {}

    const app = JustScale().add(SecretServiceDef).add(Provider).add(ApiClient).build();
    await app.compile().ready;

    const client = await app.container.resolve(ApiClient);
    assert.strictEqual(await client.fetch(), 'abc123');
  });

  test('missing secret provider: validation fails at .build() time', () => {
    const Missing = defineSecretPartial('missing.secret', z.object({ v: z.string() }));

    class NeedsIt extends defineService({
      inject: { s: Secret.of(Missing) },
      factory: ({ s }) => ({ get: () => s.v }),
    }) {}

    assert.throws(
      // @ts-expect-error — intentionally missing dep to verify runtime error
      () => JustScale().add(NeedsIt).build(),
      (err: Error) => {
        assert.match(err.message, /missing/i);
        return true;
      },
    );
  });
});
