import type { Component } from '../../builder/index.js';
import {
  DEFAULT_VAULT_POLICY,
  ENVIRONMENT,
  type Environment,
  type EnvironmentType,
  type ServiceCompatibleWithEnv,
  type VaultPolicy,
  type VaultPolicyRules,
} from './types.js';

interface CreateEnvironmentOptions<
  T extends EnvironmentType,
  S extends readonly Component[],
  P extends readonly Component[],
> {
  name: string
  type: T
  /**
   * Non-secret environment values (site URL, log level, public API keys, etc.)
   * Stored on the Environment for runtime introspection. For typed injection,
   * prefer a `createConfig(...)` in `providers`.
   */
  public?: Record<string, unknown>
  /**
   * Raw services (vault clients, flag SDK clients) that providers depend on.
   * Services carrying a `VaultAllowedIn<E>` brand are checked against the
   * environment type at compile time - incompatible combos are a TS error.
   */
  services?: { [K in keyof S]: ServiceCompatibleWithEnv<S[K], T> }
  /**
   * Config/secret/flag providers that load values at boot.
   */
  providers?: P
  /**
   * Override the default vault policy for this environment.
   * The `extend` key merges additional rules into the default - it does
   * not replace the defaults.
   */
  vaultPolicy?: VaultPolicy
}

function mergeRules(a: VaultPolicyRules, b: VaultPolicyRules): VaultPolicyRules {
  return {
    disallow: [...(a.disallow ?? []), ...(b.disallow ?? [])],
    warn: [...(a.warn ?? []), ...(b.warn ?? [])],
  };
}

/**
 * Create an Environment - a declarative description of one deployment
 * target. Added to the builder with `.add(env)`, which expands into the
 * underlying services and providers while enforcing the vault policy.
 *
 * **Typed form** (recommended): pass `<E>` where `E = EnvContract<...>`
 * from your shared `env-contract.ts`. The return type becomes `E` so
 * `defineApp<E>` and `loadEnvironment<E>` carry full provides info through
 * the builder.
 *
 * @example
 * ```ts
 * // Typed
 * export default createEnvironment<AppEnv>({
 *   name: 'production',
 *   type: 'production',
 *   services: [KubernetesVault({ namespace: 'prod' })],
 *   providers: [ProdSecrets, ProdFlags, EnvConfig],
 * });
 *
 * // Untyped (legacy)
 * export default createEnvironment({ name: '...', type: 'production', ... });
 * ```
 */
export function createEnvironment<
  E extends Environment<any, any>,
  T extends EnvironmentType = EnvironmentType,
  const S extends readonly Component[] = readonly Component[],
>(options: CreateEnvironmentOptions<T, S, readonly Component[]>): E;
export function createEnvironment<
  T extends EnvironmentType,
  const S extends readonly Component[] = readonly [],
  const P extends readonly Component[] = readonly [],
>(options: CreateEnvironmentOptions<T, S, P>): Environment<S, P>;
export function createEnvironment(options: CreateEnvironmentOptions<any, any, any>): Environment<any, any> {
  const baseRules = DEFAULT_VAULT_POLICY[options.type as EnvironmentType];
  const extendRules = options.vaultPolicy?.extend ?? {};
  const policy = mergeRules(baseRules, extendRules);

  return {
    [ENVIRONMENT]: true,
    name: options.name,
    type: options.type,
    public: options.public ?? {},
    services: ((options.services as readonly Component[] | undefined)?.slice() ?? []) as unknown as readonly Component[],
    providers: (options.providers ?? []) as unknown as readonly Component[],
    vaultPolicy: policy,
  };
}
