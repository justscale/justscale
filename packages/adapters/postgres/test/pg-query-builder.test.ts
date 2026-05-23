/**
 * Tests for PgQueryBuilder
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PgQueryBuilder } from '../src/query/pg-query-builder.js';
import { PgQueryCompiler } from '../src/query/query-compiler.js';
import { createQueryHash } from '../src/query/query-iterator.js';

// ============================================================================
// Mock Client
// ============================================================================

interface QueryRecord {
  sql: string
  values: unknown[]
}

function createMockClient() {
  const queries: QueryRecord[] = [];
  let nextResult: Record<string, unknown>[] = [];

  const sql = {
    unsafe(query: string, values: unknown[] = []) {
      queries.push({ sql: query, values });
      return Promise.resolve(nextResult);
    },
  };

  return {
    sql,
    queries,
    setNextResult(result: Record<string, unknown>[]) {
      nextResult = result;
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('PgQueryBuilder', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let compiler: PgQueryCompiler;

  beforeEach(() => {
    mockClient = createMockClient();
    compiler = new PgQueryCompiler({
      storageMode: 'columnar',
      tableName: 'orders',
      snakeCase: true,
    });
  });

  describe('clone', () => {
    it('creates an independent copy', () => {
      const builder = new PgQueryBuilder(
        mockClient as any,
        'orders',
        compiler,
        new Set(['id']),
        undefined,
        { createdAt: 'asc' },
      );

      const cloned = builder.clone();

      assert.deepStrictEqual(cloned.getOrderByColumns(), builder.getOrderByColumns());
      assert.deepStrictEqual(cloned.getOrderByDirections(), builder.getOrderByDirections());
      assert.strictEqual(cloned.toHash(), builder.toHash());
    });
  });

  describe('limit', () => {
    it('returns a new builder with limit applied', async () => {
      const builder = new PgQueryBuilder(
        mockClient as any,
        'orders',
        compiler,
        new Set(['id']),
        undefined,
        { id: 'asc' },
      );

      mockClient.setNextResult([]);
      const limited = builder.limit(10);
      await limited.execute();

      assert.strictEqual(mockClient.queries.length, 1);
      assert.ok(mockClient.queries[0].sql.includes('LIMIT 10'));
    });
  });

  describe('execute', () => {
    it('generates basic SELECT query', async () => {
      const builder = new PgQueryBuilder(
        mockClient as any,
        'orders',
        compiler,
        new Set(['id']),
        undefined,
        { id: 'asc' },
      );

      mockClient.setNextResult([{ id: '1' }]);
      const result = await builder.execute();

      assert.strictEqual(mockClient.queries.length, 1);
      assert.ok(mockClient.queries[0].sql.startsWith('SELECT * FROM orders'));
      assert.ok(mockClient.queries[0].sql.includes('ORDER BY'));
      assert.strictEqual(result.length, 1);
    });

    it('includes keyset WHERE when applied', async () => {
      const builder = new PgQueryBuilder(
        mockClient as any,
        'orders',
        compiler,
        new Set(['id']),
        undefined,
        { id: 'asc' },
      );

      const withKeyset = builder.whereKeyset(
        ['id'],
        { id: '5' },
        ['asc'],
      );

      mockClient.setNextResult([]);
      await withKeyset.execute();

      const sql = mockClient.queries[0].sql;
      assert.ok(sql.includes('WHERE'), 'Should have WHERE clause');
      assert.ok(sql.includes('id >'), 'Should have keyset comparison');
      assert.deepStrictEqual(mockClient.queries[0].values, ['5']);
    });
  });

  describe('getOrderByColumns / getOrderByDirections', () => {
    it('parses object form orderBy', () => {
      const builder = new PgQueryBuilder(
        mockClient as any,
        'orders',
        compiler,
        new Set(['id']),
        undefined,
        { createdAt: 'desc', id: 'asc' },
      );

      const columns = builder.getOrderByColumns();
      const directions = builder.getOrderByDirections();

      assert.deepStrictEqual(columns, ['created_at', 'id']);
      assert.deepStrictEqual(directions, ['desc', 'asc']);
    });
  });

  describe('hasUniqueColumn', () => {
    it('returns true for id', () => {
      const builder = new PgQueryBuilder(
        mockClient as any,
        'orders',
        compiler,
        new Set(['id', 'email']),
      );

      assert.strictEqual(builder.hasUniqueColumn('id'), true);
      assert.strictEqual(builder.hasUniqueColumn('email'), true);
      assert.strictEqual(builder.hasUniqueColumn('name'), false);
    });
  });

  describe('toHash', () => {
    it('produces consistent hash for same query', () => {
      const builder1 = new PgQueryBuilder(
        mockClient as any,
        'orders',
        compiler,
        new Set(['id']),
        undefined,
        { id: 'asc' },
      );
      const builder2 = new PgQueryBuilder(
        mockClient as any,
        'orders',
        compiler,
        new Set(['id']),
        undefined,
        { id: 'asc' },
      );

      assert.strictEqual(builder1.toHash(), builder2.toHash());
    });

    it('produces different hash for different orderBy', () => {
      const builder1 = new PgQueryBuilder(
        mockClient as any,
        'orders',
        compiler,
        new Set(['id']),
        undefined,
        { id: 'asc' },
      );
      const builder2 = new PgQueryBuilder(
        mockClient as any,
        'orders',
        compiler,
        new Set(['id']),
        undefined,
        { id: 'desc' },
      );

      assert.notStrictEqual(builder1.toHash(), builder2.toHash());
    });
  });

  describe('whereKeyset', () => {
    it('returns a new builder with keyset filter', async () => {
      const builder = new PgQueryBuilder(
        mockClient as any,
        'orders',
        compiler,
        new Set(['id']),
        undefined,
        { createdAt: 'asc', id: 'asc' },
      );

      const withKeyset = builder.whereKeyset(
        ['created_at', 'id'],
        { created_at: new Date('2024-01-01'), id: '5' },
        ['asc', 'asc'],
      );

      mockClient.setNextResult([]);
      await withKeyset.execute();

      const sql = mockClient.queries[0].sql;
      assert.ok(sql.includes('created_at >'), 'Should have first keyset condition');
      assert.ok(sql.includes('id >'), 'Should have second keyset condition');
    });
  });
});
