/**
 * In-Memory Repository
 *
 * A complete implementation of ModelRepository that stores entities in memory.
 * Useful for testing.
 */

import { ModelRepository } from '../model.repository.js';
import type {Persistent, Locked, Lock, Transient, InsertData, UpdateData, Ref} from '../types.js';
import { isPersistent, isLocked } from '../types.js';
import type { LockOptions, LockMetadata, LockProvider } from '../../features/lock/types.js';
import {
  DoubleLockError,
  LockReleasedError,
  getHeldLocks,
  _registerHeldLock,
  _unregisterHeldLock,
} from '../../features/lock/lock-service.js';
import { createInMemoryLockProvider } from '../../features/lock/memory.js';
import { PERSISTENT, ADAPTER_KEY } from '../symbols.js';
import type { Condition, FindOptions, Aggregation, OrderBy, OrderByItem } from '../query.js';
import { evaluateCondition, sortEntities, computeAggregation, type EvaluatorContext } from './condition-evaluator.js';
import type { FieldDef } from '../field.js';
import { type Reference, isReference, isReferences } from '../reference/reference.js';
import { DurableArrayIterator, DurableCursor, FromCursor, type DurableCursorType, type DurableQueryIterable } from '../../process/primitives.js';
import { MODEL_SERVICE, FIELD_STORAGE } from '../symbols.js';

// ============================================================================
// Adapter-internal symbols - invisible to domain code
// ============================================================================

/** Internal creation timestamp - non-enumerable */
export const MEM_CREATED_AT = Symbol('inmemory:createdAt');
/** Internal update timestamp - non-enumerable */
export const MEM_UPDATED_AT = Symbol('inmemory:updatedAt');
/** Internal version for optimistic concurrency - non-enumerable */
export const MEM_VERSION = Symbol('inmemory:version');

/** System fields stored as non-enumerable symbol properties on persistent entities */
export interface InMemorySystemFields {
  readonly [ADAPTER_KEY]: string;
  readonly [MEM_CREATED_AT]: Date;
  readonly [MEM_UPDATED_AT]: Date;
  readonly [MEM_VERSION]: number;
}

/** Attach system fields as non-enumerable symbol properties */
export function attachSystemFields(
  entity: Record<string | symbol, unknown>,
  key: string,
  createdAt: Date,
  updatedAt: Date,
  version: number,
): void {
  Object.defineProperty(entity, ADAPTER_KEY, { value: key, enumerable: false, configurable: true, writable: true });
  Object.defineProperty(entity, MEM_CREATED_AT, { value: createdAt, enumerable: false, configurable: true, writable: true });
  Object.defineProperty(entity, MEM_UPDATED_AT, { value: updatedAt, enumerable: false, configurable: true, writable: true });
  Object.defineProperty(entity, MEM_VERSION, { value: version, enumerable: false, configurable: true, writable: true });
}

/** Extract the adapter key from a Reference or Persistent entity */
export function extractKey(refOrEntity: Reference<unknown> | Record<string | symbol, unknown>): string {
  if (isReference(refOrEntity)) {
    return refOrEntity.identifier;
  }
  const key = (refOrEntity as Record<symbol, unknown>)[ADAPTER_KEY];
  if (key === undefined) {
    const legacyId = (refOrEntity as Record<string, unknown>).id;
    if (legacyId !== undefined) return String(legacyId);
    throw new Error('Cannot extract key from entity - not a persistent in-memory entity');
  }
  return key as string;
}

/** Read version from an entity's adapter-internal symbol */
export function getVersion(entity: Record<string | symbol, unknown>): number {
  return (entity[MEM_VERSION] as number) ?? (entity as Record<string, unknown>).version as number ?? 0;
}

/**
 * Resolve ref/refs field values to FK strings for internal storage.
 *
 * When domain code passes `author: persistentUser` or `author: Reference`,
 * this extracts the FK string so the condition evaluator can find it.
 * Creates `${fieldName}Id` / `${fieldName}Ids` entries.
 */
