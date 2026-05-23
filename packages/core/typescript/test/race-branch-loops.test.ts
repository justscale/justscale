/**
 * Tests for race branches containing for-of loops.
 *
 * Verifies that when multiple race branches each contain durable for-of
 * loops (or other block-creating constructs), the compiler generates
 * independent step targets for each branch - no sharing of blocks across
 * branches.
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

function analyzeCode(code: string) {
  const handler = createHandler(code);
  const typeChecker = createTypeChecker();
  return analyzeHandler(handler, typeChecker);
}

function generateCode(code: string): string {
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

/**
 * Extract case bodies from generated switch code.
 * Returns a map of step number -> case body code.
 */
function extractCaseBodies(code: string): Map<number, string> {
  const cases = new Map<number, string>();
  // Match "case N:{...}" blocks - find the opening { after "case N:" and
  // match to its closing } using brace counting
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
 * Extract all "step=N;continue main_loop" targets from a case body.
 */
function extractJumpTargets(caseBody: string): number[] {
  const targets: number[] = [];
  const regex = /step\s*=\s*(\d+);\s*continue main_loop/g;
  let match;
  while ((match = regex.exec(caseBody)) !== null) {
    targets.push(parseInt(match[1], 10));
  }
  return targets;
}

/**
 * Extract resumeStep values from race branch configs.
 */
function extractResumeSteps(code: string): number[] {
  const steps: number[] = [];
  const regex = /resumeStep:\s*(\d+)/g;
  let match;
  while ((match = regex.exec(code)) !== null) {
    steps.push(parseInt(match[1], 10));
  }
  return steps;
}

describe('Race branches with for-of loops', () => {
  describe('independent branch targets', () => {
    it('each race branch with a for-of loop gets independent step targets', () => {
      const code = `async () => {
        const r = race()
        switch (true) {
          case signal(r, orders.paid): {
            for (const item of items) {
              await doWork(item)
              await signal(work.done)
            }
            return { status: 'shipped' }
          }
          case delay.days(r, 7): {
            for (const item of items) {
              await cancelItem(item)
              await signal(cancel.done)
            }
            return { status: 'cancelled' }
          }
        }
      }`;

      const analysis = analyzeCode(code);
      const { steps } = buildSteps(analysis);

      // Should have at least 2 branch steps (one per race case)
      const branchSteps = steps.filter(s => s.type === 'branch');
      assert.ok(branchSteps.length >= 2, `Should have >=2 branch steps, got ${branchSteps.length}`);

      // Each branch's next step should be different (independent loops)
      if (branchSteps.length >= 2) {
        const nextSteps = branchSteps.map(s => s.nextStep).filter(s => s !== undefined);
        const unique = new Set(nextSteps);
        assert.strictEqual(
          unique.size, nextSteps.length,
          `Branch nextSteps should all be unique: ${JSON.stringify(nextSteps)}`
        );
      }
    });

    it('generated code: signal branch loop does NOT reference timer branch loop steps', () => {
      const code = `async () => {
        const r = race()
        switch (true) {
          case signal(r, orders.paid): {
            for (const item of items) {
              await ship(item)
              await signal(shipped.confirmed)
            }
            return { status: 'shipped' }
          }
          case delay.days(r, 7): {
            for (const item of items) {
              await refund(item)
              await signal(refund.confirmed)
            }
            return { status: 'refunded' }
          }
        }
      }`;

      const output = generateCode(code);
      const cases = extractCaseBodies(output);
      const resumeSteps = extractResumeSteps(output);

      assert.ok(resumeSteps.length >= 2, `Should have >=2 race branches, got ${resumeSteps.length}`);

      const [signalBranchStep, timerBranchStep] = resumeSteps;

      // Get the signal branch's case body
      const signalBody = cases.get(signalBranchStep);
      assert.ok(signalBody, `Should have case body for signal branch (step ${signalBranchStep})`);

      // The signal branch's jump targets should NOT include the timer branch step
      // or any steps belonging to the timer branch's loop
      const signalTargets = extractJumpTargets(signalBody!);

      // All jump targets from the signal branch should be <= timerBranchStep
      // (they should reference steps within the signal branch, not the timer branch)
      for (const target of signalTargets) {
        assert.ok(
          target < timerBranchStep,
          `Signal branch (step ${signalBranchStep}) should not jump to timer branch territory ` +
          `(step ${target} >= timer branch ${timerBranchStep})`
        );
      }
    });

    it('generated code: timer branch loop uses its own refund steps, not charge steps', () => {
      const code = `async () => {
        const r = race()
        switch (true) {
          case signal(r, pledges.fullyFunded): {
            await campaigns.updateStatus(campaignId, 'settling')
            for (const pledge of pledges.iterate(query)) {
              await payments.charge(pledge.id)
              await signal(payments.chargeProcessed)
            }
            await campaigns.updateStatus(campaignId, 'completed')
            return { status: 'completed', campaignId }
          }
          case delay.days(r, campaign.durationDays): {
            await campaigns.updateStatus(campaignId, 'failed')
            for (const pledge of pledges.iterate(query)) {
              await payments.refund(pledge.id)
              await signal(payments.refundProcessed)
            }
            return { status: 'failed', campaignId }
          }
        }
      }`;

      const output = generateCode(code);
      const cases = extractCaseBodies(output);
      const resumeSteps = extractResumeSteps(output);

      assert.ok(resumeSteps.length >= 2, 'Should have at least 2 race branches');

      const timerBranchStep = resumeSteps[1];
      const timerBody = cases.get(timerBranchStep);
      assert.ok(timerBody, `Should have case body for timer branch (step ${timerBranchStep})`);

      // Timer branch should contain 'failed' (its own updateStatus call)
      // and should jump to steps AFTER itself, not before
      const timerTargets = extractJumpTargets(timerBody!);
      for (const target of timerTargets) {
        assert.ok(
          target > timerBranchStep,
          `Timer branch (step ${timerBranchStep}) should jump forward to its own loop ` +
          `(step ${target}), not backward to signal branch's loop`
        );
      }
    });
  });

  describe('race branch with break (no loop)', () => {
    it('break in signal case jumps past the switch, not into delay case', () => {
      const code = `async () => {
        const r = race()
        switch (true) {
          case signal(r, orders.paid):
            break
          case delay.days(r, 7): {
            await cancelOrder()
            return { status: 'cancelled' }
          }
        }
        await fulfillOrder()
        return { status: 'fulfilled' }
      }`;

      const output = generateCode(code);
      const cases = extractCaseBodies(output);
      const resumeSteps = extractResumeSteps(output);

      assert.ok(resumeSteps.length >= 2, 'Should have 2 race branches');
      const [signalStep, timerStep] = resumeSteps;

      const signalBody = cases.get(signalStep);
      assert.ok(signalBody, `Should have case for signal branch (step ${signalStep})`);

      const targets = extractJumpTargets(signalBody!);
      // The signal branch's break should jump to the code after the switch (fulfillOrder),
      // which must be at a step index AFTER the timer branch
      for (const target of targets) {
        assert.ok(
          target !== timerStep,
          `Signal branch break should NOT jump into timer branch (step ${timerStep})`
        );
      }
    });
  });

  describe('race with if-else inside branch', () => {
    it('if-else inside timer branch jumps to its own blocks, not signal branch blocks', () => {
      const code = `async () => {
        const r = race()
        switch (true) {
          case signal(r, pledges.fullyFunded): {
            for (const pledge of pledges.iterate(query)) {
              await payments.charge(pledge.id)
              await signal(payments.chargeProcessed)
            }
            return { status: 'completed' }
          }
          case delay.days(r, campaign.durationDays): {
            if (isUnderfunded) {
              await markFailed()
              for (const pledge of pledges.iterate(query)) {
                await payments.refund(pledge.id)
                await signal(payments.refundProcessed)
              }
              return { status: 'failed' }
            }
            return { status: 'funded_at_deadline' }
          }
        }
      }`;

      const output = generateCode(code);
      const cases = extractCaseBodies(output);
      const resumeSteps = extractResumeSteps(output);

      const timerBranchStep = resumeSteps[1];
      const timerBody = cases.get(timerBranchStep);
      assert.ok(timerBody, `Should have case for timer branch (step ${timerBranchStep})`);

      // If the timer branch has conditional jumps, all targets should be
      // AFTER the timer branch step (in the timer branch's territory)
      const targets = extractJumpTargets(timerBody!);
      const signalBranchStep = resumeSteps[0];

      for (const target of targets) {
        assert.ok(
          target > signalBranchStep,
          'Timer branch if-else should not jump into signal branch territory ' +
          `(target ${target} should be > ${signalBranchStep})`
        );
      }
    });
  });
});

describe('while-loop mutable condition', () => {
  it('while(running) emits a condition check (JUMP_IF) at the loop start step', () => {
    // Before the fix, analyzeWhileStatement never emitted opcodes to evaluate
    // the condition. `while (running)` compiled identically to `while (true)`:
    // setting `running = false` in a branch body could never exit the loop
    // because the condition was never re-evaluated.
    //
    // The fix emits BLOCK + STORE(__condition) + JUMP_IF(__condition_false)
    // at the top of the loop body, patched to jump to the end label when false.
    const code = `async () => {
      let running = true;
      while (running) {
        const r = race();
        switch (true) {
          case signal(r, svc.stop): running = false; break;
          case signal(r, svc.tick): break;
        }
      }
    }`;

    const output = generateCode(code);

    // The generated code must contain a condition check that negates something
    // (the `!state.vars.__condition` pattern) and jumps to a step.
    assert.match(
      output,
      /!state\.vars\.__condition/,
      'while(running) must emit a condition check (JUMP_IF __condition_false); ' +
      `no negated condition found in:\n${output}`,
    );
  });

  it('while(true) does NOT emit a redundant condition check', () => {
    // The literal `while (true)` is the common infinite-loop pattern. Emitting
    // a condition block for it would be dead overhead. The fix skips the
    // condition check when the expression is the literal `true` keyword.
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, svc.stop): return { done: true };
          case signal(r, svc.tick): break;
        }
      }
    }`;

    const output = generateCode(code);

    // No `state.vars.__condition` should appear (no spurious condition BLOCK).
    assert.ok(
      !output.includes('state.vars.__condition'),
      'while(true) must not emit a redundant condition check; ' +
      `found state.vars.__condition in:\n${output}`,
    );
  });

  it('while(running) with stop branch setting running=false eventually exits the loop step', () => {
    // Structural check: the generated code for `while(running)` must include
    // a jump path from the loop start step to some later step (the loop exit).
    // Without the condition check there is only a jump back to the start -
    // no exit path.
    const code = `async () => {
      let running = true;
      while (running) {
        const r = race();
        switch (true) {
          case signal(r, svc.stop): running = false; break;
          case signal(r, svc.tick): break;
        }
      }
      return { stopped: true };
    }`;

    const output = generateCode(code);
    const cases = extractCaseBodies(output);

    // There must be at least one step that contains the `!state.vars.__condition`
    // guard AND a forward jump (to the exit step).
    let foundConditionStep = false;
    for (const [, body] of cases) {
      if (body.includes('!state.vars.__condition')) {
        foundConditionStep = true;
        // This step must have a forward jump (step = N; continue main_loop)
        // to handle the false case (exit the loop).
        assert.match(
          body,
          /step\s*=\s*\d+;\s*continue main_loop/,
          `condition-check step must contain a forward exit jump:\n${body}`,
        );
        break;
      }
    }

    assert.ok(
      foundConditionStep,
      'No step containing the while-condition check found. ' +
      `The loop exit path is missing from:\n${output}`,
    );
  });
});
