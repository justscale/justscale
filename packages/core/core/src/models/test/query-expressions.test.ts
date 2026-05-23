import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  defineModel,
  field,
  q,
  isCondition,
  isAggregation,
  CONDITION,
  AGGREGATION,
  isOrderByItem,
  StringFieldExpr,
  NumberFieldExpr,
  BigIntFieldExpr,
  DecimalFieldExpr,
  BooleanFieldExpr,
  TimestampFieldExpr,
  UuidFieldExpr,
  EnumFieldExpr,
  RefFieldExpr,
  RefsFieldExpr,
  ArrayFieldExpr,
  JsonFieldExpr,
  ObjectFieldExpr,
  createFieldExpr,
  refId,
  isRefTraversal,
  Reference,
  ADAPTER_KEY,
} from '../index.js';

// ----------------------------------------------------------------------------
// Model setup — all field types represented
// ----------------------------------------------------------------------------

const User = defineModel({
  name: 'User',
  fields: { id: field.uuid().primaryKey(), email: field.string().unique() },
});

const Post = defineModel({
  name: 'Post',
  fields: {
    title: field.string().max(255),
    views: field.int(),
    big: field.bigint(),
    score: field.decimal(10, 2),
    active: field.boolean(),
    created: field.timestamp(),
    id: field.uuid(),
    status: field.enum('Status', ['draft', 'published'] as const),
    author: field.ref(User),
    editors: field.refs(User),
    tags: field.array(field.string()),
    meta: field.json<{ pinned?: boolean }>(),
    settings: field.object({ theme: field.string(), nested: field.object({ v: field.int() }) }),
  },
});

// ----------------------------------------------------------------------------
// Field expression class dispatch
// ----------------------------------------------------------------------------

describe('Model.fields expression classes', () => {
  test('string field yields StringFieldExpr', () => {
    assert.ok(Post.fields.title instanceof StringFieldExpr);
  });

  test('int field yields NumberFieldExpr', () => {
    assert.ok(Post.fields.views instanceof NumberFieldExpr);
  });

  test('bigint field yields BigIntFieldExpr', () => {
    assert.ok(Post.fields.big instanceof BigIntFieldExpr);
  });

  test('decimal field yields DecimalFieldExpr', () => {
    assert.ok(Post.fields.score instanceof DecimalFieldExpr);
  });

  test('boolean field yields BooleanFieldExpr', () => {
    assert.ok(Post.fields.active instanceof BooleanFieldExpr);
  });

  test('timestamp field yields TimestampFieldExpr', () => {
    assert.ok(Post.fields.created instanceof TimestampFieldExpr);
  });

  test('uuid field yields UuidFieldExpr', () => {
    assert.ok(Post.fields.id instanceof UuidFieldExpr);
  });

  test('enum field yields EnumFieldExpr', () => {
    assert.ok(Post.fields.status instanceof EnumFieldExpr);
  });

  test('ref field yields RefFieldExpr', () => {
    assert.ok(Post.fields.author instanceof RefFieldExpr);
  });

  test('refs field yields RefsFieldExpr', () => {
    assert.ok(Post.fields.editors instanceof RefsFieldExpr);
  });

  test('array field yields ArrayFieldExpr', () => {
    assert.ok(Post.fields.tags instanceof ArrayFieldExpr);
  });

  test('json field yields JsonFieldExpr', () => {
    assert.ok(Post.fields.meta instanceof JsonFieldExpr);
  });

  test('object field yields an ObjectFieldExpr (wrapped in a Proxy)', () => {
    // The Proxy wrapper means `instanceof` can still work since Proxy preserves
    // prototype chain when `target` is the ObjectFieldExpr.
    assert.ok(Post.fields.settings instanceof ObjectFieldExpr);
  });
});

// ----------------------------------------------------------------------------
// Comparator coverage — every condition method
// ----------------------------------------------------------------------------