function resolveRefFields(data: Record<string, unknown>, fieldDefs?: Record<string, FieldDef>): void {
  if (!fieldDefs) return;
  for (const [fieldName, def] of Object.entries(fieldDefs)) {
    const value = data[fieldName];
    if (value === null || value === undefined) continue;

    if (def.type === 'ref') {
      // Persistent entity → extract key for FK
      if (isPersistent(value)) {
        const key = (value as unknown as Record<symbol, unknown>)[ADAPTER_KEY] as string;
        if (key !== undefined) {
          data[`${fieldName}Id`] = key;
        }
      } else if (isReference(value)) {
        data[`${fieldName}Id`] = value.identifier;
      }
    } else if (def.type === 'refs') {
      // Array of persistent entities or References → extract keys
      if (isReferences(value)) {
        data[`${fieldName}Ids`] = [...value.identifiers];
      } else if (Array.isArray(value)) {
        const keys: string[] = [];
        for (const item of value) {
          if (isPersistent(item)) {
            const key = (item as unknown as Record<symbol, unknown>)[ADAPTER_KEY] as string;
            if (key !== undefined) keys.push(key);
          } else if (isReference(item)) {
            keys.push(item.identifier);
          }
        }
        if (keys.length > 0) data[`${fieldName}Ids`] = keys;
      }
    }
  }
}

/**
 * Extract the adapter key from a persistent entity.
 * Adapter-internal helper - not part of the public API.
 */
export function keyOf(entity: unknown): string {
  const rec = entity as Record<string | symbol, unknown>;
  const key = rec[ADAPTER_KEY];
  if (key !== undefined) return key as string;
  if (rec.id !== undefined) return String(rec.id);
  throw new Error('keyOf: entity has no adapter key');
}

/**
 * Extract the version from a persistent entity.
 * This is an infrastructure helper - use only in tests, adapters, or infrastructure code.
 */
export function versionOf(entity: unknown): number {
  return getVersion(entity as Record<string | symbol, unknown>);
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Copy all properties from a source object, including inherited enumerable properties.
 * This handles model instances where ref fields are defined as getters on the prototype.
 *
 * Object spread ({...obj}) only copies own properties, missing prototype getters.
 * for...in loops include inherited enumerable properties, capturing ref field values.
 */
function copyAllEnumerableProperties<T>(source: T): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key in source) {
    result[key] = (source as Record<string, unknown>)[key];
  }
  return result;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Function to resolve a related entity by ID.
 * Used for has() conditions in queries.
 */
export type RelationResolver = (refId: string, fieldDef: FieldDef) => Record<string, unknown> | undefined;

/** Options for creating an InMemoryRepository */
export interface InMemoryRepositoryOptions {
  /**
   * Custom ID generator function.
   * Default: crypto.randomUUID()
   */
  idGenerator?: () => string

  /**
   * Initial data to populate the repository.
   * Useful for seeding test data.
   */
  initialData?: Array<{ id?: string } & Record<string, unknown>>

  /**
   * Field definitions for the model.
   * Required for has() conditions to understand ref fields.
   */
  fieldDefs?: Record<string, FieldDef>

  /**
   * Function to resolve related entities for has() conditions.
   * Called with the ref ID and field definition.
   */
  relationResolver?: RelationResolver

  /**
   * Function to get field definitions for a related model from a ref field.
   * Required for nested has() conditions that traverse multiple relationships.
   * Called with the ref field definition (use refTarget to get the model).
   */
  getFieldDefsForRef?: (fieldDef: FieldDef) => Record<string, FieldDef> | undefined

  /**
   * Model class for prototype-based entity creation.
   * When provided, entities are created via Object.create(modelService)
   * so that class methods and inject deps are available on instances.
   */
  modelClass?: { prototype: object; [key: symbol]: unknown }

