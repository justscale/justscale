/**
 * Regression test for the "naked break inside if-body of a race branch"
 * bug. The compiler used to preserve the `break;` verbatim, which in the
 * emitted code exits the compiled `switch(step)` but leaves `step`
 * unchanged, so the branch body runs forever on the next `while(true)`
 * iteration.
 *
 * The fix rewrites every unlabeled `break;` reachable through
 * `transformStatement` (i.e. inside the race branch's case body, but not
 * inside nested user-level `for`/`while`/`switch`) into
 * `step = <continuation>; continue main_loop;`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import ts from 'typescript';
import { analyzeHandler } from '../src/compiler/analyzer.js';
import {
  buildSteps,
  generateSwitchProcess,
  type SwitchCodeGenInput,
} from '../src/compiler/switch-codegen.js';
import { computeVersionHash } from '../src/compiler/step-hash.js';
import { createHandler, createTypeChecker } from './test-utils.js';

function generate(code: string): string {
  const handler = createHandler(code);
  const typeChecker = createTypeChecker();
  const analysis = analyzeHandler(handler, typeChecker);

  const input: SwitchCodeGenInput = {
    id: 'test-process',
    path: '/test/:testId',
    version: computeVersionHash(analysis),
    injectNode: undefined,
    handler,
    analysis,
  };

  const factory = ts.factory;
  const callExpr = generateSwitchProcess(factory, input);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const sourceFile = ts.createSourceFile('output.ts', '', ts.ScriptTarget.Latest, false);
  return printer.printNode(ts.EmitHint.Expression, callExpr, sourceFile);
}

function extractCaseBodies(code: string): Map<number, string> {
  const cases = new Map<number, string>();
  const caseRegex = /case (\d+):\s*\{/g;
  let match;
  while ((match = caseRegex.exec(code)) !== null) {
    const stepNum = parseInt(match[1], 10);
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    while (i < code.length && depth > 0) {
      if (code[i] === '{') depth++;
      if (code[i] === '}') depth--;
      i++;
    }
    cases.set(stepNum, code.slice(start, i - 1));
  }
  return cases;
}

describe('race branch body: naked break inside nested if', () => {
  it('rewrites unlabeled break in if-body to step=continuation; continue main_loop', () => {
    // Mirrors the chat-room pattern: a race branch with an early-exit
    // `break;` from inside an `if` guard, followed by normal work and a
    // trailing `break;`.
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.tick): {
            if (r.skip) {
              break;
            }
            break;
          }
        }
      }
    }`;
    const generated = generate(code);
    const cases = extractCaseBodies(generated);

    // Grab the branch step (the one that reads __raceResult and contains
    // the if-guard). It's the first case after the RACE_SUSPEND step.
    const branchCase = Array.from(cases.entries()).find(
      ([_, body]) => body.includes('__raceResult') && body.includes('if (')
    );
    assert.ok(branchCase, `couldn't locate the race-branch case in generated code:\n${generated}`);
    const [branchIdx, branchBody] = branchCase;

    // The if-body must NOT contain a bare "break;" that would fall out of
    // the compiled switch(step) - instead it must set step and continue
    // main_loop.
    const bareBreakInIf = /if\s*\([^)]+\)\s*\{\s*break\s*;?\s*\}/;
    assert.ok(
      !bareBreakInIf.test(branchBody),
      `case ${branchIdx} still has a naked \`if (...) { break; }\` that will infinite-loop:\n${branchBody}`,
    );

    // And the rewritten form must be present.
    assert.match(
      branchBody,
      /step\s*=\s*\d+;\s*continue main_loop/,
      `case ${branchIdx} should rewrite unlabeled break to step=continuation; continue main_loop:\n${branchBody}`,
    );
  });

  it('does not rewrite break inside a user-written for loop', () => {
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.tick): {
            for (const x of r.items) {
              if (x === 'stop') break;
            }
            break;
          }
        }
      }
    }`;
    const generated = generate(code);
    // The for-loop's `break` must still be a plain break (targeting the for).
    // Easiest check: the code must still contain a break inside a for-of.
    assert.match(
      generated,
      /for\s*\([^)]+\)\s*\{[^}]*\bbreak;[^}]*\}/,
      `for-loop break was incorrectly rewritten:\n${generated}`,
    );
  });
});
