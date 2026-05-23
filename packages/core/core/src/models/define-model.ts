/**
 * Model Definition
 *
 * Creates typed model classes with field schemas.
 */

import { type FieldBuilder, type FieldDef, type Decimal, FIELD_DEF } from './field.js';
import { Reference, References, isReference, isReferences } from './reference/reference.js';
import { FIELD_STORAGE, MODEL_METHODS, MODEL_REPO_CONTRACT, PERSISTENT, ADAPTER_KEY, HYDRATE, MODEL_INJECT, MODEL_SERVICE, ACCESS_RULES, PERMISSION_DEFS } from './symbols.js';
import type { Persistent } from './types.js';
import { isPersistent } from './types.js';
import type { ServiceToken, ResolvedDeps } from '../core/service.js';
import type { GuardDef } from '../core/middleware.js';

export { MODEL_METHODS, MODEL_INJECT, MODEL_SERVICE };
import {
  createFieldExpr,
  StringFieldExpr,
  NumberFieldExpr,
  BigIntFieldExpr,
  DecimalFieldExpr,
  BooleanFieldExpr,
  TimestampFieldExpr,
  RefFieldExpr,
  RefsFieldExpr,
  ArrayFieldExpr,
  JsonFieldExpr,
  ObjectFieldExpr,
} from './query.js';

// ============================================================================
// Symbols
// ============================================================================

/** Symbol.for() so separate module realms see the same symbol */
export const MODEL_DEF = Symbol.for('@justscale/core/models:modelDef');
/**
 * Stable identity key for a model class. Two classes produced by separate imports
 * of the same source (e.g. after HMR cache-busting) share the same stable ID, so
 * `ModelRepository.of(model)` resolves to the same token without special wiring.
 */
export const MODEL_STABLE_ID = Symbol.for('@justscale/core/models:modelStableId');
export const MODEL_FIELDS = Symbol('models:modelFields');
export const MODEL_NAME = Symbol('models:modelName');
export const MODEL_DATA = Symbol('models:modelData');
export const MODEL_DEFAULTS = Symbol('models:modelDefaults');

// ============================================================================
// Types
// ============================================================================

/** Forces TypeScript to expand/simplify a type in .d.ts output */
type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type FieldDefs = Record<string, FieldBuilder<unknown> | FieldDef>;

/** Unwrap HasDefault<T> → T, pass-through for other types */
type UnwrapDefault<T> = T extends { readonly __hasDefault: infer U } ? U : T;

export type InferModelType<F extends FieldDefs> = Simplify<{
  [K in keyof F]: F[K] extends FieldBuilder<infer T>
    ? UnwrapDefault<T>
    : F[K] extends FieldDef<infer T>
      ? UnwrapDefault<T>
      : never;
}>;

/** Extract keys of fields that have defaults */
export type InferDefaultKeys<F extends FieldDefs> = {
  [K in keyof F]: F[K] extends FieldBuilder<infer T>
    ? T extends { readonly __hasDefault: unknown } ? K : never
    : F[K] extends FieldDef<infer T>
      ? T extends { readonly __hasDefault: unknown } ? K : never
      : never;
}[keyof F];

/**
 * Partial type for model constructor input.
 * Ref fields accept both Reference<R> and Persistent<R> (the setter handles both).
 */
