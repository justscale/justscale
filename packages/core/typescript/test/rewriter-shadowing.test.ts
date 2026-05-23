/**
 * Regression tests: nested function parameters that shadow outer locals
 * must NOT be rewritten to `state.vars.x` at the declaration site (which
 * is a syntax error) NOR inside the function body (which silently breaks
 * lexical scope).
 *
 * Original bug: poker game.process.ts had a top-level `const players = ...`
 * plus a nested `async function playHand(players, deck, ...)`. The rewriter
 * walked every identifier and rewrote `players` everywhere in localVars,
 * including the parameter declaration site, emitting:
 *
 *   async function playHand(state.vars.players, state.vars.deck, ...) { ... }
 *
 * which is invalid JS (the `.` in `state.vars.players` is the parse error).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { compileProcessSource } from '../src/compiler/compile.js';

function parseAsJs(code: string): readonly ts.Diagnostic[] {
  const sf = ts.createSourceFile('out.js', code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  return (sf as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics ?? [];
}

describe('rewriter: nested function parameter shadowing', () => {
  it('does not rewrite parameter declaration sites of nested functions', () => {
    const source = `
      import { createProcess } from '@justscale/core/process'

      export const proc = createProcess({
        path: '/test/:id',
        inject: {},
        async handler({}, [id]) {
          const players = [{ name: 'a' }, { name: 'b' }];
          const deck = [1, 2, 3];

          async function playHand(players, deck, n) {
            return players.length + deck.length + n;
          }

          return await playHand(players, deck, 1);
        },
      })
    `;
    const result = compileProcessSource(source, 'test.process.ts');
    const out = result.outputText;

    const diagnostics = parseAsJs(out);
    const messages = diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n');
    assert.equal(diagnostics.length, 0, `compiled output had parse errors:\n${messages}\n--- output ---\n${out}`);

    assert.ok(
      !/function\s+\w+\s*\([^)]*state\.vars\./.test(out),
      `parameter list of a nested function contains state.vars.* — invalid JS:\n${out}`,
    );
    assert.ok(
      !/=>\s*[^{]*\bstate\.vars\.[a-zA-Z_$][\w$]*\s*[),]/.test(out)
        || !/\(\s*state\.vars\./.test(out),
      `arrow function parameter list contains state.vars.*:\n${out}`,
    );
  });

  it('does not rewrite shadowed parameter references inside the nested function body', () => {
    const source = `
      import { createProcess } from '@justscale/core/process'

      export const proc = createProcess({
        path: '/test/:id',
        inject: {},
        async handler({}, [id]) {
          const players = [{ name: 'outer' }];

          function withOwn(players) {
            return players.length;
          }

          return withOwn([{ name: 'inner' }]);
        },
      })
    `;
    const result = compileProcessSource(source, 'test.process.ts');
    const out = result.outputText;

    const diagnostics = parseAsJs(out);
    assert.equal(diagnostics.length, 0, `compiled output had parse errors\n${out}`);

    const fnMatch = out.match(/function\s+withOwn\s*\([^)]*\)\s*\{[\s\S]*?\n\s*\}/);
    assert.ok(fnMatch, `withOwn body not found in output:\n${out}`);
    assert.ok(
      !/state\.vars\.players/.test(fnMatch[0]),
      `inside withOwn the parameter 'players' was rewritten to state.vars.players:\n${fnMatch[0]}`,
    );
  });

  it('does not rewrite for-of loop variable shadowing an outer local', () => {
    const source = `
      import { createProcess } from '@justscale/core/process'

      export const proc = createProcess({
        path: '/test/:id',
        inject: {},
        async handler({}, [id]) {
          const item = 'outer';
          let total = 0;
          for (const item of [1, 2, 3]) {
            total += item;
          }
          return total;
        },
      })
    `;
    const result = compileProcessSource(source, 'test.process.ts');
    const out = result.outputText;
    const diagnostics = parseAsJs(out);
    assert.equal(diagnostics.length, 0, `compiled output had parse errors\n${out}`);

    assert.ok(
      !/for\s*\(\s*const\s+state\.vars\.item\b/.test(out),
      `for-of declaration site rewritten to state.vars.item:\n${out}`,
    );
    assert.ok(
      !/total\s*\+=\s*state\.vars\.item/.test(out),
      `for-of body reference to loop variable was rewritten:\n${out}`,
    );
  });

  // Block-scoped redeclarations would collapse onto the same `state.vars.x`
  // slot — the analyzer rejects them up front rather than miscompiling.
  it('rejects block-scoped const that shadows outer handler local', () => {
    const source = `
      import { createProcess } from '@justscale/core/process'

      export const proc = createProcess({
        path: '/test/:id',
        inject: {},
        async handler({}, [id]) {
          const x = 1;
          let result = 0;
          {
            const x = 99;
            result = x;
          }
          return result;
        },
      })
    `;
    const result = compileProcessSource(source, 'test.process.ts');
    const messages = result.diagnostics
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      .join('\n');
    assert.match(
      messages,
      /Variable 'x' shadows an outer process-handler local/,
      `expected ShadowedHandlerLocal diagnostic; got:\n${messages}`,
    );
  });

  it('handles arrow function parameter shadowing', () => {
    const source = `
      import { createProcess } from '@justscale/core/process'

      export const proc = createProcess({
        path: '/test/:id',
        inject: {},
        async handler({}, [id]) {
          const items = [1, 2, 3];

          const sum = (items) => items.reduce((a, b) => a + b, 0);

          return sum(items);
        },
      })
    `;
    const result = compileProcessSource(source, 'test.process.ts');
    const out = result.outputText;

    const diagnostics = parseAsJs(out);
    assert.equal(diagnostics.length, 0, `compiled output had parse errors\n${out}`);

    assert.ok(
      !/\(\s*state\.vars\.items\s*\)\s*=>/.test(out),
      `arrow's parameter declaration was rewritten to state.vars.items:\n${out}`,
    );
  });
});
