/**
 * Race Narrowing Prototype
 *
 * Exploring TypeScript type narrowing for a race/switch DSL.
 * The key insight: runtime behavior doesn't matter (compiler transforms to opcodes).
 * We only need TypeScript to narrow types correctly in each case branch.
 *
 * CONSTRAINT: TypeScript's switch narrowing works on discriminant properties,
 * not arbitrary case expressions. We need creative workarounds.
 */

// ============================================================================
// Test Signals (mock definitions)
// ============================================================================

interface Signal<TPayload = void> {
  readonly __payload: TPayload
  readonly signalName: string
}

const twofa = {
  codeSubmitted: {
    signalName: 'twofa.code_submitted',
    __payload: undefined as unknown as { code: string; attempt: number },
  } as Signal<{ code: string; attempt: number }>,

  cancelled: {
    signalName: 'twofa.cancelled',
    __payload: undefined as unknown as void,
  } as Signal<void>,

  resendRequested: {
    signalName: 'twofa.resend_requested',
    __payload: undefined as unknown as { reason: string },
  } as Signal<{ reason: string }>,
};

function minutes(n: number) {
  return { ms: n * 60 * 1000 };
}

// ============================================================================
// APPROACH 1: Discriminated Union with Magic Types
// ============================================================================
// Idea: race() returns a discriminated union, signal() returns a type that
// matches one variant. TypeScript narrows on === comparison in switch.

namespace Approach1 {
  // Each race outcome is a discriminated union member
  type RaceOutcome<TSignals extends Record<string, unknown>> = {
    [K in keyof TSignals]: { type: K; payload: TSignals[K] }
  }[keyof TSignals];

  // This is what race() would return (union of all possible outcomes)
  type RaceResult =
    | { type: 'codeSubmitted'; payload: { code: string; attempt: number } }
    | { type: 'cancelled'; payload: void }
    | { type: 'timeout'; payload: void };

  // signal() returns a type guard that matches one variant
  // The trick: return value type matches the discriminant
  function race(): RaceResult {
    return { type: 'codeSubmitted', payload: { code: '', attempt: 0 } };
  }

  // Hmm, this doesn't work because case expressions need to be comparable
  // to the switch expression. We can't use signal() as a case expression
  // that narrows based on type.

  function test1() {
    const result = race();
    switch (result.type) {
      case 'codeSubmitted':
        // WORKS: result.payload is narrowed to { code: string; attempt: number }
        console.log(result.payload.code);
        break;
      case 'cancelled':
        // WORKS: result.payload is void
        break;
      case 'timeout':
        break;
    }
  }

  // Problem: We want `signal(twofa.codeSubmitted)` as the case, not a string literal
}

// ============================================================================
// APPROACH 2: Tagged Signal Matchers
// ============================================================================
// Idea: signal() returns a unique symbol/string that TypeScript tracks.
// The race result's type property is the same type.

namespace Approach2 {
  // Each signal has a unique literal type as its "tag"
  interface TaggedSignal<Tag extends string, TPayload> {
    readonly tag: Tag
    readonly __payload: TPayload
  }

  // Create tagged versions
  const codeSubmitted: TaggedSignal<'code', { code: string; attempt: number }> = {
    tag: 'code',
    __payload: { code: '', attempt: 0 },
  };
  const cancelled: TaggedSignal<'cancelled', void> = {
    tag: 'cancelled',
    __payload: undefined,
  };
  const timeout: TaggedSignal<'timeout', void> = {
    tag: 'timeout',
    __payload: undefined,
  };

  // Race result uses the same tags
  type RaceResult<T extends TaggedSignal<string, unknown>[]> = {
    [K in keyof T]: T[K] extends TaggedSignal<infer Tag, infer P>
      ? { tag: Tag; payload: P }
      : never
  }[number];

  function race<T extends TaggedSignal<string, unknown>[]>(
    ...signals: T
  ): RaceResult<T> {
    return { tag: signals[0].tag, payload: signals[0].__payload } as RaceResult<T>;
  }

