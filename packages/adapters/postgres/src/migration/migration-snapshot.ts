/**
 * Migration Snapshots
 *
 * Type-safe snapshots of model schemas for use in migrations and seeders.
 * Snapshots freeze the field definitions at migration time, ensuring
 * migrations continue to work even as models evolve.
 *
 * @example
 * ```typescript
 * import { defineMigration, defineSnapshot } from '@justscale/postgres'
 * import { field } from '@justscale/core/models'
 *
 * // Snapshot: User schema at this migration point
 * const User = defineSnapshot('users', {
 *   email: field.string().max(255),
 *   name: field.string().max(100),
 *   status: field.enum('UserStatus', ['active', 'inactive', 'banned'] as const),
 * })
 *
 * export default defineMigration({
 *   async up({ repo }) {
 *     const users = repo(User)
 *
 *     if (await users.exists(User.fields.email.eq('admin@example.com'))) {
 *       return
 *     }
 *
 *     await users.create({
 *       email: 'admin@example.com',
 *       name: 'Admin User',
 *       status: 'active',
 *     })
 *   },
 *
 *   async down({ repo }) {
 *     const users = repo(User)
 *     await users.delete(User.fields.email.eq('admin@example.com'))
 *   },
 * })
 * ```
 */

import {
  type ArrayFieldExpr,
  type BigIntFieldExpr,
  type BooleanFieldExpr,
  type Condition,
  FIELD_DEF,
  type FieldBuilder,
  type FieldDef,
  type FieldDefs,
  type InferModelType,
  type JsonFieldExpr,
  type NumberFieldExpr,
  type RefFieldExpr,
  type Reference,
  type References,
  type RefsFieldExpr,
  type StringFieldExpr,
  type TimestampFieldExpr,
  createFieldExpr,
} from '@justscale/core/models';


export const SNAPSHOT_DEF = Symbol('postgres:snapshotDef');
export const SNAPSHOT_TABLE = Symbol('postgres:snapshotTable');
export const SNAPSHOT_FIELDS = Symbol('postgres:snapshotFields');


/** Map value type to appropriate field expression type */
type ValueToFieldExpr<T> = T extends Reference<infer R>
  ? RefFieldExpr<R>
  : T extends References<infer R>
    ? RefsFieldExpr<R>
    : T extends string | undefined
      ? StringFieldExpr
      : T extends number | undefined
        ? NumberFieldExpr
        : T extends bigint | undefined
          ? BigIntFieldExpr
          : T extends boolean | undefined
            ? BooleanFieldExpr
            : T extends Date | undefined
              ? TimestampFieldExpr
              : T extends (infer E)[]
                ? ArrayFieldExpr<E>
                : JsonFieldExpr;

/** Field expressions for a data type */
type FieldExprsFromData<T> = {
  readonly [K in keyof T]: ValueToFieldExpr<T[K]>
};

/**
 * A model snapshot for use in migrations.
 *
 * Provides type-safe field expressions and data types frozen
 * at the time the migration was created.
 */
export interface Snapshot<T, _F extends FieldDefs = FieldDefs> {
  readonly [SNAPSHOT_DEF]: true
  readonly [SNAPSHOT_TABLE]: string
  readonly [SNAPSHOT_FIELDS]: Record<string, FieldDef>

  /** Table name */
  readonly table: string

  /** Field expressions for queries */
  readonly fields: FieldExprsFromData<T>

  /** Type brand for inference */
  readonly _type: T
}

/**
 * Repository interface for snapshot operations in migrations.
 *
 * Provides CRUD operations using the snapshot's field types.
 */
export interface SnapshotRepository<T> {
  /**
   * Create a new record.
   *
   * @example
   * ```typescript
   * await users.create({
   *   email: 'admin@example.com',
   *   name: 'Admin User',
   * })
   * ```
   */
  create(data: T): Promise<T & { id: string }>

