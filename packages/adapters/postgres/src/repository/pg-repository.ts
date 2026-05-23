/**
 * PostgreSQL Repository
 *
 * A typed repository implementation for PostgreSQL that:
 * - Uses the query compiler to translate Condition AST to SQL
 * - Supports both columnar and JSONB storage modes
 * - Works with models defined via defineModel()
 *
 * @example
 * ```typescript
 * class User extends defineModel({
 *   email: field.string().max(255),
 *   name: field.string(),
 *   status: field.enum('UserStatus', ['active', 'inactive'] as const),
 * }) {}
 *
 * const userRepo = new PgRepository(client, User, {
 *   tableName: 'users',
 *   storageMode: 'columnar',
 * });
 *
 * // Find with typed conditions
 * const activeUsers = await userRepo.find({
 *   where: User.fields.status.eq('active'),
 *   orderBy: { createdAt: 'desc' },
 *   limit: 10,
 * });
 * ```
 */

import { randomUUID } from 'node:crypto';
import {
  type ChannelsInstance,
  REPO_BRAND,
  DoubleLockError,
  LockReleasedError,
  getHeldLocks,
  _registerHeldLock,
  _unregisterHeldLock,
} from '@justscale/core';
import {
  registerModelRefResolver,
} from '@justscale/core/models';
import type {
  Aggregation,
  AnyModel,
  Condition,
  FieldDef,
  FindOptions,
  InsertData,
  Locked,
  ModelClass,
  ModelData,
  OrderBy,
  Ref,
  UpdateData,
} from '@justscale/core/models';
import type { LockOptions, LockMetadata, LockProvider } from '@justscale/core';
import { createInMemoryLockProvider } from '@justscale/core/memory';
import type { DurableQueryIterable } from '@justscale/core/process';
import { PgQueryBuilder } from '../query/pg-query-builder.js';
import { PgQueryIterator } from '../query/query-iterator.js';
import {
  type Persistent,
  Reference,
  type ReferenceResolver,
  References,
  SET_RESOLVER,
  HYDRATE,
  SET_STREAM_CHANNEL,
  SET_STREAM_SIGNAL_EMITTER,
  StreamImpl,
  PERSISTENT,
  ADAPTER_KEY,
  isPersistent,
  getModelFields,
  getModelName,
  isReference,
  isReferences,
  isLocked,
  isStream,
  MODEL_SERVICE,
  FIELD_STORAGE,
} from '@justscale/core/models';
import {
  type SignalBus,
  modelNameToIdentityKey,
  buildStreamSignal,
} from '@justscale/core/process';
import type { JSONValue } from 'postgres';
import type { AbstractPostgresClient } from '../client/client.js';
import { DataLoader } from '../query/dataloader.js';
import { ModelRegistry } from '../model/model-registry.js';
import type { ModelChangeEvent } from './pg-repository-service.js';
import {
  PgQueryCompiler,
  type PgQueryCompilerOptions,
  type StorageMode,
} from '../query/query-compiler.js';


/** Options for creating a PgRepository */
export interface PgRepositoryOptions {
  /** Table name in the database */
  tableName: string

  /**
   * Storage mode for the repository.
   * - 'columnar': Fields map directly to columns
   * - 'jsonb': Fields stored in a JSONB data column
   */
  storageMode?: StorageMode

  /**
   * JSONB data column name (for 'jsonb' mode).
   * Default: 'data'
   */
  dataColumn?: string

  /**
   * Convert camelCase to snake_case for column names.
   * Default: true
   */
  snakeCase?: boolean

  /**
   * Custom field to column mapping.
   */
  fieldMap?: Record<string, string>

  /**
   * System fields stored as columns (not in JSONB).
   * Default: ['id', 'createdAt', 'updatedAt', 'version']
   */
  systemFields?: string[]

  /**
   * Lazy resolver for signal bus.
   * Resolves the signal bus on first use to avoid circular dependency
   * (SignalSubscriptionRepository is created before SignalBusService).
   */
  getSignalBus?: () => Promise<SignalBus | undefined>
}

/** System fields added to persisted entities */
export interface SystemFields {
  id: string
  createdAt: Date
  updatedAt: Date
  version: number
}

// Re-export Persistent from @justscale/core/models for backwards compatibility
export { Persistent };

// ============================================================================
// Adapter-internal symbols - invisible to domain code
// ============================================================================

/** Internal creation timestamp - non-enumerable */
export const PG_CREATED_AT = Symbol('pg:createdAt');
/** Internal update timestamp - non-enumerable */
export const PG_UPDATED_AT = Symbol('pg:updatedAt');
/** Internal version for optimistic concurrency - non-enumerable */
export const PG_VERSION = Symbol('pg:version');

/** System fields stored as non-enumerable symbol properties on persistent entities */
export interface PgSystemFields {
  readonly [ADAPTER_KEY]: string;
  readonly [PG_CREATED_AT]: Date;
  readonly [PG_UPDATED_AT]: Date;
  readonly [PG_VERSION]: number;
}

// LIMIT/OFFSET land in raw SQL via string interpolation. The TypeScript
// signature claims `number`, but `repo.find({ limit: req.query.limit as any })`
// or a bypassed type can route a string here. Reject anything that isn't a
// non-negative safe integer so a caller can't smuggle SQL through arithmetic
// that postgres-js sees as "a number string".
export function assertNonNegativeInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || !Number.isFinite(value)) {
    throw new TypeError(
      `${name} must be a non-negative integer, got ${typeof value === 'number' ? value : typeof value}`,
    );
  }
  return value;
}

/** Attach system fields as non-enumerable symbol properties */
function attachSystemFields(
  entity: Record<string | symbol, unknown>,
  key: string,
  createdAt: Date,
  updatedAt: Date,
  version: number,
): void {
  Object.defineProperty(entity, ADAPTER_KEY, { value: key, enumerable: false, configurable: true, writable: true });
  Object.defineProperty(entity, PG_CREATED_AT, { value: createdAt, enumerable: false, configurable: true, writable: true });
  Object.defineProperty(entity, PG_UPDATED_AT, { value: updatedAt, enumerable: false, configurable: true, writable: true });
  Object.defineProperty(entity, PG_VERSION, { value: version, enumerable: false, configurable: true, writable: true });
}

/** Extract the adapter key from a Reference or Persistent entity */
export function extractKey(refOrEntity: unknown): string {
  if (isReference(refOrEntity)) {
    return (refOrEntity as Reference<unknown>).identifier;
  }
  if (typeof refOrEntity === 'string') {
    return refOrEntity;
  }
  const key = (refOrEntity as Record<symbol, unknown>)[ADAPTER_KEY];
  if (key === undefined) {
    throw new Error('Cannot extract key from entity - not a persistent PG entity');
  }
  return key as string;
}

/** Read version from an entity's adapter-internal symbol */
function getVersion(entity: Record<string | symbol, unknown>): number {
  return (entity[PG_VERSION] as number) ?? 0;
}

/**
 * Extract the adapter key from a persistent entity.
 * Infrastructure helper - use only in tests, adapters, or infrastructure code.
 */
export function keyOf(entity: unknown): string {
  const rec = entity as Record<string | symbol, unknown>;
  const key = rec[ADAPTER_KEY];
  if (key !== undefined) return key as string;
  throw new Error('keyOf: entity has no adapter key');
}

/**
 * Extract the version from a persistent entity.
 * Infrastructure helper - use only in tests, adapters, or infrastructure code.
 */
export function versionOf(entity: unknown): number {
  return getVersion(entity as Record<string | symbol, unknown>);
}

/** Query result with count */
export interface CountResult {
  count: number
}