  function test2() {
    const result = race(codeSubmitted, cancelled, timeout);

    switch (result.tag) {
      case 'code':
        // result.payload is { code: string; attempt: number }
        console.log(result.payload.code);
        break;
      case 'cancelled':
        break;
      case 'timeout':
        break;
    }
  }

  // This works but requires `result.tag` not `signal(...)` as case
}

// ============================================================================
// APPROACH 3: Abuse of Intersection Types and Type Guards
// ============================================================================
// Idea: Use intersection types and type assertions creatively

namespace Approach3 {
  // Result carriers
  interface SignalResult<Tag, TPayload> {
    readonly __tag: Tag
    readonly __payload: TPayload
  }

  type CodeResult = SignalResult<'code', { code: string; attempt: number }> & {
    code: string
    attempt: number
  };
  type CancelledResult = SignalResult<'cancelled', void>;
  type TimeoutResult = SignalResult<'timeout', void>;

  type AnyResult = CodeResult | CancelledResult | TimeoutResult;

  // What if race returns true but is typed as the union?
  function race(): AnyResult {
    return true as unknown as AnyResult;
  }

  // What if signal returns a specific variant but equals true at runtime?
  function signalCode(): CodeResult {
    return true as unknown as CodeResult;
  }
  function signalCancelled(): CancelledResult {
    return true as unknown as CancelledResult;
  }
  function delay(): TimeoutResult {
    return true as unknown as TimeoutResult;
  }

  function test3() {
    const r = race();
    // switch (r) with case signalCode() won't narrow...
    // TypeScript compares types structurally but switch/case uses ===

    // This WON'T work as desired:
    switch (r) {
      case signalCode():
        // r is still AnyResult, not CodeResult
        break;
    }
  }
}

// ============================================================================
// APPROACH 4: Object Pattern Matching via Destructuring
// ============================================================================
// Maybe we don't use switch at all? Use a pattern-matching object.

namespace Approach4 {
  interface RaceMatcher<TResult> {
    signal<P>(s: Signal<P>, handler: (payload: P) => TResult): RaceMatcher<TResult>
    delay(duration: { ms: number }, handler: () => TResult): RaceMatcher<TResult>
    run(): Promise<TResult>
  }

  function race<TResult>(): RaceMatcher<TResult> {
    const handlers: Array<() => TResult> = [];
    const matcher: RaceMatcher<TResult> = {
      signal: (s, handler) => {
        handlers.push(handler as () => TResult);
        return matcher;
      },
      delay: (d, handler) => {
        handlers.push(handler);
        return matcher;
      },
      run: async () => handlers[0](),
    };
    return matcher;
  }

  async function test4() {
    const result = await race<{ status: string }>()
      .signal(twofa.codeSubmitted, (payload) => {
        // payload is correctly { code: string; attempt: number }
        return { status: `got code ${payload.code}` };
      })
      .signal(twofa.cancelled, () => {
        return { status: 'cancelled' };
      })
      .delay(minutes(5), () => {
        return { status: 'timeout' };
      })
      .run();

    return result;
  }

  // This works for types but changes the syntax significantly
}

// ============================================================================
// APPROACH 5: Const Assertion + Template Literal Types
// ============================================================================
// Use const assertion to make signal names literal types

namespace Approach5 {
  // Signals defined with const
  const SIGNALS = {
    codeSubmitted: 'twofa.code' as const,
    cancelled: 'twofa.cancelled' as const,
    timeout: 'twofa.timeout' as const,
  };

  interface PayloadMap {
    'twofa.code': { code: string; attempt: number }
    'twofa.cancelled': void
    'twofa.timeout': void
  }

  type RaceResult = {
    [K in keyof PayloadMap]: {
      signal: K
      payload: PayloadMap[K]
    }
  }[keyof PayloadMap];

  function race(): RaceResult {
    return { signal: 'twofa.code', payload: { code: '', attempt: 0 } };
  }

  function test5() {
    const result = race();
    switch (result.signal) {
      case SIGNALS.codeSubmitted:
        // result.payload is narrowed!
        console.log(result.payload.code);
        break;
      case SIGNALS.cancelled:
        break;
      case SIGNALS.timeout:
        break;
    }
  }

