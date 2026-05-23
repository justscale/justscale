import type { Component } from '../../builder/index.js';
import type { VaultKind } from '../vault/types.js';
import type { ConfigPartial, ConfigComponent } from '../config/types.js';
import type { SecretPartial, SecretComponent } from '../secrets/types.js';
import type { FeatureFlagPartial, FeatureFlagComponent } from '../feature-flags/types.js';

/** All valid environment types. */
export const ENVIRONMENT_TYPES = ['production', 'test', 'development', 'ci'] as const;
export type EnvironmentType = typeof ENVIRONMENT_TYPES[number];

/**
 * Vault-policy rules applied at build time.
 * `disallow` throws on matching VAULT_KIND brands; `warn` logs and permits.
 */
export interface VaultPolicyRules {
  disallow?: VaultKind[]
  warn?: VaultKind[]
}

/** Vault-policy option on `createEnvironment`. `extend` merges additional rules. */
export interface VaultPolicy {
  extend?: VaultPolicyRules
}

export const DEFAULT_VAULT_POLICY: Record<EnvironmentType, VaultPolicyRules> = {
  production: { disallow: ['hardcoded'] },
  ci: { disallow: ['hardcoded'] },
  test: {},
  development: {},
};

/**
 * Marker brand for Environment values. Cross-realm: env files loaded from
 * /tmp paths may resolve @justscale/core to a different module instance,
 * so the marker must be globally interned for the identity check to match.
 */
export const ENVIRONMENT = Symbol.for('justscale.environment');

export interface Environment<
  S extends readonly Component[] = readonly Component[],
  P extends readonly Component[] = readonly Component[],
> {
  readonly [ENVIRONMENT]: true
  readonly name: string
  readonly type: EnvironmentType
  readonly public: Record<string, unknown>
  readonly services: S
  readonly providers: P
  readonly vaultPolicy: VaultPolicyRules
}

export function isEnvironment(value: unknown): value is Environment {
  return typeof value === 'object' && value !== null && ENVIRONMENT in value;
}

// ============================================================================
// Typed Env Contract
// ============================================================================

/**
 * Declarative contract describing the partials a specific app's env
 * supplies. Used with `loadEnvironment<T>()`, `createEnvironment<T>()`,
 * and `defineApp<T>()` so the builder's feature-requirement type checks
 * don't lose information when the env is loaded dynamically.
 *
 * @example
 * ```ts
 * // src/env-contract.ts
 * export type AppEnv = EnvContract<{
 *   config:  [typeof AppConfig, typeof HttpConfig, typeof PostgresProcessConfig],
 *   secrets: [typeof PostgresSecrets],
 *   flags:   [typeof UserFlags],
 * }>;
 *
 * // src/app.ts
 * export default defineApp<AppEnv>(import.meta, (env) =>
 *   JustScale().add(env).add(PostgresFeature) // TS: env provides PostgresSecrets ✓
 * );
 *
 * // env/development.ts
 * export default createEnvironment<AppEnv>({ ... });
 * // ^ providers[] must cover every partial in AppEnv or TS errors.
 * ```
 */
export type EnvContract<T extends {
  readonly config?: readonly ConfigPartial<any>[]
  readonly secrets?: readonly SecretPartial<any>[]
  readonly flags?: readonly FeatureFlagPartial<any>[]
  readonly services?: readonly Component[]
}> = Environment<
  T['services'] extends readonly Component[] ? T['services'] : readonly [],
  readonly [
    ...(T['config']  extends readonly ConfigPartial<any>[]      ? [ConfigComponent<T['config']>]     : []),
    ...(T['secrets'] extends readonly SecretPartial<any>[]      ? [SecretComponent<T['secrets']>]    : []),
    ...(T['flags']   extends readonly FeatureFlagPartial<any>[] ? [FeatureFlagComponent<T['flags']>] : []),
  ]
>;

// ============================================================================
// Registered partials - per-feature module augmentation
// ============================================================================

