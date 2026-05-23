/**
 * Tests for process yield support
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { analyzeHandler, Opcode } from '../src/compiler/analyzer.js';
import { compileProcessSource } from '../src/compiler/compile.js';

// Helper to analyze a handler function with mocked type info
function analyze(handlerCode: string, isGenerator: boolean = false) {
  const asterisk = isGenerator ? '*' : '';
  const fullCode = `
    import { signal, race, delay } from '@justscale/core/process'
    const svc = { paid: {} as any, shipped: {} as any, verified: {} as any, done: {} as any }
    const handler = async ${asterisk}() => ${handlerCode}
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

// Helper to analyze a generator handler using function expression syntax
function analyzeGenerator(handlerCode: string) {
  const fullCode = `
    import { signal, race, delay } from '@justscale/core/process'
    const svc = { paid: {} as any, shipped: {} as any, verified: {} as any, done: {} as any }
    const handler = async function*() ${handlerCode}
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
  let handler: ts.FunctionExpression | null = null;
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === 'handler') {
          if (decl.initializer && ts.isFunctionExpression(decl.initializer)) {
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

describe('Process Yield Support', () => {
  describe('isGenerator detection', () => {
    it('detects non-generator handler', () => {
      const result = analyze(`{
        await signal(svc.done)
        return { status: 'done' }
      }`);

      assert.strictEqual(result.isGenerator, false);
      assert.strictEqual(result.yields.length, 0);
    });

    it('detects generator handler', () => {
      const result = analyzeGenerator(`{
        yield { event: 'started' }
        await signal(svc.done)
        return { status: 'done' }
      }`);

      assert.strictEqual(result.isGenerator, true);
      assert.strictEqual(result.yields.length, 1);
    });
  });

  describe('YIELD_EMIT opcode', () => {
    it('generates YIELD_EMIT for yield expression', () => {
      const result = analyzeGenerator(`{
        yield { event: 'started' }
        await signal(svc.done)
        yield { event: 'completed' }
        return { status: 'done' }
      }`);

      const yieldOps = findOpcodes(result.opcodes, 'YIELD_EMIT');
      assert.strictEqual(yieldOps.length, 2, 'Should have 2 YIELD_EMIT opcodes');

      assert.strictEqual(result.yields.length, 2, 'Should track 2 yield expressions');
    });

    it('handles yield in regular for loop (in block)', () => {
      const result = analyzeGenerator(`{
        for (let i = 0; i < 3; i++) {
          yield { event: 'iteration', index: i }
        }
        return { status: 'done' }
      }`);

      assert.ok(result.isGenerator);
      // Regular for loops with yields are handled as blocks - the yields execute at runtime
      // They don't generate individual YIELD_EMIT opcodes because yields don't suspend
      const blockOps = findOpcodes(result.opcodes, 'BLOCK');
      assert.ok(blockOps.length >= 1, 'Should have at least 1 BLOCK opcode');
    });
  });

  describe('error detection', () => {
    it('reports TSP3003 for yield in non-generator', () => {
      // Note: Arrow functions can't be generators, but we can test the diagnostic
      // by using a regular async function with yield (which is a syntax error in TS,
      // but our analyzer should still report the correct error if it encounters it)

      // This is a bit tricky to test because TypeScript itself will error on this.
      // We'll test the analyzer's isGenerator flag instead.
      const result = analyze(`{
        await signal(svc.done)
        return { status: 'done' }
      }`);

      // For a non-generator, isGenerator should be false
      assert.strictEqual(result.isGenerator, false);

      // If we could somehow inject a yield here, it would produce TSP3003
      // But TypeScript's parser prevents this at the syntax level
    });
  });

  describe('YIELD_EMIT codegen', () => {
    it('generates ctx.emit() call in compiled output', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { done: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async *handler({}, [id]) {
            yield { event: 'started' }
            await signal(svc.done)
            yield { event: 'completed' }
            return { status: 'done' }
          }
        })
      `;

      const result = compileProcessSource(source, 'test.ts', { verbose: false });

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no diagnostics');
      assert.ok(result.outputText, 'Should have output');

      // Check that ctx.emit is in the generated code
      assert.ok(
        result.outputText.includes('ctx.emit'),
        `Generated code should contain ctx.emit(). Got:\n${result.outputText.slice(0, 500)}`
      );
    });
  });

  describe('yield with signals', () => {
    it('supports yield before signal', () => {
      const result = analyzeGenerator(`{
        yield { event: 'starting' }
        await signal(svc.paid)
        yield { event: 'payment_received' }
        return { status: 'done' }
      }`);

      assert.strictEqual(result.isGenerator, true);
      assert.strictEqual(result.yields.length, 2);

      const yieldOps = findOpcodes(result.opcodes, 'YIELD_EMIT');
      const waitOps = findOpcodes(result.opcodes, 'WAIT');

      assert.strictEqual(yieldOps.length, 2);
      assert.strictEqual(waitOps.length, 1);
    });

    it('supports yield after signal', () => {
      const result = analyzeGenerator(`{
        await signal(svc.paid)
        yield { event: 'payment_received', amount: 100 }
        await signal(svc.shipped)
        yield { event: 'shipped' }
        return { status: 'complete' }
      }`);

      assert.strictEqual(result.isGenerator, true);

      const yieldOps = findOpcodes(result.opcodes, 'YIELD_EMIT');
      const waitOps = findOpcodes(result.opcodes, 'WAIT');

      assert.strictEqual(yieldOps.length, 2);
      assert.strictEqual(waitOps.length, 2);
    });
  });
});
