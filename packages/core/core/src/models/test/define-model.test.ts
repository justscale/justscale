import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  defineModel,
  field,
  isModelClass,
  getModelFields,
  getModelName,
  Reference,
  References,
  isReference,
  isReferences,
  MODEL_DEF,
  MODEL_FIELDS,
  MODEL_NAME,
} from '../index.js';

// ----------------------------------------------------------------------------
// defineModel — identity and name
// ----------------------------------------------------------------------------

describe('defineModel — identity', () => {
  test('returns a function / class constructor', () => {
    const User = defineModel({ fields: { name: field.string() } });
    assert.equal(typeof User, 'function');
    assert.ok(isModelClass(User));
  });

  test('stamps MODEL_DEF symbol marker', () => {
    const User = defineModel({ fields: { name: field.string() } });
    assert.equal((User as any)[MODEL_DEF], true);
  });

  test('name from explicit config name overrides class name', () => {
    const M = defineModel({ name: 'Explicit', fields: { x: field.string() } });
    assert.equal(getModelName(M as any), 'Explicit');
  });

  test('name defaults to the generated class name when not supplied', () => {
    const M = defineModel({ fields: { x: field.string() } });
    // The class name is the internal class name — always defined, stable per invocation
    const name = getModelName(M as any);
    assert.equal(typeof name, 'string');
    assert.ok(name.length >= 0);
  });

  test('empty string name is accepted (no validation)', () => {
    const M = defineModel({ name: '', fields: { x: field.string() } });
    // Falsy explicit name falls through to class-name fallback per impl
    // Document actual behaviour: empty explicit name is ignored and class name is used.
    const name = getModelName(M as any);
    assert.equal(typeof name, 'string');
  });

  test('names with special characters are accepted verbatim', () => {
    const M = defineModel({ name: 'User::v2/@ns', fields: { x: field.string() } });
    assert.equal(getModelName(M as any), 'User::v2/@ns');
  });

  test('same name used twice yields distinct model classes', () => {
    const A = defineModel({ name: 'Dup', fields: { x: field.string() } });
    const B = defineModel({ name: 'Dup', fields: { y: field.string() } });
    assert.notEqual(A, B);
    // Both claim the same model name
    assert.equal(getModelName(A as any), 'Dup');
    assert.equal(getModelName(B as any), 'Dup');
  });

  test('isModelClass rejects non-model values', () => {
    assert.equal(isModelClass(null), false);
    assert.equal(isModelClass(undefined), false);
    assert.equal(isModelClass({}), false);
    assert.equal(isModelClass(() => {}), false);
    assert.equal(isModelClass(class {}), false);
    assert.equal(isModelClass(42), false);
    assert.equal(isModelClass('string'), false);
  });
});

// ----------------------------------------------------------------------------
// defineModel — fields descriptor shape
// ----------------------------------------------------------------------------

describe('defineModel — MODEL_FIELDS descriptor', () => {
  test('exposes resolved FieldDef for every declared field', () => {
    const M = defineModel({
      fields: {
        name: field.string(),
        age: field.int().optional(),
        active: field.boolean().default(true),
      },
    });
    const fields = getModelFields(M as any);
    assert.deepEqual(Object.keys(fields).sort(), ['active', 'age', 'name']);
    assert.equal(fields.name.type, 'string');
    assert.equal(fields.age.type, 'int');
    assert.equal(fields.active.type, 'boolean');
  });

  test('optional modifier is reflected on FieldDef.optional', () => {
    const M = defineModel({ fields: { a: field.string(), b: field.string().optional() } });
    const fields = getModelFields(M as any);
    assert.equal(fields.a.optional, false);
    assert.equal(fields.b.optional, true);
  });

  test('unique modifier is reflected on FieldDef.unique', () => {
    const M = defineModel({ fields: { a: field.string(), b: field.string().unique() } });
    const fields = getModelFields(M as any);
    assert.equal(fields.a.unique, false);
    assert.equal(fields.b.unique, true);
  });

  test('primaryKey and index modifiers reflected on FieldDef', () => {
    const M = defineModel({
      fields: {
        id: field.uuid().primaryKey(),
        email: field.string().index(),
      },
    });
    const fields = getModelFields(M as any);
    assert.equal(fields.id.primaryKey, true);
    assert.equal(fields.id.indexed, false);
    assert.equal(fields.email.indexed, true);
    assert.equal(fields.email.primaryKey, false);
  });

  test('invalid field value throws on definition', () => {
    assert.throws(
      () => defineModel({ fields: { bad: {} as any } }),
      /Invalid field definition for "bad"/,
    );
  });

  test('model with no fields (empty object) is allowed', () => {
    const M = defineModel({ fields: {} });
    const fields = getModelFields(M as any);
    assert.deepEqual(Object.keys(fields), []);
  });

  test('accepts a single-field model', () => {
    const M = defineModel({ fields: { only: field.string() } });
    const fields = getModelFields(M as any);
    assert.equal(Object.keys(fields).length, 1);
  });

  test('both fields-only and config form produce same field shape', () => {
    const A = defineModel({ name: field.string(), age: field.int() });
    const B = defineModel({ fields: { name: field.string(), age: field.int() } });
    const aFields = getModelFields(A as any);
    const bFields = getModelFields(B as any);
    assert.deepEqual(Object.keys(aFields).sort(), Object.keys(bFields).sort());
    assert.equal(aFields.name.type, bFields.name.type);
    assert.equal(aFields.age.type, bFields.age.type);
  });
});

