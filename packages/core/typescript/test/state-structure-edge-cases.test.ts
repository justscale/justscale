/**
 * Edge case tests for the flat path-based state model.
 *
 * Tests verify that the compiler correctly handles complex nested structures:
 * - Nested parallel/loop combinations
 * - Variable scoping across paths
 * - Cursor persistence
 * - Label tracking
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { analyzeHandler, Opcode } from '../src/compiler/analyzer.js';
import { compileProcessSource, formatDiagnostics } from '../src/compiler/compile.js';

// ============================================================================
// Test Helpers
// ============================================================================

function analyze(handlerCode: string) {
  const fullCode = `
    import { signal, race, delay } from '@justscale/core/process'
    const svc = {
      paid: {} as any,
      shipped: {} as any,
      itemProcessed: {} as any,
      outerDone: {} as any,
      innerDone: {} as any,
      done: {} as any,
      a: {} as any,
      b: {} as any,
      c: {} as any,
    }
    const items = [1, 2, 3]
    const outerItems = ['a', 'b']
    const innerItems = [1, 2]
    const handler = async () => ${handlerCode}
  `;

  const sourceFile = ts.createSourceFile(
    'test.ts',
    fullCode,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noEmit: true,
  };

  const host = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = host.getSourceFile;
  host.getSourceFile = (fileName, languageVersion) => {
    if (fileName === 'test.ts') return sourceFile;
    return originalGetSourceFile.call(host, fileName, languageVersion);
  };

  const program = ts.createProgram(['test.ts'], compilerOptions, host);
  const typeChecker = program.getTypeChecker();

  let handler: ts.ArrowFunction | ts.FunctionExpression | null = null;
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === 'handler') {
          if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
            handler = decl.initializer;
          }
        }
      }
    }
  });

  if (!handler) throw new Error('Handler not found in test code');

  return analyzeHandler(handler, typeChecker);
}

function compileProcess(handlerCode: string) {
  const source = `
    import { createProcess, signal, race, delay } from '@justscale/core/process'
    const svc = {
      paid: {} as any,
      shipped: {} as any,
      itemProcessed: {} as any,
      outerDone: {} as any,
      innerDone: {} as any,
      done: {} as any,
      a: {} as any,
      b: {} as any,
      c: {} as any,
    }
    export const test = createProcess({
      path: '/test/:id',
      inject: {},
      async handler({}, [id]) ${handlerCode}
    })
  `;
  return compileProcessSource(source, 'test.ts', { verbose: false });
}

function findOpcodes(opcodes: Opcode[], op: Opcode['op']): Opcode[] {
  return opcodes.filter((o) => o.op === op);
}

// ============================================================================
// Edge Case Tests
// ============================================================================

describe('State Structure Edge Cases', () => {
  describe('Nested Loop Structures', () => {
    it('handles nested for-of loops with unique loop IDs', () => {
      const result = analyze(`{
        for (const outer of outerItems) {
          await signal(svc.outerDone)
          for (const inner of innerItems) {
            await signal(svc.innerDone)
          }
        }
        return { done: true }
      }`);

      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      // Should have two ITER_START opcodes with different loop IDs
      const iterStarts = findOpcodes(result.opcodes, 'ITER_START') as Array<{
        op: 'ITER_START'
        loopId: number
        cursorVar: string
        itemVar: string
      }>;
      assert.strictEqual(iterStarts.length, 2, 'Should have 2 ITER_START opcodes');
      assert.strictEqual(iterStarts[0].loopId, 0, 'Outer loop should have ID 0');
      assert.strictEqual(iterStarts[1].loopId, 1, 'Inner loop should have ID 1');
      assert.strictEqual(iterStarts[0].cursorVar, '__cursor_0', 'Outer cursor should be __cursor_0');
      assert.strictEqual(iterStarts[1].cursorVar, '__cursor_1', 'Inner cursor should be __cursor_1');
    });

    it('handles loop with race inside (race triggers iteration)', () => {
      // Note: Race inside for-of is handled via switch analysis, not await.
      // The loop becomes durable only when there's explicit await before/after race.
      const result = analyze(`{
        for (const item of items) {
          await signal(svc.itemProcessed)  // Explicit await makes loop durable
          const r = race()
          switch (true) {
            case signal(r, svc.paid):
              break
            case delay.hours(r, 1):
              break
          }
        }
        return { done: true }
      }`);

      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const iterStarts = findOpcodes(result.opcodes, 'ITER_START');
      const raceStarts = findOpcodes(result.opcodes, 'RACE_START');

      assert.strictEqual(iterStarts.length, 1, 'Should have 1 ITER_START');
      assert.strictEqual(raceStarts.length, 1, 'Should have 1 RACE_START');
    });

    it('handles sequential loops with different items', () => {
      const result = analyze(`{
        for (const outer of outerItems) {
          await signal(svc.outerDone)
        }
        for (const inner of innerItems) {
          await signal(svc.innerDone)
        }
        return { done: true }
      }`);

      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const iterStarts = findOpcodes(result.opcodes, 'ITER_START') as Array<{
        op: 'ITER_START'
        loopId: number
        itemVar: string
      }>;
      assert.strictEqual(iterStarts.length, 2, 'Should have 2 ITER_START opcodes');
      assert.strictEqual(iterStarts[0].itemVar, 'outer', 'First loop variable should be outer');
      assert.strictEqual(iterStarts[1].itemVar, 'inner', 'Second loop variable should be inner');
    });
  });

  describe('Parallel + Loop Combinations', () => {
    it('handles parallel blocks with signals', () => {
      const result = analyze(`{
        const [a, b] = await signal.all([svc.a, svc.b])
        return { a, b }
      }`);

      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const parallelStarts = findOpcodes(result.opcodes, 'PARALLEL_START');
      const parallelWaits = findOpcodes(result.opcodes, 'PARALLEL_WAIT');
      const parallelCollects = findOpcodes(result.opcodes, 'PARALLEL_COLLECT');

      assert.strictEqual(parallelStarts.length, 1, 'Should have 1 PARALLEL_START');
      assert.strictEqual(parallelWaits.length, 1, 'Should have 1 PARALLEL_WAIT');
      assert.strictEqual(parallelCollects.length, 1, 'Should have 1 PARALLEL_COLLECT');
    });

    it('handles loop followed by parallel', () => {
      const result = analyze(`{
        for (const item of items) {
          await signal(svc.itemProcessed)
        }
        const [a, b] = await signal.all([svc.a, svc.b])
        return { a, b }
      }`);

      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const iterStarts = findOpcodes(result.opcodes, 'ITER_START');
      const parallelStarts = findOpcodes(result.opcodes, 'PARALLEL_START');

      assert.strictEqual(iterStarts.length, 1, 'Should have 1 ITER_START');
      assert.strictEqual(parallelStarts.length, 1, 'Should have 1 PARALLEL_START');

      // ITER_START should come before PARALLEL_START
      const iterIdx = result.opcodes.indexOf(iterStarts[0]);
      const parallelIdx = result.opcodes.indexOf(parallelStarts[0]);
      assert.ok(iterIdx < parallelIdx, 'Loop should be processed before parallel');
    });

    it('handles parallel followed by loop', () => {
      const result = analyze(`{
        const [a, b] = await signal.all([svc.a, svc.b])
        for (const item of items) {
          await signal(svc.itemProcessed)
        }
        return { a, b }
      }`);

      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const iterStarts = findOpcodes(result.opcodes, 'ITER_START');
      const parallelStarts = findOpcodes(result.opcodes, 'PARALLEL_START');

      assert.strictEqual(iterStarts.length, 1, 'Should have 1 ITER_START');
      assert.strictEqual(parallelStarts.length, 1, 'Should have 1 PARALLEL_START');

      // PARALLEL_START should come before ITER_START
      const iterIdx = result.opcodes.indexOf(iterStarts[0]);
      const parallelIdx = result.opcodes.indexOf(parallelStarts[0]);
      assert.ok(parallelIdx < iterIdx, 'Parallel should be processed before loop');
    });

    it('handles multiple sequential parallel blocks', () => {
      const result = analyze(`{
        const [a1, b1] = await signal.all([svc.a, svc.b])
        const [a2, b2] = await signal.all([svc.a, svc.b])
        return { a1, b1, a2, b2 }
      }`);

      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const parallelStarts = findOpcodes(result.opcodes, 'PARALLEL_START') as Array<{
        op: 'PARALLEL_START'
        parallelId: number
      }>;
      assert.strictEqual(parallelStarts.length, 2, 'Should have 2 PARALLEL_START opcodes');
      assert.strictEqual(parallelStarts[0].parallelId, 0, 'First parallel should have ID 0');
      assert.strictEqual(parallelStarts[1].parallelId, 1, 'Second parallel should have ID 1');
    });
  });

  describe('Label Tracking', () => {
    it('handles single label with suspension', () => {
      const result = analyze(`{
        outer: {
          await signal(svc.done)
        }
        return { done: true }
      }`);

      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const labelEnters = findOpcodes(result.opcodes, 'LABEL_ENTER') as Array<{
        op: 'LABEL_ENTER'
        label: string
      }>;
      const labelExits = findOpcodes(result.opcodes, 'LABEL_EXIT') as Array<{
        op: 'LABEL_EXIT'
        label: string
      }>;

      assert.strictEqual(labelEnters.length, 1, 'Should have 1 LABEL_ENTER');
      assert.strictEqual(labelExits.length, 1, 'Should have 1 LABEL_EXIT');
      assert.strictEqual(labelEnters[0].label, 'outer', 'Label name should be outer');
      assert.strictEqual(labelExits[0].label, 'outer', 'Exit label should match enter');
    });

    it('handles nested labels', () => {
      const result = analyze(`{
        outer: {
          inner: {
            await signal(svc.done)
          }
        }
        return { done: true }
      }`);

      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const labelEnters = findOpcodes(result.opcodes, 'LABEL_ENTER') as Array<{
        op: 'LABEL_ENTER'
        label: string
      }>;
      const labelExits = findOpcodes(result.opcodes, 'LABEL_EXIT') as Array<{
        op: 'LABEL_EXIT'
        label: string
      }>;

      assert.strictEqual(labelEnters.length, 2, 'Should have 2 LABEL_ENTER');
      assert.strictEqual(labelExits.length, 2, 'Should have 2 LABEL_EXIT');

      // Order should be: enter outer, enter inner, ..., exit inner, exit outer
      assert.strictEqual(labelEnters[0].label, 'outer', 'First enter should be outer');
      assert.strictEqual(labelEnters[1].label, 'inner', 'Second enter should be inner');
      assert.strictEqual(labelExits[0].label, 'inner', 'First exit should be inner');
      assert.strictEqual(labelExits[1].label, 'outer', 'Second exit should be outer');
    });

    it('handles label with loop inside', () => {
      const result = analyze(`{
        processing: {
          for (const item of items) {
            await signal(svc.itemProcessed)
          }
        }
        return { done: true }
      }`);

      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const labelEnters = findOpcodes(result.opcodes, 'LABEL_ENTER');
      const iterStarts = findOpcodes(result.opcodes, 'ITER_START');

      assert.strictEqual(labelEnters.length, 1, 'Should have 1 LABEL_ENTER');
      assert.strictEqual(iterStarts.length, 1, 'Should have 1 ITER_START');

      // LABEL_ENTER should come before ITER_START
      const labelIdx = result.opcodes.indexOf(labelEnters[0]);
      const iterIdx = result.opcodes.indexOf(iterStarts[0]);
      assert.ok(labelIdx < iterIdx, 'Label should be entered before loop starts');
    });
  });

  describe('Variable Scoping', () => {
    it('tracks loop variable in variables map', () => {
      const result = analyze(`{
        for (const item of items) {
          await signal(svc.itemProcessed)
        }
        return { done: true }
      }`);

      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const itemVar = result.variables.get('item');
      assert.ok(itemVar, 'Should track item variable');
      assert.strictEqual(itemVar.name, 'item', 'Variable name should be item');
      assert.strictEqual(itemVar.isSerializable, true, 'Loop variable should be serializable');
    });

    it('tracks nested loop variables separately', () => {
      const result = analyze(`{
        for (const outer of outerItems) {
          await signal(svc.outerDone)
          for (const inner of innerItems) {
            await signal(svc.innerDone)
          }
        }
        return { done: true }
      }`);

      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const outerVar = result.variables.get('outer');
      const innerVar = result.variables.get('inner');

      assert.ok(outerVar, 'Should track outer variable');
      assert.ok(innerVar, 'Should track inner variable');
      assert.strictEqual(outerVar.name, 'outer', 'Outer variable name correct');
      assert.strictEqual(innerVar.name, 'inner', 'Inner variable name correct');
    });

    it('tracks variables declared before suspension', () => {
      const result = analyze(`{
        const counter = 0
        await signal(svc.done)
        return { counter }
      }`);

      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const counterVar = result.variables.get('counter');
      assert.ok(counterVar, 'Should track counter variable');
    });
  });

  describe('Complex Nested Structures', () => {
    it('handles race inside loop inside label', () => {
      // Race inside for-of requires explicit await to make loop durable
      const result = analyze(`{
        batch: {
          for (const item of items) {
            await signal(svc.itemProcessed)  // Makes loop durable
            const r = race()
            switch (true) {
              case signal(r, svc.paid):
                break
              case delay.minutes(r, 30):
                break
            }
          }
        }
        return { done: true }
      }`);

      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const labelEnters = findOpcodes(result.opcodes, 'LABEL_ENTER');
      const iterStarts = findOpcodes(result.opcodes, 'ITER_START');
      const raceStarts = findOpcodes(result.opcodes, 'RACE_START');

      assert.strictEqual(labelEnters.length, 1, 'Should have 1 LABEL_ENTER');
      assert.strictEqual(iterStarts.length, 1, 'Should have 1 ITER_START');
      assert.strictEqual(raceStarts.length, 1, 'Should have 1 RACE_START');
    });

    it('handles parallel followed by loop followed by race', () => {
      const result = analyze(`{
        const [first, second] = await signal.all([svc.a, svc.b])
        for (const item of items) {
          await signal(svc.itemProcessed)
        }
        const r = race()
        switch (true) {
          case signal(r, svc.done):
            return { status: 'done' }
          case delay.hours(r, 24):
            return { status: 'timeout' }
        }
      }`);

      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const parallelStarts = findOpcodes(result.opcodes, 'PARALLEL_START');
      const iterStarts = findOpcodes(result.opcodes, 'ITER_START');
      const raceStarts = findOpcodes(result.opcodes, 'RACE_START');

      assert.strictEqual(parallelStarts.length, 1, 'Should have 1 PARALLEL_START');
      assert.strictEqual(iterStarts.length, 1, 'Should have 1 ITER_START');
      assert.strictEqual(raceStarts.length, 1, 'Should have 1 RACE_START');

      // Verify order: PARALLEL_START < ITER_START < RACE_START
      const parallelIdx = result.opcodes.indexOf(parallelStarts[0]);
      const iterIdx = result.opcodes.indexOf(iterStarts[0]);
      const raceIdx = result.opcodes.indexOf(raceStarts[0]);

      assert.ok(parallelIdx < iterIdx, 'Parallel should come before loop');
      assert.ok(iterIdx < raceIdx, 'Loop should come before race');
    });
  });

  describe('Code Generation', () => {
    it('generates valid code for nested loops', () => {
      const result = compileProcess(`{
        const outerItems = ['a', 'b']
        const innerItems = [1, 2]
        for (const outer of outerItems) {
          await signal(svc.outerDone)
          for (const inner of innerItems) {
            await signal(svc.innerDone)
          }
        }
        return { done: true }
      }`);

      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));
      assert.ok(result.outputText.length > 0, 'Should generate output');

      // Should have cursor variables for both loops
      assert.ok(result.outputText.includes('__cursor_0'), 'Should have cursor for outer loop');
      assert.ok(result.outputText.includes('__cursor_1'), 'Should have cursor for inner loop');
    });

    it('generates valid code for parallel block', () => {
      const result = compileProcess(`{
        const [a, b] = await signal.all([svc.a, svc.b])
        return { a, b }
      }`);

      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));
      assert.ok(result.outputText.length > 0, 'Should generate output');
    });

    it('generates valid step map for complex structure', () => {
      const result = compileProcess(`{
        await signal(svc.a)
        for (const item of items) {
          await signal(svc.itemProcessed)
        }
        await signal(svc.b)
        return { done: true }
      }`);

      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      // Should have stepMap in output
      assert.ok(result.outputText.includes('stepMap'), 'Should have stepMap in output');
    });
  });
});
