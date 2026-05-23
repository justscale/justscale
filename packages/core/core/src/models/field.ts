/**
 * Field Builders
 *
 * Type-safe field definitions for models.
 * These define the domain schema, storage mapping is separate.
 *
 * @example
 * ```typescript
 * import { defineModel, field } from '@justscale/core/models';
 *
 * class User extends defineModel({
 *   email: field.string().max(255).unique(),
 *   name: field.string(),
 *   balance: field.decimal(10, 2).default('0.00'),
 * }) {}
 * ```
 */

import type { Reference, References } from './reference/reference.js';
import type { Stream } from './stream.js';

// ============================================================================
// Type Helpers
// ============================================================================

import { MODEL_DATA } from './define-model.js';

/**
 * Extract the data type from a Model.
 * Uses MODEL_DATA symbol on BaseModel for inference.
 */
// biome-ignore lint/suspicious/noExplicitAny: Need any for variance
type ModelData<M> = M extends abstract new (...args: any[]) => { readonly [MODEL_DATA]: infer T }
  ? T
  : never;


// ============================================================================
// Symbols
// ============================================================================

/** Symbol to mark a field definition */
export const FIELD_DEF = Symbol('models:fieldDef');

// ============================================================================
// Field Types
// ============================================================================

/** All supported field types */
export type FieldType =
  | 'string'
  | 'text'
  | 'int'
  | 'smallint'
  | 'bigint'
  | 'decimal'
  | 'float'
  | 'double'
  | 'boolean'
  | 'uuid'
  | 'timestamp'
  | 'date'
  | 'time'
  | 'duration'
  | 'json'
  | 'jsonb'
  | 'bytes'
  | 'array'
  | 'enum'
  | 'object'
  | 'ref'
  | 'refs'
  | 'createdAt'
  | 'updatedAt'
  | 'deletedAt'
  | 'stream'
  | 'version';

/** Base field definition */
export interface FieldDef<T = unknown> {
  readonly [FIELD_DEF]: true;
  readonly type: FieldType;
  readonly tsType: T;
  readonly optional: boolean;
  readonly defaultValue?: T | (() => T);
  /** Value for existing rows when adding column to existing table (migrations only) */
  readonly backfillValue?: T;
  readonly unique: boolean;
  readonly indexed: boolean;
  readonly primaryKey: boolean;
  readonly maxLength?: number;
  readonly fixedLength?: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly enumName?: string;
  readonly enumValues?: readonly string[];
  readonly arrayOf?: FieldDef;
  readonly objectShape?: Record<string, FieldDef>;
  readonly refTarget?: () => unknown; // Lazy to handle circular refs
  readonly streamTarget?: () => unknown; // Lazy target for stream fields
  readonly streamProtected?: boolean; // Protected mode requires Lock<T> to publish
}

// ============================================================================
// Field Builder Base
// ============================================================================

/**
 * Wrapper type marking a field as having a default value.
 * InferModelType maps HasDefault<T> → T for the model data type,
 * but InferDefaultKeys extracts which field names have defaults.
 * InsertData uses this to make those fields optional.
 */
export interface HasDefault<out T> {
  /** @internal type-level only -- extracts the base type */
  readonly __hasDefault: T;
}

/**
 * Nominal type for decimal values. Stored as a string for precision, but
 * branded so the query-expression type mapping can route decimal fields to
 * `DecimalFieldExpr` instead of the generic `StringFieldExpr` - giving them
 * the numeric comparators (`.gt / .gte / .lt / .lte / .between`) while keeping
 * the runtime value a plain string. Input sites (`InsertData` / `UpdateData`
 * / `DeepPartial`) strip the brand so user code can pass ordinary string
 * literals like `'9.99'`.
 */
declare const DECIMAL_BRAND: unique symbol;
export type Decimal = string & { readonly [DECIMAL_BRAND]: 'decimal' };

/**
 * Strip internal brands from `T` so user-facing values (defaults, backfills,
 * insert/update payloads) can be plain primitives.
 * - Removes the `HasDefault<U>` wrapper.
 * - Widens `Decimal` (branded string) back to `string`.
 */
type Unbrand<T> = T extends HasDefault<infer U>
  ? Unbrand<U>
  : [T] extends [Decimal]
    ? string
    : T extends undefined
      ? T
      : T;

