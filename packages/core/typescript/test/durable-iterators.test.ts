/**
 * Durable iterators tests.
 *
 * These tests verify that for-of loops with suspension points generate
 * ITER_START, ITER_NEXT, and ITER_SAVE opcodes for durable iteration.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { analyzeHandler, type AnalysisResult, type Opcode } from '../src/compiler/analyzer.js';
import { createHandler, createTypeChecker } from './test-utils.js';

// ============================================================================
// Analysis Helpers
// ============================================================================

/**
 * Analyze a handler code string and return the analysis result.
 */
function analyze(code: string): AnalysisResult {
  const handler = createHandler(code);
  const typeChecker = createTypeChecker();
  return analyzeHandler(handler, typeChecker);
}

/**
 * Find all opcodes of a specific type.
 */
function findOpcodes<T extends Opcode>(opcodes: Opcode[], type: T['op']): T[] {
  return opcodes.filter(op => op.op === type) as T[];
}

// ============================================================================
// Durable Iterator Opcode Tests
// ============================================================================

describe('Durable Iterators', () => {
  describe('for-of with suspension', () => {
    it('generates ITER_START, ITER_NEXT, ITER_SAVE for for-of with signal', () => {
      const result = analyze(`async () => {
        const items = ['a', 'b', 'c']
        for (const item of items) {
          await signal(orders.processed)
        }
      }`);

      assert.ok(result, 'Should return analysis result');
      assert.strictEqual(result.diagnostics.length, 0, 'Should have no diagnostics');

      // Should have ITER_START, ITER_NEXT, ITER_SAVE
      const iterStartOps = findOpcodes(result.opcodes, 'ITER_START');
      const iterNextOps = findOpcodes(result.opcodes, 'ITER_NEXT');
      const iterSaveOps = findOpcodes(result.opcodes, 'ITER_SAVE');

      assert.strictEqual(iterStartOps.length, 1, 'Should have exactly one ITER_START');
      assert.strictEqual(iterNextOps.length, 1, 'Should have exactly one ITER_NEXT');
      assert.strictEqual(iterSaveOps.length, 1, 'Should have exactly one ITER_SAVE');
    });

    it('extracts item variable name from for-of', () => {
      const result = analyze(`async () => {
        const orders = [1, 2, 3]
        for (const order of orders) {
          await signal(fulfillment.shipped)
        }
      }`);

      assert.ok(result, 'Should return analysis result');
      assert.strictEqual(result.diagnostics.length, 0, 'Should have no diagnostics');

      const iterStartOps = findOpcodes(result.opcodes, 'ITER_START');
      assert.strictEqual(iterStartOps.length, 1, 'Should have one ITER_START');

      const iterStart = iterStartOps[0] as { op: 'ITER_START'; itemVar: string };
      assert.strictEqual(iterStart.itemVar, 'order', 'Should extract item variable name');
    });

    it('generates unique loop IDs for nested loops', () => {
      const result = analyze(`async () => {
        const outer = [1, 2]
        for (const o of outer) {
          await signal(svc.outerDone)
          const inner = [3, 4]
          for (const i of inner) {
            await signal(svc.innerDone)
          }
        }
      }`);

      assert.ok(result, 'Should return analysis result');

      const iterStartOps = findOpcodes(result.opcodes, 'ITER_START');
      assert.strictEqual(iterStartOps.length, 2, 'Should have two ITER_START opcodes');

      const loopIds = iterStartOps.map(op => (op as { loopId: number }).loopId);
      assert.strictEqual(loopIds[0], 0, 'First loop should have ID 0');
      assert.strictEqual(loopIds[1], 1, 'Second loop should have ID 1');
    });

    it('generates cursor variable names with loop IDs', () => {
      const result = analyze(`async () => {
        for (const item of items) {
          await signal(svc.done)
        }
      }`);

      assert.ok(result, 'Should return analysis result');

      const iterStartOps = findOpcodes(result.opcodes, 'ITER_START');
      const iterStart = iterStartOps[0] as { op: 'ITER_START'; cursorVar: string; loopId: number };

      assert.strictEqual(iterStart.cursorVar, '__cursor_0', 'Cursor var should include loop ID');
    });

    it('generates JUMP to loop start and LABEL for loop end', () => {
      const result = analyze(`async () => {
        for (const item of items) {
          await signal(svc.done)
        }
      }`);

      assert.ok(result, 'Should return analysis result');

      const jumpOps = findOpcodes(result.opcodes, 'JUMP');
      const labelOps = findOpcodes(result.opcodes, 'LABEL');

      // Should have JUMP back to loop start
      assert.ok(jumpOps.length >= 1, 'Should have at least one JUMP opcode');

      // Should have LABELs for loop start and end
      const loopLabels = labelOps.filter(op =>
        (op as { label: string }).label.startsWith('__loop_')
      );
      assert.strictEqual(loopLabels.length, 2, 'Should have start and end loop labels');
    });

    it('allows for-of without suspension as regular statement', () => {
      const result = analyze(`async () => {
        const items = [1, 2, 3]
        let sum = 0
        for (const item of items) {
          sum += item
        }
        return { sum }
      }`);

      assert.ok(result, 'Should return analysis result');
      assert.strictEqual(result.diagnostics.length, 0, 'Should have no diagnostics');

      // Should NOT have ITER_* opcodes (no suspension)
      const iterStartOps = findOpcodes(result.opcodes, 'ITER_START');
      assert.strictEqual(iterStartOps.length, 0, 'Should have no ITER_START for loop without suspension');
    });

    it('sets ITER_NEXT doneTarget to loop end', () => {
      const result = analyze(`async () => {
        for (const item of items) {
          await signal(svc.done)
        }
      }`);

      assert.ok(result, 'Should return analysis result');

      const iterNextOps = findOpcodes(result.opcodes, 'ITER_NEXT');
      assert.strictEqual(iterNextOps.length, 1, 'Should have one ITER_NEXT');

      const iterNext = iterNextOps[0] as { op: 'ITER_NEXT'; doneTarget: number };
      const labelOps = findOpcodes(result.opcodes, 'LABEL');
      const endLabel = labelOps.find(op =>
        (op as { label: string }).label === '__loop_0_end'
      );

      assert.ok(endLabel, 'Should have end label');
      const endLabelIndex = result.opcodes.indexOf(endLabel!);
      assert.strictEqual(iterNext.doneTarget, endLabelIndex, 'doneTarget should point to end label');
    });
  });

  describe('DurableArrayIterator integration', () => {
    it('tracks item variable in variables map', () => {
      const result = analyze(`async () => {
        for (const order of orders) {
          await signal(svc.done)
        }
      }`);

      assert.ok(result, 'Should return analysis result');
      assert.ok(result.variables.has('order'), 'Should track loop variable in variables map');

      const varInfo = result.variables.get('order')!;
      assert.strictEqual(varInfo.name, 'order', 'Variable info should have correct name');
      assert.strictEqual(varInfo.isSerializable, true, 'Loop variable should be serializable');
    });
  });
});