/**
 * PostgreSQL repository with typed query support.
 *
 * Parameterized by the instance type to preserve named types:
 * - `PgRepository<User>` instead of `PgRepository<{ email: string; ... }>`
 */
export class PgRepository<T> {
  /** Brand to distinguish Repository from plain objects in type checking */
  readonly [REPO_BRAND] = true as const;

  private readonly client: AbstractPostgresClient;
  private readonly tableName: string;
  private readonly storageMode: StorageMode;
  private readonly dataColumn: string;
  private readonly compiler: PgQueryCompiler;
  private readonly modelName: string;
  private readonly fieldDefs: Record<string, unknown>;
  private readonly model: AnyModel;
  private readonly channels?: ChannelsInstance<ModelChangeEvent>;
  private readonly getSignalBus?: () => Promise<SignalBus | undefined>;
  private cachedSignalBus?: SignalBus;
  private readonly fieldMap: Record<string, string>;
  /** Mutex backend serialising concurrent `lock()` calls on the same row. */
  private readonly lockProvider: LockProvider;
  /** Stable per-repo identity used as the LockProvider's `instanceId`. */
  private readonly lockInstanceId: string = randomUUID();

  constructor(
    client: AbstractPostgresClient,
    model: AnyModel,
    options: PgRepositoryOptions,
    channels?: ChannelsInstance<ModelChangeEvent>,
    lockProvider?: LockProvider,
  ) {
    this.client = client;
    this.model = model;
    this.tableName = options.tableName;
    this.storageMode = options.storageMode ?? 'columnar';
    this.dataColumn = options.dataColumn ?? 'data';
    this.modelName = getModelName(model);
    this.fieldDefs = getModelFields(model);
    // If wired via DI (createPgRepository), the LockProvider is injected
    // — typically PostgresLockProvider with cluster-wide pg_advisory_lock.
    // Direct instantiation (tests, programmatic use) gets a per-instance
    // in-memory provider so concurrent lock() within this process serializes
    // correctly even without DI plumbing.
    this.lockProvider = lockProvider ?? createInMemoryLockProvider();
    this.channels = channels;
    this.getSignalBus = options.getSignalBus;

    // Build field map (snake_case by default)
    // Only include non-system fields in columnar mode (JSONB uses data->>'field' paths)
    const snakeCase = options.snakeCase ?? true;
    const fieldMap = options.fieldMap ?? {};
    const builtFieldMap: Record<string, string> = {};

    // Only build explicit field map for columnar mode
    // In JSONB mode, the compiler handles non-system fields via JsonPath
    if (this.storageMode === 'columnar') {
      for (const fieldName of Object.keys(this.fieldDefs)) {
        if (fieldName in fieldMap) {
          builtFieldMap[fieldName] = fieldMap[fieldName];
        } else if (snakeCase) {
          builtFieldMap[fieldName] = this.toSnakeCase(fieldName);
        } else {
          builtFieldMap[fieldName] = fieldName;
        }
      }
    } else {
      // In JSONB mode, only use explicit overrides from user
      Object.assign(builtFieldMap, fieldMap);
    }

    this.fieldMap = builtFieldMap;

    // Register this model in the global registry (for has() condition support)
    ModelRegistry.register({
      modelName: this.modelName,
      model: model as unknown as ModelClass<unknown>,
      tableName: this.tableName,
      storageMode: this.storageMode,
      fieldMap: builtFieldMap,
      fieldDefs: this.fieldDefs as Record<string, FieldDef>,
    });

    // Register ref resolver so typed params (HTTP/process) can await references
    registerModelRefResolver(model as unknown as ModelClass<unknown>, this.createRefResolver(model));

    // Create compiler with matching options and model context
    const compilerOptions: PgQueryCompilerOptions = {
      storageMode: this.storageMode,
      dataColumn: this.dataColumn,
      snakeCase,
      tableName: this.tableName,
      fieldMap: builtFieldMap,
      systemFields: options.systemFields,
      modelContext: {
        modelName: this.modelName,
        fieldDefs: this.fieldDefs as Record<string, FieldDef>,
      },
    };

    this.compiler = new PgQueryCompiler(compilerOptions);
  }

  // -------------------------------------------------------------------------
  // Query Methods
  // -------------------------------------------------------------------------

  /**
   * Find entities matching the given options.
   *
   * @example
   * ```typescript
   * // Basic find
   * const posts = await postRepo.find({ where: Post.fields.status.eq('published') });
   *
   * // Eager load references
   * const posts = await postRepo.find({
   *   where: Post.fields.author.has(Author.fields.name.eq('John')),
   *   load: ['author'],  // Eager load author reference
   * });
   * // posts[0].author is pre-populated, no lazy load needed
   * ```
   */
  async find(options?: FindOptions<ModelData<T>>): Promise<Persistent<T>[]> {
    const sql = this.client.sql;
    const parts: string[] = [`SELECT * FROM ${this.tableName}`];
    const values: unknown[] = [];

    // WHERE clause
    if (options?.where) {
      const compiled = this.compiler.compileWhere(options.where);
      parts.push(`WHERE ${compiled.text}`);
      values.push(...compiled.values);
    }

    // ORDER BY clause
    if (options?.orderBy) {
      const compiled = this.compiler.compileOrderBy(options.orderBy);
      if (compiled.text) {
        parts.push(`ORDER BY ${compiled.text}`);
      }
    }

    // LIMIT / OFFSET — interpolated as integers into raw SQL. Type-only
    // checks aren't enough: a caller bypassing types via `as any` could
    // smuggle SQL through, so reject anything that isn't a non-negative
    // safe integer at runtime.
    if (options?.limit !== undefined) {
      parts.push(`LIMIT ${assertNonNegativeInt(options.limit, 'limit')}`);
    }
    if (options?.offset !== undefined) {
      parts.push(`OFFSET ${assertNonNegativeInt(options.offset, 'offset')}`);
    }

    const query = parts.join(' ');
    const result = await sql.unsafe(
      query,
      values as (string | number | boolean | Date | null)[],
    );

    // Convert rows to entities first (without hydrating references yet)
    // Track which entities are new vs cached for stream hydration
    const newEntityIds = new Set<string>();
    const entities = result.map((row) => {
      const entity = this.rowToEntityRaw(row as Record<string, unknown>);
      const id = extractKey(entity as unknown as Record<string | symbol, unknown>);

      // Check identity map first - if entity exists, return cached instance
      const cached = this.client.getFromIdentityMap<Persistent<T>>(
        this.tableName,
        id,
      );
      if (cached) {
        return cached;
      }

      // Store new entity in identity map (raw, before hydration)
      this.client.storeInIdentityMap(this.tableName, id, entity);
      newEntityIds.add(id);
      return entity;
    });

    // Eager load references if requested
    // Use a local cache since identity map only works in transactions
    let eagerCache: Map<string, object> | undefined;
    if (options?.load) {
      eagerCache = await this.eagerLoadRefs(entities, options.load);
    }

    // Hydrate references for all entities (including cached, for eager load benefit)
    // But only hydrate streams for new entities (cached already have streams)
    for (const entity of entities) {
      const id = extractKey(entity as unknown as Record<string | symbol, unknown>);
      this.hydrateReferences(entity as Record<string, unknown>, eagerCache);
      if (newEntityIds.has(id)) {
        this.hydrateStreams(entity as Record<string, unknown>, id);
      }
    }

    return entities;
  }