  // Works but requires `result.signal` discriminant
}

// ============================================================================
// APPROACH 6: is() Type Guard Pattern
// ============================================================================
// What if we use if/else with type guards instead of switch?

namespace Approach6 {
  type SignalResult =
    | { type: 'signal'; signal: 'code'; payload: { code: string; attempt: number } }
    | { type: 'signal'; signal: 'cancelled'; payload: void };

  type DelayResult = { type: 'delay'; payload: void };

  type RaceResult = SignalResult | DelayResult;

  function race(): RaceResult {
    return { type: 'signal', signal: 'code', payload: { code: '', attempt: 0 } };
  }

  function isSignal<T extends SignalResult['signal']>(
    result: RaceResult,
    signal: T
  ): result is Extract<SignalResult, { signal: T }> {
    return result.type === 'signal' && 'signal' in result && (result as SignalResult).signal === signal;
  }

  function isDelay(result: RaceResult): result is DelayResult {
    return result.type === 'delay';
  }

  function test6() {
    const result = race();

    if (isSignal(result, 'code')) {
      // result.payload is { code: string; attempt: number }
      console.log(result.payload.code);
    } else if (isSignal(result, 'cancelled')) {
      // result.payload is void
    } else if (isDelay(result)) {
      // timeout
    }
  }

  // Works with if/else, not switch. But type narrowing is correct!
}

// ============================================================================
// APPROACH 7: Branded Case Expressions (the "holy grail" attempt)
// ============================================================================
// What if case expressions return the same branded type as the switch value?

namespace Approach7 {
  // Brand for race result
  declare const RACE_BRAND: unique symbol;

  // Base race result - a union of all possibilities
  type RaceBase<T> = T & { [RACE_BRAND]: true };

  // Individual outcomes
  interface CodeOutcome {
    readonly kind: 'code'
    readonly code: string
    readonly attempt: number
  }
  interface CancelledOutcome {
    readonly kind: 'cancelled'
  }
  interface TimeoutOutcome {
    readonly kind: 'timeout'
  }

  type AnyOutcome = CodeOutcome | CancelledOutcome | TimeoutOutcome;
  type RaceResult = RaceBase<AnyOutcome>;

  // race() returns true but typed as the union
  function race(): RaceResult {
    return true as unknown as RaceResult;
  }

  // signal() returns a "matcher" with the same brand
  // The trick: at runtime it returns true, but TypeScript sees a narrowed type
  function signal<K extends AnyOutcome['kind']>(
    _s: Signal<K extends 'code' ? { code: string; attempt: number } : void>
  ): RaceBase<Extract<AnyOutcome, { kind: K }>> {
    return true as unknown as RaceBase<Extract<AnyOutcome, { kind: K }>>;
  }

  // Hmm, but how do we connect the signal to the outcome?
  // TypeScript can't infer K from the signal alone...
}

// ============================================================================
// APPROACH 8: Symbol-Based Matching
// ============================================================================
// Use unique symbols as discriminants

namespace Approach8 {
  // Each signal gets a unique symbol
  const CODE_SYM = Symbol('code');
  const CANCEL_SYM = Symbol('cancel');
  const TIMEOUT_SYM = Symbol('timeout');

  type RaceResult =
    | { sym: typeof CODE_SYM; code: string; attempt: number }
    | { sym: typeof CANCEL_SYM }
    | { sym: typeof TIMEOUT_SYM };

  function race(): RaceResult {
    return { sym: CODE_SYM, code: '', attempt: 0 };
  }

  function test8() {
    const r = race();
    switch (r.sym) {
      case CODE_SYM:
        console.log(r.code); // Works!
        break;
      case CANCEL_SYM:
        break;
      case TIMEOUT_SYM:
        break;
    }
  }

  // Works but requires r.sym discriminant
}

// ============================================================================
// APPROACH 9: Match Expression (functional pattern matching)
// ============================================================================

namespace Approach9 {
  interface Signal9<T> {
    readonly __payload: T
    readonly name: string
  }

  // Builder pattern for race
  interface RaceBuilder {
    on<P>(signal: Signal9<P>): CaseBuilder<P>
    onTimeout(duration: { ms: number }): CaseBuilder<void>
  }

