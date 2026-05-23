import { AsyncLocalStorage } from 'node:async_hooks';
import {
  AbstractLockProvider,
  type LockMetadata,
  type LockOptions,
  type LockProvider,
} from '@justscale/core';
import { AbstractPostgresClient } from '../client/client.js';
import { hashStringToBigInt } from '../utils/hash.js';

interface LockContext {
  /** Map of lock key -> metadata for locks held in this context */
  locks: Map<string, LockMetadata>
}

const lockContext = new AsyncLocalStorage<LockContext>();

/**
 * Run a function with lock context tracking.
 * Any locks acquired within will be tracked and can be queried via isLockHeld().
 *
 * @example
 * ```typescript
 * await withLockContext(async () => {
 *   using user = await lockService.acquire(userRepo.get(User.ref(id)));
 *
 *   // Elsewhere in the call stack:
 *   if (isLockHeld('user:123')) {
 *     // We have the lock
 *   }
 * });
 * ```
 */
export function withLockContext<T>(fn: () => T | Promise<T>): Promise<T> {
  const ctx: LockContext = { locks: new Map() };
  return Promise.resolve(lockContext.run(ctx, fn));
}

/** Returns lock metadata if held in the current async context, undefined otherwise. */
export function getLockMetadata(key: string): LockMetadata | undefined {
  const ctx = lockContext.getStore();
  return ctx?.locks.get(key);
}

export function isLockHeld(key: string): boolean {
  return getLockMetadata(key) !== undefined;
}

export function getCurrentLocks(): ReadonlyMap<string, LockMetadata> {
  const ctx = lockContext.getStore();
  return ctx?.locks ?? new Map();
}

function registerLock(key: string, metadata: LockMetadata): void {
  const ctx = lockContext.getStore();
  if (ctx) {
    ctx.locks.set(key, metadata);
  }
}

function unregisterLock(key: string): void {
  const ctx = lockContext.getStore();
  if (ctx) {
    ctx.locks.delete(key);
  }
}

/**
 * Thrown by the advisory strategy when `options.timeout > 0` and the lock
 * could not be acquired before the deadline.
 */
export class LockAcquisitionTimeoutError extends Error {
  readonly lockKey: string;
  readonly timeoutMs: number;
  constructor(key: string, timeoutMs: number) {
    super(`Lock acquisition timed out after ${timeoutMs}ms for key "${key}"`);
    this.name = 'LockAcquisitionTimeoutError';
    this.lockKey = key;
    this.timeoutMs = timeoutMs;
  }
}

export type LockStrategy = 'advisory' | 'table';

export interface PostgresLockProviderOptions {
  strategy?: LockStrategy
  tableName?: string
  heartbeatInterval?: number
}

/**
 * Internal state for managing advisory locks.
 *
 * Advisory locks use hash of key -> bigint. To handle hash collisions,
 * we track all keys that map to each hash. A single advisory lock
 * is shared by all keys with the same hash.
 *
 * IMPORTANT: Advisory locks are connection-specific in PostgreSQL.
 * We must use the same connection for pg_advisory_lock and pg_advisory_unlock.
 * This is achieved by reserving a connection from the pool.
 */
interface HashLockState {
  /** Number of holders (keys) using this hash */
  refCount: number
  /** Map of key -> metadata for each holder */
  holders: Map<string, LockMetadata>
  /** Reserved connection for this lock (must use same connection for lock/unlock) */
  reservedConnection: { release: () => void }
  /** The SQL function bound to the reserved connection */
  sql: ReturnType<typeof import('postgres')>
}

/**
 * Advisory lock implementation using pg_advisory_lock.
 *
 * Each held lock pins one pool connection for its lifetime - PostgreSQL advisory
 * locks are session-scoped and lock + unlock must run on the same connection.
 * Size `postgres({ max })` to at least the number of concurrently held locks you
 * expect, or use the `table` strategy which uses a single connection per operation.
 *
 * Hash collision handling:
 * - Multiple keys may hash to the same bigint (rare but possible)
 * - We use refCount to track how many keys share each hash
 * - Advisory lock is only released when all holders release
 *
 * Timeout behaviour:
 *   - `options.timeout === 0` (default) -> pg_advisory_lock (blocks
 *     forever at the Postgres level, matching the core "always blocking"
 *     contract in LockProvider).
 *   - `options.timeout > 0` -> pg_try_advisory_lock in a polling loop
 *     bounded by the timeout. Rejects with `LockAcquisitionTimeoutError`
 *     if the lock is not obtained before the deadline.
 */
