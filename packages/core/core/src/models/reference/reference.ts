/**
 * Reference - A lazy, Promise-like reference to another entity.
 *
 * Models declare relationships using Reference<T>, keeping them
 * storage-agnostic. The actual resolution happens via a resolver
 * that has access to repositories through DI.
 *
 * References implement PromiseLike, so you can directly await them:
 *   const author = await post.author;
 */

import type { Persistent } from '../types.js';
import {
  REFERENCE,
  REFERENCES,
  SET_RESOLVER,
  HYDRATE,
} from '../symbols.js';

// Re-export for use by other modules that need to attach resolvers
export { SET_RESOLVER, HYDRATE };

/**
 * Extract the data type from a ModelClass.
 * If T is a class constructor, extracts the constructor parameter type.
 * Otherwise returns T as-is.
 */
type ExtractModelData<T> = T extends abstract new (data: infer D) => unknown ? D : T;

/**
 * Resolver function type - resolves an ID to a model.
 * This gets injected by the repository/DI system.
 */
export type ReferenceResolver<T> = (id: string) => Promise<Persistent<T> | null>;

/**
 * Batch resolver function type - resolves multiple IDs efficiently.
 * Returns a Map of id -> entity (or null if not found).
 *
 * This is used by DataLoader to batch multiple reference resolutions
 * into a single query, avoiding the N+1 problem.
 */
export type BatchReferenceResolver<T> = (ids: string[]) => Promise<Map<string, Persistent<T> | null>>;

/**
 * A reference to another entity that implements PromiseLike.
 *
 * The reference holds:
 * - The ID (always available synchronously)
 * - Optionally, the resolved entity (after resolution)
 * - A resolver function (injected by the system)
 *
 * @example
 * ```typescript
 * const Post = defineModel('Post', {
 *   title: field.string(),
 *   author: field.ref(User),
 * });
 *
 * const post = await postRepo.get(Post.ref('1'));
 *
 * // Just await the reference - no .resolve() needed!
 * const author = await post.author;
 *
 * // Or use Promise.all for parallel resolution
 * const [author, tags] = await Promise.all([post.author, post.tags]);
 *
 * // Sync access to the reference identifier (infrastructure use only)
 * post.author.identifier;  // 'user-123'
 * post.author.isLoaded; // true (after await)
 * post.author.value;    // User entity (sync, throws if not loaded)
 * ```
 */
export class Reference<T> implements PromiseLike<Persistent<T> | undefined> {
  /** Symbol marker for type identification */
  readonly [REFERENCE] = true as const;

  /** Internal ID storage */
  private readonly _id: string;

  /** Internal model name (set by adapter registration, used for serialization) */
  private _modelName: string | undefined;

  /** Internal cached value */
  private _value: Persistent<T> | null = null;

  /** Internal resolver */
  private _resolver: ReferenceResolver<T> | null = null;

  constructor(id: string, modelName?: string) {
    this._id = id;
    this._modelName = modelName;
  }

  /** The raw identifier of the referenced entity */
  get identifier(): string {
    return this._id;
  }

  /** The model name this reference belongs to (if known) */
  get modelName(): string | undefined {
    return this._modelName;
  }

  /** Returns the identifier - enables `${ref}` in template literals and string coercion */
  toString(): string {
    return this._id;
  }

  /** Whether the reference has been resolved */
  get isLoaded(): boolean {
    return this._value !== null;
  }

  /** The resolved entity (throws if not loaded) */
  get value(): Persistent<T> {
    if (this._value === null) {
      throw new Error('Reference not loaded. Await the reference first.');
    }
    return this._value;
  }

  /** The resolved entity or null if not loaded */
  get valueOrNull(): Persistent<T> | null {
    return this._value;
  }

  /**
   * Attach a resolver to this reference.
   * Called by the field setter when the reference is assigned.
   * Uses Symbol-keyed method for internal use only.
   *
   * Accepts `any` so Reference<T> is covariant in T - allows Reference<SubType>
   * to be assigned where Reference<SuperType> is expected.
   */
  // biome-ignore lint/suspicious/noExplicitAny: covariance - internal symbol method, never called by user code
  [SET_RESOLVER](resolver: ReferenceResolver<any>): void {
    this._resolver = resolver as ReferenceResolver<T>;
  }

