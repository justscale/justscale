/**
 * Custom error codes for the process compiler (TSPxxxx range).
 */

import ts from 'typescript';

/**
 * Custom error codes for process compilation.
 * Range: TSP1000-TSP9999
 */
export const ProcessErrorCode = {
  /**
   * TSP1001: Non-serializable await result must use `using` declaration.
   *
   * Process state is serialized to storage when suspended. Awaited values
   * from service calls (like `orders.get(Order.ref(id))`) return non-serializable
   * objects that must be rehydrated on resume.
   *
   * Wrong: `const order = await orders.get(Order.ref(id))`
   * Right: `using order = await orders.get(Order.ref(id))`
   */
  NonSerializableConst: 1001,

  /**
   * TSP1002: Signal must be awaited inside process handler.
   *
   * The `signal()` primitive creates a suspension point and must be awaited.
   *
   * Wrong: `signal(orders.complete)`
   * Right: `await signal(orders.complete)`
   */
  SignalNotAwaited: 1002,

  /**
   * TSP1003: Invalid race pattern - switch must use `await race()`.
   *
   * The race pattern requires a specific structure with switch/case.
   */
  InvalidRacePattern: 1003,

  /**
   * TSP1004: Process handler must be an async function.
   */
  HandlerNotAsync: 1004,

  /**
   * TSP1005: Cannot use non-deterministic operations in process handler.
   *
   * Operations like `Date.now()`, `Math.random()`, or `crypto.randomUUID()`
   * produce different results on replay and break determinism.
   */
  NonDeterministicOperation: 1005,

  /**
   * TSP1006: Signal/delay must be used directly, not stored in a variable.
   *
   * The compiler transforms signal() and delay() calls at compile time.
   * Storing them in variables breaks this transformation.
   *
   * Wrong: `const s = signal(orders.paid); await s;`
   * Right: `await signal(orders.paid)`
   *
   * Wrong: `const d = delay.minutes(5); await d;`
   * Right: `await delay.minutes(5)`
   */
  SignalStoredInVariable: 1006,

  /**
   * TSP1007: Cannot use try-catch around suspension points.
   *
   * Process suspensions serialize state to storage. Exceptions cannot be
   * caught across suspension boundaries because the try-catch context is
   * lost when the process resumes from storage.
   *
   * Wrong: `try { await signal(orders.paid) } catch (e) { ... }`
   * Right: Use race() with a timeout or handle errors in the signaling service.
   */
  TryCatchWithSuspension: 1007,

  /**
   * TSP1008: Cannot use nested async functions with suspension points.
   *
   * Suspension points must be directly in the process handler, not in
   * nested async functions or callbacks. The compiler cannot track
   * suspensions through nested function boundaries.
   *
   * Wrong: `const fn = async () => { await signal(...) }; await fn()`
   * Right: Use await signal() directly in the handler.
   */
  NestedAsyncWithSuspension: 1008,

  /**
   * TSP1009: Cannot use Promise.all/Promise.race with signals.
   *
   * Process primitives like signal() and delay() must be awaited directly
   * or used in a race() switch pattern. Promise combinators bypass the
   * compiler's suspension tracking.
   *
   * Wrong: `await Promise.all([signal(a), signal(b)])`
   * Right: Use sequential awaits or the race() switch pattern.
   */
  PromiseCombinatorWithSignal: 1009,

  /**
   * TSP1010: For-in loops with suspension points are not supported.
   *
   * For-in iteration over object keys cannot be made durable because
   * property enumeration order is not guaranteed to be stable.
   * Convert to Object.keys() with a for-of loop or while loop.
   *
   * Wrong: `for (const key in obj) { await signal(...) }`
   * Right: `for (const key of Object.keys(obj)) { await signal(...) }`
   */
  ForInWithSuspension: 1010,

  /**
   * TSP1011: Inner function escapes handler scope.
   *
   * Inner functions with suspension points must be called directly within
   * the handler. Returning them, storing them in arrays, or passing them
   * to other functions prevents the compiler from inlining.
   *
   * Wrong: `const fn = async () => { await signal(...) }; return fn`
   * Right: `const fn = async () => { await signal(...) }; await fn()`
   */
  FunctionEscapesScope: 1011,

  /**
   * TSP1012: Parallel functions cannot have parameters.
   *
   * Functions used in signal.all() cannot have parameters because they
   * are executed in parallel without specific arguments.
   *
   * Wrong: `signal.all([async (x) => { await signal(...) }])`
   * Right: `signal.all([async () => { await signal(...) }])`
   */
  ParallelFunctionWithParams: 1012,

  /**
   * TSP1013: While-loop condition contains a suspension point.
   *
   * The compiler cannot suspend inside a while-loop condition because
   * the condition is re-evaluated on each iteration before the loop body.
   * Move the suspension into the loop body with an explicit break.
   *
   * Wrong: `while (await signal(svc.hasMore)) { ... }`
   * Right: `while (true) { if (!await signal(svc.hasMore)) break; ... }`
   */
  WhileConditionSuspension: 1013,

  /**
   * TSP1014: Do-while loops with suspension points are not supported.
   *
   * The compiler does not yet support do-while loops containing
   * suspension points. Convert to a while(true) loop with a break.
   *
   * Wrong: `do { await signal(svc.event) } while (condition)`
   * Right: `while (true) { await signal(svc.event); if (!condition) break }`
   */
  DoWhileWithSuspension: 1014,

  /**
   * TSP1015: Classic for loops with suspension points are not supported.
   *
   * The compiler cannot make classic for(;;) loops durable because the
   * incrementor and condition expressions would need to be re-evaluated
   * on resume. Convert to a while loop with explicit counter management.
   *
   * Wrong: `for (let i = 0; i < n; i++) { await signal(...) }`
   * Right: `let i = 0; while (i < n) { await signal(...); i++ }`
   */
  ForWithSuspension: 1015,

  /**
   * TSP2001: Recursion depth cannot be determined statically.
   *
   * The compiler must inline inner functions into the parent state machine.
   * Recursive calls require static bounds to prevent infinite expansion.
   *
   * Wrong: `function recurse(n) { if (n > 0) await recurse(n - 1) }`
   * Right: Use a while loop or bounded recursion with a constant limit.
   */
  RecursionDepthUnknown: 2001,

  /**
   * TSP2002: Mutual recursion detected.
   *
   * Two or more functions that call each other cannot be inlined into
   * a state machine. The compiler cannot determine the call order.
   *
   * Wrong: `function a() { b() } function b() { a() }`
   * Right: Restructure to use a single function or loop.
   */
  MutualRecursion: 2002,

  /**
   * TSP2003: Maximum inlining depth exceeded.
   *
   * The nested function call depth exceeds the maximum allowed for
   * inlining (default: 10 levels). This prevents state machine explosion.
   */
  MaxInliningDepthExceeded: 2003,

  /**
   * TSP3001: Invalid durable iterator (missing ORDER BY).
   *
   * Repository queries used in for-of loops must have an ORDER BY clause
   * with at least one unique column for keyset pagination to work.
   */
  InvalidDurableIterator: 3001,

  /**
   * TSP3002: Non-serializable cursor type.
   *
   * Durable iterators must produce serializable cursors (strings, numbers,
   * or objects of primitives). Complex objects cannot be persisted.
   */
  NonSerializableCursor: 3002,

  /**
   * TSP3003: Yield in non-generator handler.
   *
   * The `yield` expression can only be used in async generator handlers
   * declared with `async *handler()`. Regular async handlers cannot yield.
   *
   * Wrong: `async handler() { yield event }`
   * Right: `async *handler() { yield event }`
   */
  YieldInNonGenerator: 3003,

  /**
   * TSP3004: Throw statement not allowed in process handler.
   *
   * Process handlers should return error results instead of throwing.
   * Thrown exceptions break the durable execution model.
   *
   * Wrong: `throw new Error('failed')`
   * Right: `return { status: 'error', message: 'failed' }`
   */
  ThrowNotAllowed: 3004,

  /**
   * TSP3005: signal.all() with empty array literal.
   *
   * Parallel blocks must have at least one branch.
   *
   * Wrong: `await signal.all([])`
   * Right: `await signal.all([svc.a, svc.b])`
   */
  EmptyParallelBlock: 3005,

  /**
   * TSP3006: scope() exceeded item limit.
   *
   * The scope() function limits the number of entities to prevent
   * state explosion. Default limit is 1000 items.
   */
  ScopeItemLimitExceeded: 3006,

  /**
   * TSP3007: Scope handler cannot yield.
   *
   * Handlers inside scope() cannot use yield. To emit events from
   * scoped processing, use a process reference with subprocess.
   *
   * Wrong: `scope(items, async (item) => { yield item })`
   * Right: `scope(processRef, items)`
   */
  ScopeHandlerCannotYield: 3007,

  /**
   * TSP3008: Duplicate entity in scope.
   *
   * Each entity in a scope() call must have a unique identity.
   * Duplicate IDs would create conflicting execution paths.
   */
  DuplicateEntityInScope: 3008,

  /**
   * TSP3009: Nested scope collision.
   *
   * Cannot nest scope() calls with the same model type. This would
   * create ambiguous identity paths.
   */
  NestedScopeCollision: 3009,

  /**
   * TSP3010: Race switch has no valid branches.
   *
   * A race switch must have at least one signal or delay branch.
   * An empty switch would suspend indefinitely.
   *
   * Wrong: `const r = race(); switch (true) { default: break }`
   * Right: `const r = race(); switch (true) { case signal(r, svc.a): ... }`
   */
  EmptyRace: 3010,

  /**
   * TSP3011: Invalid scope() arguments.
   *
   * scope() requires at least 2 arguments in one of these forms:
   * - scope(signal, entities)
   * - scope(entities, handler)
   * - scope(entities, idFn, handler)
   */
  InvalidScopeArguments: 3011,

  /**
   * TSP3012: signal.all / signal.settled / stream inside race switch.
   *
   * These combinators are not yet supported as case expressions in a race
   * switch. Use them as standalone awaits outside of a race, or use plain
   * signal(r, ...) / delay(r, ...) branches.
   *
   * Wrong: `case signal.all(r, [svc.a, svc.b]):`
   * Right: `case signal(r, svc.a):` or `const result = await signal.all([svc.a, svc.b])`
   */
  RaceCombinatorNotSupported: 3012,

  /**
   * TSP3013: Variable shadowing in process handler.
   *
   * Process state is serialized to a flat `state.vars.{name}` namespace.
   * Block-scoped redeclarations (`const x = 1; { const x = 99 }`) collapse
   * onto the same storage slot — the inner binding silently overwrites the
   * outer, breaking lexical scope semantics. Function-parameter shadowing
   * is fine (parameters live in their own activation record); this error
   * is only for declarations that share a flat scope with the outer binding.
   *
   * Wrong: `const x = 1; { const x = 99; ... }`
   * Right: `const x = 1; { const innerX = 99; ... }`
   */
  ShadowedHandlerLocal: 3013,
} as const;