export type DeepPartial<T> = {
  // Decimal strips its brand so plain string literals ('9.99') are accepted;
  // check it before the `object` branch because `string & {...}` also
  // structurally extends `object`.
  [K in keyof T]?: [NonNullable<T[K]>] extends [Decimal]
    ? string | (undefined extends T[K] ? undefined : never)
    : T[K] extends Reference<any>
      ? T[K] | (Persistent<any> & { readonly [PERSISTENT]: true })
      : T[K] extends References<any>
        ? T[K]
        : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

// biome-ignore lint/suspicious/noExplicitAny: Methods can have any signature
export type MethodDefs = Record<string, (this: any, ...args: any[]) => any>;

export type InferMethods<T, M extends MethodDefs> = {
  [K in keyof M]: M[K] extends (this: unknown, ...args: infer A) => infer R
    ? (this: T, ...args: A) => R
    : never;
};

/**
 * Maps a field's TypeScript type to its corresponding field expression type.
 * For nested objects, recursively creates field expressions for nested access.
 */
type ValueToFieldExpr<T> =
  [NonNullable<T>] extends [Reference<infer R>]
    ? RefFieldExpr<R>
    : [NonNullable<T>] extends [References<infer R>]
      ? RefsFieldExpr<R>
      : // Decimal (branded string) must be checked before plain `string`,
    // otherwise the `string` branch swallows it.
      [NonNullable<T>] extends [Decimal]
        ? DecimalFieldExpr
        : [NonNullable<T>] extends [string]
          ? StringFieldExpr
          : [NonNullable<T>] extends [number]
            ? NumberFieldExpr
            : [NonNullable<T>] extends [bigint]
              ? BigIntFieldExpr
              : [NonNullable<T>] extends [boolean]
                ? BooleanFieldExpr
                : [NonNullable<T>] extends [Date]
                  ? TimestampFieldExpr
                  : [NonNullable<T>] extends [(infer E)[]]
                    ? ArrayFieldExpr<E>
                    : [NonNullable<T>] extends [Record<string, unknown>]
                      ? ObjectFieldExpr<NonNullable<T>> & NestedFieldExprs<NonNullable<T>>
                      : JsonFieldExpr;

/**
 * Creates field expressions for nested object properties.
 * This enables type-safe access like `User.fields.settings.theme.eq('dark')`.
 */
type NestedFieldExprs<T> = T extends Record<string, unknown>
  ? { readonly [K in keyof T]: ValueToFieldExpr<T[K]> }
  : {};

type FieldExprsFromData<T> = {
  readonly [K in keyof T]: ValueToFieldExpr<T[K]>;
};

// biome-ignore lint/suspicious/noExplicitAny: Contract methods can have any signature
export type RepositoryContract<T = unknown> = Record<string, (...args: any[]) => Promise<any>>;

// ============================================================================
// Ref accessor factory
// ============================================================================

/**
 * Create the `Model.ref` callable. References are memoized by ID using
 * WeakRef so identical IDs round-trip to the same Reference instance (as long
 * as it hasn't been garbage collected).
 *
 * @internal used by defineModel to populate `static ref`
 */
function createRefAccessor<T>(): (
  idOrStringsOrEntity: string | TemplateStringsArray | Record<string | symbol, unknown>,
  ...values: unknown[]
) => Reference<T> {
  const refCache = new Map<string, WeakRef<Reference<T>>>();

  const getOrCreateRef = (id: string): Reference<T> => {
    const cached = refCache.get(id);
    if (cached) {
      const ref = cached.deref();
      if (ref) return ref;
      refCache.delete(id);
    }
    const ref = new Reference<T>(id, (callable as any).__modelName);
    refCache.set(id, new WeakRef(ref));
    return ref;
  };

  const callable = function (
    idOrStringsOrEntity: string | TemplateStringsArray | Record<string | symbol, unknown>,
    ...values: unknown[]
  ): Reference<T> {
    if (typeof idOrStringsOrEntity === 'object' && 'raw' in idOrStringsOrEntity) {
      const id = String.raw({ raw: idOrStringsOrEntity as TemplateStringsArray }, ...values);
      return getOrCreateRef(id);
    }
    if (isReference(idOrStringsOrEntity)) {
      const ref = getOrCreateRef(idOrStringsOrEntity.identifier);
      if (idOrStringsOrEntity.isLoaded) {
        ref[HYDRATE](idOrStringsOrEntity.value as Persistent<T>);
      }
      return ref;
    }
    if (typeof idOrStringsOrEntity === 'object' && idOrStringsOrEntity !== null) {
      const key = (idOrStringsOrEntity as Record<symbol, unknown>)[ADAPTER_KEY];
      if (key !== undefined) {
        const ref = getOrCreateRef(key as string);
        ref[HYDRATE](idOrStringsOrEntity as Persistent<T>);
        return ref;
      }
      throw new Error('Cannot create Reference from object without adapter key. Is this a persistent entity?');
    }
    return getOrCreateRef(idOrStringsOrEntity as string);
  };

  return callable;
}

// ============================================================================
// BaseModel - The base class all models extend
// ============================================================================

/**
 * Abstract base class that all models extend.
 * The class itself represents the transient (unpersisted) form.
 * Use Persistent<T> for the persisted form with id, createdAt, etc.
 *
 * Models are Disposable by default to support `using` declarations
 * in durable processes (for rehydration marking).
 */
export abstract class BaseModel<T, N extends string = string, D extends string = never> implements Disposable {
  // Type brands via symbols - used for inference, never assigned at runtime
  declare readonly [MODEL_DATA]: T;
  declare readonly [MODEL_NAME]: N;
  declare readonly [MODEL_DEFAULTS]: D;

  constructor(data: DeepPartial<T>) {
    Object.defineProperty(this, FIELD_STORAGE, {
      value: {} as Record<string, unknown>,
      enumerable: false,
      writable: false,
    });

    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      (this as Record<string, unknown>)[key] = value;
    }
  }

  /** No-op dispose - models use `using` for process rehydration marking, not cleanup */
  [Symbol.dispose](): void {}
}