  /**
   * Create a durable iterator for process for-of loops.
   * Uses keyset pagination to support suspend/resume.
   */
  iterate(options: FindOptions<ModelData<T>> & { orderBy: OrderBy<ModelData<T>> }): DurableQueryIterable<Persistent<T>> {
    const uniqueFields = this.getUniqueFields();
    const builder = new PgQueryBuilder<Record<string, unknown>>(
      this.client,
      this.tableName,
      this.compiler,
      uniqueFields,
      options.where,
      options.orderBy,
    );
    return new PgQueryIterator(
      builder,
      100,
      (row) => this.rowToEntity(row as Record<string, unknown>) as unknown as Record<string, unknown>,
    ) as unknown as DurableQueryIterable<Persistent<T>>;
  }

  /**
   * Get the set of fields that have unique constraints.
   * Always includes 'id'.
   */
  private getUniqueFields(): Set<string> {
    const fields = new Set<string>(['id']);
    for (const [fieldName, fieldDef] of Object.entries(this.fieldDefs)) {
      const def = fieldDef as FieldDef;
      if (def.unique) {
        // Use the SQL column name for consistency with the query builder
        fields.add(this.toSnakeCase(fieldName));
      }
    }
    return fields;
  }

  /**
   * Find a single entity matching the condition.
   */
  async findOne(where: Condition): Promise<Persistent<T> | undefined> {
    const results = await this.find({ where, limit: 1 });
    return results[0];
  }

  /**
   * Count entities matching the condition.
   */
  async count(where?: Condition): Promise<number> {
    const sql = this.client.sql;
    let result: Array<{ count: string }>;

    if (where) {
      const compiled = this.compiler.compileWhere(where);
      const query = `SELECT COUNT(*) as count FROM ${this.tableName} WHERE ${compiled.text}`;
      result = await sql.unsafe(
        query,
        compiled.values as (string | number | boolean | Date | null)[],
      );
    } else {
      result = await sql`
        SELECT COUNT(*) as count FROM ${sql(this.tableName)}
      `;
    }

    return Number.parseInt(result[0].count, 10);
  }

  /**
   * Check if any entity matches the condition.
   */
  async exists(where: Condition): Promise<boolean> {
    const count = await this.count(where);
    return count > 0;
  }

  /**
   * Run an aggregation query.
   */
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

  // -------------------------------------------------------------------------
  // Mutation Methods
  // -------------------------------------------------------------------------

  /**
   * Insert a new entity.
   */
  async insert(data: InsertData<T>): Promise<Persistent<T>> {
    const sql = this.client.sql;
    const id = crypto.randomUUID();
    const now = new Date();

    if (this.storageMode === 'jsonb') {
      const result = await sql`
        INSERT INTO ${sql(this.tableName)} (id, ${sql(this.dataColumn)}, created_at, updated_at, version)
        VALUES (${id}, ${sql.json(data as JSONValue)}, ${now}, ${now}, 1)
        RETURNING *
      `;
      const entity = this.rowToEntity(result[0] as Record<string, unknown>);
      const entityId = extractKey(entity as unknown as Record<string | symbol, unknown>);
      // Store in identity map
      this.client.storeInIdentityMap(this.tableName, entityId, entity);
      return entity;
    }

    // Columnar mode - map fields to columns
    const columns = this.getColumnarColumns(data as unknown as Partial<ModelData<T>>);
    const columnNames = [
      'id',
      ...Object.keys(columns),
      'created_at',
      'updated_at',
      'version',
    ];
    const columnValues = [id, ...Object.values(columns), now, now, 1];

    const placeholders = columnValues.map((_, i) => `$${i + 1}`).join(', ');
    const query = `INSERT INTO ${this.tableName} (${columnNames.join(', ')}) VALUES (${placeholders}) RETURNING *`;

    const result = await sql.unsafe(
      query,
      columnValues as (string | number | boolean | Date | null)[],
    );
    const entity = this.rowToEntity(result[0] as Record<string, unknown>);
    const entityId = extractKey(entity as unknown as Record<string | symbol, unknown>);
    // Store in identity map
    this.client.storeInIdentityMap(this.tableName, entityId, entity);
    return entity;
  }

