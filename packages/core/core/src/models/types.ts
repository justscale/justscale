import type { z } from 'zod';
import type {
  MODEL_INTERNALS,
  OBSERVABLE_META,
  MODEL_METHODS,
} from './symbols.js';
import { PERSISTENT, TRANSIENT, LOCK } from './symbols.js';
import { MODEL_DATA, MODEL_DEFAULTS } from './define-model.js'; // MODEL_DEFAULTS for InsertData
import type { Lock, LockMetadata } from '../features/lock/types.js';
import type { Reference } from './reference/reference.js';
import type { Decimal } from './field.js';

// ============================================
// Model Types (from @justscale/observable)
// ============================================

/**
 * Internal state for a model.
 */
export interface ModelInternals<T, S extends z.ZodTypeAny = z.ZodTypeAny> {
  schema: S;
  dirty: Set<string>;
  original: T;
  markClean(): void;
  isDirty(): boolean;
  getDirtyPaths(): string[];
  getDirtyData(): Partial<T>;
}

/**
 * A model with attached internals for dirty tracking.
 */
export type Model<T> = T & {
  [MODEL_INTERNALS]: ModelInternals<T>;
};

// ============================================
// Observable Types (from @justscale/observable)
// ============================================

/**
 * Internal state for an observable.
 */
export interface ObservableInternals {
  dirty: Set<string>;
  markClean(): void;
  isDirty(): boolean;
  getDirtyPaths(): string[];
}

/**
 * An observable wrapper that tracks mutations.
 */
export type Observable<T> = T & {
  [OBSERVABLE_META]: ObservableInternals;
};

// ============================================
// Proxy Types (from @justscale/observable)
// ============================================

/**
 * Reference to a parent proxy.
 */
export interface ParentRef {
  ref: WeakRef<ProxyMeta>;
  key: string;
}

/**
 * Internal metadata for tracked proxies.
 */
export interface ProxyMeta {
  path: string[];
  dirtySets: Set<Set<string>>;
  parents: Set<ParentRef>;
  children: Map<string | symbol, ProxyMeta>;
  target: object;
  proxy: object;
}

// ============================================
// Entity and Persistent Types
// ============================================

/**
 * Base entity type - anything with an id.
 */
export interface Entity<TId = string> {
  id: TId;
}

/**
 * System fields added by the persistence layer.
 *
 * These are ADAPTER concerns - they do NOT appear on Persistent<T>.
 * Adapters store these internally via non-enumerable symbols.
 * Domain code never sees or accesses system fields directly.
 *
 * @deprecated Import from your adapter package instead (e.g. @justscale/postgres).
 * Kept temporarily for migration - will be removed from core.
 */
export interface SystemFields {
  /** Unique identifier assigned by storage */
  readonly id: string;
  /** Creation timestamp */
  readonly createdAt: Date;
  /** Last update timestamp */
  readonly updatedAt: Date;
  /** Version for optimistic concurrency */
  readonly version: number;
}

/**
 * Keys of system fields (for type-level exclusion).
 *
 * @deprecated Adapter concern - will be removed from core.
 */
export type SystemFieldKeys = keyof SystemFields;

/**
 * Extract domain fields, excluding system fields and internal symbols.
 *
 * @deprecated No longer needed - Persistent<T> is already pure domain fields.
 */
export type DomainFields<T> = Omit<T, SystemFieldKeys | typeof PERSISTENT | typeof LOCK>;

/**
 * Resolve T to its model data type if T is a model class, otherwise use T directly.
 */
type ResolveModelType<T> =
  T extends abstract new (...args: any[]) => { readonly [MODEL_DATA]: infer D }
    ? D
    : T extends { readonly [MODEL_DATA]: infer D }
      ? D
      : T;

/** Domain fields: the model's data type. No system fields to exclude anymore. */
type DomainOf<T> = ResolveModelType<T>;

