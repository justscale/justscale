/**
 * PostgreSQL Scheduled Task Repository
 *
 * PostgreSQL implementation of ScheduledTaskRepository using:
 * - FOR UPDATE SKIP LOCKED for efficient, exactly-once task pickup
 * - Polling-based subscription with configurable interval
 * - Proper status transitions to track task lifecycle
 *
 * @example
 * ```typescript
 * const scheduler = new PgScheduledTaskRepository(pgClient, {
 *   tableName: 'scheduled_tasks',
 * })
 *
 * // Schedule a task
 * await scheduler.schedule({
 *   dueAt: new Date(Date.now() + 60_000),
 *   namespace: 'process',
 *   type: 'delay',
 *   payload: { processId: '123' },
 * })
 *
 * // Subscribe and process
 * for await (const task of scheduler.subscribe('process.delay')) {
 *   await handleTask(task)
 * }
 * ```
 */

import {
  ADAPTER_KEY,
  type Ref,
  type Locked,
  type Aggregation,
  type Condition,
  type FindOptions,
  type Transient,
  type OrderBy,
  type Persistent,
  type Reference,
  type ScheduleOptions,
  type ScheduledTask,
  ScheduledTaskRepository,
  ScheduledTaskStatus,
  type SubscribeOptions,
  isLocked,
} from '@justscale/core/models';
import type { LockOptions, LockMetadata } from '@justscale/core';
import { defineService } from '@justscale/core';
import { PG_CREATED_AT, PG_UPDATED_AT, PG_VERSION, extractKey } from './pg-repository.js';
import type { DurableQueryIterable } from '@justscale/core/process';
import type { JSONValue } from 'postgres';
import { AbstractPostgresClient } from '../client/client.js';
import { PgQueryBuilder } from '../query/pg-query-builder.js';
import { PgQueryIterator } from '../query/query-iterator.js';
import { PgQueryCompiler, type StorageMode } from '../query/query-compiler.js';

/** Default poll interval in milliseconds */
const DEFAULT_POLL_INTERVAL = 1000;
/** Default threshold for stuck-task recovery: 10 minutes in Processing. */
const DEFAULT_STUCK_AFTER_MS = 10 * 60 * 1000;
/** Default interval at which `subscribe()` checks for stuck tasks: 60s. */
const DEFAULT_STUCK_CHECK_EVERY_MS = 60 * 1000;

/** Options for PgScheduledTaskRepository */
export interface PgScheduledTaskRepositoryOptions {
  /** Table name (default: 'scheduled_tasks') */
  tableName?: string
  /** Storage mode (default: 'columnar') */
  storageMode?: StorageMode
}

/**
 * PostgreSQL implementation of ScheduledTaskRepository.
 *
 * Uses FOR UPDATE SKIP LOCKED for efficient concurrent task pickup.
 * Multiple workers can subscribe to the same qualified name and tasks
 * will be distributed among them without conflicts.
 */
export class PgScheduledTaskRepository extends ScheduledTaskRepository {
  private readonly client: AbstractPostgresClient;
  private readonly tableName: string;
  private readonly storageMode: StorageMode;
  private readonly compiler: PgQueryCompiler;

  constructor(
    client: AbstractPostgresClient,
    options: PgScheduledTaskRepositoryOptions = {},
  ) {
    super();
    this.client = client;
    this.tableName = options.tableName ?? 'scheduled_tasks';
    this.storageMode = options.storageMode ?? 'columnar';

    this.compiler = new PgQueryCompiler({
      storageMode: this.storageMode,
      tableName: this.tableName,
      snakeCase: true,
    });
  }

  // -------------------------------------------------------------------------
  // Scheduling Methods
  // -------------------------------------------------------------------------

