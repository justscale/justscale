/**
 * Tests for signal type detection in the process compiler.
 *
 * Verifies that the compiler properly handles:
 * - Valid signal patterns (property access like svc.paid)
 * - Invalid signal patterns (plain objects, string literals, etc.)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { compileProcessSource, formatDiagnostics } from '../src/compiler/compile.js';
import { parseOutput } from './test-utils.js';

describe('Signal Type Detection', () => {
  describe('valid signal patterns', () => {
    it('accepts property access pattern (svc.signalName)', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const PaymentService = {} as any
        export const test = createProcess({
          path: '/test/:id',
          inject: { payments: PaymentService },
          async handler({ payments }, [id]) {
            await signal(payments.received)
            return { done: true }
          }
        })
      `;

      const result = compileProcessSource(source, 'test.ts', { verbose: false });

      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const parsed = parseOutput(result.outputText);
      assert.ok(parsed.hasSuspendPattern, 'Should generate suspend for signal (__r[0] = 1)');
      assert.ok(parsed.signalNames.includes('payments.received'), 'Should extract signal name');
    });

    it('accepts call expression pattern (svc.signalName(identity))', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const PaymentService = {} as any
        export const test = createProcess({
          path: '/test/:id',
          inject: { payments: PaymentService },
          async handler({ payments }, [id]) {
            await signal(payments.received(id))
            return { done: true }
          }
        })
      `;

      const result = compileProcessSource(source, 'test.ts', { verbose: false });

      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const parsed = parseOutput(result.outputText);
      assert.ok(parsed.hasSuspendPattern, 'Should generate suspend for signal');
      assert.ok(parsed.signalNames.includes('payments.received'), 'Should extract signal name');
    });
  });

  describe('signal argument patterns', () => {
    it('extracts identifier reference (for createSignal exports)', () => {
      // Identifiers ARE accepted because they could be createSignal() exports
      // e.g., await signal(emailVerified) where emailVerified = createSignal(...)
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const mySignalRef = { foo: 'bar' }
            await signal(mySignalRef)
            return { done: true }
          }
        })
      `;

      const result = compileProcessSource(source, 'test.ts', { verbose: false });
      const parsed = parseOutput(result.outputText);

      // Should have suspend
      assert.ok(parsed.hasSuspendPattern, 'Should generate suspend');

      // Identifiers ARE extracted as potential createSignal references
      assert.ok(
        parsed.signalNames.includes('mySignalRef'),
        'Should extract identifier as signal name'
      );
    });

    it('optimizes away string literal argument (invalid signal)', () => {
      // String literals are not valid signal references, so the compiler
      // optimizes away the entire signal() call
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            await signal("not-a-signal" as any)
            return { done: true }
          }
        })
      `;

      const result = compileProcessSource(source, 'test.ts', { verbose: false });

      const parsed = parseOutput(result.outputText);

      // No suspend generated - invalid signal is optimized away
      assert.strictEqual(parsed.hasSuspendPattern, false, 'Should NOT generate suspend for invalid signal');

      // No signal should be extracted
      assert.strictEqual(
        parsed.signalNames.length,
        0,
        'Should NOT extract string literal as signal'
      );
    });

    it('handles number literal argument', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            await signal(42 as any)
            return { done: true }
          }
        })
      `;

      const result = compileProcessSource(source, 'test.ts', { verbose: false });

      const parsed = parseOutput(result.outputText);
      assert.strictEqual(
        parsed.signalNames.length,
        0,
        'Should NOT extract number as signal'
      );
    });
  });

  describe('race pattern signal detection', () => {
    it('extracts signals from race switch cases', () => {
      const source = `
        import { createProcess, signal, race, delay } from '@justscale/core/process'
        const PaymentService = {} as any
        export const test = createProcess({
          path: '/test/:id',
          inject: { payments: PaymentService },
          async handler({ payments }, [id]) {
            const r = race()
            switch (true) {
              case signal(r, payments.received):
                return { status: 'paid' }
              case signal(r, payments.refunded):
                return { status: 'refunded' }
              case delay.hours(r, 24):
                return { status: 'timeout' }
            }
          }
        })
      `;

      const result = compileProcessSource(source, 'test.ts', { verbose: false });

      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const parsed = parseOutput(result.outputText);
      assert.ok(parsed.signalNames.includes('payments.received'), 'Should extract payments.received');
      assert.ok(parsed.signalNames.includes('payments.refunded'), 'Should extract payments.refunded');
    });

    it('extracts identifier as signal (for createSignal pattern)', () => {
      // Identifiers ARE accepted because they could be createSignal() exports
      // e.g., signal(r, emailVerified) where emailVerified = createSignal(...)
      const source = `
        import { createProcess, signal, race, delay } from '@justscale/core/process'
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const r = race()
            const mySignal = { not: 'signal' }
            switch (true) {
              case signal(r, mySignal):
                return { status: 'signaled' }
              case delay.hours(r, 24):
                return { status: 'timeout' }
            }
          }
        })
      `;

      const result = compileProcessSource(source, 'test.ts', { verbose: false });
      const parsed = parseOutput(result.outputText);

      // Identifiers ARE extracted as signal names (for createSignal pattern support)
      // The type is tracked, so at runtime it would fail if not a real signal
      assert.ok(
        parsed.signalNames.includes('mySignal'),
        'Should extract identifier as signal name (createSignal pattern)'
      );

      // The type is captured for runtime validation
      assert.ok(
        result.outputText.includes('payloadType'),
        'Should capture payload type for validation'
      );
    });
  });
});
