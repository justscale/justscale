/**
 * Loop interactions around race().
 *
 * The most common durable-process shape is:
 *
 *   while (true) {
 *     const r = race();
 *     switch (true) { case signal(...): ... }
 *   }
 *
 * The break-in-if and fallthrough-in-while-true fixes both targeted this
 * shape. Tests here cover:
 *
 *  - the canonical `while (true) { race }` - branch continuation loops
 *    back to the race-suspend step, not off the end of the compiled switch
 *  - nested `while (true) { while (!done) { race } }` - double-loop
 *    continuation: inner branch must loop back to the inner while's start,
 *    and the inner while's exit must route to the outer while's start
 *  - a `for` loop OUTSIDE the race is preserved verbatim (no step splitting
 *    required because it contains no suspension points)
 *  - `while (cond)` where cond is a local variable mutated inside a branch:
 *    analyzer emits a per-iteration condition check that re-reads the live
 *    variable (state.vars.keep) and jumps to the loop-end label when false,
 *    so a branch that sets `keep = false` exits cleanly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import ts from 'typescript';
import { analyzeHandler } from '../src/compiler/analyzer.js';
import {
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
    id: 'test',
    path: '/test',
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

function extractJumpTargets(body: string): number[] {
  const targets: number[] = [];
  const re = /step\s*=\s*(\d+);\s*continue main_loop/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    targets.push(parseInt(m[1], 10));
  }
  return targets;
}

describe('race + loop interactions', () => {
  it('`while (true) { race }` - branch continuation jumps back to the race-suspend step', () => {
    // Canonical pattern. The fallthrough-in-while-true fix ensures the
    // branch body finishes with `step = <continuation>; continue main_loop;`
    // instead of falling off the case and restarting at step 0 (which
    // would re-run any pre-race setup every iteration).
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.tick): {
            await svc.work();
            break;
          }
        }
      }
    }`;
    const generated = generate(code);
    const cases = extractCaseBodies(generated);

    // Locate the race-suspend step: the one with `__raceBranches =` and
    // `break main_loop;`.
    const suspendEntry = Array.from(cases.entries()).find(
      ([, body]) => body.includes('__raceBranches = [') && body.includes('break main_loop'),
    );
    assert.ok(suspendEntry, `couldn't locate race-suspend step:\n${generated}`);
    const [suspendStep] = suspendEntry!;

    // Locate the branch body.
    const branchEntry = Array.from(cases.entries()).find(
      ([idx, body]) => idx !== suspendStep && body.includes('__raceResult') && body.includes('svc.work'),
    );
    assert.ok(branchEntry, `couldn't locate branch body:\n${generated}`);
    const [, branchBody] = branchEntry!;

    // The branch body's trailing continuation must eventually route back
    // to the suspendStep - possibly via a continuation step. We check the
    // transitive chain.
    const visited = new Set<number>();
    const queue: number[] = extractJumpTargets(branchBody);
    let routedBack = false;
    while (queue.length) {
      const t = queue.shift()!;
      if (visited.has(t)) continue;
      visited.add(t);
      if (t === suspendStep) { routedBack = true; break; }
      const next = cases.get(t);
      if (next) queue.push(...extractJumpTargets(next));
    }
    assert.ok(
      routedBack,
      `branch continuation chain must eventually jump back to the race-suspend step (${suspendStep}):\n${generated}`,
    );
  });

  it('nested `while (true) { while (!done) { race } }` - inner branch loops to inner race, outer loop wraps inner', () => {
    // Two concentric while-trues. After the inner race's branch body,
    // step must route back to the inner race's suspend step (not the
    // outer loop's top). We don't prescribe a specific step layout -
    // just that the control flow chain from the branch body eventually
    // re-enters the race-suspend step.
    const code = `async () => {
      while (true) {
        while (true) {
          const r = race();
          switch (true) {
            case signal(r, deps.signals.tick): {
              await svc.tick();
              break;
            }
          }
        }
      }
    }`;
    const generated = generate(code);
    const cases = extractCaseBodies(generated);

    const suspendEntry = Array.from(cases.entries()).find(
      ([, body]) => body.includes('__raceBranches = [') && body.includes('break main_loop'),
    );
    assert.ok(suspendEntry, `couldn't locate race-suspend step:\n${generated}`);
    const [suspendStep] = suspendEntry!;

    const branchEntry = Array.from(cases.entries()).find(
      ([idx, body]) => idx !== suspendStep && body.includes('__raceResult') && body.includes('svc.tick'),
    );
    assert.ok(branchEntry, `couldn't locate branch body:\n${generated}`);
    const [, branchBody] = branchEntry!;

    // Transitive continuation chain must reach suspendStep.
    const visited = new Set<number>();
    const queue = extractJumpTargets(branchBody);
    let routedBack = false;
    while (queue.length) {
      const t = queue.shift()!;
      if (visited.has(t)) continue;
      visited.add(t);
      if (t === suspendStep) { routedBack = true; break; }
      const next = cases.get(t);
      if (next) queue.push(...extractJumpTargets(next));
    }
    assert.ok(
      routedBack,
      `nested while(true): inner branch must route back to the inner race-suspend step (${suspendStep}):\n${generated}`,
    );
  });

  it('a `for-of` loop OUTSIDE a race body is preserved verbatim (no step splitting)', () => {
    // The for loop contains no suspension points, so the analyzer keeps
    // it as a single statement inside the preceding block. Verification:
    // the emitted code still contains `for (const x of items)` literally.
    const code = `async () => {
      const items = [1, 2, 3];
      for (const x of items) {
        // Pure synchronous work, no await.
        state.total = (state.total ?? 0) + x;
      }
      const r = race();
      switch (true) {
        case signal(r, deps.signals.done): {
          return { total: state.total };
        }
      }
    }`;
    const generated = generate(code);

    assert.match(
      generated,
      /for \(const x of [\s\S]*?items\)/,
      `synchronous for-of loop outside race must be preserved verbatim:\n${generated}`,
    );
  });

  it('`while (cond)` where cond is a local mutated inside a branch - emits a per-iteration condition check', () => {
    // Without a condition check the loop is identical to `while (true)`:
    // the branch that sets `keep = false` would re-enter the race forever.
    // The analyzer now emits, per iteration:
    //   __blockResult = state.vars.keep;
    //   state.vars.__condition = __blockResult;
    //   if (!state.vars.__condition) { step = <exit>; continue main_loop; }
    // We assert both halves: the live var is re-read each iteration AND the
    // negated guard jumps somewhere on falsy.
    const code = `async () => {
      let keep = true;
      while (keep) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.stop): {
            keep = false;
            break;
          }
          case signal(r, deps.signals.tick): {
            break;
          }
        }
      }
    }`;
    const generated = generate(code);

    assert.match(
      generated,
      /=\s*state\.vars\.keep/,
      `expected the loop body to re-read \`state.vars.keep\` each iteration:\n${generated}`,
    );
    assert.match(
      generated,
      /if\s*\(\s*!\s*state\.vars\.__condition\s*\)/,
      `expected a negated guard on the stored condition that exits the loop:\n${generated}`,
    );
  });
});