class AdvisoryLockProvider
  extends AbstractLockProvider
  implements LockProvider
{
  private readonly pg: AbstractPostgresClient;
  private readonly hashLocks = new Map<bigint, HashLockState>();
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(pg: AbstractPostgresClient) {
    super();
    this.pg = pg;
  }

  private waitForRelease(key: string, timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let waiters = this.waiters.get(key);
      if (!waiters) {
        waiters = new Set();
        this.waiters.set(key, waiters);
      }

      let timeoutId: NodeJS.Timeout | undefined;
      const cleanup = () => {
        waiters!.delete(onRelease);
        if (waiters!.size === 0) {
          this.waiters.delete(key);
        }
        if (timeoutId) clearTimeout(timeoutId);
      };

      const onRelease = () => {
        cleanup();
        resolve();
      };

      waiters.add(onRelease);

      if (timeout > 0) {
        timeoutId = setTimeout(() => {
          cleanup();
          reject(new Error(`Lock acquisition timeout for key "${key}"`));
        }, timeout);
      }
    });
  }

  private notifyRelease(key: string): void {
    const waiters = this.waiters.get(key);
    if (waiters) {
      for (const callback of [...waiters]) {
        callback();
      }
    }
  }

  async acquire(
    key: string,
    options: Required<LockOptions>,
    instanceId: string,
  ): Promise<LockMetadata> {
    const hash = hashStringToBigInt(key);

    // Same async context re-acquiring the same lock is a design error
    const ctx = lockContext.getStore();
    if (ctx?.locks.has(key)) {
      // Same async context already holds this lock - design error
      throw new Error(
        `Re-entrant lock attempt on key "${key}". Pass Lock<T> instead of re-acquiring.`,
      );
    }

    const existing = this.hashLocks.get(hash);

    // Hash collision: another key maps to the same bigint - share the advisory lock
    if (existing && existing.refCount > 0 && !existing.holders.has(key)) {
      const now = new Date();
      const metadata: LockMetadata = {
        lockedAt: now,
        expiresAt: new Date(now.getTime() + options.ttl),
        lockedBy: instanceId,
      };
      existing.holders.set(key, metadata);
      existing.refCount++;
      registerLock(key, metadata);
      return metadata;
    }

    // Different async context holds the same key - wait for it
    while (this.hashLocks.get(hash)?.holders.has(key)) {
      await this.waitForRelease(key, options.timeout);
    }

    if (existing && existing.refCount > 0) {
      const now = new Date();
      const metadata: LockMetadata = {
        lockedAt: now,
        expiresAt: new Date(now.getTime() + options.ttl),
        lockedBy: instanceId,
      };
      existing.holders.set(key, metadata);
      existing.refCount++;
      registerLock(key, metadata);
      return metadata;
    }

    // Advisory locks are session-scoped - must use the same connection for lock+unlock
    const pool = this.pg.pool as ReturnType<typeof import('postgres')>;
    const reservedConnection = await pool.reserve();

    // Acquire advisory lock.
    // - timeout <= 0 -> pg_advisory_lock (blocks at Postgres level forever,
    //   matches the core "always blocking" contract).
    // - timeout > 0  -> pg_try_advisory_lock in a polling loop bounded by
    //   the deadline; throws LockAcquisitionTimeoutError on expiry.
    const hashStr = hash.toString();
    try {
      if (options.timeout > 0) {
        const deadline = Date.now() + options.timeout;
        const basePoll = 50;
        let acquired = false;
        while (true) {
          const [row] = await reservedConnection<{ got: boolean }[]>`
            SELECT pg_try_advisory_lock(${hashStr}::bigint) AS got
          `;
          if (row?.got) {
            acquired = true;
            break;
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await new Promise<void>((r) =>
            setTimeout(r, Math.min(basePoll, remaining)),
          );
        }
        if (!acquired) {
          reservedConnection.release();
          throw new LockAcquisitionTimeoutError(key, options.timeout);
        }
      } else {
        await reservedConnection`SELECT pg_advisory_lock(${hashStr}::bigint)`;
      }
    } catch (err) {
      // LockAcquisitionTimeoutError already called release(); skip for that case
      if (!(err instanceof LockAcquisitionTimeoutError)) {
        reservedConnection.release();
      }
      throw err;
    }

    const now = new Date();
    const metadata: LockMetadata = {
      lockedAt: now,
      expiresAt: new Date(now.getTime() + options.ttl),
      lockedBy: instanceId,
    };

    const state: HashLockState = {
      refCount: 1,
      holders: new Map([[key, metadata]]),
      reservedConnection,
      sql: reservedConnection,
    };
    this.hashLocks.set(hash, state);
    registerLock(key, metadata);
    return metadata;
  }

  async release(key: string, _instanceId: string): Promise<void> {
    const hash = hashStringToBigInt(key);
    unregisterLock(key);

    const state = this.hashLocks.get(hash);
    if (!state) return;

    state.holders.delete(key);
    state.refCount--;
    this.notifyRelease(key);

    if (state.refCount <= 0) {
      // MUST use the same reserved connection that acquired the lock
      this.hashLocks.delete(hash);
      const hashStr = hash.toString();
      try {
        await state.sql`SELECT pg_advisory_unlock(${hashStr}::bigint)`;
      } finally {
        // Release back to pool even if pg_advisory_unlock fails - the lock
        // will be dropped when the connection closes anyway
        state.reservedConnection.release();
      }
    }
  }

  async extend(key: string, instanceId: string, ttl: number): Promise<boolean> {
    const hash = hashStringToBigInt(key);
    const state = this.hashLocks.get(hash);

    if (!state || !state.holders.has(key)) return false;

    const metadata = state.holders.get(key)!;
    if (metadata.lockedBy !== instanceId) return false;

    // Advisory locks don't actually expire at the PG level, but we track the deadline
    const now = new Date();
    const updatedMetadata: LockMetadata = {
      lockedAt: metadata.lockedAt,
      expiresAt: new Date(now.getTime() + ttl),
      lockedBy: metadata.lockedBy,
    };
    state.holders.set(key, updatedMetadata);

    return true;
  }

  async close(): Promise<void> {
    for (const [hash, state] of this.hashLocks) {
      const hashStr = hash.toString();
      // Unregister every holder key from the AsyncLocalStorage lockContext
      // BEFORE releasing - otherwise getLockMetadata()/isLockHeld() briefly
      // report stale held state after close() returns.
      for (const key of state.holders.keys()) {
        unregisterLock(key);
      }
      try {
        await state.sql`SELECT pg_advisory_unlock(${hashStr}::bigint)`;
      } finally {
        state.reservedConnection.release();
      }
    }
    this.hashLocks.clear();
  }
}

