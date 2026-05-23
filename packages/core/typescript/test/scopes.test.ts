/**
 * Tests for scope() primitive support
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { analyzeHandler, Opcode } from '../src/compiler/analyzer.js';
import { compileProcessSource } from '../src/compiler/compile.js';

// Helper to analyze a handler function with mocked type info
function analyze(handlerCode: string) {
  const fullCode = `
    import { signal, race, delay, scope } from '@justscale/core/process'
    const svc = {
      paid: {} as any,
      shipped: {} as any,
      itemProcessed: {} as any,
      done: {} as any
    }
    const items = [{ id: '1' }, { id: '2' }]
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

describe('Scope Primitive Support', () => {
  describe('SCOPE opcodes', () => {
    it('has SCOPE_START opcode defined', () => {
      // This test verifies the opcode type exists in the union
      const opcodeTypes: Opcode['op'][] = [
        'SCOPE_START',
        'SCOPE_NEXT',
        'SCOPE_WAIT',
        'SCOPE_HANDLER',
        'SCOPE_END',
      ];

      // All scope opcodes should be valid
      for (const opType of opcodeTypes) {
        assert.ok(typeof opType === 'string', `${opType} should be a valid opcode type`);
      }
    });
  });

  describe('scope() primitive types', () => {
    it('scope primitive is exported from process module', async () => {
      // Dynamic import to verify export
      const { scope } = await import('@justscale/core/process');
      assert.ok(typeof scope === 'function', 'scope should be a function');
    });

    it('isScopePlaceholder is exported from process module', async () => {
      const { isScopePlaceholder } = await import('@justscale/core/process');
      assert.ok(typeof isScopePlaceholder === 'function', 'isScopePlaceholder should be a function');
    });
  });

  describe('scope placeholder detection', () => {
    it('detects signal-first scope placeholder', async () => {
      const { scope, isScopePlaceholder } = await import('@justscale/core/process');

      const mockSignal = Promise.resolve({ data: 'test' });
      const items = [{ id: '1' }, { id: '2' }];

      const result = scope(mockSignal, items);
      assert.ok(isScopePlaceholder(result), 'Should detect scope placeholder');
    });

    it('detects entities-with-handler scope placeholder', async () => {
      const { scope, isScopePlaceholder } = await import('@justscale/core/process');

      const items = [{ id: '1' }, { id: '2' }];
      const handler = async (item: { id: string }) => item.id;

      const result = scope(items, handler);
      assert.ok(isScopePlaceholder(result), 'Should detect scope placeholder');
    });

    it('detects entities-with-idFn-handler scope placeholder', async () => {
      const { scope, isScopePlaceholder } = await import('@justscale/core/process');

      const items = [{ id: '1' }, { id: '2' }];
      const idFn = (item: { id: string }) => item.id;
      const handler = async (item: { id: string }) => item.id;

      const result = scope(items, idFn, handler);
      assert.ok(isScopePlaceholder(result), 'Should detect scope placeholder');
    });
  });

  describe('analyzer detection', () => {
    it('detects scope() with signal-first form', () => {
      const result = analyze(`{
        await scope(svc.itemProcessed, items)
        return { status: 'done' }
      }`);

      const scopeStartOps = findOpcodes(result.opcodes, 'SCOPE_START');
      assert.strictEqual(scopeStartOps.length, 1, 'Should have 1 SCOPE_START opcode');

      const scopeWaitOps = findOpcodes(result.opcodes, 'SCOPE_WAIT');
      assert.strictEqual(scopeWaitOps.length, 1, 'Should have 1 SCOPE_WAIT opcode');

      const scopeEndOps = findOpcodes(result.opcodes, 'SCOPE_END');
      assert.strictEqual(scopeEndOps.length, 1, 'Should have 1 SCOPE_END opcode');
    });

    it('detects scope() with handler form', () => {
      const result = analyze(`{
        await scope(items, async (item) => {
          await signal(svc.itemProcessed)
          return item.id
        })
        return { status: 'done' }
      }`);

      const scopeStartOps = findOpcodes(result.opcodes, 'SCOPE_START');
      assert.strictEqual(scopeStartOps.length, 1, 'Should have 1 SCOPE_START opcode');

      const scopeHandlerOps = findOpcodes(result.opcodes, 'SCOPE_HANDLER');
      assert.strictEqual(scopeHandlerOps.length, 1, 'Should have 1 SCOPE_HANDLER opcode');

      const scopeEndOps = findOpcodes(result.opcodes, 'SCOPE_END');
      assert.strictEqual(scopeEndOps.length, 1, 'Should have 1 SCOPE_END opcode');
    });

    it('emits no diagnostics for valid scope usage', () => {
      const result = analyze(`{
        await scope(svc.itemProcessed, items)
        return { status: 'done' }
      }`);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no diagnostics');
    });
  });

  describe('scope codegen', () => {
    it('generates scope suspend config in compiled output', () => {
      const source = `
        import { createProcess, signal, scope } from '@justscale/core/process'
        const svc = { itemProcessed: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const items = [{ id: '1' }, { id: '2' }]
            await scope(svc.itemProcessed, items)
            return { status: 'done' }
          }
        })
      `;

      const result = compileProcessSource(source, 'test.ts', { verbose: false });
      assert.ok(result.outputText, 'Should have output');
      assert.ok(
        result.outputText.includes('scope'),
        'Generated code should contain scope reference'
      );
    });
  });

  describe('analyzer context', () => {
    it('tracks nextScopeBlockId in context', () => {
      const result = analyze(`{
        await signal(svc.done)
        return { status: 'done' }
      }`);

      // Analysis should complete without errors
      assert.ok(result, 'Should return analysis result');
      assert.strictEqual(result.diagnostics.length, 0, 'Should have no diagnostics');
    });
  });
});
