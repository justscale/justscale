/**
 * PostgreSQL Migration Schema
 *
 * Database interface for writing migrations.
 * Uses field builders from @justscale/core/models.
 *
 * @example
 * ```typescript
 * import { defineMigration } from '@justscale/postgres';
 * import { field } from '@justscale/core/models';
 *
 * export default defineMigration({
 *   async up(db) {
 *     await db.createTable('users', {
 *       id: field.uuid().primaryKey(),
 *       email: field.string().max(255).unique(),
 *       name: field.string().max(100).optional(),
 *       balance: field.decimal(10, 2),
 *       createdAt: field.createdAt(),
 *       updatedAt: field.updatedAt(),
 *     });
 *
 *     await db.createIndex('users', ['email']);
 *   },
 *
 *   async down(db) {
 *     await db.dropTable('users');
 *   },
 * });
 * ```
 */

import type { FieldBuilder, FieldDefs } from '@justscale/core/models';
import type { Snapshot, SnapshotRepository } from './migration-snapshot.js';


/** Table columns using field builders */
export type TableColumns = Record<string, FieldBuilder<unknown>>;

/** FK referential actions */
export type ReferentialAction =
  | 'CASCADE'
  | 'SET NULL'
  | 'SET DEFAULT'
  | 'RESTRICT'
  | 'NO ACTION';

/** Index options */
export interface IndexOptions {
  name?: string
  unique?: boolean
  using?: 'btree' | 'hash' | 'gin' | 'gist' | 'spgist' | 'brin'
  where?: string
  concurrently?: boolean
}

/** Foreign key options */
export interface ForeignKeyOptions {
  name?: string
  onDelete?: ReferentialAction
  onUpdate?: ReferentialAction
}

/** Table alteration builder (for alterTable callbacks) */
export interface TableAlterationBuilder {
  /** Add a column */
  addColumn(name: string, column: FieldBuilder<unknown>): void
  /** Drop a column */
  dropColumn(name: string): void
  /** Rename a column */
  renameColumn(from: string, to: string): void
  /** Alter column type */
  alterType(name: string, newType: string): void
  /** Set column nullable */
  setNullable(name: string): void
  /** Set column NOT NULL */
  setNotNull(name: string): void
  /** Set default value */
  setDefault(name: string, value: string): void
  /** Drop default */
  dropDefault(name: string): void
  /** Add constraint */
  addConstraint(name: string, expression: string): void
  /** Drop constraint */
  dropConstraint(name: string): void
}


/**
 * Database interface for migrations.
 * Provides DDL operations for PostgreSQL.
 */
export interface Database {
  // --- TABLE OPERATIONS ---

  /** Create a new table */
  createTable(name: string, columns: TableColumns): Promise<void>

  /** Drop a table */
  dropTable(name: string): Promise<void>

  /** Drop table if exists */
  dropTableIfExists(name: string): Promise<void>

  /** Rename a table */
  renameTable(from: string, to: string): Promise<void>

  /** Check if table exists */
  hasTable(name: string): Promise<boolean>

  /** Alter a table */
  alterTable(
    name: string,
    callback: (table: TableAlterationBuilder) => void,
  ): Promise<void>

  // --- INDEX OPERATIONS ---

  /** Create an index */
  createIndex(
    table: string,
    columns: string | string[],
    options?: IndexOptions,
  ): Promise<void>

  /** Drop an index */
  dropIndex(name: string): Promise<void>

  /** Drop index if exists */
  dropIndexIfExists(name: string): Promise<void>

  // --- CONSTRAINT OPERATIONS ---

  /** Add a foreign key */
  addForeignKey(
    table: string,
    column: string,
    references: { table: string; column?: string },
    options?: ForeignKeyOptions,
  ): Promise<void>

  /** Drop a foreign key */
  dropForeignKey(table: string, name: string): Promise<void>

  /** Add a unique constraint */
  addUnique(
    table: string,
    columns: string | string[],
    name?: string,
  ): Promise<void>

  /** Drop a unique constraint */
  dropUnique(table: string, name: string): Promise<void>

  /** Add a check constraint */
  addCheck(table: string, name: string, expression: string): Promise<void>

  /** Drop a check constraint */
  dropCheck(table: string, name: string): Promise<void>

  // --- TYPE OPERATIONS ---

  /** Create an enum type */
  createType(name: string, values: string[]): Promise<void>

  /** Add value to enum */
  addTypeValue(
    name: string,
    value: string,
    options?: { after?: string; before?: string },
  ): Promise<void>

  /** Drop a type */
  dropType(name: string): Promise<void>

  /** Drop type if exists */
  dropTypeIfExists(name: string): Promise<void>

  // --- RAW SQL ---

  /** Execute raw SQL */
  raw(sql: string): Promise<void>

  /** Execute raw SQL and return results */
  query<T = unknown>(sql: string): Promise<T[]>

  // --- DATA OPERATIONS (for seeder migrations) ---

  /**
   * Insert a record into a table.
   * @returns The inserted record with generated fields (id, timestamps)
   *
   * @example
   * ```typescript
   * await db.insert('users', {
   *   email: 'admin@example.com',
   *   name: 'Admin User',
   * });
   * ```
   */
  insert<T extends Record<string, unknown>>(
    table: string,
    data: T,
  ): Promise<T & { id: string }>

  /**
   * Insert multiple records.
   *
   * @example
   * ```typescript
   * await db.insertMany('users', [
   *   { email: 'user1@example.com', name: 'User 1' },
   *   { email: 'user2@example.com', name: 'User 2' },
   * ]);
   * ```
   */
  insertMany<T extends Record<string, unknown>>(
    table: string,
    data: T[],
  ): Promise<Array<T & { id: string }>>