export type ProcessErrorCode = (typeof ProcessErrorCode)[keyof typeof ProcessErrorCode];


const errorMessages: Record<ProcessErrorCode, string> = {
  [ProcessErrorCode.NonSerializableConst]:
    "Process state is serialized to storage on suspension - 'const {0}' cannot be restored on resume. " +
    "Declare it as 'using {0}' so the runtime can rehydrate it on resume.",

  [ProcessErrorCode.SignalNotAwaited]:
    'Signal must be awaited to create a suspension point. ' +
    "Use 'await signal({0})' instead of 'signal({0})'.",

  [ProcessErrorCode.InvalidRacePattern]:
    'Invalid race pattern. Expected: switch (await race()) { case await signal(...): ... }',

  [ProcessErrorCode.HandlerNotAsync]:
    'Process handler must be an async function.',

  [ProcessErrorCode.NonDeterministicOperation]:
    "Non-deterministic operation '{0}' cannot be used in a process handler - " +
    'replaying from persisted state would produce different results. ' +
    'For timestamps, pass the current time as a signal payload. For random values, generate them before the process starts and pass as a parameter.',

  [ProcessErrorCode.SignalStoredInVariable]:
    "'{0}' must be used directly in an await expression so the compiler can track the suspension point - storing it in a variable loses tracking. " +
    "Write 'await {0}(...)' or 'case {0}(r, ...):' directly.",

  [ProcessErrorCode.TryCatchWithSuspension]:
    'Cannot use try-catch around suspension points - processes resume from persisted state, so catch blocks cannot be serialized. ' +
    'Handle errors by adding a timeout branch to your race, or move error-prone logic into a service method.',

  [ProcessErrorCode.NestedAsyncWithSuspension]:
    'Cannot use suspension points (signal/delay) inside nested async functions. ' +
    'Move the await signal() directly into the process handler.',

  [ProcessErrorCode.PromiseCombinatorWithSignal]:
    'Cannot use {0} with process primitives. ' +
    'Use sequential awaits or the race() switch pattern instead.',

  [ProcessErrorCode.ForInWithSuspension]:
    'For-in loops with suspension points are not supported. ' +
    'Convert to for-of with Object.keys(): for (const key of Object.keys(obj)) { ... }',

  [ProcessErrorCode.FunctionEscapesScope]:
    'Inner function with suspension points escapes handler scope. ' +
    'Functions with signal/delay must be called directly, not returned or passed.',

  [ProcessErrorCode.ParallelFunctionWithParams]:
    'Parallel functions cannot have parameters. ' +
    "Use 'async () => {{ ... }}' instead of 'async ({0}) => {{ ... }}'.",

  [ProcessErrorCode.WhileConditionSuspension]:
    'While-loop condition contains a suspension point (signal/delay). ' +
    'Move it into the body: while (true) {{ if (!await signal(...)) break; ... }}',

  [ProcessErrorCode.DoWhileWithSuspension]:
    'Do-while loops with suspension points are not supported. ' +
    'Convert to: while (true) {{ await signal(...); if (!condition) break }}',

  [ProcessErrorCode.ForWithSuspension]:
    'Classic for loops with suspension points are not supported. ' +
    'Convert to a while loop: let i = 0; while (i < n) { await signal(...); i++ }',

  [ProcessErrorCode.RecursionDepthUnknown]:
    "Recursive function '{0}' cannot be inlined - recursion depth is not statically known. " +
    'Use a while loop or provide a constant recursion limit.',

  [ProcessErrorCode.MutualRecursion]:
    "Mutual recursion detected between '{0}' and '{1}'. " +
    'Restructure to use a single function or loop.',

  [ProcessErrorCode.MaxInliningDepthExceeded]:
    "Maximum inlining depth ({0}) exceeded for function '{1}'. " +
    'Reduce nesting or restructure to use loops.',

  [ProcessErrorCode.InvalidDurableIterator]:
    'Durable iteration requires ORDER BY with a unique final column. ' +
    "Add .orderBy('createdAt', 'id') to your query for keyset pagination.",

  [ProcessErrorCode.NonSerializableCursor]:
    'Durable iterator cursor must be serializable (string, number, or plain object). ' +
    'The cursor type {0} cannot be persisted.',

  [ProcessErrorCode.YieldInNonGenerator]:
    "Cannot use 'yield' in a regular async handler. " +
    "Use 'async *handler()' instead of 'async handler()' to enable yields.",

  [ProcessErrorCode.ThrowNotAllowed]:
    'Throw statements are not allowed in process handlers - processes track state via program counter, not exception unwinding. ' +
    "Return an error result object instead: return {{ status: 'error', message: '...' }}.",

  [ProcessErrorCode.EmptyParallelBlock]:
    'signal.all() requires at least one signal. ' +
    'Use await signal(svc.single) for a single signal.',

  [ProcessErrorCode.ScopeItemLimitExceeded]:
    'scope() exceeded maximum item limit ({0}). ' +
    'Process batches or increase the limit if necessary.',

  [ProcessErrorCode.ScopeHandlerCannotYield]:
    'Scope handlers cannot use yield. ' +
    'Use scope(processRef, items) with a generator process to emit events.',

  [ProcessErrorCode.DuplicateEntityInScope]:
    "Duplicate entity ID '{0}' in scope(). " +
    'Each entity must have a unique identity.',

  [ProcessErrorCode.NestedScopeCollision]:
    "Nested scope() with same model type '{0}' creates ambiguous paths. " +
    'Use different model types or restructure the nesting.',

  [ProcessErrorCode.EmptyRace]:
    'Race switch has no valid signal or delay branches. ' +
    'Add at least one case with signal(r, ...) or delay(r, ...).',

  [ProcessErrorCode.InvalidScopeArguments]:
    'Invalid scope() arguments. Use one of: scope(signal, entities), scope(entities, handler), or scope(entities, idFn, handler).',

  [ProcessErrorCode.RaceCombinatorNotSupported]:
    'signal.all / signal.settled / stream inside a race switch is not yet supported. ' +
    'Use signal(r, svc.x) / delay.seconds(r, n) branches, or await the combinator outside the race.',

  [ProcessErrorCode.ShadowedHandlerLocal]:
    "Variable '{0}' shadows an outer process-handler local. Process state is serialized to a flat " +
    'state.vars namespace; block-scoped redeclarations would silently overwrite the outer binding. ' +
    'Rename the inner variable.',
};


