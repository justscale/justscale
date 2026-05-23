import { defineAbstract } from '../../core/index.js';

/**
 * Brand attached to concrete vault-client service classes so the environment
 * layer can enforce policies (e.g. "HardcodedVault not allowed in production").
 */
export const VAULT_KIND = Symbol('justscale.vault.kind');

export type VaultKind = 'hardcoded' | 'envvar' | 'kubernetes' | 'hashicorp' | 'custom';

/**
 * Vault-client interface.
 *
 * Implementations read raw string values from an external source by path.
 * SecretProviders and config contributions (`fromVault`) inject
 * `AbstractVaultClient` and translate raw values into their typed shape.
 *
 * `read` throws when the path is not set - appropriate for required
 * values (most secrets). `readOptional` returns `undefined` - appropriate
 * for config overrides where a missing value should fall through to a
 * zod-level `.default()`.
 */
export interface VaultClient {
  /** Read a required value. Throws when the path is not set. */
  read(path: string): Promise<string>
  /** Read an optional value. Returns `undefined` when the path is not set. */
  readOptional(path: string): Promise<string | undefined>
}

/**
 * Abstract vault-client token. Concrete implementations (HardcodedVault,
 * EnvVarVault, KubernetesVault, HashiCorpVault) bind to this.
 *
 * @example
 * const ProdSecrets = createSecretProvider({
 *   inject: { vault: AbstractVaultClient },
 *   factory: async ({ vault }) => ({
 *     [PostgresSecrets.key]: { connectionString: await vault.read('postgres/url') },
 *   }),
 * })
 */
export abstract class AbstractVaultClient extends defineAbstract<VaultClient>('AbstractVaultClient') {}
