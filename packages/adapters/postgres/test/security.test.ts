/**
 * Postgres adapter security regressions.
 *
 * These exercise the boundaries where a runtime caller (HTTP body, query
 * string, etc.) can flow into SQL through the typed DSL. The framework's
 * own paths use compile-time strings; these tests guard the gaps where
 * strings reach SQL anyway and prove they fail closed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ColumnRef, JsonPath } from '../src/sql/sql-ast.js';
import { PgQueryCompiler } from '../src/query/query-compiler.js';
import { assertNonNegativeInt } from '../src/repository/pg-repository.js';

describe('Security: SQL AST identifier handling', () => {
  it('ColumnRef rejects column names with statement terminators', () => {
    assert.throws(
      () => new ColumnRef('id; DROP TABLE users; --'),
      /Invalid SQL/,
    );
  });

  it('ColumnRef rejects column names that would break out of an unquoted ident', () => {
    assert.throws(() => new ColumnRef('id" OR "1"="1'), /Invalid SQL/);
    assert.throws(() => new ColumnRef("id' OR '1'='1"), /Invalid SQL/);
  });

  it('ColumnRef rejects column names containing operators / whitespace', () => {
    assert.throws(() => new ColumnRef('id OR 1=1'), /Invalid SQL/);
    assert.throws(() => new ColumnRef('balance--'), /Invalid SQL/);
  });

  it('JsonPath escapes single quotes in path parts', () => {
    const node = new JsonPath('data', ["k'='admin' --"], true);
    // The single quotes in the key must be doubled so they stay inside the
    // SQL string literal — otherwise `data->>'k'='admin' --'` evaluates
    // `data->>'k'` against literal `admin` instead of the JSON key.
    assert.strictEqual(node.toSql(), "data->>'k''=''admin'' --'");
  });

  it('JsonPath rejects malicious column / qualified column references', () => {
    assert.throws(() => new JsonPath("data'", ['k']), /Invalid SQL/);
    assert.throws(
      () => new JsonPath('data; DROP TABLE x; --', ['k']),
      /Invalid SQL/,
    );
  });
});

describe('Security: query compiler against runtime-input field names', () => {
  // Realistic vector: `repo.find({ orderBy: req.body })`. The handler types
  // it as OrderByOptions<T>, but at runtime any string can land in
  // Object.entries(orderBy) and reach fieldToExpr → ColumnRef.
  it('compileOrderBy on a malicious object key throws before SQL emission', () => {
    const compiler = new PgQueryCompiler({ storageMode: 'columnar' });
    assert.throws(
      () =>
        compiler.compileOrderBy({
          'id; DROP TABLE users; --': 'asc',
        } as Record<string, 'asc' | 'desc'>),
      /Invalid SQL/,
    );
  });

  it('compileOrderBy with valid snake_case still works', () => {
    const compiler = new PgQueryCompiler({ storageMode: 'columnar' });
    const compiled = compiler.compileOrderBy({
      created_at: 'desc',
      user_id: 'asc',
    } as Record<string, 'asc' | 'desc'>);
    // direction comes from a hardcoded enum, not user input — safe regardless
    assert.match(compiled.text, /created_at DESC/);
    assert.match(compiled.text, /user_id ASC/);
  });

  it("rejects '; DROP /*' style strings from a bypassed `as any` cast", () => {
    // Concrete reproduction of the original CVE pattern: a caller bypasses
    // the typed signature and routes a string into LIMIT.
    assert.throws(
      () => assertNonNegativeInt('1; DROP TABLE users; --' as unknown, 'limit'),
      /must be a non-negative integer/,
    );
  });

  it('rejects negative, fractional, NaN, Infinity', () => {
    assert.throws(() => assertNonNegativeInt(-1, 'limit'), /non-negative/);
    assert.throws(() => assertNonNegativeInt(1.5, 'limit'), /non-negative/);
    assert.throws(() => assertNonNegativeInt(NaN, 'limit'), /non-negative/);
    assert.throws(() => assertNonNegativeInt(Infinity, 'limit'), /non-negative/);
    assert.throws(() => assertNonNegativeInt(null, 'limit'), /non-negative/);
    assert.throws(() => assertNonNegativeInt(undefined, 'limit'), /non-negative/);
  });

  it('accepts 0 and positive integers', () => {
    assert.strictEqual(assertNonNegativeInt(0, 'limit'), 0);
    assert.strictEqual(assertNonNegativeInt(100, 'limit'), 100);
    assert.strictEqual(assertNonNegativeInt(Number.MAX_SAFE_INTEGER, 'limit'), Number.MAX_SAFE_INTEGER);
  });

  it('JSONB-mode order key with single quote in path stays inside a SQL literal', () => {
    const compiler = new PgQueryCompiler({ storageMode: 'jsonb' });
    const compiled = compiler.compileOrderBy({
      "k'='admin'--": 'asc',
    } as Record<string, 'asc' | 'desc'>);
    // The breakout-shaped key gets escaped to keep ' doubled inside the
    // jsonb path literal — no terminator reaches SQL.
    assert.match(compiled.text, /'k''=''admin''--'/);
    assert.ok(!compiled.text.match(/'.*'.*=.*'.*'/) || compiled.text.includes("''"));
  });
});