// ============================================================================
// Model - The model class type (static side)
// ============================================================================

/**
 * A model class created by defineModel().
 *
 * TInject carries the resolved inject deps type - instances include these
 * properties via prototype chain (the model service).
 */
export interface Model<T, N extends string = string, C extends RepositoryContract<T> = {}, D extends string = never, TInject extends Record<string, unknown> = {}> {
  readonly [MODEL_DEF]: true;
  readonly [MODEL_DATA]: T;
  readonly [MODEL_NAME]: N;
  readonly [MODEL_DEFAULTS]: D;
  readonly [MODEL_FIELDS]: Record<string, FieldDef>;
  readonly [MODEL_REPO_CONTRACT]?: C;
  readonly [MODEL_INJECT]?: Record<string, ServiceToken>;
  readonly fields: FieldExprsFromData<T>;

  // Constructor creates a transient instance - includes inject deps from prototype
  new (data: DeepPartial<T>): BaseModel<T, N, D> & T & Readonly<TInject>;

  /**
   * Reference accessor - polymorphic over `this` so subclass body additions
   * flow through. `Cart.ref`${id}`` returns `Reference<Cart>` (including any
   * getters/methods declared on the `Cart` class). For validation at HTTP/CLI
   * boundaries, use `z.ref(Cart)` instead of the ref as a Zod schema.
   */
  ref<I>(this: new (data: DeepPartial<T>) => I, idOrEntity: string | object): Reference<I>;
  ref<I>(this: new (data: DeepPartial<T>) => I, strings: TemplateStringsArray, ...values: unknown[]): Reference<I>;

  refs<I>(this: new (data: DeepPartial<T>) => I, ...ids: string[]): References<I>;

  /**
   * Create a transient model instance with inject deps available via prototype.
   * Prefer this over `new Model(data)` when the model has inject deps.
   */
  create(data: Omit<DeepPartial<T>, keyof TInject>): BaseModel<T, N, D> & T & Readonly<TInject>;

  // Add repository contract type
  withRepository<Contract extends RepositoryContract<T>>(): Model<T, N, Contract, D, TInject>;

  /**
   * Override this model with additional fields.
   * Returns a new model class with merged fields. Inherits the ref accessor (same cache).
   * Use for extending framework models: `class AppUser extends User.override({ fields: {...} }) {}`
   */
  override<TNew extends FieldDefs>(config: {
    name?: string;
    fields: TNew;
    inject?: Record<string, ServiceToken>;
  }): Model<T & InferModelType<TNew>, string, {}, D | (InferDefaultKeys<TNew> & string)>;
}

