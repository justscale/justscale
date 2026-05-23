/**
 * @justscale/core/secrets
 *
 * Read-only, vault-backed secret management.
 *
 * Mirrors the config partial pattern but reserved for secrets - no runtime
 * mutation, no disk persistence, values loaded once at boot from a vault.
 */

export {
  SECRET_PARTIAL,
  isSecretPartial,
  isSecretComponent,
} from './types.js';
export type {
  SecretPartial,
  SecretComponent,
} from './types.js';

export { defineSecretPartial } from './define-secret-partial.js';
export { Secret } from './secret-of.js';
export type { SecretToken } from './secret-of.js';

export { createSecretProvider } from './create-secret-provider.js';

export { SecretServiceDef } from './secret-service.js';
export type { SecretService } from './secret-service.js';
