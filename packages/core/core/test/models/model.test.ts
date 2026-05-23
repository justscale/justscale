import assert from 'node:assert';
import { describe, it } from 'node:test';
import { createModelInstance } from '../../src/models/model.js';
import {
  createObservable,
  getModelInternals,
  getObservableInternals,
} from '../../src/models/index.js';
import { z } from 'zod';
import { assertExactPaths } from './helpers.js';

describe('createModel', () => {
  describe('basic functionality', () => {
    it('should create a model with defaults from schema', () => {
      const schema = z.object({
        count: z.number().default(0),
        name: z.string().default('test'),
      });

      const model = createModelInstance(schema, {});

      assert.strictEqual(model.count, 0);
      assert.strictEqual(model.name, 'test');
    });

    it('should override defaults with provided values', () => {
      const schema = z.object({
        count: z.number().default(0),
      });

      const model = createModelInstance(schema, { count: 42 });

      assert.strictEqual(model.count, 42);
    });

    it('should start with no dirty paths', () => {
      const schema = z.object({ count: z.number().default(0) });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      assert.strictEqual(internals.isDirty(), false);
      assert.deepStrictEqual(internals.getDirtyPaths(), []);
    });
  });

  describe('dirty tracking - primitives', () => {
    it('should mark path dirty when primitive is changed', () => {
      const schema = z.object({ count: z.number().default(0) });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      model.count = 5;

      assert.strictEqual(internals.isDirty(), true);
      assertExactPaths(internals.getDirtyPaths(), ['count']);
    });

    it('should not mark dirty when same value is assigned', () => {
      const schema = z.object({ count: z.number().default(0) });
      const model = createModelInstance(schema, { count: 5 });
      const internals = getModelInternals(model);

      model.count = 5; // Same value

      assert.strictEqual(internals.isDirty(), false);
      assertExactPaths(internals.getDirtyPaths(), []);
    });

    it('should track multiple dirty paths', () => {
      const schema = z.object({
        a: z.number().default(0),
        b: z.string().default(''),
      });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      model.a = 1;
      model.b = 'changed';

      assertExactPaths(internals.getDirtyPaths(), ['a', 'b']);
    });
  });

  describe('dirty tracking - nested objects', () => {
    it('should track nested property changes with parent paths', () => {
      const schema = z.object({
        user: z
          .object({
            name: z.string().default(''),
            age: z.number().default(0),
          })
          .default(() => ({ name: '', age: 0 })),
      });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      model.user.name = 'Alice';

      assert.strictEqual(internals.isDirty(), true);
      assertExactPaths(internals.getDirtyPaths(), ['user.name', 'user']);
    });

    it('should track deeply nested changes with all parent paths', () => {
      const schema = z.object({
        a: z.object({
          b: z.object({
            c: z.number().default(0),
          }),
        }),
      });
      const model = createModelInstance(schema, { a: { b: { c: 0 } } });
      const internals = getModelInternals(model);

      model.a.b.c = 99;

      assert.strictEqual(internals.isDirty(), true);
      assertExactPaths(internals.getDirtyPaths(), ['a.b.c', 'a.b', 'a']);
    });

    it('should handle replacing entire nested object', () => {
      const schema = z.object({
        user: z
          .object({
            name: z.string().default(''),
          })
          .default(() => ({ name: '' })),
      });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      model.user = { name: 'Bob' };

      assertExactPaths(internals.getDirtyPaths(), ['user']);

      // After replacement, the new object should also be tracked
      internals.markClean();
      model.user.name = 'Charlie';
      assertExactPaths(internals.getDirtyPaths(), ['user.name', 'user']);
    });
  });

  describe('dirty tracking - arrays', () => {
    it('should track array element changes with exact paths', () => {
      const schema = z.object({
        items: z.array(z.number()).default([1, 2, 3]),
      });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      model.items[0] = 100;

      assert.strictEqual(internals.isDirty(), true);
      assertExactPaths(internals.getDirtyPaths(), ['items.0', 'items']);
    });

    it('should track array push with index path', () => {
      const schema = z.object({
        items: z.array(z.number()).default([]),
      });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      model.items.push(42);

      assert.strictEqual(internals.isDirty(), true);
      assertExactPaths(internals.getDirtyPaths(), ['items.0', 'items']);
    });

    it('should track array of objects with nested paths', () => {
      const schema = z.object({
        users: z
          .array(
            z.object({
              name: z.string(),
            }),
          )
          .default([{ name: 'Alice' }]),
      });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      model.users[0].name = 'Bob';

      assert.strictEqual(internals.isDirty(), true);
      assertExactPaths(internals.getDirtyPaths(), ['users.0.name', 'users.0', 'users']);
    });

    it('should track array pop with removed index and length', () => {
      const schema = z.object({
        items: z.array(z.number()).default([1, 2, 3]),
      });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      const popped = model.items.pop();

      assert.strictEqual(popped, 3);
      assert.strictEqual(model.items.length, 2);
      assertExactPaths(internals.getDirtyPaths(), ['items.2', 'items.length', 'items']);
    });

    it('should track array shift with all shifted indices', () => {
      const schema = z.object({
        items: z.array(z.number()).default([1, 2, 3]),
      });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      const shifted = model.items.shift();

      assert.strictEqual(shifted, 1);
      assert.strictEqual(model.items.length, 2);
      // shift moves all elements and changes length
      assertExactPaths(internals.getDirtyPaths(), [
        'items.0',
        'items.1',
        'items.2',
        'items.length',
        'items',
      ]);
    });

    it('should track array unshift with all shifted indices', () => {
      const schema = z.object({
        items: z.array(z.number()).default([1, 2]),
      });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      model.items.unshift(0);

      assert.strictEqual(model.items[0], 0);
      assert.strictEqual(model.items.length, 3);
      // unshift shifts existing elements and adds new one
      assertExactPaths(internals.getDirtyPaths(), ['items.0', 'items.1', 'items.2', 'items']);
    });

    it('should track array splice with affected indices', () => {
      const schema = z.object({
        items: z.array(z.number()).default([1, 2, 3, 4, 5]),
      });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      const removed = model.items.splice(1, 2, 10, 20, 30);

      assert.deepStrictEqual(removed, [2, 3]);
      assert.deepStrictEqual([...model.items], [1, 10, 20, 30, 4, 5]);
      // splice modifies indices 1-5 and length
      assertExactPaths(internals.getDirtyPaths(), [
        'items.1',
        'items.2',
        'items.3',
        'items.4',
        'items.5',
        'items',
      ]);
    });

    it('should track array sort with swapped indices', () => {
      const schema = z.object({
        items: z.array(z.number()).default([3, 1, 2]),
      });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      model.items.sort();

      assert.deepStrictEqual([...model.items], [1, 2, 3]);
      // sort modifies all indices that changed
      assertExactPaths(internals.getDirtyPaths(), ['items.0', 'items.1', 'items.2', 'items']);
    });

    it('should track array reverse with swapped indices', () => {
      const schema = z.object({
        items: z.array(z.number()).default([1, 2, 3]),
      });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      model.items.reverse();

      assert.deepStrictEqual([...model.items], [3, 2, 1]);
      // reverse swaps indices 0 and 2 (1 stays same)
      assertExactPaths(internals.getDirtyPaths(), ['items.0', 'items.2', 'items']);
    });

    it('should track pushing objects and subsequent mutation', () => {
      const schema = z.object({
        users: z
          .array(
            z.object({
              name: z.string(),
            }),
          )
          .default([]),
      });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      model.users.push({ name: 'Alice' });
      assertExactPaths(internals.getDirtyPaths(), ['users.0', 'users']);

      internals.markClean();

      // Mutate the pushed object
      model.users[0].name = 'Bob';
      assertExactPaths(internals.getDirtyPaths(), ['users.0.name', 'users.0', 'users']);
      assert.strictEqual(model.users[0].name, 'Bob');
    });

    it('should track multiple pushes with correct indices', () => {
      const schema = z.object({
        items: z.array(z.number()).default([]),
      });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      model.items.push(1);
      assertExactPaths(internals.getDirtyPaths(), ['items.0', 'items']);

      internals.markClean();
      model.items.push(2);
      assertExactPaths(internals.getDirtyPaths(), ['items.1', 'items']);

      internals.markClean();
      model.items.push(3, 4); // Multiple at once
      assertExactPaths(internals.getDirtyPaths(), ['items.2', 'items.3', 'items']);
    });

    it('should handle nested arrays with full path', () => {
      const schema = z.object({
        matrix: z.array(z.array(z.number())).default([
          [1, 2],
          [3, 4],
        ]),
      });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      model.matrix[0][1] = 99;

      assert.strictEqual(model.matrix[0][1], 99);
      assertExactPaths(internals.getDirtyPaths(), ['matrix.0.1', 'matrix.0', 'matrix']);
    });

    it('should handle array fill with all indices', () => {
      const schema = z.object({
        items: z.array(z.number()).default([1, 2, 3]),
      });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      model.items.fill(0);

      assert.deepStrictEqual([...model.items], [0, 0, 0]);
      assertExactPaths(internals.getDirtyPaths(), ['items.0', 'items.1', 'items.2', 'items']);
    });
  });

  describe('markClean', () => {
    it('should clear dirty state', () => {
      const schema = z.object({ count: z.number().default(0) });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      model.count = 5;
      assert.strictEqual(internals.isDirty(), true);

      internals.markClean();
      assert.strictEqual(internals.isDirty(), false);
      assert.deepStrictEqual(internals.getDirtyPaths(), []);
    });
  });

  describe('getDirtyData', () => {
    it('should return only changed top-level keys', () => {
      const schema = z.object({
        a: z.number().default(0),
        b: z.number().default(0),
        c: z.number().default(0),
      });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      model.a = 1;
      model.c = 3;

      const dirty = internals.getDirtyData();
      assert.strictEqual(dirty.a, 1);
      assert.strictEqual(dirty.c, 3);
      assert.strictEqual('b' in dirty, false);
    });

    it('should include entire nested object when child changes', () => {
      const schema = z.object({
        user: z
          .object({
            name: z.string().default(''),
            age: z.number().default(0),
          })
          .default(() => ({ name: '', age: 0 })),
      });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      model.user.name = 'Alice';

      const dirty = internals.getDirtyData();
      assert.ok('user' in dirty);
    });
  });

  describe('proxy stability', () => {
    it('should return same proxy for repeated access', () => {
      const schema = z.object({
        user: z
          .object({
            name: z.string().default(''),
          })
          .default(() => ({ name: '' })),
      });
      const model = createModelInstance(schema, {});

      const user1 = model.user;
      const user2 = model.user;

      // Should be the same proxy, not a new one each time
      assert.strictEqual(user1, user2);
    });

    it('should not create infinite proxy nesting on read', () => {
      const schema = z.object({
        deep: z.object({
          nested: z.object({
            value: z.number().default(0),
          }),
        }),
      });
      // Provide full structure
      const model = createModelInstance(schema, { deep: { nested: { value: 0 } } });

      // Access the same path many times - should not stack overflow
      for (let i = 0; i < 1000; i++) {
        const _ = model.deep.nested.value;
      }

      // If we get here without stack overflow, test passes
      assert.ok(true);
    });
  });

  describe('circular references', () => {
    it('should handle circular references without infinite loop', () => {
      const schema = z.object({
        self: z.any().optional(),
        value: z.number().default(0),
      });

      // Create circular structure
      const circular: Record<string, unknown> = { value: 42 };
      circular.self = circular;

      // This should not throw or infinite loop
      const model = createModelInstance(schema, circular);

      assert.strictEqual(model.value, 42);
      // Self-reference should work
      assert.strictEqual((model.self as typeof model).value, 42);
    });
  });

  describe('shared references', () => {
    it('should handle same object referenced multiple times with exact paths', () => {
      const schema = z.object({
        a: z.any(),
        b: z.any(),
      });

      const shared = { value: 1 };
      const model = createModelInstance(schema, { a: shared, b: shared });
      const internals = getModelInternals(model);

      // Modify through one reference
      (model.a as { value: number }).value = 99;

      // Both should see the change (same underlying object)
      assert.strictEqual((model.a as { value: number }).value, 99);
      assert.strictEqual((model.b as { value: number }).value, 99);

      // Both paths should be dirty since they reference the same object
      assertExactPaths(internals.getDirtyPaths(), ['a.value', 'a', 'b.value', 'b']);
    });

    it('should handle deeply nested shared references with exact paths', () => {
      const schema = z.object({
        foo: z.object({
          bar: z.any(),
        }),
        baz: z.object({
          qux: z.any(),
        }),
      });

      const shared = { deep: { value: 1 } };
      const model = createModelInstance(schema, {
        foo: { bar: shared },
        baz: { qux: shared },
      });
      const internals = getModelInternals(model);

      // Modify through one deep path
      (model.foo.bar as { deep: { value: number } }).deep.value = 42;

      // Both paths should be dirty with full parent chain
      assertExactPaths(internals.getDirtyPaths(), [
        'foo.bar.deep.value',
        'foo.bar.deep',
        'foo.bar',
        'foo',
        'baz.qux.deep.value',
        'baz.qux.deep',
        'baz.qux',
        'baz',
      ]);
    });

    it('should handle shared object across different models with exact paths per model', () => {
      const schemaA = z.object({
        user: z.object({
          profile: z.any(),
        }),
      });

      const schemaB = z.object({
        settings: z.object({
          data: z.any(),
        }),
        count: z.number().default(0),
      });

      // Same object referenced in two different models
      const shared = { name: 'Alice', score: 100 };

      const modelA = createModelInstance(schemaA, { user: { profile: shared } });
      const modelB = createModelInstance(schemaB, { settings: { data: shared }, count: 5 });

      const internalsA = getModelInternals(modelA);
      const internalsB = getModelInternals(modelB);

      // Modify through modelA
      (modelA.user.profile as { name: string }).name = 'Bob';

      // ModelA should have its own paths
      assertExactPaths(internalsA.getDirtyPaths(), ['user.profile.name', 'user.profile', 'user']);

      // ModelB should have its own paths (not modelA's paths!)
      assertExactPaths(internalsB.getDirtyPaths(), [
        'settings.data.name',
        'settings.data',
        'settings',
      ]);

      // Both should see the value change
      assert.strictEqual((modelA.user.profile as { name: string }).name, 'Bob');
      assert.strictEqual((modelB.settings.data as { name: string }).name, 'Bob');
    });

    it('should track dirty independently with separate dirty sets and exact paths', () => {
      const schema = z.object({
        data: z.any(),
      });

      const shared = { value: 1 };

      const model1 = createModelInstance(schema, { data: shared });
      const model2 = createModelInstance(schema, { data: shared });

      const internals1 = getModelInternals(model1);
      const internals2 = getModelInternals(model2);

      // Modify through model1
      (model1.data as { value: number }).value = 99;

      // Both models see the change
      assert.strictEqual((model1.data as { value: number }).value, 99);
      assert.strictEqual((model2.data as { value: number }).value, 99);

      // Both should be dirty with same paths (same schema)
      assertExactPaths(internals1.getDirtyPaths(), ['data.value', 'data']);
      assertExactPaths(internals2.getDirtyPaths(), ['data.value', 'data']);

      // Clean model1
      internals1.markClean();
      assertExactPaths(internals1.getDirtyPaths(), []);

      // Model2 should still be dirty (separate dirty set)
      assertExactPaths(internals2.getDirtyPaths(), ['data.value', 'data']);
    });
  });

  describe('complex multi-parent scenarios', () => {
    it('should handle diamond pattern - shared object via multiple converging paths', () => {
      // Diamond: root -> left -> shared, root -> right -> shared
      const shared = { value: 1 };
      const schema = z.object({
        left: z.object({ child: z.any() }),
        right: z.object({ child: z.any() }),
      });

      const model = createModelInstance(schema, {
        left: { child: shared },
        right: { child: shared },
      });
      const internals = getModelInternals(model);

      (model.left.child as { value: number }).value = 99;

      // Both paths should be dirty
      assertExactPaths(internals.getDirtyPaths(), [
        'left.child.value',
        'left.child',
        'left',
        'right.child.value',
        'right.child',
        'right',
      ]);
    });

    it('should handle triple reference - same object in 3 places', () => {
      const shared = { x: 1 };
      const schema = z.object({
        a: z.any(),
        b: z.any(),
        c: z.any(),
      });

      const model = createModelInstance(schema, { a: shared, b: shared, c: shared });
      const internals = getModelInternals(model);

      (model.b as { x: number }).x = 42;

      assertExactPaths(internals.getDirtyPaths(), ['a.x', 'a', 'b.x', 'b', 'c.x', 'c']);
    });

    it('should handle deeply nested diamond - 5 levels deep', () => {
      const shared = { deep: { value: 1 } };
      const schema = z.object({
        path1: z.object({
          level2: z.object({
            level3: z.object({
              level4: z.object({
                target: z.any(),
              }),
            }),
          }),
        }),
        path2: z.object({
          alt2: z.object({
            alt3: z.object({
              alt4: z.object({
                target: z.any(),
              }),
            }),
          }),
        }),
      });

      const model = createModelInstance(schema, {
        path1: { level2: { level3: { level4: { target: shared } } } },
        path2: { alt2: { alt3: { alt4: { target: shared } } } },
      });
      const internals = getModelInternals(model);

      // Modify through path1
      (model.path1.level2.level3.level4.target as { deep: { value: number } }).deep.value = 999;

      assertExactPaths(internals.getDirtyPaths(), [
        // path1 chain
        'path1.level2.level3.level4.target.deep.value',
        'path1.level2.level3.level4.target.deep',
        'path1.level2.level3.level4.target',
        'path1.level2.level3.level4',
        'path1.level2.level3',
        'path1.level2',
        'path1',
        // path2 chain
        'path2.alt2.alt3.alt4.target.deep.value',
        'path2.alt2.alt3.alt4.target.deep',
        'path2.alt2.alt3.alt4.target',
        'path2.alt2.alt3.alt4',
        'path2.alt2.alt3',
        'path2.alt2',
        'path2',
      ]);
    });

    it('should handle shared array in multiple locations', () => {
      const sharedArray = createObservable([1, 2, 3]);
      const schema = z.object({
        list1: z.any(),
        list2: z.any(),
      });

      const model = createModelInstance(schema, { list1: sharedArray, list2: sharedArray });
      const internals = getModelInternals(model);

      (model.list1 as number[]).push(4);

      // Both list paths should show the new index
      assertExactPaths(internals.getDirtyPaths(), ['list1.3', 'list1', 'list2.3', 'list2']);
    });

    it('should handle nested shared objects - shared within shared', () => {
      const innerShared = { innerValue: 1 };
      const outerShared = { inner: innerShared, outerValue: 2 };

      const schema = z.object({
        x: z.any(),
        y: z.any(),
      });

      const model = createModelInstance(schema, { x: outerShared, y: outerShared });
      const internals = getModelInternals(model);

      // Modify inner shared through x
      (model.x as { inner: { innerValue: number } }).inner.innerValue = 99;

      assertExactPaths(internals.getDirtyPaths(), [
        'x.inner.innerValue',
        'x.inner',
        'x',
        'y.inner.innerValue',
        'y.inner',
        'y',
      ]);
    });

    it('should handle 3 models sharing deeply nested observable', () => {
      const sharedObs = createObservable({
        level1: {
          level2: {
            level3: { value: 1 },
          },
        },
      });
      const sharedInternals = getObservableInternals(sharedObs);

      const schema1 = z.object({ a: z.object({ data: z.any() }) });
      const schema2 = z.object({ b: z.object({ info: z.any() }) });
      const schema3 = z.object({ c: z.object({ ref: z.any() }) });

      const model1 = createModelInstance(schema1, { a: { data: sharedObs } });
      const model2 = createModelInstance(schema2, { b: { info: sharedObs } });
      const model3 = createModelInstance(schema3, { c: { ref: sharedObs } });

      const internals1 = getModelInternals(model1);
      const internals2 = getModelInternals(model2);
      const internals3 = getModelInternals(model3);

      // Modify through model2's path
      (
        model2.b.info as { level1: { level2: { level3: { value: number } } } }
      ).level1.level2.level3.value = 42;

      // All should see their respective paths dirty
      assertExactPaths(sharedInternals.getDirtyPaths(), [
        'level1.level2.level3.value',
        'level1.level2.level3',
        'level1.level2',
        'level1',
      ]);

      assertExactPaths(internals1.getDirtyPaths(), [
        'a.data.level1.level2.level3.value',
        'a.data.level1.level2.level3',
        'a.data.level1.level2',
        'a.data.level1',
        'a.data',
        'a',
      ]);

      assertExactPaths(internals2.getDirtyPaths(), [
        'b.info.level1.level2.level3.value',
        'b.info.level1.level2.level3',
        'b.info.level1.level2',
        'b.info.level1',
        'b.info',
        'b',
      ]);

      assertExactPaths(internals3.getDirtyPaths(), [
        'c.ref.level1.level2.level3.value',
        'c.ref.level1.level2.level3',
        'c.ref.level1.level2',
        'c.ref.level1',
        'c.ref',
        'c',
      ]);
    });

    it('should handle array of shared objects with modifications', () => {
      const shared1 = { id: 1 };
      const shared2 = { id: 2 };

      const schema = z.object({
        items: z.array(z.any()),
        first: z.any(),
        second: z.any(),
      });

      const model = createModelInstance(schema, {
        items: [shared1, shared2],
        first: shared1,
        second: shared2,
      });
      const internals = getModelInternals(model);

      // Modify shared1 through items array
      (model.items[0] as { id: number }).id = 100;

      // items.0 and first should both be dirty
      assertExactPaths(internals.getDirtyPaths(), [
        'items.0.id',
        'items.0',
        'items',
        'first.id',
        'first',
      ]);

      internals.markClean();

      // Modify shared2 through the direct reference
      (model.second as { id: number }).id = 200;

      // items.1 and second should both be dirty
      assertExactPaths(internals.getDirtyPaths(), [
        'items.1.id',
        'items.1',
        'items',
        'second.id',
        'second',
      ]);
    });

    it('should handle modification at multiple depths sequentially', () => {
      const shared = {
        level1: {
          level2: {
            level3: { value: 1 },
          },
        },
      };

      const schema = z.object({
        a: z.any(),
        b: z.any(),
      });

      const model = createModelInstance(schema, { a: shared, b: shared });
      const internals = getModelInternals(model);

      // Modify at deepest level
      (model.a as typeof shared).level1.level2.level3.value = 10;
      assertExactPaths(internals.getDirtyPaths(), [
        'a.level1.level2.level3.value',
        'a.level1.level2.level3',
        'a.level1.level2',
        'a.level1',
        'a',
        'b.level1.level2.level3.value',
        'b.level1.level2.level3',
        'b.level1.level2',
        'b.level1',
        'b',
      ]);

      internals.markClean();

      // Modify at middle level (replace level3)
      (model.b as typeof shared).level1.level2.level3 = { value: 20 };
      assertExactPaths(internals.getDirtyPaths(), [
        'a.level1.level2.level3',
        'a.level1.level2',
        'a.level1',
        'a',
        'b.level1.level2.level3',
        'b.level1.level2',
        'b.level1',
        'b',
      ]);

      internals.markClean();

      // Modify at top level (replace level1)
      (model.a as typeof shared).level1 = { level2: { level3: { value: 30 } } };
      assertExactPaths(internals.getDirtyPaths(), ['a.level1', 'a', 'b.level1', 'b']);
    });

    it('should handle star pattern - one object referenced from many siblings', () => {
      const center = { core: 1 };
      const schema = z.object({
        n: z.any(),
        s: z.any(),
        e: z.any(),
        w: z.any(),
        ne: z.any(),
        nw: z.any(),
        se: z.any(),
        sw: z.any(),
      });

      const model = createModelInstance(schema, {
        n: center,
        s: center,
        e: center,
        w: center,
        ne: center,
        nw: center,
        se: center,
        sw: center,
      });
      const internals = getModelInternals(model);

      (model.n as { core: number }).core = 999;

      assertExactPaths(internals.getDirtyPaths(), [
        'n.core',
        'n',
        's.core',
        's',
        'e.core',
        'e',
        'w.core',
        'w',
        'ne.core',
        'ne',
        'nw.core',
        'nw',
        'se.core',
        'se',
        'sw.core',
        'sw',
      ]);
    });

    it('should handle mixed depth references - same object at different depths', () => {
      const shared = { val: 1 };
      const schema = z.object({
        shallow: z.any(),
        deep: z.object({
          nested: z.object({
            deeper: z.any(),
          }),
        }),
      });

      const model = createModelInstance(schema, {
        shallow: shared,
        deep: { nested: { deeper: shared } },
      });
      const internals = getModelInternals(model);

      (model.shallow as { val: number }).val = 42;

      assertExactPaths(internals.getDirtyPaths(), [
        'shallow.val',
        'shallow',
        'deep.nested.deeper.val',
        'deep.nested.deeper',
        'deep.nested',
        'deep',
      ]);
    });
  });
});
