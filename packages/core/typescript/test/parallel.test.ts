/**
 * Tests for parallel block syntax (signal.all() and signal.settled())
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { analyzeHandler, Opcode } from '../src/compiler/analyzer.js';

// Helper to analyze a handler function with mocked type info
function analyze(handlerCode: string) {
  const fullCode = `
    import { signal, race, delay } from '@justscale/core/process'
    const svc = { paid: {} as any, shipped: {} as any, verified: {} as any }
    const handler = ${handlerCode}
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

  // Find the handler variable
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

function findOpcodes(opcodes: Opcode[], op: Opcode['op']): Opcode[] {
  return opcodes.filter((o) => o.op === op);
}

function findDiagnosticByCode(diagnostics: ts.Diagnostic[], code: number): ts.Diagnostic | undefined {
  // Process error codes are offset by 100000
  return diagnostics.find(d => d.code === 100000 + code);
}

// Helper to analyze code with race variables properly tracked
function analyzeWithRace(handlerCode: string) {
  const fullCode = `
    import { signal, race, delay } from '@justscale/core/process'
    const svc = { paid: {} as any, shipped: {} as any, verified: {} as any }
    const handler = async () => {
      const r = race()
      ${handlerCode}
    }
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

describe('Parallel Block Syntax', () => {
  describe('empty parallel validation', () => {
    it('reports TSP3005 for empty signal.all array', () => {
      const result = analyze(`async () => {
        const results = await signal.all([])
        return results
      }`);

      const diagnostic = findDiagnosticByCode(result.diagnostics, 3005);
      assert.ok(diagnostic, 'Should have TSP3005 diagnostic for empty signal.all');
      assert.ok(diagnostic.messageText.toString().includes('at least one'), 'Error message should mention requiring signals');

      // Should NOT have PARALLEL_START opcode (analysis should abort)
      const parallelStart = findOpcodes(result.opcodes, 'PARALLEL_START');
      assert.strictEqual(parallelStart.length, 0, 'Should NOT emit PARALLEL_START for empty array');
    });

    it('reports TSP3005 for empty signal.settled array', () => {
      const result = analyze(`async () => {
        const results = await signal.settled([])
        return results
      }`);

      const diagnostic = findDiagnosticByCode(result.diagnostics, 3005);
      assert.ok(diagnostic, 'Should have TSP3005 diagnostic for empty signal.settled');

      const parallelStart = findOpcodes(result.opcodes, 'PARALLEL_START');
      assert.strictEqual(parallelStart.length, 0, 'Should NOT emit PARALLEL_START for empty array');
    });

    it('allows single element in signal.all', () => {
      const result = analyze(`async () => {
        const [a] = await signal.all([svc.paid])
        return { a }
      }`);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no diagnostics');

      const parallelStart = findOpcodes(result.opcodes, 'PARALLEL_START');
      assert.strictEqual(parallelStart.length, 1, 'Should have PARALLEL_START opcode');
    });
  });

  describe('signal.all() analysis', () => {
    it('analyzes signal.all with array form', () => {
      const result = analyze(`async () => {
        const [a, b] = await signal.all([svc.paid, svc.shipped])
        return { a, b }
      }`);

      assert.ok(result, 'Should return analysis result');

      // Should have PARALLEL_START, PARALLEL_WAIT, PARALLEL_COLLECT opcodes
      const parallelStart = findOpcodes(result.opcodes, 'PARALLEL_START');
      assert.strictEqual(parallelStart.length, 1, 'Should have 1 PARALLEL_START opcode');

      const parallelWait = findOpcodes(result.opcodes, 'PARALLEL_WAIT');
      assert.strictEqual(parallelWait.length, 1, 'Should have 1 PARALLEL_WAIT opcode');

      const parallelCollect = findOpcodes(result.opcodes, 'PARALLEL_COLLECT');
      assert.strictEqual(parallelCollect.length, 1, 'Should have 1 PARALLEL_COLLECT opcode');

      // Check PARALLEL_START has correct branches
      const startOp = parallelStart[0] as { op: 'PARALLEL_START'; parallelId: number; branches: unknown[]; isSettled: boolean };
      assert.strictEqual(startOp.branches.length, 2, 'Should have 2 branches');
      assert.strictEqual(startOp.isSettled, false, 'isSettled should be false for signal.all');
    });

    it('analyzes signal.all with object form', () => {
      const result = analyze(`async () => {
        const { payment, shipping } = await signal.all({
          payment: svc.paid,
          shipping: svc.shipped
        })
        return { payment, shipping }
      }`);

      assert.ok(result, 'Should return analysis result');

      const parallelStart = findOpcodes(result.opcodes, 'PARALLEL_START');
      assert.strictEqual(parallelStart.length, 1, 'Should have 1 PARALLEL_START opcode');

      const parallelCollect = findOpcodes(result.opcodes, 'PARALLEL_COLLECT');
      assert.strictEqual(parallelCollect.length, 1, 'Should have 1 PARALLEL_COLLECT opcode');

      // Check PARALLEL_COLLECT has correct isObject flag
      const collectOp = parallelCollect[0] as { op: 'PARALLEL_COLLECT'; parallelId: number; resultVar: string; isObject: boolean };
      assert.strictEqual(collectOp.isObject, true, 'isObject should be true for object form');
    });

    it('analyzes signal.settled with array form', () => {
      const result = analyze(`async () => {
        const results = await signal.settled([svc.paid, svc.shipped, svc.verified])
        return results
      }`);

      assert.ok(result, 'Should return analysis result');

      const parallelStart = findOpcodes(result.opcodes, 'PARALLEL_START');
      assert.strictEqual(parallelStart.length, 1, 'Should have 1 PARALLEL_START opcode');

      // Check isSettled flag
      const startOp = parallelStart[0] as { op: 'PARALLEL_START'; parallelId: number; branches: unknown[]; isSettled: boolean };
      assert.strictEqual(startOp.isSettled, true, 'isSettled should be true for signal.settled');
      assert.strictEqual(startOp.branches.length, 3, 'Should have 3 branches');
    });
  });

  describe('step building', () => {
    it('creates step boundary after PARALLEL_WAIT', () => {
      const result = analyze(`async () => {
        const [a, b] = await signal.all([svc.paid, svc.shipped])
        return { a, b }
      }`);

      assert.ok(result, 'Should return analysis result');

      // Verify opcode sequence includes suspension point
      const parallelWaitIdx = result.opcodes.findIndex(op => op.op === 'PARALLEL_WAIT');
      const parallelCollectIdx = result.opcodes.findIndex(op => op.op === 'PARALLEL_COLLECT');

      assert.ok(parallelWaitIdx >= 0, 'Should have PARALLEL_WAIT opcode');
      assert.ok(parallelCollectIdx >= 0, 'Should have PARALLEL_COLLECT opcode');
      assert.ok(parallelCollectIdx > parallelWaitIdx, 'PARALLEL_COLLECT should come after PARALLEL_WAIT');
    });
  });

  describe('locals persistence across signal.all', () => {
    it('emits STORE for resultVar after PARALLEL_COLLECT', () => {
      const result = analyze(`async () => {
        const results = await signal.all([svc.paid, svc.shipped])
        return results
      }`);

      // PARALLEL_COLLECT stores into state.vars, and STORE persists the variable
      const storeOps = findOpcodes(result.opcodes, 'STORE');
      assert.ok(storeOps.length > 0, 'Should have STORE opcode for result variable');

      const resultStore = storeOps.find(op => (op as { var: string }).var === 'results');
      assert.ok(resultStore, 'Should have STORE for the results variable');
    });

    it('variables declared before signal.all are tracked in analysis', () => {
      const result = analyze(`async () => {
        const tag = 'order-123'
        const [a, b] = await signal.all([svc.paid, svc.shipped])
        return { tag, a, b }
      }`);

      assert.ok(result, 'Should return analysis result');

      // The variable 'tag' should be in the variables map
      assert.ok(result.variables.has('tag'), 'Should track tag variable');

      // Should still emit all parallel opcodes
      const parallelStart = findOpcodes(result.opcodes, 'PARALLEL_START');
      assert.strictEqual(parallelStart.length, 1, 'Should have PARALLEL_START');
    });
  });
});

describe('Race Validation', () => {
  describe('valid race patterns', () => {
    it('allows race with single signal branch', () => {
      const result = analyzeWithRace(`
        switch (true) {
          case signal(r, svc.paid):
            return { status: 'paid' }
        }
      `);

      // Should have no errors
      assert.strictEqual(result.diagnostics.length, 0, 'Should have no diagnostics');

      const raceStart = findOpcodes(result.opcodes, 'RACE_START');
      assert.strictEqual(raceStart.length, 1, 'Should have RACE_START opcode');
    });

    it('allows race with delay branch', () => {
      const result = analyzeWithRace(`
        switch (true) {
          case delay.minutes(r, 5):
            return { status: 'timeout' }
        }
      `);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no diagnostics');

      const raceStart = findOpcodes(result.opcodes, 'RACE_START');
      assert.strictEqual(raceStart.length, 1, 'Should have RACE_START opcode');
    });

    it('allows race with multiple branches', () => {
      const result = analyzeWithRace(`
        switch (true) {
          case signal(r, svc.paid):
            return { status: 'paid' }
          case signal(r, svc.shipped):
            return { status: 'shipped' }
          case delay.days(r, 3):
            return { status: 'timeout' }
        }
      `);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no diagnostics');

      const raceStart = findOpcodes(result.opcodes, 'RACE_START');
      assert.strictEqual(raceStart.length, 1, 'Should have RACE_START opcode');

      const startOp = raceStart[0] as { op: 'RACE_START'; branches: unknown[] };
      assert.strictEqual(startOp.branches.length, 3, 'Should have 3 branches');
    });

    it('switch without signal/delay patterns is not treated as race', () => {
      // A switch with only default case is just a regular switch, not a race
      const result = analyzeWithRace(`
        switch (true) {
          default:
            return { status: 'no-op' }
        }
      `);

      // No race opcodes - it's just a regular switch
      const raceStart = findOpcodes(result.opcodes, 'RACE_START');
      assert.strictEqual(raceStart.length, 0, 'Should NOT have RACE_START opcode');

      // No TSP3010 error either - the switch is simply not a race
      const diagnostic = findDiagnosticByCode(result.diagnostics, 3010);
      assert.ok(!diagnostic, 'Should NOT have TSP3010 diagnostic');
    });
  });
});
