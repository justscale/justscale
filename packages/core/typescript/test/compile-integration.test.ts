/**
 * Integration tests for the process compiler.
 *
 * These tests verify the full compilation pipeline from source code to generated output,
 * using structured verification to ensure correctness.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { compileProcessSource, formatDiagnostics } from '../src/compiler/compile.js';
import {
  parseOutput,
  assertVMStructure,
  assertValidStepHashes,
  assertSequentialIndices,
  assertSourceMapMatch,
  assertStepCaseMatch,
  assertValidSourceMapRanges,
} from './test-utils.js';

describe('Process Compilation Integration', () => {
  describe('simple process compilation', () => {
    it('compiles a simple process with waitFor', () => {
      const source = `
        import { createProcess, waitFor } from '@justscale/core/process'

        const PaymentService = {} as any

        export const orderProcess = createProcess({
          path: '/order/:orderId',
          inject: { payments: PaymentService },
          async handler({ payments }, [orderId]) {
            const payment = await waitFor(payments.received(orderId))
            return { status: 'paid', payment }
          }
        })
      `;

      const result = compileProcessSource(source, 'order.process.ts', { verbose: false });

      // Should have no errors
      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      // Parse and verify structure
      const parsed = parseOutput(result.outputText);

      // Verify transformation
      assert.ok(
        result.outputText.includes('__createProcess'),
        'Should transform to __createProcess'
      );

      // Verify VM structure
      assertVMStructure(parsed);

      // Verify stepMap structure
      assert.ok(parsed.stepMapCount >= 2, `Should have at least 2 steps (entry + resume), got ${parsed.stepMapCount}`);
      assertValidStepHashes(parsed.stepMapEntries);
      assertSequentialIndices(parsed.stepMapEntries);

      // Verify step hashes contain expected types
      const hashes = Object.keys(parsed.stepMapEntries);
      assert.ok(hashes.some(h => h.startsWith('entry_')), 'Should have entry step');
      assert.ok(hashes.some(h => h.startsWith('resume_')), 'Should have resume step after WAIT');

      // Verify sourceMap
      assertSourceMapMatch(parsed);
      assertValidSourceMapRanges(parsed.sourceMapEntries);

      // Verify case statements match steps
      assertStepCaseMatch(parsed);

      // Verify signal registration
      assert.ok(parsed.signalNames.includes('payments.received'), 'Should register payments.received signal');

      // Verify suspend/done patterns
      assert.ok(parsed.hasSuspendPattern, 'Should have suspend pattern for await');
      assert.ok(parsed.hasDonePattern, 'Should have done pattern for return');

      // Verify path is preserved
      assert.strictEqual(parsed.path, '/order/:orderId', 'Should preserve path');
    });
  });

  describe('race pattern compilation', () => {
    it('compiles a process with race pattern', () => {
      const source = `
        import { createProcess, signal, race, delay } from '@justscale/core/process'

        const PaymentService = {} as any

        export const paymentProcess = createProcess({
          path: '/payment/:orderId',
          inject: { payments: PaymentService },
          async handler({ payments }, [orderId]) {
            const r = race()
            switch (true) {
              case signal(r, payments.received(orderId)):
                return { status: 'paid' }
              case delay.hours(r, 24):
                return { status: 'timeout' }
            }
          }
        })
      `;

      const result = compileProcessSource(source, 'payment.process.ts');

      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const parsed = parseOutput(result.outputText);

      // Verify transformation
      assert.ok(result.outputText.includes('__createProcess'), 'Should transform');

      // Verify VM structure
      assertVMStructure(parsed);

      // Verify race handling
      assert.ok(parsed.raceConfigs >= 1, `Should have race config, got ${parsed.raceConfigs}`);

      // Verify branch steps exist
      const hashes = Object.keys(parsed.stepMapEntries);
      assert.ok(hashes.some(h => h.startsWith('branch_')), 'Should have branch steps for race');

      // Verify step structure
      assert.ok(parsed.stepMapCount >= 3, `Should have at least 3 steps (entry + 2 branches), got ${parsed.stepMapCount}`);
      assertValidStepHashes(parsed.stepMapEntries);

      // Verify signal is registered
      assert.ok(parsed.signalNames.includes('payments.received'), 'Should have payments.received signal');

      // Verify __raceBranches are generated
      assert.ok(result.outputText.includes('__raceBranches'), 'Should have __raceBranches');
      assert.ok(parsed.raceBranches >= 2, `Should have at least 2 race branches, got ${parsed.raceBranches}`);
    });
  });

  describe('using declaration compilation', () => {
    it('compiles a process with using (rehydration)', () => {
      const source = `
        import { createProcess, waitFor } from '@justscale/core/process'

        const OrderService = {} as any
        const PaymentService = {} as any

        export const checkoutProcess = createProcess({
          path: '/checkout/:orderId',
          inject: { orders: OrderService, payments: PaymentService },
          async handler({ orders, payments }, [orderId]) {
            using order = await orders.get(Order.ref(orderId))
            const payment = await waitFor(payments.received(orderId))
            return { orderId: order.id, payment }
          }
        })
      `;

      const result = compileProcessSource(source, 'checkout.process.ts');

      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const parsed = parseOutput(result.outputText);

      // Verify __dispose array for using vars cleanup
      assert.ok(parsed.hasDispose, 'Should have __dispose for using vars');

      // Verify Symbol.dispose pattern
      assert.ok(
        result.outputText.includes('[Symbol.dispose]'),
        'Should have Symbol.dispose cleanup'
      );

      // Verify disposal index tracking
      assert.ok(result.outputText.includes('__dispose_i'), 'Should have disposal index');

      // Verify using var is declared at function scope
      assert.ok(result.outputText.includes('let order'), 'Should declare order at function scope');

      // Verify inline rehydration in resume steps
      assert.ok(
        result.outputText.includes('orders.get'),
        'Should contain rehydration call'
      );

      // Verify VM structure
      assertVMStructure(parsed);

      // Verify signal registration
      assert.ok(parsed.signalNames.includes('payments.received'), 'Should register signal');
    });
  });

  describe('loop compilation', () => {
    it('compiles a process with while loop', () => {
      const source = `
        import { createProcess, signal, race, delay } from '@justscale/core/process'

        const MotionService = {} as any
        const LightService = {} as any

        export const motionLightProcess = createProcess({
          path: '/room/:roomId/motion-light',
          inject: { motion: MotionService, light: LightService },
          async handler({ motion, light }, [roomId]) {
            await light.turnOn(roomId)

            while (true) {
              const r = race()
              switch (true) {
                case delay.minutes(r, 5):
                  await light.turnOff(roomId)
                  return { status: 'off' }
                case signal(r, motion.detected(roomId)):
                  continue
              }
            }
          }
        })
      `;

      const result = compileProcessSource(source, 'motion-light.process.ts');

      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const parsed = parseOutput(result.outputText);

      // Verify VM structure
      assertVMStructure(parsed);

      // Verify continue main_loop for loop back
      assert.ok(parsed.hasContinueMainLoop, 'Should have continue main_loop for loop jumps');

      // Verify step structure
      assertValidStepHashes(parsed.stepMapEntries);
      assertSequentialIndices(parsed.stepMapEntries);

      // Verify signal registration
      assert.ok(parsed.signalNames.includes('motion.detected'), 'Should register motion signal');
    });
  });

  describe('metadata generation', () => {
    it('generates version hash', () => {
      const source = `
        import { createProcess, waitFor } from '@justscale/core/process'

        const Svc = {} as any

        export const testProcess = createProcess({
          path: '/test/:id',
          inject: { svc: Svc },
          async handler({ svc }, [id]) {
            const result = await waitFor(svc.done(id))
            return result
          }
        })
      `;

      const result = compileProcessSource(source);
      const parsed = parseOutput(result.outputText);

      // Should have version with v_ prefix
      assert.ok(parsed.version, 'Should have version');
      assert.ok(parsed.version!.startsWith('v_'), `Version should start with v_, got ${parsed.version}`);

      // Version should be 8 hex chars after prefix
      const hex = parsed.version!.slice(2);
      assert.ok(/^[a-f0-9]{8}$/.test(hex), `Version hex should be 8 chars, got ${hex}`);
    });

    it('preserves inject object', () => {
      const source = `
        import { createProcess, waitFor } from '@justscale/core/process'

        const PaymentService = { token: 'payment' } as any
        const ShippingService = { token: 'shipping' } as any

        export const orderProcess = createProcess({
          path: '/order/:id',
          inject: { payments: PaymentService, shipping: ShippingService },
          async handler({ payments, shipping }, [id]) {
            const p = await waitFor(payments.received(id))
            return p
          }
        })
      `;

      const result = compileProcessSource(source);

      // Should preserve the inject object
      assert.ok(
        result.outputText.includes('payments: PaymentService'),
        'Should preserve payments in inject'
      );
      assert.ok(
        result.outputText.includes('shipping: ShippingService'),
        'Should preserve shipping in inject'
      );
    });

    it('generates process id from path', () => {
      const source = `
        import { createProcess, waitFor } from '@justscale/core/process'

        const Svc = {} as any

        export const testProcess = createProcess({
          path: '/order/:orderId/items/:itemId',
          inject: { svc: Svc },
          async handler({ svc }, [orderId, itemId]) {
            return { orderId, itemId }
          }
        })
      `;

      const result = compileProcessSource(source);
      const parsed = parseOutput(result.outputText);

      // id should be derived from path
      assert.ok(parsed.id, 'Should have id');
      assert.ok(parsed.id!.includes('order'), 'id should include path segment');
    });
  });

  describe('import transformation', () => {
    it('transforms import to use __createProcess', () => {
      const source = `
        import { createProcess, waitFor, signal } from '@justscale/core/process'

        const Svc = {} as any

        export const testProcess = createProcess({
          path: '/test/:id',
          inject: { svc: Svc },
          async handler({ svc }, [id]) {
            return { id }
          }
        })
      `;

      const result = compileProcessSource(source);

      // Should replace createProcess with __createProcess in import
      assert.ok(
        result.outputText.includes('__createProcess'),
        'Should have __createProcess in output'
      );
      assert.ok(
        result.outputText.includes('import { waitFor, signal, __createProcess }'),
        'Should transform import'
      );

      // createProcess should be removed from import
      const importMatch = result.outputText.match(/import \{[^}]+\} from ['"]@justscale\/process['"]/);
      if (importMatch) {
        assert.ok(
          !importMatch[0].includes('createProcess,') && !importMatch[0].includes(', createProcess'),
          'Should remove createProcess from import'
        );
      }
    });
  });

  describe('declaration file generation', () => {
    it('generates declaration output', () => {
      const source = `
        import { createProcess, waitFor } from '@justscale/core/process'

        const PaymentService = {} as any

        export const orderProcess = createProcess({
          path: '/order/:orderId',
          inject: { payments: PaymentService },
          async handler({ payments }, [orderId]) {
            const payment = await waitFor(payments.received(orderId))
            return { status: 'paid', payment }
          }
        })
      `;

      const result = compileProcessSource(source, 'order.process.ts');

      // Should generate declaration text
      assert.ok(result.declarationText, 'Should have declaration text');

      // Should export the orderProcess variable
      assert.ok(
        result.declarationText!.includes('orderProcess'),
        'Should include exported variable name'
      );
    });
  });

  describe('source map generation', () => {
    it('generates source maps when enabled', () => {
      const source = `
        import { createProcess, waitFor } from '@justscale/core/process'

        const Svc = {} as any

        export const testProcess = createProcess({
          path: '/test/:id',
          inject: { svc: Svc },
          async handler({ svc }, [id]) {
            return { done: true }
          }
        })
      `;

      const result = compileProcessSource(source, 'test.process.ts', { sourceMap: true });

      // Should generate source map
      assert.ok(result.sourceMapText, 'Should have source map text');

      // Source map should be valid JSON
      const sourceMap = JSON.parse(result.sourceMapText!);
      assert.strictEqual(sourceMap.version, 3, 'Should be source map v3');
      assert.ok(Array.isArray(sourceMap.sources), 'Should have sources array');
      assert.ok(sourceMap.mappings, 'Should have mappings');
    });

    it('generates stepMap and sourceMap properties in output', () => {
      const source = `
        import { createProcess, waitFor } from '@justscale/core/process'

        const Svc = {} as any

        export const testProcess = createProcess({
          path: '/test/:id',
          inject: { svc: Svc },
          async handler({ svc }, [id]) {
            const result = await waitFor(svc.done(id))
            return result
          }
        })
      `;

      const result = compileProcessSource(source);
      const parsed = parseOutput(result.outputText);

      // Verify stepMap
      assert.ok(parsed.stepMapCount > 0, 'Should have stepMap entries');
      assertValidStepHashes(parsed.stepMapEntries);

      // Verify sourceMap
      assert.ok(parsed.sourceMapCount > 0, 'Should have sourceMap entries');
      assertValidSourceMapRanges(parsed.sourceMapEntries);

      // Counts should match
      assertSourceMapMatch(parsed);
    });
  });

  describe('execute function generation', () => {
    it('generates execute function with proper structure', () => {
      const source = `
        import { createProcess, waitFor } from '@justscale/core/process'

        const Svc = {} as any

        export const testProcess = createProcess({
          path: '/test/:id',
          inject: { svc: Svc },
          async handler({ svc }, [id]) {
            const result = await waitFor(svc.done(id))
            return result
          }
        })
      `;

      const result = compileProcessSource(source);
      const parsed = parseOutput(result.outputText);

      // Should have execute property
      assert.ok(result.outputText.includes('execute:'), 'Should have execute property');

      // Should have async arrow function
      assert.ok(result.outputText.includes('async (ctx)'), 'Should have async (ctx) =>');

      // Should destructure state and services
      assert.ok(
        result.outputText.includes('const { state, services } = ctx'),
        'Should destructure state and services'
      );

      // Should have result tuple initialization
      assert.ok(result.outputText.includes('const __r'), 'Should have __r result tuple');

      // Should have step initialization
      assert.ok(
        result.outputText.includes('step = state.step'),
        'Should initialize step from state'
      );

      // Should return __r at end
      assert.ok(result.outputText.includes('return __r'), 'Should return __r');

      // Should have state.step persistence on suspend
      assert.ok(
        result.outputText.includes('state.step = step'),
        'Should persist state.step on suspend'
      );
    });

    it('generates DONE pattern with __r[0] = 0', () => {
      const source = `
        import { createProcess } from '@justscale/core/process'

        const Svc = {} as any

        export const testProcess = createProcess({
          path: '/test/:id',
          inject: { svc: Svc },
          async handler({ svc }, [id]) {
            return { done: true }
          }
        })
      `;

      const result = compileProcessSource(source);
      const parsed = parseOutput(result.outputText);

      // Should have DONE pattern
      assert.ok(parsed.hasDonePattern, 'Should have DONE pattern __r[0] = 0');
    });

    it('generates SUSPEND pattern with __r[0] = 1', () => {
      const source = `
        import { createProcess, waitFor } from '@justscale/core/process'

        const Svc = {} as any

        export const testProcess = createProcess({
          path: '/test/:id',
          inject: { svc: Svc },
          async handler({ svc }, [id]) {
            await waitFor(svc.event)
            return { done: true }
          }
        })
      `;

      const result = compileProcessSource(source);
      const parsed = parseOutput(result.outputText);

      // Should have SUSPEND pattern
      assert.ok(parsed.hasSuspendPattern, 'Should have SUSPEND pattern __r[0] = 1');

      // Should have signal config
      assert.ok(result.outputText.includes('signal:'), 'Should have signal in suspend config');
    });
  });

  describe('signals generation', () => {
    it('generates signals object with identity and payloadType', () => {
      const source = `
        import { createProcess, waitFor, signal } from '@justscale/core/process'

        const Svc = {} as any

        export const testProcess = createProcess({
          path: '/test/:id',
          inject: { svc: Svc },
          async handler({ svc }, [id]) {
            await waitFor(svc.payment(id))
            await signal(svc.shipped)
            return { done: true }
          }
        })
      `;

      const result = compileProcessSource(source);
      const parsed = parseOutput(result.outputText);

      // Should have signals
      assert.ok(parsed.signalNames.length >= 2, `Should have at least 2 signals, got ${parsed.signalNames.length}`);

      // Each signal should have identity and payloadType
      assert.ok(result.outputText.includes('identity:'), 'Signals should have identity');
      assert.ok(result.outputText.includes('payloadType:'), 'Signals should have payloadType');
    });
  });

  describe('version hash consistency', () => {
    it('same code produces same version hash', () => {
      const source = `
        import { createProcess, waitFor } from '@justscale/core/process'
        const Svc = {} as any
        export const testProcess = createProcess({
          path: '/test/:id',
          inject: { svc: Svc },
          async handler({ svc }, [id]) {
            await waitFor(svc.event)
            return { done: true }
          }
        })
      `;

      const result1 = compileProcessSource(source);
      const result2 = compileProcessSource(source);

      const parsed1 = parseOutput(result1.outputText);
      const parsed2 = parseOutput(result2.outputText);

      assert.strictEqual(parsed1.version, parsed2.version, 'Same code should produce same version');
    });

    it('different suspension points produce different versions', () => {
      const source1 = `
        import { createProcess, waitFor } from '@justscale/core/process'
        const Svc = {} as any
        export const testProcess = createProcess({
          path: '/test/:id',
          inject: { svc: Svc },
          async handler({ svc }, [id]) {
            await waitFor(svc.event)
            return { done: true }
          }
        })
      `;

      const source2 = `
        import { createProcess, waitFor } from '@justscale/core/process'
        const Svc = {} as any
        export const testProcess = createProcess({
          path: '/test/:id',
          inject: { svc: Svc },
          async handler({ svc }, [id]) {
            await waitFor(svc.event)
            await waitFor(svc.another)
            return { done: true }
          }
        })
      `;

      const parsed1 = parseOutput(compileProcessSource(source1).outputText);
      const parsed2 = parseOutput(compileProcessSource(source2).outputText);

      assert.notStrictEqual(
        parsed1.version,
        parsed2.version,
        'Different suspension points should produce different versions'
      );
    });
  });
});