/** Base interface for all field builders */
interface FieldBuilderBase<T, Self> {
  /** Make field optional (undefined when not set) */
  optional(): FieldBuilder<T | undefined>;
  /** Set default value - makes field optional on insert */
  default(value: Unbrand<T> | (() => Unbrand<T>)): FieldBuilder<HasDefault<Unbrand<T>>>;
  /**
   * Set backfill value for existing rows when adding column via migration.
   * Required for non-nullable fields without defaults on existing tables.
   *
   * Accepts the base type regardless of whether `.default()` has already been
   * applied - chain order is commutative.
   *
   * @example
   * ```typescript
   * // In migration - existing users get 'Unknown' for name
   * table.addColumn('name', field.string().backfill('Unknown'))
   * ```
   */
  backfill(value: Unbrand<T>): Self;
  /** Add unique constraint */
  unique(): Self;
  /** Add index */
  index(): Self;
  /** Mark as primary key */
  primaryKey(): Self;
  /** Get the field definition */
  build(): FieldDef<T>;
}

/** Field builder with modifiers */
export interface FieldBuilder<T> extends FieldBuilderBase<T, FieldBuilder<T>> {
  readonly _type: T;
}

/** String field builder with max/fixed */
export interface StringFieldBuilder<T extends string | undefined = string>
  extends FieldBuilderBase<T, StringFieldBuilder<T>> {
  readonly _type: T;
  /** Set maximum length (VARCHAR) */
  max(length: number): StringFieldBuilder<T>;
  /** Set fixed length (CHAR) */
  fixed(length: number): StringFieldBuilder<T>;
  /** Make field optional */
  optional(): StringFieldBuilder<T | undefined>;
  /** Set backfill value for migrations (base-typed; accepted pre- or post-`.default()`) */
  backfill(value: Unbrand<T>): StringFieldBuilder<T>;
}

/** Decimal field builder */
export interface DecimalFieldBuilder<T extends Decimal | undefined = Decimal>
  extends FieldBuilderBase<T, DecimalFieldBuilder<T>> {
  readonly _type: T;
  /** Make field optional */
  optional(): DecimalFieldBuilder<T | undefined>;
}

/** Array field builder */
export interface ArrayFieldBuilder<T>
  extends FieldBuilderBase<T[], ArrayFieldBuilder<T>> {
  readonly _type: T[];
}

/** Object field builder */
export interface ObjectFieldBuilder<T extends Record<string, unknown>>
  extends FieldBuilderBase<T, ObjectFieldBuilder<T>> {
  readonly _type: T;
}

/** Reference field builder */
export interface RefFieldBuilder<T>
  extends FieldBuilderBase<T, RefFieldBuilder<T>> {
  readonly _type: T;
}

/** References field builder */
export interface RefsFieldBuilder<T>
  extends FieldBuilderBase<T[], RefsFieldBuilder<T>> {
  readonly _type: T[];
}

/** Stream field builder - always has a default (created by adapter) */
export interface StreamFieldBuilder<T>
  extends FieldBuilderBase<HasDefault<Stream<T>>, StreamFieldBuilder<T>> {
  readonly _type: HasDefault<Stream<T>>;
  /**
   * Mark stream as protected - requires Lock<T> to publish.
   *
   * @example
   * ```typescript
   * class Order extends defineModel({
   *   statusChanges: field.stream(StatusEvent).protected(),
   * }) {}
   *
   * // Only locked entities can publish to protected streams
   * using order = await lockService.acquire(orderRepo.get(ref))
   * order.statusChanges.publish({ status: 'shipped' })
   * ```
   */
  protected(): StreamFieldBuilder<T>;
  /** @deprecated Stream fields cannot be optional - they are always created by the repository. */
  optional(): never;
}

// ============================================================================
// Field Builder Implementation
// ============================================================================

/** Make all properties of T mutable */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Internal mutable field definition for builder */
type MutableFieldDef<T> = Mutable<Omit<FieldDef<T>, typeof FIELD_DEF | 'tsType'>>;

class FieldBuilderImpl<T> implements FieldBuilder<T> {
  readonly _type!: T;
  protected def: MutableFieldDef<T>;