  /**
   * Pre-populate this reference with an already-loaded entity.
   * Uses Symbol-keyed method for internal use only.
   *
   * Accepts `any` so Reference<T> is covariant in T - allows Reference<SubType>
   * to be assigned where Reference<SuperType> is expected.
   */
  // biome-ignore lint/suspicious/noExplicitAny: covariance - internal symbol method, never called by user code
  [HYDRATE](value: Persistent<any>): void {
    this._value = value as Persistent<T>;
  }

  /**
   * Implement PromiseLike - makes the reference directly awaitable.
   *
   * `await post.author` becomes possible without calling .resolve().
   *
   * If already loaded, returns immediately (no async).
   * Otherwise, resolves first then returns.
   */
  then<TResult1 = Persistent<T> | undefined, TResult2 = never>(
    onfulfilled?:
      | ((value: Persistent<T> | undefined) => TResult1 | PromiseLike<TResult1>)
      | null
      | undefined,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null
      | undefined,
  ): PromiseLike<TResult1 | TResult2> {
    // If already loaded, return immediately (fast path)
    if (this._value !== null) {
      return Promise.resolve(this._value).then(onfulfilled, onrejected);
    }
    // Otherwise resolve first
    return this.resolve().then(onfulfilled, onrejected);
  }

  /**
   * Resolve the reference, fetching the entity.
   * Returns undefined if the referenced entity does not exist.
   * Caches the result - subsequent calls return the cached value.
   *
   * Usually you can just `await` the reference directly instead.
   */
  async resolve(): Promise<Persistent<T> | undefined> {
    if (this._value !== null) {
      return this._value;
    }

    if (this._resolver === null) {
      throw new Error(
        'Reference has no resolver. Was this entity loaded from a repository?',
      );
    }

    const resolved = await this._resolver(this._id);
    if (resolved === null) {
      return undefined;
    }

    this._value = resolved;
    return resolved;
  }

  /**
   * Create a reference that's already resolved.
   * Uses ExtractModelData to ensure compatibility with field.ref() types.
   *
   * @param key - The adapter-internal key for this entity
   * @param entity - The already-loaded entity
   */
  static resolved<M>(key: string, entity: Persistent<M>): Reference<ExtractModelData<M>> {
    const ref = new Reference<ExtractModelData<M>>(key);
    ref._value = entity as Persistent<ExtractModelData<M>>;
    return ref;
  }
}

/**
 * Type guard to check if a value is a Reference.
 */
export function isReference<T>(value: unknown): value is Reference<T> {
  return (
    value !== null &&
    typeof value === 'object' &&
    REFERENCE in value &&
    (value as Record<symbol, unknown>)[REFERENCE] === true
  );
}

/**
 * A collection of references to other entities that implements PromiseLike.
 *
 * Just like Reference, you can directly await References:
 *   const tags = await post.tags;
 *
 * @example
 * ```typescript
 * const Post = defineModel('Post', {
 *   title: field.string(),
 *   tags: field.refs(Tag),
 * });
 *
 * const post = await postRepo.get(Post.ref('1'));
 *
 * // Just await the references - no .resolveAll() needed!
 * const tags = await post.tags;
 *
 * // Works with Promise.all too
 * const [author, tags] = await Promise.all([post.author, post.tags]);
 *
 * // Sync access
 * post.tags.identifiers; // ['tag-1', 'tag-2']
 * post.tags.length;    // 2
 * post.tags.isLoaded;  // true (after await)
 * post.tags.values;    // Tag[] (sync, throws if not loaded)
 * ```
 */
export class References<T> implements PromiseLike<Persistent<T>[]> {
  /** Symbol marker for type identification */
  readonly [REFERENCES] = true as const;

  /** Internal IDs storage */
  private readonly _ids: string[];

  /** Internal cached values */
  private _values: Persistent<T>[] | null = null;

  /** Internal resolver */
  private _resolver: ReferenceResolver<T> | null = null;

  /** Internal batch resolver (optional, used for efficient batching) */
  private _batchResolver: BatchReferenceResolver<T> | null = null;