  interface CaseBuilder<P> {
    do<R>(handler: (payload: P) => R): RaceChain<R>
  }

  interface RaceChain<Acc> {
    on<P>(signal: Signal9<P>): CaseContinue<P, Acc>
    onTimeout(duration: { ms: number }): CaseContinue<void, Acc>
    run(): Promise<Acc>
  }

  interface CaseContinue<P, Acc> {
    do<R>(handler: (payload: P) => R): RaceChain<Acc | R>
  }

  // Local signal definitions for this approach
  const localTwofa = {
    codeSubmitted: {
      name: 'twofa.code_submitted',
      __payload: undefined as unknown as { code: string; attempt: number },
    } as Signal9<{ code: string; attempt: number }>,
    cancelled: {
      name: 'twofa.cancelled',
      __payload: undefined as unknown as void,
    } as Signal9<void>,
  };

  function race(): RaceBuilder {
    return null as unknown as RaceBuilder;
  }

  async function test9() {
    const result = await race()
      .on(localTwofa.codeSubmitted)
      .do((p) => ({ status: 'code' as const, code: p.code }))
      .on(localTwofa.cancelled)
      .do(() => ({ status: 'cancelled' as const }))
      .onTimeout(minutes(5))
      .do(() => ({ status: 'timeout' as const }))
      .run();

    // result is union of all possible returns
    if (result.status === 'code') {
      console.log(result.code);
    }
  }
}

// ============================================================================
// APPROACH 10: Proxy-based Magic (runtime + types together)
// ============================================================================

namespace Approach10 {
  type PayloadOf<S> = S extends Signal<infer P> ? P : never;

  interface RaceProxy<TSignals extends Signal<unknown>[]> {
    // Access payload by index after race resolves
    [K: number]: PayloadOf<TSignals[number]>
  }

  // This doesn't really help with narrowing either...
}

// ============================================================================
// APPROACH 11: The Compiler Hint Approach
// ============================================================================
// Accept that TypeScript can't do this naturally, but provide hints for a
// custom compiler/transformer that adds type assertions

namespace Approach11 {
  // Type annotation that the compiler recognizes
  type Narrowed<T> = T & { __narrowed: true };

  // The race result before narrowing
  type RaceResult =
    | { branch: 0; payload: { code: string; attempt: number } }
    | { branch: 1; payload: void }
    | { branch: 2; payload: void };

  // signal() hints what branch it represents
  interface SignalCase<Branch extends number, Payload> {
    __branch: Branch
    __payload: Payload
  }

  function race(): RaceResult {
    return { branch: 0, payload: { code: '', attempt: 0 } };
  }

  // The compiler would rewrite:
  //   case signal(twofa.codeSubmitted):
  // Into:
  //   case 0: const __narrowed = r as Extract<RaceResult, { branch: 0 }>

  function test11() {
    const r = race();
    switch (r.branch) {
      case 0: {
        // r is narrowed to { branch: 0; payload: ... }
        console.log(r.payload.code);
        break;
      }
      case 1:
        break;
      case 2:
        break;
    }
  }
}

// ============================================================================
// APPROACH 12: Generator-based (yield* pattern)
// ============================================================================
// What if race is a generator that yields narrowed results?

namespace Approach12 {
  type SignalDef<P> = { name: string; __payload: P };

  // Race arm definition
  interface RaceArm<T, P> {
    type: T
    payload: P
  }

  type ArmDef =
    | RaceArm<'code', { code: string; attempt: number }>
    | RaceArm<'cancelled', void>
    | RaceArm<'timeout', void>;

  // Generator that yields the winning arm
  async function* raceGen(): AsyncGenerator<ArmDef, void, unknown> {
    yield { type: 'code', payload: { code: '123456', attempt: 1 } };
  }

  async function test12() {
    for await (const arm of raceGen()) {
      switch (arm.type) {
        case 'code':
          console.log(arm.payload.code);
          break;
        case 'cancelled':
          break;
        case 'timeout':
          break;
      }
    }
  }
}

