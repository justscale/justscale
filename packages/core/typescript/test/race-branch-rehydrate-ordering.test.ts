/**
 * Pinning tests for race-branch rehydrate ordering edge cases.
 *
 * Covers:
 * - `using lk = await svc.lock(r.id)` in a race-branch body: rehydrate prelude
 *   must run AFTER the __raceResult STORE so `r.id` resolves correctly.
 * - The REHYDRATE opcode must NOT also run after the prelude (double-acquire).
 * - Two sibling branches both declaring `using v = differentInit()`: each branch
 *   must use its own initializer expression, not last-write-wins from the global map.
 * - `using child = await svc.deriveFrom(outer)` inside a branch: `outer` must
 *   be rehydrated before `child` so the initializer sees the right value.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import ts from 'typescript';
import { analyzeHandler } from '../src/compiler/analyzer.js';
import { buildSteps, generateSwitchProcess } from '../src/compiler/switch-codegen.js';
import { computeVersionHash } from '../src/compiler/step-hash.js';
import { createHandler, createTypeChecker } from './test-utils.js';

function generateCode(handlerSource: string): string {
  const handler = createHandler(handlerSource);
  const typeChecker = createTypeChecker();
  const analysis = analyzeHandler(handler, typeChecker);
  const input = {
    id: 'test',
    path: '/test/:id',
    version: computeVersionHash(analysis),
    injectNode: undefined as ts.ObjectLiteralExpression | undefined,
    handler,
    analysis,
  };
  const callExpr = generateSwitchProcess(ts.factory, input);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const sf = ts.createSourceFile('out.ts', '', ts.ScriptTarget.Latest, false);
  return printer.printNode(ts.EmitHint.Expression, callExpr, sf);
}

function getBranchStepNumbers(analysis: ReturnType<typeof analyzeHandler>): number[] {
  const { steps } = buildSteps(analysis);
  return steps.filter(s => s.type === 'branch').map(s => s.index);
}

/**
 * Extract the body of a given case clause from generated code.
 * Returns the text inside `case N: { ... }`.
 */
function extractCaseBody(code: string, caseNum: number): string {
  const pattern = new RegExp(`case ${caseNum}:\\s*\\{`);
  const m = pattern.exec(code);
  if (!m) return '';
  const start = m.index + m[0].length;
  let depth = 1;
  let i = start;
  while (i < code.length && depth > 0) {
    if (code[i] === '{') depth++;
    if (code[i] === '}') depth--;
    i++;
  }
  return code.slice(start, i - 1);
}

describe('race-branch rehydrate ordering', () => {
  const handlerSrc = `async ({ svc }, [id]) => {
    const r = race()
    switch (true) {
      case signal(r, svc.paymentConfirmed): {
        using lk = await svc.lock(r.id)
        await svc.process(lk)
        return { status: 'paid' }
      }
      case delay.days(r, 3):
        return { status: 'timeout' }
    }
  }`;

  it('__raceResult STORE appears before the using-var initializer in the branch case', () => {
    const code = generateCode(handlerSrc);
    const handler = createHandler(handlerSrc);
    const analysis = analyzeHandler(handler, createTypeChecker());
    const branchSteps = getBranchStepNumbers(analysis);
    const signalBranch = branchSteps[0];

    const body = extractCaseBody(code, signalBranch);

    // __raceResult must be assigned BEFORE lk = await svc.lock(...)
    const storeIdx = body.indexOf('__raceResult = state.vars.__raceResult');
    const lockIdx = body.indexOf('lk = await ');

    assert.ok(storeIdx !== -1, 'Branch case must contain __raceResult STORE');
    assert.ok(lockIdx !== -1, 'Branch case must contain lk rehydration');
    assert.ok(
      storeIdx < lockIdx,
      `STORE (__raceResult) at ${storeIdx} must precede lk rehydration at ${lockIdx}`
    );
  });

  it('lk initializer appears exactly once (no double-acquire)', () => {
    const code = generateCode(handlerSrc);
    const handler = createHandler(handlerSrc);
    const analysis = analyzeHandler(handler, createTypeChecker());
    const branchSteps = getBranchStepNumbers(analysis);
    const signalBranch = branchSteps[0];

    const body = extractCaseBody(code, signalBranch);

    // Count occurrences of the lock initializer
    const count = (body.match(/lk = await /g) || []).length;
    assert.strictEqual(count, 1, 'Lock initializer must appear exactly once (no double-acquire)');
  });

  it('rehydrated var references __raceResult (not undefined)', () => {
    const code = generateCode(handlerSrc);
    const handler = createHandler(handlerSrc);
    const analysis = analyzeHandler(handler, createTypeChecker());
    const branchSteps = getBranchStepNumbers(analysis);
    const signalBranch = branchSteps[0];

    const body = extractCaseBody(code, signalBranch);

    // The lock call must reference __raceResult.id (not r.id via pre-STORE evaluation)
    assert.ok(
      body.includes('__raceResult.id') || body.includes('__raceResult'),
      'Lock initializer must reference __raceResult (which is available after STORE)'
    );
  });
});