  constructor(ids: string[]) {
    this._ids = ids;
  }

  /** The raw identifiers of the referenced entities - use for infrastructure only */
  get identifiers(): readonly string[] {
    return this._ids;
  }

  /** Number of references */
  get length(): number {
    return this._ids.length;
  }

  /** Whether the references have been resolved */
  get isLoaded(): boolean {
    return this._values !== null;
  }

  /** The resolved entities (throws if not loaded) */
  get values(): Persistent<T>[] {
    if (this._values === null) {
      throw new Error('References not loaded. Await the references first.');
    }
    return this._values;
  }

  /** The resolved entities or null if not loaded */
  get valuesOrNull(): Persistent<T>[] | null {
    return this._values;
  }

  /**
   * Attach a resolver to these references.
   * Uses Symbol-keyed method for internal use only.
   */
  [SET_RESOLVER](resolver: ReferenceResolver<T>): void {
    this._resolver = resolver;
  }

  /**
   * Pre-populate these references with already-loaded entities.
   * Uses Symbol-keyed method for internal use only.
   */
  [HYDRATE](values: Persistent<T>[]): void {
    this._values = values;
  }

  /**
   * Attach a batch resolver to these references.
   * When available, this will be used instead of the single resolver for better performance.
   *
   * @internal
   */
  setBatchResolver(batchResolver: BatchReferenceResolver<T>): void {
    this._batchResolver = batchResolver;
  }

  /**
   * Implement PromiseLike - makes the references directly awaitable.
   *
   * `await post.tags` becomes possible without calling .resolveAll().
   */
  then<TResult1 = Persistent<T>[], TResult2 = never>(
    onfulfilled?:
      | ((value: Persistent<T>[]) => TResult1 | PromiseLike<TResult1>)
      | null
      | undefined,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null
      | undefined,
  ): PromiseLike<TResult1 | TResult2> {
    // If already loaded, return immediately (fast path)
    if (this._values !== null) {
      return Promise.resolve(this._values).then(onfulfilled, onrejected);
    }
    // Otherwise resolve first
    return this.resolveAll().then(onfulfilled, onrejected);
  }

  /**
   * Resolve all references, fetching the entities.
   * Caches the result - subsequent calls return the cached values.
   *
   * If a batch resolver is available, it will be used for efficient batching.
   * Otherwise, falls back to resolving IDs one at a time.
   *
   * Usually you can just `await` the references directly instead.
   */
  async resolveAll(): Promise<Persistent<T>[]> {
    if (this._values !== null) {
      return this._values;
    }

    if (this._resolver === null) {
      throw new Error(
        'References have no resolver. Was this entity loaded from a repository?',
      );
    }

    // Use batch resolver if available (more efficient)
    if (this._batchResolver !== null) {
      const resultMap = await this._batchResolver(this._ids);
      const results: Persistent<T>[] = [];

      // Preserve order and filter out nulls
      for (const id of this._ids) {
        const resolved = resultMap.get(id);
        if (resolved !== null && resolved !== undefined) {
          results.push(resolved);
        }
      }

      this._values = results;
      return results;
    }

    // Fall back to one-by-one resolution
    const results: Persistent<T>[] = [];
    for (const id of this._ids) {
      const resolved = await this._resolver(id);
      if (resolved !== null) {
        results.push(resolved);
      }
    }

    this._values = results;
    return results;
  }

  /**
   * Create references that are already resolved.
   * Uses ExtractModelData to ensure compatibility with field.refs() types.
   *
   * @param keys - The adapter-internal keys for the entities
   * @param entities - The already-loaded entities (must match keys order)
   */
  static resolved<M>(keys: string[], entities: Persistent<M>[]): References<ExtractModelData<M>> {
    const refs = new References<ExtractModelData<M>>(keys);
    refs._values = entities as Persistent<ExtractModelData<M>>[];
    return refs;
  }
}

/**
 * Type guard to check if a value is a References collection.
 */
export function isReferences<T>(value: unknown): value is References<T> {
  return (
    value !== null &&
    typeof value === 'object' &&
    REFERENCES in value &&
    (value as Record<symbol, unknown>)[REFERENCES] === true
  );
}