// ============================================================================
// APPROACH 13: The "Accessor Property" Trick
// ============================================================================
// What if the racer object has getters that narrow themselves?

namespace Approach13 {
  interface CodePayload {
    code: string
    attempt: number
  }

  interface RaceContext {
    // These getters return type guards
    isCode(): this is RaceContext & CodePayload
    isCancelled(): this is RaceContext & { cancelled: true }
    isTimeout(): this is RaceContext & { timeout: true }
  }

  function race(): RaceContext {
    const ctx: RaceContext & CodePayload = {
      code: '123',
      attempt: 1,
      isCode(): this is RaceContext & CodePayload {
        return true;
      },
      isCancelled(): this is RaceContext & { cancelled: true } {
        return false;
      },
      isTimeout(): this is RaceContext & { timeout: true } {
        return false;
      },
    };
    return ctx;
  }

  function test13() {
    const r = race();

    if (r.isCode()) {
      // r is narrowed to RaceContext & CodePayload
      console.log(r.code); // Works!
      console.log(r.attempt);
    } else if (r.isCancelled()) {
      console.log('cancelled');
    } else if (r.isTimeout()) {
      console.log('timeout');
    }
  }
}

// ============================================================================
// APPROACH 14: Assertion Functions in Case Expression
// ============================================================================
// TypeScript 3.7+ has assertion functions. Can we use them in switch?

namespace Approach14 {
  interface CodePayload {
    code: string
    attempt: number
  }

  type RaceResult =
    | { type: 'code'; payload: CodePayload }
    | { type: 'cancelled'; payload: void }
    | { type: 'timeout'; payload: void };

  // Assertion function
  function assertCode(r: RaceResult): asserts r is Extract<RaceResult, { type: 'code' }> {
    if (r.type !== 'code') throw new Error('not code');
  }

  // This doesn't work in switch/case syntax...
  // Assertion functions work in statement position, not expression position
}

// ============================================================================
// APPROACH 15: Infer from Callback Parameter (the winning approach?)
// ============================================================================
// What if match() takes callbacks where the parameter type is inferred?

namespace Approach15 {
  interface RaceMatch<R> {
    case<P>(signal: Signal<P>, handler: (payload: P) => R): RaceMatch<R>
    timeout(duration: { ms: number }, handler: () => R): RaceMatch<R>
    // Returning the first match result
    end(): R
  }

  function match<R>(): RaceMatch<R> {
    let result: R;
    return {
      case(signal, handler) {
        // First call wins (simulating race)
        if (result === undefined) {
          result = handler(signal.__payload);
        }
        return this;
      },
      timeout(duration, handler) {
        if (result === undefined) {
          result = handler();
        }
        return this;
      },
      end() {
        return result;
      },
    };
  }

  function test15(): { status: string } {
    // Perfect type inference!
    return match<{ status: string }>()
      .case(twofa.codeSubmitted, (payload) => {
        // payload is { code: string; attempt: number }
        return { status: `code: ${payload.code}, attempt: ${payload.attempt}` };
      })
      .case(twofa.cancelled, () => {
        return { status: 'cancelled' };
      })
      .timeout(minutes(5), () => {
        return { status: 'timeout' };
      })
      .end();
  }
}

// ============================================================================
// APPROACH 16: Overloaded match() with Tuple Types
// ============================================================================

namespace Approach16 {
  // Simpler version: just use explicit types
  type CodeHandler<R> = [Signal<{ code: string; attempt: number }>, (payload: { code: string; attempt: number }) => R];
  type VoidHandler<R> = [Signal<void>, () => R];
  type TimeoutHandler<R> = [{ ms: number }, () => R];

  // Overloaded race that accepts handlers directly
  function race<R1, R2, R3>(
    h1: CodeHandler<R1>,
    h2: VoidHandler<R2>,
    h3: TimeoutHandler<R3>
  ): R1 | R2 | R3;
  function race(...handlers: unknown[]): unknown {
    // Runtime: execute first handler that matches
    const [, handler] = handlers[0] as [unknown, (p: unknown) => unknown];
    return handler({});
  }

