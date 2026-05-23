import assert from 'node:assert';
import { describe, it } from 'node:test';
import { CONDITION, AGGREGATION, type Condition, type Aggregation } from '../query.js';
import {
  evaluateCondition,
  sortEntities,
  computeAggregation,
  type EvaluatorContext,
} from './condition-evaluator.js';
import type { FieldDef } from '../field.js';
import { PERSISTENT } from '../symbols.js';
import type { Persistent } from '../types.js';

/** Helper to create condition objects with the required [CONDITION] symbol */
function cond<T extends Omit<Condition, typeof CONDITION>>(c: T): T & { [CONDITION]: true } {
  return { [CONDITION]: true, ...c } as T & { [CONDITION]: true };
}

/** Helper to create aggregation objects with the required [AGGREGATION] symbol */
function agg<T extends Omit<Aggregation, typeof AGGREGATION>>(a: T): T & { [AGGREGATION]: true } {
  return { [AGGREGATION]: true, ...a } as T & { [AGGREGATION]: true };
}

/** Helper to wrap test data with Persistent metadata */
function persistent<T extends object>(data: T): Persistent<T> {
  return {
    ...data,
    [PERSISTENT]: true,
  } as unknown as Persistent<T>;
}

// ============================================================================
// Test Data
// ============================================================================

const testEntity = {
  id: '1',
  name: 'John Doe',
  age: 30,
  email: 'john@example.com',
  score: '95.5', // decimal as string
  active: true,
  createdAt: new Date('2024-01-15'),
  tags: ['admin', 'user', 'premium'],
  address: {
    city: 'New York',
    zip: '10001',
  },
  role: null,
};

// ============================================================================
// Basic Conditions
// ============================================================================

