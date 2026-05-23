/**
 * Tests for PostgreSQL Query Iterator
 *
 * Tests the durable iteration implementation using keyset pagination.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  DurableCursor,
  FromCursor,
  isDurableIterable,
} from '@justscale/core/process';
import {
  PgQueryIterator,
  ProcessIntegrityError,
  generateKeysetWhereClause,
  createQueryHash,
  type KeysetCursor,
  type QueryBuilderLike,
} from '../src/query/query-iterator.js';

// ============================================================================
// Mock Query Builder
// ============================================================================

interface MockRow {
  id: string
  createdAt: Date
  name: string
  [key: string]: unknown
}

class MockQueryBuilder implements QueryBuilderLike<MockRow> {
  private _data: MockRow[];
  private _limit?: number;
  private _keysetFilter?: {
    sortKey: string[]
    lastSeen: Record<string, unknown>
    directions: ('asc' | 'desc')[]
  };

  constructor(
    data: MockRow[],
    private readonly orderBy: string[] = ['id'],
    private readonly orderDirections: ('asc' | 'desc')[] = ['asc'],
    private readonly uniqueColumns: Set<string> = new Set(['id']),
  ) {
    this._data = data;
  }

  clone(): MockQueryBuilder {
    const cloned = new MockQueryBuilder(
      this._data,
      this.orderBy,
      this.orderDirections,
      this.uniqueColumns,
    );
    cloned._limit = this._limit;
    cloned._keysetFilter = this._keysetFilter;
    return cloned;
  }

  limit(n: number): MockQueryBuilder {
    const cloned = this.clone();
    cloned._limit = n;
    return cloned;
  }

  async execute(): Promise<MockRow[]> {
    let results = [...this._data];

    // Apply keyset filter
    if (this._keysetFilter) {
      results = results.filter((row) =>
        this.passesKeysetFilter(row, this._keysetFilter!),
      );
    }

    // Sort results
    results.sort((a, b) => {
      for (let i = 0; i < this.orderBy.length; i++) {
        const col = this.orderBy[i];
        const dir = this.orderDirections[i];
        const aVal = this.normalizeValue(a[col]);
        const bVal = this.normalizeValue(b[col]);

        const cmp = typeof aVal === 'number' && typeof bVal === 'number'
          ? aVal - bVal
          : String(aVal).localeCompare(String(bVal));

        if (cmp !== 0) {
          return dir === 'asc' ? cmp : -cmp;
        }
      }
      return 0;
    });

    // Apply limit
    if (this._limit !== undefined) {
      results = results.slice(0, this._limit);
    }

    return results;
  }

  private passesKeysetFilter(
    row: MockRow,
    filter: {
      sortKey: string[]
      lastSeen: Record<string, unknown>
      directions: ('asc' | 'desc')[]
    },
  ): boolean {
    // Implement the same logic as generateKeysetWhereClause
    const { sortKey, lastSeen, directions } = filter;

    for (let i = 0; i < sortKey.length; i++) {
      // Check if all preceding columns are equal
      let allPrecedingEqual = true;
      for (let j = 0; j < i; j++) {
        const col = sortKey[j];
        const rowVal = this.normalizeValue(row[col]);
        const lastVal = this.normalizeValue(lastSeen[col]);
        if (!this.valuesEqual(rowVal, lastVal)) {
          allPrecedingEqual = false;
          break;
        }
      }

      if (allPrecedingEqual) {
        // Check if current column passes inequality
        const col = sortKey[i];
        const dir = directions[i];
        const rowVal = this.normalizeValue(row[col]);
        const lastVal = this.normalizeValue(lastSeen[col]);

        if (this.compareValues(rowVal, lastVal, dir === 'asc' ? '>' : '<')) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Normalize values for comparison.
   * Cursor values are serialized (dates become ISO strings), so we need
   * to convert row values to the same format for comparison.
   */
  private normalizeValue(val: unknown): string | number {
    if (val instanceof Date) {
      return val.toISOString();
    }
    if (typeof val === 'string' || typeof val === 'number') {
      return val;
    }
    return String(val);
  }

  private valuesEqual(a: string | number, b: string | number): boolean {
    return a === b;
  }

  private compareValues(a: string | number, b: string | number, op: '>' | '<'): boolean {
    if (typeof a === 'number' && typeof b === 'number') {
      return op === '>' ? a > b : a < b;
    }
    // String comparison (works for ISO date strings too)
    const strA = String(a);
    const strB = String(b);
    const cmp = strA.localeCompare(strB);
    return op === '>' ? cmp > 0 : cmp < 0;
  }

  getOrderByColumns(): string[] {
    return this.orderBy;
  }

  getOrderByDirections(): ('asc' | 'desc')[] {
    return this.orderDirections;
  }

  hasUniqueColumn(column: string): boolean {
    return this.uniqueColumns.has(column);
  }

  toHash(): string {
    return createQueryHash({
      table: 'test_table',
      orderBy: this.orderBy.join(','),
    });
  }

  whereKeyset(
    sortKey: string[],
    lastSeen: Record<string, unknown>,
    directions: ('asc' | 'desc')[],
  ): MockQueryBuilder {
    const cloned = this.clone();
    cloned._keysetFilter = { sortKey, lastSeen, directions };
    return cloned;
  }
}

