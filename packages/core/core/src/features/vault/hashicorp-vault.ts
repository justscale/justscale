import { defineService } from '../../core/index.js';
import type { Service } from '../../core/service.js';
import { AbstractVaultClient, VAULT_KIND, type VaultClient } from './types.js';

type VaultService = Service<VaultClient, {}>;

interface HashiCorpVaultOptions {
  /**
   * Vault server URL, e.g. `https://vault.example.com:8200`.
   */
  url: string
  /**
   * Auth token for this vault client. In production this typically comes
   * from a kubernetes-auth exchange rather than a static token.
   */
  token: string
  /**
   * KV secrets engine version. Defaults to `'v2'`.
   */
  kvVersion?: 'v1' | 'v2'
  /**
   * Mount path for the secrets engine. Defaults to `'secret'`.
   */
  mount?: string
}

/**
 * HashiCorpVault - reads secret values from a HashiCorp Vault KV engine.
 *
 * Paths follow the `<path>[#<field>]` convention: `postgres/url` reads all
 * fields, `postgres#connectionString` reads the single `connectionString`
 * field. For v2 KV engines, this transparently uses the `/data/` segment.
 */
export function HashiCorpVault(options: HashiCorpVaultOptions): VaultService {
  const kvVersion = options.kvVersion ?? 'v2';
  const mount = options.mount ?? 'secret';

  async function readRaw(path: string, throwOnMissing: boolean): Promise<string | undefined> {
    const [secretPath, field] = path.includes('#') ? path.split('#', 2) : [path, undefined];
    const dataSegment = kvVersion === 'v2' ? '/data/' : '/';
    const url = `${options.url}/v1/${mount}${dataSegment}${secretPath}`;

    const response = await fetch(url, {
      headers: { 'X-Vault-Token': options.token },
    });
    if (response.status === 404) {
      if (throwOnMissing) throw new Error(`HashiCorpVault: no data at '${path}'`);
      return undefined;
    }
    if (!response.ok) {
      throw new Error(
        `HashiCorpVault: ${response.status} ${response.statusText} reading '${path}'`,
      );
    }
    const body = await response.json() as {
      data?: { data?: Record<string, unknown> } | Record<string, unknown>
    };
    const data = kvVersion === 'v2'
      ? (body.data as { data?: Record<string, unknown> })?.data
      : body.data as Record<string, unknown> | undefined;
    if (!data) {
      if (throwOnMissing) throw new Error(`HashiCorpVault: no data at '${path}'`);
      return undefined;
    }
    if (field !== undefined) {
      const value = data[field];
      if (value === undefined) {
        if (throwOnMissing) {
          throw new Error(`HashiCorpVault: field '${field}' at '${secretPath}' is not set`);
        }
        return undefined;
      }
      if (typeof value !== 'string') {
        throw new Error(`HashiCorpVault: field '${field}' at '${secretPath}' is not a string`);
      }
      return value;
    }
    return JSON.stringify(data);
  }

  class HashiCorpVaultImpl extends defineService({
    inject: {},
    provides: [AbstractVaultClient],
    factory: (): VaultClient => ({
      async read(path: string): Promise<string> {
        const value = await readRaw(path, true);
        return value as string;
      },
      async readOptional(path: string): Promise<string | undefined> {
        return readRaw(path, false);
      },
    }),
  }) {}

  Object.assign(HashiCorpVaultImpl, { [VAULT_KIND]: 'hashicorp' });

  return HashiCorpVaultImpl as unknown as VaultService;
}
