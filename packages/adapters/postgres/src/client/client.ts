import { AsyncLocalStorage } from 'node:async_hooks';
import type { ServiceDef } from '@justscale/core';
import { Logger, SERVICE_PROVIDES } from '@justscale/core';
import postgres, { type Sql, type Options } from 'postgres';

interface SimpleLogger {
  debug(message: string, attributes?: Record<string, unknown>): void
  info(message: string, attributes?: Record<string, unknown>): void
  warn(message: string, attributes?: Record<string, unknown>): void
  error(message: string, attributes?: Record<string, unknown>): void
}

interface TransactionContext {
  /**
   * The transaction SQL client.
   * Typed as Sql<{}> instead of TransactionSql<{}> to work around
   * postgres 3.4.8 breaking TransactionSql's call signature.
   * See: https://github.com/porsager/postgres/issues/1143
   */
  sql: Sql<{}>
  /** Depth of nesting (0 = root transaction) */
  depth: number
  /** Callbacks to run after commit */
  afterCommit: Array<() => void | Promise<void>>
  /** Callbacks to run after rollback */
  afterRollback: Array<() => void | Promise<void>>
  /** Identity map for entity caching (key: "tableName:id") */
  identityMap: Map<string, WeakRef<object>>
  /** Keys modified at each savepoint depth, used to invalidate on rollback */
  savepointKeys: Map<number, Set<string>>
}

const txContext = new AsyncLocalStorage<TransactionContext>();

export interface PostgresClientOptions {
  /** PostgreSQL connection string (e.g., postgres://user:pass@localhost:5432/db) */
  connectionString?: string
  /** Database host (default: localhost) */
  host?: string
  /** Database port (default: 5432) */
  port?: number
  /** Database name */
  database?: string
  /** Database user */
  username?: string
  /** Database password */
  password?: string
  /** Max connections in pool (default: 10) */
  max?: number
  /** Idle timeout in seconds (default: 20) */
  idleTimeout?: number
  /** Connect timeout in seconds (default: 10) */
  connectTimeout?: number
  /** Connection name for debugging */
  name?: string
  /** SSL mode */
  ssl?: boolean | 'require' | 'prefer' | 'allow' | object
  /**
   * Reconnection backoff in seconds, or a function receiving the retry count.
   * Passed directly to postgres.js which handles automatic reconnection.
   * Default: postgres.js uses exponential backoff starting at ~250ms.
   *
   * @example
   * ```typescript
   * // Fixed 1-second backoff
   * backoff: 1
   * // Exponential with cap
   * backoff: (retries) => Math.min(2 ** retries * 0.5, 30)
   * ```
   */
  backoff?: number | ((retries: number) => number)
}

export type IsolationLevel =
  | 'read uncommitted'
  | 'read committed'
  | 'repeatable read'
  | 'serializable';

// Explicit allowlist used by rootTransaction(). Keeps the raw-SQL emission
// site free of any string operations on caller-provided input.
const ISOLATION_LEVEL_SQL: Record<IsolationLevel, string> = {
  'read uncommitted': 'READ UNCOMMITTED',
  'read committed': 'READ COMMITTED',
  'repeatable read': 'REPEATABLE READ',
  serializable: 'SERIALIZABLE',
};

export interface TransactionOptions {
  /** Isolation level (default: read committed) */
  isolationLevel?: IsolationLevel
  /**
   * Transaction timeout in milliseconds.
   * When set, executes `SET LOCAL statement_timeout = N` at the start of the
   * transaction. PostgreSQL will abort any statement that exceeds this duration,
   * causing the transaction to roll back.
   */
  timeout?: number
}

export abstract class AbstractPostgresClient {
  /**
   * SQL client for the current context (transaction-scoped if inside a transaction).
   * Return type is Sql<{}> rather than TransactionSql<{}> due to postgres#1143.
   */
  abstract get sql(): Sql<{}>;

  /** Raw pool client, bypasses transaction context. */
  abstract get pool(): Sql<{}>;

  abstract get inTransaction(): boolean;

  /** 0 if not in a transaction. */
  abstract get transactionDepth(): number;