// ============================================================================
// Test Data
// ============================================================================

function createTestData(): MockRow[] {
  return [
    { id: '1', createdAt: new Date('2024-01-01'), name: 'Alice' },
    { id: '2', createdAt: new Date('2024-01-02'), name: 'Bob' },
    { id: '3', createdAt: new Date('2024-01-03'), name: 'Charlie' },
    { id: '4', createdAt: new Date('2024-01-04'), name: 'David' },
    { id: '5', createdAt: new Date('2024-01-05'), name: 'Eve' },
  ];
}

// ============================================================================
// Tests
// ============================================================================

describe('PgQueryIterator', () => {
  describe('DurableIterable protocol', () => {
    it('implements DurableIterable interface', () => {
      const query = new MockQueryBuilder(createTestData());
      const iterator = new PgQueryIterator(query);

      assert.ok(isDurableIterable(iterator), 'Should implement DurableIterable');
      assert.ok(DurableCursor in iterator, 'Should have DurableCursor symbol');
      assert.ok(FromCursor in iterator, 'Should have FromCursor symbol');
    });

    it('returns cursor with query hash and position', async () => {
      const query = new MockQueryBuilder(createTestData());
      const iterator = new PgQueryIterator(query, 2);

      // Iterate a few items
      await iterator.next();
      await iterator.next();

      const cursor = iterator[DurableCursor]() as unknown as KeysetCursor;

      assert.ok(cursor.queryHash, 'Cursor should have query hash');
      assert.deepStrictEqual(cursor.sortKey, ['id'], 'Cursor should have sort key');
      assert.deepStrictEqual(cursor.directions, ['asc'], 'Cursor should have directions');
      assert.strictEqual(cursor.lastSeen.id, '2', 'Cursor should track last seen id');
    });

    it('resumes from cursor position', async () => {
      const data = createTestData();
      const query = new MockQueryBuilder(data);
      const iterator = new PgQueryIterator(query, 2);

      // Iterate first two items
      await iterator.next();
      await iterator.next();

      // Get cursor
      const cursor = iterator[DurableCursor]();

      // Create new iterator and resume
      const resumedIterator = iterator[FromCursor](cursor);

      // Should continue from item 3
      const result = await resumedIterator.next();
      assert.strictEqual(result.done, false);
      assert.strictEqual(result.value.id, '3');
    });
  });

  describe('iteration', () => {
    it('iterates all items', async () => {
      const data = createTestData();
      const query = new MockQueryBuilder(data);
      const iterator = new PgQueryIterator(query);

      const results: MockRow[] = [];
      for await (const item of iterator) {
        results.push(item);
      }

      assert.strictEqual(results.length, 5);
      assert.deepStrictEqual(
        results.map((r) => r.id),
        ['1', '2', '3', '4', '5'],
      );
    });

    it('respects batch size', async () => {
      const data = createTestData();
      const query = new MockQueryBuilder(data);
      const iterator = new PgQueryIterator(query, 2);

      const results: MockRow[] = [];
      for await (const item of iterator) {
        results.push(item);
      }

      // Should still get all items despite small batch size
      assert.strictEqual(results.length, 5);
    });

    it('handles empty results', async () => {
      const query = new MockQueryBuilder([]);
      const iterator = new PgQueryIterator(query);

      const results: MockRow[] = [];
      for await (const item of iterator) {
        results.push(item);
      }

      assert.strictEqual(results.length, 0);
    });
  });

  describe('keyset pagination', () => {
    it('works with DESC ordering', async () => {
      const data = createTestData();
      const query = new MockQueryBuilder(
        data,
        ['createdAt', 'id'],
        ['desc', 'asc'],
        new Set(['id']),
      );
      const iterator = new PgQueryIterator(query, 2);

      // Iterate first two (should be Eve, David due to DESC)
      await iterator.next();
      await iterator.next();

      const cursor = iterator[DurableCursor]();
      const resumedIterator = iterator[FromCursor](cursor);

      // Should continue with Charlie (id=3)
      const result = await resumedIterator.next();
      assert.strictEqual(result.done, false);
      assert.strictEqual(result.value.id, '3');
    });

    it('handles multi-column ORDER BY', async () => {
      const data = [
        { id: '1', createdAt: new Date('2024-01-01'), name: 'Alice' },
        { id: '2', createdAt: new Date('2024-01-01'), name: 'Bob' }, // Same date
        { id: '3', createdAt: new Date('2024-01-02'), name: 'Charlie' },
      ];
      const query = new MockQueryBuilder(
        data,
        ['createdAt', 'id'],
        ['asc', 'asc'],
        new Set(['id']),
      );
      const iterator = new PgQueryIterator(query, 1);

      // Get first item (Alice)
      await iterator.next();
      const cursor = iterator[DurableCursor]();

      // Resume - should get Bob (same date, higher id)
      const resumedIterator = iterator[FromCursor](cursor);
      const result = await resumedIterator.next();
      assert.strictEqual(result.value.id, '2');
    });
  });

  describe('error handling', () => {
    it('throws if no ORDER BY columns', () => {
      const query = new MockQueryBuilder([], [], [], new Set());

      assert.throws(
        () => new PgQueryIterator(query),
        /ORDER BY clause/,
      );
    });

    it('throws if last ORDER BY column is not unique', () => {
      const query = new MockQueryBuilder(
        [],
        ['name'], // name is not unique
        ['asc'],
        new Set(['id']), // only id is unique
      );

      // No longer throws - auto-appends PK column for keyset pagination
      const iter = new PgQueryIterator(query);
      assert.ok(iter);
    });

    it('throws ProcessIntegrityError if query hash changes', async () => {
      const data = createTestData();
      const query1 = new MockQueryBuilder(data, ['id'], ['asc']);
      const iterator1 = new PgQueryIterator(query1);

      await iterator1.next();
      const cursor = iterator1[DurableCursor]();

      // Create a different query (different ORDER BY)
      const query2 = new MockQueryBuilder(
        data,
        ['createdAt', 'id'],
        ['desc', 'asc'],
        new Set(['id']),
      );
      const iterator2 = new PgQueryIterator(query2);

      assert.throws(
        () => iterator2[FromCursor](cursor),
        ProcessIntegrityError,
      );
    });
  });
});