/**
 * Registry of config partials that the app's imports make visible.
 * Each feature augments this interface via `declare module '@justscale/core'`;
 * the app then derives its `Env` type directly from the merged shape
 * instead of re-listing every partial by hand.
 *
 * @example Feature-side augmentation
 * ```ts
 * // @justscale/http
 * declare module '@justscale/core' {
 *   interface RegisteredConfigPartials {
 *     http: typeof HttpConfig;
 *   }
 * }
 * ```
 *
 * @example App-side usage
 * ```ts
 * // simple-app/src/env-contract.ts
 * export type AppEnv = Env;   // all registered partials, no manual list
 * ```
 *
 * Augmentations are scoped per-compilation: only features actually
 * imported from the app's compile graph contribute.
 */
 
export interface RegisteredConfigPartials {}
 
export interface RegisteredSecretPartials {}
 
export interface RegisteredFlagPartials {}

type UnionToIntersection<U> =
  (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

type LastOf<T> =
  UnionToIntersection<T extends unknown ? () => T : never> extends () => infer R ? R : never;

type UnionToTuple<T, Last = LastOf<T>> =
  [T] extends [never] ? [] : [...UnionToTuple<Exclude<T, Last>>, Last];

type TupleFromInterfaceValues<T> =
  [T[keyof T]] extends [never] ? readonly [] : Readonly<UnionToTuple<T[keyof T]>>;

type RegisteredConfigTuple =
  TupleFromInterfaceValues<RegisteredConfigPartials> extends readonly ConfigPartial<any>[]
    ? TupleFromInterfaceValues<RegisteredConfigPartials>
    : readonly [];
type RegisteredSecretTuple =
  TupleFromInterfaceValues<RegisteredSecretPartials> extends readonly SecretPartial<any>[]
    ? TupleFromInterfaceValues<RegisteredSecretPartials>
    : readonly [];
type RegisteredFlagTuple =
  TupleFromInterfaceValues<RegisteredFlagPartials> extends readonly FeatureFlagPartial<any>[]
    ? TupleFromInterfaceValues<RegisteredFlagPartials>
    : readonly [];

/**
 * Env contract combining feature-registered partials with app-specific extras.
 *
 * @example
 * ```ts
 * export type AppEnv = Env<{
 *   config: [typeof AppConfig],
 *   flags:  [typeof UserFlags],
 * }>;
 * ```
 */
export type Env<Extras extends {
  readonly config?: readonly ConfigPartial<any>[]
  readonly secrets?: readonly SecretPartial<any>[]
  readonly flags?: readonly FeatureFlagPartial<any>[]
  readonly services?: readonly Component[]
} = {}> = EnvContract<{
  services: Extras['services'] extends readonly Component[] ? Extras['services'] : readonly []
  config: readonly [
    ...RegisteredConfigTuple,
    ...(Extras['config'] extends readonly ConfigPartial<any>[] ? Extras['config'] : readonly []),
  ]
  secrets: readonly [
    ...RegisteredSecretTuple,
    ...(Extras['secrets'] extends readonly SecretPartial<any>[] ? Extras['secrets'] : readonly []),
  ]
  flags: readonly [
    ...RegisteredFlagTuple,
    ...(Extras['flags'] extends readonly FeatureFlagPartial<any>[] ? Extras['flags'] : readonly []),
  ]
}>;

/**
 * Type-level vault compatibility brand. A concrete vault service can be
 * tagged with the set of EnvironmentTypes it is permitted in. When passed
 * into `createEnvironment`, the env's `type` is checked against this brand
 * and incompatible combinations become a TS type error.
 *
 * Services without the brand are treated as env-neutral (allowed anywhere).
 */
declare const VAULT_ALLOWED_IN: unique symbol;

export interface VaultAllowedIn<T extends EnvironmentType> {
  readonly [VAULT_ALLOWED_IN]?: T
}

/**
 * Given a service token type S and an environment type T, resolve to S if
 * S is either un-branded (any env) or allows T - otherwise resolve to
 * `never` so a TS assignment error fires at the incompatible position.
 */
export type ServiceCompatibleWithEnv<S, T extends EnvironmentType> =
  S extends VaultAllowedIn<infer Allowed>
    ? T extends Allowed ? S : never
    : S;
