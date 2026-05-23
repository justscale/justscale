/**
 * Shared utility for transforming string params into typed References
 * using a `types` config. Used by both the process executor and HTTP server.
 *
 * Matching: key matches param name directly, lowercased, or lowercased + "Ref" suffix.
 * `types: { Table }` matches `:table`, `:Table`, and `:tableRef`.
 */

import type { ModelClass } from './define-model.js';
import { Reference, SET_RESOLVER } from './reference/reference.js';
import type { ReferenceResolver } from './reference/reference.js';

// ============================================================================
// Global ref resolver registry - populated by storage adapters at boot
// ============================================================================

const _resolvers = new WeakMap<ModelClass<unknown>, ReferenceResolver<unknown>>();

export function registerModelRefResolver(model: ModelClass<unknown>, resolver: ReferenceResolver<unknown>): void {
  _resolvers.set(model, resolver);
}

export function getModelRefResolver(model: ModelClass<unknown>): ReferenceResolver<unknown> | undefined {
  return _resolvers.get(model);
}

// ============================================================================
// Type-level param resolution (shared by processes and controllers)
// ============================================================================

/** Flatten intersection types for cleaner display */
export type Prettify<T> = { [K in keyof T]: T[K] } & {};

/** Types config: maps model classes to path params */
export type TypesConfig = Record<string, ModelClass<unknown>>;

/**
 * Extract param names from a path as a union of string literals.
 * "/poker/:table/game/:gameId" → "table" | "gameId"
 */
export type ExtractParamNames<Path extends string> =
  Path extends `${string}:${infer Param}/${infer Rest}`
    ? Param | ExtractParamNames<`/${Rest}`>
    : Path extends `${string}:${infer Param}`
      ? Param
      : never;

/**
 * Extract params from a path as a record of string values.
 * "/users/:id/posts/:postId" → { id: string; postId: string }
 */
export type ExtractParams<TPath extends string> =
  { [K in ExtractParamNames<TPath>]: string };

/**
 * Look up the model type for a param name from the types config.
 *
 * Matches by:
 * 1. Direct key match: `types: { tableRef: Table }` → `:tableRef` gets `Ref<Table>`
 * 2. Lowercased key: `types: { Table }` → `:table` gets `Ref<Table>`
 * 3. Lowercased + "Ref" suffix: `types: { Table }` → `:tableRef` gets `Ref<Table>`
 */
export type ResolveParamType<
  TParamName extends string,
  TTypes extends Record<string, abstract new (...args: any[]) => any>,
> = {
  [K in keyof TTypes]: K extends TParamName
    ? TTypes[K]
    : K extends string
      ? Lowercase<K> extends TParamName
        ? TTypes[K]
        : `${Lowercase<K>}Ref` extends TParamName
          ? TTypes[K]
          : never
      : never
}[keyof TTypes];

/**
 * Extract a clean Reference type from a model class.
 * Uses InstanceType<T> so TypeScript preserves the class name in tooltips.
 */
type ModelReference<TModel extends abstract new (...args: any[]) => any> =
  Reference<InstanceType<TModel>>;

export type TypedParams<
  TPath extends string,
  TTypes extends Record<string, abstract new (...args: any[]) => any>,
> = {
  [P in ExtractParamNames<TPath>]:
  ResolveParamType<P, TTypes> extends never
    ? string
    : ModelReference<ResolveParamType<P, TTypes>>
};

// ============================================================================
// Runtime param transformation
// ============================================================================

export function applyTypesConfig(
  params: Record<string, string>,
  types?: TypesConfig,
): Record<string, unknown> {
  if (!types) return params;

  const lookup = new Map<string, ModelClass<unknown>>();
  for (const [key, model] of Object.entries(types)) {
    lookup.set(key, model);
    lookup.set(key.toLowerCase(), model);
    lookup.set(key.toLowerCase() + 'Ref', model);
  }

  const result: Record<string, unknown> = {};
  for (const [paramName, stringValue] of Object.entries(params)) {
    const model = lookup.get(paramName);
    if (model) {
      const ref = new Reference(stringValue);
      const resolver = _resolvers.get(model as ModelClass<unknown>);
      if (resolver) (ref as unknown as { [SET_RESOLVER]: (r: ReferenceResolver<unknown>) => void })[SET_RESOLVER](resolver);
      result[paramName] = ref;
    } else {
      result[paramName] = stringValue;
    }
  }
  return result;
}