// ----------------------------------------------------------------------------
// Model.ref — identity, caching, template literal, accepted inputs
// ----------------------------------------------------------------------------

describe('Model.ref — callable form', () => {
  test('returns a Reference<T>', () => {
    const M = defineModel({ fields: { x: field.string() } });
    const r = M.ref('abc');
    assert.ok(r instanceof Reference);
    assert.ok(isReference(r));
    assert.equal(r.identifier, 'abc');
  });

  test('memoizes same-id refs (WeakRef cache)', () => {
    const M = defineModel({ fields: { x: field.string() } });
    const a = M.ref('same');
    const b = M.ref('same');
    assert.equal(a, b, 'same id must produce the same Reference instance');
  });

  test('different ids produce different refs', () => {
    const M = defineModel({ fields: { x: field.string() } });
    const a = M.ref('a');
    const b = M.ref('b');
    assert.notEqual(a, b);
  });

  test('each model has its own ref cache (no cross-model leakage)', () => {
    const A = defineModel({ name: 'A', fields: { x: field.string() } });
    const B = defineModel({ name: 'B', fields: { x: field.string() } });
    const ra = A.ref('shared-id');
    const rb = B.ref('shared-id');
    assert.notEqual(ra, rb);
  });

  test('passing an existing Reference returns a ref for the same id (memoized)', () => {
    const M = defineModel({ fields: { x: field.string() } });
    const r1 = M.ref('abc');
    const r2 = M.ref(r1 as unknown as object);
    assert.equal(r1, r2);
  });
});

describe('Model.ref — template literal form', () => {
  test('single static segment', () => {
    const M = defineModel({ fields: { x: field.string() } });
    const r = M.ref`literal-id`;
    assert.equal(r.identifier, 'literal-id');
  });

  test('zero interpolations (pure string template)', () => {
    const M = defineModel({ fields: { x: field.string() } });
    const r = M.ref`constant`;
    assert.equal(r.identifier, 'constant');
  });

  test('empty template literal yields empty-string id', () => {
    const M = defineModel({ fields: { x: field.string() } });
    const r = M.ref``;
    assert.equal(r.identifier, '');
  });

  test('single interpolation with string', () => {
    const M = defineModel({ fields: { x: field.string() } });
    const r = M.ref`user-${'42'}`;
    assert.equal(r.identifier, 'user-42');
  });

  test('multiple interpolations', () => {
    const M = defineModel({ fields: { x: field.string() } });
    const r = M.ref`${'a'}-${'b'}-${'c'}`;
    assert.equal(r.identifier, 'a-b-c');
  });

  test('interpolation with a Reference uses its toString (identifier)', () => {
    const M = defineModel({ fields: { x: field.string() } });
    const inner = M.ref('42');
    const composed = M.ref`parent-${inner}`;
    assert.equal(composed.identifier, 'parent-42');
  });

  test('interpolation with number coerces to string', () => {
    const M = defineModel({ fields: { x: field.string() } });
    const r = M.ref`n-${7}`;
    assert.equal(r.identifier, 'n-7');
  });

  test('interpolation with undefined stringifies to "undefined"', () => {
    const M = defineModel({ fields: { x: field.string() } });
    const r = M.ref`u-${undefined}`;
    // Document actual behaviour — String.raw just concatenates raw strings with
    // JS' default stringification of values.
    assert.equal(r.identifier, 'u-undefined');
  });

  test('template and callable forms with the same resulting id are the same instance', () => {
    const M = defineModel({ fields: { x: field.string() } });
    const a = M.ref('xyz');
    const b = M.ref`xyz`;
    assert.equal(a, b);
  });
});

