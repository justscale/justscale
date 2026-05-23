import { defineService, type Resolver } from '../../core/index.js';
import { Secret } from './secret-of.js';
import type { SecretPartial } from './types.js';

/**
 * Read-only secret access service.
 *
 * Intentionally has NO .set(), no persistence to disk, no watch. Secrets are
 * loaded at boot by SecretProviders and are immutable for the process
 * lifetime. Rotation = restart the process (k8s rolling deploy).
 */
export interface SecretService {
  /**
   * Read the current value for a secret partial.
   *
   * @throws if no provider has registered a value for this partial
   */
  read<T>(partial: SecretPartial<T>): Promise<T>
}

class SecretServiceImpl implements SecretService {
  constructor(private readonly resolver: Resolver) {}

  async read<T>(partial: SecretPartial<T>): Promise<T> {
    // Route through the partial's ResolvableToken (Secret.of) instead of the
    // raw symbol. The container's resolvable-token branch looks the value
    // up via container.instances.get(partial.key) and returns undefined
    // when nothing is registered; we surface the friendly error below.
    // Passing the raw symbol used to reach resolveInternal's
    // `'deps' in token` check and threw an opaque TypeError.
    const value = await this.resolver<T>(Secret.of(partial));
    if (value === undefined) {
      throw new Error(
        `SecretService.read: no provider registered a value for secret partial '${partial.name}'. ` +
        `Did you add a createSecretProvider() that returns { [${partial.name}.key]: ... }?`,
      );
    }
    return value;
  }
}

export class SecretServiceDef extends defineService({
  inject: {},
  factory: (_deps, resolver): SecretService => new SecretServiceImpl(resolver),
}) {}
