/**
 * Env contribution helpers for assembling an environment declaratively.
 *
 * `buildProviders([...])` partitions contributions into the three
 * providers `createEnvironment` expects (config, secrets, flags).
 *
 * `fromVault(partial, mapping)` builds an async config source that reads
 * each field from the vault and coerces the raw string using the partial's
 * zod schema. Fields with `.default()` or `.optional()` are silently
 * dropped when the vault path is missing; required fields throw at boot.
 */

import { z } from 'zod';
import { AbstractVaultClient, type VaultClient } from '../vault/types.js';
import { createConfig } from '../config/create-config.js';
import { createSecretProvider } from '../secrets/create-secret-provider.js';
import { createFeatureFlagProvider } from '../feature-flags/create-feature-flag-provider.js';
import type { ConfigPartial, ConfigComponent } from '../config/types.js';
import type { SecretPartial, SecretComponent } from '../secrets/types.js';
import type { FeatureFlagPartial, FeatureFlagComponent } from '../feature-flags/types.js';

// ============================================================================
// Contribution kinds
// ============================================================================

const CONFIG_CONTRIB = Symbol('env:config-contribution');
const SECRET_CONTRIB = Symbol('env:secret-contribution');
const FLAG_CONTRIB = Symbol('env:flag-contribution');

type VaultDeps = { vault: VaultClient };

/** A config override: static object or async factory that reads the vault. */
export type ConfigSource<T> =
  | Partial<T>
  | ((deps: VaultDeps) => Partial<T> | Promise<Partial<T>>);

export interface ConfigContribution<T = unknown> {
  readonly [CONFIG_CONTRIB]: true
  readonly partial: ConfigPartial<T>
  readonly source: ConfigSource<T>
}

export interface SecretContribution<T = unknown> {
  readonly [SECRET_CONTRIB]: true
  readonly partial: SecretPartial<T>
  readonly factory: (deps: VaultDeps) => T | Promise<T>
}

export interface FlagContribution<T = unknown> {
  readonly [FLAG_CONTRIB]: true
  readonly partial: FeatureFlagPartial<T>
  readonly value: Partial<T>
}

export type EnvContribution =
  | ConfigContribution<any>
  | SecretContribution<any>
  | FlagContribution<any>;

// ============================================================================
// Contribution constructors
// ============================================================================

/** Contribute values for a config partial. Unset fields fall through to the partial's zod defaults. */
export function config<S extends z.ZodType<any>>(
  partial: ConfigPartial<z.infer<S>> & { schema: S },
  source: ConfigSource<z.infer<S>> = {},
): ConfigContribution<z.infer<S>> {
  return { [CONFIG_CONTRIB]: true, partial, source };
}

/** Contribute a factory for a secret partial. Runs with the env's injected vault client. */
export function secret<T>(
  partial: SecretPartial<T>,
  factory: SecretContribution<T>['factory'],
): SecretContribution<T> {
  return { [SECRET_CONTRIB]: true, partial, factory };
}

/** Contribute values for a feature-flag partial. Unset fields fall through to the partial's zod defaults. */
export function flag<S extends z.ZodType<any>>(
  partial: FeatureFlagPartial<z.infer<S>> & { schema: S },
  value: Partial<z.infer<S>> = {},
): FlagContribution<z.infer<S>> {
  return { [FLAG_CONTRIB]: true, partial, value };
}

// ============================================================================
// fromVault - schema-aware config source
// ============================================================================

/**
 * Build an async config source that reads mapped fields from the vault.
 * Each raw string is coerced to the field's zod type before returning.
 * Required fields throw at boot; optional/defaulted fields are silently skipped.
 */
export function fromVault<T>(
  partial: ConfigPartial<T>,
  mapping: Partial<Record<keyof T & string, string>>,
): (deps: VaultDeps) => Promise<Partial<T>> {
  return async ({ vault }) => {
    const shape = unwrapZodObject(partial.schema).shape as Record<string, z.ZodTypeAny>;
    const result: Record<string, unknown> = {};

    for (const [field, path] of Object.entries(mapping)) {
      if (path === undefined) continue;
      const zodType = shape[field];
      if (!zodType) {
        throw new Error(
          `fromVault: field '${field}' is not in the '${partial.name}' schema`,
        );
      }

      const optional = isOptionalInSchema(zodType);
      const raw = optional
        ? await vault.readOptional(path as string)
        : await vault.read(path as string);

      if (raw === undefined) {
        if (acceptsNull(zodType) && !acceptsUndefined(zodType)) {
          result[field] = null;
        }
        continue;
      }

      try {
        result[field] = parseForZod(zodType, raw);
      } catch (err) {
        throw new Error(
          `fromVault: failed to parse '${partial.name}.${field}' from '${path}': ${(err as Error).message}`,
          { cause: err },
        );
      }
    }

    return result as Partial<T>;
  };
}

