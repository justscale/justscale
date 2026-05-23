/**
 * DataLoader - Batches and caches entity lookups within a request.
 *
 * When multiple references are awaited, instead of N queries,
 * DataLoader batches them into a single WHERE id IN (...) query.
 *
 * This implementation uses the microtask queue to batch multiple
 * load() calls made in the same tick into a single batch function call.
 *
 * @example
 * ```typescript
 * const loader = new DataLoader(async (ids) => {
 *   const users = await sql`SELECT * FROM users WHERE id = ANY(${ids})`;
 *   return new Map(users.map(u => [u.id, u]));
 * });
 *
 * // These three calls will be batched into a single query
 * const [user1, user2, user3] = await Promise.all([
 *   loader.load('id1'),
 *   loader.load('id2'),
 *   loader.load('id3'),
 * ]);
 * ```
 */

/**
 * Batch function that loads multiple IDs in one query.
 * Returns a Map of id -> entity (or undefined if not found).
 */
export type BatchLoadFn<T> = (
  ids: string[],
) => Promise<Map<string, T | undefined>>;

/**
 * DataLoader class that batches and caches entity lookups.
 */
export class DataLoader<T> {
  private pending: Map<
    string,
    Array<{
      resolve: (value: T | undefined) => void
      reject: (error: unknown) => void
    }>
  >;
  private cache: Map<string, T | undefined>;
  private batchFn: BatchLoadFn<T>;
  private batchScheduled: boolean;

  constructor(batchFn: BatchLoadFn<T>) {
    this.pending = new Map();
    this.cache = new Map();
    this.batchFn = batchFn;
    this.batchScheduled = false;
  }

  /**
   * Load a single ID (batched automatically).
   * Multiple calls in the same tick are batched together.
   */
  load(id: string): Promise<T | undefined> {
    // Check cache first
    if (this.cache.has(id)) {
      return Promise.resolve(this.cache.get(id));
    }

    // Create promise and add to pending
    return new Promise<T | undefined>((resolve, reject) => {
      const callbacks = this.pending.get(id);
      if (callbacks) {
        callbacks.push({ resolve, reject });
      } else {
        this.pending.set(id, [{ resolve, reject }]);
      }

      // Schedule batch execution if not already scheduled
      if (!this.batchScheduled) {
        this.batchScheduled = true;
        queueMicrotask(() => this.executeBatch());
      }
    });
  }

  /**
   * Load multiple IDs (batched automatically).
   * This is a convenience method that calls load() for each ID.
   */
  loadMany(ids: string[]): Promise<(T | undefined)[]> {
    return Promise.all(ids.map((id) => this.load(id)));
  }

  /**
   * Clear the cache.
   * Pending batches are not affected.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Prime the cache with a known value.
   * Useful for pre-loading entities that are already available.
   */
  prime(id: string, value: T): void {
    this.cache.set(id, value);
  }

  /**
   * Execute the pending batch.
   * Called at the end of the tick via queueMicrotask.
   */
  private async executeBatch(): Promise<void> {
    this.batchScheduled = false;

    // Get all pending IDs and callbacks
    const pending = this.pending;
    this.pending = new Map();

    if (pending.size === 0) {
      return;
    }

    const ids = Array.from(pending.keys());

    try {
      // Execute batch function
      const results = await this.batchFn(ids);

      // Distribute results to waiting promises
      for (const id of ids) {
        const callbacks = pending.get(id)!;
        const value = results.get(id);

        // Cache the result
        this.cache.set(id, value);

        // Resolve all waiting promises for this ID
        for (const { resolve } of callbacks) {
          resolve(value);
        }
      }
    } catch (error) {
      // Reject all pending promises on error
      for (const callbacks of pending.values()) {
        for (const { reject } of callbacks) {
          reject(error);
        }
      }
    }
  }
}
