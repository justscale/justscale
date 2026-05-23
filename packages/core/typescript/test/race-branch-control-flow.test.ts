/**
 * Control flow inside race-branch bodies.
 *
 * Adjacent coverage for the "naked break inside if-body of a race branch"
 * regression (see race-branch-break-in-if.test.ts). That fix only rewrites
 * unlabeled break; this file locks down every control-flow shape a user can
 * write inside a race branch body and verifies the compiler either:
 *   - rewrites it to `step = <continuation>; continue main_loop;` (for
 *     unlabeled break reachable through transformStatement), OR
 *   - preserves it verbatim (for break inside user-written for/while/switch,
 *     for labeled break, and for return which has its own __r[0]=0 rewrite).
 *
 * Also locks down the return-value path: a return inside a race branch
 * must set __r[0]=0 (DONE), stash the value on __r[1], and break main_loop.
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

/**
 * Find the step whose body contains both __raceResult and the given needle.
 * Race branch bodies always load __raceResult; the needle disambiguates
 * between sibling branches.
 */
function findBranchByContent(code: string, needle: string | RegExp): [number, string] {
  const cases = extractCaseBodies(code);
  const pred = typeof needle === 'string'
    ? (body: string) => body.includes(needle)
    : (body: string) => needle.test(body);
  const entry = Array.from(cases.entries()).find(
    ([, body]) => body.includes('__raceResult') && pred(body),
  );
  if (!entry) {
    throw new assert.AssertionError({
      message: `couldn't locate branch containing ${needle} in:\n${code}`,
    });
  }
  return entry;
}

describe('race-branch control flow: break variants', () => {
  it('break inside if/else (both branches break) rewrites both arms', () => {
    // Both the then and else arms contain `break;`. Each should become a
    // jump to the race continuation step - not a naked `break;` that would
    // fall out of `switch(step)` and spin the outer `while(true)`.
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.tick): {
            if (r.skip) {
              break;
            } else {
              break;
            }
          }
        }
      }
    }`;
    const generated = generate(code);
    const [, branchBody] = findBranchByContent(generated, /if \(.*skip/);

    // No naked `break;` should remain inside the if/else arms.
    const nakedBreakInArm = /\{\s*break;?\s*\}/;
    assert.ok(
      !nakedBreakInArm.test(branchBody),
      `naked \`{ break; }\` still present in if/else arms:\n${branchBody}`,
    );

    // Both arms should have a step=continuation jump.
    const jumpCount = (branchBody.match(/step\s*=\s*\d+;\s*continue main_loop/g) ?? []).length;
    assert.ok(
      jumpCount >= 2,
      `expected >=2 step=…; continue main_loop jumps (one per arm), got ${jumpCount}:\n${branchBody}`,
    );
  });

  it('break inside else-if ladder is rewritten', () => {
    // The `break` is nested in the else-if's own then-body. transformStatement
    // recurses through else-if nodes, so this should also be rewritten.
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.tick): {
            if (r.skip) {
              await svc.skipped();
            } else if (r.bad) {
              break;
            }
            break;
          }
        }
      }
    }`;
    const generated = generate(code);
    const [, branchBody] = findBranchByContent(generated, 'skipped');

    // The else-if body's break must NOT remain as naked `break;`.
    const elseIfNakedBreak = /if \(__raceResult\.bad\)\s*\{\s*break;?\s*\}/;
    assert.ok(
      !elseIfNakedBreak.test(branchBody),
      `else-if body still has naked \`break;\` that would exit switch(step):\n${branchBody}`,
    );

    // Locate the `if (__raceResult.bad)` then-body and check it contains
    // a jump, not a naked break.
    const m = branchBody.match(/if \(__raceResult\.bad\)\s*\{([\s\S]*?)\}/);
    assert.ok(m, `couldn't find else-if body:\n${branchBody}`);
    assert.match(
      m![1],
      /step\s*=\s*\d+;\s*continue main_loop/,
      `else-if body should contain step=continuation jump:\n${m![1]}`,
    );
  });

  it('break inside if-nested-in-if (two levels deep) is rewritten', () => {
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.tick): {
            if (r.skip) {
              if (r.reason === 'user') {
                break;
              }
            }
            break;
          }
        }
      }
    }`;
    const generated = generate(code);
    const [, branchBody] = findBranchByContent(generated, 'reason');

    // The innermost if's break must be rewritten.
    const innerMatch = branchBody.match(/if \(__raceResult\.reason === "user"\)\s*\{([\s\S]*?)\}/);
    assert.ok(innerMatch, `couldn't find inner if:\n${branchBody}`);
    assert.match(
      innerMatch![1],
      /step\s*=\s*\d+;\s*continue main_loop/,
      `inner if-body's break should be rewritten to step=continuation jump:\n${innerMatch![1]}`,
    );
    // Defence-in-depth: no naked `break;` on its own line.
    assert.ok(
      !/if \(__raceResult\.reason === "user"\)\s*\{\s*break;?\s*\}/.test(branchBody),
      `inner if still has naked \`break;\`:\n${branchBody}`,
    );
  });

  it('does not rewrite break inside a user-written for-of loop body', () => {
    // Adjacent to the existing test - this one just asserts the rewritten
    // case body still contains a `for (const x of __raceResult.items)` with
    // a nested `break;` (targeting the for, not the outer switch(step)).
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

    // The for-of must remain, with the `break;` verbatim inside it.
    assert.match(
      generated,
      /for \(const x of __raceResult\.items\)[\s\S]*?if \(x === "stop"\)\s*\n?\s*break;/,
      `for-of loop's break was incorrectly rewritten or removed:\n${generated}`,
    );
  });

  it('does not rewrite break inside a user-written switch', () => {
    // case 'a': break; and case 'b': break; must stay exactly as written -
    // they target the user's own switch statement.
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.tick): {
            switch (r.kind) {
              case 'a': break;
              case 'b': break;
            }
            break;
          }
        }
      }
    }`;
    const generated = generate(code);
    const [, branchBody] = findBranchByContent(generated, /switch \(__raceResult\.kind\)/);

    // Each inner case's break must remain as a bare `break;` (not rewritten).
    const innerMatches = branchBody.match(/case "[ab]":\s*break;?/g);
    assert.ok(
      innerMatches && innerMatches.length === 2,
      `inner switch cases should both end in bare break;, got: ${JSON.stringify(innerMatches)}\n${branchBody}`,
    );
  });

  it('preserves labeled break that targets a user-written outer loop', () => {
    // `break outer;` must stay verbatim - the label targets the user's
    // labeled for-of, not the compiled switch(step).
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.tick): {
            outer: for (const x of r.items) {
              for (const y of x) {
                if (y === 'stop') break outer;
              }
            }
            break;
          }
        }
      }
    }`;
    const generated = generate(code);
    assert.match(
      generated,
      /break outer;/,
      `labeled \`break outer;\` should be preserved verbatim:\n${generated}`,
    );
  });
});