export type ModelClass<T, N extends string = string, C extends RepositoryContract<T> = {}> = Model<T, N, C, string, any>;
export type ModelConstructor<T, N extends string = string, C extends RepositoryContract<T> = {}> = Model<T, N, C, string, any>;

// ============================================================================
// Type Extraction Helpers
// ============================================================================

/**
 * Extract the data type from a Model class.
 *
 * Use this to get clean type references that TypeScript preserves in .d.ts output:
 * - `ModelData<typeof User>` shows as `ModelData<typeof User>` in hovers
 * - Instead of `{ readonly email: string; readonly name: string; ... }`
 *
 * @example
 * ```typescript
 * class User extends defineModel({
 *   email: field.string(),
 *   name: field.string(),
 * }) {}
 *
 * type UserData = ModelData<typeof User>
 * // { readonly email: string; readonly name: string }
 * ```
 */
export type ModelData<M> = M extends { readonly [MODEL_DATA]: infer T } ? T : never;

/**
 * Extract the model name from a Model class.
 *
 * @example
 * ```typescript
 * class User extends defineModel({ ... }) {}
 * type Name = ModelName<typeof User>  // "User"
 * ```
 */
export type ModelName<M> = M extends { readonly [MODEL_NAME]: infer N extends string } ? N : never;

/**
 * Type guard for any Model class.
 * Use this when you need to accept any model without caring about its specific type.
 */
export type AnyModel = Model<unknown, string, RepositoryContract<unknown>, string>;

// ============================================================================
// Global model registry - models with inject, for Container.wireModelPrototypes
// ============================================================================

const modelsWithInject = new Set<AnyModel>();

/** Register a model class for inject wiring (called by createInMemoryModel/createPgModel) */
export function registerModelForInjection(model: AnyModel): void {
  if (MODEL_INJECT in model) {
    modelsWithInject.add(model);
  }
}

/** Get all models that need inject wiring */
export function getModelsWithInject(): ReadonlySet<AnyModel> {
  return modelsWithInject;
}

// ============================================================================
// defineModel - Creates a model class
// ============================================================================

/**
 * Define a model class.
 *
 * @example
 * ```typescript
 * // Fields-only form
 * class User extends defineModel({
 *   email: field.string().max(255),
 *   name: field.string().optional(),
 * }) {}
 *
 * // Config form with inject - model instances gain DI services via prototype
 * class Order extends defineModel({
 *   fields: {
 *     amount: field.decimal(10, 2),
 *     status: field.enum('Status', ['pending', 'paid']),
 *   },
 *   inject: {
 *     payments: PaymentService,
 *   },
 * }) {}
 * ```
 */
// ============================================================================
// Shared helpers - used by defineModel and Model.override()
// ============================================================================

/** Build FieldDefs into resolved FieldDef records */
function buildFieldDefs(fields: FieldDefs): Record<string, FieldDef> {
  const builtFields: Record<string, FieldDef> = {};
  for (const [key, fieldOrBuilder] of Object.entries(fields)) {
    if (FIELD_DEF in fieldOrBuilder) {
      builtFields[key] = fieldOrBuilder as FieldDef;
    } else if ('build' in fieldOrBuilder && typeof fieldOrBuilder.build === 'function') {
      builtFields[key] = (fieldOrBuilder as FieldBuilder<unknown>).build();
    } else {
      throw new Error(`Invalid field definition for "${key}" in model`);
    }
  }
  return builtFields;
}

/** Create field expressions from built field definitions */
function buildFieldExprs(builtFields: Record<string, FieldDef>): Record<string, unknown> {
  const fieldExprs: Record<string, unknown> = {};
  for (const [key, fieldDef] of Object.entries(builtFields)) {
    fieldExprs[key] = createFieldExpr(key, fieldDef);
  }
  return fieldExprs;
}