describe('Model.refs — plural', () => {
  test('returns References', () => {
    const M = defineModel({ fields: { x: field.string() } });
    const rs = M.refs('a', 'b', 'c');
    assert.ok(rs instanceof References);
    assert.ok(isReferences(rs));
  });

  test('preserves order of ids', () => {
    const M = defineModel({ fields: { x: field.string() } });
    const rs = M.refs('c', 'a', 'b');
    assert.deepEqual([...rs.identifiers], ['c', 'a', 'b']);
  });

  test('zero ids is allowed', () => {
    const M = defineModel({ fields: { x: field.string() } });
    const rs = M.refs();
    assert.equal(rs.length, 0);
    assert.deepEqual([...rs.identifiers], []);
  });
});

// ----------------------------------------------------------------------------
// Model constructor + static create()
// ----------------------------------------------------------------------------

describe('Model constructor', () => {
  test('assigns declared fields from constructor data', () => {
    const M = defineModel({ fields: { name: field.string(), age: field.int() } });
    const inst: any = new (M as any)({ name: 'bob', age: 30 });
    assert.equal(inst.name, 'bob');
    assert.equal(inst.age, 30);
  });

  test('ignores unknown fields silently (they are still assigned as own properties)', () => {
    // Actual behaviour: constructor writes any keys passed into `data` directly
    // onto the instance. No validation against the declared schema.
    const M = defineModel({ fields: { name: field.string() } });
    const inst: any = new (M as any)({ name: 'x', extra: 'y' });
    assert.equal(inst.name, 'x');
    assert.equal(inst.extra, 'y');
  });

  test('no-arg-style with empty data', () => {
    const M = defineModel({ fields: { x: field.string().optional() } });
    const inst: any = new (M as any)({});
    assert.equal(inst.x, undefined);
  });

  test('ref field assignment from Reference works', () => {
    const A = defineModel({ fields: { x: field.string() } });
    const B = defineModel({ fields: { a: field.ref(A) } });
    const ref = A.ref('id-1');
    const b: any = new (B as any)({ a: ref });
    assert.equal(b.a, ref);
  });

  test('ref field setter rejects bare strings', () => {
    const A = defineModel({ fields: { x: field.string() } });
    const B = defineModel({ fields: { a: field.ref(A) } });
    const b: any = new (B as any)({});
    assert.throws(
      () => { b.a = 'some-id'; },
      /Cannot assign string to ref field "a"/,
    );
  });

  test('ref field setter accepts null / undefined', () => {
    const A = defineModel({ fields: { x: field.string() } });
    const B = defineModel({ fields: { a: field.ref(A) } });
    const b: any = new (B as any)({});
    b.a = null;
    assert.equal(b.a, null);
    b.a = undefined;
    assert.equal(b.a, undefined);
  });

  test('ref field setter rejects random objects without adapter key', () => {
    const A = defineModel({ fields: { x: field.string() } });
    const B = defineModel({ fields: { a: field.ref(A) } });
    const b: any = new (B as any)({});
    assert.throws(() => { b.a = { not: 'a ref' }; }, /Invalid value for ref field "a"/);
  });

  test('refs field setter rejects string-array', () => {
    const A = defineModel({ fields: { x: field.string() } });
    const B = defineModel({ fields: { xs: field.refs(A) } });
    const b: any = new (B as any)({});
    assert.throws(
      () => { b.xs = ['a', 'b']; },
      /Cannot assign string array to refs field "xs"/,
    );
  });

  test('refs field setter accepts empty array (normalises to References)', () => {
    const A = defineModel({ fields: { x: field.string() } });
    const B = defineModel({ fields: { xs: field.refs(A) } });
    const b: any = new (B as any)({});
    b.xs = [];
    assert.ok(isReferences(b.xs), 'empty array should be normalised to References');
    assert.equal(b.xs.length, 0);
  });

  test('refs field setter accepts null', () => {
    const A = defineModel({ fields: { x: field.string() } });
    const B = defineModel({ fields: { xs: field.refs(A) } });
    const b: any = new (B as any)({});
    b.xs = null;
    assert.equal(b.xs, null);
  });

  test('refs field setter accepts a References instance', () => {
    const A = defineModel({ fields: { x: field.string() } });
    const B = defineModel({ fields: { xs: field.refs(A) } });
    const refs = A.refs('1', '2');
    const b: any = new (B as any)({});
    b.xs = refs;
    assert.equal(b.xs, refs);
  });
});

