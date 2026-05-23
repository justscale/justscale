/**
 * combineDisposables — exception-safe combined disposal.
 *
 * Pre-fix the impl was a plain reverse-iteration `for ... { d.dispose() }`
 * with no try/catch. If any single dispose threw, the loop bailed and
 * every remaining disposable leaked — a database connection, lock,
 * file handle, or HTTP server could be left dangling.
 *
 * The fix catches per-disposal exceptions, runs the entire chain, and
 * surfaces all errors via AggregateError (or the lone error directly
 * when only one threw). These tests pin the behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { combineDisposables } from '../../src/core/disposable.js';

function makeDisposable(label: string, log: string[], throwIt = false): Disposable {
  return {
    [Symbol.dispose]() {
      log.push(label);
      if (throwIt) throw new Error(`dispose-${label}`);
    },
  };
}

describe('combineDisposables', () => {
  it('disposes in reverse registration order (LIFO)', () => {
    const log: string[] = [];
    const combined = combineDisposables(
      makeDisposable('a', log),
      makeDisposable('b', log),
      makeDisposable('c', log),
    );
    combined[Symbol.dispose]();
    assert.deepStrictEqual(log, ['c', 'b', 'a']);
  });

  it('runs ALL disposals even when one in the middle throws', () => {
    // The regression: previously, when 'b' threw, 'a' never ran.
    const log: string[] = [];
    const combined = combineDisposables(
      makeDisposable('a', log),
      makeDisposable('b', log, /* throw */ true),
      makeDisposable('c', log),
    );
    assert.throws(() => combined[Symbol.dispose](), /dispose-b/);
    // c first (reverse), then b (which threw), then a — a MUST still run.
    assert.deepStrictEqual(log, ['c', 'b', 'a']);
  });

  it('surfaces a single throw directly (not wrapped)', () => {
    const log: string[] = [];
    const combined = combineDisposables(
      makeDisposable('a', log),
      makeDisposable('b', log, true),
    );
    assert.throws(
      () => combined[Symbol.dispose](),
      (e) => e instanceof Error && !(e instanceof AggregateError) && e.message === 'dispose-b',
    );
  });

  it('aggregates multiple throws into AggregateError', () => {
    const log: string[] = [];
    const combined = combineDisposables(
      makeDisposable('a', log, true),
      makeDisposable('b', log, true),
      makeDisposable('c', log, true),
    );
    assert.throws(
      () => combined[Symbol.dispose](),
      (e) => {
        if (!(e instanceof AggregateError)) return false;
        const msgs = e.errors.map((x: any) => x.message).sort();
        // All three throws must be in the aggregate.
        return JSON.stringify(msgs) === JSON.stringify(['dispose-a', 'dispose-b', 'dispose-c']);
      },
    );
    // All three ran in reverse despite each throwing.
    assert.deepStrictEqual(log, ['c', 'b', 'a']);
  });

  it('does not throw when all disposals succeed', () => {
    const log: string[] = [];
    const combined = combineDisposables(
      makeDisposable('a', log),
      makeDisposable('b', log),
    );
    assert.doesNotThrow(() => combined[Symbol.dispose]());
    assert.deepStrictEqual(log, ['b', 'a']);
  });

  it('handles empty list (no-op)', () => {
    const combined = combineDisposables();
    assert.doesNotThrow(() => combined[Symbol.dispose]());
  });

  it('handles a single disposable', () => {
    const log: string[] = [];
    const combined = combineDisposables(makeDisposable('only', log));
    combined[Symbol.dispose]();
    assert.deepStrictEqual(log, ['only']);
  });
});