/**
 * Table-based lock implementation (TTL + heartbeat + fencing tokens).
 *
 * Requires the distributed_locks table:
 * ```sql
 * CREATE TABLE IF NOT EXISTS distributed_locks (
 *   lock_key VARCHAR(512) PRIMARY KEY,
 *   instance_id VARCHAR(255) NOT NULL,
 *   fencing_token BIGINT NOT NULL DEFAULT 1,
 *   expires_at TIMESTAMPTZ NOT NULL,
 *   heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 * );
 * CREATE INDEX idx_locks_expires_at ON distributed_locks(expires_at);
 * CREATE SEQUENCE IF NOT EXISTS global_fencing_token START 1 INCREMENT 1 CACHE 100;
 * ```
 */
class TableLockProvider extends AbstractLockProvider implements LockProvider {
  private readonly pg: AbstractPostgresClient;
  private readonly tableName: string;
  private readonly heartbeatIntervals = new Map<string, NodeJS.Timeout>();
  /** Track held locks: key -> instanceId for cleanup on close */
  private readonly heldLocks = new Map<string, string>();

  constructor(pg: AbstractPostgresClient, tableName = 'distributed_locks') {
    super();
    this.pg = pg;
    this.tableName = tableName;
  }

  async acquire(
    key: string,
    options: Required<LockOptions>,
    instanceId: string,
  ): Promise<LockMetadata> {
    const sql = this.pg.pool;
    const table = sql(this.tableName);
    const channel = `lock_release_${key.replace(/[^a-zA-Z0-9_]/g, '_')}`;

    // Keep trying until we get the lock
    while (true) {
      const expiresAt = new Date(Date.now() + options.ttl);

      try {
        // Try to insert or update if expired/same instance
        const [result] = await sql`
          INSERT INTO ${table} (lock_key, instance_id, fencing_token, expires_at)
          VALUES (${key}, ${instanceId}, nextval('global_fencing_token'), ${expiresAt})
          ON CONFLICT (lock_key) DO UPDATE
          SET
            instance_id = ${instanceId},
            fencing_token = nextval('global_fencing_token'),
            expires_at = ${expiresAt},
            heartbeat_at = NOW()
          WHERE
            ${table}.expires_at < NOW()
            OR ${table}.instance_id = ${instanceId}
          RETURNING fencing_token, created_at
        `;

        if (!result) {
          await this.waitForRelease(channel);
          continue;
        }

        const now = new Date();
        const metadata: LockMetadata = {
          lockedAt: now,
          expiresAt,
          lockedBy: instanceId,
        };

        this.heldLocks.set(key, instanceId);
        this.startHeartbeat(key, instanceId, options.ttl);
        registerLock(key, metadata);

        return metadata;
      } catch (_err) {
        // Handle race condition - another process got the lock, wait and retry
        await this.waitForRelease(channel);
      }
    }
  }

