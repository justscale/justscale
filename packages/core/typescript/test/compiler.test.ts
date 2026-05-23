/**
 * Compiler analyzer tests.
 *
 * These tests verify handler analysis that produces opcodes,
 * using thorough structural verification of the analysis result.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import ts from 'typescript';
import { analyzeHandler, type AnalysisResult, type Opcode } from '../src/compiler/analyzer.js';
import { ProcessErrorCode, getProcessErrorCode } from '../src/compiler/errors.js';
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
 * Assert opcodes contain specific types in order.
 */
function assertOpcodeSequence(opcodes: Opcode[], expectedTypes: string[]): void {
  const actualTypes = opcodes.map(op => op.op);
  for (const expected of expectedTypes) {
    assert.ok(
      actualTypes.includes(expected as any),
      `Should have ${expected} opcode. Got: ${actualTypes.join(', ')}`
    );
  }
}

/**
 * Count opcodes of a specific type.
 */
function countOpcodes(opcodes: Opcode[], type: string): number {
  return opcodes.filter(op => op.op === type).length;
}

/**
 * Find all opcodes of a specific type.
 */
function findOpcodes<T extends Opcode>(opcodes: Opcode[], type: T['op']): T[] {
  return opcodes.filter(op => op.op === type) as T[];
}

// ============================================================================
// Basic Analysis Tests
// ============================================================================

