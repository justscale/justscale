/**
 * PostgreSQL Migration Runner
 *
 * Applies migrations registered via `defineMigration()` and tracks
 * applied state in the `_migrations` table. Runtime is file-system
 * free - the app's import graph populates the registry at boot, the
 * runner just reads it.
 *
 * @example
 * ```typescript
 * import { createMigrationRunner, createPostgresLockProvider } from '@justscale/postgres';
 * import './migrations/index.js';  // side-effect: registers all migrations
 *
 * const runner = createMigrationRunner(client, {
 *   lockProvider: createPostgresLockProvider(client),
 * });
 * await runner.migrate();   // apply pending
 * await runner.rollback();  // rollback last batch
 * const status = await runner.status();
 * ```
 */

import { AbstractLockProvider, Config, defineService } from '@justscale/core';
import type { LockProvider } from '@justscale/core';
import { AbstractPostgresClient } from '../client/client.js';
import { PostgresMigrationConfig } from '../config.js';
import type { MigrationContext, MigrationDef } from './migration-schema.js';
import { getRegisteredMigrations } from './migration-schema.js';
import { createMigrationContext } from '../pg-database.js';
import { ColumnDef, CreateIndex, CreateTable } from '../sql/sql-ddl.js';


const LOCK_INSTANCE_ID = 'migration-runner';
const LOCK_TTL_MS = 10 * 60 * 1000; // 10 minutes - generous for large backfills/DDL
const LOCK_TIMEOUT_MS = 0; // block until obtained; concurrent runners serialise here


export interface MigrationRunnerOptions {
  /** Table name for tracking migrations (default: `_migrations`). */
  table?: string
  /**
   * Lock provider used to serialise concurrent runners on the same DB.
   * Required - the framework deliberately has no default. Apps must wire
   * one explicitly (`PostgresLockFeature`, `InMemoryLockProvider`, etc.).
   *
   * Accepts the `LockProvider` interface so callers can pass either a
   * resolved `AbstractLockProvider` from DI or a raw provider built via
   * `createPostgresLockProvider` / `createInMemoryLockProvider`.
   */
  lockProvider: LockProvider
}

export interface MigrationRecord {
  id: number
  name: string
  batch: number
  appliedAt: Date
}

export interface MigrationStatus {
  name: string
  applied: boolean
  batch?: number
  appliedAt?: Date
}


function createMigrationsTableDdl(tableName: string): string {
  const columns = [
    new ColumnDef('id', 'SERIAL', [{ type: 'primaryKey' }]),
    new ColumnDef('name', 'VARCHAR(255)', [
      { type: 'notNull' },
      { type: 'unique' },
    ]),
    new ColumnDef('batch', 'INTEGER', [{ type: 'notNull' }]),
    new ColumnDef('applied_at', 'TIMESTAMPTZ', [
      { type: 'notNull' },
      { type: 'default', value: 'NOW()' },
    ]),
  ];

  const createTable = new CreateTable(tableName, columns, true);
  const createIndex = new CreateIndex(tableName, ['batch'], {
    name: `idx_${tableName}_batch`,
  });

  return `${createTable.toSql()};\n${createIndex.toSql()}`;
}


export class MigrationRunner {
  private readonly client: AbstractPostgresClient;
  private readonly ctx: MigrationContext;
  private readonly tableName: string;
  private readonly lockProvider: LockProvider;
  private readonly lockKey: string;
  private initialized = false;

  constructor(client: AbstractPostgresClient, options: MigrationRunnerOptions) {
    this.client = client;
    this.ctx = createMigrationContext(client);
    this.tableName = options.table ?? '_migrations';
    this.lockProvider = options.lockProvider;
    this.lockKey = `migration:${this.tableName}`;
  }