describe('StringFieldExpr comparators', () => {
  test('eq produces an EqCondition tagged with the field', () => {
    const c: any = Post.fields.title.eq('hello');
    assert.equal(c[CONDITION], true);
    assert.equal(c.type, 'eq');
    assert.equal(c.field, 'title');
    assert.equal(c.value, 'hello');
    assert.equal(isCondition(c), true);
  });

  test('neq', () => {
    const c: any = Post.fields.title.neq('x');
    assert.equal(c.type, 'neq');
  });

  test('like', () => {
    const c: any = Post.fields.title.like('hello%');
    assert.equal(c.type, 'like');
    assert.equal(c.pattern, 'hello%');
  });

  test('ilike', () => {
    const c: any = Post.fields.title.ilike('HELLO%');
    assert.equal(c.type, 'ilike');
  });

  test('startsWith / endsWith / contains', () => {
    assert.equal((Post.fields.title.startsWith('a') as any).type, 'startsWith');
    assert.equal((Post.fields.title.endsWith('b') as any).type, 'endsWith');
    assert.equal((Post.fields.title.contains('c') as any).type, 'contains');
  });

  test('in / notIn', () => {
    assert.equal((Post.fields.title.in(['a', 'b']) as any).type, 'in');
    assert.equal((Post.fields.title.notIn(['a']) as any).type, 'notIn');
  });

  test('isNull / isNotNull', () => {
    assert.equal((Post.fields.title.isNull() as any).type, 'isNull');
    assert.equal((Post.fields.title.isNotNull() as any).type, 'isNotNull');
  });
});

describe('NumberFieldExpr comparators', () => {
  test('eq / neq / gt / gte / lt / lte / between', () => {
    const f = Post.fields.views;
    assert.equal((f.eq(1) as any).type, 'eq');
    assert.equal((f.neq(1) as any).type, 'neq');
    assert.equal((f.gt(1) as any).type, 'gt');
    assert.equal((f.gte(1) as any).type, 'gte');
    assert.equal((f.lt(1) as any).type, 'lt');
    assert.equal((f.lte(1) as any).type, 'lte');
    const between = f.between(1, 10) as any;
    assert.equal(between.type, 'between');
    assert.equal(between.min, 1);
    assert.equal(between.max, 10);
  });

  test('in / notIn', () => {
    const f = Post.fields.views;
    assert.deepEqual((f.in([1, 2]) as any).values, [1, 2]);
    assert.deepEqual((f.notIn([3]) as any).values, [3]);
  });
});

describe('BigIntFieldExpr comparators', () => {
  test('eq / gt / between', () => {
    const f = Post.fields.big;
    assert.equal((f.eq(1n) as any).type, 'eq');
    assert.equal((f.gt(1n) as any).type, 'gt');
    const b = f.between(1n, 2n) as any;
    assert.equal(b.type, 'between');
    assert.equal(b.min, 1n);
    assert.equal(b.max, 2n);
  });
});

describe('DecimalFieldExpr comparators', () => {
  test('eq / gt / between — type and runtime agree (both DecimalFieldExpr)', () => {
    // Decimal fields are branded so ValueToFieldExpr routes them to
    // DecimalFieldExpr directly — no cast needed.
    const f = Post.fields.score;
    assert.equal((f.eq('1.00') as any).type, 'eq');
    assert.equal((f.gt('0.50') as any).type, 'gt');
    assert.equal((f.between('0.00', '9.99') as any).type, 'between');
  });
});

describe('BooleanFieldExpr', () => {
  test('eq / isTrue / isFalse produce eq conditions', () => {
    const f = Post.fields.active;
    assert.equal((f.eq(true) as any).value, true);
    assert.equal((f.isTrue() as any).value, true);
    assert.equal((f.isFalse() as any).value, false);
  });

  test('in / notIn', () => {
    const f = Post.fields.active;
    assert.deepEqual((f.in([true, false]) as any).values, [true, false]);
    assert.deepEqual((f.notIn([false]) as any).values, [false]);
  });
});

describe('TimestampFieldExpr', () => {
  test('before / after / between', () => {
    const f = Post.fields.created;
    const d1 = new Date('2024-01-01');
    const d2 = new Date('2024-02-01');
    assert.equal((f.before(d1) as any).type, 'before');
    assert.equal((f.after(d1) as any).type, 'after');
    const b = f.between(d1, d2) as any;
    assert.equal(b.type, 'between');
    assert.equal(b.min, d1);
    assert.equal(b.max, d2);
  });

  test('gt / gte / lt / lte use the eq-family types', () => {
    const f = Post.fields.created;
    const d = new Date();
    assert.equal((f.gt(d) as any).type, 'gt');
    assert.equal((f.gte(d) as any).type, 'gte');
    assert.equal((f.lt(d) as any).type, 'lt');
    assert.equal((f.lte(d) as any).type, 'lte');
  });
});

