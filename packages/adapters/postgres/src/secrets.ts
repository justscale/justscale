import { defineSecretPartial } from '@justscale/core';
import { z } from 'zod';

/**
 * Canonical Postgres connection secret.
 *
 * The adapter's built-in `PostgresFeature` and the per-service factories
 * (`PostgresClientService`, `PostgresChannelBackendService`) inject
 * `Secret.of(PostgresSecrets)` - an environment's secret provider fills it
 * from a vault or env var.
 *
 * Apps that need a different shape (separate host/password, multiple DBs)
 * should define their own `defineSecretPartial(...)` and build the services
 * directly with `createPostgresClient` + `createPostgresChannelBackend`
 * instead of using `PostgresFeature`.
 *
 * @example
 * ```typescript
 * import { defineEnvironment, createSecretProvider, HardcodedVault } from '@justscale/core'
 * import { PostgresSecrets } from '@justscale/postgres'
 *
 * const DevSecrets = createSecretProvider({
 *   provides: [PostgresSecrets],
 *   factory: () => ({
 *     [PostgresSecrets.key]: {
 *       connectionString: 'postgres://localhost:5432/app',
 *     },
 *   }),
 * })
 * ```
 */
export const PostgresSecrets = defineSecretPartial(
  'postgres',
  z.object({
    connectionString: z.string().min(1),
  }),
);

declare module '@justscale/core' {
  interface RegisteredSecretPartials {
    postgres: typeof PostgresSecrets;
  }
}
