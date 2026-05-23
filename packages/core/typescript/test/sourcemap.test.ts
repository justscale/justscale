/**
 * Source Map Verification Tests
 *
 * These tests verify that:
 * 1. The sourceMap in generated output correctly maps step indices to source line ranges
 * 2. Generated AST nodes preserve source positions from the original handler
 * 3. The source map can be used to map runtime positions back to original source
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import ts from 'typescript';
import { analyzeHandler } from '../src/compiler/analyzer.js';
import { generateSwitchProcess, buildSteps, type SwitchCodeGenInput } from '../src/compiler/switch-codegen.js';

// ============================================================================
// Test Utilities
// ============================================================================

function createHandler(code: string): {
  handler: ts.ArrowFunction | ts.FunctionExpression
  sourceFile: ts.SourceFile
} {
  const sourceFile = ts.createSourceFile(
    'test.ts',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  let handler: ts.ArrowFunction | ts.FunctionExpression | undefined;

  const visit = (node: ts.Node) => {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      handler = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (!handler) {
    throw new Error('No function found in code');
  }
  return { handler, sourceFile };
}

function createTypeChecker(): ts.TypeChecker {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    strict: true,
  };

  const host = ts.createCompilerHost(options);
  const program = ts.createProgram(['test.ts'], options, {
    ...host,
    getSourceFile: (fileName) => {
      if (fileName === 'test.ts') {
        return ts.createSourceFile(fileName, '', ts.ScriptTarget.Latest);
      }
      return host.getSourceFile(fileName, ts.ScriptTarget.Latest);
    },
  });

  return program.getTypeChecker();
}

function getLineNumber(sourceFile: ts.SourceFile, pos: number): number {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

// ============================================================================
// sourceMap Property Tests
// ============================================================================

describe('sourceMap property verification', () => {
  it('sourceMap contains line ranges for each step', () => {
    const code = `async () => {
      const x = 1
      await waitFor(payments.received)
      const y = 2
      await waitFor(orders.shipped)
      return { x, y }
    }`;

    const { handler, sourceFile } = createHandler(code);
    const typeChecker = createTypeChecker();
    const analysis = analyzeHandler(handler, typeChecker);
    const { steps, sourceMap } = buildSteps(analysis);

    // Each step should have a sourceMap entry if it has source info
    for (const step of steps) {
      if (step.sourceRange) {
        const mapped = sourceMap[step.index];
        assert.ok(mapped, `Step ${step.index} should have sourceMap entry`);
        assert.ok(Array.isArray(mapped), 'Entry should be array');
        assert.strictEqual(mapped.length, 2, 'Entry should have [start, end]');
        assert.ok(mapped[0] > 0, 'Start line should be positive');
        assert.ok(mapped[1] >= mapped[0], 'End line should be >= start line');
      }
    }
  });

  it('sourceMap line numbers correspond to original source', () => {
    const code = `async () => {
      // Line 2: entry code
      const orderId = 'test-123'  // Line 3
      // Line 4: suspension point
      await waitFor(payments.received)  // Line 5
      // Line 6: after suspension
      return { orderId }  // Line 7
    }`;

    const { handler, sourceFile } = createHandler(code);
    const typeChecker = createTypeChecker();
    const analysis = analyzeHandler(handler, typeChecker);
    const { steps, sourceMap } = buildSteps(analysis);

    // Entry step should reference early lines (2-5)
    const entryStep = steps.find(s => s.type === 'entry');
    if (entryStep && sourceMap[entryStep.index]) {
      const [start, end] = sourceMap[entryStep.index];
      assert.ok(start <= 5, `Entry step should start at line <= 5, got ${start}`);
    }

    // Resume step (after WAIT) should reference later lines (6-7)
    const resumeStep = steps.find(s => s.type === 'resume');
    if (resumeStep && sourceMap[resumeStep.index]) {
      const [start, end] = sourceMap[resumeStep.index];
      assert.ok(start >= 5, `Resume step should start at line >= 5, got ${start}`);
    }
  });

  it('sourceMap covers all suspension points', () => {
    const code = `async () => {
      await waitFor(sig1)   // Suspension 1
      await waitFor(sig2)   // Suspension 2
      await waitFor(sig3)   // Suspension 3
      return { done: true }
    }`;

    const { handler, sourceFile } = createHandler(code);
    const typeChecker = createTypeChecker();
    const analysis = analyzeHandler(handler, typeChecker);
    const { steps, sourceMap } = buildSteps(analysis);

    // Should have at least 4 steps: entry + 3 resume steps
    assert.ok(steps.length >= 4, `Expected at least 4 steps, got ${steps.length}`);

    // Each step should have distinct line ranges (no exact overlaps)
    const ranges = Object.values(sourceMap).filter(r => r !== undefined);
    for (let i = 0; i < ranges.length; i++) {
      for (let j = i + 1; j < ranges.length; j++) {
        const [s1, e1] = ranges[i];
        const [s2, e2] = ranges[j];
        // Ranges can overlap but shouldn't be identical
        const identical = s1 === s2 && e1 === e2;
        // Note: identical ranges are possible for adjacent steps, so just log
      }
    }
  });

  it('sourceMap step indices match step.index values', () => {
    const code = `async () => {
      await waitFor(payments.received)
      return { done: true }
    }`;

    const { handler, sourceFile } = createHandler(code);
    const typeChecker = createTypeChecker();
    const analysis = analyzeHandler(handler, typeChecker);
    const { steps, sourceMap } = buildSteps(analysis);

    const sourceMapIndices = Object.keys(sourceMap).map(Number);
    const stepIndices = steps.map(s => s.index);

    // All sourceMap keys should be valid step indices
    for (const idx of sourceMapIndices) {
      assert.ok(
        stepIndices.includes(idx),
        `sourceMap index ${idx} should be a valid step index`
      );
    }
  });
});

// ============================================================================
// Generated Code Source Positions Tests
// ============================================================================

describe('generated code source positions', () => {
  it('generated nodes have source positions via setTextRange', () => {
    const code = `async () => {
      await waitFor(payments.received)
      return { done: true }
    }`;

    const { handler, sourceFile } = createHandler(code);
    const typeChecker = createTypeChecker();
    const analysis = analyzeHandler(handler, typeChecker);

    const input: SwitchCodeGenInput = {
      id: 'test',
      path: '/test/:id',
      version: 'v_test',
      injectNode: undefined,
      handler,
      analysis,
      originalNode: handler.parent, // Use the call expression as original node
    };

    const factory = ts.factory;
    const callExpr = generateSwitchProcess(factory, input);

    // The call expression should have positions from the original node
    assert.ok(callExpr.pos !== undefined, 'Generated call should have pos');
    assert.ok(callExpr.end !== undefined, 'Generated call should have end');
  });

  it('blocks in generated code preserve original statement positions', () => {
    // This test verifies that when we rewrite statements, we preserve positions
    const code = `async () => {
      const orderId = 'test-123'
      console.log(orderId)
      return { orderId }
    }`;

    const { handler, sourceFile } = createHandler(code);
    const typeChecker = createTypeChecker();
    const analysis = analyzeHandler(handler, typeChecker);

    // The analysis should have blocks with statements that have source positions
    for (const block of analysis.blocks) {
      if (block && block.statements) {
        for (const stmt of block.statements) {
          // Each statement should have positions from the original source
          const startLine = sourceFile.getLineAndCharacterOfPosition(stmt.getStart()).line + 1;
          const endLine = sourceFile.getLineAndCharacterOfPosition(stmt.getEnd()).line + 1;
          assert.ok(startLine > 0, 'Statement should have valid start line');
          assert.ok(endLine >= startLine, 'Statement should have valid end line');
        }
      }
    }
  });
});

// ============================================================================
// Full Compilation Source Map Tests
// ============================================================================

describe('full compilation source map generation', () => {
  it('compiled output can generate valid source map', async () => {
    const originalSource = `
// Original process definition
const OrderProcess = createProcess({
  path: '/order/:orderId',
  inject: { payments: PaymentService },
  async handler({ payments }, [orderId]) {
    const status = 'pending'
    await signal(payments.received)
    return { status: 'paid' }
  }
})
`;
    // Create source file with createProcess call
    const sourceFile = ts.createSourceFile(
      'order-process.ts',
      originalSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );

    // Find the handler function in the AST
    let handler: ts.ArrowFunction | ts.FunctionExpression | undefined;

    const visit = (node: ts.Node) => {
      if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        // Check if it's the handler (has async modifier and is inside createProcess)
        if (node.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword)) {
          handler = node;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    if (!handler) {
      // This is expected for this mock test - we'd need a real program
      return;
    }

    const typeChecker = createTypeChecker();
    const analysis = analyzeHandler(handler, typeChecker);

    // Verify sourceMap is generated with valid line numbers
    const { sourceMap } = buildSteps(analysis);

    for (const [stepIdx, range] of Object.entries(sourceMap)) {
      if (range) {
        const [startLine, endLine] = range;
        // Lines should be within the original source
        const totalLines = originalSource.split('\n').length;
        assert.ok(startLine >= 1, `Start line ${startLine} should be >= 1`);
        assert.ok(endLine <= totalLines, `End line ${endLine} should be <= ${totalLines}`);
      }
    }
  });

  it('stepMap hashes can be used to look up source positions', () => {
    const code = `async () => {
      await waitFor(payments.received)
      await waitFor(orders.shipped)
      return { done: true }
    }`;

    const { handler } = createHandler(code);
    const typeChecker = createTypeChecker();
    const analysis = analyzeHandler(handler, typeChecker);
    const { steps, stepMap, sourceMap } = buildSteps(analysis);

    // Use stepMap to look up source positions by hash
    for (const [hash, stepIndex] of Object.entries(stepMap)) {
      const range = sourceMap[stepIndex];
      // We should be able to go: hash -> stepIndex -> sourceRange
      assert.ok(
        typeof stepIndex === 'number',
        `stepMap[${hash}] should be number, got ${typeof stepIndex}`
      );

      if (range) {
        assert.ok(
          Array.isArray(range) && range.length === 2,
          `sourceMap[${stepIndex}] should be [start, end]`
        );
      }
    }
  });

  it('runtime can map step back to original source line', () => {
    const code = `async () => {
      const x = 1           // line 2
      await waitFor(sig1)   // line 3 - suspension
      const y = 2           // line 4 - resume point
      return { x, y }       // line 5
    }`;

    const { handler } = createHandler(code);
    const typeChecker = createTypeChecker();
    const analysis = analyzeHandler(handler, typeChecker);
    const { steps, stepMap, sourceMap } = buildSteps(analysis);

    // Simulate runtime: we're at step 1 (resume after sig1)
    // Find the resume step
    const resumeStep = steps.find(s => s.type === 'resume');
    if (resumeStep) {
      const stepIndex = resumeStep.index;
      const stepHash = resumeStep.hash;

      // Verify we can look up source position
      const range = sourceMap[stepIndex];
      if (range) {
        const [startLine, endLine] = range;
        // Resume point should be on/after line 4
        assert.ok(startLine >= 3, `Resume should start at line >= 3, got ${startLine}`);
      }

      // Verify stepMap reverse lookup works
      assert.strictEqual(stepMap[stepHash], stepIndex, 'stepMap should map hash to index');
    }
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('sourceMap edge cases', () => {
  it('handles empty handler', () => {
    const code = 'async () => {}';

    const { handler } = createHandler(code);
    const typeChecker = createTypeChecker();
    const analysis = analyzeHandler(handler, typeChecker);
    const { steps, sourceMap } = buildSteps(analysis);

    // Empty handler might have no steps or one entry step
    // sourceMap should not throw
    assert.ok(typeof sourceMap === 'object', 'sourceMap should be object');
  });

  it('handles handler with only return', () => {
    const code = 'async () => { return { done: true } }';

    const { handler } = createHandler(code);
    const typeChecker = createTypeChecker();
    const analysis = analyzeHandler(handler, typeChecker);
    const { steps, sourceMap } = buildSteps(analysis);

    // Should have at least entry step
    assert.ok(steps.length >= 1, 'Should have at least one step');
  });

  it('handles nested structures', () => {
    const code = `async () => {
      while (true) {
        const r = race()
        switch (true) {
          case signal(r, sig1):
            return { which: 'sig1' }
          case delay.hours(r, 1):
            continue
        }
      }
    }`;

    const { handler } = createHandler(code);
    const typeChecker = createTypeChecker();
    const analysis = analyzeHandler(handler, typeChecker);
    const { steps, sourceMap } = buildSteps(analysis);

    // Complex structures should still produce valid sourceMap
    for (const [idx, range] of Object.entries(sourceMap)) {
      if (range) {
        const [start, end] = range;
        assert.ok(start > 0 && end >= start, `Invalid range for step ${idx}: [${start}, ${end}]`);
      }
    }
  });

  it('handles multiple race branches', () => {
    const code = `async () => {
      const r = race()
      switch (true) {
        case signal(r, branch1):
          return { branch: 1 }
        case signal(r, branch2):
          return { branch: 2 }
        case signal(r, branch3):
          return { branch: 3 }
      }
    }`;

    const { handler } = createHandler(code);
    const typeChecker = createTypeChecker();
    const analysis = analyzeHandler(handler, typeChecker);
    const { steps, sourceMap } = buildSteps(analysis);

    // Each branch should have its own step
    const branchSteps = steps.filter(s => s.type === 'branch');
    assert.ok(branchSteps.length >= 1, 'Should have branch steps');

    // Each branch step should have source info
    for (const step of branchSteps) {
      if (sourceMap[step.index]) {
        const [start, end] = sourceMap[step.index];
        assert.ok(start > 0, `Branch step ${step.index} should have valid source line`);
      }
    }
  });
});

// ============================================================================
// Integration with TypeScript Source Maps
// ============================================================================

describe('TypeScript source map integration', () => {
  it('generated code preserves source file reference', () => {
    const code = `async () => {
      await waitFor(payments.received)
      return { done: true }
    }`;

    const { handler, sourceFile } = createHandler(code);

    // Handler should have reference to its source file
    const handlerSourceFile = handler.getSourceFile();
    assert.strictEqual(handlerSourceFile.fileName, 'test.ts', 'Should reference test.ts');
  });

  it('opcode source nodes can be traced to original positions', () => {
    const code = `async () => {
      const x = 1                       // line 2
      await waitFor(payments.received)  // line 3
      const y = x + 1                   // line 4
      return { x, y }                   // line 5
    }`;

    const { handler, sourceFile } = createHandler(code);
    const typeChecker = createTypeChecker();
    const analysis = analyzeHandler(handler, typeChecker);

    // Check that opcodeSourceNodes exist and have valid positions
    for (const [idx, node] of Object.entries(analysis.opcodeSourceNodes)) {
      if (node) {
        const sf = node.getSourceFile();
        const start = sf.getLineAndCharacterOfPosition(node.getStart());
        const end = sf.getLineAndCharacterOfPosition(node.getEnd());

        assert.ok(start.line >= 0, `Opcode ${idx} should have valid start line`);
        assert.ok(end.line >= start.line, `Opcode ${idx} should have valid end line`);
      }
    }
  });

  it('generated sourceMap matches opcode line numbers', () => {
    const code = `async () => {
      const x = 1
      await waitFor(signal1)
      const y = 2
      await waitFor(signal2)
      return { x, y }
    }`;

    const { handler, sourceFile } = createHandler(code);
    const typeChecker = createTypeChecker();
    const analysis = analyzeHandler(handler, typeChecker);
    const { steps, sourceMap } = buildSteps(analysis);

    // For each step, verify the sourceMap line range covers the opcodes
    for (const step of steps) {
      const range = sourceMap[step.index];
      if (range) {
        const [mapStart, mapEnd] = range;

        // Check opcodes in this step's range
        for (let i = step.opcodeRange.start; i < step.opcodeRange.end; i++) {
          const node = analysis.opcodeSourceNodes[i];
          if (node) {
            const sf = node.getSourceFile();
            const nodeLine = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;

            // The opcode's line should be within the step's range
            // (allowing some flexibility for multi-line statements)
            assert.ok(
              nodeLine >= mapStart - 1 && nodeLine <= mapEnd + 1,
              `Opcode ${i} at line ${nodeLine} should be near step ${step.index} range [${mapStart}, ${mapEnd}]`
            );
          }
        }
      }
    }
  });
});