describe('EnumFieldExpr', () => {
  test('eq / neq / in / notIn', () => {
    const f = Post.fields.status;
    assert.equal((f.eq('draft') as any).type, 'eq');
    assert.equal((f.neq('published') as any).type, 'neq');
    assert.deepEqual((f.in(['draft', 'published']) as any).values, ['draft', 'published']);
  });
});

describe('UuidFieldExpr', () => {
  test('eq / in', () => {
    const f = Post.fields.id;
    const c = f.eq('00000000-0000-0000-0000-000000000000') as any;
    assert.equal(c.type, 'eq');
    assert.deepEqual((f.in(['a', 'b']) as any).values, ['a', 'b']);
  });
});

describe('RefFieldExpr', () => {
  test('eq accepts a Reference and extracts the identifier', () => {
    const ref = User.ref('user-1');
    const c: any = Post.fields.author.eq(ref);
    assert.equal(c.type, 'eq');
    assert.equal(c.value, 'user-1');
  });

  test('eq accepts a bare string identifier', () => {
    const c: any = Post.fields.author.eq('user-2');
    assert.equal(c.value, 'user-2');
  });

  test('in maps a mix of references and strings to ids', () => {
    const c: any = Post.fields.author.in([User.ref('a'), 'b', User.ref('c')]);
    assert.equal(c.type, 'in');
    assert.deepEqual(c.values, ['a', 'b', 'c']);
  });

  test('has(condition) produces a HasCondition', () => {
    const c: any = Post.fields.author.has(User.fields.email.eq('x@y'));
    assert.equal(c.type, 'has');
    assert.equal(c.field, 'author');
    assert.equal(c.condition.type, 'eq');
  });

  test('has(refFieldExpr) returns a RefTraversal — multi-hop', () => {
    // Build a model with a ref field so we can chain a ref-hop.
    const Team = defineModel({ name: 'Team', fields: { x: field.string() } });
    const Member = defineModel({ name: 'Member', fields: { team: field.ref(Team) } });
    const Org = defineModel({ name: 'Org', fields: { owner: field.ref(Member) } });
    const t = Org.fields.owner.has(Member.fields.team as any);
    assert.equal(isRefTraversal(t), true);
    assert.deepEqual((t as any).path, ['owner', 'team']);
    // Chain another hop
    const t2 = (t as any).has(Team.fields.x);
    // extending by a non-ref field key still works at the traversal level
    // (the traversal.has accepts RefFieldExpr in the type, but the runtime just
    // reads fieldKey — document actual behaviour)
    assert.deepEqual(t2.path, ['owner', 'team', 'x']);
  });

  test('where(condition) is an alias for has', () => {
    const c: any = Post.fields.author.where(User.fields.email.eq('z'));
    assert.equal(c.type, 'has');
  });
});

describe('RefsFieldExpr', () => {
  test('hasAny produces an InCondition with extracted ids', () => {
    const c: any = Post.fields.editors.hasAny([User.ref('a'), 'b']);
    assert.equal(c.type, 'in');
    assert.deepEqual(c.values, ['a', 'b']);
  });

  test('hasAll produces an AND of eq conditions', () => {
    const c: any = Post.fields.editors.hasAll([User.ref('a'), 'b']);
    assert.equal(c.type, 'and');
    assert.equal(c.conditions.length, 2);
    assert.equal(c.conditions[0].type, 'eq');
    assert.deepEqual(c.conditions.map((x: any) => x.value), ['a', 'b']);
  });

  test('has(condition) generates a HasCondition', () => {
    const c: any = Post.fields.editors.has(User.fields.email.eq('a@b'));
    assert.equal(c.type, 'has');
    assert.equal(c.field, 'editors');
  });
});

