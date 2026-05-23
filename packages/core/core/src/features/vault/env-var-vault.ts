import { defineService } from '../../core/index.js';
import { AbstractVaultClient, VAULT_KIND, type VaultClient } from './types.js';

/**
 * EnvVarVault - reads raw values from `process.env`.
 *
 * The path is transformed to an uppercase env-var name: `/` and `-` become
 * `_`. E.g. `read('postgres/url')` reads `POSTGRES_URL`.
 *
 * Apps use it uniformly for both secrets (via `postgresSecret(...)`) and
 * non-secret config overrides (via `fromVault(partial, {...})`), so the
 * production composition never reads `process.env` directly.
 *
 * @example
 * export default createEnvironment({
 *   name: 'production',
 *   type: 'production',
 *   services: [EnvVarVault],
 *   providers: [...],
 * })
 */
export class EnvVarVault extends defineService({
  inject: {},
  provides: [AbstractVaultClient],
  factory: (): VaultClient => ({
    async read(path: string): Promise<string> {
      const envKey = toEnvKey(path);
      const value = process.env[envKey];
      if (value === undefined) {
        throw new Error(
          `EnvVarVault: environment variable '${envKey}' is not set (read of path '${path}')`,
        );
      }
      return value;
    },
    async readOptional(path: string): Promise<string | undefined> {
      return process.env[toEnvKey(path)];
    },
  }),
}) {}

function toEnvKey(path: string): string {
  return path.toUpperCase().replace(/[/-]/g, '_');
}

Object.assign(EnvVarVault, { [VAULT_KIND]: 'envvar' });