/** Add ref field getters/setters to a prototype (only for NEW fields, not inherited) */
function defineRefGetters(proto: object, builtFields: Record<string, FieldDef>) {
  for (const [fieldName, fieldDef] of Object.entries(builtFields)) {
    if (fieldDef.type === 'ref') {
      Object.defineProperty(proto, fieldName, {
        get(this: { [FIELD_STORAGE]: Record<string, unknown> }) {
          return this[FIELD_STORAGE][fieldName];
        },
        set(this: { [FIELD_STORAGE]: Record<string, unknown> }, value: unknown) {
          if (isReference(value)) {
            this[FIELD_STORAGE][fieldName] = value;
          } else if (typeof value === 'string') {
            throw new Error(`Cannot assign string to ref field "${fieldName}". Use Model.ref\`id\` instead.`);
          } else if (isPersistent(value)) {
            this[FIELD_STORAGE][fieldName] = value;
          } else if (value === null || value === undefined) {
            this[FIELD_STORAGE][fieldName] = value;
          } else {
            throw new Error(`Invalid value for ref field "${fieldName}".`);
          }
        },
        enumerable: true,
        configurable: true,
      });
    } else if (fieldDef.type === 'refs') {
      Object.defineProperty(proto, fieldName, {
        get(this: { [FIELD_STORAGE]: Record<string, unknown> }) {
          return this[FIELD_STORAGE][fieldName];
        },
        set(this: { [FIELD_STORAGE]: Record<string, unknown> }, value: unknown) {
          if (isReferences(value)) {
            this[FIELD_STORAGE][fieldName] = value;
          } else if (Array.isArray(value)) {
            if (value.length === 0) {
              this[FIELD_STORAGE][fieldName] = new References([]);
            } else if (typeof value[0] === 'string') {
              throw new Error(`Cannot assign string array to refs field "${fieldName}". Use Model.refs(...ids) instead.`);
            } else if (isPersistent(value[0])) {
              this[FIELD_STORAGE][fieldName] = value;
            }
          } else if (value === null || value === undefined) {
            this[FIELD_STORAGE][fieldName] = value;
          }
        },
        enumerable: true,
        configurable: true,
      });
    }
  }
}

/** A map of action names to guard definitions */
export type PermissionRecord = Record<string, GuardDef | readonly GuardDef[]>;

/**
 * Stamp each permission's `.name` with its key as a string literal.
 *
 * `permit(X).always()` returns a def whose `name` is typed as `string` (the
 * actual name is set at runtime by defineModel from the permissions record
 * key). This type-level pass narrows `name` to the key literal so permission-
 * scoped `.returns()` can build a proper discriminated union.
 */
export type StampPermissionNames<P extends PermissionRecord> = {
  readonly [K in keyof P & string]: P[K] extends readonly (infer E)[]
    ? readonly (E & { readonly name: K })[]
    : P[K] & { readonly name: K }
};

/** Factory function that receives field expressions and returns a permissions map */
export type PermissionsFactory<F extends FieldDefs, P extends PermissionRecord> =
  (fields: FieldExprsFromData<InferModelType<F>>) => P;

// ============================================================================
// Access Control Types
// ============================================================================

/**
 * A single field's access rule.
 * - GuardDef or GuardDef[]: short form, same for see + set
 * - []: nobody (fully hidden, not editable)
 * - { see?, set? }: split form for different read/write
 */
export type FieldAccessRule =
  | GuardDef | readonly GuardDef[]
  | readonly []
  | { see?: GuardDef | readonly GuardDef[] | readonly []; set?: GuardDef | readonly GuardDef[] | readonly [] };

/** The resolved access rules stored on a model - field name to rule */
export type AccessRulesRecord = Record<string, FieldAccessRule>;

/** Factory function that receives permission defs and returns field access rules */
export type AccessFactory<F extends FieldDefs, P extends PermissionRecord> =
  (permissions: P) => Partial<Record<keyof InferModelType<F>, FieldAccessRule>>;

// Config form with inject + permissions (+ optional access)
export function defineModel<
  const F extends FieldDefs,
  const D extends Record<string, ServiceToken>,
  const P extends PermissionRecord,
>(config: { name?: string; fields: F; inject: D; permissions: PermissionsFactory<F, P>; access?: AccessFactory<F, P> }): Model<InferModelType<F>, string, {}, InferDefaultKeys<F> & string, ResolvedDeps<D>> & { readonly can: StampPermissionNames<P> };