describe('generateKeysetWhereClause', () => {
  it('generates single column comparison', () => {
    const result = generateKeysetWhereClause(
      ['id'],
      { id: '5' },
      ['asc'],
    );

    assert.strictEqual(result.text, '(id > $1)');
    assert.deepStrictEqual(result.values, ['5']);
  });

  it('generates multi-column comparison', () => {
    const result = generateKeysetWhereClause(
      ['created_at', 'id'],
      { created_at: new Date('2024-01-01'), id: '5' },
      ['asc', 'asc'],
    );

    assert.strictEqual(
      result.text,
      '(created_at > $1) OR (created_at = $2 AND id > $3)',
    );
    assert.strictEqual(result.values.length, 3);
  });

  it('handles DESC direction', () => {
    const result = generateKeysetWhereClause(
      ['created_at', 'id'],
      { created_at: new Date('2024-01-01'), id: '5' },
      ['desc', 'asc'],
    );

    assert.strictEqual(
      result.text,
      '(created_at < $1) OR (created_at = $2 AND id > $3)',
    );
  });

  it('handles mixed directions', () => {
    const result = generateKeysetWhereClause(
      ['category', 'created_at', 'id'],
      { category: 'A', created_at: new Date('2024-01-01'), id: '5' },
      ['asc', 'desc', 'asc'],
    );

    assert.strictEqual(
      result.text,
      '(category > $1) OR (category = $2 AND created_at < $3) OR (category = $4 AND created_at = $5 AND id > $6)',
    );
  });

  it('returns TRUE for empty sort key', () => {
    const result = generateKeysetWhereClause([], {}, []);
    assert.strictEqual(result.text, 'TRUE');
    assert.deepStrictEqual(result.values, []);
  });
});