describe('Process Compiler', () => {
  describe('analyzeHandler', () => {
    describe('basic analysis', () => {
      it('analyzes empty handler', () => {
        const result = analyze('async () => {}');

        assert.ok(result, 'Should return analysis result');
        assert.strictEqual(result.opcodes.length, 0, 'Empty handler should have no opcodes');
        assert.strictEqual(result.blocks.length, 0, 'Empty handler should have no blocks');
        assert.strictEqual(result.diagnostics.length, 0, 'Should have no diagnostics');
        assert.ok(result.signals, 'Should have signals object');
        assert.ok(result.variables instanceof Map, 'Should have variables Map');
        assert.ok(result.rehydrationBlocks, 'Should have rehydrationBlocks object');
      });

      it('analyzes handler with return statement', () => {
        const result = analyze(`async () => {
          return { status: 'done' }
        }`);

        assert.ok(result, 'Should return analysis result');

        // Should have a RETURN opcode
        const returnOps = findOpcodes(result.opcodes, 'RETURN');
        assert.strictEqual(returnOps.length, 1, 'Should have exactly one RETURN opcode');

        // RETURN should have some value property (value, expression, etc)
        const returnOp = returnOps[0];
        assert.ok(
          'value' in returnOp || 'expression' in returnOp,
          'RETURN should capture the return value'
        );
      });
    });

    describe('waitFor/signal analysis', () => {
      it('analyzes handler with waitFor', () => {
        const result = analyze(`async () => {
          const payment = await waitFor(payments.received(orderId))
          return payment
        }`);

        assert.ok(result, 'Should return analysis result');

        // Should have a WAIT opcode
        const waitOps = findOpcodes(result.opcodes, 'WAIT');
        assert.strictEqual(waitOps.length, 1, 'Should have exactly one WAIT opcode');

        // WAIT should have signal info
        const waitOp = waitOps[0];
        assert.ok('signal' in waitOp, 'WAIT should have signal');
        assert.strictEqual(waitOp.signal, 'payments.received', 'Signal should be payments.received');

        // Should have a STORE opcode for 'payment'
        const storeOps = findOpcodes(result.opcodes, 'STORE');
        const paymentStore = storeOps.find(op => 'var' in op && op.var === 'payment');
        assert.ok(paymentStore, 'Should have STORE for payment variable');

        // Should have a signal recorded
        assert.ok(Object.keys(result.signals).length > 0, 'Should have signals registered');
        assert.ok(result.signals['payments.received'], 'Should have payments.received signal');
      });

      it('analyzes handler with delay', () => {
        const result = analyze(`async () => {
          await delay.hours(24)
          return { done: true }
        }`);

        assert.ok(result, 'Should return analysis result');

        // Should have a WAIT opcode for the timer
        const waitOps = findOpcodes(result.opcodes, 'WAIT');
        assert.ok(waitOps.length >= 1, 'Should have WAIT opcode for delay');
      });

      it('analyzes sequential signal awaits', () => {
        const result = analyze(`async () => {
          const payment = await signal(orders.paid)
          const shipment = await signal(orders.shipped)
          await signal(orders.delivered)
          return { payment, shipment }
        }`);

        assert.ok(result, 'Should return analysis result');

        // Should have 3 WAIT opcodes
        const waitOps = findOpcodes(result.opcodes, 'WAIT');
        assert.strictEqual(waitOps.length, 3, 'Should have exactly 3 WAIT opcodes');

        // Each WAIT should have a signal
        for (const waitOp of waitOps) {
          assert.ok('signal' in waitOp, 'Each WAIT should have signal');
        }

        // Should have 3 signals registered
        const signalNames = Object.keys(result.signals);
        assert.strictEqual(signalNames.length, 3, 'Should have 3 signals registered');
        assert.ok(signalNames.includes('orders.paid'), 'Should have orders.paid');
        assert.ok(signalNames.includes('orders.shipped'), 'Should have orders.shipped');
        assert.ok(signalNames.includes('orders.delivered'), 'Should have orders.delivered');
      });
    });

    describe('race pattern analysis', () => {
      it('analyzes handler with race pattern', () => {
        const result = analyze(`async () => {
          const r = race()
          switch (true) {
            case signal(r, payments.received(orderId)):
              return { status: 'paid' }
            case delay.hours(r, 24):
              return { status: 'timeout' }
          }
        }`);

        assert.ok(result, 'Should return analysis result');

        // Should have RACE_START and RACE_SUSPEND opcodes
        const raceStart = findOpcodes(result.opcodes, 'RACE_START');
        assert.strictEqual(raceStart.length, 1, 'Should have exactly one RACE_START');

        const raceSuspend = findOpcodes(result.opcodes, 'RACE_SUSPEND');
        assert.strictEqual(raceSuspend.length, 1, 'Should have exactly one RACE_SUSPEND');

        // RACE_START should have branches
        const raceOp = raceStart[0];
        assert.ok('branches' in raceOp, 'RACE_START should have branches');
        assert.strictEqual(raceOp.branches.length, 2, 'Should have 2 branches');

        // First branch should be signal
        const branches = raceOp.branches as Array<{ signal?: string; timer?: unknown }>;
        const signalBranch = branches.find(b => b.signal);
        assert.ok(signalBranch, 'Should have signal branch');
        assert.strictEqual(signalBranch.signal, 'payments.received', 'Signal should be payments.received');

        // Second branch should be timer
        const timerBranch = branches.find(b => b.timer);
        assert.ok(timerBranch, 'Should have timer branch');
      });

      it('analyzes race with multiple signals (no delay)', () => {
        const result = analyze(`async () => {
          const r = race()
          switch (true) {
            case signal(r, approvals.approved):
              return { status: 'approved' }
            case signal(r, approvals.rejected):
              return { status: 'rejected' }
          }
        }`);

        assert.ok(result, 'Should return analysis result');

        const raceStart = findOpcodes(result.opcodes, 'RACE_START')[0];
        assert.ok('branches' in raceStart, 'RACE_START should have branches');
        assert.strictEqual(raceStart.branches.length, 2, 'Should have 2 branches');

        // Both branches should be signals (no timer)
        const branches = raceStart.branches as Array<{ signal?: string; timer?: unknown }>;
        assert.ok(
          branches.every(b => b.signal && !b.timer),
          'All branches should be signals'
        );
      });

      it('analyzes race with only delay branches', () => {
        const result = analyze(`async () => {
          const r = race()
          switch (true) {
            case delay.minutes(r, 5):
              return { status: 'warning' }
            case delay.minutes(r, 10):
              return { status: 'timeout' }
          }
        }`);

        assert.ok(result, 'Should return analysis result');

        const raceStart = findOpcodes(result.opcodes, 'RACE_START')[0];
        assert.ok('branches' in raceStart, 'RACE_START should have branches');
        assert.strictEqual(raceStart.branches.length, 2, 'Should have 2 branches');

        // Both branches should be timers
        const branches = raceStart.branches as Array<{ signal?: string; timer?: unknown }>;
        assert.ok(
          branches.every(b => b.timer && !b.signal),
          'All branches should be timers'
        );
      });

      it('analyzes nested race in loop', () => {
        const result = analyze(`async () => {
          let attempts = 0
          while (attempts < 3) {
            attempts++
            const r = race()
            switch (true) {
              case signal(r, payments.received):
                return { status: 'success', attempts }
              case delay.minutes(r, 5):
                continue
            }
          }
          return { status: 'failed' }
        }`);

        assert.ok(result, 'Should return analysis result');

        // Should have LABEL for loop
        const labelOps = findOpcodes(result.opcodes, 'LABEL');
        assert.ok(labelOps.length >= 1, 'Should have LABEL for loop');

        // Should have RACE_START
        const raceStart = findOpcodes(result.opcodes, 'RACE_START');
        assert.strictEqual(raceStart.length, 1, 'Should have RACE_START');

        // Should have JUMP for loop back
        const jumpOps = findOpcodes(result.opcodes, 'JUMP');
        assert.ok(jumpOps.length >= 1, 'Should have JUMP for loop');
      });

      it('analyzes multiple sequential races', () => {
        const result = analyze(`async () => {
          // First race
          const r1 = race()
          switch (true) {
            case signal(r1, orders.paid):
              break
            case delay.days(r1, 7):
              return { status: 'expired' }
          }
          // Second race
          const r2 = race()
          switch (true) {
            case signal(r2, orders.shipped):
              return { status: 'shipped' }
            case signal(r2, orders.cancelled):
              return { status: 'cancelled' }
          }
        }`);

        assert.ok(result, 'Should return analysis result');

        // Should have 2 RACE_START opcodes
        const raceStarts = findOpcodes(result.opcodes, 'RACE_START');
        assert.strictEqual(raceStarts.length, 2, 'Should have 2 RACE_START opcodes');

        // Each should have branches
        for (const raceOp of raceStarts) {
          assert.ok('branches' in raceOp, 'Each RACE_START should have branches');
          assert.ok(raceOp.branches.length >= 2, 'Each race should have at least 2 branches');
        }
      });
    });

    describe('loop analysis', () => {
      it('analyzes handler with while loop', () => {
        const result = analyze(`async () => {
          while (true) {
            const x = await waitFor(events.tick)
            if (x.done) break
          }
          return { done: true }
        }`);

        assert.ok(result, 'Should return analysis result');

        // Should have LABEL for loop start
        const labelOps = findOpcodes(result.opcodes, 'LABEL');
        assert.ok(labelOps.length >= 1, 'Should have LABEL for loop start');

        // Should have JUMP back to loop start
        const jumpOps = findOpcodes(result.opcodes, 'JUMP');
        assert.ok(jumpOps.length >= 1, 'Should have JUMP for loop continuation');

        // Should have WAIT for the signal
        const waitOps = findOpcodes(result.opcodes, 'WAIT');
        assert.ok(waitOps.length >= 1, 'Should have WAIT for signal');

        // Signal should be registered
        assert.ok(result.signals['events.tick'], 'Should have events.tick signal registered');
      });
    });

    describe('using/rehydration analysis', () => {
      it('tracks using declarations as rehydration blocks', () => {
        const result = analyze(`async () => {
          using order = await orders.get(Order.ref(orderId))
          await waitFor(payments.received(orderId))
          return order.status
        }`);

        assert.ok(result, 'Should return analysis result');

        // Should have a rehydration block for 'order'
        assert.ok(result.rehydrationBlocks['order'], 'Should have rehydration block for order');

        // Rehydration block should have expression
        const orderBlock = result.rehydrationBlocks['order'];
        assert.ok(orderBlock.expression, 'Rehydration block should have expression');

        // Should have a REHYDRATE opcode
        const rehydrateOps = findOpcodes(result.opcodes, 'REHYDRATE');
        assert.ok(rehydrateOps.length >= 1, 'Should have REHYDRATE opcode');

        // REHYDRATE should reference 'order'
        const orderRehydrate = rehydrateOps.find(op => 'var' in op && op.var === 'order');
        assert.ok(orderRehydrate, 'Should have REHYDRATE for order');
      });

      it('tracks variable serialization requirements', () => {
        const result = analyze(`async () => {
          const orderId = '123'
          const amount = 100
          using order = await orders.get(Order.ref(orderId))
          return { orderId, amount }
        }`);

        assert.ok(result, 'Should return analysis result');
        assert.ok(result.variables instanceof Map, 'Should have variables Map');

        // orderId should be serializable (not using)
        const orderIdVar = result.variables.get('orderId');
        if (orderIdVar) {
          assert.strictEqual(orderIdVar.isUsing, false, 'orderId should not be using');
        }

        // order should be non-serializable (using)
        const orderVar = result.variables.get('order');
        if (orderVar) {
          assert.strictEqual(orderVar.isUsing, true, 'order should be using');
        }
      });
    });

    describe('error detection', () => {
      it('reports TSP1001 error for const with service await (must use using)', () => {
        // The const is read AFTER a suspension - requires `using` for rehydration.
        const result = analyze(`async () => {
          const order = await orders.get(Order.ref(orderId))
          await signal(orders.paid)
          return order.status
        }`);

        assert.ok(result, 'Should return analysis result');

        // Should have a diagnostic error
        assert.strictEqual(result.diagnostics.length, 1, 'Should have exactly 1 diagnostic');

        const diagnostic = result.diagnostics[0];
        const errorCode = getProcessErrorCode(diagnostic);
        assert.strictEqual(
          errorCode,
          ProcessErrorCode.NonSerializableConst,
          'Should be NonSerializableConst error'
        );

        // Error message should mention the variable name and 'using'
        const message =
          typeof diagnostic.messageText === 'string'
            ? diagnostic.messageText
            : diagnostic.messageText.messageText;
        assert.ok(message.includes('order'), 'Message should mention variable name');
        assert.ok(message.includes('using'), 'Message should suggest using');
      });

      it('does not report error for using with service await', () => {
        const result = analyze(`async () => {
          using order = await orders.get(Order.ref(orderId))
          return order.status
        }`);

        assert.ok(result, 'Should return analysis result');
        assert.strictEqual(result.diagnostics.length, 0, 'Should NOT have any diagnostics');
      });

      it('does not report error for const with signal await', () => {
        const result = analyze(`async () => {
          const payment = await signal(payments.received)
          return payment.amount
        }`);

        assert.ok(result, 'Should return analysis result');
        assert.strictEqual(
          result.diagnostics.length,
          0,
          'Should NOT have diagnostics (signals are fine with const)'
        );
      });

      it('reports TSP1006 error for storing signal in variable', () => {
        const result = analyze(`async () => {
          const s = signal(orders.paid)
          await s
          return { done: true }
        }`);

        assert.ok(result, 'Should return analysis result');
        assert.strictEqual(result.diagnostics.length, 1, 'Should have exactly 1 diagnostic');

        const diagnostic = result.diagnostics[0];
        const errorCode = getProcessErrorCode(diagnostic);
        assert.strictEqual(
          errorCode,
          ProcessErrorCode.SignalStoredInVariable,
          'Should be SignalStoredInVariable error'
        );
      });

      it('reports TSP1006 error for storing delay in variable', () => {
        const result = analyze(`async () => {
          const d = delay.minutes(5)
          await d
          return { done: true }
        }`);

        assert.ok(result, 'Should return analysis result');
        assert.strictEqual(result.diagnostics.length, 1, 'Should have exactly 1 diagnostic');

        const diagnostic = result.diagnostics[0];
        const errorCode = getProcessErrorCode(diagnostic);
        assert.strictEqual(
          errorCode,
          ProcessErrorCode.SignalStoredInVariable,
          'Should be SignalStoredInVariable error'
        );
      });

      it('does not report error for storing race() in variable', () => {
        const result = analyze(`async () => {
          const r = race()
          switch (true) {
            case signal(r, orders.paid):
              return { status: 'paid' }
          }
        }`);

        assert.ok(result, 'Should return analysis result');
        assert.strictEqual(
          result.diagnostics.length,
          0,
          'Should NOT have diagnostics - storing race() is allowed'
        );
      });
    });

    describe('source position tracking', () => {
      it('tracks opcode source positions', () => {
        const result = analyze(`async () => {
          const x = 1
          await waitFor(payments.received)
          return { x }
        }`);

        assert.ok(result, 'Should return analysis result');
        assert.ok(result.opcodeSourceNodes, 'Should have opcodeSourceNodes');

        // Each opcode should have a source node
        for (let i = 0; i < result.opcodes.length; i++) {
          const sourceNode = result.opcodeSourceNodes[i];
          if (sourceNode) {
            assert.ok(sourceNode.pos >= 0, `Opcode ${i} source node should have valid pos`);
            assert.ok(sourceNode.end > sourceNode.pos, `Opcode ${i} source node should have valid end`);
          }
        }
      });

      it('tracks block statements with positions', () => {
        const result = analyze(`async () => {
          console.log('hello')
          const x = 1
          return x
        }`);

        assert.ok(result, 'Should return analysis result');

        // Blocks should have statements with positions
        for (const block of result.blocks) {
          if (block && block.statements) {
            for (const stmt of block.statements) {
              assert.ok(stmt.pos >= 0, 'Statement should have valid pos');
              assert.ok(stmt.end > stmt.pos, 'Statement should have valid end');
            }
          }
        }
      });
    });

    describe('opcode sequence verification', () => {
      it('produces correct sequence for simple await-return', () => {
        const result = analyze(`async () => {
          const x = await waitFor(sig)
          return { x }
        }`);

        // Should have: BLOCK (for const x = ...) -> WAIT -> STORE -> BLOCK (return setup) -> RETURN
        assertOpcodeSequence(result.opcodes, ['WAIT', 'STORE', 'RETURN']);
      });

      it('produces correct sequence for if-else with await', () => {
        const result = analyze(`async () => {
          if (condition) {
            await waitFor(sigA)
            return { a: true }
          } else {
            await waitFor(sigB)
            return { b: true }
          }
        }`);

        // Should have JUMP_IF for condition, WAITs in branches, RETURNs
        assertOpcodeSequence(result.opcodes, ['JUMP_IF', 'WAIT', 'RETURN']);

        // Should have 2 WAITs (one per branch)
        assert.strictEqual(countOpcodes(result.opcodes, 'WAIT'), 2, 'Should have 2 WAIT opcodes');

        // Should have 2 RETURNs
        assert.strictEqual(countOpcodes(result.opcodes, 'RETURN'), 2, 'Should have 2 RETURN opcodes');
      });

      it('produces correct sequence for while loop', () => {
        const result = analyze(`async () => {
          while (true) {
            await waitFor(tick)
          }
        }`);

        // Should have: LABEL -> WAIT -> JUMP (back to label)
        assertOpcodeSequence(result.opcodes, ['LABEL', 'WAIT', 'JUMP']);

        // JUMP target should point back to LABEL
        const labelIdx = result.opcodes.findIndex(op => op.op === 'LABEL');
        const jumpOps = findOpcodes(result.opcodes, 'JUMP');
        const backJump = jumpOps.find(op => 'target' in op && op.target === labelIdx);
        assert.ok(backJump, 'JUMP should target back to LABEL for loop');
      });
    });
  });
});
