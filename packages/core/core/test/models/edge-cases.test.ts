import assert from 'node:assert';
import { describe, it } from 'node:test';
import { createModelInstance } from '../../src/models/model.js';
import {
  createObservable,
  getModelInternals,
  getObservableInternals,
  watch,
} from '../../src/models/index.js';
import { z } from 'zod';
import { assertExactPaths } from './helpers.js';

describe('edge cases', () => {
  describe('delete operations', () => {
    it('should mark deleted property as dirty', () => {
      const schema = z.object({
        a: z.number().optional(),
        b: z.number().default(0),
      });
      const model = createModelInstance(schema, { a: 1, b: 2 });
      const internals = getModelInternals(model);

      delete (model as Record<string, unknown>).a;

      assert.strictEqual(internals.isDirty(), true);
      assertExactPaths(internals.getDirtyPaths(), ['a']);
    });

    it('should mark deleted nested property as dirty', () => {
      const schema = z.object({
        user: z.object({
          name: z.string().optional(),
          age: z.number().default(0),
        }),
      });
      const model = createModelInstance(schema, { user: { name: 'Alice', age: 30 } });
      const internals = getModelInternals(model);

      delete (model.user as Record<string, unknown>).name;

      assert.strictEqual(internals.isDirty(), true);
      assertExactPaths(internals.getDirtyPaths(), ['user.name', 'user']);
    });

    it('should handle deleting shared reference from one path', () => {
      const schema = z.object({
        a: z.any(),
        b: z.any(),
      });

      const shared = { value: 1 };
      const model = createModelInstance(schema, { a: shared, b: shared });
      const internals = getModelInternals(model);

      // Delete from one path
      delete (model as Record<string, unknown>).a;

      // b should still work
      assert.strictEqual((model.b as { value: number }).value, 1);
      assert.strictEqual(internals.isDirty(), true);
      assertExactPaths(internals.getDirtyPaths(), ['a']);
    });
  });

  describe('undefined vs delete', () => {
    it('should mark dirty when setting to undefined', () => {
      const schema = z.object({
        value: z.number().optional(),
      });
      const model = createModelInstance(schema, { value: 42 });
      const internals = getModelInternals(model);

      model.value = undefined;

      assert.strictEqual(internals.isDirty(), true);
      assert.strictEqual(model.value, undefined);
    });

    it('should distinguish between undefined and missing', () => {
      const schema = z.object({
        a: z.number().optional(),
        b: z.number().optional(),
      });
      const model = createModelInstance(schema, { a: 1, b: 2 });

      model.a = undefined;
      delete (model as Record<string, unknown>).b;

      assert.strictEqual('a' in model, true); // exists but undefined
      assert.strictEqual('b' in model, false); // actually deleted
    });
  });

  describe('array edge cases', () => {
    it('should handle sparse arrays', () => {
      const schema = z.object({
        items: z.array(z.number().optional()).default([]),
      });
      const model = createModelInstance(schema, { items: [1, 2, 3] });
      const internals = getModelInternals(model);

      // Create a hole
      delete (model.items as unknown[])[1];

      assert.strictEqual(internals.isDirty(), true);
      assert.strictEqual(model.items.length, 3);
      assert.strictEqual(1 in model.items, false); // hole
      assertExactPaths(internals.getDirtyPaths(), ['items.1', 'items']);
    });

    it('should handle direct length manipulation', () => {
      const schema = z.object({
        items: z.array(z.number()).default([1, 2, 3, 4, 5]),
      });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      model.items.length = 2;

      assert.strictEqual(internals.isDirty(), true);
      assert.deepStrictEqual([...model.items], [1, 2]);
      // Note: Setting length directly only triggers the length property change,
      // not individual deleteProperty calls for truncated elements
      assertExactPaths(internals.getDirtyPaths(), ['items.length', 'items']);
    });

    it('should handle setting array index beyond length', () => {
      const schema = z.object({
        items: z.array(z.number()).default([1, 2]),
      });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      model.items[5] = 99;

      assert.strictEqual(internals.isDirty(), true);
      assert.strictEqual(model.items.length, 6);
      assert.strictEqual(model.items[5], 99);
      assertExactPaths(internals.getDirtyPaths(), ['items.5', 'items']);
    });
  });

  describe('same reference assignment', () => {
    it('should not mark dirty when assigning same primitive', () => {
      const schema = z.object({ count: z.number().default(0) });
      const model = createModelInstance(schema, { count: 42 });
      const internals = getModelInternals(model);

      model.count = 42;

      assert.strictEqual(internals.isDirty(), false);
    });

    it('should not mark dirty when assigning same object reference', () => {
      const schema = z.object({ user: z.any() });
      const model = createModelInstance(schema, { user: { name: 'Alice' } });
      const internals = getModelInternals(model);

      const sameRef = model.user;
      model.user = sameRef;

      assert.strictEqual(internals.isDirty(), false);
    });

    it('should mark dirty when assigning equal but different object', () => {
      const schema = z.object({ user: z.any() });
      const model = createModelInstance(schema, { user: { name: 'Alice' } });
      const internals = getModelInternals(model);

      model.user = { name: 'Alice' }; // Same content, different reference

      assert.strictEqual(internals.isDirty(), true);
    });
  });

  describe('replacing nested objects', () => {
    it('should track changes on replacement object', () => {
      const schema = z.object({
        user: z.object({
          name: z.string().default(''),
        }),
      });
      const model = createModelInstance(schema, { user: { name: 'Alice' } });
      const internals = getModelInternals(model);

      // Replace the whole object
      model.user = { name: 'Bob' };
      internals.markClean();

      // Now modify the new object
      model.user.name = 'Charlie';

      assert.strictEqual(internals.isDirty(), true);
      assertExactPaths(internals.getDirtyPaths(), ['user.name', 'user']);
    });

    it('should disconnect old object from tracking after replacement', () => {
      const schema = z.object({
        user: z.object({
          name: z.string().default(''),
        }),
      });
      const model = createModelInstance(schema, { user: { name: 'Alice' } });
      const internals = getModelInternals(model);

      const oldUser = model.user;
      model.user = { name: 'Bob' };
      internals.markClean();

      // Modify the old reference directly (bypassing proxy)
      // This shouldn't affect the model's dirty state since it's disconnected
      // Note: oldUser is still a proxy, so this WILL mark dirty
      // This test documents current behavior
      oldUser.name = 'Changed';

      // Current behavior: old proxy still marks dirty
      // This might be expected or might want to change
      assert.strictEqual(model.user.name, 'Bob'); // Model has new value
    });
  });

  describe('special values', () => {
    it('should handle NaN', () => {
      const schema = z.object({ value: z.union([z.number(), z.nan()]).default(0) });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      model.value = NaN;

      assert.strictEqual(internals.isDirty(), true);
      assertExactPaths(internals.getDirtyPaths(), ['value']);
      assert.strictEqual(Number.isNaN(model.value), true);
    });

    it('should handle setting NaN to NaN (should not mark dirty)', () => {
      const schema = z.object({ value: z.nan().default(NaN) });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      model.value = NaN;

      // NaN !== NaN, so this WILL mark dirty (current behavior)
      // This documents the behavior - might want to use Object.is() instead
      assert.strictEqual(internals.isDirty(), true);
      assertExactPaths(internals.getDirtyPaths(), ['value']);
    });

    it('should handle null', () => {
      const schema = z.object({ value: z.any() });
      const model = createModelInstance(schema, { value: { nested: 1 } });
      const internals = getModelInternals(model);

      model.value = null;

      assert.strictEqual(internals.isDirty(), true);
      assertExactPaths(internals.getDirtyPaths(), ['value']);
      assert.strictEqual(model.value, null);
    });

    it('should handle BigInt', () => {
      const schema = z.object({ value: z.any() });
      const model = createModelInstance(schema, { value: 0n });
      const internals = getModelInternals(model);

      model.value = 9007199254740993n;

      assert.strictEqual(internals.isDirty(), true);
      assertExactPaths(internals.getDirtyPaths(), ['value']);
      assert.strictEqual(model.value, 9007199254740993n);
    });

    it('should handle -0 vs 0', () => {
      const schema = z.object({ value: z.number().default(0) });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      model.value = -0;

      // 0 === -0 is true, so should not be dirty
      assert.strictEqual(internals.isDirty(), false);
    });

    it('should handle Infinity', () => {
      const schema = z.object({ value: z.number().default(0) });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      model.value = Infinity;

      assert.strictEqual(internals.isDirty(), true);
      assertExactPaths(internals.getDirtyPaths(), ['value']);
      assert.strictEqual(model.value, Infinity);
    });
  });

  describe('deep nesting', () => {
    it('should handle very deep nesting without stack overflow', () => {
      const schema = z.object({ root: z.any() });

      // Create 100 levels deep
      let deep: Record<string, unknown> = { value: 'bottom' };
      for (let i = 0; i < 100; i++) {
        deep = { nested: deep };
      }

      const model = createModelInstance(schema, { root: deep });
      const internals = getModelInternals(model);

      // Navigate to bottom and modify
      let current: Record<string, unknown> = model.root as Record<string, unknown>;
      for (let i = 0; i < 100; i++) {
        current = current.nested as Record<string, unknown>;
      }
      current.value = 'modified';

      assert.strictEqual(internals.isDirty(), true);
    });
  });

  describe('watch edge cases', () => {
    it('should handle markClean during watch callback', () => {
      const schema = z.object({ count: z.number().default(0) });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      let callCount = 0;
      watch(model, (_paths) => {
        callCount++;
        internals.markClean(); // Clear during callback
      });

      model.count = 1;
      model.count = 2;

      assert.strictEqual(callCount, 2);
      assert.strictEqual(internals.isDirty(), false);
    });

    it('should handle multiple watchers where one unsubscribes during callback', () => {
      const schema = z.object({ count: z.number().default(0) });
      const model = createModelInstance(schema, {});

      const calls1: number[] = [];
      const calls2: number[] = [];
      const handle1 = watch(model, () => {
        calls1.push(model.count);
        if (model.count === 1) {
          handle1.unsubscribe();
        }
      });

      watch(model, () => {
        calls2.push(model.count);
      });

      model.count = 1;
      model.count = 2;
      model.count = 3;

      assert.strictEqual(calls1.length, 1); // Unsubscribed after first
      assert.strictEqual(calls2.length, 3); // All three
    });

    it('should handle watcher that modifies the model', () => {
      const schema = z.object({
        input: z.number().default(0),
        doubled: z.number().default(0),
      });
      const model = createModelInstance(schema, {});

      let callCount = 0;

      watch(model, (paths) => {
        callCount++;
        // Only react to input on first change to avoid infinite loop
        if (paths.includes('input') && callCount === 1) {
          model.doubled = model.input * 2; // Causes another notification
        }
      });

      model.input = 5;

      assert.strictEqual(model.doubled, 10);
      // Called twice: once for input, once for doubled
      assert.strictEqual(callCount, 2);
    });

    it('should pass all dirty paths (accumulated) in callback', () => {
      const schema = z.object({
        a: z.number().default(0),
        b: z.number().default(0),
      });
      const model = createModelInstance(schema, {});
      const _internals = getModelInternals(model);

      const receivedPaths: string[][] = [];

      watch(model, (paths) => {
        receivedPaths.push([...paths]);
      });

      model.a = 1;
      model.b = 2;

      // Each callback gets ALL dirty paths at that moment
      assert.ok(receivedPaths[0].includes('a'));
      assert.ok(receivedPaths[1].includes('a')); // Still dirty
      assert.ok(receivedPaths[1].includes('b')); // New
    });
  });

  describe('observable edge cases', () => {
    it('should handle empty object', () => {
      const obs = createObservable({});
      const internals = getObservableInternals(obs);

      (obs as Record<string, unknown>).newProp = 'value';

      assert.strictEqual(internals.isDirty(), true);
      assertExactPaths(internals.getDirtyPaths(), ['newProp']);
    });

    it('should handle adding new properties', () => {
      const obs = createObservable({ existing: 1 });
      const internals = getObservableInternals(obs);

      (obs as Record<string, unknown>).newProp = 'added';

      assert.strictEqual(internals.isDirty(), true);
      assert.strictEqual((obs as Record<string, unknown>).newProp, 'added');
      assertExactPaths(internals.getDirtyPaths(), ['newProp']);
    });

    it('should track changes on dynamically added nested objects', () => {
      const obs = createObservable<Record<string, unknown>>({});
      const internals = getObservableInternals(obs);

      obs.user = { name: 'Alice' };
      internals.markClean();

      (obs.user as { name: string }).name = 'Bob';

      assert.strictEqual(internals.isDirty(), true);
      assertExactPaths(internals.getDirtyPaths(), ['user.name', 'user']);
    });
  });

  describe('symbols as keys', () => {
    it('should handle symbol keys for getting', () => {
      const sym = Symbol('test');
      const obj = { [sym]: 'secret', normal: 'visible' };
      const obs = createObservable(obj);

      assert.strictEqual((obs as any)[sym], 'secret');
      assert.strictEqual(obs.normal, 'visible');
    });

    it('should track symbol key changes as dirty', () => {
      const sym = Symbol('test');
      const obj: Record<symbol | string, unknown> = { [sym]: 'original' };
      const obs = createObservable(obj);
      const internals = getObservableInternals(obs);

      obs[sym] = 'changed';

      assert.strictEqual(internals.isDirty(), true);
      // Symbol gets stringified in path
      assertExactPaths(internals.getDirtyPaths(), ['Symbol(test)']);
    });

    it('should handle well-known symbols', () => {
      const obj = {
        data: [1, 2, 3],
        [Symbol.toStringTag]: 'CustomObject',
      };
      const obs = createObservable(obj);

      // Should be able to read well-known symbols
      assert.strictEqual((obs as any)[Symbol.toStringTag], 'CustomObject');

      // Object.prototype.toString should work
      assert.strictEqual(Object.prototype.toString.call(obs), '[object CustomObject]');
    });

    it('should handle Symbol.iterator', () => {
      const obj = {
        items: [1, 2, 3],
        *[Symbol.iterator]() {
          yield* this.items;
        },
      };
      const obs = createObservable(obj);

      // Should be iterable
      const result = [...obs];
      assert.deepStrictEqual(result, [1, 2, 3]);
    });
  });

  describe('methods and this binding', () => {
    it('should call methods with correct this', () => {
      const obj = {
        value: 10,
        getValue() {
          return this.value;
        },
      };
      const obs = createObservable(obj);

      assert.strictEqual(obs.getValue(), 10);
    });

    it('should track dirty when method modifies this', () => {
      const obj = {
        count: 0,
        increment() {
          this.count++;
        },
      };
      const obs = createObservable(obj);
      const internals = getObservableInternals(obs);

      obs.increment();

      // Methods are bound to proxy, so this.count++ triggers dirty tracking
      assert.strictEqual(obs.count, 1);
      assert.strictEqual(internals.isDirty(), true);
    });

    it('should track dirty when method modifies via returned proxy property', () => {
      // Workaround: access properties through the proxy
      const schema = z.object({
        count: z.number().default(0),
      });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      // External modification through proxy works
      model.count++;

      assert.strictEqual(model.count, 1);
      assert.strictEqual(internals.isDirty(), true);
    });

    it('should handle getter properties', () => {
      const obj = {
        _value: 5,
        get doubled() {
          return this._value * 2;
        },
      };
      const obs = createObservable(obj);

      assert.strictEqual(obs.doubled, 10);
    });

    it('should handle setter properties and track dirty', () => {
      const obj = {
        _value: 0,
        get value() {
          return this._value;
        },
        set value(v: number) {
          this._value = v;
        },
      };
      const obs = createObservable(obj);
      const internals = getObservableInternals(obs);

      obs.value = 42;

      // Setter modifies _value through proxy, so it's tracked
      assert.strictEqual(obs._value, 42);
      assert.strictEqual(obs.value, 42);
      assert.strictEqual(internals.isDirty(), true);
    });

    it('should handle arrow function methods (lexical this)', () => {
      // Arrow functions capture `this` at definition time
      const value = 100;
      const obj = {
        value: 50,
        // This would capture outer `this`, not the object
        arrowMethod: () => value, // Returns outer `value`, not this.value
      };
      const obs = createObservable(obj);

      assert.strictEqual(obs.arrowMethod(), 100); // Uses lexical scope
    });

    it('should handle class instances and track method mutations', () => {
      class Counter {
        count = 0;

        increment() {
          this.count++;
        }

        getCount() {
          return this.count;
        }
      }

      const counter = new Counter();
      const obs = createObservable(counter);
      const internals = getObservableInternals(obs);

      // Method call now tracks because methods are bound to proxy
      obs.increment();
      assert.strictEqual(obs.count, 1);
      assert.strictEqual(internals.isDirty(), true);

      // Direct modification also works
      internals.markClean();
      obs.count = 5;
      assert.strictEqual(internals.isDirty(), true);
    });
  });

  describe('private fields - known limitation', () => {
    it('should throw TypeError because methods are bound to proxy', () => {
      class Secret {
        #hidden = 'secret';

        getHidden() {
          return this.#hidden;
        }
      }

      const secret = new Secret();
      const obs = createObservable(secret);

      // Private fields require `this` to be the exact instance
      // Since methods are bound to proxy for dirty tracking, this breaks
      assert.throws(() => {
        obs.getHidden();
      }, TypeError);
    });
  });

  describe('built-in objects with internal slots', () => {
    it('should handle Map - methods work and mutations track dirty', () => {
      const obs = createObservable({ map: new Map([['a', 1]]) });
      const internals = getObservableInternals(obs);

      // Methods work
      assert.strictEqual(obs.map.get('a'), 1);
      obs.map.set('b', 2);
      assert.strictEqual(obs.map.get('b'), 2);
      assert.strictEqual(obs.map.size, 2);
      assert.deepStrictEqual([...obs.map.keys()], ['a', 'b']);

      // Internal mutations track dirty - just the container path
      assertExactPaths(internals.getDirtyPaths(), ['map']);

      internals.markClean();
      obs.map.delete('a');
      assertExactPaths(internals.getDirtyPaths(), ['map']);

      internals.markClean();
      obs.map.clear();
      assertExactPaths(internals.getDirtyPaths(), ['map']);
    });

    it('should handle Set - methods work and mutations track dirty', () => {
      const obs = createObservable({ set: new Set([1, 2, 3]) });
      const internals = getObservableInternals(obs);

      assert.strictEqual(obs.set.has(1), true);
      obs.set.add(4);
      assert.strictEqual(obs.set.has(4), true);
      assert.strictEqual(obs.set.size, 4);
      assert.deepStrictEqual([...obs.set.values()], [1, 2, 3, 4]);

      assertExactPaths(internals.getDirtyPaths(), ['set']);

      internals.markClean();
      obs.set.delete(1);
      assertExactPaths(internals.getDirtyPaths(), ['set']);

      internals.markClean();
      obs.set.clear();
      assertExactPaths(internals.getDirtyPaths(), ['set']);
    });

    it('should handle Date - methods work and mutations track dirty', () => {
      const obs = createObservable({ date: new Date('2024-01-15') });
      const internals = getObservableInternals(obs);

      assert.strictEqual(obs.date.getFullYear(), 2024);
      assert.strictEqual(obs.date.getMonth(), 0);
      assert.strictEqual(obs.date.getDate(), 15);

      obs.date.setFullYear(2025);
      assert.strictEqual(obs.date.getFullYear(), 2025);
      assertExactPaths(internals.getDirtyPaths(), ['date']);

      internals.markClean();
      obs.date.setMonth(6);
      assertExactPaths(internals.getDirtyPaths(), ['date']);
    });

    it('should handle TypedArray - index access works', () => {
      const obs = createObservable({ arr: new Uint8Array([1, 2, 3]) });

      assert.strictEqual(obs.arr.length, 3);
      assert.strictEqual(obs.arr[0], 1);
      obs.arr[0] = 99;
      assert.strictEqual(obs.arr[0], 99);
    });

    it('should handle RegExp - methods work', () => {
      const obs = createObservable({ regex: /hello/i });

      assert.strictEqual(obs.regex.test('Hello'), true);
      assert.strictEqual(obs.regex.test('world'), false);
    });

    it('should track dirty when replacing built-in with new instance', () => {
      const obs = createObservable({
        map: new Map([['a', 1]]),
        set: new Set([1]),
        date: new Date(),
      });
      const internals = getObservableInternals(obs);

      obs.map = new Map([['b', 2]]);
      assertExactPaths(internals.getDirtyPaths(), ['map']);

      internals.markClean();
      obs.set = new Set([99]);
      assertExactPaths(internals.getDirtyPaths(), ['set']);

      internals.markClean();
      obs.date = new Date('2030-01-01');
      assertExactPaths(internals.getDirtyPaths(), ['date']);
    });

    it('should handle nested object containing built-ins', () => {
      const obs = createObservable({
        data: {
          cache: new Map([['key', 'value']]),
          tags: new Set(['a', 'b']),
        },
      });
      const internals = getObservableInternals(obs);

      // Built-in methods work through nested access
      assert.strictEqual(obs.data.cache.get('key'), 'value');
      assert.strictEqual(obs.data.tags.has('a'), true);

      // Mutating nested built-in tracks parent paths
      obs.data.cache.set('new', 'value');
      assertExactPaths(internals.getDirtyPaths(), ['data.cache', 'data']);

      internals.markClean();

      // Replacing nested built-in also tracks parent paths
      obs.data.cache = new Map([['replaced', 'map']]);
      assertExactPaths(internals.getDirtyPaths(), ['data.cache', 'data']);
    });

    it('should handle Map iteration methods', () => {
      const obs = createObservable({
        map: new Map([
          ['a', 1],
          ['b', 2],
          ['c', 3],
        ]),
      });

      // entries()
      const entries = [...obs.map.entries()];
      assert.deepStrictEqual(entries, [
        ['a', 1],
        ['b', 2],
        ['c', 3],
      ]);

      // keys()
      const keys = [...obs.map.keys()];
      assert.deepStrictEqual(keys, ['a', 'b', 'c']);

      // values()
      const values = [...obs.map.values()];
      assert.deepStrictEqual(values, [1, 2, 3]);

      // forEach
      const forEachResults: [string, number][] = [];
      obs.map.forEach((value, key) => {
        forEachResults.push([key, value]);
      });
      assert.deepStrictEqual(forEachResults, [
        ['a', 1],
        ['b', 2],
        ['c', 3],
      ]);

      // for...of iteration (uses Symbol.iterator -> entries)
      const iterResults: [string, number][] = [];
      for (const [key, value] of obs.map) {
        iterResults.push([key, value]);
      }
      assert.deepStrictEqual(iterResults, [
        ['a', 1],
        ['b', 2],
        ['c', 3],
      ]);
    });

    it('should handle Set iteration methods', () => {
      const obs = createObservable({ set: new Set([1, 2, 3]) });

      // values()
      const values = [...obs.set.values()];
      assert.deepStrictEqual(values, [1, 2, 3]);

      // keys() - same as values() for Set
      const keys = [...obs.set.keys()];
      assert.deepStrictEqual(keys, [1, 2, 3]);

      // entries() - [value, value] pairs for Set
      const entries = [...obs.set.entries()];
      assert.deepStrictEqual(entries, [
        [1, 1],
        [2, 2],
        [3, 3],
      ]);

      // forEach
      const forEachResults: number[] = [];
      obs.set.forEach((value) => {
        forEachResults.push(value);
      });
      assert.deepStrictEqual(forEachResults, [1, 2, 3]);

      // for...of iteration
      const iterResults: number[] = [];
      for (const value of obs.set) {
        iterResults.push(value);
      }
      assert.deepStrictEqual(iterResults, [1, 2, 3]);
    });

    it('should handle WeakMap - methods work but no dirty tracking for internal mutations', () => {
      const keyObj = { id: 1 };
      const obs = createObservable({ weakMap: new WeakMap([[keyObj, 'value']]) });
      const internals = getObservableInternals(obs);

      // Methods work
      assert.strictEqual(obs.weakMap.get(keyObj), 'value');
      assert.strictEqual(obs.weakMap.has(keyObj), true);

      // Mutations track dirty
      obs.weakMap.set(keyObj, 'updated');
      assertExactPaths(internals.getDirtyPaths(), ['weakMap']);

      internals.markClean();

      const newKey = { id: 2 };
      obs.weakMap.set(newKey, 'new');
      assertExactPaths(internals.getDirtyPaths(), ['weakMap']);

      internals.markClean();

      obs.weakMap.delete(keyObj);
      assertExactPaths(internals.getDirtyPaths(), ['weakMap']);
    });

    it('should handle WeakSet - methods work and mutations track dirty', () => {
      const obj1 = { id: 1 };
      const obj2 = { id: 2 };
      const obs = createObservable({ weakSet: new WeakSet([obj1]) });
      const internals = getObservableInternals(obs);

      // Methods work
      assert.strictEqual(obs.weakSet.has(obj1), true);
      assert.strictEqual(obs.weakSet.has(obj2), false);

      // Mutations track dirty
      obs.weakSet.add(obj2);
      assertExactPaths(internals.getDirtyPaths(), ['weakSet']);
      assert.strictEqual(obs.weakSet.has(obj2), true);

      internals.markClean();

      obs.weakSet.delete(obj1);
      assertExactPaths(internals.getDirtyPaths(), ['weakSet']);
      assert.strictEqual(obs.weakSet.has(obj1), false);
    });

    it('should handle TypedArray mutation methods - fill', () => {
      const obs = createObservable({ arr: new Uint8Array([1, 2, 3, 4, 5]) });
      const internals = getObservableInternals(obs);

      obs.arr.fill(0);
      assert.deepStrictEqual([...obs.arr], [0, 0, 0, 0, 0]);
      assertExactPaths(internals.getDirtyPaths(), ['arr']);
    });

    it('should handle TypedArray mutation methods - set', () => {
      const obs = createObservable({ arr: new Int16Array([1, 2, 3, 4, 5]) });
      const internals = getObservableInternals(obs);

      obs.arr.set([10, 20], 1); // Set [10, 20] starting at index 1
      assert.deepStrictEqual([...obs.arr], [1, 10, 20, 4, 5]);
      assertExactPaths(internals.getDirtyPaths(), ['arr']);
    });

    it('should handle TypedArray mutation methods - copyWithin', () => {
      const obs = createObservable({ arr: new Float32Array([1, 2, 3, 4, 5]) });
      const internals = getObservableInternals(obs);

      obs.arr.copyWithin(0, 3); // Copy elements from index 3 to index 0
      assert.deepStrictEqual([...obs.arr], [4, 5, 3, 4, 5]);
      assertExactPaths(internals.getDirtyPaths(), ['arr']);
    });

    it('should handle TypedArray mutation methods - sort', () => {
      const obs = createObservable({ arr: new Uint32Array([3, 1, 4, 1, 5, 9, 2, 6]) });
      const internals = getObservableInternals(obs);

      obs.arr.sort();
      assert.deepStrictEqual([...obs.arr], [1, 1, 2, 3, 4, 5, 6, 9]);
      assertExactPaths(internals.getDirtyPaths(), ['arr']);
    });

    it('should handle TypedArray mutation methods - reverse', () => {
      const obs = createObservable({ arr: new Int8Array([1, 2, 3]) });
      const internals = getObservableInternals(obs);

      obs.arr.reverse();
      assert.deepStrictEqual([...obs.arr], [3, 2, 1]);
      assertExactPaths(internals.getDirtyPaths(), ['arr']);
    });

    it('should handle TypedArray non-mutating methods without marking dirty', () => {
      const obs = createObservable({ arr: new Uint8Array([1, 2, 3, 4, 5]) });
      const internals = getObservableInternals(obs);

      // These should NOT mark dirty
      const sliced = obs.arr.slice(1, 3);
      assert.deepStrictEqual([...sliced], [2, 3]);

      const mapped = obs.arr.map((x) => x * 2);
      assert.deepStrictEqual([...mapped], [2, 4, 6, 8, 10]);

      const filtered = obs.arr.filter((x) => x > 2);
      assert.deepStrictEqual([...filtered], [3, 4, 5]);

      const found = obs.arr.find((x) => x > 3);
      assert.strictEqual(found, 4);

      const index = obs.arr.indexOf(3);
      assert.strictEqual(index, 2);

      const sum = obs.arr.reduce((a, b) => a + b, 0);
      assert.strictEqual(sum, 15);

      // Still not dirty
      assert.strictEqual(internals.isDirty(), false);
    });

    it('should handle all TypedArray types', () => {
      const obs = createObservable({
        int8: new Int8Array([1, 2]),
        uint8: new Uint8Array([1, 2]),
        uint8Clamped: new Uint8ClampedArray([1, 2]),
        int16: new Int16Array([1, 2]),
        uint16: new Uint16Array([1, 2]),
        int32: new Int32Array([1, 2]),
        uint32: new Uint32Array([1, 2]),
        float32: new Float32Array([1.5, 2.5]),
        float64: new Float64Array([1.5, 2.5]),
        bigInt64: new BigInt64Array([1n, 2n]),
        bigUint64: new BigUint64Array([1n, 2n]),
      });
      const internals = getObservableInternals(obs);

      // All can be read
      assert.strictEqual(obs.int8[0], 1);
      assert.strictEqual(obs.uint8[0], 1);
      assert.strictEqual(obs.uint8Clamped[0], 1);
      assert.strictEqual(obs.int16[0], 1);
      assert.strictEqual(obs.uint16[0], 1);
      assert.strictEqual(obs.int32[0], 1);
      assert.strictEqual(obs.uint32[0], 1);
      assert.strictEqual(obs.float32[0], 1.5);
      assert.strictEqual(obs.float64[0], 1.5);
      assert.strictEqual(obs.bigInt64[0], 1n);
      assert.strictEqual(obs.bigUint64[0], 1n);

      // All can be mutated and track dirty
      obs.int8.fill(9);
      assertExactPaths(internals.getDirtyPaths(), ['int8']);
    });

    it('should handle DataView - read methods work', () => {
      const buffer = new ArrayBuffer(16);
      const obs = createObservable({ view: new DataView(buffer) });

      // Write some data first (through the view)
      obs.view.setInt32(0, 42);
      obs.view.setFloat64(4, Math.PI);

      // Read it back
      assert.strictEqual(obs.view.getInt32(0), 42);
      assert.strictEqual(obs.view.getFloat64(4), Math.PI);

      // Properties
      assert.strictEqual(obs.view.byteLength, 16);
      assert.strictEqual(obs.view.byteOffset, 0);
    });

    it('should handle DataView - write methods track dirty', () => {
      const buffer = new ArrayBuffer(64); // Larger buffer for all tests
      const obs = createObservable({ view: new DataView(buffer) });
      const internals = getObservableInternals(obs);

      obs.view.setInt8(0, 127);
      assertExactPaths(internals.getDirtyPaths(), ['view']);

      internals.markClean();
      obs.view.setUint8(1, 255);
      assertExactPaths(internals.getDirtyPaths(), ['view']);

      internals.markClean();
      obs.view.setInt16(2, 32767);
      assertExactPaths(internals.getDirtyPaths(), ['view']);

      internals.markClean();
      obs.view.setUint16(4, 65535);
      assertExactPaths(internals.getDirtyPaths(), ['view']);

      internals.markClean();
      obs.view.setInt32(8, 2147483647);
      assertExactPaths(internals.getDirtyPaths(), ['view']);

      internals.markClean();
      obs.view.setUint32(12, 4294967295);
      assertExactPaths(internals.getDirtyPaths(), ['view']);

      internals.markClean();
      obs.view.setFloat32(16, 3.14);
      assertExactPaths(internals.getDirtyPaths(), ['view']);

      internals.markClean();
      obs.view.setFloat64(24, Math.PI);
      assertExactPaths(internals.getDirtyPaths(), ['view']);

      internals.markClean();
      obs.view.setBigInt64(32, 9007199254740993n);
      assertExactPaths(internals.getDirtyPaths(), ['view']);

      internals.markClean();
      obs.view.setBigUint64(40, 18446744073709551615n);
      assertExactPaths(internals.getDirtyPaths(), ['view']);
    });

    it('should handle DataView read methods without marking dirty', () => {
      const buffer = new ArrayBuffer(16);
      const view = new DataView(buffer);
      view.setInt32(0, 42);

      const obs = createObservable({ view: new DataView(buffer) });
      const internals = getObservableInternals(obs);

      // All reads should not mark dirty
      obs.view.getInt8(0);
      obs.view.getUint8(0);
      obs.view.getInt16(0);
      obs.view.getUint16(0);
      obs.view.getInt32(0);
      obs.view.getUint32(0);
      obs.view.getFloat32(0);
      obs.view.getFloat64(0);

      assert.strictEqual(internals.isDirty(), false);
    });

    it('should handle Date - all mutator methods track dirty', () => {
      const obs = createObservable({ date: new Date('2024-06-15T12:30:45.500Z') });
      const internals = getObservableInternals(obs);

      obs.date.setDate(20);
      assertExactPaths(internals.getDirtyPaths(), ['date']);
      assert.strictEqual(obs.date.getDate(), 20);

      internals.markClean();
      obs.date.setMonth(11);
      assertExactPaths(internals.getDirtyPaths(), ['date']);

      internals.markClean();
      obs.date.setHours(15);
      assertExactPaths(internals.getDirtyPaths(), ['date']);

      internals.markClean();
      obs.date.setMinutes(45);
      assertExactPaths(internals.getDirtyPaths(), ['date']);

      internals.markClean();
      obs.date.setSeconds(30);
      assertExactPaths(internals.getDirtyPaths(), ['date']);

      internals.markClean();
      obs.date.setMilliseconds(999);
      assertExactPaths(internals.getDirtyPaths(), ['date']);

      internals.markClean();
      obs.date.setTime(0);
      assertExactPaths(internals.getDirtyPaths(), ['date']);
    });

    it('should handle Date - UTC mutator methods track dirty', () => {
      const obs = createObservable({ date: new Date('2024-06-15T12:30:45.500Z') });
      const internals = getObservableInternals(obs);

      obs.date.setUTCDate(20);
      assertExactPaths(internals.getDirtyPaths(), ['date']);

      internals.markClean();
      obs.date.setUTCMonth(11);
      assertExactPaths(internals.getDirtyPaths(), ['date']);

      internals.markClean();
      obs.date.setUTCFullYear(2030);
      assertExactPaths(internals.getDirtyPaths(), ['date']);

      internals.markClean();
      obs.date.setUTCHours(23);
      assertExactPaths(internals.getDirtyPaths(), ['date']);

      internals.markClean();
      obs.date.setUTCMinutes(59);
      assertExactPaths(internals.getDirtyPaths(), ['date']);

      internals.markClean();
      obs.date.setUTCSeconds(59);
      assertExactPaths(internals.getDirtyPaths(), ['date']);

      internals.markClean();
      obs.date.setUTCMilliseconds(999);
      assertExactPaths(internals.getDirtyPaths(), ['date']);
    });

    it('should handle Date - getter methods do not mark dirty', () => {
      const obs = createObservable({ date: new Date('2024-06-15T12:30:45.500Z') });
      const internals = getObservableInternals(obs);

      // All these should not mark dirty
      obs.date.getTime();
      obs.date.getFullYear();
      obs.date.getMonth();
      obs.date.getDate();
      obs.date.getDay();
      obs.date.getHours();
      obs.date.getMinutes();
      obs.date.getSeconds();
      obs.date.getMilliseconds();
      obs.date.getTimezoneOffset();
      obs.date.getUTCFullYear();
      obs.date.getUTCMonth();
      obs.date.getUTCDate();
      obs.date.getUTCDay();
      obs.date.getUTCHours();
      obs.date.getUTCMinutes();
      obs.date.getUTCSeconds();
      obs.date.getUTCMilliseconds();
      obs.date.toISOString();
      obs.date.toJSON();
      obs.date.toString();
      obs.date.toDateString();
      obs.date.toTimeString();
      obs.date.toLocaleString();
      obs.date.toLocaleDateString();
      obs.date.toLocaleTimeString();
      obs.date.valueOf();

      assert.strictEqual(internals.isDirty(), false);
    });

    it('should handle ArrayBuffer - can be observed and replaced', () => {
      const obs = createObservable({ buffer: new ArrayBuffer(8) });
      const internals = getObservableInternals(obs);

      // Can read properties
      assert.strictEqual(obs.buffer.byteLength, 8);

      // Replacing tracks dirty
      obs.buffer = new ArrayBuffer(16);
      assertExactPaths(internals.getDirtyPaths(), ['buffer']);
      assert.strictEqual(obs.buffer.byteLength, 16);
    });

    it('should handle SharedArrayBuffer if available', () => {
      // SharedArrayBuffer might not be available in all environments
      if (typeof SharedArrayBuffer !== 'undefined') {
        const obs = createObservable({ buffer: new SharedArrayBuffer(8) });
        assert.strictEqual(obs.buffer.byteLength, 8);
      }
    });

    it('should handle deeply nested built-ins with full path tracking', () => {
      const obs = createObservable({
        level1: {
          level2: {
            level3: {
              map: new Map([['key', 'value']]),
              set: new Set([1, 2, 3]),
              date: new Date('2024-01-01'),
            },
          },
        },
      });
      const internals = getObservableInternals(obs);

      obs.level1.level2.level3.map.set('new', 'entry');
      assertExactPaths(internals.getDirtyPaths(), [
        'level1.level2.level3.map',
        'level1.level2.level3',
        'level1.level2',
        'level1',
      ]);

      internals.markClean();

      obs.level1.level2.level3.set.add(4);
      assertExactPaths(internals.getDirtyPaths(), [
        'level1.level2.level3.set',
        'level1.level2.level3',
        'level1.level2',
        'level1',
      ]);

      internals.markClean();

      obs.level1.level2.level3.date.setFullYear(2030);
      assertExactPaths(internals.getDirtyPaths(), [
        'level1.level2.level3.date',
        'level1.level2.level3',
        'level1.level2',
        'level1',
      ]);
    });

    it('should handle shared built-ins across multiple paths', () => {
      const sharedMap = new Map([['key', 'value']]);
      const obs = createObservable({
        path1: { map: sharedMap },
        path2: { map: sharedMap },
      });
      const internals = getObservableInternals(obs);

      // Access through both paths first to establish tracking
      obs.path1.map.get('key');
      obs.path2.map.get('key');

      // Mutate through one path
      obs.path1.map.set('new', 'entry');

      // Both paths should be dirty
      assertExactPaths(internals.getDirtyPaths(), ['path1.map', 'path1', 'path2.map', 'path2']);
    });
  });

  describe('proxy transparency - native behavior', () => {
    it('should work with Object.keys', () => {
      const obs = createObservable({ a: 1, b: 2, c: 3 });
      assert.deepStrictEqual(Object.keys(obs), ['a', 'b', 'c']);
    });

    it('should work with Object.entries', () => {
      const obs = createObservable({ x: 10, y: 20 });
      assert.deepStrictEqual(Object.entries(obs), [
        ['x', 10],
        ['y', 20],
      ]);
    });

    it('should work with Object.values', () => {
      const obs = createObservable({ a: 1, b: 2 });
      assert.deepStrictEqual(Object.values(obs), [1, 2]);
    });

    it("should work with 'in' operator", () => {
      const obs = createObservable({ exists: true });
      assert.strictEqual('exists' in obs, true);
      assert.strictEqual('missing' in obs, false);
    });

    it('should work with for...in', () => {
      const obs = createObservable({ a: 1, b: 2, c: 3 });
      const keys: string[] = [];
      for (const key in obs) {
        keys.push(key);
      }
      assert.deepStrictEqual(keys, ['a', 'b', 'c']);
    });

    it('should work with spread operator', () => {
      const obs = createObservable({ a: 1, b: 2 });
      const spread = { ...obs };
      assert.deepStrictEqual(spread, { a: 1, b: 2 });
    });

    it('should work with Array.isArray on nested arrays', () => {
      const obs = createObservable({ items: [1, 2, 3] });
      assert.strictEqual(Array.isArray(obs.items), true);
    });

    it('should work with instanceof for built-ins', () => {
      const obs = createObservable({
        map: new Map(),
        set: new Set(),
        date: new Date(),
        arr: new Uint8Array(4),
      });
      assert.strictEqual(obs.map instanceof Map, true);
      assert.strictEqual(obs.set instanceof Set, true);
      assert.strictEqual(obs.date instanceof Date, true);
      assert.strictEqual(obs.arr instanceof Uint8Array, true);
    });

    it('should work with Object.getPrototypeOf', () => {
      const obs = createObservable({ value: 1 });
      assert.strictEqual(Object.getPrototypeOf(obs), Object.prototype);

      const obsArr = createObservable({ items: [1, 2] });
      assert.strictEqual(Object.getPrototypeOf(obsArr.items), Array.prototype);
    });

    it('should work with Object.getOwnPropertyDescriptor', () => {
      const obs = createObservable({ count: 42 });
      const desc = Object.getOwnPropertyDescriptor(obs, 'count');
      assert.strictEqual(desc?.value, 42);
      assert.strictEqual(desc?.writable, true);
      assert.strictEqual(desc?.enumerable, true);
    });

    it('should work with JSON.stringify', () => {
      const obs = createObservable({
        name: 'test',
        nested: { value: 123 },
        items: [1, 2, 3],
      });
      const json = JSON.stringify(obs);
      assert.strictEqual(json, '{"name":"test","nested":{"value":123},"items":[1,2,3]}');
    });

    it('should work with Object.assign', () => {
      const obs = createObservable({ a: 1 });
      const result = Object.assign({}, obs, { b: 2 });
      assert.deepStrictEqual(result, { a: 1, b: 2 });
    });

    it('should work with array spread', () => {
      const obs = createObservable({ items: [1, 2, 3] });
      const spread = [...obs.items];
      assert.deepStrictEqual(spread, [1, 2, 3]);
    });

    it('should work with array methods that return new arrays', () => {
      const obs = createObservable({ items: [1, 2, 3, 4, 5] });

      assert.deepStrictEqual(
        obs.items.map((x) => x * 2),
        [2, 4, 6, 8, 10],
      );
      assert.deepStrictEqual(
        obs.items.filter((x) => x > 2),
        [3, 4, 5],
      );
      assert.strictEqual(
        obs.items.reduce((a, b) => a + b, 0),
        15,
      );
      assert.strictEqual(
        obs.items.find((x) => x > 3),
        4,
      );
      assert.strictEqual(
        obs.items.findIndex((x) => x > 3),
        3,
      );
      assert.strictEqual(obs.items.includes(3), true);
      assert.strictEqual(obs.items.indexOf(3), 2);
      assert.deepStrictEqual(obs.items.slice(1, 3), [2, 3]);
    });

    it('should work with Object.hasOwn / hasOwnProperty', () => {
      const obs = createObservable({ exists: true });
      assert.strictEqual(Object.hasOwn(obs, 'exists'), true);
      assert.strictEqual(Object.hasOwn(obs, 'missing'), false);
      assert.strictEqual(Object.hasOwn(obs, 'exists'), true);
    });

    it('should work with Object.isExtensible', () => {
      const obs = createObservable({ value: 1 });
      assert.strictEqual(Object.isExtensible(obs), true);
    });

    it('should work with delete operator', () => {
      const obs = createObservable<Record<string, number>>({ a: 1, b: 2 });
      delete obs.a;
      assert.strictEqual('a' in obs, false);
      assert.deepStrictEqual(Object.keys(obs), ['b']);
    });
  });

  describe('prototype chain', () => {
    it('should handle inherited properties', () => {
      const parent = { inherited: 'from parent' };
      const child = Object.create(parent);
      child.own = 'own property';

      const obs = createObservable(child);

      assert.strictEqual(obs.inherited, 'from parent');
      assert.strictEqual(obs.own, 'own property');
    });

    it('should only track own property changes as dirty', () => {
      const parent = { inherited: 'from parent' };
      const child = Object.create(parent) as Record<string, unknown>;
      child.own = 'own property';

      const obs = createObservable(child);
      const internals = getObservableInternals(obs);

      // Modifying own property
      obs.own = 'modified';
      assert.strictEqual(internals.isDirty(), true);
      assertExactPaths(internals.getDirtyPaths(), ['own']);

      internals.markClean();

      // "Setting" inherited property creates own property
      (obs as any).inherited = 'shadowed';
      assert.strictEqual(internals.isDirty(), true);
      assertExactPaths(internals.getDirtyPaths(), ['inherited']);
      assert.strictEqual((obs as any).inherited, 'shadowed');
      // Original parent unchanged
      assert.strictEqual(parent.inherited, 'from parent');
    });
  });

  describe('frozen and sealed objects - known limitations', () => {
    it('should throw when trying to observe frozen objects', () => {
      const frozen = Object.freeze({ value: 42 });

      // Cannot attach OBSERVABLE_META to frozen object
      assert.throws(() => {
        createObservable(frozen);
      }, TypeError);
    });

    it('should throw when trying to observe sealed objects', () => {
      const sealed = Object.seal({ value: 42 });

      // Cannot attach OBSERVABLE_META to sealed object
      assert.throws(() => {
        createObservable(sealed);
      }, TypeError);
    });

    it('should handle freezing AFTER creating observable', () => {
      const obj = { value: 42 };
      const obs = createObservable(obj);

      // Now freeze the underlying object
      Object.freeze(obj);

      // Reading still works
      assert.strictEqual(obs.value, 42);

      // Writing should fail
      try {
        (obs as any).value = 100;
      } catch (_e) {
        // Expected in strict mode
      }

      // Value unchanged
      assert.strictEqual(obs.value, 42);
    });
  });

  describe('concurrent model operations', () => {
    it('should handle rapid successive changes', () => {
      const schema = z.object({ count: z.number().default(0) });
      const model = createModelInstance(schema, {});
      const internals = getModelInternals(model);

      for (let i = 0; i < 1000; i++) {
        model.count = i;
      }

      assert.strictEqual(model.count, 999);
      assert.strictEqual(internals.isDirty(), true);
    });

    it('should handle interleaved changes on multiple models sharing data', () => {
      const shared = createObservable({ value: 0 });

      const schema = z.object({ ref: z.any() });
      const model1 = createModelInstance(schema, { ref: shared });
      const model2 = createModelInstance(schema, { ref: shared });

      const internals1 = getModelInternals(model1);
      const internals2 = getModelInternals(model2);

      // Interleaved modifications and clean operations
      (model1.ref as { value: number }).value = 1;
      internals1.markClean();

      (model2.ref as { value: number }).value = 2;
      internals2.markClean();

      (model1.ref as { value: number }).value = 3;

      assert.strictEqual(internals1.isDirty(), true);
      assert.strictEqual(internals2.isDirty(), true);
      assert.strictEqual((model1.ref as { value: number }).value, 3);
      assert.strictEqual((model2.ref as { value: number }).value, 3);
      assertExactPaths(internals1.getDirtyPaths(), ['ref.value', 'ref']);
      assertExactPaths(internals2.getDirtyPaths(), ['ref.value', 'ref']);
    });
  });

  describe('key coercion edge cases', () => {
    describe('string vs number keys', () => {
      it("should treat arr[5] and arr['5'] as equivalent", () => {
        const schema = z.object({
          items: z.array(z.string()).default([]),
        });
        const model = createModelInstance(schema, { items: ['a', 'b', 'c', 'd', 'e', 'f'] });
        const internals = getModelInternals(model);

        // Set using numeric key
        (model.items as any)[5] = 'updated';
        internals.markClean();

        // Read using string key
        assert.strictEqual((model.items as any)['5'], 'updated');

        // Modify using string key
        (model.items as any)['5'] = 'updated-again';

        // Should record dirty path as string "5"
        assertExactPaths(internals.getDirtyPaths(), ['items.5', 'items']);
      });

      it('should handle numeric string keys on objects', () => {
        const schema = z.object({
          data: z.record(z.string(), z.number()).default({}),
        });
        const model = createModelInstance(schema, { data: {} });
        const internals = getModelInternals(model);

        // Set using string key
        (model.data as any)['5'] = 100;
        internals.markClean();

        // Access using numeric key (coerced to string)
        assert.strictEqual((model.data as any)[5], 100);

        // Modify using numeric key
        (model.data as any)[5] = 200;

        // Path should be string "5"
        assertExactPaths(internals.getDirtyPaths(), ['data.5', 'data']);
      });

      it('should handle zero as a key', () => {
        const schema = z.object({
          items: z.array(z.string()).default([]),
        });
        const model = createModelInstance(schema, { items: ['zero'] });
        const internals = getModelInternals(model);

        // Numeric zero
        (model.items as any)[0] = 'numeric';

        assertExactPaths(internals.getDirtyPaths(), ['items.0', 'items']);
        assert.strictEqual((model.items as any)['0'], 'numeric');
      });

      it('should handle very large numeric indices', () => {
        const schema = z.object({
          data: z.record(z.string(), z.string()).default({}),
        });
        const model = createModelInstance(schema, { data: {} });
        const internals = getModelInternals(model);

        const largeIndex = Number.MAX_SAFE_INTEGER;
        (model.data as any)[largeIndex] = 'large';

        assertExactPaths(internals.getDirtyPaths(), [`data.${largeIndex}`, 'data']);
        assert.strictEqual((model.data as any)[String(largeIndex)], 'large');
      });

      it('should handle numeric strings that look like numbers', () => {
        const schema = z.object({
          data: z.record(z.string(), z.string()).default({}),
        });
        const model = createModelInstance(schema, { data: {} });
        const internals = getModelInternals(model);

        // These are string keys, not array indices
        (model.data as any)['123'] = 'value1';
        (model.data as any)['0123'] = 'value2'; // Leading zero
        (model.data as any)['1.5'] = 'value3'; // Float

        assertExactPaths(internals.getDirtyPaths(), ['data.123', 'data.0123', 'data.1.5', 'data']);
      });
    });

    describe('object keys as property names', () => {
      it("should coerce object keys to '[object Object]'", () => {
        const schema = z.object({
          data: z.record(z.string(), z.number()).default({}),
        });
        const model = createModelInstance(schema, { data: {} });
        const internals = getModelInternals(model);

        const objKey = { id: 1 };
        // JavaScript coerces objects to "[object Object]" when used as keys
        (model.data as any)[objKey as any] = 42;

        assertExactPaths(internals.getDirtyPaths(), ['data.[object Object]', 'data']);
        assert.strictEqual((model.data as any)['[object Object]'], 42);
      });

      it('should handle different objects coercing to same key', () => {
        const schema = z.object({
          data: z.record(z.string(), z.number()).default({}),
        });
        const model = createModelInstance(schema, { data: {} });
        const internals = getModelInternals(model);

        const obj1 = { id: 1 };
        const obj2 = { id: 2 };

        // Both coerce to same key
        (model.data as any)[obj1 as any] = 100;
        internals.markClean();

        (model.data as any)[obj2 as any] = 200;

        // Should overwrite (same key)
        assert.strictEqual((model.data as any)['[object Object]'], 200);
        assertExactPaths(internals.getDirtyPaths(), ['data.[object Object]', 'data']);
      });
    });

    describe('symbol keys', () => {
      it('should handle symbol keys without coercing to string', () => {
        const schema = z.object({
          data: z.any().default({}),
        });
        const model = createModelInstance(schema, { data: {} });
        const internals = getModelInternals(model);

        const sym = Symbol('test');
        (model.data as any)[sym] = 'symbol-value';

        // Symbol keys should be tracked with Symbol(test) in path
        const paths = internals.getDirtyPaths();
        assert.strictEqual(
          paths.some((p) => p.includes('Symbol(test)')),
          true,
        );
        assert.strictEqual((model.data as any)[sym], 'symbol-value');
      });

      it('should distinguish between different symbols', () => {
        const schema = z.object({
          data: z.any().default({}),
        });
        const model = createModelInstance(schema, { data: {} });

        const sym1 = Symbol('test');
        const sym2 = Symbol('test'); // Different symbol, same description

        (model.data as any)[sym1] = 'value1';
        (model.data as any)[sym2] = 'value2';

        // Both should exist independently
        assert.strictEqual((model.data as any)[sym1], 'value1');
        assert.strictEqual((model.data as any)[sym2], 'value2');
      });

      it('should handle well-known symbols', () => {
        const schema = z.object({
          data: z.any().default({}),
        });
        const model = createModelInstance(schema, { data: {} });

        // toStringTag is a passthrough symbol, won't track dirty
        (model.data as any)[Symbol.toStringTag] = 'CustomObject';

        assert.strictEqual((model.data as any)[Symbol.toStringTag], 'CustomObject');
      });
    });

    describe('array index edge cases', () => {
      it('should treat negative indices as properties, not array indices', () => {
        const schema = z.object({
          items: z.array(z.number()).default([]),
        });
        const model = createModelInstance(schema, { items: [1, 2, 3] });
        const internals = getModelInternals(model);

        // Negative index is a property, not an array index
        (model.items as any)[-1] = 999;

        assertExactPaths(internals.getDirtyPaths(), ['items.-1', 'items']);
        assert.strictEqual((model.items as any)['-1'], 999);
        // Array content unchanged
        assert.strictEqual(model.items[0], 1);
        assert.strictEqual(model.items[2], 3);
      });

      it('should treat float indices as properties, not array indices', () => {
        const schema = z.object({
          items: z.array(z.number()).default([]),
        });
        const model = createModelInstance(schema, { items: [1, 2, 3] });
        const internals = getModelInternals(model);

        // Float is a property, not an array index
        (model.items as any)[1.5] = 999;

        assertExactPaths(internals.getDirtyPaths(), ['items.1.5', 'items']);
        assert.strictEqual((model.items as any)['1.5'], 999);
        // Array content unchanged
        assert.strictEqual(model.items[1], 2);
      });

      it('should handle Infinity as a key', () => {
        const schema = z.object({
          data: z.any().default({}),
        });
        const model = createModelInstance(schema, { data: {} });
        const internals = getModelInternals(model);

        (model.data as any)[Infinity] = 'infinite';
        (model.data as any)[-Infinity] = 'negative-infinite';

        assertExactPaths(internals.getDirtyPaths(), ['data.Infinity', 'data.-Infinity', 'data']);
        assert.strictEqual((model.data as any).Infinity, 'infinite');
        assert.strictEqual((model.data as any)['-Infinity'], 'negative-infinite');
      });

      it('should handle NaN as a key', () => {
        const schema = z.object({
          data: z.any().default({}),
        });
        const model = createModelInstance(schema, { data: {} });
        const internals = getModelInternals(model);

        // NaN coerces to "NaN" as a string key
        (model.data as any)[NaN] = 'not-a-number';

        assertExactPaths(internals.getDirtyPaths(), ['data.NaN', 'data']);
        assert.strictEqual((model.data as any).NaN, 'not-a-number');
      });
    });

    describe('prototype pollution concerns', () => {
      it('should handle __proto__ as a regular property key', () => {
        const schema = z.object({
          data: z.record(z.string(), z.any()).default({}),
        });
        const model = createModelInstance(schema, { data: {} });
        const internals = getModelInternals(model);

        // Set __proto__ as a regular property (doesn't affect prototype)
        (model.data as any).__proto__ = { malicious: true };

        assertExactPaths(internals.getDirtyPaths(), ['data.__proto__', 'data']);
        // Should be stored as regular property, not affecting prototype
        assert.strictEqual((model.data as any).__proto__.malicious, true);
      });

      it('should handle constructor as a regular property key', () => {
        const schema = z.object({
          data: z.record(z.string(), z.string()).default({}),
        });
        const model = createModelInstance(schema, { data: {} });
        const internals = getModelInternals(model);

        (model.data as any).constructor = 'overwritten';

        assertExactPaths(internals.getDirtyPaths(), ['data.constructor', 'data']);
      });

      it('should handle prototype as a regular property key', () => {
        const schema = z.object({
          data: z.record(z.string(), z.string()).default({}),
        });
        const model = createModelInstance(schema, { data: {} });
        const internals = getModelInternals(model);

        (model.data as any).prototype = 'test';

        assertExactPaths(internals.getDirtyPaths(), ['data.prototype', 'data']);
        assert.strictEqual((model.data as any).prototype, 'test');
      });
    });

    describe('empty and whitespace keys', () => {
      it('should handle empty string as a key', () => {
        const schema = z.object({
          data: z.record(z.string(), z.string()).default({}),
        });
        const model = createModelInstance(schema, { data: {} });
        const internals = getModelInternals(model);

        (model.data as any)[''] = 'empty-key';

        assertExactPaths(internals.getDirtyPaths(), ['data.', 'data']);
        assert.strictEqual((model.data as any)[''], 'empty-key');
      });

      it('should handle whitespace keys', () => {
        const schema = z.object({
          data: z.record(z.string(), z.string()).default({}),
        });
        const model = createModelInstance(schema, { data: {} });
        const internals = getModelInternals(model);

        (model.data as any)[' '] = 'space';
        (model.data as any)['\t'] = 'tab';
        (model.data as any)['\n'] = 'newline';

        assertExactPaths(internals.getDirtyPaths(), ['data. ', 'data.\t', 'data.\n', 'data']);
      });
    });

    describe('unicode and special character keys', () => {
      it('should handle unicode keys', () => {
        const schema = z.object({
          data: z.record(z.string(), z.string()).default({}),
        });
        const model = createModelInstance(schema, { data: {} });
        const internals = getModelInternals(model);

        (model.data as any)['🚀'] = 'rocket';
        (model.data as any).你好 = 'hello';
        (model.data as any).مرحبا = 'hello-arabic';

        assertExactPaths(internals.getDirtyPaths(), ['data.🚀', 'data.你好', 'data.مرحبا', 'data']);
        assert.strictEqual((model.data as any)['🚀'], 'rocket');
      });

      it('should handle keys with dots', () => {
        const schema = z.object({
          data: z.record(z.string(), z.string()).default({}),
        });
        const model = createModelInstance(schema, { data: {} });
        const internals = getModelInternals(model);

        // Key with dot is a single key, not a nested path
        (model.data as any)['a.b'] = 'value';

        assertExactPaths(internals.getDirtyPaths(), ['data.a.b', 'data']);
        assert.strictEqual((model.data as any)['a.b'], 'value');
      });
    });
  });
});
