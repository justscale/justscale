/**
 * Determinism guardrails (TSP1005 / NonDeterministicOperation).
 *
 * Process handlers are replayed on recovery, so every pure-JS operation
 * inside the handler body must be deterministic - the compiler rejects
 * `Date.now()`, `Math.random()`, `crypto.randomUUID()`,
 * `crypto.getRandomValues()`, and `new Date()` (no args). Anything the
 * runtime can't reproduce on replay gets an error.
 *
 * The existing compiler-errors.test.ts covers the canonical positive/
 * negative cases (Date.now in an if-branch rejected, new Date(timestamp)
 * accepted). This file covers *adjacent placements* that the recursive
 * walker must also catch, plus the one shape that MUST be allowed:
 * a non-deterministic call wrapped behind a service method (the BLOCK
 * captures the result in state, so replay uses the stored value).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { compileProcessSource, formatDiagnostics } from '../src/compiler/compile.js';
import { ProcessErrorCode, getProcessErrorCode } from '../src/compiler/errors.js';

function expectError(source: string, code: ProcessErrorCode, description: string) {
  const result = compileProcessSource(source, 'test.ts', { verbose: false });
  if (result.diagnostics.length === 0) {
    assert.fail(`Expected TSP${code} (${description}) but got no diagnostics.`);
  }
  const codes = result.diagnostics.map(d => getProcessErrorCode(d));
  assert.ok(
    codes.includes(code),
    `Expected TSP${code} (${description}) but got TSP${codes.join(', TSP')}.\n${formatDiagnostics(result.diagnostics)}`,
  );
}

function expectNoError(source: string, description: string) {
  const result = compileProcessSource(source, 'test.ts', { verbose: false });
  assert.strictEqual(
    result.diagnostics.length, 0,
    `Expected no errors (${description}), got:\n${formatDiagnostics(result.diagnostics)}`,
  );
}

describe('TSP1005 determinism guardrails: adjacent placements', () => {
  it('rejects Date.now() inside a race-branch body', () => {
    const source = `
      import { createProcess, signal, race } from '@justscale/core/process'
      const svc = { done: {} as any, tick: {} as any }
      export const test = createProcess({
        path: '/test/:id',
        inject: {},
        async handler({}, [id]) {
          while (true) {
            const r = race()
            switch (true) {
              case signal(r, svc.tick): {
                const now = Date.now()
                await signal(svc.done)
                return { now }
              }
            }
          }
        }
      })
    `;
    expectError(source, ProcessErrorCode.NonDeterministicOperation, 'Date.now() inside race branch');
  });

  it('rejects Math.random() inside an if-branch inside a race-branch body', () => {
    // The walker recurses into nested control-flow - a Math.random()
    // hidden two levels deep must still be flagged.
    const source = `
      import { createProcess, signal, race } from '@justscale/core/process'
      const svc = { tick: {} as any, done: {} as any }
      export const test = createProcess({
        path: '/test/:id',
        inject: {},
        async handler({}, [id]) {
          while (true) {
            const r = race()
            switch (true) {
              case signal(r, svc.tick): {
                if (r.needRoll) {
                  const roll = Math.random()
                  if (roll > 0.5) {
                    await signal(svc.done)
                    return { roll }
                  }
                }
                break
              }
            }
          }
        }
      })
    `;
    expectError(source, ProcessErrorCode.NonDeterministicOperation, 'Math.random() nested inside if-inside-race');
  });

  it('rejects `new Date()` (no args) inside a variable initializer', () => {
    const source = `
      import { createProcess, signal } from '@justscale/core/process'
      const svc = { done: {} as any }
      export const test = createProcess({
        path: '/test/:id',
        inject: {},
        async handler({}, [id]) {
          const stamp = new Date()
          await signal(svc.done)
          return { stamp }
        }
      })
    `;
    expectError(source, ProcessErrorCode.NonDeterministicOperation, 'new Date() in var init');
  });

  it('rejects crypto.getRandomValues() call', () => {
    // The other Crypto method in the banned list. Prevents someone from
    // reaching for it as a way around the randomUUID rejection.
    const source = `
      import { createProcess, signal } from '@justscale/core/process'
      const svc = { done: {} as any }
      export const test = createProcess({
        path: '/test/:id',
        inject: {},
        async handler({}, [id]) {
          const buf = new Uint8Array(16)
          crypto.getRandomValues(buf)
          await signal(svc.done)
          return { buf }
        }
      })
    `;
    expectError(source, ProcessErrorCode.NonDeterministicOperation, 'crypto.getRandomValues()');
  });

  it('rejects Date.now() inside a return expression', () => {
    const source = `
      import { createProcess, signal } from '@justscale/core/process'
      const svc = { done: {} as any }
      export const test = createProcess({
        path: '/test/:id',
        inject: {},
        async handler({}, [id]) {
          await signal(svc.done)
          return { stamp: Date.now() }
        }
      })
    `;
    expectError(source, ProcessErrorCode.NonDeterministicOperation, 'Date.now() in return expression');
  });

  it('allows a service that returns a timestamp - replay captures the BLOCK result', () => {
    // This is the mandated escape hatch: wrap the non-deterministic call
    // in a service method. The await-BLOCK captures the result into state,
    // so replay uses the stored value instead of re-running the clock.
    const source = `
      import { createProcess, signal } from '@justscale/core/process'
      const Clock = {} as any
      const svc = { done: {} as any }
      export const test = createProcess({
        path: '/test/:id',
        inject: { clock: Clock },
        async handler({ clock }, [id]) {
          using stamp = await clock.now()
          await signal(svc.done)
          return { stamp }
        }
      })
    `;
    expectNoError(source, 'service-wrapped timestamp via `using`');
  });

  it('allows `new Date(specificTimestamp)` - deterministic when the timestamp comes from state', () => {
    const source = `
      import { createProcess, signal } from '@justscale/core/process'
      const svc = { done: {} as any }
      export const test = createProcess({
        path: '/test/:id',
        inject: {},
        async handler({}, [id]) {
          const d = new Date('2025-01-01T00:00:00Z')
          await signal(svc.done)
          return { d }
        }
      })
    `;
    expectNoError(source, 'new Date(literal)');
  });

  it('rejects Date.now() inside a plain while(true) loop body (non-race placement)', () => {
    // Adjacent placement: outside any race, just inside a loop. The
    // walker must still catch it - the handler is still replayable.
    const source = `
      import { createProcess, signal } from '@justscale/core/process'
      const svc = { done: {} as any }
      export const test = createProcess({
        path: '/test/:id',
        inject: {},
        async handler({}, [id]) {
          while (true) {
            const t = Date.now()
            await signal(svc.done)
            return { t }
          }
        }
      })
    `;
    expectError(source, ProcessErrorCode.NonDeterministicOperation, 'Date.now() inside while(true)');
  });
});
