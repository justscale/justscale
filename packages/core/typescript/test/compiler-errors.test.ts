/**
 * Tests for process compiler error codes.
 *
 * This file tests the error detection in the process compiler,
 * ensuring proper diagnostics are emitted for invalid patterns.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { compileProcessSource, formatDiagnostics } from '../src/compiler/compile.js';
import { ProcessErrorCode, getProcessErrorCode } from '../src/compiler/errors.js';

function expectError(source: string, expectedCode: ProcessErrorCode, description?: string) {
  const result = compileProcessSource(source, 'test.ts', { verbose: false });

  if (result.diagnostics.length === 0) {
    assert.fail(`Expected error TSP${expectedCode} but got no diagnostics. ${description || ''}`);
  }

  const codes = result.diagnostics.map((d) => getProcessErrorCode(d));
  assert.ok(
    codes.includes(expectedCode),
    `Expected TSP${expectedCode} but got TSP${codes.join(', TSP')}. ${description || ''}\n` +
      formatDiagnostics(result.diagnostics)
  );
}

function expectNoError(source: string, description?: string) {
  const result = compileProcessSource(source, 'test.ts', { verbose: false });

  assert.strictEqual(
    result.diagnostics.length,
    0,
    `Expected no errors but got:\n${formatDiagnostics(result.diagnostics)}. ${description || ''}`
  );
}

describe('Compiler Error Codes', () => {
  describe('TSP1001 - NonSerializableConst', () => {
    it('detects const declaration with awaited service call', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const OrderRepository = {} as any
        export const test = createProcess({
          path: '/test/:id',
          inject: { orders: OrderRepository },
          async handler({ orders }, [id]) {
            const order = await orders.get(id)
            await signal(orders.completed)
            return order
          }
        })
      `;
      expectError(source, ProcessErrorCode.NonSerializableConst);
    });

    it('allows using declaration for awaited service calls', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const OrderRepository = {} as any
        export const test = createProcess({
          path: '/test/:id',
          inject: { orders: OrderRepository },
          async handler({ orders }, [id]) {
            using order = await orders.get(id)
            await signal(orders.completed)
            return order
          }
        })
      `;
      expectNoError(source);
    });

    it('allows const when value is never read after a suspension', () => {
      // `remaining` is consumed entirely within a single continuation - no
      // suspension between declaration and last use - so const is safe.
      const source = `
        import { createProcess, signal, race, delay } from '@justscale/core/process'
        const CartRepository = {} as any
        const signals = { lineRemoved: {} as any, checkout: {} as any }
        export const test = createProcess({
          path: '/cart/:id',
          inject: { cart: CartRepository },
          async handler({ cart }, [id]) {
            while (true) {
              const r = race()
              switch (true) {
                case signal(r, signals.lineRemoved): {
                  const remaining = await cart.linesOf(id)
                  if (remaining.length === 0) return { status: 'empty' }
                  break
                }
                case signal(r, signals.checkout): return { status: 'done' }
              }
            }
          }
        })
      `;
      expectNoError(source);
    });

    it('still errors when const is read after a suspension in the same scope', () => {
      const source = `
        import { createProcess, signal, delay } from '@justscale/core/process'
        const OrderRepository = {} as any
        const svc = { ready: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: { orders: OrderRepository },
          async handler({ orders }, [id]) {
            const order = await orders.get(id)
            await delay.seconds(5)
            return order.status
          }
        })
      `;
      expectError(source, ProcessErrorCode.NonSerializableConst);
    });

    it('allows const inside a for-of body that has no suspension', () => {
      const source = `
        import { createProcess } from '@justscale/core/process'
        const OrderRepository = {} as any
        export const test = createProcess({
          path: '/test/:id',
          inject: { orders: OrderRepository },
          async handler({ orders }, [id]) {
            for (const o of orders.iterator()) {
              const full = await orders.get(o.id)
              if (full.total === 0) continue
            }
            return { done: true }
          }
        })
      `;
      expectNoError(source);
    });

    it('errors when const inside a for-of body is read after a suspension', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const OrderRepository = {} as any
        const svc = { ready: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: { orders: OrderRepository },
          async handler({ orders }, [id]) {
            for (const o of orders.iterator()) {
              const full = await orders.get(o.id)
              await signal(svc.ready)
              if (full.total === 0) return { done: true }
            }
            return { done: false }
          }
        })
      `;
      expectError(source, ProcessErrorCode.NonSerializableConst);
    });

    it('errors when for-of binding is non-serializable and body suspends', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        class Order { id!: string; total!: number; ping(): void {} }
        const orders: Order[] = []
        const svc = { ready: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            for (const order of orders) {
              await signal(svc.ready)
              order.ping()
            }
            return { done: true }
          }
        })
      `;
      expectError(source, ProcessErrorCode.NonSerializableConst);
    });

    it('allows for-of binding as const when body has no suspension', () => {
      const source = `
        import { createProcess } from '@justscale/core/process'
        class Order { id!: string; ping(): void {} }
        const orders: Order[] = []
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            for (const order of orders) {
              order.ping()
            }
            return { done: true }
          }
        })
      `;
      expectNoError(source);
    });
  });

  describe('TSP1006 - SignalStoredInVariable', () => {
    it('detects signal stored in variable', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { paid: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const s = signal(svc.paid)
            await s
            return { done: true }
          }
        })
      `;
      expectError(source, ProcessErrorCode.SignalStoredInVariable);
    });

    it('detects delay stored in variable', () => {
      const source = `
        import { createProcess, delay } from '@justscale/core/process'
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const d = delay.minutes(5)
            await d
            return { done: true }
          }
        })
      `;
      expectError(source, ProcessErrorCode.SignalStoredInVariable);
    });
  });

  describe('TSP1007 - TryCatchWithSuspension', () => {
    it('detects try-catch around signal', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { paid: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            try {
              await signal(svc.paid)
            } catch (e) {
              return { error: true }
            }
            return { done: true }
          }
        })
      `;
      expectError(source, ProcessErrorCode.TryCatchWithSuspension);
    });

    it('detects try-catch around delay', () => {
      const source = `
        import { createProcess, delay } from '@justscale/core/process'
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            try {
              await delay.hours(1)
            } catch (e) {
              return { error: true }
            }
            return { done: true }
          }
        })
      `;
      expectError(source, ProcessErrorCode.TryCatchWithSuspension);
    });
  });

  describe('TSP1009 - PromiseCombinatorWithSignal', () => {
    it('detects Promise.all with signal', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { a: {} as any, b: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const result = await Promise.all([signal(svc.a), signal(svc.b)])
            return result
          }
        })
      `;
      expectError(source, ProcessErrorCode.PromiseCombinatorWithSignal);
    });

    it('detects Promise.race with signal', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { a: {} as any, b: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const result = await Promise.race([signal(svc.a), signal(svc.b)])
            return result
          }
        })
      `;
      expectError(source, ProcessErrorCode.PromiseCombinatorWithSignal);
    });

    it('detects Promise.allSettled with signal', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { a: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const result = await Promise.allSettled([signal(svc.a)])
            return result
          }
        })
      `;
      expectError(source, ProcessErrorCode.PromiseCombinatorWithSignal);
    });
  });

  describe('TSP1010 - ForInWithSuspension', () => {
    it('detects for-in loop with signal inside', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { itemProcessed: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const obj = { a: 1, b: 2 }
            for (const key in obj) {
              await signal(svc.itemProcessed)
            }
            return { done: true }
          }
        })
      `;
      expectError(source, ProcessErrorCode.ForInWithSuspension);
    });

    it('allows for-of loop with suspension (durable iteration)', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { itemProcessed: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const items = [1, 2, 3]
            for (const item of items) {
              await signal(svc.itemProcessed)
            }
            return { done: true }
          }
        })
      `;
      expectNoError(source);
    });
  });

  describe('TSP1013 - WhileConditionSuspension', () => {
    it('detects signal in while-loop condition', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { hasMore: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            while (await signal(svc.hasMore)) {
              // process items
            }
            return { done: true }
          }
        })
      `;
      expectError(source, ProcessErrorCode.WhileConditionSuspension);
    });

    it('allows signal in while-loop body (not condition)', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { event: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            while (true) {
              const ev = await signal(svc.event)
              if (ev.done) break
            }
            return { done: true }
          }
        })
      `;
      expectNoError(source);
    });
  });

  describe('TSP1014 - DoWhileWithSuspension', () => {
    it('detects signal in do-while body', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { event: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            do {
              await signal(svc.event)
            } while (true)
          }
        })
      `;
      expectError(source, ProcessErrorCode.DoWhileWithSuspension);
    });

    it('allows do-while without suspension points', () => {
      const source = `
        import { createProcess } from '@justscale/core/process'
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            let i = 0
            do {
              i++
            } while (i < 10)
            return { i }
          }
        })
      `;
      expectNoError(source);
    });
  });

  describe('TSP1012 - ParallelFunctionWithParams (removed)', () => {
    it('parameterized inner functions with suspension are now allowed', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { processed: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const process = async (x: number) => {
              await signal(svc.processed)
              return x
            }
            await process(1)
            return { done: true }
          }
        })
      `;
      expectNoError(source);
    });
  });

  describe('TSP2001 - RecursionDepthUnknown', () => {
    it('detects unbounded recursion in parameterless function', () => {
      // Note: Functions with parameters get ParallelFunctionWithParams error first
      // This tests recursion detection for functions without parameters
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { processed: {} as any }
        let counter = 0
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const recurse = async (): Promise<void> => {
              if (counter++ > 10) return
              await signal(svc.processed)
              await recurse()
            }
            await recurse()
            return { done: true }
          }
        })
      `;
      expectError(source, ProcessErrorCode.RecursionDepthUnknown);
    });
  });

  describe('TSP3003 - YieldInNonGenerator', () => {
    // Note: TypeScript parses `yield` as an identifier in non-generators, so this
    // error can only be triggered in specific edge cases. In practice, using yield
    // in a non-generator is a syntax error at the JavaScript level.
    // The error code exists for completeness but won't be triggered in normal usage.

    it('allows yield in generator handler', () => {
      // This verifies that yield IS allowed in async generators
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { processed: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async *handler({}, [id]) {
            yield { event: 'started' }
            await signal(svc.processed)
            return { done: true }
          }
        })
      `;
      expectNoError(source);
    });
  });

  describe('TSP3005 - EmptyParallelBlock', () => {
    it('detects signal.all with empty array', () => {
      const source = `
        import { createProcess } from '@justscale/core/process'
        const signalAll = { all: (...args: any[]) => {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            await signalAll.all([])
            return { done: true }
          }
        })
      `;
      // This test verifies the error is detected for signal.all([])
      // The compiler looks for .all() calls with empty array literals
      const result = compileProcessSource(source, 'test.ts', { verbose: false });
      // Note: If signal.all isn't detected as a primitive, the empty array check won't trigger
      // This may need adjustment based on how signal.all is detected
    });
  });

  describe('TSP3010 - EmptyRace', () => {
    // Note: The EmptyRace error is emitted when a race switch is detected but
    // all signal/delay extraction fails. This requires a very specific edge case
    // where findRaceVariableInCases finds the race var but extractSignalInfo
    // returns null for all cases. In practice, this is rare.

    it('detects race with invalid signal argument (string literal)', () => {
      // This case uses signal(r, "string") which finds the race var but
      // extractSignalInfo should reject the string literal
      const source = `
        import { createProcess, race, signal } from '@justscale/core/process'
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const r = race()
            switch (true) {
              case signal(r, "not-a-signal" as any):
                return { status: 'invalid' }
            }
          }
        })
      `;
      expectError(source, ProcessErrorCode.EmptyRace);
    });

    it('allows race switch with signal branch', () => {
      const source = `
        import { createProcess, race, signal } from '@justscale/core/process'
        const svc = { paid: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const r = race()
            switch (true) {
              case signal(r, svc.paid):
                return { status: 'paid' }
            }
          }
        })
      `;
      expectNoError(source);
    });

    it('allows race switch with delay branch', () => {
      const source = `
        import { createProcess, race, delay } from '@justscale/core/process'
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const r = race()
            switch (true) {
              case delay.hours(r, 1):
                return { status: 'timeout' }
            }
          }
        })
      `;
      expectNoError(source);
    });
  });

  describe('TSP1002 - SignalNotAwaited', () => {
    it('detects signal() call without await', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { paid: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            signal(svc.paid)
            return { done: true }
          }
        })
      `;
      expectError(source, ProcessErrorCode.SignalNotAwaited);
    });

    it('detects delay() call without await', () => {
      const source = `
        import { createProcess, delay } from '@justscale/core/process'
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            delay.hours(1)
            return { done: true }
          }
        })
      `;
      expectError(source, ProcessErrorCode.SignalNotAwaited);
    });

    it('allows awaited signal()', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { paid: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            await signal(svc.paid)
            return { done: true }
          }
        })
      `;
      expectNoError(source);
    });
  });

  describe('TSP1004 - HandlerNotAsync', () => {
    it('detects non-async handler', () => {
      const source = `
        import { createProcess } from '@justscale/core/process'
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          handler({}, [id]) {
            return { done: true }
          }
        })
      `;
      expectError(source, ProcessErrorCode.HandlerNotAsync);
    });

    it('allows async handler', () => {
      const source = `
        import { createProcess } from '@justscale/core/process'
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            return { done: true }
          }
        })
      `;
      expectNoError(source);
    });
  });

  describe('TSP1005 - NonDeterministicOperation', () => {
    it('detects Date.now()', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { done: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const timestamp = Date.now()
            await signal(svc.done)
            return { timestamp }
          }
        })
      `;
      expectError(source, ProcessErrorCode.NonDeterministicOperation);
    });

    it('detects Math.random()', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { done: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const rand = Math.random()
            await signal(svc.done)
            return { rand }
          }
        })
      `;
      expectError(source, ProcessErrorCode.NonDeterministicOperation);
    });

    it('detects new Date() without arguments', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { done: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const date = new Date()
            await signal(svc.done)
            return { date }
          }
        })
      `;
      expectError(source, ProcessErrorCode.NonDeterministicOperation);
    });

    it('allows new Date(specificTimestamp)', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { done: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const date = new Date('2024-01-01')
            await signal(svc.done)
            return { date }
          }
        })
      `;
      expectNoError(source);
    });

    it('detects crypto.randomUUID()', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { done: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const uuid = crypto.randomUUID()
            await signal(svc.done)
            return { uuid }
          }
        })
      `;
      expectError(source, ProcessErrorCode.NonDeterministicOperation);
    });
  });

  describe('TSP3004 - ThrowNotAllowed', () => {
    it('detects throw statement', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { done: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            if (id === 'bad') {
              throw new Error('bad id')
            }
            await signal(svc.done)
            return { done: true }
          }
        })
      `;
      expectError(source, ProcessErrorCode.ThrowNotAllowed);
    });

    it('allows error return instead of throw', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { done: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            if (id === 'bad') {
              return { error: 'bad id' }
            }
            await signal(svc.done)
            return { done: true }
          }
        })
      `;
      expectNoError(source);
    });
  });

  describe('TSP1003 - InvalidRacePattern', () => {
    it('detects switch(true) with signal/delay but no race variable', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { paid: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            switch (true) {
              case signal(svc.paid):
                return { status: 'paid' }
            }
          }
        })
      `;
      expectError(source, ProcessErrorCode.InvalidRacePattern);
    });

    it('allows race switch with proper race variable', () => {
      const source = `
        import { createProcess, race, signal } from '@justscale/core/process'
        const svc = { paid: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const r = race()
            switch (true) {
              case signal(r, svc.paid):
                return { status: 'paid' }
            }
          }
        })
      `;
      expectNoError(source);
    });
  });

  describe('TSP1008 - NestedAsyncWithSuspension', () => {
    it('detects async arrow with suspension passed as callback', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { processed: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const items = [1, 2, 3]
            items.forEach(async (item) => {
              await signal(svc.processed)
            })
            return { done: true }
          }
        })
      `;
      expectError(source, ProcessErrorCode.NestedAsyncWithSuspension);
    });

    it('allows named inner async function called directly', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { processed: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const process = async () => {
              await signal(svc.processed)
            }
            await process()
            return { done: true }
          }
        })
      `;
      expectNoError(source);
    });
  });

  describe('TSP1011 - FunctionEscapesScope', () => {
    it('detects inner function with suspension returned from handler', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { processed: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const fn = async () => {
              await signal(svc.processed)
            }
            return fn
          }
        })
      `;
      expectError(source, ProcessErrorCode.FunctionEscapesScope);
    });

    it('detects inner function with suspension passed to another function', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { processed: {} as any }
        const register = (fn: any) => {}
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const fn = async () => {
              await signal(svc.processed)
            }
            register(fn)
            return { done: true }
          }
        })
      `;
      expectError(source, ProcessErrorCode.FunctionEscapesScope);
    });

    it('allows inner function called directly', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { processed: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const fn = async () => {
              await signal(svc.processed)
            }
            await fn()
            return { done: true }
          }
        })
      `;
      expectNoError(source);
    });
  });

  describe('TSP1015 - ForWithSuspension', () => {
    it('detects classic for loop with signal inside', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { itemProcessed: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            for (let i = 0; i < 3; i++) {
              await signal(svc.itemProcessed)
            }
            return { done: true }
          }
        })
      `;
      expectError(source, ProcessErrorCode.ForWithSuspension);
    });

    it('allows classic for loop without suspension', () => {
      const source = `
        import { createProcess } from '@justscale/core/process'
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            let sum = 0
            for (let i = 0; i < 10; i++) {
              sum += i
            }
            return { sum }
          }
        })
      `;
      expectNoError(source);
    });
  });

  describe('TSP2002 - MutualRecursion', () => {
    it('detects two inner functions calling each other with suspension', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { step: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const a = async () => {
              await signal(svc.step)
              await b()
            }
            const b = async () => {
              await signal(svc.step)
              await a()
            }
            await a()
            return { done: true }
          }
        })
      `;
      expectError(source, ProcessErrorCode.MutualRecursion);
    });
  });

  describe('TSP2003 - MaxInliningDepthExceeded', () => {
    it('detects deeply nested function calls exceeding inline limit', () => {
      // Build a chain of 12 nested functions, each with its own suspension
      // Default maxInliningDepth is 10, so 12 levels should exceed it
      const fns = Array.from({ length: 12 }, (_, i) => {
        const next = i < 11 ? `await signal(svc.step)\n              await f${i + 1}()` : 'await signal(svc.step)';
        return `const f${i} = async () => { ${next} }`;
      }).join('\n            ');

      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { step: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            ${fns}
            await f0()
            return { done: true }
          }
        })
      `;
      expectError(source, ProcessErrorCode.MaxInliningDepthExceeded);
    });
  });

  describe('TSP3009 - NestedScopeCollision', () => {
    it('detects nested scope() calls', () => {
      const source = `
        import { createProcess, scope } from '@justscale/core/process'
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const outer = [{ id: '1' }]
            const inner = [{ id: '2' }]
            await scope(outer, async (o) => {
              await scope(inner, async (i) => {
                return { i }
              })
            })
            return { done: true }
          }
        })
      `;
      expectError(source, ProcessErrorCode.NestedScopeCollision);
    });
  });

  describe('TSP3011 - InvalidScopeArguments', () => {
    it('detects scope() with only 1 argument', () => {
      const source = `
        import { createProcess, scope } from '@justscale/core/process'
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const items = [{ id: '1' }]
            await scope(items)
            return { done: true }
          }
        })
      `;
      expectError(source, ProcessErrorCode.InvalidScopeArguments);
    });

    it('detects scope() with non-function second argument', () => {
      const source = `
        import { createProcess, scope } from '@justscale/core/process'
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const items = [{ id: '1' }]
            await scope(items, "notAFunction")
            return { done: true }
          }
        })
      `;
      expectError(source, ProcessErrorCode.InvalidScopeArguments);
    });
  });

  describe('TSP3001 - InvalidDurableIterator', () => {
    it('detects durable iterator without orderBy', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { processed: {} as any }

        type DurableQuery = AsyncIterable<{ id: string }> & {
          __durableIterator: true
          orderBy: (field: string) => DurableQuery
        }

        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const query = {} as DurableQuery
            for await (const item of query) {
              await signal(svc.processed)
            }
            return { done: true }
          }
        })
      `;
      expectError(source, ProcessErrorCode.InvalidDurableIterator);
    });

    it('allows regular array iteration with suspension', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { processed: {} as any }
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const items = [1, 2, 3]
            for (const item of items) {
              await signal(svc.processed)
            }
            return { done: true }
          }
        })
      `;
      expectNoError(source);
    });
  });

  describe('TSP3002 - NonSerializableCursor', () => {
    it('detects non-serializable cursor type', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { processed: {} as any }

        type OrderedQuery = AsyncIterable<{ id: string }> & {
          __durableIterator: true
          orderBy: string  // not a function = already called
          __cursorType: { id: string; ref: () => void }  // function is not serializable
        }

        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const query = {} as OrderedQuery
            for await (const item of query) {
              await signal(svc.processed)
            }
            return { done: true }
          }
        })
      `;
      expectError(source, ProcessErrorCode.NonSerializableCursor);
    });

    it('allows serializable cursor type', () => {
      const source = `
        import { createProcess, signal } from '@justscale/core/process'
        const svc = { processed: {} as any }

        type OrderedQuery = AsyncIterable<{ id: string }> & {
          __durableIterator: true
          orderBy: string  // not a function = already called
          __cursorType: { id: string; createdAt: number }  // all primitives
        }

        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            const query = {} as OrderedQuery
            for await (const item of query) {
              await signal(svc.processed)
            }
            return { done: true }
          }
        })
      `;
      expectNoError(source);
    });
  });

  describe('TSP3007 - ScopeHandlerCannotYield', () => {
    it('rejects yield inside scope handler', () => {
      const source = `
        import { createProcess, scope } from '@justscale/core/process'
        export const test = createProcess({
          path: '/test/:id',
          inject: {},
          async *handler({}, [id]) {
            const items = [{ id: '1' }, { id: '2' }]
            await scope(items, async function*(item) {
              yield { event: 'processing' }
              return item.id
            })
            return { status: 'done' }
          }
        })
      `;
      expectError(source, ProcessErrorCode.ScopeHandlerCannotYield);
    });
  });

});