/**
 * Create a process-specific diagnostic.
 */
export function createProcessDiagnostic(
  code: ProcessErrorCode,
  node: ts.Node,
  ...args: string[]
): ts.Diagnostic {
  let message = errorMessages[code];

  for (let i = 0; i < args.length; i++) {
    message = message.split(`{${i}}`).join(args[i]);
  }

  const sourceFile = node.getSourceFile();
  const start = node.getStart();
  const length = node.getWidth();

  return {
    file: sourceFile,
    start,
    length,
    messageText: message,
    category: ts.DiagnosticCategory.Error,
    code: 100000 + code, // Offset to avoid collision with TS codes
    source: 'justscale-process',
  };
}

/**
 * Format error code for display.
 */
export function formatErrorCode(code: ProcessErrorCode): string {
  return `TSP${code}`;
}

/**
 * Check if a diagnostic is a process-specific error.
 */
export function isProcessDiagnostic(diagnostic: ts.Diagnostic): boolean {
  return diagnostic.source === 'justscale-process';
}

/**
 * Get the process error code from a diagnostic.
 */
export function getProcessErrorCode(diagnostic: ts.Diagnostic): ProcessErrorCode | null {
  if (!isProcessDiagnostic(diagnostic)) return null;
  return (diagnostic.code - 100000) as ProcessErrorCode;
}


