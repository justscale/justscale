/**
 * In-Memory Scheduled Task Repository
 *
 * In-memory implementation of ScheduledTaskRepository for development and testing.
 * Uses polling to check for due tasks and setTimeout for the delay between polls.
 *
 * @example
 * ```typescript
 * const scheduler = new InMemoryScheduledTaskRepository()
 *
 * // Schedule a task
 * await scheduler.schedule({
 *   dueAt: new Date(Date.now() + 5000),
 *   namespace: 'test',
 *   type: 'job',
 *   payload: { message: 'hello' },
 * })
 *
 * // Subscribe and process
 * for await (const task of scheduler.subscribe('test.job')) {
 *   console.log('Got task:', task.payload)
 * }
 * ```
 */

import type { Condition, FindOptions, Aggregation, OrderBy, OrderByItem } from '../query.js';
import type { Persistent, Locked, Transient, InsertData, UpdateData } from '../types.js';
import { isLocked } from '../types.js';
import type { LockOptions, LockMetadata } from '../../features/lock/types.js';
import { PERSISTENT, ADAPTER_KEY } from '../symbols.js';
import {
  ScheduledTaskRepository,
  type ScheduleOptions,
  type SubscribeOptions,
} from '../scheduled-task/scheduled-task.repository.js';
import { ScheduledTask, ScheduledTaskStatus } from '../scheduled-task/scheduled-task.js';
import { evaluateCondition, sortEntities, computeAggregation } from './condition-evaluator.js';
import type { Reference } from '../reference/reference.js';
import { DurableArrayIterator, DurableCursor, FromCursor, type DurableCursorType, type DurableQueryIterable } from '../../process/primitives.js';
import { attachSystemFields, extractKey, getVersion, MEM_CREATED_AT } from './in-memory-repository.js';

/** Default poll interval in milliseconds */
const DEFAULT_POLL_INTERVAL = 1000;

/**
 * In-memory implementation of ScheduledTaskRepository.
 *
 * Features:
 * - Stores tasks in memory (not durable across restarts)
 * - Polling-based subscription with configurable interval
 * - Simple exactly-once semantics via status transition
 */
export class InMemoryScheduledTaskRepository extends ScheduledTaskRepository {
  private readonly store = new Map<string, Persistent<ScheduledTask>>();
  private readonly idGenerator: () => string;