  async schedule<TPayload = unknown>(
    options: ScheduleOptions<TPayload>,
  ): Promise<Persistent<ScheduledTask>> {
    const sql = this.client.sql;
    const id = crypto.randomUUID();
    const now = new Date();

    const result = await sql`
      INSERT INTO ${sql(this.tableName)} (
        id, due_at, namespace, type, payload, status,
        created_at, updated_at, version
      ) VALUES (
        ${id},
        ${options.dueAt},
        ${options.namespace},
        ${options.type},
        ${sql.json(options.payload as JSONValue)},
        ${ScheduledTaskStatus.Pending},
        ${now},
        ${now},
        1
      )
      RETURNING *
    `;

    return this.rowToEntity(result[0] as Record<string, unknown>);
  }

  async cancel(taskId: string): Promise<boolean> {
    const sql = this.client.sql;
    const now = new Date();

    const result = await sql`
      UPDATE ${sql(this.tableName)}
      SET
        status = ${ScheduledTaskStatus.Cancelled},
        completed_at = ${now},
        updated_at = ${now},
        version = version + 1
      WHERE id = ${taskId} AND status = ${ScheduledTaskStatus.Pending}
      RETURNING id
    `;

    return result.length > 0;
  }

  async *subscribe(
    qualifiedName: string,
    options?: SubscribeOptions,
  ): AsyncIterable<Persistent<ScheduledTask>> {
    const [namespace, type] = qualifiedName.split('.');
    if (!namespace || !type) {
      throw new Error(
        `Invalid qualified name: ${qualifiedName}. Expected format: namespace.type`,
      );
    }

    const pollInterval = options?.pollInterval ?? DEFAULT_POLL_INTERVAL;
    const signal = options?.signal;
    // Stuck-task auto-recovery. If the worker that picked a task crashed
    // before `markCompleted` landed, the row sits in Processing forever
    // unless someone calls `resetStuck`. Reset stuck rows periodically in
    // the subscribe loop - without this, a worker OOM silently drops a
    // scheduled signal, and any `delay.minutes(r, N)` inside a process
    // never fires.
    const stuckAfterMs = options?.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS;
    const stuckCheckEveryMs = options?.stuckCheckEveryMs ?? DEFAULT_STUCK_CHECK_EVERY_MS;
    let lastStuckCheck = 0;

    while (true) {
      // Check for abort
      if (signal?.aborted) {
        return;
      }

      // Periodic stuck-task recovery (skipped when disabled).
      if (stuckAfterMs !== false) {
        const now = Date.now();
        if (now - lastStuckCheck >= stuckCheckEveryMs) {
          lastStuckCheck = now;
          try {
            await this.resetStuck(new Date(now - stuckAfterMs));
          } catch {
            // Best-effort - a transient DB error here should not break
            // the subscribe loop. We'll retry on the next interval.
          }
        }
      }

      // Try to pick up a task
      const task = await this.pickNextDueTask(namespace, type);

      if (task) {
        // Yield to the consumer
        yield task;

        // Mark as completed after successful processing
        await this.markCompleted((task as unknown as Record<symbol, unknown>)[ADAPTER_KEY] as string);
      } else {
        // No task ready, wait before polling again
        await this.sleep(pollInterval, signal);
      }
    }
  }

  /**
   * Pick up the next due task using FOR UPDATE SKIP LOCKED.
   * This ensures exactly-once pickup even with multiple workers.
   */
  private async pickNextDueTask(
    namespace: string,
    type: string,
  ): Promise<Persistent<ScheduledTask> | null> {
    const sql = this.client.sql;
    const now = new Date();

    // Use a transaction to ensure atomic pickup
    const result = await sql`
      UPDATE ${sql(this.tableName)}
      SET
        status = ${ScheduledTaskStatus.Processing},
        started_at = ${now},
        updated_at = ${now},
        version = version + 1
      WHERE id = (
        SELECT id FROM ${sql(this.tableName)}
        WHERE namespace = ${namespace}
          AND type = ${type}
          AND status = ${ScheduledTaskStatus.Pending}
          AND due_at <= ${now}
        ORDER BY due_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `;

    if (result.length === 0) {
      return null;
    }

    return this.rowToEntity(result[0] as Record<string, unknown>);
  }

