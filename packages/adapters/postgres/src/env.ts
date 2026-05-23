/**
 * Env contributions for Postgres.
 *
 * Each helper accepts either a static override object or a `fromVault`-
 * produced factory. Either way, unspecified fields fall through to each
 * partial's zod defaults (`signalChannel='process_signals'`,
 * `table='_migrations'`, `directory='./migrations'`).
 *
 * @example
 * ```ts
 * // Static
 * postgresProcessEnv({ signalChannel: 'dev_signals' })
 *
 * // Vault-sourced
 * postgresProcessEnv(fromVault(PostgresProcessConfig, { signalChannel: 'postgres/signal-channel' }))
 * ```
 */

import { config, secret, type ConfigSource } from '@justscale/core';
import type { z } from 'zod';
import {
  PostgresProcessConfig,
  PostgresMigrationConfig,
  PostgresMigrationDevConfig,
} from './config.js';
import { PostgresSecrets } from './secrets.js';

type PostgresProcessShape = z.infer<typeof PostgresProcessConfig.schema>;
type PostgresMigrationShape = z.infer<typeof PostgresMigrationConfig.schema>;
type PostgresMigrationDevShape = z.infer<typeof PostgresMigrationDevConfig.schema>;

export const postgresProcessEnv = (source: ConfigSource<PostgresProcessShape> = {}) =>
  config(PostgresProcessConfig, source);

export const postgresMigrationEnv = (source: ConfigSource<PostgresMigrationShape> = {}) =>
  config(PostgresMigrationConfig, source);

export const postgresMigrationDevEnv = (source: ConfigSource<PostgresMigrationDevShape> = {}) =>
  config(PostgresMigrationDevConfig, source);

/**
 * Read the Postgres connection string from the vault at `vaultKey`.
 * Dev typically uses `'postgres/url'` (backed by `HardcodedVault`);
 * prod uses the same shape with `EnvVarVault`/`KubernetesVault`/etc.
 */
export const postgresSecret = (vaultKey: string) =>
  secret(PostgresSecrets, async ({ vault }) => ({
    connectionString: await vault.read(vaultKey),
  }));