  function test16() {
    const result = race(
      [twofa.codeSubmitted, (p) => ({ status: 'code' as const, code: p.code })],
      [twofa.cancelled, () => ({ status: 'cancelled' as const })],
      [minutes(5), () => ({ status: 'timeout' as const })]
    );

    // Result type is union: { status: 'code', code: string } | { status: 'cancelled' } | { status: 'timeout' }
    if (result.status === 'code') {
      console.log(result.code);
    }
  }
}

// ============================================================================
// APPROACH 17: Direct Property Access (Most Ergonomic?)
// ============================================================================
// What if the race result directly exposes typed payload properties?

namespace Approach17 {
  // Union where each variant has its payload spread in
  type RaceResult =
    | ({ won: 'code' } & { code: string; attempt: number })
    | { won: 'cancelled' }
    | { won: 'timeout' };

  function race(): RaceResult {
    return { won: 'code', code: '123456', attempt: 1 };
  }

  function test17() {
    const r = race();

    switch (r.won) {
      case 'code':
        // Direct access to payload properties!
        console.log(r.code, r.attempt);
        break;
      case 'cancelled':
        break;
      case 'timeout':
        break;
    }
  }

  // This is nice but requires `r.won` not a signal reference in case
}

// ============================================================================
// APPROACH 18: Index Signature with Literal Types
// ============================================================================

namespace Approach18 {
  // Map signal to payload
  interface SignalPayloads {
    codeSubmitted: { code: string; attempt: number }
    cancelled: void
    timeout: void
  }

  type SignalKey = keyof SignalPayloads;

  type RaceResult = {
    [K in SignalKey]: { match: K; payload: SignalPayloads[K] }
  }[SignalKey];

  function race(): RaceResult {
    return { match: 'codeSubmitted', payload: { code: '', attempt: 0 } };
  }

  // signal() returns the key for switch comparison
  function signal<K extends SignalKey>(key: K): K {
    return key;
  }

  function delay(): 'timeout' {
    return 'timeout';
  }

  function test18() {
    const r = race();

    // Works! signal() returns the literal type for comparison
    switch (r.match) {
      case signal('codeSubmitted'):
        // r.payload is { code: string; attempt: number }
        console.log(r.payload.code);
        break;
      case signal('cancelled'):
        break;
      case delay():
        break;
    }
  }
}

// ============================================================================
// APPROACH 19: THE BREAKTHROUGH - Using signal instance as the discriminant
// ============================================================================

namespace Approach19 {
  // Signals are unique objects (like enum members)
  const codeSubmitted = Symbol('codeSubmitted');
  const cancelled = Symbol('cancelled');
  const timeout = Symbol('timeout');

  // Map symbols to their payload types
  interface SymbolPayloadMap {
    [codeSubmitted]: { code: string; attempt: number }
    [cancelled]: void
    [timeout]: void
  }

  type AllSignals = typeof codeSubmitted | typeof cancelled | typeof timeout;

  // Race result: the symbol that won, with its payload accessible
  type RaceResult = {
    [S in AllSignals]: {
      which: S
      payload: SymbolPayloadMap[S]
    }
  }[AllSignals];

  function race(): RaceResult {
    return {
      which: codeSubmitted,
      payload: { code: '123456', attempt: 1 },
    } as RaceResult;
  }

  function test19() {
    const r = race();

    // Use the actual signal symbols in case!
    switch (r.which) {
      case codeSubmitted:
        // r is narrowed, payload is { code: string; attempt: number }
        // Note: TypeScript doesn't narrow well with computed property symbols
        // This approach has limitations
        console.log((r.payload as { code: string }).code);
        break;
      case cancelled:
        break;
      case timeout:
        break;
    }
  }

  // Partially works but symbol-based discriminants have limitations
}

// ============================================================================
// APPROACH 20: Custom Case Expression Return Type
// ============================================================================
// What if case expressions return the expected type and === just checks true?

namespace Approach20 {
  // This is really clever: race() returns true, but typed as a union.
  // signal() returns true, but typed as ONE variant.
  // Switch compares true === true, but TypeScript sees type comparison.