describe('ArrayFieldExpr', () => {
  test('contains / hasAny / hasAll / overlaps', () => {
    const f = Post.fields.tags;
    assert.equal((f.contains('a') as any).type, 'arrayContains');
    assert.equal((f.hasAny(['a', 'b']) as any).type, 'arrayHasAny');
    assert.equal((f.hasAll(['a', 'b']) as any).type, 'arrayHasAll');
    assert.equal((f.overlaps(['a']) as any).type, 'arrayOverlaps');
  });
});

describe('JsonFieldExpr', () => {
  test('eq / contains (contains stringifies the value)', () => {
    const f = Post.fields.meta;
    const c: any = f.eq({ pinned: true });
    assert.equal(c.type, 'eq');
    assert.deepEqual(c.value, { pinned: true });
    const c2: any = f.contains({ pinned: true });
    assert.equal(c2.type, 'contains');
    assert.equal(c2.substring, JSON.stringify({ pinned: true }));
  });
});

describe('ObjectFieldExpr (Proxy-wrapped)', () => {
  test('own eq produces a condition on the object field itself', () => {
    const s = Post.fields.settings as any;
    const c = s.eq({ theme: 'dark', nested: { v: 1 } });
    assert.equal(c.type, 'eq');
    assert.equal(c.field, 'settings');
  });

  test('nested property access produces a dotted-path field expression', () => {
    const nested = (Post.fields.settings as any).theme;
    const c = nested.eq('dark');
    assert.equal(c.field, 'settings.theme');
  });

  test('deeply nested property access', () => {
    const deep = (Post.fields.settings as any).nested.v;
    const c = deep.eq(1);
    assert.equal(c.field, 'settings.nested.v');
  });

  test('unknown nested key returns undefined (no throw)', () => {
    const bogus = (Post.fields.settings as any).doesNotExist;
    assert.equal(bogus, undefined);
  });
});

// ----------------------------------------------------------------------------
// OrderBy helpers
// ----------------------------------------------------------------------------

describe('order-by helpers', () => {
  test('asc() returns an OrderByItem', () => {
    const o: any = Post.fields.title.asc();
    assert.equal(isOrderByItem(o), true);
    assert.equal(o.direction, 'asc');
    assert.equal(o.field, 'title');
    assert.equal(o.nulls, undefined);
  });

  test('desc() with nulls first', () => {
    const o: any = Post.fields.title.desc('first');
    assert.equal(o.direction, 'desc');
    assert.equal(o.nulls, 'first');
  });

  test('isOrderByItem false for non-order-by values', () => {
    assert.equal(isOrderByItem(null), false);
    assert.equal(isOrderByItem({ field: 'a', direction: 'asc' }), false);
  });
});

// ----------------------------------------------------------------------------
// q helpers — and / or / not / aggregations / raw
// ----------------------------------------------------------------------------

describe('q.and / q.or / q.not', () => {
  test('q.and wraps conditions', () => {
    const a = Post.fields.title.eq('a');
    const b = Post.fields.views.gt(1);
    const c: any = q.and(a, b);
    assert.equal(c.type, 'and');
    assert.equal(c.conditions.length, 2);
  });

  test('q.and with zero args yields empty and-condition (match-all)', () => {
    const c: any = q.and();
    assert.equal(c.type, 'and');
    assert.deepEqual(c.conditions, []);
  });

  test('q.or with zero args yields empty or-condition (match-nothing)', () => {
    const c: any = q.or();
    assert.equal(c.type, 'or');
    assert.deepEqual(c.conditions, []);
  });

  test('q.not wraps a single condition', () => {
    const inner = Post.fields.title.eq('a');
    const c: any = q.not(inner);
    assert.equal(c.type, 'not');
    assert.equal(c.condition, inner);
  });

  test('deep nesting q.and(q.or(..), q.not(..))', () => {
    const a = Post.fields.title.eq('a');
    const b = Post.fields.title.eq('b');
    const c = Post.fields.views.gt(0);
    const compound: any = q.and(q.or(a, b), q.not(c));
    assert.equal(compound.type, 'and');
    assert.equal(compound.conditions[0].type, 'or');
    assert.equal(compound.conditions[1].type, 'not');
    assert.equal(compound.conditions[0].conditions.length, 2);
  });
});