describe('race-branch control flow: continue variants', () => {
  it('naked `continue;` inside if-body of a race branch is rewritten to step=continuation; continue main_loop', () => {
    // Same class as the break-in-if bug. An unlabeled `continue;` inside an
    // if-body of a race branch would (before the fix) fall through
    // `transformStatement` unchanged. At runtime it executes `continue;`
    // inside the compiled `switch(step)`, which restarts `main_loop` with
    // `step` still equal to the branch step - re-entering the same branch
    // body immediately. Infinite loop.
    //
    // The fix adds a `continueTarget` parallel to `breakTarget` in
    // RewriterContext and rewrites unlabeled `continue;` the same way:
    // `step = <continuation>; continue main_loop;`.
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.tick): {
            if (r.skip) {
              continue;
            }
            break;
          }
        }
      }
    }`;
    const generated = generate(code);
    const [, branchBody] = findBranchByContent(generated, /if \(__raceResult\.skip\)/);

    // The if-body must not contain a naked `continue;` - it should be
    // rewritten to `step = <continuation>; continue main_loop`.
    const naked = /if \(__raceResult\.skip\)\s*\{\s*continue;?\s*\}/;
    assert.ok(
      !naked.test(branchBody),
      'naked `continue;` inside if-body of race branch was preserved - ' +
      `will infinite-loop at runtime (step stays at branch index). Body:\n${branchBody}`,
    );

    // The if-body should contain a step=continuation jump.
    const m = branchBody.match(/if \(__raceResult\.skip\)\s*\{([\s\S]*?)\}/);
    assert.ok(m, `couldn't find if-body:\n${branchBody}`);
    assert.match(
      m![1],
      /step\s*=\s*\d+;\s*continue main_loop/,
      `if-body should be rewritten to step=<continuation>; continue main_loop:\n${m![1]}`,
    );
  });

  it('continue inside else-if arm of a race branch is rewritten', () => {
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.tick): {
            if (r.skip) {
              await svc.skipped();
            } else if (r.stop) {
              continue;
            }
            break;
          }
        }
      }
    }`;
    const generated = generate(code);
    const [, branchBody] = findBranchByContent(generated, 'skipped');

    // The else-if body's continue must not remain as naked `continue;`.
    const elseIfNaked = /if \(__raceResult\.stop\)\s*\{\s*continue;?\s*\}/;
    assert.ok(
      !elseIfNaked.test(branchBody),
      `else-if body still has naked \`continue;\` that would restart main_loop at same step:\n${branchBody}`,
    );

    const m = branchBody.match(/if \(__raceResult\.stop\)\s*\{([\s\S]*?)\}/);
    assert.ok(m, `couldn't find else-if body:\n${branchBody}`);
    assert.match(
      m![1],
      /step\s*=\s*\d+;\s*continue main_loop/,
      `else-if body should contain step=continuation jump:\n${m![1]}`,
    );
  });
});