  /**
   * Run a function inside a transaction.
   * Supports nested transactions via savepoints.
   *
   * @example
   * ```typescript
   * await client.transaction(async () => {
   *   // All queries here use the same transaction
   *   await client.sql`INSERT INTO users (name) VALUES ('Alice')`;
   *
   *   // Nested transaction = savepoint
   *   await client.transaction(async () => {
   *     await client.sql`INSERT INTO posts (title) VALUES ('Hello')`;
   *   });
   * });
   * ```
   */
  abstract transaction<T>(
    fn: () => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;

  /** Runs immediately if not in a transaction. */
  abstract afterCommit(fn: () => void | Promise<void>): void;

  /** Ignored if not in a transaction. */
  abstract afterRollback(fn: () => void | Promise<void>): void;

  abstract close(): Promise<void>;

  abstract getFromIdentityMap<T>(table: string, id: string): T | undefined;

  abstract storeInIdentityMap<T extends object>(
    table: string,
    id: string,
    entity: T,
  ): void;

  abstract clearIdentityMap(): void;

  abstract removeFromIdentityMap(table: string, id: string): void;
}

class PostgresClientImpl extends AbstractPostgresClient {
  private _sql: Sql<{}>;
  private readonly logger: SimpleLogger;
  private readonly options: PostgresClientOptions;
  /** Global identity map for entity caching outside transactions (key: "tableName:id") */
  private globalIdentityMap = new Map<string, WeakRef<object>>();

  constructor(
    sql: Sql<{}>,
    options: PostgresClientOptions,
    logger: SimpleLogger,
  ) {
    super();
    this._sql = sql;
    this.options = options;
    this.logger = logger;
  }

  get sql(): Sql<{}> {
    const ctx = txContext.getStore();
    return (ctx?.sql ?? this._sql) as Sql<{}>; // TransactionSql is a subset of Sql - postgres#1143
  }

  get pool(): Sql<{}> {
    return this._sql;
  }

  get inTransaction(): boolean {
    return txContext.getStore() !== undefined;
  }

  get transactionDepth(): number {
    return txContext.getStore()?.depth ?? 0;
  }

  async transaction<T>(
    fn: () => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    const parentCtx = txContext.getStore();

    // If already in a transaction, use savepoint (nested transaction)
    if (parentCtx) {
      return this.nestedTransaction(fn, parentCtx);
    }

    // Start new root transaction
    return this.rootTransaction(fn, options);
  }

  private async rootTransaction<T>(
    fn: () => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    const afterCommit: Array<() => void | Promise<void>> = [];
    const afterRollback: Array<() => void | Promise<void>> = [];
    // Capture the ctx out of `_sql.begin` so the rollback path can purge
    // the global identity map for keys that got cached during the aborted
    // transaction. Without this, a root-tx rollback leaves ghost entities
    // in `globalIdentityMap` - subsequent `repo.get(ref)` returns the
    // cached object even though the DB row never committed.
    let ctxRef: TransactionContext | null = null;

    try {
      const result = (await this._sql.begin(async (sql) => {
        const ctx: TransactionContext = {
          sql: sql as unknown as Sql<{}>,
          depth: 0,
          afterCommit,
          afterRollback,
          identityMap: new Map(),
          savepointKeys: new Map(),
        };
        ctxRef = ctx;

        if (options?.isolationLevel !== undefined) {
          // Allowlist before reaching raw SQL — the type narrows to four
          // string literals, but a caller bypassing types via `as any` would
          // otherwise smuggle SQL through `.toUpperCase()`. Empty / whitespace
          // / unknown strings all fail closed; only the four known levels pass.
          const level = ISOLATION_LEVEL_SQL[options.isolationLevel];
          if (!level) {
            throw new Error(
              `Invalid isolation level: ${JSON.stringify(options.isolationLevel)}`,
            );
          }
          if (options.isolationLevel !== 'read committed') {
            await sql.unsafe(`SET TRANSACTION ISOLATION LEVEL ${level}`);
          }
        }

        // Set statement timeout if specified (scoped to this transaction via LOCAL)
        if (options?.timeout) {
          await sql.unsafe(
            `SET LOCAL statement_timeout = ${Math.round(options.timeout)}`,
          );
        }

        return txContext.run(ctx, fn);
      })) as T;

      for (const hook of afterCommit) {
        try {
          await hook();
        } catch (err) {
          this.logger.error('afterCommit hook failed', { error: err });
        }
      }

      return result;
    } catch (err) {
      // Purge globalIdentityMap for keys touched by the rolled-back tx;
      // without this, ghost entities remain visible via getFromIdentityMap
      if (ctxRef) {
        for (const key of (ctxRef as TransactionContext).identityMap.keys()) {
          this.globalIdentityMap.delete(key);
        }
      }

      for (const hook of afterRollback) {
        try {
          await hook();
        } catch (hookErr) {
          this.logger.error('afterRollback hook failed', { error: hookErr });
        }
      }
      throw err;
    }
  }