  /**
   * Update records matching a condition.
   * @returns Number of rows updated
   *
   * @example
   * ```typescript
   * await db.update('users', { name: 'Updated Name' }, { email: 'admin@example.com' });
   * ```
   */
  update(
    table: string,
    data: Record<string, unknown>,
    where: Record<string, unknown>,
  ): Promise<number>

  /**
   * Delete records matching a condition.
   * @returns Number of rows deleted
   *
   * @example
   * ```typescript
   * await db.delete('users', { email: 'admin@example.com' });
   * ```
   */
  delete(table: string, where: Record<string, unknown>): Promise<number>

  /**
   * Check if a record exists.
   *
   * @example
   * ```typescript
   * const exists = await db.exists('users', { email: 'admin@example.com' });
   * if (!exists) {
   *   await db.insert('users', { ... });
   * }
   * ```
   */
  exists(table: string, where: Record<string, unknown>): Promise<boolean>

  /**
   * Find records matching a condition.
   *
   * @example
   * ```typescript
   * const admins = await db.find('users', { role: 'admin' });
   * ```
   */
  find<T = Record<string, unknown>>(
    table: string,
    where?: Record<string, unknown>,
  ): Promise<T[]>

  /**
   * Find a single record.
   *
   * @example
   * ```typescript
   * const user = await db.findOne('users', { email: 'admin@example.com' });
   * ```
   */
  findOne<T = Record<string, unknown>>(
    table: string,
    where: Record<string, unknown>,
  ): Promise<T | null>
}


/**
 * Context provided to migration up/down functions.
 *
 * Includes both the raw database interface for DDL operations
 * and the repo() function for type-safe data operations.
 */
export interface MigrationContext {
  /**
   * Raw database interface for DDL and untyped DML operations.
   *
   * @example
   * ```typescript
   * await db.createTable('users', { ... })
   * await db.insert('users', { ... })
   * ```
   */
  db: Database

  /**
   * Get a type-safe repository for a snapshot.
   *
   * Use this for seeder migrations to get compile-time type safety
   * on all data operations.
   *
   * @example
   * ```typescript
   * const User = defineSnapshot('users', {
   *   email: field.string().max(255),
   *   name: field.string().max(100),
   * })
   *
   * export default defineMigration({
   *   async up({ repo }) {
   *     const users = repo(User)
   *
   *     await users.create({
   *       email: 'admin@example.com',
   *       name: 'Admin User',
   *     })
   *   },
   * })
   * ```
   */
  repo<T, F extends FieldDefs>(snapshot: Snapshot<T, F>): SnapshotRepository<T>
}


/**
 * Migration definition. The `name` doubles as the unique identity used
 * to track applied state in the `_migrations` table. Convention:
 * `YYYY_MM_DD_HHMMSS_<slug>` (written by `just migrate make`), but any
 * stable string works as long as it sorts correctly - `MigrationRunner`
 * relies on lexicographic ordering of `name` to derive run order.
 */
export interface MigrationDef {
  /** Unique identifier; doubles as the order key. */
  name: string
  /** Apply the migration. */
  up(ctx: MigrationContext): Promise<void>
  /** Revert the migration. */
  down(ctx: MigrationContext): Promise<void>
}

/**
 * Module-level registry populated as a side effect of `defineMigration`.
 * The app's entry file is expected to `import` each migration (typically
 * via a generated `migrations/index.ts` barrel) - at that point every
 * `defineMigration(...)` call runs and lands here.
 *
 * `MigrationRunner` reads this list at runtime: no directory, no
 * `readdir`, no dynamic `import`. Works identically in dev (tsx on .ts),
 * compiled prod (.js), and bundled prod (esbuild/rollup) - the bundler
 * just follows the import graph that already includes the migrations.
 */
const registered: MigrationDef[] = [];

/**
 * Define and register a PostgreSQL migration.
 *
 * Side effect: appends to the module-level registry. Returning `def`
 * preserves the existing `export default defineMigration({...})` call
 * shape so downstream code that still imports the default doesn't break.
 *
 * @example
 * ```typescript
 * import { defineMigration } from '@justscale/postgres';
 *
 * export default defineMigration({
 *   name: '2026_04_21_115845_init',
 *   async up({ db }) { ... },
 *   async down({ db }) { ... },
 * });
 * ```
 */
export function defineMigration(def: MigrationDef): MigrationDef {
  registered.push(def);
  return def;
}

/**
 * Snapshot of every migration registered so far. Returned in definition
 * order (which is import order - always a stable lexicographic sort if
 * the barrel is written in timestamp order, which `just migrate make`
 * guarantees).
 */
export function getRegisteredMigrations(): readonly MigrationDef[] {
  return registered;
}

/** Clear the registry. Test-only - production code must not call this. */
export function clearRegisteredMigrations(): void {
  registered.length = 0;
}


/**
 * Generate a timestamped migration filename.
 *
 * @example
 * ```typescript
 * migrationName('create_users_table')
 * // => '2024_01_15_143022_create_users_table'
 * ```
 */
export function migrationName(name: string): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  // Format: YYYY_MM_DD_HHMMSS_name (time portion has no underscores)
  return `${year}_${month}_${day}_${hours}${minutes}${seconds}_${name}`;
}

/**
 * Parse a migration filename.
 */
export function parseMigrationName(
  filename: string,
): { timestamp: string; name: string } | null {
  const match = filename.match(/^(\d{4}_\d{2}_\d{2}_\d{6})_(.+)$/);
  if (!match) return null;
  return { timestamp: match[1], name: match[2] };
}
