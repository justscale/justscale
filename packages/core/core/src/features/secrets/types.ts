import type { z } from 'zod';
import type { Token } from '../../builder/index.js';

export const SECRET_PARTIAL = Symbol('secret:partial');

/**
 * A secret partial - defines shape and validation for a secret slice.
 *
 * Parallel to ConfigPartial but reserved for secrets. Secrets are NEVER
 * mutated at runtime (no .set, no persistence to .justscale/). Values come
 * from a vault-backed SecretProvider at boot and are read-only thereafter.
 */
export interface SecretPartial<T> {
  readonly [SECRET_PARTIAL]: true
  readonly key: symbol
  readonly name: string
  readonly schema: z.ZodType<T>
}

export function isSecretPartial(value: unknown): value is SecretPartial<unknown> {
  return typeof value === 'object' && value !== null && SECRET_PARTIAL in value;
}

/**
 * Component returned by createSecretProvider().
 * Builder runs its factory at boot, validates each returned value against
 * its partial's schema, and registers the results under partial keys.
 */
export interface SecretComponent<P extends readonly SecretPartial<any>[] = readonly SecretPartial<any>[]> {
  readonly __secretComponent: true
  readonly provides: P
  readonly inject: Record<string, Token<any>>
  readonly factory: (deps: Record<string, any>) => Record<symbol, any> | Promise<Record<symbol, any>>
}

export function isSecretComponent(value: unknown): value is SecretComponent {
  return typeof value === 'object' && value !== null && '__secretComponent' in value;
}