  /**
   * Acquire the migration lock via the abstract LockProvider, run fn, then
   * release. Lock options are fully specified (no implicit defaults from
   * the LockService layer) because we call the provider directly.
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await this.lockProvider.acquire(
      this.lockKey,
      {
        key: this.lockKey,
        ttl: LOCK_TTL_MS,
        timeout: LOCK_TIMEOUT_MS,
        heartbeat: false,
        heartbeatInterval: Math.floor(LOCK_TTL_MS / 3),
      },
      LOCK_INSTANCE_ID,
    );
    try {
      return await fn();
    } finally {
      await this.lockProvider.release(this.lockKey, LOCK_INSTANCE_ID);
    }
  }

  /**
   * All migrations registered in this process, sorted by `name`.
   * `defineMigration()` side-effects into the registry - the caller is
   * responsible for having imported every migration file they want the
   * runner to see.
   */
  private getMigrations(): MigrationDef[] {
    return [...getRegisteredMigrations()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Create the migrations tracking table (idempotent).
   *
   * MUST be called while the caller already holds the migration lock (either
   * via withMigrationLock or ensureInit). The in-process `initialized` flag
   * is a fast-path that skips the DDL once the table is known to exist in
   * this runner instance.
   */
  private async init(): Promise<void> {
    if (this.initialized) return;
    await this.client.sql.unsafe(createMigrationsTableDdl(this.tableName));
    this.initialized = true;
  }

  /**
   * Ensure the migrations table exists for read-only callers (getApplied,
   * status, pending) that do not go through withMigrationLock.
   *
   * Holds the abstract migration lock so that concurrent runners on a fresh
   * DB serialise the bootstrap DDL and avoid the pg_type catalog race where
   * `CREATE TABLE IF NOT EXISTS` triggers an implicit composite-type creation
   * that fails with SQLSTATE 42710 or 23505 under concurrency. Once
   * `this.initialized` is true the lock path is bypassed entirely.
   */
  private async ensureInit(): Promise<void> {
    if (this.initialized) return;
    await this.withLock(async () => {
      // Re-check after acquiring - another runner may have just created it.
      if (!this.initialized) {
        await this.client.pool.unsafe(createMigrationsTableDdl(this.tableName));
        this.initialized = true;
      }
    });
  }

  /** All applied migrations, ordered by id. */
  async getApplied(): Promise<MigrationRecord[]> {
    await this.ensureInit();
    const rows = await this.client.sql<MigrationRecord[]>`
      SELECT id, name, batch, applied_at as "appliedAt"
      FROM ${this.client.sql(this.tableName)}
      ORDER BY id ASC
    `;
    return rows as MigrationRecord[];
  }

  private async getCurrentBatch(): Promise<number> {
    const [result] = await this.client.sql`
      SELECT COALESCE(MAX(batch), 0) as batch
      FROM ${this.client.sql(this.tableName)}
    `;
    return (result?.batch ?? 0) as number;
  }

  private async recordMigration(name: string, batch: number): Promise<void> {
    await this.client.sql`
      INSERT INTO ${this.client.sql(this.tableName)} (name, batch)
      VALUES (${name}, ${batch})
    `;
  }

  private async removeMigration(name: string): Promise<void> {
    await this.client.sql`
      DELETE FROM ${this.client.sql(this.tableName)}
      WHERE name = ${name}
    `;
  }

  /**
   * Acquire the abstract migration lock, bootstrap the tracking table if it
   * doesn't exist yet, open a transaction, run fn, then release the lock
   * after the transaction commits or rolls back.
   *
   * init() runs INSIDE the lock so that concurrent runners on a fresh DB
   * cannot race on the implicit composite-type that Postgres creates
   * alongside CREATE TABLE (SQLSTATE 42710 / 23505). The lock is held
   * across the whole transaction so the lock guards both the bootstrap DDL
   * and fn's writes.
   */
  private async withMigrationLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.withLock(async () => {
      try {
        return await this.client.transaction(async () => {
          await this.init();
          return fn();
        });
      } catch (err) {
        // If the tx rolled back, init()'s CREATE TABLE rolled back with it -
        // but the in-process `initialized` flag already flipped to true. Reset
        // it so the next read-path call (getApplied/status/pending) actually
        // re-runs the DDL via ensureInit() instead of SELECT-ing a table that
        // no longer exists.
        this.initialized = false;
        throw err;
      }
    });
  }

  /**
   * Run every pending migration (those registered but not recorded in
   * `_migrations`). Returns the names that were applied.
   */
  async migrate(): Promise<string[]> {
    const migrations = this.getMigrations();
    const registeredNames = new Set(migrations.map((m) => m.name));

    return this.withMigrationLock(async () => {
      const applied = await this.getApplied();
      // A row in `_migrations` with no matching registered file is a
      // broken deploy - the source was renamed/deleted without a proper
      // migration. Refuse loudly here just like `rollback()` does; a
      // silent skip hides the drift until a future rollback tries to
      // invert a migration whose code no longer exists.
      const orphan = applied.find((m) => !registeredNames.has(m.name));
      if (orphan) {
        throw new Error(
          `Migration '${orphan.name}' is recorded in _migrations but not registered - ` +
          'did you forget to import it from migrations/index.ts, or was its file deleted?'
        );
      }
      const appliedNames = new Set(applied.map((m) => m.name));
      const pending = migrations.filter((m) => !appliedNames.has(m.name));
      if (pending.length === 0) return [];

      const batch = (await this.getCurrentBatch()) + 1;
      const ran: string[] = [];

      for (const migration of pending) {
        await migration.up(this.ctx);
        await this.recordMigration(migration.name, batch);
        ran.push(migration.name);
      }

      return ran;
    });
  }

  /** Rollback the last batch of migrations. LIFO order. */
  async rollback(): Promise<string[]> {
    const migrations = this.getMigrations();
    const migrationByName = new Map(migrations.map((m) => [m.name, m]));

    return this.withMigrationLock(async () => {
      const currentBatch = await this.getCurrentBatch();
      if (currentBatch === 0) return [];

      const applied = await this.getApplied();
      const toRollback = applied.filter((m) => m.batch === currentBatch).reverse();
      const rolledBack: string[] = [];

      for (const record of toRollback) {
        const migration = migrationByName.get(record.name);
        if (!migration) {
          throw new Error(
            `Migration '${record.name}' is recorded in _migrations but not registered - ` +
            'did you forget to import it from migrations/index.ts?'
          );
        }
        await migration.down(this.ctx);
        await this.removeMigration(record.name);
        rolledBack.push(record.name);
      }

      return rolledBack;
    });
  }

  /** Rollback all migrations, one batch at a time. */
  async reset(): Promise<string[]> {
    const allRolledBack: string[] = [];
    while (true) {
      const rolledBack = await this.rollback();
      if (rolledBack.length === 0) break;
      allRolledBack.push(...rolledBack);
    }
    return allRolledBack;
  }

  /** Reset and re-run every migration. */
  async fresh(): Promise<string[]> {
    await this.reset();
    return this.migrate();
  }

  /** Status (applied?/batch/appliedAt) for every registered migration. */
  async status(): Promise<MigrationStatus[]> {
    await this.ensureInit();
    const migrations = this.getMigrations();
    const applied = await this.getApplied();
    const appliedMap = new Map(applied.map((m) => [m.name, m]));

    return migrations.map((m) => {
      const record = appliedMap.get(m.name);
      return {
        name: m.name,
        applied: !!record,
        batch: record?.batch,
        appliedAt: record?.appliedAt,
      };
    });
  }

  /** Names of registered migrations that haven't been applied yet. */
  async pending(): Promise<string[]> {
    await this.ensureInit();
    const migrations = this.getMigrations();
    const applied = await this.getApplied();
    const appliedNames = new Set(applied.map((m) => m.name));
    return migrations.filter((m) => !appliedNames.has(m.name)).map((m) => m.name);
  }

  /**
   * Run a specific migration by name (if not already applied).
   * Holds the abstract migration lock to prevent concurrent batch number
   * conflicts.
   */
  async run(name: string): Promise<boolean> {
    const migration = this.getMigrations().find((m) => m.name === name);
    if (!migration) {
      throw new Error(`Migration not registered: ${name}`);
    }

    return this.withMigrationLock(async () => {
      const applied = await this.getApplied();
      if (applied.some((m) => m.name === name)) return false;

      const batch = (await this.getCurrentBatch()) + 1;
      await migration.up(this.ctx);
      await this.recordMigration(migration.name, batch);
      return true;
    });
  }
}

/**
 * DI-native service that resolves a `MigrationRunner` with `table`
 * read from `PostgresMigrationConfig`. Features and controllers inject
 * this; non-DI callers (tests, standalone scripts) use
 * `createMigrationRunner(client, options)` directly.
 *
 * Requires a wired `AbstractLockProvider` - apps must explicitly add
 * `PostgresLockFeature` (or another lock provider). DI fails loudly at
 * `app.ready` if none is wired.
 */
export class MigrationRunnerService extends defineService({
  inject: {
    client: AbstractPostgresClient,
    config: Config.of(PostgresMigrationConfig),
    lockProvider: AbstractLockProvider,
  },
  factory: ({ client, config, lockProvider }): MigrationRunner =>
    new MigrationRunner(client, { table: config.table, lockProvider }),
}) {}

/**
 * Create a migration runner. Non-DI callers (tests, standalone scripts)
 * use this; DI callers inject `MigrationRunnerService` instead.
 *
 * `lockProvider` is required. For tests, pass `createInMemoryLockProvider()`
 * from `@justscale/core`. For real pg-backed locking, construct
 * `new PostgresLockProvider(client)`.
 */
export function createMigrationRunner(
  client: AbstractPostgresClient,
  options: MigrationRunnerOptions,
): MigrationRunner {
  return new MigrationRunner(client, options);
}