  /**
   * Mark a task as completed.
   */
  private async markCompleted(taskId: string): Promise<void> {
    const sql = this.client.sql;
    const now = new Date();

    await sql`
      UPDATE ${sql(this.tableName)}
      SET
        status = ${ScheduledTaskStatus.Completed},
        completed_at = ${now},
        updated_at = ${now},
        version = version + 1
      WHERE id = ${taskId}
    `;
  }

  /**
   * Mark a task as failed.
   */
  async markFailed(taskId: string, error: string): Promise<void> {
    const sql = this.client.sql;
    const now = new Date();

    await sql`
      UPDATE ${sql(this.tableName)}
      SET
        status = ${ScheduledTaskStatus.Failed},
        completed_at = ${now},
        error = ${error},
        updated_at = ${now},
        version = version + 1
      WHERE id = ${taskId}
    `;
  }

  /**
   * Sleep for the given duration, respecting abort signal.
   */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timeout = setTimeout(resolve, ms);

      if (signal) {
        const abortHandler = () => {
          clearTimeout(timeout);
          resolve();
        };
        signal.addEventListener('abort', abortHandler, { once: true });
      }
    });
  }

  // -------------------------------------------------------------------------
  // Standard Repository Methods
  // -------------------------------------------------------------------------

  async find(
    options?: FindOptions<ScheduledTask>,
  ): Promise<Persistent<ScheduledTask>[]> {
    const sql = this.client.sql;
    const parts: string[] = [`SELECT * FROM ${this.tableName}`];
    const values: unknown[] = [];

    if (options?.where) {
      const compiled = this.compiler.compileWhere(options.where);
      parts.push(`WHERE ${compiled.text}`);
      values.push(...compiled.values);
    }

    if (options?.orderBy) {
      const compiled = this.compiler.compileOrderBy(options.orderBy);
      if (compiled.text) {
        parts.push(`ORDER BY ${compiled.text}`);
      }
    }

    if (options?.limit !== undefined) {
      parts.push(`LIMIT ${options.limit}`);
    }

    if (options?.offset !== undefined) {
      parts.push(`OFFSET ${options.offset}`);
    }

    const query = parts.join(' ');
    const result = await sql.unsafe(
      query,
      values as (string | number | boolean | Date | null)[],
    );

    return result.map((row) => this.rowToEntity(row as Record<string, unknown>));
  }

  async get(
    ref: Ref<ScheduledTask>,
  ): Promise<Persistent<ScheduledTask> | undefined> {
    const id = extractKey(ref);
    const sql = this.client.sql;

    const result = await sql`
      SELECT * FROM ${sql(this.tableName)}
      WHERE id = ${id}
      LIMIT 1
    `;

    if (result.length === 0) {
      return undefined;
    }

    return this.rowToEntity(result[0] as Record<string, unknown>);
  }

  async getMany(
    refs: Ref<ScheduledTask>[],
  ): Promise<Persistent<ScheduledTask>[]> {
    if (refs.length === 0) return [];

    const sql = this.client.sql;
    const ids = refs.map((ref) => extractKey(ref));

    const result = await sql`
      SELECT * FROM ${sql(this.tableName)}
      WHERE id = ANY(${ids})
    `;

    return result.map((row) => this.rowToEntity(row as Record<string, unknown>));
  }

  async findOne(
    where: Condition,
  ): Promise<Persistent<ScheduledTask> | undefined> {
    const results = await this.find({ where, limit: 1 });
    return results[0];
  }

  async count(where?: Condition): Promise<number> {
    const sql = this.client.sql;

    if (where) {
      const compiled = this.compiler.compileWhere(where);
      const query = `SELECT COUNT(*) as count FROM ${this.tableName} WHERE ${compiled.text}`;
      const result = await sql.unsafe(
        query,
        compiled.values as (string | number | boolean | Date | null)[],
      );
      return Number.parseInt(
        (result[0] as unknown as { count: string }).count,
        10,
      );
    }

    const result = await sql`
      SELECT COUNT(*) as count FROM ${sql(this.tableName)}
    `;
    return Number.parseInt(
      (result[0] as unknown as { count: string }).count,
      10,
    );
  }

  async aggregate(agg: Aggregation, where?: Condition): Promise<number | null> {
    const sql = this.client.sql;
    const aggCompiled = this.compiler.compileAggregation(agg);

    let result: Array<{ result: string | null }>;

    if (where) {
      const whereCompiled = this.compiler.compileWhere(where);
      const query = `SELECT ${aggCompiled.text} as result FROM ${this.tableName} WHERE ${whereCompiled.text}`;
      result = await sql.unsafe(query, [
        ...aggCompiled.values,
        ...whereCompiled.values,
      ] as (string | number | boolean | Date | null)[]);
    } else {
      const query = `SELECT ${aggCompiled.text} as result FROM ${this.tableName}`;
      result = await sql.unsafe(
        query,
        aggCompiled.values as (string | number | boolean | Date | null)[],
      );
    }

    const value = result[0]?.result;
    return value === null ? null : Number.parseFloat(value);
  }

  async insert(data: ScheduledTask): Promise<Persistent<ScheduledTask>> {
    const sql = this.client.sql;
    const id = crypto.randomUUID();
    const now = new Date();

    const result = await sql`
      INSERT INTO ${sql(this.tableName)} (
        id, due_at, namespace, type, payload, status,
        started_at, completed_at, error,
        created_at, updated_at, version
      ) VALUES (
        ${id},
        ${data.dueAt},
        ${data.namespace},
        ${data.type},
        ${sql.json(data.payload as JSONValue)},
        ${data.status},
        ${data.startedAt ?? null},
        ${data.completedAt ?? null},
        ${data.error ?? null},
        ${now},
        ${now},
        1
      )
      RETURNING *
    `;

    return this.rowToEntity(result[0] as Record<string, unknown>);
  }

  async insertMany(
    data: ScheduledTask[],
  ): Promise<Persistent<ScheduledTask>[]> {
    const results: Persistent<ScheduledTask>[] = [];
    for (const item of data) {
      results.push(await this.insert(item));
    }
    return results;
  }

  async lock(
    entity: Ref<ScheduledTask> | Promise<Persistent<ScheduledTask> | null | undefined>,
    _options?: LockOptions,
  ): Promise<Locked<ScheduledTask> | null> {
    const resolved = await Promise.resolve(entity);
    if (!resolved) return null;
    const id = extractKey(resolved);
    const sql = this.client.sql;

    // Use SELECT FOR UPDATE to acquire a row-level lock in Postgres
    const result = await sql`
      SELECT * FROM ${sql(this.tableName)} WHERE id = ${id} FOR UPDATE
    `;
    if (result.length === 0) return null;

    const fresh = this.rowToEntity(result[0] as Record<string, unknown>);
    const metadata: LockMetadata = {
      lockedAt: new Date(),
      expiresAt: new Date(Date.now() + (_options?.ttl ?? 30000)),
      lockedBy: 'postgres',
    };
    const locked = Object.create(fresh as object, {
      __lock: { value: metadata, writable: false, enumerable: false, configurable: false },
      [Symbol.dispose]: { value: () => {}, writable: false, enumerable: false, configurable: false },
    });
    return locked as Locked<ScheduledTask>;
  }

  async update(
    entity: Locked<ScheduledTask>,
    data: Partial<ScheduledTask>,
  ): Promise<Persistent<ScheduledTask>> {
    const id = extractKey(entity);
    const sql = this.client.sql;
    const now = new Date();

    // Build SET clause dynamically
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (data.dueAt !== undefined) {
      setClauses.push(`due_at = $${paramIndex++}`);
      values.push(data.dueAt);
    }
    if (data.namespace !== undefined) {
      setClauses.push(`namespace = $${paramIndex++}`);
      values.push(data.namespace);
    }
    if (data.type !== undefined) {
      setClauses.push(`type = $${paramIndex++}`);
      values.push(data.type);
    }
    if (data.payload !== undefined) {
      setClauses.push(`payload = $${paramIndex++}`);
      values.push(JSON.stringify(data.payload));
    }
    if (data.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      values.push(data.status);
    }
    if (data.startedAt !== undefined) {
      setClauses.push(`started_at = $${paramIndex++}`);
      values.push(data.startedAt);
    }
    if (data.completedAt !== undefined) {
      setClauses.push(`completed_at = $${paramIndex++}`);
      values.push(data.completedAt);
    }
    if (data.error !== undefined) {
      setClauses.push(`error = $${paramIndex++}`);
      values.push(data.error);
    }

    setClauses.push(`updated_at = $${paramIndex++}`);
    values.push(now);
    setClauses.push('version = version + 1');

    values.push(id);
    let query = `UPDATE ${this.tableName} SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`;

    query += ' RETURNING *';

    const result = await sql.unsafe(
      query,
      values as (string | number | boolean | Date | null)[],
    );

    if (result.length === 0) {
      throw new Error(`Task not found or version mismatch: ${id}`);
    }

    return this.rowToEntity(result[0] as Record<string, unknown>);
  }

  async save(
    entity: ScheduledTask | Transient<ScheduledTask> | Locked<ScheduledTask>,
  ): Promise<Persistent<ScheduledTask>> {
    if (isLocked(entity)) {
      const data = { ...entity } as Partial<ScheduledTask>;
      return this.update(entity as Locked<ScheduledTask>, data);
    }

    return this.insert(entity as ScheduledTask);
  }

  async delete(entity: Locked<ScheduledTask>): Promise<boolean> {
    const id = extractKey(entity);
    const sql = this.client.sql;

    const result = await sql`
      DELETE FROM ${sql(this.tableName)}
      WHERE id = ${id}
      RETURNING id
    `;
    return result.length > 0;
  }

  async deleteWhere(where: Condition): Promise<number> {
    const sql = this.client.sql;
    const compiled = this.compiler.compileWhere(where);
    const query = `DELETE FROM ${this.tableName} WHERE ${compiled.text} RETURNING id`;
    const result = await sql.unsafe(
      query,
      compiled.values as (string | number | boolean | Date | null)[],
    );
    return result.length;
  }

  iterate(options: FindOptions<ScheduledTask> & { orderBy: OrderBy<ScheduledTask> }): DurableQueryIterable<Persistent<ScheduledTask>> {
    const uniqueFields = new Set<string>(['id']);
    const builder = new PgQueryBuilder<Record<string, unknown>>(
      this.client,
      this.tableName,
      this.compiler,
      uniqueFields,
      options.where,
      options.orderBy,
    );
    return new PgQueryIterator(builder) as unknown as DurableQueryIterable<Persistent<ScheduledTask>>;
  }

  async *stream(
    options?: FindOptions<ScheduledTask> & { batchSize?: number },
  ): AsyncIterable<Persistent<ScheduledTask>> {
    for await (const batch of this.streamBatches(options)) {
      for (const entity of batch) {
        yield entity;
      }
    }
  }

  async *streamBatches(
    options?: FindOptions<ScheduledTask> & { batchSize?: number },
  ): AsyncIterable<Persistent<ScheduledTask>[]> {
    const batchSize = options?.batchSize ?? 100;
    let offset = options?.offset ?? 0;
    while (true) {
      const batch = await this.find({
        ...options,
        offset,
        limit: batchSize,
      });

      if (batch.length === 0) {
        break;
      }

      yield batch;

      offset += batchSize;

      if (batch.length < batchSize) {
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Live Model Observation
  // -------------------------------------------------------------------------

  /**
   * Observe changes to a scheduled task.
   *
   * Scheduled tasks are typically consumed once and completed, so live
   * observation is not meaningful. This is a no-op that returns an empty
   * async generator.
   */
  async *observe(
    _entity: Persistent<ScheduledTask> | Reference<unknown>,
  ): AsyncGenerator<Persistent<ScheduledTask>> {
    // Scheduled tasks don't need cross-process observation
    // They are consumed once via subscribe() and marked complete
  }

  // -------------------------------------------------------------------------
  // Utility Methods
  // -------------------------------------------------------------------------

  /**
   * Clean up old completed/cancelled/failed tasks.
   * Call this periodically to prevent table bloat.
   */
  async cleanup(olderThan: Date): Promise<number> {
    const sql = this.client.sql;

    const result = await sql`
      DELETE FROM ${sql(this.tableName)}
      WHERE completed_at < ${olderThan}
        AND status IN (
          ${ScheduledTaskStatus.Completed},
          ${ScheduledTaskStatus.Cancelled},
          ${ScheduledTaskStatus.Failed}
        )
      RETURNING id
    `;

    return result.length;
  }

  /**
   * Reset stuck tasks (processing for too long) back to pending.
   * Useful for recovering from worker crashes.
   */
  async resetStuck(stuckThreshold: Date): Promise<number> {
    const sql = this.client.sql;
    const now = new Date();

    const result = await sql`
      UPDATE ${sql(this.tableName)}
      SET
        status = ${ScheduledTaskStatus.Pending},
        started_at = NULL,
        updated_at = ${now},
        version = version + 1
      WHERE status = ${ScheduledTaskStatus.Processing}
        AND started_at < ${stuckThreshold}
      RETURNING id
    `;

    return result.length;
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  /**
   * Convert a database row to a ScheduledTask entity.
   */
  private rowToEntity(row: Record<string, unknown>): Persistent<ScheduledTask> {
    const entity = {
      dueAt: row.due_at as Date,
      namespace: row.namespace as string,
      type: row.type as string,
      payload: row.payload as unknown,
      status: row.status as string,
      // Normalize null -> undefined (Postgres NULL vs JS undefined)
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      error: row.error ?? undefined,
    } as Record<string | symbol, unknown>;

    // Attach system fields as non-enumerable symbols
    Object.defineProperty(entity, ADAPTER_KEY, { value: row.id as string, enumerable: false, configurable: true, writable: true });
    Object.defineProperty(entity, PG_CREATED_AT, { value: row.created_at as Date, enumerable: false, configurable: true, writable: true });
    Object.defineProperty(entity, PG_UPDATED_AT, { value: row.updated_at as Date, enumerable: false, configurable: true, writable: true });
    Object.defineProperty(entity, PG_VERSION, { value: row.version as number, enumerable: false, configurable: true, writable: true });

    return entity as unknown as Persistent<ScheduledTask>;
  }
}


/**
 * SQL to create the scheduled_tasks table.
 * Run this as part of your migrations.
 */
export const SCHEDULED_TASKS_MIGRATION = `
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id UUID PRIMARY KEY,
  due_at TIMESTAMPTZ NOT NULL,
  namespace VARCHAR(64) NOT NULL,
  type VARCHAR(64) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 1
);

-- Index for efficient task pickup (namespace + type + status + due_at)
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_pickup
  ON scheduled_tasks (namespace, type, status, due_at)
  WHERE status = 'pending';

-- Index for cleanup of old tasks
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_completed
  ON scheduled_tasks (completed_at)
  WHERE status IN ('completed', 'cancelled', 'failed');

-- Index for stuck task detection
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_stuck
  ON scheduled_tasks (started_at)
  WHERE status = 'processing';
`;

/**
 * Factory function to create a PgScheduledTaskRepository.
 */
export function createPgScheduledTaskRepository(
  client: AbstractPostgresClient,
  options?: PgScheduledTaskRepositoryOptions,
): PgScheduledTaskRepository {
  return new PgScheduledTaskRepository(client, options);
}

/**
 * DI-native service that resolves a `PgScheduledTaskRepository` bound to
 * the injected Postgres client with default options. Non-DI callers use
 * `createPgScheduledTaskRepository(client, options)` directly when they
 * need custom table/storage settings.
 */
export class PgScheduledTaskRepositoryService extends defineService({
  inject: { client: AbstractPostgresClient },
  factory: ({ client }): PgScheduledTaskRepository =>
    new PgScheduledTaskRepository(client),
}) {}
