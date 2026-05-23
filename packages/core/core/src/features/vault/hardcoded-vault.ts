import { defineService } from '../../core/index.js';
import type { Service } from '../../core/service.js';
import type { VaultAllowedIn } from '../environment/types.js';
import { AbstractVaultClient, VAULT_KIND, type VaultClient } from './types.js';

/**
 * Public shape of a concrete vault service: a Service that produces a
 * VaultClient. Used in return-type annotations so the declaration emitter
 * doesn't leak internal service symbols (SERVICE_ID etc.) while still
 * surfacing a value that `.add()` accepts as a Component.
 */
type VaultService = Service<VaultClient, {}>;

/**
 * HardcodedVault - development-only vault with values inlined in TypeScript.
 *
 * Intentionally awful-looking: the store is passed as a plain object at
 * construction. Meant to scream "dev only" at a glance. Environment policy
 * refuses to let this be wired into production/CI environments.
 *
 * @example
 * // env/development.ts
 * import { HardcodedVault } from '@justscale/core'
 *
 * export default createEnvironment({
 *   name: 'dev-local',
 *   type: 'development',
 *   services: [HardcodedVault({
 *     'postgres/url': 'postgres://postgres:postgres@localhost:5432/dev',
 *     'jwt/key': 'dev-only-signing-key',
 *   })],
 *   providers: [DevSecretProvider],
 * })
 */
export function HardcodedVault(store: Record<string, string>): VaultService & VaultAllowedIn<'development' | 'test'> {
  class HardcodedVaultImpl extends defineService({
    inject: {},
    provides: [AbstractVaultClient],
    factory: (): VaultClient => ({
      async read(path: string): Promise<string> {
        const value = store[path];
        if (value === undefined) {
          const keys = Object.keys(store).join(', ');
          throw new Error(
            `HardcodedVault: no value at path '${path}'. Known paths: ${keys || '(none)'}`,
          );
        }
        return value;
      },
      async readOptional(path: string): Promise<string | undefined> {
        return store[path];
      },
    }),
  }) {}

  Object.assign(HardcodedVaultImpl, { [VAULT_KIND]: 'hardcoded' });

  return HardcodedVaultImpl as unknown as VaultService & VaultAllowedIn<'development' | 'test'>;
}