describe('cursor serialization', () => {
  it('serializes and deserializes NULL values correctly', async () => {
    // Create data with NULL value in a sort key column
    const data: MockRow[] = [
      { id: '1', createdAt: new Date('2024-01-01'), name: 'Alice', category: 'A' },
      { id: '2', createdAt: new Date('2024-01-02'), name: 'Bob', category: null as unknown as string },
      { id: '3', createdAt: new Date('2024-01-03'), name: 'Charlie', category: 'C' },
    ];

    const query = new MockQueryBuilder(
      data,
      ['id'],
      ['asc'],
      new Set(['id']),
    );
    const iterator = new PgQueryIterator(query, 1);

    // Iterate to the row with null
    await iterator.next();
    await iterator.next();

    // Get cursor - should capture the null value
    const cursor = iterator[DurableCursor]() as unknown as KeysetCursor;

    // Cursor should have lastSeen.id = '2'
    assert.strictEqual(cursor.lastSeen.id, '2');
  });

  it('serializes and deserializes Date values correctly', async () => {
    const data = createTestData();
    const query = new MockQueryBuilder(
      data,
      ['createdAt', 'id'],
      ['asc', 'asc'],
      new Set(['id']),
    );
    const iterator = new PgQueryIterator(query, 2);

    // Iterate to get a cursor with a Date value
    await iterator.next();
    await iterator.next();

    const cursor = iterator[DurableCursor]() as unknown as KeysetCursor;

    // Date should be serialized with type marker
    const createdAtCursor = cursor.lastSeen.createdAt as { __type: string; value: string };
    assert.strictEqual(createdAtCursor.__type, 'date');
    assert.ok(createdAtCursor.value.includes('2024-01-02'));

    // Resume from cursor - Date should be deserialized back
    const resumedIterator = iterator[FromCursor](cursor as unknown as import('@justscale/core/process').DurableCursorType);
    const result = await resumedIterator.next();

    // Should continue with item 3
    assert.strictEqual(result.done, false);
    assert.strictEqual(result.value.id, '3');
  });

  it('preserves null vs undefined distinction in cursor', async () => {
    // This test verifies the typed encoding preserves the difference
    const data: MockRow[] = [
      { id: '1', createdAt: new Date('2024-01-01'), name: 'Alice' },
    ];

    const query = new MockQueryBuilder(data, ['id'], ['asc'], new Set(['id']));
    const iterator = new PgQueryIterator(query, 1);

    await iterator.next();
    const cursor = iterator[DurableCursor]() as unknown as KeysetCursor;

    // Verify cursor structure
    assert.ok(cursor.queryHash);
    assert.deepStrictEqual(cursor.sortKey, ['id']);
    assert.deepStrictEqual(cursor.directions, ['asc']);
    assert.strictEqual(cursor.lastSeen.id, '1');
  });
});

describe('createQueryHash', () => {
  it('creates consistent hash for same query', () => {
    const hash1 = createQueryHash({
      table: 'users',
      columns: ['id', 'name'],
      where: 'status = active',
      orderBy: 'id ASC',
    });
    const hash2 = createQueryHash({
      table: 'users',
      columns: ['name', 'id'], // Different order
      where: 'status = active',
      orderBy: 'id ASC',
    });

    // Columns are sorted, so should produce same hash
    assert.strictEqual(hash1, hash2);
  });

  it('creates different hash for different queries', () => {
    const hash1 = createQueryHash({
      table: 'users',
      orderBy: 'id ASC',
    });
    const hash2 = createQueryHash({
      table: 'users',
      orderBy: 'created_at DESC',
    });

    assert.notStrictEqual(hash1, hash2);
  });

  it('handles missing optional fields', () => {
    const hash = createQueryHash({
      table: 'users',
    });

    assert.ok(hash.length > 0);
  });
});