  /**
   * Create multiple records.
   *
   * @example
   * ```typescript
   * await users.createMany([
   *   { email: 'user1@example.com', name: 'User 1' },
   *   { email: 'user2@example.com', name: 'User 2' },
   * ])
   * ```
   */
  createMany(data: T[]): Promise<Array<T & { id: string }>>

  /**
   * Update records matching a condition.
   *
   * @returns Number of rows updated
   *
   * @example
   * ```typescript
   * await users.update(
   *   User.fields.status.eq('inactive'),
   *   { status: 'banned' }
   * )
   * ```
   */
  update(where: Condition, data: Partial<T>): Promise<number>

  /**
   * Delete records matching a condition.
   *
   * @returns Number of rows deleted
   *
   * @example
   * ```typescript
   * await users.delete(User.fields.email.eq('admin@example.com'))
   * ```
   */
  delete(where: Condition): Promise<number>

  /**
   * Check if a record exists.
   *
   * @example
   * ```typescript
   * if (await users.exists(User.fields.email.eq('admin@example.com'))) {
   *   return // Already seeded
   * }
   * ```
   */
  exists(where: Condition): Promise<boolean>

  /**
   * Find records matching a condition.
   *
   * @example
   * ```typescript
   * const admins = await users.find(User.fields.role.eq('admin'))
   * ```
   */
  find(where?: Condition): Promise<Array<T & { id: string }>>

  /**
   * Find a single record.
   *
   * @example
   * ```typescript
   * const admin = await users.findOne(User.fields.email.eq('admin@example.com'))
   * ```
   */
  findOne(where: Condition): Promise<(T & { id: string }) | null>
}


/**
 * Define a model snapshot for use in migrations.
 *
 * Snapshots freeze the field definitions at migration time,
 * ensuring migrations continue to work even as models evolve.
 *
 * @example
 * ```typescript
 * import { defineSnapshot } from '@justscale/postgres'
 * import { field } from '@justscale/core/models'
 *
 * const User = defineSnapshot('users', {
 *   email: field.string().max(255),
 *   name: field.string().max(100),
 *   status: field.enum('UserStatus', ['active', 'inactive', 'banned'] as const),
 * })
 *
 * // User.table -> 'users'
 * // User.fields.email.eq('...') -> query expression
 * // Type: { email: string, name: string, status: 'active' | 'inactive' | 'banned' }
 * ```
 */
export function defineSnapshot<const F extends FieldDefs>(
  table: string,
  fields: F,
): Snapshot<InferModelType<F>, F> {
  type T = InferModelType<F>;

  // Build field definitions
  const builtFields: Record<string, FieldDef> = {};
  for (const [key, fieldOrBuilder] of Object.entries(fields)) {
    if (FIELD_DEF in fieldOrBuilder) {
      builtFields[key] = fieldOrBuilder as FieldDef;
    } else if (
      'build' in fieldOrBuilder &&
      typeof fieldOrBuilder.build === 'function'
    ) {
      builtFields[key] = (fieldOrBuilder as FieldBuilder<unknown>).build();
    } else {
      throw new Error(
        `Invalid field definition for "${key}" in snapshot "${table}"`,
      );
    }
  }

  // Create field expressions
  const fieldExprs: FieldExprsFromData<T> = {} as FieldExprsFromData<T>;
  for (const [key, fieldDef] of Object.entries(builtFields)) {
    ;(fieldExprs as Record<string, unknown>)[key] = createFieldExpr(
      key,
      fieldDef,
    );
  }

  return {
    [SNAPSHOT_DEF]: true,
    [SNAPSHOT_TABLE]: table,
    [SNAPSHOT_FIELDS]: builtFields,
    table,
    fields: fieldExprs,
    _type: undefined as unknown as T,
  };
}


/**
 * Check if a value is a snapshot definition.
 */
export function isSnapshot(value: unknown): value is Snapshot<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    SNAPSHOT_DEF in value &&
    (value as Record<symbol, unknown>)[SNAPSHOT_DEF] === true
  );
}