  /**
   * Human-readable name of the model, used as part of the lock key
   * (`repo:${modelName}:${id}`). Defaults to a per-instance UUID prefix
   * if not provided — locks still serialize correctly within one repo,
   * just with opaque keys. Pass `modelName` for diagnostic clarity.
   */
  modelName?: string

  /**
   * LockProvider used to serialize concurrent `lock()` calls on the
   * same entity. Default: per-instance `createInMemoryLockProvider()`,
   * which serializes within this repo only. Pass a shared provider
   * to coordinate across multiple repos in the same process.
   */
  lockProvider?: LockProvider
}

// ============================================================================
// Repository Implementation
// ============================================================================

/**
 * In-memory implementation of Repository.
 *
 * Features:
 * - Full condition evaluation (all query operators)
 * - Sorting with OrderBy support
 * - Aggregations (count, sum, avg, min, max)
 * - Optimistic concurrency via version checking
 * - Streaming with async iterables
 *
 * @typeParam T - The entity type
 */
export class InMemoryRepository<T> extends ModelRepository<T> {
  protected readonly store = new Map<string, Persistent<T>>();
  private readonly idGenerator: () => string;
  private readonly evaluatorCtx: EvaluatorContext | undefined;
  private readonly modelClass?: { prototype: object; [key: symbol]: unknown };
  /** Mutex backend serialising concurrent `lock()` calls on the same row. */
  private readonly lockProvider: LockProvider;
  /** Stable per-repo identity used as the LockProvider's `instanceId`. */
  private readonly lockInstanceId: string = crypto.randomUUID();
  /** Lock-key namespace — `repo:${keyPrefix}:${id}`. */
  private readonly keyPrefix: string;

  constructor(options: InMemoryRepositoryOptions = {}) {
    super();
    this.idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.modelClass = options.modelClass;
    this.lockProvider = options.lockProvider ?? createInMemoryLockProvider();
    this.keyPrefix = options.modelName ?? `anon:${this.lockInstanceId}`;

    // Create evaluator context if relation resolver is provided
    if (options.relationResolver || options.fieldDefs) {
      this.evaluatorCtx = {
        resolveRef: options.relationResolver,
        fieldDefs: options.fieldDefs,
        getFieldDefsForRef: options.getFieldDefsForRef,
      };
    }

    // Seed initial data
    if (options.initialData) {
      for (const item of options.initialData) {
        const id = item.id ?? this.idGenerator();
        const now = new Date();
        const copied = copyAllEnumerableProperties(item);
        delete copied.id;
        const persisted = this.createEntity(copied);
        attachSystemFields(persisted as Record<string | symbol, unknown>, id, now, now, 1);
        this.store.set(id, persisted);
      }
    }
  }

