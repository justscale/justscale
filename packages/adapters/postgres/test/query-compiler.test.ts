/**
 * Tests for PgQueryCompiler
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';

import { defineModel, field, q } from '@justscale/core/models';
import { PgQueryCompiler, Sql, Compare, And, ColumnRef, JsonPath, Param } from '../src/index.js';

// =============================================================================
// Test Models
// =============================================================================

class Post extends defineModel({
  title: field.string().max(255),
  status: field.enum('PostStatus', ['draft', 'published', 'archived'] as const),
  views: field.int(),
  rating: field.decimal(3, 2),
  published: field.boolean(),
  createdAt: field.createdAt(),
  deletedAt: field.deletedAt(),
}) {}

const { title, status, views, published, createdAt, deletedAt } = Post.fields;

// =============================================================================
// Columnar Mode Tests
// =============================================================================

describe('PgQueryCompiler - Columnar Mode', () => {
  const compiler = new PgQueryCompiler({ storageMode: 'columnar' });

  test('compiles simple equality', () => {
    const sql = compiler.compileWhere(status.eq('published'));

    assert.strictEqual(sql.text, 'status = $1');
    assert.deepStrictEqual(sql.values, ['published']);
  });

  test('compiles inequality', () => {
    const sql = compiler.compileWhere(status.neq('draft'));

    assert.strictEqual(sql.text, 'status <> $1');
    assert.deepStrictEqual(sql.values, ['draft']);
  });

  test('compiles gt/gte/lt/lte', () => {
    assert.strictEqual(compiler.compileWhere(views.gt(100)).text, 'views > $1');
    assert.strictEqual(compiler.compileWhere(views.gte(100)).text, 'views >= $1');
    assert.strictEqual(compiler.compileWhere(views.lt(100)).text, 'views < $1');
    assert.strictEqual(compiler.compileWhere(views.lte(100)).text, 'views <= $1');
  });

  test('compiles LIKE patterns', () => {
    const sql = compiler.compileWhere(title.like('%hello%'));

    assert.strictEqual(sql.text, 'title LIKE $1');
    assert.deepStrictEqual(sql.values, ['%hello%']);
  });

  test('compiles ILIKE patterns', () => {
    const sql = compiler.compileWhere(title.ilike('%HELLO%'));

    assert.strictEqual(sql.text, 'title ILIKE $1');
    assert.deepStrictEqual(sql.values, ['%HELLO%']);
  });

  test('compiles startsWith/endsWith/contains', () => {
    assert.strictEqual(compiler.compileWhere(title.startsWith('Hello')).text, 'title LIKE $1');
    assert.deepStrictEqual(compiler.compileWhere(title.startsWith('Hello')).values, ['Hello%']);

    assert.strictEqual(compiler.compileWhere(title.endsWith('World')).text, 'title LIKE $1');
    assert.deepStrictEqual(compiler.compileWhere(title.endsWith('World')).values, ['%World']);

    assert.strictEqual(compiler.compileWhere(title.contains('middle')).text, 'title LIKE $1');
    assert.deepStrictEqual(compiler.compileWhere(title.contains('middle')).values, ['%middle%']);
  });

  test('escapes special LIKE characters', () => {
    const sql = compiler.compileWhere(title.contains('100%'));
    assert.deepStrictEqual(sql.values, ['%100\\%%']);
  });

  test('compiles IN list', () => {
    const sql = compiler.compileWhere(status.in(['draft', 'published']));

    assert.strictEqual(sql.text, 'status IN ($1, $2)');
    assert.deepStrictEqual(sql.values, ['draft', 'published']);
  });

  test('compiles NOT IN list', () => {
    const sql = compiler.compileWhere(status.notIn(['archived']));

    assert.strictEqual(sql.text, 'status NOT IN ($1)');
    assert.deepStrictEqual(sql.values, ['archived']);
  });

  test('compiles BETWEEN', () => {
    const sql = compiler.compileWhere(views.between(10, 100));

    assert.strictEqual(sql.text, 'views BETWEEN $1 AND $2');
    assert.deepStrictEqual(sql.values, [10, 100]);
  });

  test('compiles IS NULL', () => {
    const sql = compiler.compileWhere(deletedAt.isNull());
    assert.strictEqual(sql.text, 'deleted_at IS NULL');
    assert.deepStrictEqual(sql.values, []);
  });

  test('compiles IS NOT NULL', () => {
    const sql = compiler.compileWhere(deletedAt.isNotNull());
    assert.strictEqual(sql.text, 'deleted_at IS NOT NULL');
    assert.deepStrictEqual(sql.values, []);
  });

  test('compiles boolean isTrue/isFalse', () => {
    assert.strictEqual(compiler.compileWhere(published.isTrue()).text, 'published = $1');
    assert.deepStrictEqual(compiler.compileWhere(published.isTrue()).values, [true]);

    assert.strictEqual(compiler.compileWhere(published.isFalse()).text, 'published = $1');
    assert.deepStrictEqual(compiler.compileWhere(published.isFalse()).values, [false]);
  });

  test('compiles timestamp before/after', () => {
    const date = new Date('2024-01-01');
    assert.strictEqual(compiler.compileWhere(createdAt.before(date)).text, 'created_at < $1');
    assert.strictEqual(compiler.compileWhere(createdAt.after(date)).text, 'created_at > $1');
  });
});

// =============================================================================
// Logical Operators Tests
// =============================================================================

describe('PgQueryCompiler - Logical Operators', () => {
  const compiler = new PgQueryCompiler({ storageMode: 'columnar' });

  test('compiles AND conditions', () => {
    const sql = compiler.compileWhere(
      q.and(status.eq('published'), views.gt(100)),
    );

    assert.strictEqual(sql.text, '(status = $1 AND views > $2)');
    assert.deepStrictEqual(sql.values, ['published', 100]);
  });

  test('compiles OR conditions', () => {
    const sql = compiler.compileWhere(
      q.or(status.eq('draft'), status.eq('published')),
    );

    assert.strictEqual(sql.text, '(status = $1 OR status = $2)');
    assert.deepStrictEqual(sql.values, ['draft', 'published']);
  });

  test('compiles NOT condition', () => {
    const sql = compiler.compileWhere(q.not(status.eq('archived')));

    assert.strictEqual(sql.text, 'NOT (status = $1)');
    assert.deepStrictEqual(sql.values, ['archived']);
  });

  test('compiles complex nested conditions', () => {
    const sql = compiler.compileWhere(
      q.and(
        status.eq('published'),
        q.or(title.contains('typescript'), views.gt(1000)),
        deletedAt.isNull(),
      ),
    );

    assert.strictEqual(
      sql.text,
      '(status = $1 AND (title LIKE $2 OR views > $3) AND deleted_at IS NULL)',
    );
    assert.deepStrictEqual(sql.values, ['published', '%typescript%', 1000]);
  });

  test('single condition AND returns unwrapped', () => {
    const sql = compiler.compileWhere(q.and(status.eq('published')));
    assert.strictEqual(sql.text, 'status = $1');
  });

  test('empty AND returns TRUE', () => {
    const sql = compiler.compileWhere(q.and());
    assert.strictEqual(sql.text, 'TRUE');
  });

  test('empty OR returns FALSE', () => {
    const sql = compiler.compileWhere(q.or());
    assert.strictEqual(sql.text, 'FALSE');
  });
});

// =============================================================================
// JSONB Mode Tests
// =============================================================================

describe('PgQueryCompiler - JSONB Mode', () => {
  const compiler = new PgQueryCompiler({
    storageMode: 'jsonb',
    dataColumn: 'data',
  });

  test('compiles non-system fields as JSONB path', () => {
    const sql = compiler.compileWhere(status.eq('published'));

    assert.strictEqual(sql.text, "data->>'status' = $1");
    assert.deepStrictEqual(sql.values, ['published']);
  });

  test('keeps system fields as columns', () => {
    const sql = compiler.compileWhere(createdAt.after(new Date('2024-01-01')));

    assert.strictEqual(sql.text, 'created_at > $1');
  });

  test('compiles complex conditions in JSONB mode', () => {
    const sql = compiler.compileWhere(
      q.and(status.eq('published'), views.gt(100)),
    );

    assert.strictEqual(sql.text, "(data->>'status' = $1 AND data->>'views' > $2)");
  });
});

// =============================================================================
// Snake Case Tests
// =============================================================================

describe('PgQueryCompiler - Snake Case', () => {
  const compiler = new PgQueryCompiler({ snakeCase: true });

  test('converts camelCase to snake_case', () => {
    const sql = compiler.compileWhere(createdAt.after(new Date()));
    assert.ok(sql.text.includes('created_at'));
  });

  test('handles multiple capital letters', () => {
    class Model extends defineModel({
      userEmailAddress: field.string(),
    }) {}

    const sql = compiler.compileWhere(Model.fields.userEmailAddress.eq('test'));
    assert.strictEqual(sql.text, 'user_email_address = $1');
  });
});

// =============================================================================
// ORDER BY Tests
// =============================================================================

describe('PgQueryCompiler - ORDER BY', () => {
  const compiler = new PgQueryCompiler({ storageMode: 'columnar' });

  test('compiles simple order by', () => {
    const sql = compiler.compileOrderBy({ createdAt: 'desc' });
    assert.strictEqual(sql.text, 'created_at DESC');
  });

  test('compiles multiple order by', () => {
    const sql = compiler.compileOrderBy({ status: 'asc', createdAt: 'desc' });
    assert.strictEqual(sql.text, 'status ASC, created_at DESC');
  });
});

// =============================================================================
// Aggregation Tests
// =============================================================================

describe('PgQueryCompiler - Aggregations', () => {
  const compiler = new PgQueryCompiler({ storageMode: 'columnar' });

  test('compiles COUNT(*)', () => {
    const sql = compiler.compileAggregation(q.count());
    assert.strictEqual(sql.text, 'COUNT(*)');
  });

  test('compiles COUNT(field)', () => {
    const sql = compiler.compileAggregation(q.count(views));
    assert.strictEqual(sql.text, 'COUNT(views)');
  });

  test('compiles COUNT(DISTINCT field)', () => {
    const sql = compiler.compileAggregation(q.count(status).distinct());
    assert.strictEqual(sql.text, 'COUNT(DISTINCT status)');
  });

  test('compiles SUM', () => {
    const sql = compiler.compileAggregation(q.sum(views));
    assert.strictEqual(sql.text, 'SUM(views)');
  });

  test('compiles AVG', () => {
    const sql = compiler.compileAggregation(q.avg(views));
    assert.strictEqual(sql.text, 'AVG(views)');
  });

  test('compiles MIN/MAX', () => {
    assert.strictEqual(compiler.compileAggregation(q.min(views)).text, 'MIN(views)');
    assert.strictEqual(compiler.compileAggregation(q.max(views)).text, 'MAX(views)');
  });
});

// =============================================================================
// AST Inspection Tests
// =============================================================================

describe('PgQueryCompiler - AST Inspection', () => {
  const compiler = new PgQueryCompiler({ storageMode: 'columnar' });

  test('toAst returns SQL AST nodes', () => {
    const { ast, values } = compiler.toAst(
      q.and(status.eq('published'), views.gt(100)),
    );

    assert.ok(ast instanceof And);
    assert.strictEqual((ast as And).conditions.length, 2);
    assert.deepStrictEqual(values, ['published', 100]);
  });

  test('AST nodes have correct types', () => {
    const { ast } = compiler.toAst(status.eq('published'));

    assert.ok(ast instanceof Compare);
    assert.ok((ast as Compare).left instanceof ColumnRef);
    assert.strictEqual((ast as Compare).op, Sql.Op.Eq);
    assert.ok((ast as Compare).right instanceof Param);
  });

  test('JSONB mode creates JsonPath nodes', () => {
    const jsonCompiler = new PgQueryCompiler({ storageMode: 'jsonb' });
    const { ast } = jsonCompiler.toAst(status.eq('published'));

    assert.ok(ast instanceof Compare);
    assert.ok((ast as Compare).left instanceof JsonPath);
  });
});

// =============================================================================
// Raw SQL Tests
// =============================================================================

describe('PgQueryCompiler - Raw SQL', () => {
  const compiler = new PgQueryCompiler({ storageMode: 'columnar' });

  test('compiles raw SQL conditions', () => {
    const sql = compiler.compileWhere(q.raw('tsv @@ plainto_tsquery($1)', 'search term'));

    assert.strictEqual(sql.text, 'tsv @@ plainto_tsquery($1)');
    assert.deepStrictEqual(sql.values, ['search term']);
  });

  test('raw SQL with multiple parameters', () => {
    const sql = compiler.compileWhere(
      q.and(
        status.eq('published'),
        q.raw('score BETWEEN $1 AND $2', 0, 100),
      ),
    );

    assert.strictEqual(sql.text, '(status = $1 AND score BETWEEN $2 AND $3)');
    assert.deepStrictEqual(sql.values, ['published', 0, 100]);
  });
});

// =============================================================================
// Edge Cases - Empty/Null Values
// =============================================================================

describe('PgQueryCompiler - Edge Cases: Empty/Null Values', () => {
  const compiler = new PgQueryCompiler({ storageMode: 'columnar' });

  test('handles empty string equality', () => {
    const sql = compiler.compileWhere(title.eq(''));
    assert.strictEqual(sql.text, 'title = $1');
    assert.deepStrictEqual(sql.values, ['']);
  });

  test('handles empty string in LIKE', () => {
    const sql = compiler.compileWhere(title.contains(''));
    assert.strictEqual(sql.text, 'title LIKE $1');
    assert.deepStrictEqual(sql.values, ['%%']);
  });

  test('handles single item IN list', () => {
    const sql = compiler.compileWhere(status.in(['draft']));
    assert.strictEqual(sql.text, 'status IN ($1)');
    assert.deepStrictEqual(sql.values, ['draft']);
  });

  test('handles numeric zero', () => {
    const sql = compiler.compileWhere(views.eq(0));
    assert.strictEqual(sql.text, 'views = $1');
    assert.deepStrictEqual(sql.values, [0]);
  });

  test('handles negative numbers', () => {
    const sql = compiler.compileWhere(views.lt(-100));
    assert.strictEqual(sql.text, 'views < $1');
    assert.deepStrictEqual(sql.values, [-100]);
  });

  test('handles BETWEEN with same min and max', () => {
    const sql = compiler.compileWhere(views.between(50, 50));
    assert.strictEqual(sql.text, 'views BETWEEN $1 AND $2');
    assert.deepStrictEqual(sql.values, [50, 50]);
  });
});

// =============================================================================
// Edge Cases - Special Characters
// =============================================================================

describe('PgQueryCompiler - Edge Cases: Special Characters', () => {
  const compiler = new PgQueryCompiler({ storageMode: 'columnar' });

  test('escapes underscore in LIKE patterns', () => {
    const sql = compiler.compileWhere(title.contains('user_name'));
    assert.deepStrictEqual(sql.values, ['%user\\_name%']);
  });

  test('escapes backslash in LIKE patterns', () => {
    const sql = compiler.compileWhere(title.contains('C:\\path'));
    // Only backslash is a special LIKE char, colon is not
    assert.deepStrictEqual(sql.values, ['%C:\\\\path%']);
  });

  test('escapes multiple special chars in sequence', () => {
    const sql = compiler.compileWhere(title.startsWith('100%_done'));
    assert.deepStrictEqual(sql.values, ['100\\%\\_done%']);
  });

  test('handles unicode in values', () => {
    const sql = compiler.compileWhere(title.eq('日本語タイトル'));
    assert.strictEqual(sql.text, 'title = $1');
    assert.deepStrictEqual(sql.values, ['日本語タイトル']);
  });

  test('handles emoji in values', () => {
    const sql = compiler.compileWhere(title.contains('🚀'));
    assert.strictEqual(sql.text, 'title LIKE $1');
    assert.deepStrictEqual(sql.values, ['%🚀%']);
  });

  test('handles newlines and tabs in values', () => {
    const sql = compiler.compileWhere(title.eq('line1\nline2\ttab'));
    assert.deepStrictEqual(sql.values, ['line1\nline2\ttab']);
  });

  test('handles SQL injection attempts (safely parameterized)', () => {
    const sql = compiler.compileWhere(title.eq("'; DROP TABLE users; --"));
    assert.strictEqual(sql.text, 'title = $1');
    assert.deepStrictEqual(sql.values, ["'; DROP TABLE users; --"]);
  });
});

// =============================================================================
// Edge Cases - Field Mapping
// =============================================================================

describe('PgQueryCompiler - Edge Cases: Field Mapping', () => {
  test('uses custom field mapping', () => {
    const compiler = new PgQueryCompiler({
      storageMode: 'columnar',
      fieldMap: { status: 'post_status', views: 'view_count' },
    });

    const sql = compiler.compileWhere(
      q.and(status.eq('published'), views.gt(100)),
    );
    assert.strictEqual(sql.text, '(post_status = $1 AND view_count > $2)');
  });

  test('field mapping takes precedence over snake_case', () => {
    class Model extends defineModel({
      createdAt: field.timestamp(), // Would normally be created_at
    }) {}

    const compiler = new PgQueryCompiler({
      snakeCase: true,
      fieldMap: { createdAt: 'creation_timestamp' },
    });

    const sql = compiler.compileWhere(Model.fields.createdAt.after(new Date()));
    assert.ok(sql.text.includes('creation_timestamp'));
  });

  test('disables snake_case conversion', () => {
    class Model extends defineModel({
      myFieldName: field.string(),
    }) {}

    const compiler = new PgQueryCompiler({ snakeCase: false });
    const sql = compiler.compileWhere(Model.fields.myFieldName.eq('test'));
    assert.strictEqual(sql.text, 'myFieldName = $1');
  });

  test('custom system fields', () => {
    const compiler = new PgQueryCompiler({
      storageMode: 'jsonb',
      systemFields: ['id', 'customField'], // Only id and customField are columnar
    });

    // createdAt is no longer a system field, so it goes to JSONB
    const sql = compiler.compileWhere(createdAt.after(new Date()));
    assert.ok(sql.text.includes("data->>'createdAt'"));
  });

  test('custom data column name', () => {
    const compiler = new PgQueryCompiler({
      storageMode: 'jsonb',
      dataColumn: 'payload',
    });

    const sql = compiler.compileWhere(status.eq('published'));
    assert.strictEqual(sql.text, "payload->>'status' = $1");
  });
});

// =============================================================================
// Edge Cases - Deep Nesting
// =============================================================================

describe('PgQueryCompiler - Edge Cases: Deep Nesting', () => {
  const compiler = new PgQueryCompiler({ storageMode: 'columnar' });

  test('handles deeply nested AND/OR conditions', () => {
    const sql = compiler.compileWhere(
      q.and(
        q.or(
          q.and(
            status.eq('published'),
            views.gt(100),
          ),
          q.and(
            status.eq('draft'),
            views.lt(10),
          ),
        ),
        deletedAt.isNull(),
      ),
    );

    assert.strictEqual(
      sql.text,
      '(((status = $1 AND views > $2) OR (status = $3 AND views < $4)) AND deleted_at IS NULL)',
    );
    assert.deepStrictEqual(sql.values, ['published', 100, 'draft', 10]);
  });

  test('handles NOT inside nested conditions', () => {
    const sql = compiler.compileWhere(
      q.and(
        q.not(q.or(status.eq('archived'), status.eq('deleted'))),
        views.gt(0),
      ),
    );

    assert.strictEqual(
      sql.text,
      '(NOT ((status = $1 OR status = $2)) AND views > $3)',
    );
  });

  test('handles multiple NOT conditions', () => {
    const sql = compiler.compileWhere(
      q.and(
        q.not(status.eq('archived')),
        q.not(status.eq('deleted')),
        q.not(views.lt(0)),
      ),
    );

    assert.ok(sql.text.includes('NOT (status = $1)'));
    assert.ok(sql.text.includes('NOT (status = $2)'));
    assert.ok(sql.text.includes('NOT (views < $3)'));
  });

  test('flattens single-condition wrappers at multiple levels', () => {
    const sql = compiler.compileWhere(
      q.and(q.or(q.and(status.eq('published')))),
    );
    // All single-condition wrappers should be flattened
    assert.strictEqual(sql.text, 'status = $1');
  });
});

// =============================================================================
// Edge Cases - Multiple Raw SQL
// =============================================================================

describe('PgQueryCompiler - Edge Cases: Multiple Raw SQL', () => {
  const compiler = new PgQueryCompiler({ storageMode: 'columnar' });

  test('handles multiple raw SQL conditions with correct parameter ordering', () => {
    const sql = compiler.compileWhere(
      q.and(
        q.raw('custom_func($1) > $2', 'arg1', 10),
        status.eq('published'),
        q.raw('other_func($1, $2)', 'x', 'y'),
      ),
    );

    assert.strictEqual(
      sql.text,
      '(custom_func($1) > $2 AND status = $3 AND other_func($4, $5))',
    );
    assert.deepStrictEqual(sql.values, ['arg1', 10, 'published', 'x', 'y']);
  });

  test('handles raw SQL without parameters', () => {
    const sql = compiler.compileWhere(q.raw('is_active = TRUE'));
    assert.strictEqual(sql.text, 'is_active = TRUE');
    assert.deepStrictEqual(sql.values, []);
  });

  test('handles raw SQL with repeated placeholders (reuse)', () => {
    // User writes $1 twice - both should refer to the same value
    const sql = compiler.compileWhere(
      q.and(
        status.eq('x'), // $1
        q.raw('func($1, $2, $1)', 'a', 'b'), // $1->$2, $2->$3, $1->$2 (reused)
      ),
    );

    // Placeholder reuse: same $N in raw SQL maps to same value
    assert.strictEqual(sql.text, '(status = $1 AND func($2, $3, $2))');
    assert.deepStrictEqual(sql.values, ['x', 'a', 'b']);
  });
});

// =============================================================================
// Edge Cases - Date/Time
// =============================================================================

describe('PgQueryCompiler - Edge Cases: Date/Time', () => {
  const compiler = new PgQueryCompiler({ storageMode: 'columnar' });

  test('handles epoch date', () => {
    const epoch = new Date(0);
    const sql = compiler.compileWhere(createdAt.after(epoch));
    assert.deepStrictEqual(sql.values, [epoch]);
  });

  test('handles far future date', () => {
    const future = new Date('2099-12-31T23:59:59.999Z');
    const sql = compiler.compileWhere(createdAt.before(future));
    assert.deepStrictEqual(sql.values, [future]);
  });

  test('handles date range with BETWEEN', () => {
    const start = new Date('2024-01-01');
    const end = new Date('2024-12-31');
    const sql = compiler.compileWhere(createdAt.between(start, end));
    assert.strictEqual(sql.text, 'created_at BETWEEN $1 AND $2');
    assert.deepStrictEqual(sql.values, [start, end]);
  });
});

// =============================================================================
// Edge Cases - SQL Keyword Field Names
// =============================================================================

describe('PgQueryCompiler - Edge Cases: SQL Keyword Field Names', () => {
  test('handles field named "order"', () => {
    class Model extends defineModel({
      order: field.int(),
    }) {}

    const compiler = new PgQueryCompiler({ snakeCase: false });
    const sql = compiler.compileWhere(Model.fields.order.eq(1));
    // Note: The compiler doesn't quote identifiers - that's a potential enhancement
    assert.strictEqual(sql.text, 'order = $1');
  });

  test('handles field named "select"', () => {
    class Model extends defineModel({
      select: field.string(),
    }) {}

    const compiler = new PgQueryCompiler({ snakeCase: false });
    const sql = compiler.compileWhere(Model.fields.select.eq('value'));
    assert.strictEqual(sql.text, 'select = $1');
  });
});

// =============================================================================
// Edge Cases - Aggregations in JSONB Mode
// =============================================================================

describe('PgQueryCompiler - Edge Cases: Aggregations in JSONB Mode', () => {
  const compiler = new PgQueryCompiler({
    storageMode: 'jsonb',
    dataColumn: 'data',
  });

  test('aggregates use JSONB paths for non-system fields', () => {
    const sql = compiler.compileAggregation(q.sum(views));
    assert.strictEqual(sql.text, "SUM(data->>'views')");
  });

  test('aggregates use columns for system fields', () => {
    const sql = compiler.compileAggregation(q.max(createdAt));
    assert.strictEqual(sql.text, 'MAX(created_at)');
  });

  test('COUNT DISTINCT with JSONB field', () => {
    const sql = compiler.compileAggregation(q.count(status).distinct());
    assert.strictEqual(sql.text, "COUNT(DISTINCT data->>'status')");
  });
});

// =============================================================================
// Edge Cases - ORDER BY in JSONB Mode
// =============================================================================

describe('PgQueryCompiler - Edge Cases: ORDER BY in JSONB Mode', () => {
  const compiler = new PgQueryCompiler({
    storageMode: 'jsonb',
    dataColumn: 'data',
  });

  test('ORDER BY uses JSONB paths for non-system fields', () => {
    const sql = compiler.compileOrderBy({ status: 'asc' });
    assert.strictEqual(sql.text, "data->>'status' ASC");
  });

  test('ORDER BY uses columns for system fields', () => {
    const sql = compiler.compileOrderBy({ createdAt: 'desc' });
    assert.strictEqual(sql.text, 'created_at DESC');
  });

  test('ORDER BY mixed system and JSONB fields', () => {
    const sql = compiler.compileOrderBy({ status: 'asc', createdAt: 'desc' });
    assert.strictEqual(sql.text, "data->>'status' ASC, created_at DESC");
  });
});

// =============================================================================
// Edge Cases - Boolean and Type Coercion
// =============================================================================

describe('PgQueryCompiler - Edge Cases: Boolean and Type Coercion', () => {
  const compiler = new PgQueryCompiler({ storageMode: 'columnar' });

  test('handles boolean false explicitly', () => {
    const sql = compiler.compileWhere(published.eq(false));
    assert.deepStrictEqual(sql.values, [false]);
  });

  test('handles boolean IN list', () => {
    const sql = compiler.compileWhere(published.in([true, false]));
    assert.strictEqual(sql.text, 'published IN ($1, $2)');
    assert.deepStrictEqual(sql.values, [true, false]);
  });
});

// =============================================================================
// Edge Cases - Decimal Fields
// =============================================================================

describe('PgQueryCompiler - Edge Cases: Decimal Fields', () => {
  const compiler = new PgQueryCompiler({ storageMode: 'columnar' });
  // Note: DecimalFieldExpr is mapped to StringFieldExpr at the type level because
  // decimals have TS type `string`. We access the actual runtime methods via cast.
  const { rating } = Post.fields as unknown as { rating: import('@justscale/core/models').DecimalFieldExpr };

  test('handles decimal string values', () => {
    const sql = compiler.compileWhere(rating.eq('3.14'));
    assert.strictEqual(sql.text, 'rating = $1');
    assert.deepStrictEqual(sql.values, ['3.14']);
  });

  test('handles decimal comparison', () => {
    const sql = compiler.compileWhere(rating.gt('4.50'));
    assert.strictEqual(sql.text, 'rating > $1');
  });

  test('handles decimal BETWEEN', () => {
    const sql = compiler.compileWhere(rating.between('1.00', '5.00'));
    assert.strictEqual(sql.text, 'rating BETWEEN $1 AND $2');
    assert.deepStrictEqual(sql.values, ['1.00', '5.00']);
  });
});

// =============================================================================
// Edge Cases - Parameter Index Stress Test
// =============================================================================

describe('PgQueryCompiler - Edge Cases: Many Parameters', () => {
  const compiler = new PgQueryCompiler({ storageMode: 'columnar' });

  test('handles many parameters correctly', () => {
    // Create a condition with many parameters
    const statuses = Array.from({ length: 20 }, (_, i) => `status${i}`);
    const sql = compiler.compileWhere(status.in(statuses));

    // Should have $1 through $20
    assert.ok(sql.text.includes('$20'));
    assert.strictEqual(sql.values.length, 20);
    assert.strictEqual(sql.values[19], 'status19');
  });

  test('maintains parameter order across complex conditions', () => {
    const sql = compiler.compileWhere(
      q.and(
        status.eq('a'),        // $1
        views.gt(1),           // $2
        title.like('%b%'),     // $3
        views.lt(100),         // $4
        status.neq('c'),       // $5
        views.between(10, 50), // $6, $7
      ),
    );

    assert.deepStrictEqual(sql.values, ['a', 1, '%b%', 100, 'c', 10, 50]);
    assert.ok(sql.text.includes('$7'));
  });

  // The audit specifically called out: deeply-nested AND containing OR
  // containing inList + like + between + isNull. The risk is parameter
  // alignment — if any operator misnumbers $N inside a nested expression,
  // the values array doesn't line up and the query either errors or
  // (worse) silently uses the wrong value for a different placeholder.
  test('deeply-nested mix: and(or(inList, like), between, isNull)', () => {
    const sql = compiler.compileWhere(
      q.and(
        q.or(
          status.in(['draft', 'archived']),  // $1, $2 (one slot per IN value)
          title.contains('typescript'),       // $3 (LIKE pattern)
        ),
        views.between(10, 100),               // $4, $5
        deletedAt.isNull(),                   // (no param)
      ),
    );

    // status.in flattens to one slot per value (standard pg IN(...) shape),
    // so ['draft', 'archived'] becomes two placeholders. Total slots:
    //   2 (in) + 1 (contains) + 2 (between) + 0 (isNull) = 5
    assert.deepStrictEqual(sql.values, [
      'draft', 'archived', '%typescript%', 10, 100,
    ]);
    for (const n of [1, 2, 3, 4, 5]) {
      assert.ok(sql.text.includes(`$${n}`), `expected $${n} in: ${sql.text}`);
    }
    assert.ok(!sql.text.includes('$6'), `unexpected $6 in: ${sql.text}`);
  });

  test('three-deep AND/OR/AND nesting maintains placeholder order', () => {
    const sql = compiler.compileWhere(
      q.and(
        q.or(
          q.and(status.eq('published'), views.gt(100)), // $1, $2
          q.and(status.eq('draft'),     views.lt(10)),  // $3, $4
        ),
        title.like('%x%'),                              // $5
      ),
    );
    assert.deepStrictEqual(sql.values, ['published', 100, 'draft', 10, '%x%']);
    for (const n of [1, 2, 3, 4, 5]) {
      assert.ok(sql.text.includes(`$${n}`), `expected $${n} in: ${sql.text}`);
    }
  });

  test('NOT around OR around AND preserves placeholder count and order', () => {
    const sql = compiler.compileWhere(
      q.not(
        q.or(
          q.and(status.eq('a'), views.eq(1)), // $1, $2
          status.eq('b'),                     // $3
        ),
      ),
    );
    assert.deepStrictEqual(sql.values, ['a', 1, 'b']);
    assert.match(sql.text, /^NOT \(/);
    for (const n of [1, 2, 3]) {
      assert.ok(sql.text.includes(`$${n}`), `expected $${n}`);
    }
  });
});
