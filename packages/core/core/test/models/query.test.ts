/**
 * Tests for query system - field expressions, conditions, and aggregations
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';

import {
  defineModel,
  field,
  q,
  StringFieldExpr,
  NumberFieldExpr,
  TimestampFieldExpr,
  BooleanFieldExpr,
  RefFieldExpr,
  ArrayFieldExpr,
  ObjectFieldExpr,
  isCondition,
  type Condition,
} from '../../src/models/index.js';

// =============================================================================
// Field Expression Tests
// =============================================================================

describe('Field Expressions', () => {
  class Post extends defineModel({
    title: field.string().max(255),
    status: field.enum('PostStatus', ['draft', 'published', 'archived'] as const),
    views: field.int(),
    rating: field.decimal(3, 2),
    published: field.boolean(),
    createdAt: field.createdAt(),
    deletedAt: field.deletedAt(),
  }) {}

  test('should expose field expressions via Model.fields', () => {
    const { title, status, views, published, createdAt } = Post.fields;

    assert.ok(title instanceof StringFieldExpr);
    assert.ok(views instanceof NumberFieldExpr);
    assert.ok(published instanceof BooleanFieldExpr);
    assert.ok(createdAt instanceof TimestampFieldExpr);
  });

  test('StringFieldExpr.eq() returns Condition', () => {
    const { title } = Post.fields;
    const condition = title.eq('Hello World');

    assert.ok(isCondition(condition));
    assert.strictEqual(condition.type, 'eq');
    assert.strictEqual(condition.field, 'title');
    assert.strictEqual(condition.value, 'Hello World');
  });

  test('StringFieldExpr has all string methods', () => {
    const { title } = Post.fields;

    // eq, neq
    assert.strictEqual(title.eq('foo').type, 'eq');
    assert.strictEqual(title.neq('foo').type, 'neq');

    // like patterns
    assert.strictEqual(title.like('%hello%').type, 'like');
    assert.strictEqual(title.ilike('%HELLO%').type, 'ilike');
    assert.strictEqual(title.startsWith('Hello').type, 'startsWith');
    assert.strictEqual(title.endsWith('World').type, 'endsWith');
    assert.strictEqual(title.contains('middle').type, 'contains');

    // in/notIn
    assert.strictEqual(title.in(['a', 'b']).type, 'in');
    assert.strictEqual(title.notIn(['x', 'y']).type, 'notIn');

    // null checks
    assert.strictEqual(title.isNull().type, 'isNull');
    assert.strictEqual(title.isNotNull().type, 'isNotNull');
  });

  test('NumberFieldExpr has comparison methods', () => {
    const { views } = Post.fields;

    assert.strictEqual(views.eq(100).type, 'eq');
    assert.strictEqual(views.neq(0).type, 'neq');
    assert.strictEqual(views.gt(50).type, 'gt');
    assert.strictEqual(views.gte(50).type, 'gte');
    assert.strictEqual(views.lt(1000).type, 'lt');
    assert.strictEqual(views.lte(1000).type, 'lte');
    assert.strictEqual(views.between(10, 100).type, 'between');
    assert.strictEqual(views.in([1, 2, 3]).type, 'in');
  });

  test('TimestampFieldExpr has date methods', () => {
    const { createdAt } = Post.fields;
    const date = new Date();

    assert.strictEqual(createdAt.eq(date).type, 'eq');
    assert.strictEqual(createdAt.before(date).type, 'before');
    assert.strictEqual(createdAt.after(date).type, 'after');
    assert.strictEqual(createdAt.between(date, date).type, 'between');
  });

  test('BooleanFieldExpr has boolean methods', () => {
    const { published } = Post.fields;

    assert.strictEqual(published.eq(true).type, 'eq');
    assert.strictEqual(published.isTrue().value, true);
    assert.strictEqual(published.isFalse().value, false);
  });

  test('q.and() combines conditions', () => {
    const { title, views } = Post.fields;
    const condition = q.and(title.eq('Hello'), views.gt(100));

    assert.ok(isCondition(condition));
    assert.strictEqual(condition.type, 'and');
    assert.strictEqual(condition.conditions.length, 2);
    assert.strictEqual(condition.conditions[0].type, 'eq');
    assert.strictEqual(condition.conditions[1].type, 'gt');
  });

  test('q.or() combines conditions', () => {
    const { status } = Post.fields;
    const condition = q.or(status.eq('draft'), status.eq('published'));

    assert.strictEqual(condition.type, 'or');
    assert.strictEqual(condition.conditions.length, 2);
  });

  test('q.not() negates condition', () => {
    const { status } = Post.fields;
    const condition = q.not(status.eq('archived'));

    assert.strictEqual(condition.type, 'not');
    assert.strictEqual(condition.condition.type, 'eq');
  });

  test('complex nested conditions', () => {
    const { title, status, views, createdAt } = Post.fields;
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const condition = q.and(
      status.eq('published'),
      q.or(title.contains('typescript'), views.gt(1000)),
      createdAt.after(lastWeek),
    );

    assert.strictEqual(condition.type, 'and');
    assert.strictEqual(condition.conditions.length, 3);
    assert.strictEqual(condition.conditions[1].type, 'or');
  });
});

// =============================================================================
// RefFieldExpr Tests
// =============================================================================

describe('RefFieldExpr', () => {
  class User extends defineModel({
    email: field.string(),
    name: field.string(),
  }) {}

  class Post extends defineModel({
    title: field.string(),
    author: field.ref(User),
  }) {}

  test('should expose RefFieldExpr for ref fields', () => {
    const { author } = Post.fields;
    assert.ok(author instanceof RefFieldExpr);
  });

  test('RefFieldExpr.eq() accepts Reference', () => {
    const { author } = Post.fields;
    const ref = User.ref`user-123`;

    const condition = author.eq(ref);
    assert.strictEqual(condition.type, 'eq');
    assert.strictEqual(condition.field, 'author');
    assert.strictEqual(condition.value, 'user-123');
  });

  test('RefFieldExpr.eq() accepts Reference', () => {
    const { author } = Post.fields;

    const condition = author.eq(User.ref('user-456'));
    assert.strictEqual(condition.value, 'user-456');
  });

  test('RefFieldExpr.eq() accepts id string', () => {
    const { author } = Post.fields;

    const condition = author.eq('user-789');
    assert.strictEqual(condition.value, 'user-789');
  });

  test('RefFieldExpr.in() accepts mixed values', () => {
    const { author } = Post.fields;
    const ref = User.ref`user-1`;

    const condition = author.in([ref, User.ref('user-2'), 'user-3']);
    assert.strictEqual(condition.type, 'in');
    assert.deepStrictEqual(condition.values, ['user-1', 'user-2', 'user-3']);
  });

  test('RefFieldExpr.has() creates HasCondition for joins', () => {
    const { author } = Post.fields;
    const condition = author.has(User.fields.email.eq('admin@example.com'));

    assert.strictEqual(condition.type, 'has');
    assert.strictEqual(condition.field, 'author');
    assert.strictEqual(condition.condition.type, 'eq');
  });
});

// =============================================================================
// ArrayFieldExpr Tests
// =============================================================================

describe('ArrayFieldExpr', () => {
  class Post extends defineModel({
    tags: field.array(field.string()),
  }) {}

  test('should expose ArrayFieldExpr for array fields', () => {
    const { tags } = Post.fields;
    assert.ok(tags instanceof ArrayFieldExpr);
  });

  test('ArrayFieldExpr.contains() creates arrayContains condition', () => {
    const { tags } = Post.fields;
    const condition = tags.contains('typescript');

    assert.ok(isCondition(condition));
    assert.strictEqual(condition.type, 'arrayContains');
    assert.strictEqual(condition.field, 'tags');
    assert.strictEqual(condition.value, 'typescript');
  });

  test('ArrayFieldExpr.hasAny() creates arrayHasAny condition', () => {
    const { tags } = Post.fields;
    const condition = tags.hasAny(['typescript', 'javascript']);

    assert.ok(isCondition(condition));
    assert.strictEqual(condition.type, 'arrayHasAny');
    assert.strictEqual(condition.field, 'tags');
    assert.deepStrictEqual(condition.values, ['typescript', 'javascript']);
  });

  test('ArrayFieldExpr.hasAll() creates arrayHasAll condition', () => {
    const { tags } = Post.fields;
    const condition = tags.hasAll(['typescript', 'node']);

    assert.ok(isCondition(condition));
    assert.strictEqual(condition.type, 'arrayHasAll');
    assert.strictEqual(condition.field, 'tags');
    assert.deepStrictEqual(condition.values, ['typescript', 'node']);
  });

  test('ArrayFieldExpr.overlaps() creates arrayOverlaps condition', () => {
    const { tags } = Post.fields;
    const condition = tags.overlaps(['typescript', 'rust', 'go']);

    assert.ok(isCondition(condition));
    assert.strictEqual(condition.type, 'arrayOverlaps');
    assert.strictEqual(condition.field, 'tags');
    assert.deepStrictEqual(condition.values, ['typescript', 'rust', 'go']);
  });
});

// =============================================================================
// ObjectFieldExpr Tests
// =============================================================================

describe('ObjectFieldExpr', () => {
  class User extends defineModel({
    email: field.string(),
    settings: field.object({
      theme: field.string(),
      darkMode: field.boolean(),
      notifications: field.object({
        email: field.boolean(),
        push: field.boolean(),
      }),
    }),
  }) {}

  test('should expose ObjectFieldExpr for object fields', () => {
    const { settings } = User.fields;
    assert.ok(settings instanceof ObjectFieldExpr);
  });

  test('ObjectFieldExpr.eq() creates eq condition', () => {
    const { settings } = User.fields;
    const value = { theme: 'dark', darkMode: true, notifications: { email: true, push: false } };
    const condition = settings.eq(value);

    assert.ok(isCondition(condition));
    assert.strictEqual(condition.type, 'eq');
    assert.strictEqual(condition.field, 'settings');
    assert.deepStrictEqual(condition.value, value);
  });

  test('ObjectFieldExpr.contains() creates contains condition', () => {
    const { settings } = User.fields;
    const condition = settings.contains({ theme: 'dark' });

    assert.ok(isCondition(condition));
    assert.strictEqual(condition.type, 'contains');
    assert.strictEqual(condition.field, 'settings');
  });

  test('nested field access via Proxy - level 1', () => {
    const { settings } = User.fields;
    const theme = settings.theme;

    assert.ok(theme instanceof StringFieldExpr);
    const condition = theme.eq('dark');

    assert.strictEqual(condition.type, 'eq');
    assert.strictEqual(condition.field, 'settings.theme');
    assert.strictEqual(condition.value, 'dark');
  });

  test('nested field access via Proxy - level 2', () => {
    const { settings } = User.fields;
    const emailNotif = settings.notifications.email;

    assert.ok(emailNotif instanceof BooleanFieldExpr);
    const condition = emailNotif.eq(true);

    assert.strictEqual(condition.type, 'eq');
    assert.strictEqual(condition.field, 'settings.notifications.email');
    assert.strictEqual(condition.value, true);
  });

  test('nested object methods still work', () => {
    const { settings } = User.fields;

    // settings.eq() should work
    assert.strictEqual(settings.eq({} as any).type, 'eq');

    // settings.isNull() should work (inherited from FieldExprBase)
    assert.strictEqual(settings.isNull().type, 'isNull');
    assert.strictEqual(settings.isNull().field, 'settings');
  });

  test('complex nested query', () => {
    const { settings } = User.fields;

    const condition = q.and(
      settings.theme.eq('dark'),
      settings.darkMode.eq(true),
      settings.notifications.email.eq(false),
    );

    assert.strictEqual(condition.type, 'and');
    assert.strictEqual(condition.conditions.length, 3);
    assert.strictEqual((condition.conditions[0] as any).field, 'settings.theme');
    assert.strictEqual((condition.conditions[1] as any).field, 'settings.darkMode');
    assert.strictEqual((condition.conditions[2] as any).field, 'settings.notifications.email');
  });
});

// =============================================================================
// Aggregation Tests
// =============================================================================

describe('Aggregations', () => {
  class Post extends defineModel({
    views: field.int(),
    rating: field.decimal(3, 2),
  }) {}

  test('q.count() creates count aggregation', () => {
    const agg = q.count();
    assert.strictEqual(agg.type, 'count');
    assert.strictEqual(agg.field, undefined);
  });

  test('q.count(field) creates field count', () => {
    const { views } = Post.fields;
    const agg = q.count(views);
    assert.strictEqual(agg.type, 'count');
    assert.strictEqual(agg.field, 'views');
  });

  test('q.count().distinct() creates distinct count', () => {
    const agg = q.count().distinct();
    assert.strictEqual(agg.distinct, true);
  });

  test('q.sum() creates sum aggregation', () => {
    const { views } = Post.fields;
    const agg = q.sum(views);
    assert.strictEqual(agg.type, 'sum');
    assert.strictEqual(agg.field, 'views');
  });

  test('q.avg() creates avg aggregation', () => {
    const { views } = Post.fields;
    const agg = q.avg(views);
    assert.strictEqual(agg.type, 'avg');
  });

  test('q.min/max() work with any field', () => {
    const { views } = Post.fields;

    assert.strictEqual(q.min(views).type, 'min');
    assert.strictEqual(q.max(views).type, 'max');
  });
});