  type CodeVariant = true & { __brand: 'code'; code: string; attempt: number };
  type CancelledVariant = true & { __brand: 'cancelled' };
  type TimeoutVariant = true & { __brand: 'timeout' };

  type RaceResult = CodeVariant | CancelledVariant | TimeoutVariant;

  function race(): RaceResult {
    // Returns true at runtime, but typed as union
    return Object.assign(true as CodeVariant, {
      __brand: 'code' as const,
      code: '123',
      attempt: 1,
    });
  }

  function signalCode(): CodeVariant {
    // Returns true at runtime
    return true as unknown as CodeVariant;
  }

  function signalCancelled(): CancelledVariant {
    return true as unknown as CancelledVariant;
  }

  function delayTimeout(): TimeoutVariant {
    return true as unknown as TimeoutVariant;
  }

  function test20() {
    const r = race();

    // Problem: TypeScript knows the TYPES don't overlap properly
    // switch(true union) case (true literal) doesn't narrow

    // This approach fundamentally doesn't work because:
    // 1. TypeScript's switch narrowing is based on discriminant property comparison
    // 2. You can't narrow a union by comparing the whole value to case expressions
    // 3. The === comparison at runtime doesn't translate to type narrowing

    // Would need to use r.__brand as discriminant instead
    switch (r.__brand) {
      case 'code':
        console.log(r.code);
        break;
      case 'cancelled':
        break;
      case 'timeout':
        break;
    }
  }
}

// ============================================================================
// APPROACH 21: Explicit Type Annotation in Case (Compiler-Assisted)
// ============================================================================
// The compiler could rewrite the switch to add type assertions

namespace Approach21 {
  type RaceResult =
    | { type: 'code'; code: string; attempt: number }
    | { type: 'cancelled' }
    | { type: 'timeout' };

  function race(): RaceResult {
    return { type: 'code', code: '123', attempt: 1 };
  }

  // Developer writes:
  //   switch (race()) {
  //     case signal(twofa.codeSubmitted):
  //       // use racer.code
  //
  // Compiler rewrites to:
  function test21_compiled() {
    const __race_result = race();
    switch (__race_result.type) {
      case 'code': {
        const racer = __race_result as Extract<RaceResult, { type: 'code' }>;
        // racer.code is accessible
        console.log(racer.code);
        break;
      }
      case 'cancelled':
        break;
      case 'timeout':
        break;
    }
  }
}

// ============================================================================
// APPROACH 22: Object with Getters that Type Guard
// ============================================================================

namespace Approach22 {
  type RaceOutcome =
    | { type: 'code'; code: string; attempt: number }
    | { type: 'cancelled' }
    | { type: 'timeout' };

  // Type guard function approach (simpler than method-based)
  function isType<T extends RaceOutcome, K extends T['type']>(
    outcome: T,
    type: K
  ): outcome is Extract<T, { type: K }> {
    return outcome.type === type;
  }

  function race(): RaceOutcome {
    return { type: 'code', code: '123', attempt: 1 };
  }

  function test22() {
    const r = race();

    if (isType(r, 'code')) {
      // r is narrowed to { type: 'code'; code: string; attempt: number }
      console.log(r.code);
    } else if (isType(r, 'cancelled')) {
      // r is narrowed to { type: 'cancelled' }
    } else if (isType(r, 'timeout')) {
      // r is narrowed to { type: 'timeout' }
    }
  }
}

// ============================================================================
// FINAL APPROACH: The "signal" Function Returns the Signal
// ============================================================================
// What if we accept that switch needs a discriminant property, but make
// the API clean by having signal() just return the signal name?

namespace FinalApproach {
  // Signals with literal type names
  interface TypedSignal<Name extends string, Payload> {
    readonly name: Name
    readonly __payload: Payload
  }

  const signals = {
    codeSubmitted: {
      name: 'codeSubmitted',
      __payload: undefined as unknown as { code: string; attempt: number },
    } as TypedSignal<'codeSubmitted', { code: string; attempt: number }>,

    cancelled: {
      name: 'cancelled',
      __payload: undefined as unknown as void,
    } as TypedSignal<'cancelled', void>,
  };