  private async nestedTransaction<T>(
    fn: () => Promise<T>,
    parentCtx: TransactionContext,
  ): Promise<T> {
    const savepointName = `sp_${parentCtx.depth + 1}_${Date.now()}`;
    const nestedDepth = parentCtx.depth + 1;
    const nestedAfterCommit: Array<() => void | Promise<void>> = [];
    const nestedAfterRollback: Array<() => void | Promise<void>> = [];

    parentCtx.savepointKeys.set(nestedDepth, new Set());

    try {
      await parentCtx.sql`SAVEPOINT ${parentCtx.sql(savepointName)}`;

      const nestedCtx: TransactionContext = {
        sql: parentCtx.sql,
        depth: nestedDepth,
        afterCommit: nestedAfterCommit,
        afterRollback: nestedAfterRollback,
        identityMap: parentCtx.identityMap,
        savepointKeys: parentCtx.savepointKeys,
      };

      const result = await txContext.run(nestedCtx, fn);

      try {
        await parentCtx.sql`RELEASE SAVEPOINT ${parentCtx.sql(savepointName)}`;
      } catch {
        // transaction already ended (serialization failure etc.)
      }

      // Merge tracked keys upward so parent rollback also invalidates them
      const modifiedKeys = parentCtx.savepointKeys.get(nestedDepth);
      if (modifiedKeys && modifiedKeys.size > 0) {
        let parentKeys = parentCtx.savepointKeys.get(parentCtx.depth);
        if (!parentKeys) {
          parentKeys = new Set();
          parentCtx.savepointKeys.set(parentCtx.depth, parentKeys);
        }
        for (const key of modifiedKeys) {
          parentKeys.add(key);
        }
      }
      parentCtx.savepointKeys.delete(nestedDepth);
      parentCtx.afterCommit.push(...nestedAfterCommit);
      parentCtx.afterRollback.push(...nestedAfterRollback);

      return result;
    } catch (err) {
      try {
        await parentCtx.sql`ROLLBACK TO SAVEPOINT ${parentCtx.sql(savepointName)}`;
      } catch (rollbackErr) {
        this.logger.error('ROLLBACK TO SAVEPOINT failed - possible data integrity issue', {
          savepoint: savepointName,
          error: rollbackErr,
        });
        throw rollbackErr;
      }

      const modifiedKeys = parentCtx.savepointKeys.get(nestedDepth);
      if (modifiedKeys) {
        for (const key of modifiedKeys) {
          parentCtx.identityMap.delete(key);
          this.globalIdentityMap.delete(key);
        }
        parentCtx.savepointKeys.delete(nestedDepth);
      }

      for (const hook of nestedAfterRollback) {
        try {
          await hook();
        } catch (hookErr) {
          this.logger.error('afterRollback hook failed', { error: hookErr });
        }
      }

      throw err;
    }
  }

  afterCommit(fn: () => void | Promise<void>): void {
    const ctx = txContext.getStore();
    if (ctx) {
      ctx.afterCommit.push(fn);
    } else {
      Promise.resolve(fn()).catch((err) => {
        this.logger.error('afterCommit (immediate) failed', { error: err });
      });
    }
  }

  afterRollback(fn: () => void | Promise<void>): void {
    const ctx = txContext.getStore();
    if (ctx) ctx.afterRollback.push(fn);
  }

  async close(): Promise<void> {
    await this._sql.end();
    this.logger.debug('PostgreSQL client closed');
  }

  getFromIdentityMap<T>(table: string, id: string): T | undefined {
    const key = `${table}:${id}`;

    const ctx = txContext.getStore();
    if (ctx) {
      const ref = ctx.identityMap.get(key);
      if (ref) {
        const entity = ref.deref();
        if (entity) return entity as T;
        ctx.identityMap.delete(key);
      }
    }

    const globalRef = this.globalIdentityMap.get(key);
    if (globalRef) {
      const entity = globalRef.deref();
      if (entity) return entity as T;
      this.globalIdentityMap.delete(key);
    }

    return undefined;
  }

  storeInIdentityMap<T extends object>(
    table: string,
    id: string,
    entity: T,
  ): void {
    const key = `${table}:${id}`;
    const ref = new WeakRef(entity);
    this.globalIdentityMap.set(key, ref);

    const ctx = txContext.getStore();
    if (ctx) {
      ctx.identityMap.set(key, ref);

      if (ctx.depth > 0) {
        const savepointModified = ctx.savepointKeys.get(ctx.depth);
        if (savepointModified) {
          savepointModified.add(key);
        }
      }
    }
  }

