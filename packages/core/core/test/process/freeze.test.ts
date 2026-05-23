import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { freezeDeep, readonlyMapProxy, readonlySetProxy, freezeExports } from '../../src/runtime/process/freeze.js';

describe('readonlyMapProxy', () => {
  it('allows get, has, size', () => {
    const map = new Map([['a', 1], ['b', 2]]);
    const ro = readonlyMapProxy(map);
    assert.equal(ro.get('a'), 1);
    assert.equal(ro.has('b'), true);
    assert.equal(ro.has('c'), false);
    assert.equal(ro.size, 2);
  });

  it('allows iteration', () => {
    const map = new Map([['x', 10]]);
    const ro = readonlyMapProxy(map);
    const entries = [...ro.entries()];
    assert.deepEqual(entries, [['x', 10]]);
    const keys = [...ro.keys()];
    assert.deepEqual(keys, ['x']);
    const values = [...ro.values()];
    assert.deepEqual(values, [10]);

    const collected: [string, number][] = [];
    ro.forEach((v, k) => collected.push([k, v]));
    assert.deepEqual(collected, [['x', 10]]);

    const spread = [...ro];
    assert.deepEqual(spread, [['x', 10]]);
  });

  it('throws TypeError on set/delete/clear', () => {
    const ro = readonlyMapProxy(new Map([['a', 1]]));
    assert.throws(() => (ro as any).set('b', 2), TypeError);
    assert.throws(() => (ro as any).delete('a'), TypeError);
    assert.throws(() => (ro as any).clear(), TypeError);
  });
});

describe('readonlySetProxy', () => {
  it('allows has, size', () => {
    const set = new Set([1, 2, 3]);
    const ro = readonlySetProxy(set);
    assert.equal(ro.has(1), true);
    assert.equal(ro.has(99), false);
    assert.equal(ro.size, 3);
  });

  it('allows iteration', () => {
    const ro = readonlySetProxy(new Set(['a', 'b']));
    assert.deepEqual([...ro.values()], ['a', 'b']);
    assert.deepEqual([...ro.keys()], ['a', 'b']);
    assert.deepEqual([...ro.entries()], [['a', 'a'], ['b', 'b']]);

    const collected: string[] = [];
    ro.forEach((v) => collected.push(v));
    assert.deepEqual(collected, ['a', 'b']);

    assert.deepEqual([...ro], ['a', 'b']);
  });

  it('throws TypeError on add/delete/clear', () => {
    const ro = readonlySetProxy(new Set([1]));
    assert.throws(() => (ro as any).add(2), TypeError);
    assert.throws(() => (ro as any).delete(1), TypeError);
    assert.throws(() => (ro as any).clear(), TypeError);
  });
});

describe('freezeDeep', () => {
  it('returns primitives as-is', () => {
    assert.equal(freezeDeep(42), 42);
    assert.equal(freezeDeep('hello'), 'hello');
    assert.equal(freezeDeep(null), null);
    assert.equal(freezeDeep(undefined), undefined);
    assert.equal(freezeDeep(true), true);
  });

  it('freezes plain objects', () => {
    const obj = freezeDeep({ a: 1 }) as Record<string, number>;
    assert.ok(Object.isFrozen(obj));
    assert.throws(() => { (obj as any).b = 2; }, TypeError);
  });

  it('freezes nested objects', () => {
    const obj = freezeDeep({ nested: { deep: 1 } }) as any;
    assert.ok(Object.isFrozen(obj));
    assert.ok(Object.isFrozen(obj.nested));
  });

  it('freezes arrays and their contents', () => {
    const arr = freezeDeep([{ x: 1 }, { x: 2 }]) as any[];
    assert.ok(Object.isFrozen(arr));
    assert.ok(Object.isFrozen(arr[0]));
    assert.throws(() => { arr.push(3 as any); }, TypeError);
  });

  it('deep-freezes Map values but not the Map itself', () => {
    const map = new Map([['key', { a: 1 }]]);
    const result = freezeDeep(map) as Map<string, any>;
    assert.ok(Object.isFrozen(result.get('key')));
  });

  it('does not freeze class instances', () => {
    class Foo { x = 1; }
    const foo = new Foo();
    const result = freezeDeep(foo) as Foo;
    assert.ok(!Object.isFrozen(result));
    result.x = 2;
    assert.equal(result.x, 2);
  });
});

describe('freezeExports', () => {
  it('freezes data properties', () => {
    const result = freezeExports({ count: 5, name: 'test' });
    assert.ok(Object.isFrozen(result));
    assert.equal(result.count, 5);
    assert.equal(result.name, 'test');
    assert.throws(() => { (result as any).count = 10; }, TypeError);
  });

  it('wraps Map in readonly proxy', () => {
    const result = freezeExports({ items: new Map([['a', 1]]) });
    assert.equal((result.items as any).get('a'), 1);
    assert.throws(() => (result.items as any).set('b', 2), TypeError);
  });

  it('wraps Set in readonly proxy', () => {
    const result = freezeExports({ tags: new Set(['x']) });
    assert.equal((result.tags as any).has('x'), true);
    assert.throws(() => (result.tags as any).add('y'), TypeError);
  });

  it('binds methods with frozen data as this', () => {
    const data = { count: 42 };
    const result = freezeExports(data, {
      getCount(this: typeof data) { return this.count; },
    });
    assert.equal((result as any).getCount(), 42);
  });

  it('methods can read but mutations throw', () => {
    const data = { value: 'hello' };
    const result = freezeExports(data, {
      mutate(this: typeof data) { (this as any).value = 'changed'; },
      read(this: typeof data) { return this.value; },
    });
    assert.equal((result as any).read(), 'hello');
    assert.throws(() => (result as any).mutate(), TypeError);
  });
});