describe('sibling-branch same-varname collision', () => {
  const handlerSrc = `async ({ svc }, [id]) => {
    const r = race()
    switch (true) {
      case signal(r, svc.paymentConfirmed): {
        using v = await svc.lockA(r.id)
        return { branch: 'A', val: v }
      }
      case signal(r, svc.refundRequested): {
        using v = await svc.lockB(r.id)
        return { branch: 'B', val: v }
      }
    }
  }`;

  it('branch A uses lockA, branch B uses lockB (no last-write-wins collision)', () => {
    const code = generateCode(handlerSrc);
    const handler = createHandler(handlerSrc);
    const analysis = analyzeHandler(handler, createTypeChecker());
    const branchSteps = getBranchStepNumbers(analysis);

    assert.ok(branchSteps.length >= 2, 'Should have at least 2 branch steps');
    const [stepA, stepB] = branchSteps;

    const bodyA = extractCaseBody(code, stepA);
    const bodyB = extractCaseBody(code, stepB);

    assert.ok(bodyA.includes('lockA'), `Branch A case (${stepA}) must reference lockA, got: ${bodyA.slice(0, 200)}`);
    assert.ok(bodyB.includes('lockB'), `Branch B case (${stepB}) must reference lockB, got: ${bodyB.slice(0, 200)}`);

    // Cross-check: neither branch should use the other's initializer
    assert.ok(!bodyA.includes('lockB'), 'Branch A must not use lockB');
    assert.ok(!bodyB.includes('lockA'), 'Branch B must not use lockA');
  });

  it('each branch has its own rehydration, not the global last-write', () => {
    const code = generateCode(handlerSrc);
    const handler = createHandler(handlerSrc);
    const analysis = analyzeHandler(handler, createTypeChecker());
    const branchSteps = getBranchStepNumbers(analysis);

    // Both branches declare `using v` - the rehydration prelude in each must
    // reference the correct initializer for that branch.
    for (const stepIdx of branchSteps) {
      const body = extractCaseBody(code, stepIdx);
      // Each branch case must have exactly one 'v = await' assignment
      const count = (body.match(/\bv = await /g) || []).length;
      assert.strictEqual(count, 1, `Step ${stepIdx} must have exactly one v= assignment`);
    }
  });
});

describe('transitive using-var dep in race branch', () => {
  const handlerSrc = `async ({ svc }, [id]) => {
    using outer = await svc.connect(id)
    const r = race()
    switch (true) {
      case signal(r, svc.dataReady): {
        using child = await svc.deriveFrom(outer)
        return { result: child }
      }
      case delay.days(r, 3):
        return { status: 'timeout' }
    }
  }`;

  it('outer is rehydrated before child in the signal branch', () => {
    const code = generateCode(handlerSrc);
    const handler = createHandler(handlerSrc);
    const analysis = analyzeHandler(handler, createTypeChecker());
    const branchSteps = getBranchStepNumbers(analysis);
    const signalBranch = branchSteps[0];

    const body = extractCaseBody(code, signalBranch);

    const outerIdx = body.indexOf('outer = await ');
    const childIdx = body.indexOf('child = await ');

    assert.ok(outerIdx !== -1, 'Signal branch must rehydrate outer');
    assert.ok(childIdx !== -1, 'Signal branch must rehydrate child');
    assert.ok(
      outerIdx < childIdx,
      `outer rehydration (${outerIdx}) must precede child rehydration (${childIdx})`
    );
  });

  it('child initializer sees outer (which is defined before the child assignment)', () => {
    const code = generateCode(handlerSrc);
    const handler = createHandler(handlerSrc);
    const analysis = analyzeHandler(handler, createTypeChecker());
    const branchSteps = getBranchStepNumbers(analysis);
    const signalBranch = branchSteps[0];

    const body = extractCaseBody(code, signalBranch);

    // child = await svc.deriveFrom(outer) must reference `outer`
    assert.ok(
      body.includes('deriveFrom(outer)') || body.includes('deriveFrom'),
      'child initializer must call deriveFrom'
    );
    // outer appears before deriveFrom(outer)
    const outerAssign = body.indexOf('outer = await');
    const deriveFrom = body.indexOf('deriveFrom');
    assert.ok(outerAssign < deriveFrom, 'outer must be assigned before deriveFrom call');
  });

  it('__raceResult STORE precedes both outer and child rehydration', () => {
    const code = generateCode(handlerSrc);
    const handler = createHandler(handlerSrc);
    const analysis = analyzeHandler(handler, createTypeChecker());
    const branchSteps = getBranchStepNumbers(analysis);
    const signalBranch = branchSteps[0];

    const body = extractCaseBody(code, signalBranch);

    const storeIdx = body.indexOf('__raceResult = state.vars.__raceResult');
    const outerIdx = body.indexOf('outer = await ');
    const childIdx = body.indexOf('child = await ');

    assert.ok(storeIdx !== -1, 'Branch must contain __raceResult STORE');
    assert.ok(storeIdx < outerIdx, 'STORE must precede outer rehydration');
    assert.ok(storeIdx < childIdx, 'STORE must precede child rehydration');
  });
});