  /**
   * Create a persistent entity with the model's prototype chain.
   * If a model class is provided, entities get class methods and inject deps via prototype.
   */
  private createEntity(data: Record<string, unknown>): Persistent<T> {
    const modelService = this.modelClass?.[MODEL_SERVICE as symbol] as object | undefined;
    const proto = modelService ?? this.modelClass?.prototype ?? null;

    if (proto) {
      const entity = Object.create(proto);
      // Set up FIELD_STORAGE for ref field getters/setters
      Object.defineProperty(entity, FIELD_STORAGE, { value: {}, enumerable: false, writable: false });
      // Copy data - goes through setters for ref fields on the prototype
      for (const [key, value] of Object.entries(data)) {
        entity[key] = value;
      }
      Object.defineProperty(entity, PERSISTENT, { value: true, enumerable: false, configurable: true });
      return entity as Persistent<T>;
    }

    // Fallback: plain object (no model class provided)
    return { ...data, [PERSISTENT]: true } as Persistent<T>;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Query Methods
  // ─────────────────────────────────────────────────────────────────────────

  async find(options?: FindOptions<T>): Promise<Persistent<T>[]> {
    let results = Array.from(this.store.values());

    // Filter by condition
    if (options?.where) {
      results = results.filter((entity) =>
        evaluateCondition(entity as unknown as Record<string, unknown>, options.where!, this.evaluatorCtx),
      );
    }

    // Sort
    if (options?.orderBy) {
      results = sortEntities(results, options.orderBy as Record<string, 'asc' | 'desc'> | OrderByItem[]);
    }

    // Offset
    if (options?.offset) {
      results = results.slice(options.offset);
    }

    // Limit
    if (options?.limit !== undefined) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  async get(ref: Ref<T>): Promise<Persistent<T> | undefined> {
    const key = extractKey(ref as Reference<unknown> | Record<string | symbol, unknown>);
    return this.store.get(key);
  }

  async getMany(refs: (Ref<T>)[]): Promise<Persistent<T>[]> {
    const results: Persistent<T>[] = [];
    for (const ref of refs) {
      const key = extractKey(ref as Reference<unknown> | Record<string | symbol, unknown>);
      const entity = this.store.get(key);
      if (entity) results.push(entity);
    }
    return results;
  }

  async findOne(where: Condition): Promise<Persistent<T> | undefined> {
    for (const entity of this.store.values()) {
      if (evaluateCondition(entity as unknown as Record<string, unknown>, where, this.evaluatorCtx)) {
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
      if (evaluateCondition(entity as unknown as Record<string, unknown>, where, this.evaluatorCtx)) {
        count++;
      }
    }
    return count;
  }

  async aggregate(agg: Aggregation, where?: Condition): Promise<number | null> {
    let entities = Array.from(this.store.values());

    // Filter by condition
    if (where) {
      entities = entities.filter((entity) =>
        evaluateCondition(entity as unknown as Record<string, unknown>, where, this.evaluatorCtx),
      );
    }

    return computeAggregation(entities, agg);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Mutation Methods
  // ─────────────────────────────────────────────────────────────────────────

  private applyDefaults(copied: Record<string, unknown>): void {
    const fieldDefs = this.evaluatorCtx?.fieldDefs;
    if (!fieldDefs) return;
    for (const [key, def] of Object.entries(fieldDefs)) {
      if (copied[key] === undefined && def.defaultValue !== undefined) {
        copied[key] = typeof def.defaultValue === 'function' ? def.defaultValue() : def.defaultValue;
      }
    }
  }

  async insert(data: InsertData<T>): Promise<Persistent<T>> {
    const id = this.idGenerator();
    const now = new Date();

    const copied = copyAllEnumerableProperties(data);
    this.applyDefaults(copied);
    resolveRefFields(copied, this.evaluatorCtx?.fieldDefs);
    const persisted = this.createEntity(copied);
    attachSystemFields(persisted as Record<string | symbol, unknown>, id, now, now, 1);

    this.store.set(id, persisted);
    return persisted;
  }

  async insertMany(data: InsertData<T>[]): Promise<Persistent<T>[]> {
    const now = new Date();
    const results: Persistent<T>[] = [];

    for (const item of data) {
      const id = this.idGenerator();
      const copied = copyAllEnumerableProperties(item);
      this.applyDefaults(copied);
      resolveRefFields(copied, this.evaluatorCtx?.fieldDefs);
      const persisted = this.createEntity(copied);
      attachSystemFields(persisted as Record<string | symbol, unknown>, id, now, now, 1);

      this.store.set(id, persisted);
      results.push(persisted);
    }

    return results;
  }

  async lock(
    entity: Ref<T> | Lock<Persistent<T>> | Promise<Persistent<T> | null | undefined>,
    options?: LockOptions,
  ): Promise<Locked<T> | null> {
    // Extract ID without awaiting - References are PromiseLike and would try to resolve
    let id: string;
    if (isReference(entity)) {
      id = (entity as Reference<unknown>).identifier;
    } else {
      const resolved = await Promise.resolve(entity);
      if (!resolved) return null;
      id = extractKey(resolved as Reference<unknown> | Record<string | symbol, unknown>);
    }

    const key = `repo:${this.keyPrefix}:${id}`;

    // Re-entry guard — same async context double-locking the same row is a
    // design error (would deadlock under a real mutex).
    const heldKeys = getHeldLocks();
    if (heldKeys?.has(key)) {
      throw new DoubleLockError(key);
    }

    const ttl = options?.ttl ?? 30_000;
    const acquireOpts: Required<LockOptions> = {
      ttl,
      timeout: options?.timeout ?? 5_000,
      key,
      heartbeat: options?.heartbeat ?? false,
      heartbeatInterval: options?.heartbeatInterval ?? Math.floor(ttl / 3),
    };

    // Acquire the real mutex. This blocks until granted; only one async
    // context holds it at a time per (repo, id).
    const metadata = await this.lockProvider.acquire(
      key,
      acquireOpts,
      this.lockInstanceId,
    );
    _registerHeldLock(key);

    // Re-fetch under the lock so callers see committed state. If the row
    // was deleted between ID extraction and lock acquisition, release the
    // lock (no point holding a mutex on a non-existent row) and return null.
    const fresh = this.store.get(id);
    if (!fresh) {
      _unregisterHeldLock(key);
      await this.lockProvider.release(key, this.lockInstanceId);
      return null;
    }

    const lockProvider = this.lockProvider;
    const lockInstanceId = this.lockInstanceId;
    let active = true;

    const releaseSync = () => {
      if (!active) return;
      active = false;
      _unregisterHeldLock(key);
      // Fire-and-forget; mirrors LockServiceImpl back-compat behavior.
      lockProvider.release(key, lockInstanceId).catch(() => { /* TTL cleanup */ });
    };

    const releaseAsync = async () => {
      if (!active) return;
      active = false;
      _unregisterHeldLock(key);
      try {
        await lockProvider.release(key, lockInstanceId);
      } catch {
        // Mutex release failures are best-effort; TTL is the backstop.
      }
    };

    const locked = Object.create(fresh as object, {
      __lock: { value: metadata, enumerable: false, configurable: false },
      __active: { get: () => active, enumerable: false, configurable: false },
      [Symbol.dispose]: { value: releaseSync, enumerable: false, configurable: false },
      [Symbol.asyncDispose]: { value: releaseAsync, enumerable: false, configurable: false },
    });
    return locked as Locked<T>;
  }

  /**
   * Throw `LockReleasedError` if the caller passed a `Locked<T>` whose
   * mutex has already been released (e.g. stashed in an outer closure
   * and used after the `using` block exited). Returns the entity ID.
   */
  private requireActiveLock(
    entity: Locked<T>,
    op: 'update' | 'delete' | 'save',
  ): string {
    const active = (entity as unknown as { __active?: boolean }).__active;
    if (active === false) {
      const id = extractKey(entity as unknown as Record<string | symbol, unknown>);
      throw new LockReleasedError(`repo:${this.keyPrefix}:${id}`);
    }
    return extractKey(entity as unknown as Record<string | symbol, unknown>);
  }

  async update(entity: Locked<T>, data: UpdateData<T>): Promise<Persistent<T>> {
    const id = this.requireActiveLock(entity, 'update');
    const existing = this.store.get(id);
    if (!existing) {
      throw new Error(`Entity not found: ${id}`);
    }

    const existingVersion = getVersion(existing as unknown as Record<string | symbol, unknown>);
    const existingAny = existing as unknown as Record<string | symbol, unknown>;
    const now = new Date();
    const copiedData = copyAllEnumerableProperties(data);
    resolveRefFields(copiedData, this.evaluatorCtx?.fieldDefs);
    const merged = { ...copyAllEnumerableProperties(existing), ...copiedData };
    const updated = this.createEntity(merged);
    attachSystemFields(
      updated as Record<string | symbol, unknown>,
      id,
      existingAny[MEM_CREATED_AT] as Date,
      now,
      existingVersion + 1,
    );

    this.store.set(id, updated);
    return updated;
  }

  async save(entity: T | Transient<T> | Locked<T>): Promise<Persistent<T>> {
    // Locked entity → update (active-lock check happens inside update())
    if (isLocked(entity)) {
      const data = copyAllEnumerableProperties(entity);
      return this.update(entity as Locked<T>, data as UpdateData<T>);
    }

    // Otherwise → insert as new
    return this.insert(entity as InsertData<T>);
  }

  async delete(entity: Locked<T>): Promise<boolean> {
    const id = this.requireActiveLock(entity, 'delete');
    return this.store.delete(id);
  }

  async deleteWhere(where: Condition): Promise<number> {
    let count = 0;
    const toDelete: string[] = [];

    for (const [id, entity] of this.store.entries()) {
      if (evaluateCondition(entity as unknown as Record<string, unknown>, where, this.evaluatorCtx)) {
        toDelete.push(id);
        count++;
      }
    }

    for (const id of toDelete) {
      this.store.delete(id);
    }

    return count;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Durable Iteration
  // ─────────────────────────────────────────────────────────────────────────

  iterate(options: FindOptions<T> & { orderBy: OrderBy<T> }): DurableQueryIterable<Persistent<T>> {
    return new InMemoryDurableIterator(this, options) as unknown as DurableQueryIterable<Persistent<T>>;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Streaming Methods
  // ─────────────────────────────────────────────────────────────────────────

  async *stream(options?: FindOptions<T>): AsyncIterable<Persistent<T>> {
    const results = await this.find(options);
    for (const entity of results) {
      yield entity;
    }
  }

  async *streamBatches(
    options?: FindOptions<T> & { batchSize?: number },
  ): AsyncIterable<Persistent<T>[]> {
    const batchSize = options?.batchSize ?? 100;
    const results = await this.find(options);

    for (let i = 0; i < results.length; i += batchSize) {
      yield results.slice(i, i + batchSize);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Utility Methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Clear all entities from the repository.
   * Useful for testing.
   */
  clear(): void {
    this.store.clear();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Live Model Observation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Observe changes to an entity.
   *
   * In the in-memory implementation, this is a no-op that returns an empty
   * async iterable. For real cross-instance observation, use a repository
   * backed by PostgreSQL or Redis with channel support.
   *
   * @example
   * ```typescript
   * const user = await userRepo.get(User.ref`123`);
   *
   * // In-memory: this will never yield (no cross-process channels)
   * for await (const _ of userRepo.observe(user)) {
   *   console.log('User updated');
   * }
   * ```
   */
  async *observe(
    entity: Ref<T>,
  ): AsyncGenerator<Persistent<T>> {
    // Get the entity ID
    const id = extractKey(entity as Reference<unknown> | Record<string | symbol, unknown>);

    if (!id) {
      throw new Error('Cannot observe an entity without an ID');
    }

    // In-memory has no cross-process channels
    // This is a no-op - the generator never yields
    // For real observation, use PgRepository with channels
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Testing Utilities
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get all entities in the repository.
   * Useful for debugging/testing.
   */
  getAll(): Persistent<T>[] {
    return Array.from(this.store.values());
  }

  /**
   * Get the number of entities in the repository.
   */
  get size(): number {
    return this.store.size;
  }

  /**
   * Seed the repository with data.
   * Replaces existing entities with matching keys.
   */
  seed(data: Array<Partial<T> & { id?: string }>): void {
    const now = new Date();
    for (const item of data) {
      const id = item.id ?? this.idGenerator();
      const existing = this.store.get(id);
      const existingAny = existing as unknown as Record<string | symbol, unknown> | undefined;
      // Use copyAllEnumerableProperties to capture ref field values from prototype getters
      const copied = copyAllEnumerableProperties(item);
      delete copied.id; // Remove legacy id from domain data
      resolveRefFields(copied, this.evaluatorCtx?.fieldDefs);
      const persisted = {
        ...copied,
        [PERSISTENT]: true,
      } as Persistent<T>;
      attachSystemFields(
        persisted as Record<string | symbol, unknown>,
        id,
        existingAny?.[MEM_CREATED_AT] as Date ?? now,
        now,
        existing ? getVersion(existingAny!) + 1 : 1,
      );
      this.store.set(id, persisted);
    }
  }

  /**
   * Create a snapshot of the current repository state.
   * Returns a new Map with cloned entities (including adapter-internal symbols).
   */
  snapshot(): Map<string, Persistent<T>> {
    const result = new Map<string, Persistent<T>>();
    for (const [id, entity] of this.store) {
      const clone = { ...entity, [PERSISTENT]: true } as Persistent<T>;
      const src = entity as unknown as Record<string | symbol, unknown>;
      // Copy non-enumerable adapter symbols
      attachSystemFields(
        clone as Record<string | symbol, unknown>,
        src[ADAPTER_KEY] as string,
        src[MEM_CREATED_AT] as Date,
        src[MEM_UPDATED_AT] as Date,
        src[MEM_VERSION] as number,
      );
      result.set(id, clone);
    }
    return result;
  }

  /**
   * Restore repository state from a snapshot.
   */
  restore(snapshot: Map<string, Persistent<T>>): void {
    this.store.clear();
    for (const [id, entity] of snapshot) {
      const clone = { ...entity, [PERSISTENT]: true } as Persistent<T>;
      const src = entity as unknown as Record<string | symbol, unknown>;
      attachSystemFields(
        clone as Record<string | symbol, unknown>,
        src[ADAPTER_KEY] as string,
        src[MEM_CREATED_AT] as Date,
        src[MEM_UPDATED_AT] as Date,
        src[MEM_VERSION] as number,
      );
      this.store.set(id, clone);
    }
  }
}

// ============================================================================
// Durable Iterator for In-Memory
// ============================================================================

/**
 * Wraps InMemoryRepository.find() results in a DurableArrayIterator.
 * Lazily loads data on first iteration.
 */
class InMemoryDurableIterator<T> implements AsyncIterableIterator<Persistent<T>> {
  declare readonly __durableIterator: true;
  declare readonly __cursorType: Record<string, string | number>;
  declare readonly orderBy: string[];

  private inner: DurableArrayIterator<Persistent<T>> | null = null;
  private loadPromise: Promise<Persistent<T>[]> | null = null;
  private resumeCursor: DurableCursorType | null = null;

  constructor(
    private readonly repo: InMemoryRepository<T>,
    private readonly options: FindOptions<T>,
  ) {}

  private async ensureLoaded(): Promise<DurableArrayIterator<Persistent<T>>> {
    if (!this.inner) {
      if (!this.loadPromise) {
        this.loadPromise = this.repo.find(this.options);
      }
      const results = await this.loadPromise;
      if (!this.inner) {
        this.inner = new DurableArrayIterator(results, this.resumeCursor ?? undefined);
      }
    }
    return this.inner;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Persistent<T>> {
    return this;
  }

  async next(): Promise<IteratorResult<Persistent<T>>> {
    const it = await this.ensureLoaded();
    return it.next();
  }

  [DurableCursor](): DurableCursorType {
    if (!this.inner) return 0;
    return this.inner[DurableCursor]();
  }

  [FromCursor](cursor: DurableCursorType): AsyncIterableIterator<Persistent<T>> {
    // On resume, re-query with same filter/order and skip to cursor position
    const resumed = new InMemoryDurableIterator(this.repo, this.options);
    resumed.resumeCursor = cursor;
    return resumed;
  }
}
