/**
 * Regression tests for destructuring awaited service calls inside race branches.
 *
 * `const { a, b } = await svc.x()` previously dropped the entire await call;
 * a and b were always undefined.
 *
 * Same failure mode for array destructuring: `const [a, b] = await svc.x()`.
 *
 * Fix: the analyzer emits a BLOCK containing
 *   __blockResult = await svc.x()
 *   a = __blockResult.a  (or __blockResult[0])
 *   b = __blockResult.b  (or __blockResult[1])
 * Because a/b are registered as localVars, the rewriter turns the per-name
 * assignments into state.vars.a = __blockResult.a etc.
 *
 * Note: nested binding patterns (e.g. `const { a: { x } } = ...`) and rest
 * elements (`const [head, ...tail] = ...`) are deferred - the analyzer emits
 * nothing for those sub-patterns and their names will be undefined at runtime.
 * Document them here so they're easy to find when implementing later.
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

// ---------------------------------------------------------------------------
// object destructuring
// ---------------------------------------------------------------------------

describe('object destructuring of awaited service call in race branch', () => {
  it('emits `__blockResult = await call()` before per-property state.vars assignments', () => {
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.orderPlaced): {
            const { userId, amount } = await payments.resolve(r.orderId);
            await deps.signals.chargeDone({ userId, amount });
            break;
          }
        }
      }
    }`;

    const generated = generate(code);

    // The BLOCK body must contain the await call assigned to __blockResult.
    assert.match(
      generated,
      /__blockResult\s*=\s*await\s+(services\.)?payments\.resolve/,
      `expected \`__blockResult = await payments.resolve(...)\`:\n${generated}`,
    );

    // Both destructured names must be written to state.vars from __blockResult.
    // The rewriter can't safely walk into property-name identifiers on synthetic nodes,
    // so the analyzer uses bracket notation with string literals for object properties.
    assert.match(
      generated,
      /state\.vars\.userId\s*=\s*__blockResult\[["']userId["']\]/,
      `expected \`state.vars.userId = __blockResult['userId']\`:\n${generated}`,
    );
    assert.match(
      generated,
      /state\.vars\.amount\s*=\s*__blockResult\[["']amount["']\]/,
      `expected \`state.vars.amount = __blockResult['amount']\`:\n${generated}`,
    );

    // Order: assign __blockResult before reading it.
    const awaitIdx = generated.search(/__blockResult\s*=\s*await\s+(services\.)?payments/);
    const userIdx  = generated.search(/state\.vars\.userId\s*=\s*__blockResult/);
    const amtIdx   = generated.search(/state\.vars\.amount\s*=\s*__blockResult/);
    assert.ok(awaitIdx >= 0 && userIdx > awaitIdx && amtIdx > awaitIdx,
      `__blockResult assignment must precede state.vars extractions (await@${awaitIdx} userId@${userIdx} amount@${amtIdx})`,
    );
  });

  it('handles aliased property bindings: const { foo: bar } = await svc.x()', () => {
    const code = `async () => {
      const r = race();
      switch (true) {
        case signal(r, deps.signals.done): {
          const { foo: bar } = await svc.get();
          break;
        }
      }
    }`;

    const generated = generate(code);

    // __blockResult must be assigned.
    assert.match(generated, /__blockResult\s*=\s*await\s+(services\.)?svc\.get/,
      `expected \`__blockResult = await svc.get(...)\`:\n${generated}`);

    // The local name is `bar`, the property is `foo`:
    //   state.vars.bar = __blockResult['foo']
    assert.match(generated, /state\.vars\.bar\s*=\s*__blockResult\[["']foo["']\]/,
      `expected \`state.vars.bar = __blockResult['foo']\`:\n${generated}`);
  });
});

// ---------------------------------------------------------------------------
// array destructuring
// ---------------------------------------------------------------------------

describe('array destructuring of awaited service call in race branch', () => {
  it('emits `__blockResult = await call()` then index-based state.vars assignments', () => {
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.dataSent): {
            const [first, second] = await parser.split(r.payload);
            await deps.signals.parsed({ first, second });
            break;
          }
        }
      }
    }`;

    const generated = generate(code);

    // BLOCK body must contain the await call.
    assert.match(
      generated,
      /__blockResult\s*=\s*await\s+(services\.)?parser\.split/,
      `expected \`__blockResult = await parser.split(...)\`:\n${generated}`,
    );

    // first comes from index 0, second from index 1.
    assert.match(
      generated,
      /state\.vars\.first\s*=\s*__blockResult\[0\]/,
      `expected \`state.vars.first = __blockResult[0]\`:\n${generated}`,
    );
    assert.match(
      generated,
      /state\.vars\.second\s*=\s*__blockResult\[1\]/,
      `expected \`state.vars.second = __blockResult[1]\`:\n${generated}`,
    );

    // Order: await before index extractions.
    const awaitIdx  = generated.search(/__blockResult\s*=\s*await\s+(services\.)?parser/);
    const firstIdx  = generated.search(/state\.vars\.first\s*=\s*__blockResult\[0\]/);
    const secondIdx = generated.search(/state\.vars\.second\s*=\s*__blockResult\[1\]/);
    assert.ok(awaitIdx >= 0 && firstIdx > awaitIdx && secondIdx > awaitIdx,
      `__blockResult assignment must precede index extractions (await@${awaitIdx} first@${firstIdx} second@${secondIdx})`,
    );
  });

  it('tracks one-element array destructuring', () => {
    const code = `async () => {
      const r = race();
      switch (true) {
        case signal(r, deps.signals.ping): {
          const [result] = await svc.compute();
          break;
        }
      }
    }`;

    const generated = generate(code);

    assert.match(generated, /__blockResult\s*=\s*await\s+(services\.)?svc\.compute/,
      `missing __blockResult assignment:\n${generated}`);
    assert.match(generated, /state\.vars\.result\s*=\s*__blockResult\[0\]/,
      `missing state.vars.result extraction:\n${generated}`);
  });
});

// ---------------------------------------------------------------------------
// Analyzer-level checks (variable registration)
// ---------------------------------------------------------------------------

describe('destructure variables registered in analyzer', () => {
  it('object-destructured names appear in analysis.variables', () => {
    const handler = createHandler(`async () => {
      const r = race();
      switch (true) {
        case signal(r, deps.signals.ok): {
          const { alpha, beta } = await svc.fetch();
          break;
        }
      }
    }`);
    const analysis = analyzeHandler(handler, createTypeChecker());

    assert.ok(analysis.variables.has('alpha'), 'expected alpha in variables');
    assert.ok(analysis.variables.has('beta'),  'expected beta in variables');
    assert.strictEqual(analysis.variables.get('alpha')!.isUsing, false);
    assert.strictEqual(analysis.variables.get('beta')!.isUsing, false);
  });

  it('array-destructured names appear in analysis.variables', () => {
    const handler = createHandler(`async () => {
      const r = race();
      switch (true) {
        case signal(r, deps.signals.ok): {
          const [x, y] = await svc.pair();
          break;
        }
      }
    }`);
    const analysis = analyzeHandler(handler, createTypeChecker());

    assert.ok(analysis.variables.has('x'), 'expected x in variables');
    assert.ok(analysis.variables.has('y'), 'expected y in variables');
  });
});