  constructor(type: FieldType, extra: Partial<FieldDef<T>> = {}) {
    this.def = {
      type,
      optional: false,
      unique: false,
      indexed: false,
      primaryKey: false,
      ...extra,
    };
  }

  optional(): FieldBuilder<T | undefined> {
    // Use `this.constructor` so subclasses (StringFieldBuilderImpl,
    // DecimalFieldBuilderImpl, StreamFieldBuilderImpl, ...) get an instance
    // of the correct subclass back - preserves subclass-specific methods
    // like `.max()` / `.fixed()` / `.protected()` after `.optional()`.
    const Ctor = this.constructor as new (
      type: FieldType,
      extra: Partial<FieldDef<T | undefined>>,
    ) => FieldBuilderImpl<T | undefined>;
    return new Ctor(this.def.type, {
      ...this.def,
      optional: true,
    } as Partial<FieldDef<T | undefined>>);
  }

  default(value: Unbrand<T> | (() => Unbrand<T>)): FieldBuilder<HasDefault<Unbrand<T>>> {
    this.def.defaultValue = value as unknown as T | (() => T);
    return this as unknown as FieldBuilder<HasDefault<Unbrand<T>>>;
  }

  backfill(value: Unbrand<T>): FieldBuilder<T> {
    this.def.backfillValue = value as unknown as T;
    return this;
  }

  unique(): FieldBuilder<T> {
    this.def.unique = true;
    return this;
  }

  index(): FieldBuilder<T> {
    this.def.indexed = true;
    return this;
  }

  primaryKey(): FieldBuilder<T> {
    this.def.primaryKey = true;
    return this;
  }

  build(): FieldDef<T> {
    return {
      [FIELD_DEF]: true,
      tsType: undefined as T,
      ...this.def,
    } as FieldDef<T>;
  }
}

class StringFieldBuilderImpl<T extends string | undefined = string>
  extends FieldBuilderImpl<T>
  implements StringFieldBuilder<T>
{
  max(length: number): StringFieldBuilder<T> {
    this.def.maxLength = length;
    return this;
  }

  fixed(length: number): StringFieldBuilder<T> {
    this.def.fixedLength = length;
    return this;
  }

  optional(): StringFieldBuilder<T | undefined> {
    return super.optional() as unknown as StringFieldBuilder<T | undefined>;
  }

  default(value: Unbrand<T> | (() => Unbrand<T>)): FieldBuilder<HasDefault<Unbrand<T>>> {
    return super.default(value);
  }

  backfill(value: Unbrand<T>): StringFieldBuilder<T> {
    return super.backfill(value) as unknown as StringFieldBuilder<T>;
  }

  unique(): StringFieldBuilder<T> {
    return super.unique() as unknown as StringFieldBuilder<T>;
  }

  index(): StringFieldBuilder<T> {
    return super.index() as unknown as StringFieldBuilder<T>;
  }

  primaryKey(): StringFieldBuilder<T> {
    return super.primaryKey() as unknown as StringFieldBuilder<T>;
  }
}

class DecimalFieldBuilderImpl<T extends Decimal | undefined = Decimal>
  extends FieldBuilderImpl<T>
  implements DecimalFieldBuilder<T>
{
  optional(): DecimalFieldBuilder<T | undefined> {
    return super.optional() as unknown as DecimalFieldBuilder<T | undefined>;
  }
}

class StreamFieldBuilderImpl<T>
  extends FieldBuilderImpl<Stream<T>>
{
  protected() {
    this.def.streamProtected = true;
    return this;
  }

  optional(): never {
    throw new Error('Stream fields cannot be optional - they are always created by the repository');
  }
}

// ============================================================================
// Field Factory
// ============================================================================

/**
 * Field builder factory.
 *
 * @example
 * ```typescript
 * class User extends defineModel({
 *   email: field.string().max(255).unique(),
 *   age: field.int().optional(),
 *   balance: field.decimal(10, 2),
 *   active: field.boolean().default(true),
 * }) {}
 * ```
 */