  type SignalName = 'codeSubmitted' | 'cancelled' | 'timeout';

  // Map signal names to payloads
  interface PayloadMap {
    codeSubmitted: { code: string; attempt: number }
    cancelled: void
    timeout: void
  }

  // Race result with the signal name as discriminant
  type RaceResult = {
    [K in SignalName]: { signal: K } & (PayloadMap[K] extends void
      ? {}
      : PayloadMap[K])
  }[SignalName];

  function race(): RaceResult {
    return { signal: 'codeSubmitted', code: '123', attempt: 1 };
  }

  // signal() extracts the name literal from a typed signal
  function signal<N extends string, P>(s: TypedSignal<N, P>): N {
    return s.name;
  }

  function delay(): 'timeout' {
    return 'timeout';
  }

  function testFinal() {
    const r = race();

    // This is the cleanest we can get with standard TypeScript:
    switch (r.signal) {
      case signal(signals.codeSubmitted):
        // r is narrowed! Direct property access works.
        console.log(r.code, r.attempt);
        break;

      case signal(signals.cancelled):
        // r.signal is 'cancelled', no payload
        break;

      case delay():
        // timeout
        break;
    }
  }
}

// ============================================================================
// ULTIMATE: Let the compiler handle it - just verify the types work
// ============================================================================

namespace UltimateSolution {
  // Define the Signal type with name as literal
  interface Signal<Name extends string = string, Payload = void> {
    readonly signalName: Name
    readonly __payload: Payload
  }

  // Create signals with literal names
  function createSignal<Name extends string, Payload = void>(
    name: Name
  ): Signal<Name, Payload> {
    return { signalName: name, __payload: undefined as unknown as Payload };
  }

  // Our service signals
  const twofa = {
    codeSubmitted: createSignal<'twofa.code', { code: string; attempt: number }>(
      'twofa.code'
    ),
    cancelled: createSignal<'twofa.cancelled'>('twofa.cancelled'),
  };

  // Duration type
  interface Duration {
    ms: number
  }

  // Delay identifier
  const DELAY_ID = '__delay__' as const;

  // Map signal names to payloads (including delay)
  type SignalPayloadMap = {
    'twofa.code': { code: string; attempt: number }
    'twofa.cancelled': void
    [DELAY_ID]: void
  };

  type AllSignalNames = keyof SignalPayloadMap;

  // Race result - discriminated union with payload properties spread in
  type RaceResult = {
    [K in AllSignalNames]: { which: K } & (SignalPayloadMap[K] extends void
      ? {}
      : SignalPayloadMap[K])
  }[AllSignalNames];

  // race() returns a discriminated union
  function race(): RaceResult {
    return { which: 'twofa.code', code: '123456', attempt: 1 };
  }

  // signal() returns the signal's name literal for switch comparison
  function signal<N extends string, P>(sig: Signal<N, P>): N {
    return sig.signalName;
  }

  // delay() returns the delay identifier
  function delay(d: Duration): typeof DELAY_ID {
    return DELAY_ID;
  }

  function ultimateTest() {
    const r = race();

    // THE CLEANEST POSSIBLE SYNTAX WITH STANDARD TYPESCRIPT:
    switch (r.which) {
      case signal(twofa.codeSubmitted):
        // r is narrowed to { which: 'twofa.code'; code: string; attempt: number }
        // Direct property access!
        console.log(r.code);
        console.log(r.attempt);
        return { code: r.code, attempt: r.attempt };

      case signal(twofa.cancelled):
        // r is narrowed to { which: 'twofa.cancelled' }
        return { cancelled: true };

      case delay(minutes(5)):
        // r is narrowed to { which: '__delay__' }
        return { timeout: true };
    }
  }

  // Verify type inference works
  type _Test1 = ReturnType<typeof ultimateTest>;
  // Should be: { code: string; attempt: number } | { cancelled: true } | { timeout: true }
}

// ============================================================================
// Export for verification
// ============================================================================

export {
  Approach4 as ChainedAPI,
  Approach15 as MatchPattern,
  Approach17 as DirectProps,
  FinalApproach as CleanSwitch,
  UltimateSolution as Ultimate,
};
