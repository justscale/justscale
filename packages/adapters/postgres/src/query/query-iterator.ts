/**
 * PostgreSQL Query Iterator
 *
 * Implements the DurableIterable protocol for repository queries using
 * keyset pagination. This allows for-of loops with suspension points
 * to resume correctly even when data changes between suspend/resume.
 *
 * @example
 * ```typescript
 * createProcess({
 *   path: '/batch/:batchId',
 *   inject: { orders: OrderRepository },
 *
 *   async handler({ orders }, [batchId]) {
 *     // This now works! Repository returns DurableIterable
 *     for (const order of orders.query().where(...).orderBy('createdAt', 'id')) {
 *       await signal(fulfillment.shipped)
 *       // Suspend -> cursor = { queryHash: "...", lastSeen: { createdAt: X, id: Y } }
 *       // Resume -> continues from keyset position
 *     }
 *   },
 * })
 * ```
 */

import {
  DurableCursor,
  FromCursor,
  type DurableCursorType,
  type DurableIterable,
} from '@justscale/core/process';
import { hashStringToBigInt } from '../utils/hash.js';


/**
 * Error thrown when a query changes between process suspend and resume.
 *
 * This is a data integrity issue - the cursor from the old query cannot
 * be safely applied to the new query. The process should fail rather than
 * silently skip or duplicate rows.
 */
export class ProcessIntegrityError extends Error {
  readonly code = 'PROCESS_INTEGRITY_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'ProcessIntegrityError';
  }
}


/**
 * Cursor for keyset pagination.
 *
 * Contains all information needed to resume iteration:
 * - queryHash: Validates the query hasn't changed
 * - sortKey: Column names in ORDER BY
 * - lastSeen: Values from the last processed row (serialized)
 * - directions: ASC/DESC for each column
 *
 * Note: lastSeen values are serialized to DurableCursorType-compatible format.
 * Dates are stored as ISO strings.
 */
export interface KeysetCursor {
  /** Hash of the query structure (validates query hasn't changed) */
  queryHash: string
  /** Column names in ORDER BY clause */
  sortKey: string[]
  /** Last seen values for each sort key column (serialized) */
  lastSeen: Record<string, DurableCursorType>
  /** Direction for each column (asc or desc) */
  directions: ('asc' | 'desc')[]
}


/**
 * Minimal interface for a query builder that can be used with PgQueryIterator.
 * This allows the iterator to work with different query builder implementations.
 */
export interface QueryBuilderLike<T> {
  /** Clone the query builder */
  clone(): QueryBuilderLike<T>

  /** Add LIMIT clause */
  limit(n: number): QueryBuilderLike<T>

  /** Execute the query and return results */
  execute(): Promise<T[]>

  /** Get ORDER BY column names */
  getOrderByColumns(): string[]

  /** Get ORDER BY directions */
  getOrderByDirections(): ('asc' | 'desc')[]

  /** Check if a column has a unique constraint */
  hasUniqueColumn(column: string): boolean

  /** Get the primary key column name (adapter-specific) */
  getPrimaryKeyColumn?(): string

  /** Append an ORDER BY column (for auto-appending PK tiebreaker) */
  appendOrderBy?(column: string, direction: 'asc' | 'desc'): void

  /** Get a hash of the query structure for integrity checking */
  toHash(): string

  /**
   * Apply keyset pagination filter.
   *
   * For ORDER BY created_at DESC, id ASC with lastSeen = { created_at: X, id: Y }:
   * WHERE (created_at < X)
   *    OR (created_at = X AND id > Y)
   */
  whereKeyset(
    sortKey: string[],
    lastSeen: Record<string, unknown>,
    directions: ('asc' | 'desc')[],
  ): QueryBuilderLike<T>
}


/**
 * Durable iterator for PostgreSQL queries using keyset pagination.
 *
 * **Why keyset pagination instead of offset?**
 *
 * Offset-based pagination breaks when data changes:
 * ```
 * Before suspend:  [A, B, C, D, E]  - at offset 2 (C)
 * Delete A:        [B, C, D, E]
 * After resume:    offset 2 = D (skipped C!)
 * ```
 *
 * Keyset pagination uses the last-seen values as cursor:
 * ```
 * Before suspend:  [A, B, C, D, E]  - cursor: { id: 'C' }
 * Delete A:        [B, C, D, E]
 * After resume:    WHERE id > 'C' = D (correct!)
 * ```
 *
 * **Consistency guarantees:**
 *
 * | Scenario | Result |
 * |----------|--------|
 * | Item deleted before cursor | Correct (already processed) |
 * | Item deleted after cursor | Correct (will be skipped) |
 * | Item inserted before cursor | Correct (won't reprocess) |
 * | Item inserted after cursor | Correct (will process) |
 * | Item updated, sort key unchanged | Correct |
 * | Item updated, moves before cursor | Skipped (already "passed") |
 * | Item updated, moves after cursor | Will process |
 */