/**
 * Extract the set of field names that have defaults from a model class.
 * Returns `never` if T is not a model class.
 */
type ResolveDefaultKeys<T> =
  T extends abstract new (...args: any[]) => { readonly [MODEL_DEFAULTS]: infer D }
    ? D extends string ? D : never
    : T extends { readonly [MODEL_DEFAULTS]: infer D }
      ? D extends string ? D : never
      : never;

/** Keys of T whose type includes undefined */
type UndefinedKeys<T> = {
  [K in keyof T]: undefined extends T[K] ? K : never;
}[keyof T];

/**
 * Strip the internal `Decimal` brand recursively so callers can pass plain
 * strings for nested-object decimal fields too. Leaves non-decimal types
 * untouched.
 */
type StripDecimal<V> =
  [NonNullable<V>] extends [Decimal]
    ? string | (undefined extends V ? undefined : never)
    : V extends readonly (infer E)[]
      ? StripDecimal<E>[]
      : V extends Record<string, unknown>
        ? { [K in keyof V]: StripDecimal<V[K]> }
        : V;

/** Widen Reference<X> fields to also accept Persistent<X> (i.e. Ref<X>) */
type AcceptRef<V> =
  [NonNullable<V>] extends [Reference<infer X>]
    ? Reference<X> | Persistent<X> | Lock<Persistent<X>> | (undefined extends V ? undefined : never)
    : StripDecimal<V>;

/**
 * Insert data type - domain fields only.
 *
 * Handles both model classes (`InsertData<typeof User>`) and plain types.
 * Fields that are optional (undefined) or have defaults become optional keys.
 * Reference fields accept Ref<T> (Reference, Persistent, or Lock).
 */
export type InsertData<T> = {
  // Required fields: not undefined, not a default key
  -readonly [K in keyof DomainOf<T> as
  K extends (UndefinedKeys<DomainOf<T>> | ResolveDefaultKeys<T>) ? never : K
  ]: AcceptRef<DomainOf<T>[K]>;
} & {
  // Optional fields: undefined or has default
  -readonly [K in keyof DomainOf<T> as
  K extends (UndefinedKeys<DomainOf<T>> | ResolveDefaultKeys<T>) ? K : never
  ]?: AcceptRef<DomainOf<T>[K]>;
};

/**
 * Update data type - partial domain fields.
 *
 * Handles both model classes (`UpdateData<typeof User>`) and plain types.
 */
export type UpdateData<T> = {
  -readonly [K in keyof DomainOf<T>]?: AcceptRef<DomainOf<T>[K]>;
};

/**
 * Make all fields mutable.
 * Used by Lock<T> to enable writes on locked entities.
 */
export type Mutable<T> = {
  -readonly [K in keyof T]: T[K];
};

/**
 * @deprecated Use SystemFields instead. Alias for backwards compatibility.
 */
export type StorageMeta = SystemFields;

/**
 * Extract the instance type from a ModelClass or use T directly.
 * This allows `Persistent<typeof User>` where User is the defineModel result.
 *
 * For model constructors, extracts the instance type (which includes methods).
 * For plain types, uses the type directly.
 */
export type ExtractModelType<T> =
  // For constructors, get the instance type
  T extends abstract new (...args: any[]) => infer Instance
    ? Instance
    : T;

/**
 * Extract the data type for Reference compatibility.
 * Used by repository.get() to accept references created by Model.ref.
 *
 * Handles three cases:
 * 1. Instance type with [MODEL_DATA] (User) - extract from the symbol
 * 2. Constructor type (typeof User) - extract from constructor parameter
 * 3. Plain type - use as-is
 */
export type ReferenceData<T> =
  T extends { readonly [MODEL_DATA]: infer D }
    ? D
    : T extends abstract new (data: infer D) => unknown
      ? D
      : T;