  /**
   * Acquire an exclusive lock on an entity and re-read it from the database.
   *
   * Holds an `AbstractLockProvider` mutex on `repo:${tableName}:${id}`
   * for the lifetime of the returned `Locked<T>`. Concurrent acquirers
   * (in this process or across cluster instances when wired with
   * PostgresLockProvider) block until release. The lock is released on
   * `Symbol.asyncDispose` (preferred — `await using`) or sync
   * `Symbol.dispose` (fire-and-forget).
   */
  async lock(
    entity: Ref<T> | Promise<Persistent<T> | null | undefined>,
    options?: LockOptions,
  ): Promise<Locked<T> | null> {
    // Extract ID without awaiting - References are PromiseLike and would try to resolve
    let id: string;
    if (isReference(entity)) {
      id = (entity as unknown as Reference<unknown>).identifier;
    } else {
      const resolved = await Promise.resolve(entity);
      if (!resolved) return null;
      id = typeof resolved === 'string'
        ? resolved
        : extractKey(resolved as unknown as Reference<unknown> | Record<string | symbol, unknown>);
    }

    const key = `repo:${this.tableName}:${id}`;

    // Re-entry guard — same async context double-locking would deadlock.
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

    // Acquire the cluster-wide mutex (pg_advisory_lock when wired with
    // PostgresLockProvider). Blocks until granted.
    const metadata = await this.lockProvider.acquire(
      key,
      acquireOpts,
      this.lockInstanceId,
    );
    _registerHeldLock(key);

    // Re-fetch under the lock so callers see committed state.
    const sql = this.client.sql;
    const result = await sql`
      SELECT * FROM ${sql(this.tableName)} WHERE id = ${id}
    `;
    if (result.length === 0) {
      _unregisterHeldLock(key);
      await this.lockProvider.release(key, this.lockInstanceId);
      return null;
    }

    const fresh = this.rowToEntity(result[0] as Record<string, unknown>);
    const lockProvider = this.lockProvider;
    const lockInstanceId = this.lockInstanceId;
    let active = true;

    const releaseSync = () => {
      if (!active) return;
      active = false;
      _unregisterHeldLock(key);
      lockProvider.release(key, lockInstanceId).catch(() => { /* TTL cleanup */ });
    };

    const releaseAsync = async () => {
      if (!active) return;
      active = false;
      _unregisterHeldLock(key);
      try {
        await lockProvider.release(key, lockInstanceId);
      } catch {
        // Mutex release is best-effort; TTL is the backstop.
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
  private requireActiveLock(entity: Locked<T>): string {
    const active = (entity as unknown as { __active?: boolean }).__active;
    if (active === false) {
      const id = extractKey(entity as unknown as Record<string | symbol, unknown>);
      throw new LockReleasedError(`repo:${this.tableName}:${id}`);
    }
    return extractKey(entity as unknown as Record<string | symbol, unknown>);
  }

  /**
   * Save a persistent entity (update in place).
   */
  async save(entity: Persistent<T>): Promise<Persistent<T>> {
    return this.update(entity as unknown as Ref<T>, entity as unknown as UpdateData<T>);
  }

  /**
   * Update an entity.
   */
  async update(
    ref: Ref<T> | string,
    data: UpdateData<T>,
    expectedVersion?: number,
  ): Promise<Persistent<T>> {
    // If the caller passed a Locked<T>, enforce the lock-still-held
    // invariant. Raw Ref / string inputs skip this check (legacy path).
    if (ref !== null && typeof ref === 'object' && '__active' in (ref as object)) {
      this.requireActiveLock(ref as unknown as Locked<T>);
    }
    const id = typeof ref === 'string' ? ref : extractKey(ref as unknown as Reference<unknown> | Record<string | symbol, unknown>);
    const sql = this.client.sql;
    const now = new Date();

    if (this.storageMode === 'jsonb') {
      if (expectedVersion !== undefined) {
        const result = await sql`
          UPDATE ${sql(this.tableName)}
          SET
            ${sql(this.dataColumn)} = ${sql(this.dataColumn)} || ${sql.json(data as JSONValue)},
            updated_at = ${now},
            version = version + 1
          WHERE id = ${id} AND version = ${expectedVersion}
          RETURNING *
        `;
        if (result.length === 0) {
          throw new Error(`Stale write: entity ${id} version mismatch`);
        }
        const entity = this.rowToEntity(result[0] as Record<string, unknown>);
        this.client.storeInIdentityMap(this.tableName, id, entity);
        this.broadcastChange(id, 'update');
        return entity;
      }

      const result = await sql`
        UPDATE ${sql(this.tableName)}
        SET
          ${sql(this.dataColumn)} = ${sql(this.dataColumn)} || ${sql.json(data as JSONValue)},
          updated_at = ${now},
          version = version + 1
        WHERE id = ${id}
        RETURNING *
      `;
      const entity = this.rowToEntity(result[0] as Record<string, unknown>);
      this.client.storeInIdentityMap(this.tableName, id, entity);
      this.broadcastChange(id, 'update');
      return entity;
    }

    // Columnar mode
    const columns = this.getColumnarColumns(data as unknown as Partial<ModelData<T>>);
    const setClauses = Object.keys(columns)
      .map((col, i) => `${col} = $${i + 1}`)
      .join(', ');

    const values: (string | number | boolean | Date | null)[] = [
      ...(Object.values(columns) as (
        | string
        | number
        | boolean
        | Date
        | null
      )[]),
      now,
    ];
    let query = `UPDATE ${this.tableName} SET `;
    if (setClauses) {
      query += `${setClauses}, `;
    }
    query += `updated_at = $${values.length}, version = version + 1`;

    if (expectedVersion !== undefined) {
      query += ` WHERE id = $${values.length + 1} AND version = $${values.length + 2}`;
      values.push(id, expectedVersion);
    } else {
      query += ` WHERE id = $${values.length + 1}`;
      values.push(id);
    }
    query += ' RETURNING *';

    const result = await sql.unsafe(query, values);
    if (result.length === 0) {
      throw new Error(`Stale write: entity ${id} version mismatch or not found`);
    }
    const updated = this.rowToEntity(result[0] as Record<string, unknown>);
    this.client.storeInIdentityMap(this.tableName, id, updated);
    this.broadcastChange(id, 'update');
    return updated;
  }

  /**
   * Delete an entity.
   */
  async delete(ref: Ref<T> | string, expectedVersion?: number): Promise<boolean> {
    if (ref !== null && typeof ref === 'object' && '__active' in (ref as object)) {
      this.requireActiveLock(ref as unknown as Locked<T>);
    }
    const id = typeof ref === 'string' ? ref : extractKey(ref as unknown as Reference<unknown> | Record<string | symbol, unknown>);
    const sql = this.client.sql;

    if (expectedVersion !== undefined) {
      const result = await sql`
        DELETE FROM ${sql(this.tableName)}
        WHERE id = ${id} AND version = ${expectedVersion}
        RETURNING id
      `;
      if (result.length > 0) {
        this.client.removeFromIdentityMap(this.tableName, id);
        this.broadcastChange(id, 'delete');
        return true;
      }
      return false;
    }

    const result = await sql`
      DELETE FROM ${sql(this.tableName)}
      WHERE id = ${id}
      RETURNING id
    `;
    if (result.length > 0) {
      this.client.removeFromIdentityMap(this.tableName, id);
      this.broadcastChange(id, 'delete');
      return true;
    }
    return false;
  }

  /**
   * Delete entities matching a condition.
   */
  async deleteWhere(where: Condition): Promise<number> {
    const sql = this.client.sql;
    const compiled = this.compiler.compileWhere(where);
    const query = `DELETE FROM ${this.tableName} WHERE ${compiled.text} RETURNING id`;
    const result = await sql.unsafe(
      query,
      compiled.values as (string | number | boolean | Date | null)[],
    );

    // Remove deleted entities from identity map
    for (const row of result) {
      const id = (row as unknown as { id: string }).id;
      this.client.removeFromIdentityMap(this.tableName, id);
    }

    return result.length;
  }

  // -------------------------------------------------------------------------
  // Reference Resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve a reference to its entity.
   * This is the DDD-friendly way to fetch an entity - you work with references,
   * not raw IDs.
   *
   * @example
   * ```typescript
   * const authorRef = Author.ref`${someId}`
   * const author = await authorRepo.get(authorRef)
   * ```
   */
  async get(ref: Ref<T>): Promise<Persistent<T> | undefined> {
    const id = extractKey(ref as Reference<unknown> | Record<string | symbol, unknown>);
    // Check identity map first
    const cached = this.client.getFromIdentityMap<Persistent<T>>(
      this.tableName,
      id,
    );
    if (cached) {
      return cached;
    }

    const sql = this.client.sql;
    const result = await sql`
      SELECT * FROM ${sql(this.tableName)}
      WHERE id = ${id}
      LIMIT 1
    `;

    if (result.length === 0) {
      return undefined;
    }

    const entity = this.rowToEntity(result[0] as Record<string, unknown>);
    const entityId = extractKey(entity as unknown as Record<string | symbol, unknown>);
    // Store in identity map
    this.client.storeInIdentityMap(this.tableName, entityId, entity);
    return entity;
  }

  /**
   * Get multiple entities by their references.
   * Efficiently batches into a single query.
   *
   * @example
   * ```typescript
   * const refs = [Author.ref`${id1}`, Author.ref`${id2}`]
   * const authors = await authorRepo.getMany(refs)
   * ```
   */
  async getMany(refs: Ref<T>[]): Promise<Persistent<T>[]> {
    if (refs.length === 0) return [];

    const sql = this.client.sql;
    const ids = refs.map((ref) => extractKey(ref as Reference<unknown> | Record<string | symbol, unknown>));

    // Check identity map first, collect IDs that need fetching
    const results = new Map<string, Persistent<T>>();
    const idsToFetch: string[] = [];

    for (const id of ids) {
      const cached = this.client.getFromIdentityMap<Persistent<T>>(
        this.tableName,
        id,
      );
      if (cached) {
        results.set(id, cached);
      } else {
        idsToFetch.push(id);
      }
    }

    // Batch fetch only entities not in identity map
    if (idsToFetch.length > 0) {
      const result = await sql`
        SELECT * FROM ${sql(this.tableName)}
        WHERE id = ANY(${idsToFetch})
      `;

      // Convert to entities and store in identity map
      for (const row of result) {
        const entity = this.rowToEntity(row as Record<string, unknown>);
        const entityId = extractKey(entity as unknown as Record<string | symbol, unknown>);
        this.client.storeInIdentityMap(this.tableName, entityId, entity);
        results.set(entityId, entity);
      }
    }

    // Return in original order
    return ids
      .map((id) => results.get(id))
      .filter((e): e is Persistent<T> => e !== undefined);
  }

  // -------------------------------------------------------------------------
  // Streaming / Pagination
  // -------------------------------------------------------------------------

  /**
   * Stream entities matching the condition.
   * Yields one entity at a time for memory-efficient processing.
   *
   * Uses keyset pagination internally to avoid duplicates when data changes.
   * Default batch size is 100.
   *
   * @example
   * ```typescript
   * for await (const user of userRepo.stream({ where: User.fields.role.eq('admin') })) {
   *   await processUser(user);
   * }
   * ```
   */
  async *stream(
    options?: FindOptions<ModelData<T>> & { batchSize?: number },
  ): AsyncGenerator<Persistent<T>> {
    for await (const batch of this.streamBatches(options)) {
      for (const entity of batch) {
        yield entity;
      }
    }
  }

  /**
   * Stream entities in batches.
   * More efficient than streaming one at a time for bulk operations.
   *
   * Uses keyset pagination (WHERE id > lastId ORDER BY id) to ensure:
   * - No duplicates even if rows are inserted during iteration
   * - Consistent ordering regardless of concurrent modifications
   *
   * @example
   * ```typescript
   * for await (const batch of userRepo.streamBatches({ batchSize: 100 })) {
   *   await processBatch(batch);
   * }
   * ```
   */
  async *streamBatches(
    options?: FindOptions<ModelData<T>> & { batchSize?: number },
  ): AsyncGenerator<Persistent<T>[]> {
    const batchSize = options?.batchSize ?? 100;
    let lastId: string | null = null;
    while (true) {
      const batch = await this.fetchBatch(lastId, batchSize, options);

      if (batch.length === 0) {
        break;
      }

      yield batch;

      // Use the last entity's ID for keyset pagination
      lastId = extractKey(batch[batch.length - 1] as unknown as Record<string | symbol, unknown>);

      // If we got fewer than batchSize, we've reached the end
      if (batch.length < batchSize) {
        break;
      }
    }
  }

  /**
   * Fetch a single batch using keyset pagination.
   * @internal
   */
  private async fetchBatch(
    afterId: string | null,
    limit: number,
    options?: FindOptions<ModelData<T>>,
  ): Promise<Persistent<T>[]> {
    const sql = this.client.sql;
    const parts: string[] = [`SELECT * FROM ${this.tableName}`];
    const values: unknown[] = [];
    let paramIndex = 1;

    // Build WHERE clause combining user condition with keyset
    const conditions: string[] = [];

    // Keyset condition: id > lastId
    if (afterId !== null) {
      conditions.push(`id > $${paramIndex++}`);
      values.push(afterId);
    }

    // User-provided WHERE condition
    if (options?.where) {
      const compiled = this.compiler.compileWhere(options.where);
      // Rewrite parameter indices to account for keyset param
      const rewrittenText = this.rewriteParamIndices(
        compiled.text,
        paramIndex - 1,
      );
      conditions.push(`(${rewrittenText})`);
      values.push(...compiled.values);
    }

    if (conditions.length > 0) {
      parts.push(`WHERE ${conditions.join(' AND ')}`);
    }

    // ORDER BY id for consistent keyset pagination
    // Note: We always order by id for keyset pagination, additional ordering is applied after
    parts.push('ORDER BY id ASC');

    // LIMIT — see assertNonNegativeInt rationale above.
    parts.push(`LIMIT ${assertNonNegativeInt(limit, 'limit')}`);

    const query = parts.join(' ');
    const result = await sql.unsafe(
      query,
      values as (string | number | boolean | Date | null)[],
    );

    return result.map((row) => {
      // Get ID first to check identity map BEFORE creating subscriptions
      const rawEntity = this.rowToEntityRaw(row as Record<string, unknown>);
      const id = extractKey(rawEntity as unknown as Record<string | symbol, unknown>);

      // Check identity map first - return cached to avoid duplicate subscriptions
      const cached = this.client.getFromIdentityMap<Persistent<T>>(
        this.tableName,
        id,
      );
      if (cached) {
        return cached;
      }

      // Hydrate references and streams for new entity
      this.hydrateReferences(rawEntity as Record<string, unknown>);
      this.hydrateStreams(rawEntity as Record<string, unknown>, id);

      // Store in identity map
      this.client.storeInIdentityMap(this.tableName, id, rawEntity);
      return rawEntity;
    });
  }

  /**
   * Rewrite parameter placeholders ($1, $2, etc.) to account for an offset.
   * @internal
   */
  private rewriteParamIndices(text: string, offset: number): string {
    if (offset === 0) return text;
    return text.replace(
      /\$(\d+)/g,
      (_, n) => `$${Number.parseInt(n, 10) + offset}`,
    );
  }

  // -------------------------------------------------------------------------
  // DataLoader Support
  // -------------------------------------------------------------------------

  /**
   * Create a DataLoader for batching entity lookups by ID.
   *
   * This is useful for resolving references efficiently:
   * - Multiple references resolved in the same tick are batched together
   * - A single WHERE id = ANY($1) query fetches all entities
   * - Results are cached within the loader instance
   *
   * @example
   * ```typescript
   * const loader = userRepo.createLoader();
   *
   * // These three calls will be batched into a single query
   * const [user1, user2, user3] = await Promise.all([
   *   loader.load('id1'),
   *   loader.load('id2'),
   *   loader.load('id3'),
   * ]);
   * ```
   */
  createLoader(): DataLoader<Persistent<T>> {
    return new DataLoader<Persistent<T>>(async (ids: string[]) => {
      const sql = this.client.sql;

      // Use PostgreSQL's ANY array operator for efficient batch lookup
      const result = await sql`
        SELECT * FROM ${sql(this.tableName)}
        WHERE id = ANY(${ids})
      `;

      // Convert rows to entities and build result map
      const resultMap = new Map<string, Persistent<T> | undefined>();

      // Initialize all IDs as undefined (not found)
      for (const id of ids) {
        resultMap.set(id, undefined);
      }

      // Fill in found entities
      for (const row of result) {
        // Get ID first to check identity map BEFORE creating subscriptions
        const rawEntity = this.rowToEntityRaw(row as Record<string, unknown>);
        const entityId = extractKey(rawEntity as unknown as Record<string | symbol, unknown>);

        // Check identity map first - if entity exists, use cached instance
        const cached = this.client.getFromIdentityMap<Persistent<T>>(
          this.tableName,
          entityId,
        );
        if (cached) {
          resultMap.set(entityId, cached);
        } else {
          // Hydrate references and streams for new entity
          this.hydrateReferences(rawEntity as Record<string, unknown>);
          this.hydrateStreams(rawEntity as Record<string, unknown>, entityId);

          // Store new entity in identity map
          this.client.storeInIdentityMap(this.tableName, entityId, rawEntity);
          resultMap.set(entityId, rawEntity);
        }
      }

      return resultMap;
    });
  }

  // -------------------------------------------------------------------------
  // Eager Loading
  // -------------------------------------------------------------------------

  /**
   * Eagerly load referenced entities.
   * Returns a cache map for use during reference hydration.
   *
   * @param entities - The main entities with raw ref ID values
   * @param load - Fields to eager load (array or object form)
   * @returns A cache map of "table:id" -> entity
   */
  private async eagerLoadRefs(
    entities: Persistent<T>[],
    load: string[] | Record<string, boolean | Record<string, unknown>>,
  ): Promise<Map<string, object>> {
    const cache = new Map<string, object>();

    // Normalize load option to array of field names
    const fieldsToLoad = Array.isArray(load)
      ? load
      : Object.entries(load)
        .filter(([, v]) => v)
        .map(([k]) => k);

    for (const fieldName of fieldsToLoad) {
      const fieldDef = this.fieldDefs[fieldName] as FieldDef | undefined;
      if (!fieldDef) continue;

      // Only process ref/refs fields
      if (fieldDef.type !== 'ref' && fieldDef.type !== 'refs') continue;

      // Get target model info
      const refTarget = fieldDef.refTarget?.();
      if (!refTarget) continue;

      const refInfo = ModelRegistry.getByModel(refTarget);
      if (!refInfo) continue;

      // Collect unique IDs to fetch
      const idsToFetch = new Set<string>();

      for (const entity of entities) {
        const raw = entity as Record<string, unknown>;
        const rawValue = raw[fieldName];

        if (rawValue === null || rawValue === undefined) continue;

        if (fieldDef.type === 'ref') {
          // Handle both raw UUID strings and Reference objects (from identity map cache)
          const id = isReference(rawValue) ? rawValue.identifier : (rawValue as string);
          const cacheKey = `${refInfo.tableName}:${id}`;
          // Only fetch if not already in cache or identity map
          if (
            !cache.has(cacheKey) &&
            !this.client.getFromIdentityMap(refInfo.tableName, id)
          ) {
            idsToFetch.add(id);
          }
        } else if (fieldDef.type === 'refs') {
          // Handle both raw UUID arrays and References objects (from identity map cache)
          const ids = isReferences(rawValue)
            ? rawValue.identifiers
            : (rawValue as string[]);
          for (const id of ids) {
            const cacheKey = `${refInfo.tableName}:${id}`;
            if (
              !cache.has(cacheKey) &&
              !this.client.getFromIdentityMap(refInfo.tableName, id)
            ) {
              idsToFetch.add(id);
            }
          }
        }
      }

      // Batch fetch all needed entities in a single query
      if (idsToFetch.size > 0) {
        await this.batchFetchToCache(refInfo, Array.from(idsToFetch), cache);
      }
    }

    return cache;
  }

  /**
   * Batch fetch entities by IDs and store them in the provided cache.
   */
  private async batchFetchToCache(
    refInfo: {
      tableName: string
      modelName: string
      fieldMap: Record<string, string>
      fieldDefs: Record<string, FieldDef>
    },
    ids: string[],
    cache: Map<string, object>,
  ): Promise<void> {
    if (ids.length === 0) return;

    const sql = this.client.sql;
    const result = await sql`
      SELECT * FROM ${sql(refInfo.tableName)}
      WHERE id = ANY(${ids})
    `;

    for (const row of result) {
      const entity = this.rowToEntityForRef(
        row as Record<string, unknown>,
        refInfo,
      );
      const id = extractKey(entity as unknown as Record<string | symbol, unknown>);
      const cacheKey = `${refInfo.tableName}:${id}`;

      // Hydrate streams for the referenced entity
      // This ensures stream.publish() on referenced entities can wake up processes
      this.hydrateStreamsForRef(entity as unknown as Record<string, unknown>, id, refInfo);

      // Store in both local cache and identity map
      cache.set(cacheKey, entity);
      this.client.storeInIdentityMap(refInfo.tableName, id, entity);
    }
  }

  // -------------------------------------------------------------------------
  // Private Helpers
  // -------------------------------------------------------------------------

  /**
   * Convert a database row to an entity.
   * Creates Reference objects for ref fields and attaches resolvers.
   */
  private rowToEntity(row: Record<string, unknown>): Persistent<T> {
    const entity = this.rowToEntityRaw(row);
    const id = extractKey(entity as unknown as Record<string | symbol, unknown>);
    this.hydrateReferences(entity as Record<string, unknown>);
    this.hydrateStreams(entity as Record<string, unknown>, id);
    return entity;
  }

  /**
   * Convert a database row to an entity without hydrating references.
   * Used for eager loading where references are hydrated after batch fetching.
   *
   * System fields (id, createdAt, updatedAt, version) are stored as non-enumerable
   * symbol properties - domain code never sees them.
   */
  private rowToEntityRaw(row: Record<string, unknown>): Persistent<T> {
    // Use model prototype for entity creation - gives class methods and inject deps
    const modelService = (this.model as unknown as Record<symbol, unknown>)[MODEL_SERVICE] as object | undefined;
    const proto = modelService ?? (this.model as unknown as { prototype: object }).prototype ?? null;
    const entity: Record<string | symbol, unknown> = proto
      ? Object.create(proto)
      : {};

    // Set up FIELD_STORAGE for ref field getters/setters (needed when prototype has them)
    if (proto) {
      Object.defineProperty(entity, FIELD_STORAGE, { value: {}, enumerable: false, writable: false });
    }

    if (this.storageMode === 'jsonb') {
      const data = row[this.dataColumn] as Record<string, unknown>;
      for (const key of Object.keys(data)) {
        // Use defineProperty to bypass ref field setters - raw values
        // are hydrated into References later in hydrateReferences()
        Object.defineProperty(entity, key, {
          value: data[key] === null ? undefined : data[key],
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    } else {
      // Columnar mode - convert snake_case back to camelCase
      for (const fieldName of Object.keys(this.fieldDefs)) {
        const colName = this.fieldMap[fieldName] ?? this.toSnakeCase(fieldName);
        if (colName in row) {
          Object.defineProperty(entity, fieldName, {
            value: row[colName] === null ? undefined : row[colName],
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
      }
    }

    // Mark as persistent
    Object.defineProperty(entity, PERSISTENT, { value: true, enumerable: false, configurable: true, writable: false });

    // Attach system fields as non-enumerable symbols
    attachSystemFields(
      entity,
      row.id as string,
      row.created_at as Date,
      row.updated_at as Date,
      row.version as number,
    );

    return entity as Persistent<T>;
  }

  /**
   * Convert raw ID values to Reference objects for ref/refs fields.
   * Also checks eager cache and identity map for pre-populated references.
   *
   * @param entity - The entity to hydrate references on
   * @param eagerCache - Optional cache from eager loading (table:id -> entity)
   */
  private hydrateReferences(
    entity: Record<string, unknown>,
    eagerCache?: Map<string, object>,
  ): void {
    for (const [fieldName, fieldDef] of Object.entries(this.fieldDefs)) {
      const def = fieldDef as FieldDef;
      const rawValue = entity[fieldName];

      if (def.type === 'ref' && rawValue !== null && rawValue !== undefined) {
        // Skip if already hydrated (entity from identity map)
        if (isReference(rawValue)) continue;

        const refId = rawValue as string;

        // Create Reference object
        const ref = new Reference<unknown>(refId);

        // Try to get from eager cache or identity map
        const refTarget = def.refTarget?.();
        if (refTarget) {
          const refInfo = ModelRegistry.getByModel(refTarget);
          if (refInfo) {
            const cacheKey = `${refInfo.tableName}:${refId}`;
            // Check eager cache first, then identity map
            const cached =
              eagerCache?.get(cacheKey) ??
              this.client.getFromIdentityMap<object>(refInfo.tableName, refId);
            if (cached) {
              // Pre-populate the reference with cached entity
              ref[HYDRATE](cached as Persistent<unknown>);
            }
          }

          // Attach resolver for lazy loading
          ref[SET_RESOLVER](this.createRefResolver(refTarget));
        }

        entity[fieldName] = ref;
      } else if (
        def.type === 'refs' &&
        rawValue !== null &&
        rawValue !== undefined
      ) {
        // Skip if already hydrated (entity from identity map)
        if (isReferences(rawValue)) continue;

        const refIds = rawValue as string[];

        // Create References object
        const refs = new References<unknown>(refIds);

        // Try to pre-populate from eager cache or identity map
        const refTarget = def.refTarget?.();
        if (refTarget) {
          const refInfo = ModelRegistry.getByModel(refTarget);
          if (refInfo) {
            const cachedValues: object[] = [];
            let allCached = true;

            for (const id of refIds) {
              const cacheKey = `${refInfo.tableName}:${id}`;
              const cached =
                eagerCache?.get(cacheKey) ??
                this.client.getFromIdentityMap<object>(refInfo.tableName, id);
              if (cached) {
                cachedValues.push(cached);
              } else {
                allCached = false;
                break;
              }
            }

            if (allCached && cachedValues.length === refIds.length) {
              // All refs are cached, pre-populate
              refs[HYDRATE](cachedValues as Persistent<unknown>[]);
            }
          }

          // Attach resolver for lazy loading
          refs[SET_RESOLVER](this.createRefResolver(refTarget));
        }

        entity[fieldName] = refs;
      }
    }
  }

  /**
   * Inject stream fields with channel subscriptions.
   * Creates StreamImpl instances connected to the channels service.
   *
   * Stream fields are NOT stored in the database - they are ephemeral pub/sub channels.
   * The channel key format is: {tableName}:{entityId}:{fieldName}
   *
   * @param entity - The entity to hydrate streams on
   * @param entityId - The entity's unique identifier
   */
  private hydrateStreams(entity: Record<string, unknown>, entityId: string): void {
    for (const [fieldName, fieldDef] of Object.entries(this.fieldDefs)) {
      const def = fieldDef as FieldDef;

      if (def.type === 'stream') {
        const isProtected = def.streamProtected ?? false;
        const channelKey = `${this.tableName}:${entityId}:${fieldName}`;

        // Create stream instance
        const stream = new StreamImpl<unknown>(isProtected);

        // Connect to channels if available
        if (this.channels) {
          // Cast channels to unknown type for stream messages (different from ModelChangeEvent)
          const streamChannels = this.channels as ChannelsInstance<unknown>;
          const subscription = streamChannels.subscribe(channelKey);
          const publish = (msg: unknown) => streamChannels.publish(channelKey, msg);

          // For protected mode, check if entity has lock
          const lockChecker = isProtected
            ? () => isLocked(entity)
            : undefined;

          stream[SET_STREAM_CHANNEL](subscription, publish, lockChecker);
        }

        // Connect signal emitter for process wakeup if a signal bus is available.
        // Enables stream(r, entity.field) in processes to wake up on publish().
        if (this.getSignalBus) {
          const getSignalBusLazy = this.getSignalBus;
          const modelName = this.modelName;

          stream[SET_STREAM_SIGNAL_EMITTER](channelKey, (key: string, message: unknown) => {
            const parts = key.split(':');
            if (parts.length < 3) return;

            const [_tbl, id, field] = parts;

            const signalName = buildStreamSignal(modelName, id, field);
            const identityKey = modelNameToIdentityKey(modelName);
            const identity = { [identityKey]: id };

            const emitSignal = async () => {
              let bus = this.cachedSignalBus;
              if (!bus) {
                bus = await getSignalBusLazy();
                if (bus) {
                  this.cachedSignalBus = bus;
                }
              }
              if (bus) {
                await bus.emit(signalName, identity, message);
              }
            };

            emitSignal().catch(err => {
              console.error('[Stream] Signal emission failed:', err);
            });
          });
        }

        entity[fieldName] = stream;
      }
    }
  }

  /**
   * Hydrate stream fields for a referenced entity.
   * Similar to hydrateStreams but uses refInfo for the referenced model's metadata.
   *
   * This is needed because referenced entities loaded via lazy loading or eager loading
   * also need their stream fields to have signal emitters configured.
   *
   * @param entity - The referenced entity to hydrate streams on
   * @param entityId - The entity's unique identifier
   * @param refInfo - The referenced model's registry info
   */
  private hydrateStreamsForRef(
    entity: Record<string, unknown>,
    entityId: string,
    refInfo: {
      tableName: string
      modelName: string
      fieldDefs: Record<string, FieldDef>
    },
  ): void {
    for (const [fieldName, fieldDef] of Object.entries(refInfo.fieldDefs)) {
      const def = fieldDef as FieldDef;

      if (def.type === 'stream') {
        const isProtected = def.streamProtected ?? false;
        const channelKey = `${refInfo.tableName}:${entityId}:${fieldName}`;

        // Create stream instance
        const stream = new StreamImpl<unknown>(isProtected);

        // Connect to channels if available
        if (this.channels) {
          const streamChannels = this.channels as ChannelsInstance<unknown>;
          const subscription = streamChannels.subscribe(channelKey);
          const publish = (msg: unknown) => streamChannels.publish(channelKey, msg);

          const lockChecker = isProtected
            ? () => isLocked(entity)
            : undefined;

          stream[SET_STREAM_CHANNEL](subscription, publish, lockChecker);
        }

        // Connect signal emitter for process wakeup if a signal bus is available.
        if (this.getSignalBus) {
          const getSignalBusLazy = this.getSignalBus;
          const modelName = refInfo.modelName;

          stream[SET_STREAM_SIGNAL_EMITTER](channelKey, (key: string, message: unknown) => {
            const parts = key.split(':');
            if (parts.length < 3) return;

            const [_tbl, id, field] = parts;
            const signalName = buildStreamSignal(modelName, id, field);
            const identityKey = modelNameToIdentityKey(modelName);
            const identity = { [identityKey]: id };

            const emitSignal = async () => {
              let bus = this.cachedSignalBus;
              if (!bus) {
                bus = await getSignalBusLazy();
                if (bus) {
                  this.cachedSignalBus = bus;
                }
              }
              if (bus) {
                await bus.emit(signalName, identity, message);
              }
            };

            emitSignal().catch(err => {
              console.error('[Stream] Signal emission failed:', err);
            });
          });
        }

        entity[fieldName] = stream;
      }
    }
  }

  /**
   * Create a resolver function for a reference target.
   * Uses the ModelRegistry to find the repository for the target model.
   */
  private createRefResolver(refTarget: unknown): ReferenceResolver<unknown> {
    return async (id: string): Promise<Persistent<unknown> | null> => {
      // Look up the model info from registry
      const refInfo = ModelRegistry.getByModel(refTarget);
      if (!refInfo) {
        throw new Error('Model not found in registry for reference resolution');
      }

      // Check identity map first
      const cached = this.client.getFromIdentityMap<Persistent<unknown>>(
        refInfo.tableName,
        id,
      );
      if (cached) {
        return cached;
      }

      // Fetch from database
      const sql = this.client.sql;
      const result = await sql.unsafe(
        `SELECT * FROM ${refInfo.tableName} WHERE id = $1 LIMIT 1`,
        [id],
      );

      if (result.length === 0) {
        return null;
      }

      // Convert row to entity (simplified - uses registry info)
      const row = result[0] as Record<string, unknown>;
      const entity = this.rowToEntityForRef(row, refInfo);

      // Hydrate streams for the referenced entity
      // This ensures stream.publish() on lazy-loaded entities can wake up processes
      this.hydrateStreamsForRef(entity as unknown as Record<string, unknown>, id, refInfo);

      // Store in identity map
      this.client.storeInIdentityMap(refInfo.tableName, id, entity);

      return entity as Persistent<unknown>;
    };
  }

  /**
   * Convert a database row to an entity for a referenced model.
   * Uses the ModelRegistry info for field mapping.
   *
   * System fields stored as non-enumerable symbols, matching main rowToEntityRaw.
   */
  private rowToEntityForRef(
    row: Record<string, unknown>,
    refInfo: {
      tableName: string
      fieldMap: Record<string, string>
      fieldDefs: Record<string, FieldDef>
    },
  ): Persistent<unknown> {
    const entity: Record<string | symbol, unknown> = {};

    // Map columns back to field names
    const reverseFieldMap: Record<string, string> = {};
    for (const [fieldName, colName] of Object.entries(refInfo.fieldMap)) {
      reverseFieldMap[colName] = fieldName;
    }

    for (const [colName, value] of Object.entries(row)) {
      if (['id', 'created_at', 'updated_at', 'version'].includes(colName)) {
        continue;
      }
      const fieldName = reverseFieldMap[colName] || colName;
      // Normalize null -> undefined (Postgres NULL vs JS undefined)
      entity[fieldName] = value === null ? undefined : value;
    }

    // Mark as persistent
    Object.defineProperty(entity, PERSISTENT, { value: true, enumerable: false, configurable: true, writable: false });

    // Attach system fields as non-enumerable symbols
    attachSystemFields(
      entity,
      row.id as string,
      row.created_at as Date,
      row.updated_at as Date,
      row.version as number,
    );

    return entity as unknown as Persistent<unknown>;
  }

  /**
   * Get column names and values for columnar insert/update.
   */
  private getColumnarColumns(
    data: Partial<ModelData<T>>,
  ): Record<string, unknown> {
    const columns: Record<string, unknown> = {};

    for (const [fieldName, value] of Object.entries(
      data as Record<string, unknown>,
    )) {
      // Skip system fields
      if (['id', 'createdAt', 'updatedAt', 'version'].includes(fieldName)) {
        continue;
      }

      // Skip stream fields (they are ephemeral, not stored in database)
      if (isStream(value)) {
        continue;
      }

      // Also skip if the field definition says it's a stream type
      const fieldDef = this.fieldDefs[fieldName];
      if (fieldDef && (fieldDef as FieldDef).type === 'stream') {
        continue;
      }

      // Skip undefined values - let Postgres use column DEFAULT
      if (value === undefined) {
        continue;
      }

      const colName = this.fieldMap[fieldName] ?? this.toSnakeCase(fieldName);

      // Extract key from Reference or persistent entity
      if (isReference(value)) {
        columns[colName] = value.identifier;
      } else if (isReferences(value)) {
        columns[colName] = [...value.identifiers];
      } else if (isPersistent(value)) {
        // Persistent entity in a ref field - extract adapter key
        const refKey = (value as unknown as Record<symbol, unknown>)[ADAPTER_KEY];
        columns[colName] = refKey;
      } else if (Array.isArray(value) && value.length > 0 && isPersistent(value[0])) {
        // Array of persistent entities in a refs field - extract adapter keys
        columns[colName] = value.map((v: unknown) => (v as unknown as Record<symbol, unknown>)[ADAPTER_KEY]);
      } else {
        columns[colName] = value;
      }
    }

    return columns;
  }

  /**
   * Convert camelCase to snake_case.
   */
  private toSnakeCase(str: string): string {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  }

  // -------------------------------------------------------------------------
  // Live Model Observation
  // -------------------------------------------------------------------------

  /**
   * Observe changes to an entity.
   *
   * Returns an async iterable that yields whenever the entity is updated
   * from any instance (including other nodes in the cluster).
   *
   * The entity object is mutated in-place via the identity map, so you
   * can also just access the original reference after yielding.
   *
   * @example
   * ```typescript
   * const user = await userRepo.get(User.ref`123`);
   *
   * // Observe changes from anywhere
   * for await (const _ of userRepo.observe(user)) {
   *   console.log('User updated:', user.name); // same object, mutated
   * }
   * ```
   */
  async *observe(
    entity: Persistent<T> | Reference<T>,
  ): AsyncGenerator<Persistent<T>> {
    // Get the entity ID
    const id = extractKey(entity as unknown as Reference<unknown> | Record<string | symbol, unknown>);

    if (!id) {
      throw new Error('Cannot observe an entity without an ID');
    }

    // If no channels configured, just return (no-op)
    if (!this.channels) {
      return;
    }

    // Subscribe to changes for this specific entity
    const channelKey = `${this.tableName}:${id}`;
    const subscription = this.channels.subscribe(channelKey);

    try {
      // Close the get->subscribe race when the caller holds a snapshot:
      // another instance may have updated the row in the window between
      // `repo.get(ref)` and the LISTEN round-trip above. Without this step
      // the observer stays silent until the NEXT write, silently losing
      // the interim update.
      //
      // Only fires when the caller passed a Persistent<T> baseline - Reference
      // callers have no baseline, so we preserve the "yield on change only"
      // contract for them (matches the existing test suite's expectations).
      if (!isReference(entity)) {
        const baselineVersion = versionOf(entity) ?? -1;
        const sql = this.client.sql;
        const syncResult = await sql`
          SELECT * FROM ${sql(this.tableName)} WHERE id = ${id} LIMIT 1
        `;
        if (syncResult.length === 0) {
          // Row is already gone - nothing to observe.
          return;
        }
        const sync = this.rowToEntity(syncResult[0] as Record<string, unknown>);
        if (versionOf(sync) > baselineVersion) {
          const cached = this.client.getFromIdentityMap<Persistent<T>>(this.tableName, id);
          if (cached && cached !== sync) {
            this.mutateInPlace(cached, sync);
          }
          yield sync;
        }
      }

      for await (const event of subscription) {
        // On delete, close the generator
        if (event.type === 'delete') {
          return;
        }

        // On update, fetch fresh data and mutate identity-mapped object
        // Fetch directly since we have the raw ID (internal implementation)
        const sql = this.client.sql;
        const result = await sql`
          SELECT * FROM ${sql(this.tableName)}
          WHERE id = ${id}
          LIMIT 1
        `;
        const fresh =
          result.length > 0
            ? this.rowToEntity(result[0] as Record<string, unknown>)
            : undefined;
        if (fresh) {
          // Get the cached entity from identity map
          const cached = this.client.getFromIdentityMap<Persistent<T>>(
            this.tableName,
            id,
          );

          if (cached && cached !== fresh) {
            // Mutate the cached object in-place
            this.mutateInPlace(cached, fresh);
          }

          yield fresh;
        }
      }
    } finally {
      subscription.unsubscribe();
    }
  }

  /**
   * Mutate an object in-place with values from another object.
   * This preserves object identity while updating all properties.
   *
   * Safety guarantee: This operation is always safe because:
   * - Only locked models can be modified (save requires Lock<T>)
   * - Only one instance can hold a lock at a time
   * - The lock holder is always authoritative
   * - When they unlock, they broadcast the change
   * - All other instances receive the update and sync their cached copy
   *
   * @internal
   */
  private mutateInPlace<T extends object>(target: T, source: T): void {
    // Clear enumerable properties not in source
    // Safe: the source is authoritative (from the lock holder's save)
    for (const key of Object.keys(target)) {
      if (!(key in source)) {
        delete (target as Record<string, unknown>)[key];
      }
    }
    // Copy all enumerable properties from source
    // Safe: only one instance can modify at a time (lock holder)
    Object.assign(target, source);
    // Copy non-enumerable system field symbols from source
    const src = source as Record<string | symbol, unknown>;
    const tgt = target as Record<string | symbol, unknown>;
    for (const sym of [ADAPTER_KEY, PG_CREATED_AT, PG_UPDATED_AT, PG_VERSION, PERSISTENT] as symbol[]) {
      if (sym in src) {
        Object.defineProperty(tgt, sym, { value: src[sym], enumerable: false, configurable: true, writable: true });
      }
    }
  }

  /**
   * Broadcast a change event for an entity.
   * Called internally after updates.
   * @internal
   */
  broadcastChange(id: string, type: 'update' | 'delete'): void {
    if (!this.channels) return;

    const channelKey = `${this.tableName}:${id}`;
    this.channels.publish(channelKey, {
      type,
      table: this.tableName,
      id,
    });
  }
}
