/**
 * Labels for observability tests.
 *
 * These tests verify that labeled blocks generate LABEL_ENTER and LABEL_EXIT
 * opcodes for observability tracking.
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
// Label Opcode Tests
// ============================================================================

describe('Labels for Observability', () => {
  describe('LABEL_ENTER and LABEL_EXIT opcodes', () => {
    it('emits LABEL_ENTER and LABEL_EXIT for labeled block', () => {
      const result = analyze(`async () => {
        myLabel: {
          const x = 1
        }
      }`);

      assert.ok(result, 'Should return analysis result');
      assert.strictEqual(result.diagnostics.length, 0, 'Should have no diagnostics');

      // Should have LABEL_ENTER and LABEL_EXIT
      const enterOps = findOpcodes(result.opcodes, 'LABEL_ENTER');
      const exitOps = findOpcodes(result.opcodes, 'LABEL_EXIT');

      assert.strictEqual(enterOps.length, 1, 'Should have exactly one LABEL_ENTER');
      assert.strictEqual(exitOps.length, 1, 'Should have exactly one LABEL_EXIT');

      // Check label names
      assert.strictEqual(
        (enterOps[0] as { op: 'LABEL_ENTER'; label: string }).label,
        'myLabel',
        'LABEL_ENTER should have correct label'
      );
      assert.strictEqual(
        (exitOps[0] as { op: 'LABEL_EXIT'; label: string }).label,
        'myLabel',
        'LABEL_EXIT should have correct label'
      );
    });

    it('emits LABEL_ENTER and LABEL_EXIT for labeled block with signal', () => {
      const result = analyze(`async () => {
        waitForPayment: {
          await signal(orders.paid)
        }
      }`);

      assert.ok(result, 'Should return analysis result');

      // Should have LABEL_ENTER and LABEL_EXIT
      const enterOps = findOpcodes(result.opcodes, 'LABEL_ENTER');
      const exitOps = findOpcodes(result.opcodes, 'LABEL_EXIT');

      assert.strictEqual(enterOps.length, 1, 'Should have exactly one LABEL_ENTER');
      assert.strictEqual(exitOps.length, 1, 'Should have exactly one LABEL_EXIT');

      // Check that WAIT is between LABEL_ENTER and LABEL_EXIT
      const enterIndex = result.opcodes.indexOf(enterOps[0]);
      const exitIndex = result.opcodes.indexOf(exitOps[0]);
      const waitOps = findOpcodes(result.opcodes, 'WAIT');

      assert.ok(waitOps.length >= 1, 'Should have at least one WAIT opcode');

      const waitIndex = result.opcodes.indexOf(waitOps[0]);
      assert.ok(
        waitIndex > enterIndex && waitIndex < exitIndex,
        'WAIT should be between LABEL_ENTER and LABEL_EXIT'
      );
    });

    it('handles nested labeled blocks', () => {
      const result = analyze(`async () => {
        outer: {
          const x = 1
          inner: {
            const y = 2
          }
          const z = 3
        }
      }`);

      assert.ok(result, 'Should return analysis result');
      assert.strictEqual(result.diagnostics.length, 0, 'Should have no diagnostics');

      // Should have 2 LABEL_ENTER and 2 LABEL_EXIT
      const enterOps = findOpcodes(result.opcodes, 'LABEL_ENTER');
      const exitOps = findOpcodes(result.opcodes, 'LABEL_EXIT');

      assert.strictEqual(enterOps.length, 2, 'Should have two LABEL_ENTER opcodes');
      assert.strictEqual(exitOps.length, 2, 'Should have two LABEL_EXIT opcodes');

      // Check proper nesting: outer enters first, inner enters second
      // inner exits first, outer exits second
      const labels = result.opcodes
        .filter(op => op.op === 'LABEL_ENTER' || op.op === 'LABEL_EXIT')
        .map(op => ({ op: op.op, label: (op as { label: string }).label }));

      assert.strictEqual(labels[0].op, 'LABEL_ENTER');
      assert.strictEqual(labels[0].label, 'outer');
      assert.strictEqual(labels[1].op, 'LABEL_ENTER');
      assert.strictEqual(labels[1].label, 'inner');
      assert.strictEqual(labels[2].op, 'LABEL_EXIT');
      assert.strictEqual(labels[2].label, 'inner');
      assert.strictEqual(labels[3].op, 'LABEL_EXIT');
      assert.strictEqual(labels[3].label, 'outer');
    });

    it('emits LABEL_ENTER and LABEL_EXIT for labeled while loop', () => {
      const result = analyze(`async () => {
        retryLoop: while (true) {
          await signal(orders.attempt)
          break
        }
      }`);

      assert.ok(result, 'Should return analysis result');

      // Should have LABEL_ENTER and LABEL_EXIT
      const enterOps = findOpcodes(result.opcodes, 'LABEL_ENTER');
      const exitOps = findOpcodes(result.opcodes, 'LABEL_EXIT');

      assert.strictEqual(enterOps.length, 1, 'Should have exactly one LABEL_ENTER');
      assert.strictEqual(exitOps.length, 1, 'Should have exactly one LABEL_EXIT');

      assert.strictEqual(
        (enterOps[0] as { op: 'LABEL_ENTER'; label: string }).label,
        'retryLoop',
        'LABEL_ENTER should have correct label'
      );
    });

    it('preserves LABEL opcode for jump targets', () => {
      const result = analyze(`async () => {
        myLabel: {
          const x = 1
        }
      }`);

      // Should still have LABEL opcode for break/continue targets
      const labelOps = findOpcodes(result.opcodes, 'LABEL');

      assert.ok(labelOps.length >= 1, 'Should have at least one LABEL opcode for jump targets');
      assert.strictEqual(
        (labelOps[0] as { op: 'LABEL'; label: string }).label,
        'myLabel',
        'LABEL should have correct label'
      );
    });

    it('emits multiple labels for sequential labeled blocks', () => {
      const result = analyze(`async () => {
        step1: {
          await signal(orders.created)
        }
        step2: {
          await signal(orders.paid)
        }
        step3: {
          await signal(orders.shipped)
        }
      }`);

      assert.ok(result, 'Should return analysis result');

      // Should have 3 LABEL_ENTER and 3 LABEL_EXIT
      const enterOps = findOpcodes(result.opcodes, 'LABEL_ENTER');
      const exitOps = findOpcodes(result.opcodes, 'LABEL_EXIT');

      assert.strictEqual(enterOps.length, 3, 'Should have three LABEL_ENTER opcodes');
      assert.strictEqual(exitOps.length, 3, 'Should have three LABEL_EXIT opcodes');

      // Check labels in order
      const enterLabels = enterOps.map(op => (op as { label: string }).label);
      assert.deepStrictEqual(enterLabels, ['step1', 'step2', 'step3'], 'Labels should be in order');
    });
  });
});