  clearIdentityMap(): void {
    this.globalIdentityMap = new Map();
    const ctx = txContext.getStore();
    if (ctx) ctx.identityMap = new Map();
  }

  removeFromIdentityMap(table: string, id: string): void {
    const key = `${table}:${id}`;
    this.globalIdentityMap.delete(key);
    const ctx = txContext.getStore();
    if (ctx) ctx.identityMap.delete(key);
  }
}

function buildPostgresOptions(options: PostgresClientOptions): Options<{}> {
  const pgOptions: Options<{}> = {
    max: options.max ?? 10,
    idle_timeout: options.idleTimeout ?? 20,
    connect_timeout: options.connectTimeout ?? 10,
    // Pin search_path at connection startup to prevent schema-shadow attacks
    // (CVE-2024-0985 class). Per-session SET search_path still works for
    // test/migration tooling that explicitly overrides it.
    connection: {
      search_path: '"$user",public',
    },
  };

  if (options.backoff !== undefined) {
    pgOptions.backoff = options.backoff as Options<{}>['backoff'];
  }

  if (options.connectionString) return pgOptions;

  pgOptions.host = options.host ?? 'localhost';
  pgOptions.port = options.port ?? 5432;
  pgOptions.database = options.database;
  pgOptions.username = options.username;
  pgOptions.password = options.password;
  pgOptions.ssl = options.ssl;

  return pgOptions;
}

/**
 * Create a raw PostgreSQL client (not for DI, for direct use).
 *
 * @example
 * ```typescript
 * const client = createRawPostgresClient({
 *   connectionString: 'postgres://user:pass@localhost:5432/db'
 * });
 *
 * await client.transaction(async () => {
 *   await client.sql`INSERT INTO users (name) VALUES ('Alice')`;
 * });
 * ```
 */
export function createRawPostgresClient(
  options: PostgresClientOptions,
  logger?: SimpleLogger,
): AbstractPostgresClient {
  const pgOptions = buildPostgresOptions(options);

  const defaultLogger: SimpleLogger = {
    debug: () => {},
    info: () => {},
    warn: console.warn,
    error: console.error,
  };
  const resolvedLogger = logger ?? defaultLogger;

  // Route NOTICEs through the logger - otherwise postgres.js dumps the full
  // notice object to stderr, which is noisy for benign IF NOT EXISTS DDL
  pgOptions.onnotice = (notice: { severity?: string; message?: string }) => {
    resolvedLogger.debug(
      `[pg ${notice.severity ?? 'NOTICE'}] ${notice.message ?? ''}`,
    );
  };

  const sql = options.connectionString
    ? postgres(options.connectionString, pgOptions)
    : postgres(pgOptions);

  return new PostgresClientImpl(sql, options, resolvedLogger);
}

export interface PostgresClientDef
  extends ServiceDef<AbstractPostgresClient, { logger: typeof Logger }> {}

/**
 * Create a PostgreSQL client service definition for DI.
 *
 * @example
 * ```typescript
 * import { createPostgresClient, AbstractPostgresClient } from '@justscale/postgres';
 *
 * const PostgresClient = createPostgresClient({
 *   connectionString: process.env.DATABASE_URL
 * });
 *
 * createCluster({
 *   services: [PostgresClient],
 * });
 *
 * // Inject into services
 * const MyService = defineService({
 *   inject: { db: AbstractPostgresClient },
 *   factory: ({ db }) => ({
 *     async getUsers() {
 *       return db.sql`SELECT * FROM users`;
 *     }
 *   })
 * });
 * ```
 */
export function createPostgresClient(
  options: PostgresClientOptions = {},
): PostgresClientDef {
  return {
    deps: { logger: Logger },
    factory: async ({
      logger,
    }: { logger: Logger }): Promise<AbstractPostgresClient> => {
      const client = createRawPostgresClient(options, logger);
      logger.info('PostgreSQL client created', {
        host: options.host ?? '(connection string)',
        database: options.database ?? '(connection string)',
      });
      return client;
    },
    [SERVICE_PROVIDES]: [AbstractPostgresClient],
  } as unknown as PostgresClientDef;
}

export function getCurrentTransactionContext(): TransactionContext | undefined {
  return txContext.getStore();
}