function unwrapZodObject(schema: z.ZodType): z.ZodObject<any> {
  let current: z.ZodTypeAny = schema;
  while (
    current instanceof z.ZodDefault ||
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable
  ) {
    current = (current as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType;
  }
  if (!(current instanceof z.ZodObject)) {
    throw new Error('fromVault: partial schema must be a ZodObject');
  }
  return current;
}

/** True when a missing value is acceptable (zod handles it without erroring). */
function isOptionalInSchema(zodType: z.ZodTypeAny): boolean {
  return (
    zodType instanceof z.ZodDefault ||
    zodType instanceof z.ZodOptional ||
    zodType instanceof z.ZodNullable
  );
}

/** True when the schema accepts `null`. Walks wrapper layers. */
function acceptsNull(zodType: z.ZodTypeAny): boolean {
  let t: z.ZodTypeAny = zodType;
  while (t instanceof z.ZodDefault || t instanceof z.ZodOptional) {
    t = (t as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType;
  }
  return t instanceof z.ZodNullable;
}

/** True when the schema accepts `undefined`. ZodNullable alone does NOT. */
function acceptsUndefined(zodType: z.ZodTypeAny): boolean {
  let t: z.ZodTypeAny = zodType;
  while (t instanceof z.ZodNullable) {
    t = (t as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType;
  }
  return t instanceof z.ZodOptional || t instanceof z.ZodDefault;
}

function parseForZod(zodType: z.ZodTypeAny, raw: string): unknown {
  let t: z.ZodTypeAny = zodType;
  while (
    t instanceof z.ZodDefault ||
    t instanceof z.ZodOptional ||
    t instanceof z.ZodNullable
  ) {
    t = (t as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType;
  }

  if (t instanceof z.ZodNumber) {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new Error(`'${raw}' is not a valid number`);
    return n;
  }
  if (t instanceof z.ZodBoolean) {
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    throw new Error(`'${raw}' is not a valid boolean (expected 'true' | 'false' | '1' | '0')`);
  }
  if (t instanceof z.ZodBigInt) return BigInt(raw);
  if (t instanceof z.ZodDate) return new Date(raw);
  if (
    t instanceof z.ZodArray ||
    t instanceof z.ZodObject ||
    t instanceof z.ZodRecord ||
    t instanceof z.ZodTuple
  ) {
    return JSON.parse(raw);
  }
  // String, enum, native enum, literal, union-of-strings - passthrough.
  return raw;
}

// ============================================================================
// Provider assembly
// ============================================================================

function isConfigContrib(c: EnvContribution): c is ConfigContribution {
  return CONFIG_CONTRIB in c;
}
function isSecretContrib(c: EnvContribution): c is SecretContribution {
  return SECRET_CONTRIB in c;
}
function isFlagContrib(c: EnvContribution): c is FlagContribution {
  return FLAG_CONTRIB in c;
}

// Walk the contributions tuple, keep ConfigContribution members, and map
// each to its ConfigPartial so ProvidesOf<ConfigComponent<...>> can expose
// the matching ConfigTokens for DI validation.
type PickConfigPartials<T extends readonly EnvContribution[]> =
  T extends readonly [infer H, ...infer R extends readonly EnvContribution[]]
    ? H extends ConfigContribution<infer V>
      ? readonly [ConfigPartial<V>, ...PickConfigPartials<R>]
      : PickConfigPartials<R>
    : readonly [];

type PickSecretPartials<T extends readonly EnvContribution[]> =
  T extends readonly [infer H, ...infer R extends readonly EnvContribution[]]
    ? H extends SecretContribution<infer V>
      ? readonly [SecretPartial<V>, ...PickSecretPartials<R>]
      : PickSecretPartials<R>
    : readonly [];

type PickFlagPartials<T extends readonly EnvContribution[]> =
  T extends readonly [infer H, ...infer R extends readonly EnvContribution[]]
    ? H extends FlagContribution<infer V>
      ? readonly [FeatureFlagPartial<V>, ...PickFlagPartials<R>]
      : PickFlagPartials<R>
    : readonly [];

/**
 * Partition contributions by kind and assemble the `[Config, Secrets, Flags]`
 * provider triple that `createEnvironment({ providers })` expects.
 */
export function buildProviders<const T extends readonly EnvContribution[]>(
  contributions: T,
): [
  ConfigComponent<PickConfigPartials<T>>,
  SecretComponent<PickSecretPartials<T>>,
  FeatureFlagComponent<PickFlagPartials<T>>,
] {
  const configs = contributions.filter(isConfigContrib);
  const secrets = contributions.filter(isSecretContrib);
  const flags = contributions.filter(isFlagContrib);

  const Config = createConfig({
    provides: configs.map((c) => c.partial),
    inject: { vault: AbstractVaultClient },
    factory: async (deps) => {
      const result: Record<symbol, unknown> = {};
      for (const c of configs) {
        const value =
          typeof c.source === 'function'
            ? await c.source(deps as VaultDeps)
            : c.source;
        result[c.partial.key] = value;
      }
      return result;
    },
  });

  const Secrets = createSecretProvider({
    provides: secrets.map((c) => c.partial),
    inject: { vault: AbstractVaultClient },
    factory: async (deps) => {
      const result: Record<symbol, unknown> = {};
      for (const c of secrets) {
        result[c.partial.key] = await c.factory(deps as VaultDeps);
      }
      return result;
    },
  });

  const Flags = createFeatureFlagProvider({
    provides: flags.map((c) => c.partial),
    factory: () => Object.fromEntries(flags.map((c) => [c.partial.key, c.value])),
  });

  return [Config, Secrets, Flags] as unknown as [
    ConfigComponent<PickConfigPartials<T>>,
    SecretComponent<PickSecretPartials<T>>,
    FeatureFlagComponent<PickFlagPartials<T>>,
  ];
}