/**
 * Simplify a type by forcing TypeScript to resolve all mapped types.
 * This produces cleaner type emissions in .d.ts files.
 *
 * Instead of: `Persistent<InferModelType<{email: FieldBuilder<string>}>>`
 * Produces:   `{id: string; email: string; ...}`
 */
export type Simplify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Extract methods from a ModelClass.
 * Returns the properly typed methods (with `this` bound to model data) or empty object.
 */
type ExtractModelMethods<T> = T extends { readonly [MODEL_METHODS]?: infer M }
  ? M extends undefined ? {} : M
  : {};

/**
 * A persisted model instance - pure domain data + methods.
 *
 * No system fields (id, createdAt, etc.) - those are adapter concerns,
 * stored internally via non-enumerable symbols. Domain code never sees them.
 *
 * To reference a persistent entity, use `Model.ref(entity)` or pass
 * the entity directly where a `Reference<T>` is expected.
 */
export type Persistent<T> = ExtractModelType<T> & ExtractModelMethods<T> & Disposable & {
  readonly [PERSISTENT]: true;
};

/**
 * A transient (not yet persisted) model instance.
 *
 * Used for creating new models before they have storage metadata.
 * Methods defined on the model are preserved on transient instances.
 */
export type Transient<T> = ExtractModelType<T> & ExtractModelMethods<T> & {
  readonly [TRANSIENT]: true;
};

// ============================================
// Ref<T> - unified reference type
// ============================================

/**
 * Anything that refers to an entity of type T.
 *
 * Use `Ref<T>` in method signatures that accept "something pointing at a T":
 * a Reference, a persistent entity, or a locked entity.
 *
 * @example
 * ```typescript
 * async transfer(from: Ref<Account>, to: Ref<Account>, amount: number) { ... }
 * async update(ref: Ref<User>, data: UpdateData<User>) { ... }
 * ```
 */
export type Ref<T> = Reference<T> | Persistent<T> | Lock<Persistent<T>>;

/**
 * Proves exclusive access to a persisted entity. Required for mutations.
 *
 * Use in service signatures to communicate "this method mutates":
 * ```typescript
 * async assignTicket(ticket: Locked<Ticket>, agent: Ref<Agent>) { ... }
 * ```
 *
 * Acquire via repository:
 * ```typescript
 * using ticket = await tickets.lock(params.ticket);
 * ```
 */
export type Locked<T> = Lock<Persistent<T>>;

// ============================================
// Lock Types
// ============================================

/**
 * Disposable interface for resources that need cleanup.
 */
export interface Disposable {
  /** Dispose of the resource (release lock, cleanup, etc.) */
  [Symbol.dispose](): void;
}

// Lock<T> and LockMetadata are defined in features/lock/types.ts
// Import from '@justscale/core' to use them

// ============================================
// Type Guards
// ============================================

/**
 * Check if an object is a persisted entity.
 *
 * @example
 * ```typescript
 * if (isPersistent(user)) {
 *   console.log(user.id); // TypeScript knows id exists
 * }
 * ```
 */
export function isPersistent<T>(obj: unknown): obj is Persistent<T> {
  return obj !== null && typeof obj === 'object' && PERSISTENT in obj;
}

/**
 * Check if an object is a transient (not yet persisted) entity.
 *
 * @example
 * ```typescript
 * if (isTransient(user)) {
 *   console.log('User not yet saved');
 * }
 * ```
 */
export function isTransient<T>(obj: unknown): obj is Transient<T> {
  return obj !== null && typeof obj === 'object' && TRANSIENT in obj;
}

/**
 * Check if an object is a locked entity.
 *
 * @example
 * ```typescript
 * if (isLocked(user)) {
 *   console.log(user.__lock.lockedAt); // Access lock metadata
 * }
 * ```
 */
export function isLocked<T>(obj: unknown): obj is Lock<T> {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    '__lock' in obj &&
    Symbol.dispose in obj
  );
}

// Re-export Lock and LockMetadata from features/lock/types.ts
export type { Lock, LockMetadata };