export class PgQueryIterator<T extends Record<string, unknown>>
implements DurableIterable<T>, AsyncIterableIterator<T>
{
  declare readonly __durableIterator: true;
  declare readonly __cursorType: Record<string, string | number>;
  declare readonly orderBy: string[];

  private lastSeen: Record<string, unknown> | null = null;
  private readonly queryHash: string;
  private readonly sortKey: string[];
  private readonly directions: ('asc' | 'desc')[];
  private currentBatch: T[] = [];
  private batchIndex = 0;
  private exhausted = false;

  constructor(
    private readonly query: QueryBuilderLike<T>,
    private readonly batchSize: number = 100,
    private readonly rowMapper?: (row: T) => T,
  ) {
    this.sortKey = query.getOrderByColumns();
    this.directions = query.getOrderByDirections();
    this.queryHash = query.toHash();

    // Keyset pagination requires ORDER BY
    if (this.sortKey.length === 0) {
      throw new Error(
        'Durable iteration requires ORDER BY clause. ' +
          'Add .orderBy() to your query to enable keyset pagination.',
      );
    }

    // Last column must be unique for deterministic ordering
    // If not, auto-append the adapter's primary key column
    const lastCol = this.sortKey.at(-1)!;
    if (!query.hasUniqueColumn(lastCol)) {
      const pkColumn = query.getPrimaryKeyColumn?.() ?? 'id';
      this.sortKey.push(pkColumn);
      this.directions.push('asc');
      query.appendOrderBy?.(pkColumn, 'asc');
    }
  }

  /**
   * Serialize a value to DurableCursorType.
   * Dates are converted to ISO strings.
   * Null values use a typed encoding to preserve type info.
   */
  private serializeValue(value: unknown): DurableCursorType {
    if (value instanceof Date) {
      return { __type: 'date', value: value.toISOString() };
    }
    if (typeof value === 'string' || typeof value === 'number') {
      return value;
    }
    if (value === null) {
      return { __type: 'null' };
    }
    if (value === undefined) {
      return { __type: 'undefined' };
    }
    // For other objects, stringify them with type marker
    return { __type: 'json', value: JSON.stringify(value) };
  }

  /**
   * Deserialize a cursor value back to its original type.
   */
  private deserializeValue(value: DurableCursorType): unknown {
    if (typeof value === 'string' || typeof value === 'number') {
      return value;
    }
    if (typeof value === 'object' && value !== null && '__type' in value) {
      const typed = value as { __type: string; value?: string };
      switch (typed.__type) {
        case 'null':
          return null;
        case 'undefined':
          return undefined;
        case 'date':
          return new Date(typed.value!);
        case 'json':
          return JSON.parse(typed.value!);
      }
    }
    return value;
  }

  /**
   * Get current cursor position.
   * Called by runtime before suspension to persist position.
   */
  [DurableCursor](): DurableCursorType {
    const serializedLastSeen: Record<string, DurableCursorType> = {};
    if (this.lastSeen) {
      for (const [key, value] of Object.entries(this.lastSeen)) {
        serializedLastSeen[key] = this.serializeValue(value);
      }
    }

    return {
      queryHash: this.queryHash,
      sortKey: this.sortKey,
      lastSeen: serializedLastSeen,
      directions: this.directions,
    };
  }

  /**
   * Create iterator from a saved cursor.
   * Called by runtime on resume to continue iteration.
   */
  [FromCursor](cursor: DurableCursorType): AsyncIterableIterator<T> {
    const c = cursor as unknown as KeysetCursor;

    // Validate query hasn't changed
    if (c.queryHash !== this.queryHash) {
      throw new ProcessIntegrityError(
        'Query changed between suspend/resume. ' +
          'The cursor from the previous query cannot be applied to the modified query. ' +
          `Expected hash: ${c.queryHash}, got: ${this.queryHash}`,
      );
    }

    // Create new iterator starting from the cursor position
    const iterator = new PgQueryIterator<T>(this.query, this.batchSize);

    // Deserialize the cursor values back to their original types
    if (Object.keys(c.lastSeen).length > 0) {
      const deserializedLastSeen: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(c.lastSeen)) {
        deserializedLastSeen[key] = iterator.deserializeValue(value);
      }
      iterator.lastSeen = deserializedLastSeen;
    } else {
      iterator.lastSeen = null;
    }

    return iterator;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }

  async next(): Promise<IteratorResult<T>> {
    // If we have items in the current batch, return the next one
    if (this.batchIndex < this.currentBatch.length) {
      const item = this.currentBatch[this.batchIndex];
      this.batchIndex++;

      // Update cursor position
      this.lastSeen = Object.fromEntries(
        this.sortKey.map((col) => [col, item[col]]),
      );

      return { done: false, value: item };
    }

    // If exhausted, we're done
    if (this.exhausted) {
      return { done: true, value: undefined };
    }

    // Fetch next batch
    let q = this.query.clone();

    // Apply keyset filter if we have a cursor
    if (this.lastSeen && Object.keys(this.lastSeen).length > 0) {
      q = q.whereKeyset(this.sortKey, this.lastSeen, this.directions);
    }

    const rawBatch = await q.limit(this.batchSize).execute();
    this.currentBatch = this.rowMapper ? rawBatch.map(this.rowMapper) : rawBatch;
    this.batchIndex = 0;

    // Check if we got any results
    if (this.currentBatch.length === 0) {
      this.exhausted = true;
      return { done: true, value: undefined };
    }

    // Check if this is the last batch
    if (this.currentBatch.length < this.batchSize) {
      this.exhausted = true;
    }

    // Return first item from new batch
    const item = this.currentBatch[this.batchIndex];
    this.batchIndex++;

    // Update cursor position
    this.lastSeen = Object.fromEntries(
      this.sortKey.map((col) => [col, item[col]]),
    );

    return { done: false, value: item };
  }
}


