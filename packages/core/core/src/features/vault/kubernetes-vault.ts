import { defineService } from '../../core/index.js';
import type { Service } from '../../core/service.js';
import { AbstractVaultClient, VAULT_KIND, type VaultClient } from './types.js';

type VaultService = Service<VaultClient, {}>;

interface KubernetesVaultOptions {
  /**
   * Directory where secrets are mounted. Defaults to
   * `/var/run/secrets` - the standard k8s secret-volume mount path.
   */
  mountPath?: string
  /**
   * Optional namespace prefix applied to all paths. Useful when the same
   * vault client is shared across multiple mounted secrets.
   */
  namespace?: string
}

/**
 * KubernetesVault - reads secret values from mounted k8s Secret volumes.
 *
 * Paths are translated to file paths under `mountPath`:
 *   read('postgres/url') → /var/run/secrets/postgres/url
 *
 * Assumes secrets are mounted as individual files under the configured
 * mount path, which is the standard k8s pattern for Secret volumes.
 */
export function KubernetesVault(options: KubernetesVaultOptions = {}): VaultService {
  const mountPath = options.mountPath ?? '/var/run/secrets';
  const namespace = options.namespace ?? '';

  async function readRaw(path: string, throwOnMissing: boolean): Promise<string | undefined> {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const fullPath = namespace
      ? join(mountPath, namespace, path)
      : join(mountPath, path);
    try {
      const contents = await readFile(fullPath, 'utf-8');
      return contents.replace(/\n$/, '');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        if (throwOnMissing) {
          throw new Error(
            `KubernetesVault: secret '${path}' not mounted at ${fullPath}`,
            { cause: err },
          );
        }
        return undefined;
      }
      throw new Error(
        `KubernetesVault: failed to read '${path}' at ${fullPath}: ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  class KubernetesVaultImpl extends defineService({
    inject: {},
    provides: [AbstractVaultClient],
    factory: (): VaultClient => ({
      async read(path: string): Promise<string> {
        return (await readRaw(path, true)) as string;
      },
      async readOptional(path: string): Promise<string | undefined> {
        return readRaw(path, false);
      },
    }),
  }) {}

  Object.assign(KubernetesVaultImpl, { [VAULT_KIND]: 'kubernetes' });

  return KubernetesVaultImpl as unknown as VaultService;
}
