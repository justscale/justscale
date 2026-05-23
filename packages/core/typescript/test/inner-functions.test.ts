/**
 * Tests for inner function inlining
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { analyzeHandler, Opcode } from '../src/compiler/analyzer.js';

// Helper to analyze a handler function with mocked type info
function analyze(handlerCode: string) {
  const fullCode = `
    import { signal, race, delay } from '@justscale/core/process'
    const svc = { paid: {} as any, shipped: {} as any, verified: {} as any, done: {} as any }
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

describe('Inner Function Inlining', () => {
  describe('inner function registration', () => {
    it('registers inner async function with suspension points', () => {
      const result = analyze(`async () => {
        const doWork = async () => {
          await signal(svc.done)
        }
        await doWork()
        return 'done'
      }`);

      assert.ok(result, 'Should return analysis result');

      // The inner function body should be inlined - we should see a WAIT opcode
      const waitOps = findOpcodes(result.opcodes, 'WAIT');
      assert.strictEqual(waitOps.length, 1, 'Should have 1 WAIT opcode from inlined function');
    });

    it('registers function declaration with suspension points', () => {
      const result = analyze(`async () => {
        async function doWork() {
          await signal(svc.done)
        }
        await doWork()
        return 'done'
      }`);

      assert.ok(result, 'Should return analysis result');

      // The inner function body should be inlined
      const waitOps = findOpcodes(result.opcodes, 'WAIT');
      assert.strictEqual(waitOps.length, 1, 'Should have 1 WAIT opcode from inlined function');
    });
  });

  describe('function inlining', () => {
    it('inlines function body at call site', () => {
      const result = analyze(`async () => {
        const processPayment = async () => {
          await signal(svc.paid)
          await signal(svc.verified)
        }
        await processPayment()
        return 'paid'
      }`);

      assert.ok(result, 'Should return analysis result');

      // Both signals from the inner function should be inlined
      const waitOps = findOpcodes(result.opcodes, 'WAIT');
      assert.strictEqual(waitOps.length, 2, 'Should have 2 WAIT opcodes from inlined function');
    });

    it('inlines multiple calls to same function', () => {
      const result = analyze(`async () => {
        const waitForDone = async () => {
          await signal(svc.done)
        }
        await waitForDone()
        await waitForDone()
        return 'done'
      }`);

      assert.ok(result, 'Should return analysis result');

      // Both calls should inline the body
      const waitOps = findOpcodes(result.opcodes, 'WAIT');
      assert.strictEqual(waitOps.length, 2, 'Should have 2 WAIT opcodes from multiple inlined calls');
    });
  });

  describe('error detection', () => {
    it('reports TSP2001 for direct recursion', () => {
      const result = analyze(`async () => {
        const recurse = async () => {
          await signal(svc.done)
          await recurse()
        }
        await recurse()
        return 'done'
      }`);

      assert.ok(result, 'Should return analysis result');

      // Should have error for recursion
      const recursionError = findDiagnosticByCode(result.diagnostics, 2001);
      assert.ok(recursionError, 'Should report TSP2001 for recursion');
    });

    it('reports TSP2002 for mutual recursion', () => {
      const result = analyze(`async () => {
        const funcA = async () => {
          await signal(svc.paid)
          await funcB()
        }
        const funcB = async () => {
          await signal(svc.shipped)
          await funcA()
        }
        await funcA()
        return 'done'
      }`);

      assert.ok(result, 'Should return analysis result');

      // Should have error for mutual recursion
      const mutualError = findDiagnosticByCode(result.diagnostics, 2002);
      assert.ok(mutualError, 'Should report TSP2002 for mutual recursion');
    });

    it('inlines parameterized inner functions', () => {
      const result = analyze(`async () => {
        const doWork = async (x: number) => {
          await signal(svc.done)
        }
        await doWork(5)
        return 'done'
      }`);

      assert.ok(result, 'Should return analysis result');

      // Should NOT have TSP1012 error - parameterized inlining is now supported
      const paramError = findDiagnosticByCode(result.diagnostics, 1012);
      assert.strictEqual(paramError, undefined, 'Should NOT report TSP1012');

      // Should have inlined the function body (WAIT opcode from signal)
      const waitOps = findOpcodes(result.opcodes, 'WAIT');
      assert.strictEqual(waitOps.length, 1, 'Should have 1 WAIT from inlined body');

      // Parameter 'x' should be tracked as a variable
      assert.ok(result.variables.has('x'), 'Parameter x should be tracked');
    });
  });

  describe('parameterized inner functions', () => {
    it('inlines function with multiple parameters', () => {
      const result = analyze(`async () => {
        const doWork = async (phase: string, amount: number) => {
          await signal(svc.done)
        }
        await doWork('preflop', 50)
        return 'done'
      }`);

      assert.ok(result);
      assert.ok(result.variables.has('phase'), 'Should track phase param');
      assert.ok(result.variables.has('amount'), 'Should track amount param');
      const waitOps = findOpcodes(result.opcodes, 'WAIT');
      assert.strictEqual(waitOps.length, 1);
    });

    it('inlines multiple calls with different args', () => {
      const result = analyze(`async () => {
        const doWork = async (name: string) => {
          await signal(svc.done)
        }
        await doWork('first')
        await doWork('second')
        return 'done'
      }`);

      assert.ok(result);
      const waitOps = findOpcodes(result.opcodes, 'WAIT');
      assert.strictEqual(waitOps.length, 2, 'Should have 2 WAITs from 2 inlined calls');
    });
  });

  describe('non-suspending functions', () => {
    it('does not inline functions without suspension points', () => {
      const result = analyze(`async () => {
        const compute = async () => {
          return 42
        }
        const x = await compute()
        await signal(svc.done)
        return x
      }`);

      assert.ok(result, 'Should return analysis result');

      // Should only have 1 WAIT from the direct signal call
      const waitOps = findOpcodes(result.opcodes, 'WAIT');
      assert.strictEqual(waitOps.length, 1, 'Should have only 1 WAIT from direct signal');
    });
  });
});