  constructor(options: { idGenerator?: () => string } = {}) {
    super();
    this.idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Scheduling Methods
  // ─────────────────────────────────────────────────────────────────────────

  async schedule<TPayload = unknown>(
    options: ScheduleOptions<TPayload>
  ): Promise<Persistent<ScheduledTask>> {
    const id = this.idGenerator();
    const now = new Date();

    const task = {
      dueAt: options.dueAt,
      namespace: options.namespace,
      type: options.type,
      payload: options.payload,
      status: ScheduledTaskStatus.Pending,
      startedAt: undefined,
      completedAt: undefined,
      error: undefined,
      [PERSISTENT]: true,
    } as unknown as Persistent<ScheduledTask>;

    attachSystemFields(task as unknown as Record<string | symbol, unknown>, id, now, now, 1);
    this.store.set(id, task);
    return task;
  }

  async cancel(taskId: string): Promise<boolean> {
    const task = this.store.get(taskId);
    if (!task || task.status !== ScheduledTaskStatus.Pending) {
      return false;
    }

    const now = new Date();
    const taskAny = task as unknown as Record<string | symbol, unknown>;
    const version = getVersion(taskAny);
    const updated = {
      ...task,
      status: ScheduledTaskStatus.Cancelled,
      completedAt: now,
      [PERSISTENT]: true,
    } as unknown as Persistent<ScheduledTask>;

    attachSystemFields(
      updated as unknown as Record<string | symbol, unknown>,
      taskId,
      taskAny[MEM_CREATED_AT] as Date,
      now,
      version + 1,
    );
    this.store.set(taskId, updated);
    return true;
  }

  async *subscribe(
    qualifiedName: string,
    options?: SubscribeOptions
  ): AsyncIterable<Persistent<ScheduledTask>> {
    const [namespace, type] = qualifiedName.split('.');
    if (!namespace || !type) {
      throw new Error(`Invalid qualified name: ${qualifiedName}. Expected format: namespace.type`);
    }

    const pollInterval = options?.pollInterval ?? DEFAULT_POLL_INTERVAL;
    const signal = options?.signal;

    while (true) {
      // Check for abort
      if (signal?.aborted) {
        return;
      }

      // Find a due task
      const task = this.pickNextDueTask(namespace, type);

      if (task) {
        const taskAny = task as unknown as Record<string | symbol, unknown>;
        const taskId = taskAny[ADAPTER_KEY] as string;
        const version = getVersion(taskAny);

        // Mark as processing
        const now = new Date();
        const processing = {
          ...task,
          status: ScheduledTaskStatus.Processing,
          startedAt: now,
          [PERSISTENT]: true,
        } as unknown as Persistent<ScheduledTask>;
        attachSystemFields(
          processing as unknown as Record<string | symbol, unknown>,
          taskId,
          taskAny[MEM_CREATED_AT] as Date,
          now,
          version + 1,
        );
        this.store.set(taskId, processing);

        // Yield to the consumer
        yield processing;

        // Mark as completed after successful processing
        const processingAny = processing as unknown as Record<string | symbol, unknown>;
        const processingVersion = getVersion(processingAny);
        const completedNow = new Date();
        const completed = {
          ...processing,
          status: ScheduledTaskStatus.Completed,
          completedAt: completedNow,
          [PERSISTENT]: true,
        } as unknown as Persistent<ScheduledTask>;
        attachSystemFields(
          completed as unknown as Record<string | symbol, unknown>,
          taskId,
          processingAny[MEM_CREATED_AT] as Date,
          completedNow,
          processingVersion + 1,
        );
        this.store.set(taskId, completed);
      } else {
        // No task ready, wait before polling again
        await this.sleep(pollInterval, signal);
      }
    }
  }

  /**
   * Find and claim the next due task for a namespace.type.
   */
  private pickNextDueTask(namespace: string, type: string): Persistent<ScheduledTask> | null {
    const now = new Date();

    for (const task of this.store.values()) {
      if (
        task.namespace === namespace &&
        task.type === type &&
        task.status === ScheduledTaskStatus.Pending &&
        task.dueAt <= now
      ) {
        return task;
      }
    }

    return null;
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

  // ─────────────────────────────────────────────────────────────────────────
  // Standard Repository Methods (inherited from ModelRepository)
  // ─────────────────────────────────────────────────────────────────────────

  async find(options?: FindOptions<ScheduledTask>): Promise<Persistent<ScheduledTask>[]> {
    let results = Array.from(this.store.values());

    if (options?.where) {
      results = results.filter((entity) =>
        evaluateCondition(entity as unknown as Record<string, unknown>, options.where!)
      );
    }

    if (options?.orderBy) {
      results = sortEntities(results, options.orderBy as Record<string, 'asc' | 'desc'> | OrderByItem[]);
    }

    if (options?.offset) {
      results = results.slice(options.offset);
    }

    if (options?.limit !== undefined) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  async get(ref: Reference<unknown> | Persistent<ScheduledTask>): Promise<Persistent<ScheduledTask> | undefined> {
    const key = extractKey(ref as Reference<unknown> | Record<string | symbol, unknown>);
    return this.store.get(key);
  }

  async getMany(refs: (Reference<unknown> | Persistent<ScheduledTask>)[]): Promise<Persistent<ScheduledTask>[]> {
    const results: Persistent<ScheduledTask>[] = [];
    for (const ref of refs) {
      const key = extractKey(ref as Reference<unknown> | Record<string | symbol, unknown>);
      const entity = this.store.get(key);
      if (entity) results.push(entity);
    }
    return results;
  }

  async findOne(where: Condition): Promise<Persistent<ScheduledTask> | undefined> {
    for (const entity of this.store.values()) {
      if (evaluateCondition(entity as unknown as Record<string, unknown>, where)) {
        return entity;
      }
    }
    return undefined;
  }

  async count(where?: Condition): Promise<number> {
    if (!where) {
      return this.store.size;
    }

    let count = 0;
    for (const entity of this.store.values()) {
      if (evaluateCondition(entity as unknown as Record<string, unknown>, where)) {
        count++;
      }
    }
    return count;
  }

  async aggregate(agg: Aggregation, where?: Condition): Promise<number | null> {
    let entities = Array.from(this.store.values());

    if (where) {
      entities = entities.filter((entity) =>
        evaluateCondition(entity as unknown as Record<string, unknown>, where)
      );
    }

    return computeAggregation(entities, agg);
  }

  async insert(data: InsertData<ScheduledTask>): Promise<Persistent<ScheduledTask>> {
    const id = this.idGenerator();
    const now = new Date();

    const persisted = {
      ...data,
      [PERSISTENT]: true,
    } as unknown as Persistent<ScheduledTask>;
    attachSystemFields(persisted as unknown as Record<string | symbol, unknown>, id, now, now, 1);

    this.store.set(id, persisted);
    return persisted;
  }

  async insertMany(data: InsertData<ScheduledTask>[]): Promise<Persistent<ScheduledTask>[]> {
    const now = new Date();
    const results: Persistent<ScheduledTask>[] = [];

    for (const item of data) {
      const id = this.idGenerator();
      const persisted = {
        ...item,
        [PERSISTENT]: true,
      } as unknown as Persistent<ScheduledTask>;
      attachSystemFields(persisted as unknown as Record<string | symbol, unknown>, id, now, now, 1);

      this.store.set(id, persisted);
      results.push(persisted);
    }

    return results;
  }

  async lock(
    entity: unknown | Promise<Persistent<ScheduledTask> | null | undefined>,
    _options?: LockOptions,
  ): Promise<Locked<ScheduledTask> | null> {
    const resolved = await Promise.resolve(entity);
    if (!resolved) return null;
    const id = extractKey(resolved as Reference<unknown> | Record<string | symbol, unknown>);
    const fresh = this.store.get(id);
    if (!fresh) return null;

    const metadata: LockMetadata = {
      lockedAt: new Date(),
      expiresAt: new Date(Date.now() + (_options?.ttl ?? 30000)),
      lockedBy: 'inmemory-scheduled',
    };
    const locked = Object.create(fresh as object, {
      __lock: { value: metadata, writable: false, enumerable: false, configurable: false },
      [Symbol.dispose]: { value: () => {}, writable: false, enumerable: false, configurable: false },
    });
    return locked as Locked<ScheduledTask>;
  }

  async update(
    entity: Locked<ScheduledTask>,
    data: UpdateData<ScheduledTask>,
  ): Promise<Persistent<ScheduledTask>> {
    const id = extractKey(entity as unknown as Record<string | symbol, unknown>);
    const existing = this.store.get(id);
    if (!existing) {
      throw new Error(`Task not found: ${id}`);
    }

    const existingAny = existing as unknown as Record<string | symbol, unknown>;
    const existingVersion = getVersion(existingAny);

    const now = new Date();
    const updated = {
      ...existing,
      ...data,
      [PERSISTENT]: true,
    } as unknown as Persistent<ScheduledTask>;
    attachSystemFields(
      updated as unknown as Record<string | symbol, unknown>,
      id,
      existingAny[MEM_CREATED_AT] as Date,
      now,
      existingVersion + 1,
    );

    this.store.set(id, updated);
    return updated;
  }

  async save(
    entity: ScheduledTask | Transient<ScheduledTask> | Locked<ScheduledTask>
  ): Promise<Persistent<ScheduledTask>> {
    if (isLocked(entity)) {
      const data = { ...entity } as UpdateData<ScheduledTask>;
      return this.update(entity as Locked<ScheduledTask>, data);
    }

    return this.insert(entity as InsertData<ScheduledTask>);
  }

  async delete(entity: Locked<ScheduledTask>): Promise<boolean> {
    const id = extractKey(entity as unknown as Record<string | symbol, unknown>);
    return this.store.delete(id);
  }

  async deleteWhere(where: Condition): Promise<number> {
    const toDelete: string[] = [];

    for (const [id, entity] of this.store.entries()) {
      if (evaluateCondition(entity as unknown as Record<string, unknown>, where)) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      this.store.delete(id);
    }

    return toDelete.length;
  }

  iterate(options: FindOptions<ScheduledTask> & { orderBy: OrderBy<ScheduledTask> }): DurableQueryIterable<Persistent<ScheduledTask>> {
    return new InMemoryScheduledTaskDurableIterator(this, options) as unknown as DurableQueryIterable<Persistent<ScheduledTask>>;
  }

  async *stream(options?: FindOptions<ScheduledTask>): AsyncIterable<Persistent<ScheduledTask>> {
    const results = await this.find(options);
    for (const entity of results) {
      yield entity;
    }
  }

  async *streamBatches(
    options?: FindOptions<ScheduledTask> & { batchSize?: number }
  ): AsyncIterable<Persistent<ScheduledTask>[]> {
    const batchSize = options?.batchSize ?? 100;
    const results = await this.find(options);

    for (let i = 0; i < results.length; i += batchSize) {
      yield results.slice(i, i + batchSize);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Live Model Observation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Observe changes to a task.
   *
   * In the in-memory implementation, this is a no-op that returns an empty
   * async iterable. For real cross-instance observation, use a repository
   * backed by PostgreSQL or Redis with channel support.
   */
  async *observe(
    _entity: Persistent<ScheduledTask> | Reference<unknown>,
  ): AsyncGenerator<Persistent<ScheduledTask>> {
    // In-memory has no cross-process channels
    // This is a no-op - the generator never yields
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Utility Methods
  // ─────────────────────────────────────────────────────────────────────────

  /** Clear all tasks. */
  clear(): void {
    this.store.clear();
  }

  /** Get all tasks. */
  getAll(): Persistent<ScheduledTask>[] {
    return Array.from(this.store.values());
  }

  /** Get task count. */
  get size(): number {
    return this.store.size;
  }
}

class InMemoryScheduledTaskDurableIterator implements AsyncIterableIterator<Persistent<ScheduledTask>> {
  declare readonly __durableIterator: true;
  declare readonly __cursorType: Record<string, string | number>;
  declare readonly orderBy: string[];

  private inner: DurableArrayIterator<Persistent<ScheduledTask>> | null = null;
  private loadPromise: Promise<Persistent<ScheduledTask>[]> | null = null;

  constructor(
    private readonly repo: InMemoryScheduledTaskRepository,
    private readonly options: FindOptions<ScheduledTask>,
  ) {}

  private async ensureLoaded(): Promise<DurableArrayIterator<Persistent<ScheduledTask>>> {
    if (!this.inner) {
      if (!this.loadPromise) {
        this.loadPromise = this.repo.find(this.options);
      }
      const results = await this.loadPromise;
      this.inner = new DurableArrayIterator(results);
    }
    return this.inner;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Persistent<ScheduledTask>> {
    return this;
  }

  async next(): Promise<IteratorResult<Persistent<ScheduledTask>>> {
    const it = await this.ensureLoaded();
    return it.next();
  }

  [DurableCursor](): DurableCursorType {
    if (!this.inner) return 0;
    return this.inner[DurableCursor]();
  }

  [FromCursor](cursor: DurableCursorType): AsyncIterableIterator<Persistent<ScheduledTask>> {
    const results = this.repo.getAll();
    return new DurableArrayIterator(results, cursor);
  }
}
