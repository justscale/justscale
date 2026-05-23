/**
 * Type-level tests for sub-app composition.
 *
 * Validates compile-time semantics of `.requires()`, `.add(subApp)`,
 * and `.compile()` with non-empty TRequires. These are assertions about
 * the *type* the compiler produces — the `describe`/`it` wrapper only
 * exists so the file runs under `node:test` and is picked up by the
 * test harness. The runtime assertions are thin smoke checks; the real
 * test is that this file typechecks (or doesn't, at the marked spots).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import JustScale, { type BuiltApp } from '../../src/justscale.js';
import { defineService } from '../../src/core/service.js';
import type { AnyToken } from '../../src/builder/types.js';

// ----------------------------------------------------------------------------
// Services used across the type tests
// ----------------------------------------------------------------------------

const Alpha = defineService({ inject: {}, factory: () => ({ a: () => 'a' }) });
const Beta = defineService({ inject: {}, factory: () => ({ b: () => 'b' }) });
const Gamma = defineService({ inject: {}, factory: () => ({ g: () => 'g' }) });

// ----------------------------------------------------------------------------
// Assertion helper: make TS-level assertions explicit.
// ----------------------------------------------------------------------------

type Expect<T extends true> = T;
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends
  (<T>() => T extends Y ? 1 : 2) ? true : false;

// A token appears in a tuple (used when tuple element order is not locked down).
type Includes<T extends readonly AnyToken[], U> =
  T extends readonly [infer H, ...infer R extends readonly AnyToken[]]
    ? Equal<H, U> extends true ? true : Includes<R, U>
    : false;

describe('Sub-app types: .requires() threads TRequires', () => {
  it('builder without .requires() has empty TRequires', () => {
    const built = JustScale().add(Alpha).build();
    type T = typeof built extends BuiltApp<any, infer R> ? R : never;
    type _ = Expect<Equal<T, []>>;
    assert.ok(built);
  });

  it('.requires(T) pushes into TRequires and TProvided', () => {
    const sub = JustScale().requires(Alpha).build();
    type TRequires = typeof sub extends BuiltApp<any, infer R> ? R : never;
    type _ = Expect<Includes<TRequires, typeof Alpha>>;
    assert.deepStrictEqual([...sub.__requires], [Alpha]);
  });

  it('multiple .requires() accumulates in order', () => {
    const sub = JustScale().requires(Alpha).requires(Beta).build();
    type TRequires = typeof sub extends BuiltApp<any, infer R> ? R : never;
    type _alpha = Expect<Includes<TRequires, typeof Alpha>>;
    type _beta = Expect<Includes<TRequires, typeof Beta>>;
    assert.strictEqual(sub.__requires.length, 2);
  });
});

describe('Sub-app types: parent .add(subApp) checks TRequires ⊆ TProvided', () => {
  it('parent that provides the requires accepts the sub-app', () => {
    const Sub = JustScale().requires(Alpha).add(Beta).build();

    // Parent provides Alpha — .add(Sub) must typecheck.
    const parent = JustScale().add(Alpha).add(Sub);
    assert.ok(parent);
  });

  it('parent missing the requires rejects at the .add() call site', () => {
    const Sub = JustScale().requires(Alpha).build();

    // @ts-expect-error — parent does not provide Alpha; AddCheck returns MissingSubAppRequiresError
    JustScale().add(Sub);

    // Confirm runtime tokens still look right so we're testing the
    // right thing (not masking a bug elsewhere).
    assert.deepStrictEqual([...Sub.__requires], [Alpha]);
  });

  it('multi-require sub-app: parent must cover every token', () => {
    const Sub = JustScale().requires(Alpha).requires(Beta).build();

    // Parent provides only Alpha → should be a type error.
    // @ts-expect-error — Beta is missing
    JustScale().add(Alpha).add(Sub);

    // Parent provides both → typechecks fine.
    const ok = JustScale().add(Alpha).add(Beta).add(Sub);
    assert.ok(ok);
  });

  it('requires carry through nested sub-apps (multi-level)', () => {
    // Inner sub-app requires Alpha.
    const Inner = JustScale().requires(Alpha).add(Beta).build();

    // Middle sub-app embeds Inner. Middle must provide Alpha itself —
    // its `.add(Inner)` only typechecks when Alpha is in its TProvided,
    // which it gets via its own .requires(Alpha). Middle's TRequires
    // therefore surfaces Alpha to whatever composes Middle.
    const Middle = JustScale().requires(Alpha).add(Inner).build();
    type MiddleRequires = typeof Middle extends BuiltApp<any, infer R> ? R : never;
    type _alpha = Expect<Includes<MiddleRequires, typeof Alpha>>;

    // Outer must cover Middle's requires.
    const outer = JustScale().add(Alpha).add(Middle);
    assert.ok(outer);

    // Outer missing Alpha → type error at the Middle add site.
    // @ts-expect-error — Alpha not in parent's TProvided, surfaced from Middle
    JustScale().add(Middle);
  });
});

describe('Sub-app types: .compile() is strict when TRequires is non-empty', () => {
  it('compile() on a builder with empty TRequires returns the real App', () => {
    const built = JustScale().add(Alpha).build();
    const app = built.compile();
    // app should be the real App — accessing .container (real App property)
    // must typecheck. If TRequires were non-empty, compile()'s return would
    // be a CannotCompileSubAppError branded object and .container access
    // would fail at this line.
    const _c = app.container;
    assert.ok(_c);
  });

  it('compile() on a builder with non-empty TRequires is unusable as App', () => {
    const sub = JustScale().requires(Alpha).build();
    const result = sub.compile();

    // Runtime still returns the compiled App — the gate is type-level only.
    // But at the type level, `result` is branded as CannotCompileSubAppError,
    // so accessing App-specific fields must be a type error.
    // @ts-expect-error — CannotCompileSubAppError has no `container` field
    void result.container;

    // The brand field is visible on the type (and may even be undefined
    // at runtime, since the runtime returns the real App). This is the
    // shape we're documenting, not a runtime contract.
    assert.ok(result);
  });
});

describe('Sub-app types: orthogonal features still work', () => {
  it('unrelated components still get regular RequiresSatisfied check', () => {
    // A service that requires Gamma via inject — if Gamma is not in
    // TProvided, this is a regular dep error (MissingDepsError, not
    // MissingSubAppRequiresError). Covered by existing tests; this
    // just asserts the branching in AddCheck didn't break non-sub-app
    // components.
    const NeedsGamma = defineService({
      inject: { g: Gamma },
      factory: ({ g }) => ({ ping: () => g.g() }),
    });

    const ok = JustScale().add(Gamma).add(NeedsGamma);
    assert.ok(ok);

    // @ts-expect-error — Gamma missing
    JustScale().add(NeedsGamma);
  });
});