describe('q aggregations', () => {
  test('q.count() (no field) is a countable aggregation', () => {
    const c = q.count();
    assert.equal((c as any)[AGGREGATION], true);
    assert.equal(isAggregation(c), true);
    assert.equal(c.type, 'count');
    assert.equal(c.field, undefined);
  });

  test('q.count(field) captures the field name', () => {
    const c = q.count(Post.fields.title);
    assert.equal(c.field, 'title');
  });

  test('q.count(field).distinct() sets distinct=true', () => {
    const c = q.count(Post.fields.title).distinct();
    assert.equal(c.distinct, true);
  });

  test('q.sum captures field name', () => {
    const s = q.sum(Post.fields.views);
    assert.equal(s.type, 'sum');
    assert.equal(s.field, 'views');
  });

  test('q.avg captures field name', () => {
    const a = q.avg(Post.fields.score);
    assert.equal(a.type, 'avg');
    assert.equal(a.field, 'score');
  });

  test('q.min / q.max work on any FieldExprBase subclass', () => {
    assert.equal(q.min(Post.fields.views).type, 'min');
    assert.equal(q.max(Post.fields.created).type, 'max');
  });
});

describe('q.raw', () => {
  test('builds a raw condition with sql and values', () => {
    const c: any = q.raw('field = ?', 1);
    assert.equal(c.type, 'raw');
    assert.equal(c.sql, 'field = ?');
    assert.deepEqual(c.values, [1]);
    assert.equal(isCondition(c), true);
  });

  test('raw with no values still captures sql', () => {
    const c: any = q.raw('1 = 1');
    assert.deepEqual(c.values, []);
  });
});

// ----------------------------------------------------------------------------
// Condition / Aggregation symbol guards
// ----------------------------------------------------------------------------

describe('isCondition / isAggregation', () => {
  test('isCondition false for non-conditions', () => {
    assert.equal(isCondition(null), false);
    assert.equal(isCondition(undefined), false);
    assert.equal(isCondition({ type: 'eq', field: 'x', value: 1 }), false);
  });

  test('isAggregation false for non-aggregations', () => {
    assert.equal(isAggregation(null), false);
    assert.equal(isAggregation({ type: 'count' }), false);
  });

  test('condition made by q is tagged and detectable', () => {
    const c = q.and();
    assert.equal(isCondition(c), true);
  });

  test('aggregation made by q is tagged and detectable', () => {
    const a = q.count();
    assert.equal(isAggregation(a), true);
  });
});

// ----------------------------------------------------------------------------
// refId helper
// ----------------------------------------------------------------------------

describe('refId helper', () => {
  test('extracts id from a plain string', () => {
    assert.equal(refId('abc'), 'abc');
  });

  test('extracts identifier from a Reference', () => {
    const r = User.ref('user-1');
    assert.equal(refId(r), 'user-1');
  });

  test('throws for values without adapter key / reference marker', () => {
    assert.throws(() => refId({ random: 'object' }), /Cannot extract key/);
  });

  test('extracts adapter key from an object with the ADAPTER_KEY symbol', () => {
    const obj: any = { [ADAPTER_KEY]: 'key-7' };
    assert.equal(refId(obj), 'key-7');
  });
});

// ----------------------------------------------------------------------------
// createFieldExpr — fallback behaviour for unusual types
// ----------------------------------------------------------------------------

describe('createFieldExpr fallback behaviour', () => {
  test('time / duration / bytes fall back to a string-like expression', () => {
    const timeExpr = createFieldExpr('t', field.time().build());
    const durExpr = createFieldExpr('d', field.duration().build());
    const bytesExpr = createFieldExpr('b', field.bytes().build());
    // All three should be StringFieldExpr per the fallback branch
    assert.ok(timeExpr instanceof StringFieldExpr);
    assert.ok(durExpr instanceof StringFieldExpr);
    assert.ok(bytesExpr instanceof StringFieldExpr);
  });

  test('object field without objectShape falls back to JsonFieldExpr', () => {
    // Craft a FieldDef object manually — simulating a broken/under-specified def
    const fakeDef = {
      ...field.json().build(),
      type: 'object' as const,
      objectShape: undefined as any,
    };
    const expr = createFieldExpr('x', fakeDef as any);
    assert.ok(expr instanceof JsonFieldExpr);
  });
});