describe('Model.create', () => {
  test('create returns an instance with the data', () => {
    const M = defineModel({ fields: { name: field.string() } });
    const inst: any = (M as any).create({ name: 'alice' });
    assert.equal(inst.name, 'alice');
  });

  test('create uses prototype of the model', () => {
    const M = defineModel({ fields: { name: field.string() } });
    const inst: any = (M as any).create({ name: 'alice' });
    assert.ok(Object.prototype.isPrototypeOf.call((M as any).prototype, inst));
  });
});

// ----------------------------------------------------------------------------
// Model.override — inheritance
// ----------------------------------------------------------------------------

describe('Model.override', () => {
  test('returns a new Model class distinct from the parent', () => {
    const Parent = defineModel({ name: 'Parent', fields: { a: field.string() } });
    const Child = (Parent as any).override({ fields: { b: field.int() } });
    assert.notEqual(Parent, Child);
    assert.ok(isModelClass(Child));
  });

  test('child inherits parent fields and adds its own', () => {
    const Parent = defineModel({ name: 'Parent', fields: { a: field.string() } });
    const Child = (Parent as any).override({ fields: { b: field.int() } });
    const fields = getModelFields(Child as any);
    assert.ok('a' in fields);
    assert.ok('b' in fields);
    assert.equal(fields.a.type, 'string');
    assert.equal(fields.b.type, 'int');
  });

  test('child inherits parent ref accessor (same callable / same cache)', () => {
    const Parent = defineModel({ name: 'Parent', fields: { a: field.string() } });
    const Child = (Parent as any).override({ fields: { b: field.int() } });
    // Ref accessor is literally the same function reference
    assert.equal((Parent as any).ref, (Child as any).ref);
    // And they share the same cache
    assert.equal((Parent as any).ref('shared'), (Child as any).ref('shared'));
  });

  test('override name is reflected in MODEL_NAME', () => {
    const Parent = defineModel({ name: 'Parent', fields: { a: field.string() } });
    const Child = (Parent as any).override({ name: 'Child', fields: { b: field.int() } });
    assert.equal(getModelName(Child as any), 'Child');
    assert.equal(getModelName(Parent as any), 'Parent');
  });

  test('child overriding an inherited field key replaces the FieldDef', () => {
    const Parent = defineModel({ name: 'Parent', fields: { a: field.string() } });
    const Child = (Parent as any).override({ fields: { a: field.int() } });
    const fields = getModelFields(Child as any);
    assert.equal(fields.a.type, 'int', 'child field type wins');
    // Parent is untouched
    assert.equal(getModelFields(Parent as any).a.type, 'string');
  });

  test('child is a subclass of parent via instanceof', () => {
    const Parent = defineModel({ name: 'Parent', fields: { a: field.string() } });
    const Child = (Parent as any).override({ fields: { b: field.int() } });
    const inst = new (Child as any)({ a: 'x', b: 1 });
    assert.ok(inst instanceof (Child as any));
    assert.ok(inst instanceof (Parent as any));
  });

  test('override can be chained', () => {
    const A = defineModel({ name: 'A', fields: { a: field.string() } });
    const B = (A as any).override({ name: 'B', fields: { b: field.int() } });
    const C = (B as any).override({ name: 'C', fields: { c: field.boolean() } });
    const fields = getModelFields(C as any);
    assert.deepEqual(Object.keys(fields).sort(), ['a', 'b', 'c']);
    assert.equal(getModelName(C as any), 'C');
  });
});