  private async waitForRelease(channel: string): Promise<void> {
    const sql = this.pg.pool;

    await new Promise<void>((resolve) => {
      let listenHandle: { unlisten: () => Promise<void> } | null = null;
      const timeout = setTimeout(() => {
        listenHandle?.unlisten();
        resolve();
      }, 100);

      sql
        .listen(channel, () => {
          clearTimeout(timeout);
          listenHandle?.unlisten();
          resolve();
        })
        .then((handle) => {
          listenHandle = handle as { unlisten: () => Promise<void> };
        });
    });
  }

  async release(key: string, instanceId: string): Promise<void> {
    const sql = this.pg.pool;
    const table = sql(this.tableName);
    const channel = `lock_release_${key.replace(/[^a-zA-Z0-9_]/g, '_')}`;

    this.heldLocks.delete(key);
    unregisterLock(key);
    this.stopHeartbeat(key);

    await sql`
      DELETE FROM ${table}
      WHERE lock_key = ${key} AND instance_id = ${instanceId}
    `;

    await sql`SELECT pg_notify(${channel}, '')`;
  }

  async extend(key: string, instanceId: string, ttl: number): Promise<boolean> {
    const sql = this.pg.pool;
    const table = sql(this.tableName);
    const expiresAt = new Date(Date.now() + ttl);

    const result = await sql`
      UPDATE ${table}
      SET expires_at = ${expiresAt}, heartbeat_at = NOW()
      WHERE lock_key = ${key} AND instance_id = ${instanceId}
    `;

    return result.count > 0;
  }

  private startHeartbeat(key: string, instanceId: string, ttl: number): void {
    const interval = Math.floor(ttl / 3);

    const timer = setInterval(async () => {
      const extended = await this.extend(key, instanceId, ttl);
      if (!extended) this.stopHeartbeat(key);
    }, interval);

    this.heartbeatIntervals.set(key, timer);
  }

  private stopHeartbeat(key: string): void {
    const timer = this.heartbeatIntervals.get(key);
    if (timer) {
      clearInterval(timer);
      this.heartbeatIntervals.delete(key);
    }
  }