/**
 * Collector for process diagnostics during compilation.
 */
export class DiagnosticCollector {
  private diagnostics: ts.Diagnostic[] = [];

  add(code: ProcessErrorCode, node: ts.Node, ...args: string[]): void {
    this.diagnostics.push(createProcessDiagnostic(code, node, ...args));
  }

  getAll(): ts.Diagnostic[] {
    return [...this.diagnostics];
  }

  hasErrors(): boolean {
    return this.diagnostics.length > 0;
  }

  clear(): void {
    this.diagnostics = [];
  }
}

/**
 * Filter TS2850 diagnostics for `using exports` declarations in process files.
 * TS2850 fires because the exports object doesn't have Symbol.dispose, but
 * our compiler handles disposal separately - this diagnostic is noise.
 */
export function filterUsingExportsDiagnostics(diagnostics: ts.Diagnostic[]): ts.Diagnostic[] {
  return diagnostics.filter(d => {
    if (d.code !== 2850) return true;
    if (d.start === undefined || !d.file) return true;
    const node = findNodeAt(d.file, d.start);
    if (!node) return true;
    let current: ts.Node | undefined = node;
    while (current) {
      if (ts.isVariableDeclaration(current)) {
        if (ts.isIdentifier(current.name) && current.name.text === 'exports') {
          const parent = current.parent;
          if (parent && ts.isVariableDeclarationList(parent)) {
            return (parent.flags & ts.NodeFlags.Using) === 0;
          }
        }
        return true;
      }
      current = current.parent;
    }
    return true;
  });
}

function findNodeAt(sourceFile: ts.SourceFile, position: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (position >= node.getStart(sourceFile) && position < node.getEnd()) {
      found = node;
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}