describe('evaluateCondition', () => {
  describe('eq (equality)', () => {
    it('should match equal string values', () => {
      const c = cond({ type: 'eq', field: 'name', value: 'John Doe' });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should not match unequal string values', () => {
      const c = cond({ type: 'eq', field: 'name', value: 'Jane Doe' });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });

    it('should match equal number values', () => {
      const c = cond({ type: 'eq', field: 'age', value: 30 });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should match equal date values', () => {
      const c = cond({
        type: 'eq',
        field: 'createdAt',
        value: new Date('2024-01-15'),
      });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should not match different date values', () => {
      const c = cond({
        type: 'eq',
        field: 'createdAt',
        value: new Date('2024-01-16'),
      });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });

    it('should handle bigint comparison', () => {
      const entity = { id: '1', amount: BigInt(1000) };
      const c = cond({ type: 'eq', field: 'amount', value: BigInt(1000) });
      assert.strictEqual(evaluateCondition(entity, c), true);
    });

    it('should match nested field values', () => {
      const c = cond({ type: 'eq', field: 'address.city', value: 'New York' });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });
  });

  describe('neq (not equal)', () => {
    it('should return true for unequal values', () => {
      const c = cond({ type: 'neq', field: 'name', value: 'Jane Doe' });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should return false for equal values', () => {
      const c = cond({ type: 'neq', field: 'name', value: 'John Doe' });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });

    it('should handle date comparison', () => {
      const c = cond({
        type: 'neq',
        field: 'createdAt',
        value: new Date('2024-01-16'),
      });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });
  });

  describe('gt (greater than)', () => {
    it('should return true when value is greater', () => {
      const c = cond({ type: 'gt', field: 'age', value: 25 });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should return false when value is less', () => {
      const c = cond({ type: 'gt', field: 'age', value: 35 });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });

    it('should return false when values are equal', () => {
      const c = cond({ type: 'gt', field: 'age', value: 30 });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });

    it('should compare decimal strings numerically', () => {
      const c = cond({ type: 'gt', field: 'score', value: '90.0' });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });
  });

  describe('gte (greater than or equal)', () => {
    it('should return true when value is greater', () => {
      const c = cond({ type: 'gte', field: 'age', value: 25 });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should return true when values are equal', () => {
      const c = cond({ type: 'gte', field: 'age', value: 30 });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should return false when value is less', () => {
      const c = cond({ type: 'gte', field: 'age', value: 35 });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });
  });

  describe('lt (less than)', () => {
    it('should return true when value is less', () => {
      const c = cond({ type: 'lt', field: 'age', value: 35 });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should return false when value is greater', () => {
      const c = cond({ type: 'lt', field: 'age', value: 25 });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });
  });

  describe('lte (less than or equal)', () => {
    it('should return true when value is less', () => {
      const c = cond({ type: 'lte', field: 'age', value: 35 });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should return true when values are equal', () => {
      const c = cond({ type: 'lte', field: 'age', value: 30 });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });
  });

  describe('like', () => {
    it('should match with % wildcard at end', () => {
      const c = cond({ type: 'like', field: 'name', pattern: 'John%' });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should match with % wildcard at start', () => {
      const c = cond({ type: 'like', field: 'name', pattern: '%Doe' });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should match with % wildcard on both sides', () => {
      const c = cond({ type: 'like', field: 'name', pattern: '%hn D%' });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should match with _ single character wildcard', () => {
      const c = cond({ type: 'like', field: 'name', pattern: 'J_hn Doe' });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should not match case-sensitive', () => {
      const c = cond({ type: 'like', field: 'name', pattern: 'john%' });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });

    it('should return false for non-string values', () => {
      const c = cond({ type: 'like', field: 'age', pattern: '30%' });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });
  });

  describe('ilike (case-insensitive like)', () => {
    it('should match case-insensitively', () => {
      const c = cond({ type: 'ilike', field: 'name', pattern: 'JOHN%' });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should match mixed case patterns', () => {
      const c = cond({ type: 'ilike', field: 'name', pattern: '%dOE' });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });
  });

  describe('in', () => {
    it('should return true when value is in list', () => {
      const c = cond({ type: 'in', field: 'age', values: [25, 30, 35] });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should return false when value is not in list', () => {
      const c = cond({ type: 'in', field: 'age', values: [25, 35, 40] });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });

    it('should handle dates in list', () => {
      const c = cond({
        type: 'in',
        field: 'createdAt',
        values: [new Date('2024-01-15'), new Date('2024-01-16')],
      });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });
  });

  describe('notIn', () => {
    it('should return true when value is not in list', () => {
      const c = cond({ type: 'notIn', field: 'age', values: [25, 35, 40] });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should return false when value is in list', () => {
      const c = cond({ type: 'notIn', field: 'age', values: [25, 30, 35] });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });
  });

  describe('between', () => {
    it('should return true when value is in range', () => {
      const c = cond({ type: 'between', field: 'age', min: 25, max: 35 });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should return true at min boundary', () => {
      const c = cond({ type: 'between', field: 'age', min: 30, max: 35 });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should return true at max boundary', () => {
      const c = cond({ type: 'between', field: 'age', min: 25, max: 30 });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should return false when value is out of range', () => {
      const c = cond({ type: 'between', field: 'age', min: 35, max: 40 });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });
  });

  describe('isNull', () => {
    it('should return true for null values', () => {
      const c = cond({ type: 'isNull', field: 'role' });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should return false for non-null values', () => {
      const c = cond({ type: 'isNull', field: 'name' });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });

    it('should return true for undefined fields', () => {
      const c = cond({ type: 'isNull', field: 'nonexistent' });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });
  });

  describe('isNotNull', () => {
    it('should return false for null values', () => {
      const c = cond({ type: 'isNotNull', field: 'role' });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });

    it('should return true for non-null values', () => {
      const c = cond({ type: 'isNotNull', field: 'name' });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });
  });

  describe('startsWith', () => {
    it('should match prefix', () => {
      const c = cond({ type: 'startsWith', field: 'name', prefix: 'John' });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should not match non-prefix', () => {
      const c = cond({ type: 'startsWith', field: 'name', prefix: 'Doe' });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });

    it('should return false for non-string values', () => {
      const c = cond({ type: 'startsWith', field: 'age', prefix: '3' });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });
  });

  describe('endsWith', () => {
    it('should match suffix', () => {
      const c = cond({ type: 'endsWith', field: 'name', suffix: 'Doe' });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should not match non-suffix', () => {
      const c = cond({ type: 'endsWith', field: 'name', suffix: 'John' });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });
  });

  describe('contains', () => {
    it('should match substring in string', () => {
      const c = cond({ type: 'contains', field: 'name', substring: 'hn D' });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should match value in array', () => {
      const c = cond({ type: 'contains', field: 'tags', substring: 'admin' });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should return false when not found', () => {
      const c = cond({ type: 'contains', field: 'name', substring: 'xyz' });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });

    it('should return false for non-string/non-array values', () => {
      const c = cond({ type: 'contains', field: 'age', substring: '3' });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });
  });

  describe('before (dates)', () => {
    it('should return true when date is before', () => {
      const c = cond({
        type: 'before',
        field: 'createdAt',
        date: new Date('2024-02-01'),
      });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should return false when date is after', () => {
      const c = cond({
        type: 'before',
        field: 'createdAt',
        date: new Date('2024-01-01'),
      });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });

    it('should return false for non-date values', () => {
      const c = cond({
        type: 'before',
        field: 'name',
        date: new Date('2024-01-01'),
      });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });
  });

  describe('after (dates)', () => {
    it('should return true when date is after', () => {
      const c = cond({
        type: 'after',
        field: 'createdAt',
        date: new Date('2024-01-01'),
      });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should return false when date is before', () => {
      const c = cond({
        type: 'after',
        field: 'createdAt',
        date: new Date('2024-02-01'),
      });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });
  });

  describe('and', () => {
    it('should return true when all conditions match', () => {
      const c = cond({
        type: 'and',
        conditions: [
          cond({ type: 'eq', field: 'name', value: 'John Doe' }),
          cond({ type: 'eq', field: 'age', value: 30 }),
        ],
      });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should return false when any condition fails', () => {
      const c = cond({
        type: 'and',
        conditions: [
          cond({ type: 'eq', field: 'name', value: 'John Doe' }),
          cond({ type: 'eq', field: 'age', value: 25 }),
        ],
      });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });

    it('should return true for empty conditions', () => {
      const c = cond({ type: 'and', conditions: [] });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });
  });

  describe('or', () => {
    it('should return true when any condition matches', () => {
      const c = cond({
        type: 'or',
        conditions: [
          cond({ type: 'eq', field: 'name', value: 'Jane Doe' }),
          cond({ type: 'eq', field: 'age', value: 30 }),
        ],
      });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });

    it('should return false when no conditions match', () => {
      const c = cond({
        type: 'or',
        conditions: [
          cond({ type: 'eq', field: 'name', value: 'Jane Doe' }),
          cond({ type: 'eq', field: 'age', value: 25 }),
        ],
      });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });

    it('should return false for empty conditions', () => {
      const c = cond({ type: 'or', conditions: [] });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });
  });

  describe('not', () => {
    it('should negate true to false', () => {
      const c = cond({
        type: 'not',
        condition: cond({ type: 'eq', field: 'name', value: 'John Doe' }),
      });
      assert.strictEqual(evaluateCondition(testEntity, c), false);
    });

    it('should negate false to true', () => {
      const c = cond({
        type: 'not',
        condition: cond({ type: 'eq', field: 'name', value: 'Jane Doe' }),
      });
      assert.strictEqual(evaluateCondition(testEntity, c), true);
    });
  });

  describe('array operations', () => {
    describe('arrayContains', () => {
      it('should return true when array contains value', () => {
        const c = cond({ type: 'arrayContains', field: 'tags', value: 'admin' });
        assert.strictEqual(evaluateCondition(testEntity, c), true);
      });

      it('should return false when array does not contain value', () => {
        const c = cond({ type: 'arrayContains', field: 'tags', value: 'guest' });
        assert.strictEqual(evaluateCondition(testEntity, c), false);
      });

      it('should return false for non-array values', () => {
        const c = cond({ type: 'arrayContains', field: 'name', value: 'John' });
        assert.strictEqual(evaluateCondition(testEntity, c), false);
      });
    });

    describe('arrayHasAny', () => {
      it('should return true when array has any of values', () => {
        const c = cond({
          type: 'arrayHasAny',
          field: 'tags',
          values: ['admin', 'guest'],
        });
        assert.strictEqual(evaluateCondition(testEntity, c), true);
      });

      it('should return false when array has none of values', () => {
        const c = cond({
          type: 'arrayHasAny',
          field: 'tags',
          values: ['guest', 'visitor'],
        });
        assert.strictEqual(evaluateCondition(testEntity, c), false);
      });
    });

    describe('arrayHasAll', () => {
      it('should return true when array has all values', () => {
        const c = cond({
          type: 'arrayHasAll',
          field: 'tags',
          values: ['admin', 'user'],
        });
        assert.strictEqual(evaluateCondition(testEntity, c), true);
      });

      it('should return false when array is missing some values', () => {
        const c = cond({
          type: 'arrayHasAll',
          field: 'tags',
          values: ['admin', 'guest'],
        });
        assert.strictEqual(evaluateCondition(testEntity, c), false);
      });
    });

    describe('arrayOverlaps', () => {
      it('should return true when arrays overlap', () => {
        const c = cond({
          type: 'arrayOverlaps',
          field: 'tags',
          values: ['admin', 'guest'],
        });
        assert.strictEqual(evaluateCondition(testEntity, c), true);
      });

      it('should return false when arrays do not overlap', () => {
        const c = cond({
          type: 'arrayOverlaps',
          field: 'tags',
          values: ['guest', 'visitor'],
        });
        assert.strictEqual(evaluateCondition(testEntity, c), false);
      });
    });
  });

  describe('raw', () => {
    it('should throw error for raw SQL conditions', () => {
      const c = cond({ type: 'raw', sql: 'SELECT 1', values: [] });
      assert.throws(
        () => evaluateCondition(testEntity, c),
        /RAW SQL conditions are not supported in-memory/,
      );
    });
  });

  describe('has (relation conditions)', () => {
    it('should throw error without context', () => {
      const c = cond({
        type: 'has',
        field: 'author',
        condition: cond({ type: 'eq', field: 'name', value: 'Test' }),
      });
      assert.throws(
        () => evaluateCondition(testEntity, c),
        /HAS conditions require a relation resolver/,
      );
    });

    it('should throw error for unknown field', () => {
      const ctx: EvaluatorContext = {
        fieldDefs: {},
        resolveRef: () => undefined,
      };
      const c = cond({
        type: 'has',
        field: 'author',
        condition: cond({ type: 'eq', field: 'name', value: 'Test' }),
      });
      assert.throws(
        () => evaluateCondition(testEntity, c, ctx),
        /Unknown field "author"/,
      );
    });

    it('should throw error for non-ref field', () => {
      const ctx: EvaluatorContext = {
        fieldDefs: {
          author: { type: 'string' } as unknown as FieldDef,
        },
        resolveRef: () => undefined,
      };
      const c = cond({
        type: 'has',
        field: 'author',
        condition: cond({ type: 'eq', field: 'name', value: 'Test' }),
      });
      assert.throws(
        () => evaluateCondition(testEntity, c, ctx),
        /is not a ref\/refs field/,
      );
    });

    it('should evaluate ref field condition', () => {
      const author = { id: '2', name: 'Author Name' };
      const entity = { id: '1', authorId: '2' };
      const ctx: EvaluatorContext = {
        fieldDefs: {
          author: { type: 'ref', refTarget: 'Author' } as unknown as FieldDef,
        },
        resolveRef: (id) => (id === '2' ? author : undefined),
      };
      const c = cond({
        type: 'has',
        field: 'author',
        condition: cond({ type: 'eq', field: 'name', value: 'Author Name' }),
      });
      assert.strictEqual(evaluateCondition(entity, c, ctx), true);
    });

    it('should return false when ref is null', () => {
      const entity = { id: '1', authorId: null };
      const ctx: EvaluatorContext = {
        fieldDefs: {
          author: { type: 'ref', refTarget: 'Author' } as unknown as FieldDef,
        },
        resolveRef: () => undefined,
      };
      const c = cond({
        type: 'has',
        field: 'author',
        condition: cond({ type: 'eq', field: 'name', value: 'Test' }),
      });
      assert.strictEqual(evaluateCondition(entity, c, ctx), false);
    });

    it('should evaluate refs field condition (any match)', () => {
      const tags = [
        { id: 't1', name: 'Tag1' },
        { id: 't2', name: 'Tag2' },
      ];
      const entity = { id: '1', tagsIds: ['t1', 't2'] };
      const ctx: EvaluatorContext = {
        fieldDefs: {
          tags: { type: 'refs', refTarget: 'Tag' } as unknown as FieldDef,
        },
        resolveRef: (id) => tags.find((t) => t.id === id),
      };
      const c = cond({
        type: 'has',
        field: 'tags',
        condition: cond({ type: 'eq', field: 'name', value: 'Tag2' }),
      });
      assert.strictEqual(evaluateCondition(entity, c, ctx), true);
    });

    it('should return false for refs when no match', () => {
      const tags = [
        { id: 't1', name: 'Tag1' },
        { id: 't2', name: 'Tag2' },
      ];
      const entity = { id: '1', tagsIds: ['t1', 't2'] };
      const ctx: EvaluatorContext = {
        fieldDefs: {
          tags: { type: 'refs', refTarget: 'Tag' } as unknown as FieldDef,
        },
        resolveRef: (id) => tags.find((t) => t.id === id),
      };
      const c = cond({
        type: 'has',
        field: 'tags',
        condition: cond({ type: 'eq', field: 'name', value: 'Tag3' }),
      });
      assert.strictEqual(evaluateCondition(entity, c, ctx), false);
    });
  });

  describe('unknown condition type', () => {
    it('should throw error for unknown condition type', () => {
      const cond = { type: 'unknown', field: 'name' } as unknown as Condition;
      assert.throws(
        () => evaluateCondition(testEntity, cond),
        /Unknown condition type: unknown/,
      );
    });
  });
});

