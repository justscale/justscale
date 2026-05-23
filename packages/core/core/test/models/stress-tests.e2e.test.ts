/**
 * Stress Tests for Query System
 *
 * Tests designed to find edge cases and potential bugs:
 * - Circular references
 * - Very deep nesting
 * - Empty/null edge cases
 * - Conflicting conditions
 * - Boundary conditions
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  defineModel,
  field,
  q,
  InMemoryRepository,
  getModelFields,
  type FieldDef,
} from '../../src/models/index.js';

// ============================================================================
// Models for Circular Reference Testing
// ============================================================================

// A -> B -> C -> A (circular) — use (): any => to break type cycle
 
class NodeA extends defineModel({
  name: field.string(),
  value: field.int().default(0),
  toB: field.ref((): any => NodeB).optional(),
}) {}

 
class NodeB extends defineModel({
  name: field.string(),
  value: field.int().default(0),
  toC: field.ref((): any => NodeC).optional(),
}) {}

 
class NodeC extends defineModel({
  name: field.string(),
  value: field.int().default(0),
  toA: field.ref((): any => NodeA).optional(),
}) {}

// Deeply nested object model
class DeepModel extends defineModel({
  name: field.string(),
  level1: field.object({
    level2: field.object({
      level3: field.object({
        level4: field.object({
          value: field.string(),
        }),
      }),
    }),
  }).optional(),
}) {}

// Model with many fields
class WideModel extends defineModel({
  name: field.string(),
  field1: field.string().optional(),
  field2: field.string().optional(),
  field3: field.string().optional(),
  field4: field.string().optional(),
  field5: field.string().optional(),
  field6: field.int().optional(),
  field7: field.int().optional(),
  field8: field.int().optional(),
  field9: field.boolean().optional(),
  field10: field.boolean().optional(),
  tags: field.array(field.string()).optional(),
}) {}

// Parent model for wide model ref
class ParentModel extends defineModel({
  name: field.string(),
  child: field.ref(WideModel),
}) {}

// ============================================================================
// Repository Setup
// ============================================================================

interface Repos {
  nodeA: InMemoryRepository<NodeA>
  nodeB: InMemoryRepository<NodeB>
  nodeC: InMemoryRepository<NodeC>
  deep: InMemoryRepository<DeepModel>
  wide: InMemoryRepository<WideModel>
  parent: InMemoryRepository<ParentModel>
}

function createRepos(): Repos {
  const wideRepo = new InMemoryRepository<WideModel>();

  const getFieldDefsForRef = (fieldDef: FieldDef): Record<string, FieldDef> | undefined => {
    const target = fieldDef.refTarget?.();
    if (target === NodeA) return getModelFields(NodeA);
    if (target === NodeB) return getModelFields(NodeB);
    if (target === NodeC) return getModelFields(NodeC);
    if (target === WideModel) return getModelFields(WideModel);
    return undefined;
  };

  const repos: Record<string, InMemoryRepository<any>> = {};

  const resolver = (refId: string, fieldDef: FieldDef) => {
    const target = fieldDef.refTarget?.();
    if (target === NodeA) return repos.nodeA?.['store'].get(refId) as Record<string, unknown> | undefined;
    if (target === NodeB) return repos.nodeB?.['store'].get(refId) as Record<string, unknown> | undefined;
    if (target === NodeC) return repos.nodeC?.['store'].get(refId) as Record<string, unknown> | undefined;
    if (target === WideModel) return wideRepo['store'].get(refId) as Record<string, unknown> | undefined;
    return undefined;
  };

  repos.nodeA = new InMemoryRepository<NodeA>({
    fieldDefs: getModelFields(NodeA),
    relationResolver: resolver,
    getFieldDefsForRef,
  });

  repos.nodeB = new InMemoryRepository<NodeB>({
    fieldDefs: getModelFields(NodeB),
    relationResolver: resolver,
    getFieldDefsForRef,
  });

  repos.nodeC = new InMemoryRepository<NodeC>({
    fieldDefs: getModelFields(NodeC),
    relationResolver: resolver,
    getFieldDefsForRef,
  });

  repos.parent = new InMemoryRepository<ParentModel>({
    fieldDefs: getModelFields(ParentModel),
    relationResolver: resolver,
    getFieldDefsForRef,
  });

  return {
    nodeA: repos.nodeA as InMemoryRepository<NodeA>,
    nodeB: repos.nodeB as InMemoryRepository<NodeB>,
    nodeC: repos.nodeC as InMemoryRepository<NodeC>,
    deep: new InMemoryRepository<DeepModel>(),
    wide: wideRepo,
    parent: repos.parent as InMemoryRepository<ParentModel>,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Stress Tests', () => {
  let repos: Repos;

  beforeEach(() => {
    repos = createRepos();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Circular Reference Chain
  // ─────────────────────────────────────────────────────────────────────────

  describe('Circular reference chain', () => {
    test('should handle A -> B -> C chain without hitting A again', async () => {
      const a1 = await repos.nodeA.insert({ name: 'A1', value: 1 } as any);
      const b1 = await repos.nodeB.insert({ name: 'B1', value: 2 } as any);
      const c1 = await repos.nodeC.insert({ name: 'C1', value: 3, toA: a1 } as any);

      // Update A to point to B, B to point to C
      const lockedA1 = await repos.nodeA.lock(a1);
      const lockedB1 = await repos.nodeB.lock(b1);
      await repos.nodeA.update(lockedA1!, { toB: b1 } as any);
      await repos.nodeB.update(lockedB1!, { toC: c1 } as any);

      // Query: Find A where B -> C -> value = 3
      const results = await repos.nodeA.find({
        where: NodeA.fields.toB.has(
          NodeB.fields.toC.has(
            NodeC.fields.value.eq(3)
          )
        ),
      });

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].name, 'A1');
    });

    test('should handle query that would create cycle if followed', async () => {
      // A1 -> B1 -> C1 -> A1 (cycle)
      const a1 = await repos.nodeA.insert({ name: 'A1', value: 10 } as any);
      const b1 = await repos.nodeB.insert({ name: 'B1', value: 20 } as any);
      const c1 = await repos.nodeC.insert({ name: 'C1', value: 30, toA: a1 } as any);

      const lockedA = await repos.nodeA.lock(a1);
      const lockedB = await repos.nodeB.lock(b1);
      await repos.nodeA.update(lockedA!, { toB: b1 } as any);
      await repos.nodeB.update(lockedB!, { toC: c1 } as any);

      // This should work - we're querying A -> B -> C, not following C -> A
      const results = await repos.nodeA.find({
        where: NodeA.fields.toB.has(
          NodeB.fields.toC.has(
            NodeC.fields.value.gt(25)
          )
        ),
      });

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].value, 10);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Deeply Nested Object Queries
  // ─────────────────────────────────────────────────────────────────────────

  describe('Deeply nested object queries', () => {
    test('should query 4 levels deep into nested object', async () => {
      await repos.deep.insert({
        name: 'Deep1',
        level1: {
          level2: {
            level3: {
              level4: {
                value: 'found',
              },
            },
          },
        },
      } as any);

      await repos.deep.insert({
        name: 'Deep2',
        level1: {
          level2: {
            level3: {
              level4: {
                value: 'other',
              },
            },
          },
        },
      } as any);

      await repos.deep.insert({
        name: 'Shallow',
        // No nested object
      } as any);

      const results = await repos.deep.find({
        where: DeepModel.fields.level1.level2.level3.level4.value.eq('found'),
      });

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].name, 'Deep1');
    });

    test('should handle missing intermediate levels gracefully', async () => {
      await repos.deep.insert({
        name: 'Partial',
        level1: {
          level2: {
            // level3 is missing
          },
        },
      } as any);

      await repos.deep.insert({
        name: 'Empty',
        // level1 is missing
      } as any);

      const results = await repos.deep.find({
        where: DeepModel.fields.level1.level2.level3.level4.value.eq('anything'),
      });

      assert.strictEqual(results.length, 0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Many Conditions Combined
  // ─────────────────────────────────────────────────────────────────────────

  describe('Many conditions combined', () => {
    test('should handle 10+ AND conditions', async () => {
      await repos.wide.insert({
        name: 'Match',
        field1: 'a',
        field2: 'b',
        field3: 'c',
        field4: 'd',
        field5: 'e',
        field6: 1,
        field7: 2,
        field8: 3,
        field9: true,
        field10: false,
      } as any);

      await repos.wide.insert({
        name: 'Almost',
        field1: 'a',
        field2: 'b',
        field3: 'c',
        field4: 'd',
        field5: 'e',
        field6: 1,
        field7: 2,
        field8: 3,
        field9: true,
        field10: true, // Different!
      } as any);

      const results = await repos.wide.find({
        where: q.and(
          WideModel.fields.field1.eq('a'),
          WideModel.fields.field2.eq('b'),
          WideModel.fields.field3.eq('c'),
          WideModel.fields.field4.eq('d'),
          WideModel.fields.field5.eq('e'),
          WideModel.fields.field6.eq(1),
          WideModel.fields.field7.eq(2),
          WideModel.fields.field8.eq(3),
          WideModel.fields.field9.eq(true),
          WideModel.fields.field10.eq(false),
        ),
      });

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].name, 'Match');
    });

    test('should handle deeply nested AND/OR tree', async () => {
      await repos.wide.insert({ name: 'A', field1: 'x', field6: 1 } as any);
      await repos.wide.insert({ name: 'B', field1: 'y', field6: 2 } as any);
      await repos.wide.insert({ name: 'C', field1: 'x', field6: 3 } as any);
      await repos.wide.insert({ name: 'D', field1: 'z', field6: 4 } as any);

      // ((field1 = 'x' AND field6 = 1) OR (field1 = 'y' AND field6 = 2)) OR (field1 = 'z')
      const results = await repos.wide.find({
        where: q.or(
          q.or(
            q.and(WideModel.fields.field1.eq('x'), WideModel.fields.field6.eq(1)),
            q.and(WideModel.fields.field1.eq('y'), WideModel.fields.field6.eq(2)),
          ),
          WideModel.fields.field1.eq('z'),
        ),
      });

      assert.strictEqual(results.length, 3);
      assert.ok(results.some(r => r.name === 'A'));
      assert.ok(results.some(r => r.name === 'B'));
      assert.ok(results.some(r => r.name === 'D'));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // has() with Many Fields
  // ─────────────────────────────────────────────────────────────────────────

  describe('has() with many field conditions', () => {
    test('should handle has() with multiple conditions on wide model', async () => {
      const child1 = await repos.wide.insert({
        name: 'Child1',
        field1: 'a',
        field2: 'b',
        field6: 100,
        field9: true,
        tags: ['tag1', 'tag2'],
      } as any);

      const child2 = await repos.wide.insert({
        name: 'Child2',
        field1: 'a',
        field2: 'c', // Different
        field6: 100,
        field9: true,
        tags: ['tag1', 'tag2'],
      } as any);

      await repos.parent.insert({ name: 'Parent1', child: child1 } as any);
      await repos.parent.insert({ name: 'Parent2', child: child2 } as any);

      const results = await repos.parent.find({
        where: ParentModel.fields.child.has(
          q.and(
            WideModel.fields.field1.eq('a'),
            WideModel.fields.field2.eq('b'),
            WideModel.fields.field6.gte(50),
            WideModel.fields.field9.eq(true),
            WideModel.fields.tags.contains('tag1'),
          )
        ),
      });

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].name, 'Parent1');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Edge Cases
  // ─────────────────────────────────────────────────────────────────────────

  describe('Edge cases', () => {
    test('should handle empty string in conditions', async () => {
      await repos.wide.insert({ name: 'Empty', field1: '' } as any);
      await repos.wide.insert({ name: 'NotEmpty', field1: 'value' } as any);

      const results = await repos.wide.find({
        where: WideModel.fields.field1.eq(''),
      });

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].name, 'Empty');
    });

    test('should handle zero in numeric conditions', async () => {
      await repos.wide.insert({ name: 'Zero', field6: 0 } as any);
      await repos.wide.insert({ name: 'Positive', field6: 1 } as any);
      await repos.wide.insert({ name: 'Null', field6: undefined } as any);

      const results = await repos.wide.find({
        where: WideModel.fields.field6.eq(0),
      });

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].name, 'Zero');
    });

    test('should handle false in boolean conditions', async () => {
      await repos.wide.insert({ name: 'False', field9: false } as any);
      await repos.wide.insert({ name: 'True', field9: true } as any);
      await repos.wide.insert({ name: 'Null', field9: undefined } as any);

      const results = await repos.wide.find({
        where: WideModel.fields.field9.eq(false),
      });

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].name, 'False');
    });

    test('should handle empty array in array conditions', async () => {
      await repos.wide.insert({ name: 'Empty', tags: [] } as any);
      await repos.wide.insert({ name: 'HasTags', tags: ['a', 'b'] } as any);

      // Empty array should not contain anything
      const results = await repos.wide.find({
        where: WideModel.fields.tags.contains('a'),
      });

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].name, 'HasTags');
    });

    test('should handle special characters in string conditions', async () => {
      await repos.wide.insert({ name: "Has 'quotes'", field1: "it's" } as any);
      await repos.wide.insert({ name: 'Has "double"', field1: 'say "hello"' } as any);
      await repos.wide.insert({ name: 'Has backslash', field1: 'path\\to\\file' } as any);
      await repos.wide.insert({ name: 'Has percent', field1: '50%' } as any);

      const quote = await repos.wide.find({ where: WideModel.fields.field1.eq("it's") });
      assert.strictEqual(quote.length, 1);

      const double = await repos.wide.find({ where: WideModel.fields.field1.eq('say "hello"') });
      assert.strictEqual(double.length, 1);

      const backslash = await repos.wide.find({ where: WideModel.fields.field1.eq('path\\to\\file') });
      assert.strictEqual(backslash.length, 1);

      const percent = await repos.wide.find({ where: WideModel.fields.field1.contains('%') });
      assert.strictEqual(percent.length, 1);
    });

    test('should handle very long strings', async () => {
      const longString = 'a'.repeat(10000);
      await repos.wide.insert({ name: 'Long', field1: longString } as any);

      const results = await repos.wide.find({
        where: WideModel.fields.field1.eq(longString),
      });

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].name, 'Long');
    });

    test('should handle negative numbers', async () => {
      await repos.wide.insert({ name: 'Negative', field6: -100 } as any);
      await repos.wide.insert({ name: 'Positive', field6: 100 } as any);

      const results = await repos.wide.find({
        where: WideModel.fields.field6.lt(0),
      });

      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].name, 'Negative');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Conflicting Conditions
  // ─────────────────────────────────────────────────────────────────────────

  describe('Conflicting conditions', () => {
    test('should return empty for impossible AND conditions', async () => {
      await repos.wide.insert({ name: 'Test', field6: 50 } as any);

      const results = await repos.wide.find({
        where: q.and(
          WideModel.fields.field6.gt(100),
          WideModel.fields.field6.lt(0),
        ),
      });

      assert.strictEqual(results.length, 0);
    });

    test('should return all for tautological OR conditions', async () => {
      await repos.wide.insert({ name: 'Test1', field6: 50 } as any);
      await repos.wide.insert({ name: 'Test2', field6: 150 } as any);

      const results = await repos.wide.find({
        where: q.or(
          WideModel.fields.field6.lte(100),
          WideModel.fields.field6.gt(100),
        ),
      });

      assert.strictEqual(results.length, 2);
    });
  });
});
