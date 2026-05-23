import type { Token } from '../../builder/index.js';
import type { ServiceToken, InstanceOf } from '../../core/service.js';
import type { SecretPartial, SecretComponent } from './types.js';

type InferDeps<T extends Record<string, ServiceToken<any>>> = {
  [K in keyof T]: InstanceOf<T[K]>
};

type SecretFactory<TInject extends Record<string, ServiceToken<any>>> =
  (deps: InferDeps<TInject>) => Record<symbol, any> | Promise<Record<symbol, any>>;

interface CreateSecretProviderOptions<
  TInject extends Record<string, ServiceToken<any>>,
  P extends readonly SecretPartial<any>[],
> {
  provides?: P
  inject?: TInject
  factory: SecretFactory<TInject>
}

/**
 * Create a SecretProvider - a component that loads secrets from a source
 * (vault client, hardcoded values, process.env) at boot.
 *
 * The factory returns `{ [partial.key]: value }`. When `provides` is set,
 * each value is validated against its partial's zod schema.
 *
 * @example
 * const ProdSecrets = createSecretProvider({
 *   provides: [PostgresSecrets, JwtSecrets],
 *   inject: { vault: KubernetesVaultClient },
 *   factory: async ({ vault }) => ({
 *     [PostgresSecrets.key]: { connectionString: await vault.read('postgres/url') },
 *     [JwtSecrets.key]: { signingKey: await vault.read('jwt/key') },
 *   }),
 * })
 */
export function createSecretProvider<
  const TInject extends Record<string, ServiceToken<any>> = {},
  const P extends readonly SecretPartial<any>[] = readonly [],
>(options: CreateSecretProviderOptions<TInject, P>): SecretComponent<P> {
  return {
    __secretComponent: true,
    provides: (options.provides ?? []) as P,
    inject: (options.inject ?? {}) as Record<string, Token<any>>,
    factory: options.factory as SecretFactory<Record<string, ServiceToken<any>>>,
  };
}