/**
 * Generate WHERE clause SQL for keyset pagination.
 *
 * For multi-column ORDER BY, generates a compound comparison:
 *
 * ORDER BY created_at DESC, id ASC:
 * WHERE (created_at < $1)
 *    OR (created_at = $1 AND id > $2)
 *
 * ORDER BY category ASC, created_at DESC, id ASC:
 * WHERE (category > $1)
 *    OR (category = $1 AND created_at < $2)
 *    OR (category = $1 AND created_at = $2 AND id > $3)
 *
 * @param sortKey - Column names in ORDER BY
 * @param lastSeen - Values from last processed row
 * @param directions - ASC/DESC for each column
 * @returns Object with SQL text and parameter values
 */
export function generateKeysetWhereClause(
  sortKey: string[],
  lastSeen: Record<string, unknown>,
  directions: ('asc' | 'desc')[],
): { text: string; values: unknown[] } {
  if (sortKey.length === 0) {
    return { text: 'TRUE', values: [] };
  }

  const values: unknown[] = [];
  const conditions: string[] = [];

  // Build compound OR conditions
  // For each prefix of columns, generate: (col1 = v1 AND col2 = v2 AND ... AND colN [<|>] vN)
  for (let i = 0; i < sortKey.length; i++) {
    const parts: string[] = [];

    // Add equality conditions for all preceding columns
    for (let j = 0; j < i; j++) {
      const col = sortKey[j];
      const paramIndex = values.length + 1;
      values.push(lastSeen[col]);
      parts.push(`${col} = $${paramIndex}`);
    }

    // Add inequality for current column
    const col = sortKey[i];
    const dir = directions[i];
    const op = dir === 'asc' ? '>' : '<';
    const paramIndex = values.length + 1;
    values.push(lastSeen[col]);
    parts.push(`${col} ${op} $${paramIndex}`);

    conditions.push(`(${parts.join(' AND ')})`);
  }

  return {
    text: conditions.join(' OR '),
    values,
  };
}

/**
 * Create a hash string from a query structure.
 *
 * This hash is used to detect if the query has changed between
 * process suspend and resume. Uses the same FNV-1a algorithm
 * as the lock key hashing for consistency.
 *
 * @param queryParts - Parts of the query to hash (table, columns, where, etc.)
 * @returns A hex string hash
 */
export function createQueryHash(queryParts: {
  table: string
  columns?: string[]
  where?: string
  orderBy?: string
}): string {
  const canonical = JSON.stringify([
    queryParts.table,
    queryParts.columns?.sort() ?? [],
    queryParts.where ?? '',
    queryParts.orderBy ?? '',
  ]);

  const hash = hashStringToBigInt(canonical);
  // Convert to hex string for readability
  return (hash >= 0n ? hash : -hash).toString(16);
}