/**
 * Brace-counting scan: grab the body of `if (<pattern>)` by walking after
 * the opening `{` and tracking nesting depth. Regex can't handle the
 * `__r[1] = { status: '…' }` object literal inside the if-body.
 */
function extractIfBody(code: string, conditionPattern: RegExp): string | undefined {
  const m = code.match(conditionPattern);
  if (!m || m.index === undefined) return undefined;
  // Find the next `{` after the if header.
  const headerEnd = m.index + m[0].length;
  const braceIdx = code.indexOf('{', headerEnd);
  if (braceIdx < 0) return undefined;
  let depth = 1;
  let i = braceIdx + 1;
  while (i < code.length && depth > 0) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}') depth--;
    i++;
  }
  return code.slice(braceIdx + 1, i - 1);
}

describe('race-branch control flow: return variants', () => {
  it('`return value;` inside a race branch sets __r[0]=0 and stashes the value', () => {
    // The current compiler routes the return through __blockResult first
    // (the return statement lives inside a BLOCK, so `return expr` ->
    // `__blockResult = expr`, followed by a later RETURN opcode that does
    // `__r[1] = __blockResult`). Either shape is acceptable as long as the
    // value ends up on __r[1] before `break main_loop`.
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.done): {
            return { status: 'done', id: r.id };
          }
        }
      }
    }`;
    const generated = generate(code);
    const [, branchBody] = findBranchByContent(generated, 'status');

    // DONE flag
    assert.match(
      branchBody,
      /__r\[0\]\s*=\s*0/,
      `return in race branch must set __r[0]=0 (DONE):\n${branchBody}`,
    );
    // Return expression must appear somewhere in the body (either directly
    // assigned to __r[1] or to __blockResult).
    assert.match(
      branchBody,
      /status:\s*["']done["']/,
      `return in race branch must include the return expression in emitted code:\n${branchBody}`,
    );
    // And __r[1] must be set (either = __blockResult or = literal).
    assert.match(
      branchBody,
      /__r\[1\]\s*=/,
      `return in race branch must assign to __r[1]:\n${branchBody}`,
    );
    // Must break main_loop so the outer while(true) actually exits.
    assert.match(
      branchBody,
      /break main_loop/,
      `return in race branch must break main_loop:\n${branchBody}`,
    );
  });

  it('`return value;` inside an if-body of a race branch still produces DONE + value + break main_loop', () => {
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.done): {
            if (r.err) {
              return { status: 'failed', reason: r.err };
            }
            break;
          }
        }
      }
    }`;
    const generated = generate(code);
    const [, branchBody] = findBranchByContent(generated, 'failed');

    const ifBody = extractIfBody(branchBody, /if \(__raceResult\.err\)\s*/);
    assert.ok(ifBody !== undefined, `couldn't find if-body around the return:\n${branchBody}`);
    assert.match(ifBody!, /__r\[0\]\s*=\s*0/, `if-body should set __r[0]=0:\n${ifBody}`);
    assert.match(ifBody!, /__r\[1\]\s*=/, `if-body should set __r[1]:\n${ifBody}`);
    assert.match(ifBody!, /break main_loop/, `if-body should break main_loop:\n${ifBody}`);
    // And the return value (reason: __raceResult.err) must be carried into the emitted code.
    assert.match(
      ifBody!,
      /reason:\s*__raceResult\.err/,
      `if-body should carry the return payload:\n${ifBody}`,
    );
  });

  it('bare `return;` (no value) still terminates the process cleanly', () => {
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.stop): {
            return;
          }
        }
      }
    }`;
    const generated = generate(code);
    const [, branchBody] = findBranchByContent(generated, /__r\[0\]\s*=\s*0/);

    assert.match(branchBody, /__r\[0\]\s*=\s*0/, `bare return must set DONE flag:\n${branchBody}`);
    // Bare return emits `__blockResult = undefined;` followed by
    // `__r[1] = __blockResult;` - an `undefined` must appear in the body
    // and flow into __r[1].
    assert.match(
      branchBody,
      /(__blockResult\s*=\s*undefined|__r\[1\]\s*=\s*undefined)/,
      `bare return must route \`undefined\` through either __blockResult or __r[1]:\n${branchBody}`,
    );
    assert.match(branchBody, /__r\[1\]\s*=/, `bare return must assign __r[1]:\n${branchBody}`);
    assert.match(branchBody, /break main_loop/, `bare return must break main_loop:\n${branchBody}`);
  });
});
