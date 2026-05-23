/**
 * expressionToName — AST-walked clean name extraction.
 *
 * The compiler used to call `.getText()` on signal service expressions and
 * identity arguments. .getText() returns RAW source text — including
 * leading/trailing whitespace and inline comments — which then leaked
 * into registered signal metadata.
 *
 * expressionToName walks the AST and extracts a clean name. These tests
 * pin the behavior so a future refactor can't quietly regress to
 * .getText().
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { expressionToName } from '../src/compiler/analyzer.js';

/** Parse a snippet to an Expression node. */
function parseExpr(source: string): ts.Expression {
  // Wrap in a parens-as-statement so the source is a valid program; the
  // first statement's expression is what we want.
  const sf = ts.createSourceFile(
    'test.ts',
    `(${source});`,
    ts.ScriptTarget.Latest,
    true,
  );
  const stmt = sf.statements[0] as ts.ExpressionStatement;
  // Strip the wrapping parens.
  const paren = stmt.expression as ts.ParenthesizedExpression;
  return paren.expression;
}

describe('expressionToName', () => {
  it('extracts text from a plain identifier', () => {
    assert.strictEqual(expressionToName(parseExpr('orderId')), 'orderId');
  });

  it('extracts text from a string literal (no quotes)', () => {
    assert.strictEqual(expressionToName(parseExpr('"order-123"')), 'order-123');
    assert.strictEqual(expressionToName(parseExpr("'order-123'")), 'order-123');
  });

  it('extracts text from a no-substitution template literal', () => {
    assert.strictEqual(expressionToName(parseExpr('`order-123`')), 'order-123');
  });

  it('extracts dotted path from property access', () => {
    assert.strictEqual(
      expressionToName(parseExpr('payments.received')),
      'payments.received',
    );
  });

  it('extracts deeply-nested property access', () => {
    assert.strictEqual(
      expressionToName(parseExpr('app.payments.events.received')),
      'app.payments.events.received',
    );
  });

  it('extracts `this` keyword as the literal string "this"', () => {
    assert.strictEqual(expressionToName(parseExpr('this')), 'this');
    assert.strictEqual(
      expressionToName(parseExpr('this.payments')),
      'this.payments',
    );
  });

  // The whole reason expressionToName exists. Pre-fix .getText() would
  // return raw source text including these comments and whitespace.
  it('strips inline block comments from property access', () => {
    assert.strictEqual(
      expressionToName(parseExpr('payments /* legacy */ . received')),
      'payments.received',
    );
  });

  it('strips inline block comments from identity-position identifier', () => {
    // A function-arg identifier with a trailing comment — analyzer maps
    // these via expressionToName for signal identity extraction.
    assert.strictEqual(
      expressionToName(parseExpr('orderId /* primary key */')),
      'orderId',
    );
  });

  it('normalizes whitespace inside property access', () => {
    assert.strictEqual(
      expressionToName(parseExpr('payments  .  received')),
      'payments.received',
    );
  });

  it('falls back to trimmed source for unknown shapes', () => {
    // E.g. an array literal as an arg position — unrecognized shape
    // hits the fallback. Should at least be trimmed so downstream
    // consumers don't get whitespace-padded keys.
    const result = expressionToName(parseExpr(' [1, 2, 3] '));
    assert.strictEqual(result, '[1, 2, 3]');
  });
});