// Config form with inject, no permissions
export function defineModel<
  const F extends FieldDefs,
  const D extends Record<string, ServiceToken>,
>(config: { name?: string; fields: F; inject: D }): Model<InferModelType<F>, string, {}, InferDefaultKeys<F> & string, ResolvedDeps<D>>;

// Config form with permissions (+ optional access), no inject
export function defineModel<
  const F extends FieldDefs,
  const P extends PermissionRecord,
>(config: { name?: string; fields: F; permissions: PermissionsFactory<F, P>; access?: AccessFactory<F, P> }): Model<InferModelType<F>, string, {}, InferDefaultKeys<F> & string> & { readonly can: StampPermissionNames<P> };

// Config form without inject or permissions
export function defineModel<
  const F extends FieldDefs,
>(config: { name?: string; fields: F }): Model<InferModelType<F>, string, {}, InferDefaultKeys<F> & string>;

// Fields-only form
export function defineModel<const F extends FieldDefs>(
  fields: F
): Model<InferModelType<F>, string, {}, InferDefaultKeys<F> & string>;

// Implementation
// biome-ignore lint/suspicious/noExplicitAny: implementation must accept all overload forms
export function defineModel(
  fieldsOrConfig: FieldDefs | { name?: string; fields: FieldDefs; inject?: Record<string, ServiceToken>; permissions?: (model: any) => PermissionRecord },
) {
  // Detect config form: has a `fields` property whose value is NOT a FieldBuilder/FieldDef
  // (a FieldBuilder has `build`, a FieldDef has FIELD_DEF - if `fields` is one of those,
  // the user named a field "fields", which is the fields-only form)
  const configCandidate = fieldsOrConfig as { name?: string; fields?: unknown; inject?: unknown; permissions?: (model: any) => PermissionRecord; access?: (perms: any) => Record<string, FieldAccessRule> };
  const fieldsValue = configCandidate.fields;
  const isConfig = fieldsValue !== undefined
    && typeof fieldsValue === 'object'
    && fieldsValue !== null
    && !(FIELD_DEF in (fieldsValue as object))
    && !('build' in (fieldsValue as object));
  const fields = isConfig
    ? fieldsValue as FieldDefs
    : fieldsOrConfig as FieldDefs;
  const inject = isConfig
    ? configCandidate.inject as Record<string, ServiceToken> | undefined
    : undefined;
  const permissionsFactory = isConfig ? configCandidate.permissions : undefined;
  const accessFactory = isConfig ? configCandidate.access : undefined;
  const explicitName = isConfig
    ? configCandidate.name as string | undefined
    : undefined;

  type T = Record<string, unknown>;

  const builtFields = buildFieldDefs(fields);
  const fieldExprs = buildFieldExprs(builtFields) as FieldExprsFromData<T>;

  // Create dual-purpose ref accessor (callable + Zod schema)
  const refAccessor = createRefAccessor<T>();

  // The model class - extends BaseModel and adds static properties
  class ModelImpl extends BaseModel<T> {
    static readonly [MODEL_DEF] = true as const;
    static readonly [MODEL_FIELDS] = builtFields;
    static readonly fields = fieldExprs;
    static readonly ref = refAccessor;

    static get [MODEL_NAME](): string {
      return explicitName ?? this.name;
    }

    static get [MODEL_STABLE_ID](): string {
      return `model:${explicitName ?? this.name}`;
    }

    static refs(...ids: string[]) {
      return new References<T>(ids);
    }

    static withRepository<Contract extends RepositoryContract<T>>() {
      return this as unknown as Model<T, string, Contract>;
    }

    static create(data: Record<string, unknown>) {
      const service = (this as unknown as Record<symbol, unknown>)[MODEL_SERVICE] as object | undefined;
      const proto = service ?? this.prototype;
      const instance = Object.create(proto);
      Object.defineProperty(instance, FIELD_STORAGE, { value: {}, enumerable: false, writable: false });
      for (const [key, value] of Object.entries(data)) {
        instance[key] = value;
      }
      return instance;
    }

    /**
     * Override this model with additional fields.
     * Returns a new model class that inherits all parent fields + adds new ones.
     * The ref accessor is inherited (same cache, same identity).
     */
    static override(overrideConfig: { name?: string; fields: FieldDefs; inject?: Record<string, ServiceToken> }) {
      const newBuiltFields = buildFieldDefs(overrideConfig.fields);
      const mergedFields = { ...this[MODEL_FIELDS], ...newBuiltFields };
      const mergedFieldExprs = buildFieldExprs(mergedFields);
      const overrideName = overrideConfig.name;
      const ParentClass = this;

      class OverrideModelImpl extends (ParentClass as any) {
        static readonly [MODEL_DEF] = true as const;
        static readonly [MODEL_FIELDS] = mergedFields;
        static readonly fields = mergedFieldExprs;
        // ref is INHERITED from parent - same accessor, same cache

        static get [MODEL_NAME](): string {
          return overrideName ?? this.name;
        }

        static get [MODEL_STABLE_ID](): string {
          return `model:${overrideName ?? this.name}`;
        }
      }

      // Add getters/setters for NEW fields only (parent's are inherited via prototype chain)
      defineRefGetters(OverrideModelImpl.prototype, newBuiltFields);

      // Merge inject configs
      if (overrideConfig.inject) {
        const parentInject = (ParentClass as any)[MODEL_INJECT] ?? {};
        Object.defineProperty(OverrideModelImpl, MODEL_INJECT, {
          value: { ...parentInject, ...overrideConfig.inject },
          enumerable: false,
          configurable: true,
          writable: false,
        });
      }

      return OverrideModelImpl;
    }
  }

  // Store inject config on the model class (if provided)
  if (inject) {
    Object.defineProperty(ModelImpl, MODEL_INJECT, {
      value: inject,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  }

  // Call permissions factory with field expressions and attach result as `can`
  if (permissionsFactory) {
    const permissionDefs = permissionsFactory(fieldExprs);
    // Stamp each permission def with its action name (the key from the permissions record)
    for (const [actionName, def] of Object.entries(permissionDefs)) {
      if (Array.isArray(def)) {
        for (const d of def) {
          if (d && typeof d === 'object') (d as any).name = actionName;
        }
      } else if (def && typeof def === 'object') {
        (def as any).name = actionName;
      }
    }
    Object.defineProperty(ModelImpl, 'can', {
      value: permissionDefs,
      enumerable: true,
      configurable: false,
      writable: false,
    });
    // Store the raw permission defs for access rule evaluation
    Object.defineProperty(ModelImpl, PERMISSION_DEFS, {
      value: permissionDefs,
      enumerable: false,
      configurable: false,
      writable: false,
    });

    // Call access factory with permission defs and store result
    if (accessFactory) {
      const accessRules = accessFactory(permissionDefs);
      Object.defineProperty(ModelImpl, ACCESS_RULES, {
        value: accessRules,
        enumerable: false,
        configurable: false,
        writable: false,
      });
    }
  }

  // Add ref/refs field getters/setters
  defineRefGetters(ModelImpl.prototype, builtFields);

  return ModelImpl as unknown as Model<T, string, {}, never, Record<string, unknown>>;
}


// ============================================================================
// Type Guards & Helpers
// ============================================================================

export function isModelClass(value: unknown): value is Model<unknown> {
  return (
    value !== null &&
    typeof value === 'function' &&
    MODEL_DEF in value &&
    (value as Record<symbol, unknown>)[MODEL_DEF] === true
  );
}

export function getModelFields(model: { [MODEL_FIELDS]: Record<string, FieldDef> }): Record<string, FieldDef> {
  return model[MODEL_FIELDS];
}

export function getModelName(model: { [MODEL_NAME]: string }): string {
  return model[MODEL_NAME];
}

export type ModelInstance<M> = M extends Model<infer T> ? T : never;
