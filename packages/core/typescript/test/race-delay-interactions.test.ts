/**
 * `delay` primitive interactions inside `race()`.
 *
 * The `delay.<unit>(r, n)` form registers a timer as a race branch that
 * fires after `n` unit-durations. These tests lock down several shapes
 * that were not directly covered by the four fixes but are adjacent
 * to the race-branch codegen paths those fixes touched:
 *
 *   - `delay` as the *only* branch (no signal branch)
 *   - multiple `delay` branches in one race (first-fires-wins)
 *   - `delay.<unit>(r, expr)` where expr comes from a prior signal's
 *     payload (outer `using`-rehydration dependency chain)
 *   - mixed `signal` + `delay` branches with side effects in each
 *
 * Assertions verify that the emitted `__raceBranches` descriptor contains
 * a `timer:` entry with the right duration key (seconds/minutes/hours/days),
 * and that every branch has an independent `resumeStep`.
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

/** Extract every race-branch descriptor entry as raw text. */
function extractBranchDescriptors(code: string): string[] {
  const descriptors: string[] = [];
  const braces = /\{\s*id:\s*"[^"]+",[\s\S]*?resumeStep:\s*\d+\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = braces.exec(code)) !== null) {
    descriptors.push(m[0]);
  }
  return descriptors;
}

describe('delay in race branches: shapes', () => {
  it('`delay.hours(r, 1)` as the only branch emits a single timer descriptor', () => {
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case delay.hours(r, 1): {
            await svc.hourly();
            break;
          }
        }
      }
    }`;
    const generated = generate(code);
    const descriptors = extractBranchDescriptors(generated);

    assert.strictEqual(
      descriptors.length, 1,
      `expected exactly 1 branch descriptor for the timer, got ${descriptors.length}:\n${generated}`,
    );
    assert.match(
      descriptors[0],
      /timer:\s*\{\s*hours:\s*1\s*\}/,
      `descriptor must include \`timer: { hours: 1 }\`:\n${descriptors[0]}`,
    );
    assert.match(
      descriptors[0],
      /id:\s*"__timer__"/,
      `timer-only branch id should be \`__timer__\`:\n${descriptors[0]}`,
    );
  });

  it('multiple delays in one race each get their own descriptor with unique resumeStep', () => {
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case delay.seconds(r, 5): {
            await svc.short();
            break;
          }
          case delay.minutes(r, 1): {
            await svc.long();
            break;
          }
        }
      }
    }`;
    const generated = generate(code);
    const descriptors = extractBranchDescriptors(generated);

    assert.strictEqual(
      descriptors.length, 2,
      `expected 2 timer descriptors, got ${descriptors.length}:\n${generated}`,
    );

    // Two distinct timer units.
    assert.ok(
      descriptors.some(d => /seconds:\s*5/.test(d)),
      `missing \`seconds: 5\` descriptor:\n${descriptors.join('\n')}`,
    );
    assert.ok(
      descriptors.some(d => /minutes:\s*1/.test(d)),
      `missing \`minutes: 1\` descriptor:\n${descriptors.join('\n')}`,
    );

    // resumeSteps must differ.
    const steps = descriptors.map(d => {
      const m = d.match(/resumeStep:\s*(\d+)/);
      return m ? parseInt(m[1], 10) : -1;
    });
    assert.strictEqual(
      new Set(steps).size,
      steps.length,
      `each timer descriptor must have a unique resumeStep, got ${steps}:\n${generated}`,
    );
  });

  it('mixed signal + delay branches emit both a signal descriptor and a timer descriptor', () => {
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.paid): {
            await svc.ship();
            break;
          }
          case delay.days(r, 7): {
            await svc.cancel();
            break;
          }
        }
      }
    }`;
    const generated = generate(code);
    const descriptors = extractBranchDescriptors(generated);

    assert.strictEqual(
      descriptors.length, 2,
      `expected 1 signal + 1 timer descriptor, got ${descriptors.length}:\n${generated}`,
    );
    assert.ok(
      descriptors.some(d => /signal:\s*deps\.signals\.paid/.test(d)),
      `missing signal descriptor for paid:\n${descriptors.join('\n')}`,
    );
    assert.ok(
      descriptors.some(d => /timer:\s*\{\s*days:\s*7\s*\}/.test(d)),
      `missing timer descriptor for delay.days(r, 7):\n${descriptors.join('\n')}`,
    );
  });

  it('`delay.seconds(r, expr)` with expr from an outer `using` payload is captured as-is (no hoisting)', () => {
    // The timer value references an outer `using`-var (`cfg.timeout`).
    // The emitted descriptor should include the raw expression - the
    // runtime resolves it by looking up `cfg` from state. This test
    // asserts the expression is neither dropped nor rewritten into a
    // mysterious `undefined`.
    const code = `async () => {
      using cfg = await svc.getConfig();
      while (true) {
        const r = race();
        switch (true) {
          case delay.seconds(r, cfg.timeout): {
            await svc.timedOut();
            break;
          }
        }
      }
    }`;
    const generated = generate(code);
    const descriptors = extractBranchDescriptors(generated);

    assert.strictEqual(
      descriptors.length, 1,
      `expected 1 timer descriptor, got ${descriptors.length}:\n${generated}`,
    );
    assert.match(
      descriptors[0],
      /timer:\s*\{\s*seconds:\s*cfg\.timeout\s*\}/,
      `timer descriptor must contain the \`cfg.timeout\` expression verbatim:\n${descriptors[0]}`,
    );
  });

  it('each delay unit keyword (seconds/minutes/hours/days) is emitted with the matching key', () => {
    // Table-driven: every supported unit should round-trip through the
    // compiler and land in the timer descriptor under the same key.
    const units: Array<[string, string]> = [
      ['seconds', '30'],
      ['minutes', '5'],
      ['hours', '2'],
      ['days', '14'],
    ];

    for (const [unit, value] of units) {
      const code = `async () => {
        while (true) {
          const r = race();
          switch (true) {
            case delay.${unit}(r, ${value}): {
              await svc.fire();
              break;
            }
          }
        }
      }`;
      const generated = generate(code);
      const descriptors = extractBranchDescriptors(generated);
      assert.strictEqual(
        descriptors.length, 1,
        `[${unit}] expected 1 descriptor, got ${descriptors.length}:\n${generated}`,
      );
      const re = new RegExp(`timer:\\s*\\{\\s*${unit}:\\s*${value}\\s*\\}`);
      assert.match(
        descriptors[0],
        re,
        `[${unit}] descriptor missing \`timer: { ${unit}: ${value} }\`:\n${descriptors[0]}`,
      );
    }
  });
});