  /**
   * Clean up expired locks.
   * Call this periodically to remove stale locks.
   */
  async cleanupExpired(): Promise<number> {
    const sql = this.pg.pool;
    const table = sql(this.tableName);

    const result = await sql`
      DELETE FROM ${table}
      WHERE expires_at < NOW()
    `;

    return result.count;
  }

  async close(): Promise<void> {
    for (const [key] of this.heartbeatIntervals) {
      this.stopHeartbeat(key);
    }

    const releasePromises: Promise<void>[] = [];
    for (const [key, instanceId] of this.heldLocks) {
      releasePromises.push(this.release(key, instanceId));
    }
    await Promise.all(releasePromises);
    this.heldLocks.clear();
  }
}

/**
 * Create a PostgreSQL lock provider.
 *
 * @example
 * ```typescript
 * // Advisory locks (default, lightweight)
 * const lockProvider = createPostgresLockProvider(pgClient);
 *
 * // Table-based locks (full control, TTL support)
 * const lockProvider = createPostgresLockProvider(pgClient, {
 *   strategy: 'table',
 *   tableName: 'my_locks',
 * });
 * ```
 */
export function createPostgresLockProvider(
  pg: AbstractPostgresClient,
  options: PostgresLockProviderOptions = {},
): LockProvider {
  const strategy = options.strategy ?? 'advisory';

  if (strategy === 'table') {
    return new TableLockProvider(pg, options.tableName);
  }

  return new AdvisoryLockProvider(pg);
}

export class PostgresLockProvider extends AbstractLockProvider {
  private readonly impl: LockProvider;

  constructor(
    pg: AbstractPostgresClient,
    options: PostgresLockProviderOptions = {},
  ) {
    super();
    this.impl = createPostgresLockProvider(pg, options);
  }

  acquire(
    key: string,
    options: Required<LockOptions>,
    instanceId: string,
  ): Promise<LockMetadata> {
    return this.impl.acquire(key, options, instanceId);
  }

  release(key: string, instanceId: string): Promise<void> {
    return this.impl.release(key, instanceId);
  }

  extend(key: string, instanceId: string, ttl: number): Promise<boolean> {
    return this.impl.extend(key, instanceId, ttl);
  }

  close(): Promise<void> {
    return this.impl.close();
  }
}

/** SQL to create the distributed_locks table. Run as part of your migrations. */
export const DISTRIBUTED_LOCKS_MIGRATION = `
CREATE TABLE IF NOT EXISTS distributed_locks (
  lock_key VARCHAR(512) PRIMARY KEY,
  instance_id VARCHAR(255) NOT NULL,
  fencing_token BIGINT NOT NULL DEFAULT 1,
  expires_at TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_locks_expires_at ON distributed_locks(expires_at);

CREATE SEQUENCE IF NOT EXISTS global_fencing_token START 1 INCREMENT 1 CACHE 100;
`;

import { bindService, createFeatureBuilder } from '@justscale/core';
import { defineService } from '@justscale/core/di';

export class PostgresLockService extends defineService({
  inject: { client: AbstractPostgresClient },
  factory: ({ client }): AbstractLockProvider =>
    new PostgresLockProvider(client),
}) {}

/**
 * Feature that sets up PostgreSQL-backed distributed locking.
 *
 * Requires:
 * - AbstractPostgresClient (add PgClient first)
 *
 * Provides:
 * - AbstractLockProvider (for process locking and other distributed locks)
 *
 * @example
 * ```typescript
 * import JustScale from '@justscale/core'
 * import { createPostgresClient, PostgresLockFeature, PostgresProcessFeature } from '@justscale/postgres'
 *
 * const PgClient = createPostgresClient({ connectionString: '...' })
 *
 * JustScale()
 *   .add(PgClient)
 *   .add(PostgresLockFeature)      // Distributed locking
 *   .add(PostgresProcessFeature)   // Durable processes
 *   .build()
 * ```
 */
export const PostgresLockFeature = createFeatureBuilder()
  .name('PostgresLock')
  .requires(AbstractPostgresClient)
  .provides((b) =>
    b
      .add(PostgresLockService)
      .add(bindService(AbstractLockProvider, PostgresLockService)),
  );