// ============================================================================
// Sorting
// ============================================================================

describe('sortEntities', () => {
  const entities = [
    persistent({ id: '1', name: 'Charlie', age: 30 }),
    persistent({ id: '2', name: 'Alice', age: 25 }),
    persistent({ id: '3', name: 'Bob', age: 35 }),
  ];

  it('should sort by single field ascending', () => {
    const result = sortEntities(entities, { name: 'asc' });
    assert.strictEqual(result[0].name, 'Alice');
    assert.strictEqual(result[1].name, 'Bob');
    assert.strictEqual(result[2].name, 'Charlie');
  });

  it('should sort by single field descending', () => {
    const result = sortEntities(entities, { name: 'desc' });
    assert.strictEqual(result[0].name, 'Charlie');
    assert.strictEqual(result[1].name, 'Bob');
    assert.strictEqual(result[2].name, 'Alice');
  });

  it('should sort by number field', () => {
    const result = sortEntities(entities, { age: 'asc' });
    assert.strictEqual(result[0].age, 25);
    assert.strictEqual(result[1].age, 30);
    assert.strictEqual(result[2].age, 35);
  });

  it('should sort by OrderByItem array', () => {
    const result = sortEntities(entities, [
      { __orderBy: true, field: 'name', direction: 'asc' } as const,
    ]);
    assert.strictEqual(result[0].name, 'Alice');
  });

  it('should handle null values with nulls first', () => {
    const entitiesWithNull = [
      persistent({ id: '1', name: 'Charlie' as string | null }),
      persistent({ id: '2', name: null as string | null }),
      persistent({ id: '3', name: 'Alice' as string | null }),
    ];
    const result = sortEntities(entitiesWithNull, [
      { __orderBy: true, field: 'name', direction: 'asc', nulls: 'first' } as const,
    ]);
    assert.strictEqual(result[0].name, null);
  });

  it('should handle null values with nulls last', () => {
    const entitiesWithNull = [
      persistent({ id: '1', name: 'Charlie' as string | null }),
      persistent({ id: '2', name: null as string | null }),
      persistent({ id: '3', name: 'Alice' as string | null }),
    ];
    const result = sortEntities(entitiesWithNull, [
      { __orderBy: true, field: 'name', direction: 'asc', nulls: 'last' } as const,
    ]);
    assert.strictEqual(result[result.length - 1].name, null);
  });

  it('should sort by multiple fields', () => {
    const entitiesWithDupes = [
      persistent({ id: '1', name: 'Bob', age: 30 }),
      persistent({ id: '2', name: 'Alice', age: 25 }),
      persistent({ id: '3', name: 'Bob', age: 25 }),
    ];
    const result = sortEntities(entitiesWithDupes, [
      { __orderBy: true, field: 'name', direction: 'asc' } as const,
      { __orderBy: true, field: 'age', direction: 'asc' } as const,
    ]);
    assert.strictEqual(result[0].name, 'Alice');
    assert.strictEqual(result[1].name, 'Bob');
    assert.strictEqual(result[1].age, 25);
    assert.strictEqual(result[2].name, 'Bob');
    assert.strictEqual(result[2].age, 30);
  });

  it('should return original order for empty orderBy', () => {
    const result = sortEntities(entities, []);
    assert.deepStrictEqual(result, entities);
  });

  it('should return original array reference for empty orderBy object', () => {
    const result = sortEntities(entities, {});
    assert.strictEqual(result, entities);
  });

  it('should sort dates correctly', () => {
    const entitiesWithDates = [
      persistent({ id: '1', created: new Date('2024-01-15') }),
      persistent({ id: '2', created: new Date('2024-01-10') }),
      persistent({ id: '3', created: new Date('2024-01-20') }),
    ];
    const result = sortEntities(entitiesWithDates, { created: 'asc' });
    assert.strictEqual(result[0].id, '2');
    assert.strictEqual(result[1].id, '1');
    assert.strictEqual(result[2].id, '3');
  });

  it('should sort decimal strings numerically', () => {
    const entitiesWithDecimals = [
      persistent({ id: '1', price: '10.50' }),
      persistent({ id: '2', price: '9.99' }),
      persistent({ id: '3', price: '100.00' }),
    ];
    const result = sortEntities(entitiesWithDecimals, { price: 'asc' });
    assert.strictEqual(result[0].id, '2'); // 9.99
    assert.strictEqual(result[1].id, '1'); // 10.50
    assert.strictEqual(result[2].id, '3'); // 100.00
  });
});

