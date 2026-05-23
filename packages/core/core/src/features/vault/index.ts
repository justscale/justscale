/**
 * @justscale/core/vault
 *
 * Abstract vault-client token + concrete implementations. SecretProviders
 * inject `AbstractVaultClient` to read raw values from the configured source.
 */

export { AbstractVaultClient, VAULT_KIND } from './types.js';
export type { VaultClient, VaultKind } from './types.js';
export { HardcodedVault } from './hardcoded-vault.js';
export { EnvVarVault } from './env-var-vault.js';
export { KubernetesVault } from './kubernetes-vault.js';
export { HashiCorpVault } from './hashicorp-vault.js';
