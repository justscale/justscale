/**
 * Tests for signal combinator validation and determinism guard uniformity.
 *
 * signal.all / signal.settled inside switch(true) with a race var must emit a
 * clear compiler error (TSP3012) rather than silently compiling to broken code
 * (no __raceBranches descriptor, no signals registered).
 *
 * `return { x: Date.now() }` both at the top level of a race branch body AND
 * nested inside an `if` block inside a race branch must be caught by the
 * determinism guard (TSP1005). Both placements use the same ReturnStatement handler.
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

describe('signal.all / signal.settled inside race switch', () => {
  it('rejects signal.all(r, [...]) as a case expression - TSP3012', () => {
    // Previously compiled clean but emitted no __raceBranches descriptor,
    // crashing at runtime. Now emits TSP3012.
    const source = `
      import { createProcess, signal, race } from '@justscale/core/process'
      const svc = { paid: {} as any, verified: {} as any }
      export const test = createProcess({
        path: '/test/:id',
        inject: {},
        async handler({}, [id]) {
          const r = race()
          switch (true) {
            case signal.all(r, [svc.paid, svc.verified]):
              return { status: 'all-confirmed' }
          }
        }
      })
    `;
    expectError(source, ProcessErrorCode.RaceCombinatorNotSupported, 'signal.all(r, [...]) in race switch');
  });

  it('rejects signal.settled(r, [...]) as a case expression - TSP3012', () => {
    const source = `
      import { createProcess, signal, race } from '@justscale/core/process'
      const svc = { a: {} as any, b: {} as any }
      export const test = createProcess({
        path: '/test/:id',
        inject: {},
        async handler({}, [id]) {
          const r = race()
          switch (true) {
            case signal.settled(r, [svc.a, svc.b]):
              return { status: 'settled' }
          }
        }
      })
    `;
    expectError(source, ProcessErrorCode.RaceCombinatorNotSupported, 'signal.settled(r, [...]) in race switch');
  });

  it('still accepts plain signal(r, ...) in the same switch - valid race branch', () => {
    const source = `
      import { createProcess, signal, race } from '@justscale/core/process'
      const svc = { done: {} as any }
      export const test = createProcess({
        path: '/test/:id',
        inject: {},
        async handler({}, [id]) {
          const r = race()
          switch (true) {
            case signal(r, svc.done):
              return { status: 'done' }
          }
        }
      })
    `;
    expectNoError(source, 'plain signal(r, ...) remains valid');
  });

  it('standalone await signal.all([...]) outside a race switch compiles clean', () => {
    // Only the race-switch form is broken. The await form is fine.
    const source = `
      import { createProcess, signal } from '@justscale/core/process'
      const svc = { a: {} as any, b: {} as any }
      export const test = createProcess({
        path: '/test/:id',
        inject: {},
        async handler({}, [id]) {
          const [a, b] = await signal.all([svc.a, svc.b])
          return { a, b }
        }
      })
    `;
    expectNoError(source, 'await signal.all([...]) outside race is fine');
  });
});

describe('return determinism guard - top-level vs. nested in if', () => {
  it('rejects Date.now() in top-level return inside race branch - TSP1005', () => {
    // Top-level return directly in race branch body.
    const source = `
      import { createProcess, signal, race } from '@justscale/core/process'
      const svc = { done: {} as any }
      export const test = createProcess({
        path: '/test/:id',
        inject: {},
        async handler({}, [id]) {
          const r = race()
          switch (true) {
            case signal(r, svc.done):
              return { stamp: Date.now() }
          }
        }
      })
    `;
    expectError(source, ProcessErrorCode.NonDeterministicOperation, 'Date.now() in top-level return inside race branch');
  });

  it('rejects Date.now() in return nested inside if inside race branch - TSP1005', () => {
    // Return nested inside an if-body inside a race branch body.
    const source = `
      import { createProcess, signal, race } from '@justscale/core/process'
      const svc = { done: {} as any }
      export const test = createProcess({
        path: '/test/:id',
        inject: {},
        async handler({}, [id]) {
          const r = race()
          switch (true) {
            case signal(r, svc.done): {
              if (r.failed) {
                return { stamp: Date.now() }
              }
              return { ok: true }
            }
          }
        }
      })
    `;
    expectError(source, ProcessErrorCode.NonDeterministicOperation, 'Date.now() in return nested in if inside race branch');
  });

  it('rejects Date.now() in return outside any race - TSP1005', () => {
    // Plain top-level return (no race) - same guard must fire.
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
    expectError(source, ProcessErrorCode.NonDeterministicOperation, 'Date.now() in top-level return outside race');
  });
});