// ============================================================================
// Aggregation
// ============================================================================

describe('computeAggregation', () => {
  const entities = [
    persistent({ id: '1', amount: 100 as number | null, name: 'Alice' }),
    persistent({ id: '2', amount: 200 as number | null, name: 'Bob' }),
    persistent({ id: '3', amount: 150 as number | null, name: 'Alice' }),
    persistent({ id: '4', amount: null as number | null, name: 'Charlie' }),
  ];

  describe('count', () => {
    it('should count all entities', () => {
      const result = computeAggregation(entities, agg({ type: 'count' }));
      assert.strictEqual(result, 4);
    });

    it('should count non-null values of specific field', () => {
      const result = computeAggregation(entities, agg({
        type: 'count',
        field: 'amount',
      }));
      assert.strictEqual(result, 3);
    });

    it('should count distinct values', () => {
      const result = computeAggregation(entities, agg({
        type: 'count',
        field: 'name',
        distinct: true,
      }));
      assert.strictEqual(result, 3); // Alice, Bob, Charlie
    });
  });

  describe('sum', () => {
    it('should sum numeric values', () => {
      const result = computeAggregation(entities, agg({
        type: 'sum',
        field: 'amount',
      }));
      assert.strictEqual(result, 450);
    });

    it('should return 0 for empty array', () => {
      const result = computeAggregation([], agg({ type: 'sum', field: 'amount' }));
      assert.strictEqual(result, 0);
    });
  });

  describe('avg', () => {
    it('should calculate average', () => {
      const result = computeAggregation(entities, agg({
        type: 'avg',
        field: 'amount',
      }));
      assert.strictEqual(result, 150); // (100 + 200 + 150) / 3
    });

    it('should return null for empty array', () => {
      const result = computeAggregation([], agg({ type: 'avg', field: 'amount' }));
      assert.strictEqual(result, null);
    });
  });

  describe('min', () => {
    it('should find minimum value', () => {
      const result = computeAggregation(entities, agg({
        type: 'min',
        field: 'amount',
      }));
      assert.strictEqual(result, 100);
    });

    it('should return null for empty array', () => {
      const result = computeAggregation([], agg({ type: 'min', field: 'amount' }));
      assert.strictEqual(result, null);
    });
  });

  describe('max', () => {
    it('should find maximum value', () => {
      const result = computeAggregation(entities, agg({
        type: 'max',
        field: 'amount',
      }));
      assert.strictEqual(result, 200);
    });

    it('should return null for empty array', () => {
      const result = computeAggregation([], agg({ type: 'max', field: 'amount' }));
      assert.strictEqual(result, null);
    });
  });

  describe('unknown type', () => {
    it('should throw for unknown aggregation type', () => {
      assert.throws(
        () =>
          computeAggregation(entities, agg({
            type: 'unknown' as any,
            field: 'amount',
          })),
        /Unknown aggregation type/,
      );
    });
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('edge cases', () => {
  describe('compareValues', () => {
    it('should handle mixed number and string comparison', () => {
      const entity = { value: 10 };
      const c = cond({ type: 'gt', field: 'value', value: '5' });
      assert.strictEqual(evaluateCondition(entity, c), true);
    });

    it('should handle bigint comparison', () => {
      const entity = { value: BigInt(100) };
      const c = cond({ type: 'gt', field: 'value', value: BigInt(50) });
      assert.strictEqual(evaluateCondition(entity, c), true);
    });
  });

  describe('nested field access', () => {
    it('should handle deeply nested paths', () => {
      const entity = { a: { b: { c: { d: 'deep' } } } };
      const c = cond({ type: 'eq', field: 'a.b.c.d', value: 'deep' });
      assert.strictEqual(evaluateCondition(entity, c), true);
    });

    it('should return undefined for broken path', () => {
      const entity = { a: { b: null } };
      const c = cond({ type: 'eq', field: 'a.b.c', value: 'test' });
      assert.strictEqual(evaluateCondition(entity, c), false);
    });
  });

  describe('ref field resolution', () => {
    it('should resolve ref field names to storage names', () => {
      const entity = { cartId: '123' };
      const ctx: EvaluatorContext = {
        fieldDefs: {
          cart: { type: 'ref', refTarget: 'Cart' } as unknown as FieldDef,
        },
      };
      const c = cond({ type: 'eq', field: 'cart', value: '123' });
      assert.strictEqual(evaluateCondition(entity, c, ctx), true);
    });

    it('should resolve refs field names to storage names', () => {
      const entity = { itemsIds: ['1', '2', '3'] };
      const ctx: EvaluatorContext = {
        fieldDefs: {
          items: { type: 'refs', refTarget: 'Item' } as unknown as FieldDef,
        },
      };
      const c = cond({
        type: 'arrayContains',
        field: 'items',
        value: '2',
      });
      assert.strictEqual(evaluateCondition(entity, c, ctx), true);
    });
  });
});