export const field = {
  // ─── STRINGS ───
  string: (): StringFieldBuilder => new StringFieldBuilderImpl('string'),
  text: (): FieldBuilder<string> => new FieldBuilderImpl('text'),

  // ─── NUMBERS ───
  int: (): FieldBuilder<number> => new FieldBuilderImpl('int'),
  smallint: (): FieldBuilder<number> => new FieldBuilderImpl('smallint'),
  bigint: (): FieldBuilder<bigint> => new FieldBuilderImpl('bigint'),
  decimal: (precision: number, scale: number): DecimalFieldBuilder =>
    new DecimalFieldBuilderImpl<Decimal>('decimal', { precision, scale }),
  float: (): FieldBuilder<number> => new FieldBuilderImpl('float'),
  double: (): FieldBuilder<number> => new FieldBuilderImpl('double'),

  // ─── BOOLEAN ───
  boolean: (): FieldBuilder<boolean> => new FieldBuilderImpl('boolean'),

  // ─── UUID ───
  uuid: (): FieldBuilder<string> => new FieldBuilderImpl('uuid'),

  // ─── DATE/TIME ───
  timestamp: (): FieldBuilder<Date> => new FieldBuilderImpl('timestamp'),
  date: (): FieldBuilder<Date> => new FieldBuilderImpl('date'),
  time: (): FieldBuilder<string> => new FieldBuilderImpl('time'),
  duration: (): FieldBuilder<string> => new FieldBuilderImpl('duration'),

  // ─── SEMANTIC TIME FIELDS ───
  createdAt: (): FieldBuilder<HasDefault<Date>> => new FieldBuilderImpl<HasDefault<Date>>('createdAt'),
  updatedAt: (): FieldBuilder<HasDefault<Date>> => new FieldBuilderImpl<HasDefault<Date>>('updatedAt'),
  deletedAt: (): FieldBuilder<Date | undefined> =>
    new FieldBuilderImpl<Date | undefined>('deletedAt', { optional: true }),

  // ─── VERSIONING ───
  version: (): FieldBuilder<number> =>
    new FieldBuilderImpl('version', { defaultValue: 1 }),

  // ─── JSON ───
  /**
   * JSON field. The type parameter `T` is a **compile-time hint only** -
   * no runtime validation is performed. Data read from the database is
   * returned as-is (parsed JSON). If you need guarantees that the value
   * conforms to `T`, validate it yourself after reading (e.g. with Zod).
   *
   * @example
   * ```typescript
   * interface Settings { theme: string; fontSize: number }
   *
   * class User extends defineModel({
   *   settings: field.json<Settings>(),
   * }) {}
   * ```
   */
  json: <T = unknown>(): FieldBuilder<T> => new FieldBuilderImpl<T>('json'),
  /**
   * JSONB field (binary JSON, Postgres). The type parameter `T` is a
   * **compile-time hint only** - no runtime validation is performed.
   * Data read from the database is returned as-is (parsed JSONB).
   * If you need guarantees that the value conforms to `T`, validate it
   * yourself after reading (e.g. with Zod).
   *
   * @example
   * ```typescript
   * interface Metadata { tags: string[]; score: number }
   *
   * class Post extends defineModel({
   *   metadata: field.jsonb<Metadata>(),
   * }) {}
   * ```
   */
  jsonb: <T = unknown>(): FieldBuilder<T> => new FieldBuilderImpl<T>('jsonb'),

  // ─── BINARY ───
  bytes: (): FieldBuilder<Uint8Array> => new FieldBuilderImpl('bytes'),

  // ─── ARRAYS ───
  array: <T>(elementType: FieldBuilder<T>): FieldBuilder<T[]> =>
    new FieldBuilderImpl<T[]>('array', {
      arrayOf: elementType.build(),
    }),

  // ─── ENUMS ───
  enum: <const T extends readonly string[]>(
    name: string,
    values: T,
  ): FieldBuilder<T[number]> =>
    new FieldBuilderImpl<T[number]>('enum', {
      enumName: name,
      enumValues: values,
    }),

  // ─── NESTED OBJECTS ───
  object: <T extends Record<string, FieldBuilder<unknown>>>(
    shape: T,
  ): FieldBuilder<{ [K in keyof T]: T[K]['_type'] }> => {
    const objectShape: Record<string, FieldDef> = {};
    for (const [key, builder] of Object.entries(shape)) {
      objectShape[key] = builder.build();
    }
    return new FieldBuilderImpl<{ [K in keyof T]: T[K]['_type'] }>('object', {
      objectShape,
    });
  },

  // ─── REFERENCES ───
  /**
   * Reference to another model (many-to-one / one-to-one).
   * Use a function for self-references to avoid hoisting issues.
   *
   * @example
   * ```typescript
   * const Post = defineModel('Post', {
   *   author: field.ref(User),           // Reference<typeof User>
   *   parent: field.ref(() => Post),     // Self-reference
   * });
   * ```
   */
  ref: <T extends abstract new (...args: never) => unknown>(
    target: T | (() => T),
  ): FieldBuilder<Reference<InstanceType<T>>> =>
    // `Reference<InstanceType<T>>` - not `Reference<ModelData<T>>` - so
    // awaiting yields `Persistent<User>` (nominal class type) rather
    // than `Persistent<{ …expanded fields }>`. Keeps the class brand
    // through the ref/persistent chain so error messages stay clean.
    new FieldBuilderImpl<Reference<InstanceType<T>>>('ref', {
      refTarget: isLazyTarget(target) ? (target as () => T) : () => target,
    }),

  /**
   * Reference to multiple models (many-to-many).
   *
   * @example
   * ```typescript
   * const Post = defineModel('Post', {
   *   tags: field.refs(Tag),            // References<typeof Tag>
   * });
   * ```
   */
  refs: <T extends abstract new (...args: never) => unknown>(
    target: T | (() => T),
  ): FieldBuilder<References<InstanceType<T>>> =>
    new FieldBuilderImpl<References<InstanceType<T>>>('refs', {
      refTarget: isLazyTarget(target) ? (target as () => T) : () => target,
    }),

  // ─── STREAMS ───
  /**
   * Stream field for pub/sub messaging on a model.
   * Use a function for self-references to avoid hoisting issues.
   *
   * Streams are AsyncIterable<T> for subscription and have publish() for broadcasting.
   *
   * @example
   * ```typescript
   * class Room extends defineModel({
   *   name: field.string(),
   *   messages: field.stream(ChatMessage),
   * }) {}
   *
   * // Subscribe to messages
   * for await (const msg of room.messages) {
   *   console.log(msg.text)
   * }
   *
   * // Publish a message
   * room.messages.publish({ user: userRef, text: 'hello' })
   * ```
   *
   * @example Protected stream (requires Lock to publish)
   * ```typescript
   * class Order extends defineModel({
   *   statusChanges: field.stream(StatusEvent).protected(),
   * }) {}
   *
   * // Protected streams require entity to be locked
   * using order = await lockService.acquire(orderRepo.get(ref))
   * order.statusChanges.publish({ status: 'shipped' })
   * ```
   */
  stream: <T extends abstract new (...args: never) => unknown>(
    target: T | (() => T),
  ): StreamFieldBuilder<ModelData<T>> =>
    new StreamFieldBuilderImpl<ModelData<T>>('stream', {
      streamTarget: isLazyTarget(target) ? (target as () => T) : () => target,
      streamProtected: false,
    }) as unknown as StreamFieldBuilder<ModelData<T>>,
};

/**
 * Check if target is a lazy callback (arrow function for self-reference)
 * vs a ModelClass (which is also a function but shouldn't be called directly).
 *
 * ModelClasses have a prototype with constructor, plain arrow functions don't.
 */
function isLazyTarget(target: unknown): boolean {
  if (typeof target !== 'function') return false;
  // ModelClass has a prototype object with a constructor
  // Arrow functions () => Model have Object.prototype or no meaningful prototype
  const proto = (target as { prototype?: unknown }).prototype;
  return proto === undefined || proto === Object.prototype;
}

// ============================================================================
// Type Utilities
// ============================================================================

/** Extract TypeScript type from field builder */
export type InferField<F> = F extends FieldBuilder<infer T> ? T : never;

/** Extract TypeScript type from field definition */
export type InferFieldDef<F> = F extends FieldDef<infer T> ? T : never;

/** Check if value is a field definition */
export function isFieldDef(value: unknown): value is FieldDef {
  return (
    value !== null &&
    typeof value === 'object' &&
    FIELD_DEF in value &&
    (value as Record<symbol, unknown>)[FIELD_DEF] === true
  );
}
