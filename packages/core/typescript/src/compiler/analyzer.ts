/**
 * Analyzes process handler functions to produce opcodes for the code generator.
 */

import ts from 'typescript';
import { DiagnosticCollector, ProcessErrorCode } from './errors.js';


export type Opcode =
  | { op: 'BLOCK'; blockId: number }
  | { op: 'STORE'; var: string; fromBlock?: boolean; fromRace?: boolean; fromSignal?: boolean }
  | { op: 'REHYDRATE'; var: string; blockId: string; expression: ts.Expression }
  | { op: 'SCOPE_ENTER'; scopeId: number; dispose?: string[] }
  | { op: 'SCOPE_EXIT'; scopeId: number }
  | { op: 'WAIT'; signal: string; signalExpr?: ts.Expression; timer?: { unit: 'seconds' | 'minutes' | 'hours' | 'days'; valueExpr: ts.Expression }; rehydrate?: string[] }
  | { op: 'RACE_START'; branches: RaceBranch[]; rehydrate?: string[] }
  | { op: 'RACE_SUSPEND' }
  | { op: 'JUMP'; target: number }
  | { op: 'JUMP_IF'; condition: string; target: number }
  | { op: 'LABEL'; label: string }
  | { op: 'LABEL_ENTER'; label: string }
  | { op: 'LABEL_EXIT'; label: string }
  | { op: 'ITER_START'; iterableExpr: ts.Expression; cursorVar: string; itemVar: string; loopId: number }
  | { op: 'ITER_NEXT'; cursorVar: string; doneTarget: number; loopId: number }
  | { op: 'ITER_SAVE'; cursorVar: string; loopId: number }
  | { op: 'PARALLEL_START'; parallelId: number; branches: ParallelBranch[]; isSettled: boolean }
  | { op: 'PARALLEL_WAIT'; parallelId: number }
  | { op: 'PARALLEL_COLLECT'; parallelId: number; resultVar: string; isObject: boolean }
  | { op: 'YIELD_EMIT'; valueExpr: ts.Expression }
  | { op: 'SCOPE_START'; scopeId: number; iterableExpr: ts.Expression; idExtractor?: ts.Expression; paramAlias?: string }
  | { op: 'SCOPE_NEXT'; scopeId: number; itemVar: string }
  | { op: 'SCOPE_WAIT'; scopeId: number; signalExpr: ts.Expression }
  | { op: 'SCOPE_HANDLER'; scopeId: number; handlerBody: ts.Block; handlerParams: string[] }
  | { op: 'SCOPE_END'; scopeId: number; resultVar: string }
  | { op: 'RETURN'; value?: unknown }
  | { op: 'SUBPROCESS_DECL'; name: string; path: string; handlerNode: ts.ArrowFunction | ts.FunctionExpression; handlerParams: string[] }
  | { op: 'SUBPROCESS_SPAWN'; name: string; argExprs: ts.Expression[]; storeVar?: string; awaited: boolean };

export interface ParallelBranch {
  /** Branch index (0, 1, 2...) for arrays, or key name for objects */
  id: string | number
  /** The expression for this branch (signal ref, delay, or async function) */
  expr: ts.Expression
  /** Type of branch */
  type: 'signal' | 'delay' | 'function'
}

export interface RaceBranch {
  id: string
  signal?: string
  /** Original signal expression for runtime access to signalName */
  signalExpr?: ts.Expression
  /** Timer configuration with unit and expression */
  timer?: {
    unit: 'seconds' | 'minutes' | 'hours' | 'days'
    /** The expression for the duration value (e.g., `5` or `attempt * 5`) */
    valueExpr: ts.Expression
  }
  jumpTarget: number
}

import {
  containsSuspensionPoint,
  findSuspensionPoints,
  getPrimitiveCall,
  isRaceCall as isPrimitiveRaceCall,
  isSignalCall as isPrimitiveSignalCall,
  isDelayCall as isPrimitiveDelayCall,
  isSignalCombinatorCall as isPrimitiveSignalCombinatorCall,
  isStreamCall as isPrimitiveStreamCall,
  isScopeCall as isPrimitiveScopeCall,
} from './primitive-detector.js';


/**
 * Check if a function has the async modifier.
 */
function hasAsyncModifier(
  node: ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration
): boolean {
  if (!node.modifiers) return false;
  return node.modifiers.some(
    (mod) => mod.kind === ts.SyntaxKind.AsyncKeyword
  );
}

/**
 * Non-deterministic operation patterns that break replay determinism.
 */
const NON_DETERMINISTIC_PATTERNS = [
  { object: 'Date', method: 'now' },
  { object: 'Math', method: 'random' },
  { object: 'crypto', method: 'randomUUID' },
  { object: 'crypto', method: 'getRandomValues' },
];

/**
 * Check if a call expression is a non-deterministic operation.
 * Detects: Date.now(), Math.random(), crypto.randomUUID(), new Date()
 */
function isNonDeterministicCall(node: ts.Node): { name: string } | null {
  // Check for new Date() without arguments
  if (ts.isNewExpression(node)) {
    if (ts.isIdentifier(node.expression) && node.expression.text === 'Date') {
      // new Date() with no args or new Date() uses current time
      if (!node.arguments || node.arguments.length === 0) {
        return { name: 'new Date()' };
      }
    }
    return null;
  }

  // Check for method calls like Date.now(), Math.random()
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      const obj = callee.expression;
      const method = callee.name.text;
      if (ts.isIdentifier(obj)) {
        const objName = obj.text;
        for (const pattern of NON_DETERMINISTIC_PATTERNS) {
          if (objName === pattern.object && method === pattern.method) {
            return { name: `${objName}.${method}()` };
          }
        }
      }
    }
  }

  return null;
}

/**
 * Find signal() or delay() calls that are not awaited.
 * Returns the primitive name if found, null otherwise.
 */
function findUnawaitedPrimitive(
  expr: ts.Expression,
  ctx: AnalyzerContext
): string | null {
  // If the expression is an await, it's fine
  if (ts.isAwaitExpression(expr)) {
    return null;
  }

  // Check if this is a direct call to signal() or delay()
  if (ts.isCallExpression(expr)) {
    if (isWaitForCall(expr, ctx)) {
      return 'signal';
    }
    if (isDelayCall(expr, ctx)) {
      return 'delay';
    }
  }

  return null;
}

/**
 * Recursively check for non-deterministic operations and report them.
 */
function checkForNonDeterministicOps(node: ts.Node, ctx: AnalyzerContext): void {
  const nonDet = isNonDeterministicCall(node);
  if (nonDet) {
    ctx.diagnostics.add(ProcessErrorCode.NonDeterministicOperation, node, nonDet.name);
  }

  // Recursively check children
  ts.forEachChild(node, (child) => checkForNonDeterministicOps(child, ctx));
}

/**
 * Recursively check for throw statements and report them.
 * TSP3004: throw statements are not allowed in process handlers.
 */
function checkForThrowStatements(node: ts.Node, ctx: AnalyzerContext): void {
  if (ts.isThrowStatement(node)) {
    ctx.diagnostics.add(ProcessErrorCode.ThrowNotAllowed, node);
    return;
  }

  // Recursively check children
  ts.forEachChild(node, (child) => checkForThrowStatements(child, ctx));
}

export interface ExportFieldInfo {
  name: string
  node: ts.Node
}

export interface ExportMethodInfo {
  name: string
  node: ts.MethodDeclaration | ts.PropertyAssignment
}

export interface ExportsInfo {
  fields: ExportFieldInfo[]
  methods: ExportMethodInfo[]
  declarationNode: ts.Node
}

export interface SubProcessInfo {
  /** Subprocess name from config (e.g., 'player') */
  name: string
  /** Subprocess path from config (e.g., '/:playerId') */
  path: string
  /** Variable name used in the parent handler (e.g., 'playerSeat') */
  varName: string
  handlerNode: ts.ArrowFunction | ts.FunctionExpression
  handlerParams: string[]
  /** Analysis of the subprocess handler body */
  analysis: AnalysisResult
}

export interface AnalysisResult {
  opcodes: Opcode[]
  /** Source nodes corresponding to each opcode (for source map generation) */
  opcodeSourceNodes: (ts.Node | undefined)[]
  /** Source nodes for race branches (key: opcode index, value: map of branchId to source node) */
  raceBranchSourceNodes: Map<number, Map<string, ts.Node>>
  blocks: BlockDefinition[]
  rehydrationBlocks: Record<string, RehydrationBlockDef>
  signals: Record<string, SignalInfo>
  variables: Map<string, VariableInfo>
  /** Race result variables (from const r = race()) - rewrite to __raceResult */
  raceVars: Set<string>
  diagnostics: ts.Diagnostic[]
  /** Whether the handler is an async generator (uses yield) */
  isGenerator: boolean
  /** Yield expressions found in the handler (for event type extraction) */
  yields: ts.Expression[]
  /** Process exports defined via `using exports = { ... }` */
  exports?: ExportsInfo
  /** Subprocess definitions declared via createSubProcess() */
  subprocesses: SubProcessInfo[]
}

export interface BlockDefinition {
  id: number
  uses: string[] // `using` variables this block depends on
  statements: ts.Statement[]
}

export interface RehydrationBlockDef {
  deps: string[]
  expression: ts.Expression
}

export interface SignalInfo {
  identity: string[]
  payloadType: string
}

export interface VariableInfo {
  name: string
  isUsing: boolean // Declared with `using`
  isSerializable: boolean
  declarationNode: ts.Node
  usedInBlocks: number[]
}

/**
 * Information about an inner function that may contain suspension points.
 * Used for inlining inner function state machines into the parent handler.
 */
export interface InnerFunctionInfo {
  name: string
  node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration
  /** Whether the function contains suspension points (signal/delay) */
  hasSuspension: boolean
  /** Whether the function is async */
  isAsync: boolean
  /** Variables captured from outer scope (closures) */
  capturedVars: Set<string>
  /** How many times this function has been inlined (for recursion detection) */
  inlineCount: number
  /** Functions that this function calls (for mutual recursion detection) */
  callsTo: Set<string>
}

interface AnalyzerContext {
  typeChecker: ts.TypeChecker
  opcodes: Opcode[]
  /** Source nodes for each opcode (parallel array for source map generation) */
  opcodeSourceNodes: (ts.Node | undefined)[]
  /** Source nodes for race branches (key: opcode index, value: map of branchId to source node) */
  raceBranchSourceNodes: Map<number, Map<string, ts.Node>>
  blocks: BlockDefinition[]
  rehydrationBlocks: Record<string, RehydrationBlockDef>
  signals: Record<string, SignalInfo>
  variables: Map<string, VariableInfo>
  /** Race result variables (from const r = race()) */
  raceVars: Set<string>
  diagnostics: DiagnosticCollector
  currentBlockStatements: ts.Statement[]
  currentBlockUses: Set<string>
  labelTargets: Map<string, number>
  pendingLabelPatches: Array<{ opcode: Opcode; label: string; field: 'target' | 'jumpTarget' }>
  scopeStack: number[]
  nextScopeId: number
  /** Stack of loop labels for continue/break handling */
  loopStack: Array<{ startLabel: string; endLabel: string }>
  /** True when analyzing race switch branches (break should not emit JUMP) */
  inRaceBranch: boolean
  /** Depth of nested regular switches inside a race branch */
  nestedSwitchDepth: number
  /** Counter for generating unique loop IDs */
  nextLoopId: number
  /** Counter for generating unique parallel block IDs */
  nextParallelId: number
  /** Inner functions defined in the handler (for inlining) */
  innerFunctions: Map<string, InnerFunctionInfo>
  /** Stack of functions currently being inlined (for recursion detection) */
  inliningStack: string[]
  /** Maximum allowed inlining depth */
  maxInliningDepth: number
  /** Whether the handler is an async generator */
  isGenerator: boolean
  /** Yield expressions found in the handler */
  yields: ts.Expression[]
  /** Counter for generating unique scope IDs */
  nextScopeBlockId: number
  /** Process exports info from `using exports = { ... }` */
  exports?: ExportsInfo
  /** Subprocess definitions from createSubProcess() */
  subprocesses: SubProcessInfo[]
}

/**
 * Emit an opcode with optional source node for source map generation.
 */
function emitOpcode(ctx: AnalyzerContext, opcode: Opcode, sourceNode?: ts.Node): void {
  ctx.opcodes.push(opcode);
  ctx.opcodeSourceNodes.push(sourceNode);
}

/**
 * Register a variable in ctx.variables, emitting a ShadowedHandlerLocal
 * diagnostic if `name` already maps to a *different* declaration node AND
 * the redeclaration is sequentially nested inside the existing one (i.e.
 * the inner block runs after the outer write, on the same execution path).
 *
 * Skipped (intentionally not flagged):
 * - Function-parameter shadowing — handled by the rewriter's sub-context.
 * - Both old and new are `using` declarations — per-block REHYDRATE opcodes
 *   make these independent, no flat-slot conflict.
 * - The name is a race-result var — rewritten to `__raceResult`, not
 *   state.vars.{name}.
 * - Mutually-exclusive branches (if/else, switch, ternary) — both
 *   declarations write the same slot but only one runs per execution; reads
 *   stay within their branch. This is the common pattern in process
 *   handlers and isn't a bug.
 */
function registerVariable(
  ctx: AnalyzerContext,
  name: string,
  info: VariableInfo,
): void {
  const existing = ctx.variables.get(name);
  if (
    existing &&
    existing.declarationNode !== info.declarationNode &&
    isSequentialNestedShadow(existing.declarationNode, info.declarationNode) &&
    !(existing.isUsing && info.isUsing) &&
    !ctx.raceVars.has(name)
  ) {
    ctx.diagnostics.add(ProcessErrorCode.ShadowedHandlerLocal, info.declarationNode, name);
  }
  ctx.variables.set(name, info);
}

/**
 * Return true when `inner` is declared in a Block / for-loop body that is
 * a descendant of `outer`'s enclosing scope WITHOUT a branch boundary
 * (IfStatement, ConditionalExpression, CaseClause, DefaultClause) between
 * them. Such a shadow runs sequentially on the same execution path —
 * `state.vars.{name}` gets overwritten in place.
 *
 * Returns false when inner and outer are in mutually-exclusive sibling
 * branches; both write the same slot but only one runs per execution.
 */
function isSequentialNestedShadow(outer: ts.Node, inner: ts.Node): ts.Node | boolean {
  // Find each declaration's enclosing scope (Block or function body).
  const outerScope = enclosingScope(outer);
  if (!outerScope) return false;

  // Walk inner's ancestors. If we reach outerScope without crossing a
  // branch boundary, it's a sequential nested shadow.
  let cur: ts.Node | undefined = inner.parent;
  while (cur) {
    if (cur === outerScope) return true;
    if (
      ts.isIfStatement(cur) ||
      ts.isConditionalExpression(cur) ||
      ts.isCaseClause(cur) ||
      ts.isDefaultClause(cur)
    ) {
      return false;
    }
    cur = cur.parent;
  }
  return false;
}

function enclosingScope(node: ts.Node): ts.Node | undefined {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (
      ts.isBlock(cur) ||
      ts.isSourceFile(cur) ||
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur)
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return undefined;
}

/**
 * Analyze a process handler function.
 */
export function analyzeHandler(
  handler: ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration,
  typeChecker: ts.TypeChecker
): AnalysisResult {
  // Check if the handler is a generator function
  // Arrow functions cannot be generators, so we only check FunctionExpression and MethodDeclaration
  const isGenerator =
    (ts.isFunctionExpression(handler) || ts.isMethodDeclaration(handler)) &&
    handler.asteriskToken !== undefined;

  // TSP1004: Check if handler is async
  const isAsync = hasAsyncModifier(handler);
  const diagnostics = new DiagnosticCollector();
  if (!isAsync) {
    diagnostics.add(ProcessErrorCode.HandlerNotAsync, handler);
  }

  const ctx: AnalyzerContext = {
    typeChecker,
    opcodes: [],
    opcodeSourceNodes: [],
    raceBranchSourceNodes: new Map(),
    blocks: [],
    rehydrationBlocks: {},
    signals: {},
    variables: new Map(),
    raceVars: new Set(),
    diagnostics, // Use the diagnostics collector we created above
    currentBlockStatements: [],
    currentBlockUses: new Set(),
    labelTargets: new Map(),
    pendingLabelPatches: [],
    scopeStack: [],
    nextScopeId: 0,
    loopStack: [],
    inRaceBranch: false,
    nestedSwitchDepth: 0,
    nextLoopId: 0,
    nextParallelId: 0,
    innerFunctions: new Map(),
    inliningStack: [],
    maxInliningDepth: 10,
    isGenerator,
    yields: [],
    nextScopeBlockId: 0,
    subprocesses: [],
  };

  // Get the handler body
  const body = handler.body;
  if (!body) {
    return emptyResult();
  }

  if (ts.isBlock(body)) {
    analyzeStatements(body.statements, ctx);
  } else {
    // Arrow function with expression body
    analyzeExpression(body, ctx);
  }

  // Flush any remaining block
  flushBlock(ctx);

  // TSP1011: Check if any registered inner functions escape their scope
  if (ts.isBlock(body)) {
    for (const [name, info] of ctx.innerFunctions) {
      if (info.hasSuspension && checkFunctionEscapes(name, body.statements)) {
        ctx.diagnostics.add(ProcessErrorCode.FunctionEscapesScope, info.node);
      }
    }
  }

  // Patch label references
  patchLabels(ctx);

  return {
    opcodes: ctx.opcodes,
    opcodeSourceNodes: ctx.opcodeSourceNodes,
    raceBranchSourceNodes: ctx.raceBranchSourceNodes,
    blocks: ctx.blocks,
    rehydrationBlocks: ctx.rehydrationBlocks,
    signals: ctx.signals,
    variables: ctx.variables,
    raceVars: ctx.raceVars,
    diagnostics: ctx.diagnostics.getAll(),
    isGenerator: ctx.isGenerator,
    yields: ctx.yields,
    exports: ctx.exports,
    subprocesses: ctx.subprocesses,
  };
}

function emptyResult(): AnalysisResult {
  return {
    opcodes: [],
    opcodeSourceNodes: [],
    raceBranchSourceNodes: new Map(),
    blocks: [],
    rehydrationBlocks: {},
    signals: {},
    variables: new Map(),
    raceVars: new Set(),
    diagnostics: [],
    isGenerator: false,
    yields: [],
    subprocesses: [],
  };
}

/**
 * Analyze a list of statements.
 */
function analyzeStatements(
  statements: ts.NodeArray<ts.Statement> | ts.Statement[],
  ctx: AnalyzerContext
): void {
  for (const stmt of statements) {
    analyzeStatement(stmt, ctx);
  }
}

/**
 * Analyze a single statement.
 */
function analyzeStatement(stmt: ts.Statement, ctx: AnalyzerContext): void {
  // Variable declaration
  if (ts.isVariableStatement(stmt)) {
    analyzeVariableStatement(stmt, ctx);
    return;
  }

  // Expression statement (might contain await)
  if (ts.isExpressionStatement(stmt)) {
    // TSP1002: Check for signal() or delay() not awaited
    const unawaitedPrimitive = findUnawaitedPrimitive(stmt.expression, ctx);
    if (unawaitedPrimitive) {
      ctx.diagnostics.add(ProcessErrorCode.SignalNotAwaited, stmt, unawaitedPrimitive);
    }

    // TSP1005: Check for non-deterministic operations
    checkForNonDeterministicOps(stmt.expression, ctx);

    // TSP1008: Check for nested async functions with suspension passed as arguments
    checkForNestedAsyncWithSuspension(stmt.expression, ctx);

    // Check for direct suspension points OR inner function calls
    if (containsSuspension(stmt.expression, ctx) || containsInnerFunctionCall(stmt.expression, ctx)) {
      flushBlock(ctx);
      analyzeExpression(stmt.expression, ctx);
    } else {
      ctx.currentBlockStatements.push(stmt);
      trackUsedVariables(stmt, ctx);
    }
    return;
  }

  // Return statement
  if (ts.isReturnStatement(stmt)) {
    flushBlock(ctx);

    // TSP1005: Check for non-deterministic operations in the return expression
    if (stmt.expression) {
      checkForNonDeterministicOps(stmt.expression, ctx);
    }

    if (stmt.expression && containsSuspension(stmt.expression, ctx)) {
      analyzeExpression(stmt.expression, ctx);
    }

    // Create a block to evaluate the return value (or undefined for empty return)
    // The block executes the return statement which returns the value
    const blockId = createBlock(ctx, [stmt]);
    emitOpcode(ctx, { op: 'BLOCK', blockId }, stmt);

    // RETURN opcode signals process completion (block result is the return value)
    emitOpcode(ctx, { op: 'RETURN', value: undefined }, stmt);
    return;
  }

  // While loop
  if (ts.isWhileStatement(stmt)) {
    analyzeWhileStatement(stmt, ctx);
    return;
  }

  // Do-while loop - reject suspension points
  if (ts.isDoStatement(stmt)) {
    const hasSuspension = containsSuspensionInStatement(stmt.statement, ctx)
      || containsSuspension(stmt.expression, ctx);
    if (hasSuspension) {
      ctx.diagnostics.add(ProcessErrorCode.DoWhileWithSuspension, stmt);
    }
    ctx.currentBlockStatements.push(stmt);
    trackUsedVariables(stmt, ctx);
    return;
  }

  // If statement
  if (ts.isIfStatement(stmt)) {
    analyzeIfStatement(stmt, ctx);
    return;
  }

  // Switch statement (might be a race)
  if (ts.isSwitchStatement(stmt)) {
    analyzeSwitchStatement(stmt, ctx);
    return;
  }

  // Try statement - check for suspension points (not supported)
  if (ts.isTryStatement(stmt)) {
    if (containsSuspensionInBlock(stmt.tryBlock, ctx)) {
      ctx.diagnostics.add(ProcessErrorCode.TryCatchWithSuspension, stmt);
    }
    // Still add to block (will fail at runtime but compile for better error messages)
    ctx.currentBlockStatements.push(stmt);
    trackUsedVariables(stmt, ctx);
    return;
  }

  // For-of statement - support durable iteration with suspension points
  if (ts.isForOfStatement(stmt)) {
    const hasSuspension = containsSuspensionInStatement(stmt.statement, ctx);

    if (hasSuspension) {
      // TSP3001/TSP3002: Validate durable iterator if the iterable has the brand
      checkDurableIteratorType(stmt.expression, ctx);

      // Durable iteration: generate ITER_* opcodes
      const loopId = ctx.nextLoopId++;
      const cursorVar = `__cursor_${loopId}`;

      // Extract the loop variable name and check if it needs `using`.
      // The binding spans the entire body; if the body suspends (which it does
      // here, by definition - hasSuspension is true), a non-JSON item type
      // cannot be rehydrated from `const`.
      let itemVar = '__item';
      let itemIsUsing = false;
      let itemIsSerializable = true;
      if (ts.isVariableDeclarationList(stmt.initializer)) {
        const decl = stmt.initializer.declarations[0];
        if (ts.isIdentifier(decl.name)) {
          itemVar = decl.name.text;
        }
        itemIsUsing = (stmt.initializer.flags & ts.NodeFlags.Using) !== 0;
        // Only flag when we have enough type information to prove non-JSON.
        // With `any`/`unknown`, the type checker has nothing to say - stay silent.
        if (
          !itemIsUsing &&
          !hasNoTypeInformation(decl, ctx.typeChecker) &&
          !isJsonSerializable(decl, ctx.typeChecker)
        ) {
          ctx.diagnostics.add(ProcessErrorCode.NonSerializableConst, decl, itemVar);
        }
        itemIsSerializable = isSerializableType(decl, ctx.typeChecker);
      }

      // Flush any pending block before the loop
      flushBlock(ctx);

      // Generate loop start label
      const startLabelName = `__loop_${loopId}_start`;
      const endLabelName = `__loop_${loopId}_end`;

      // LABEL for loop start (for continue)
      ctx.labelTargets.set(startLabelName, ctx.opcodes.length);
      emitOpcode(ctx, { op: 'LABEL', label: startLabelName }, stmt);

      // ITER_START - initializes iterator, sets up cursor var
      emitOpcode(ctx, {
        op: 'ITER_START',
        iterableExpr: stmt.expression,
        cursorVar,
        itemVar,
        loopId,
      }, stmt);

      // ITER_NEXT - fetches next item, jumps to done if exhausted
      const iterNextOpcode: Opcode = {
        op: 'ITER_NEXT',
        cursorVar,
        doneTarget: -1, // Will be patched
        loopId,
      };
      emitOpcode(ctx, iterNextOpcode, stmt);

      // Push loop onto stack for break/continue handling
      ctx.loopStack.push({ startLabel: startLabelName, endLabel: endLabelName });

      // Track the item variable
      ctx.variables.set(itemVar, {
        name: itemVar,
        isUsing: itemIsUsing,
        isSerializable: itemIsSerializable,
        declarationNode: stmt.initializer,
        usedInBlocks: [],
      });

      // ITER_SAVE - save cursor before any suspension points in loop body
      emitOpcode(ctx, { op: 'ITER_SAVE', cursorVar, loopId }, stmt.statement);

      // Analyze the loop body
      analyzeStatement(stmt.statement, ctx);

      // Flush loop body block
      flushBlock(ctx);

      // Jump back to start
      emitOpcode(ctx, { op: 'JUMP', target: ctx.labelTargets.get(startLabelName)! }, stmt);

      // Pop loop from stack
      ctx.loopStack.pop();

      // LABEL for loop end (for break and done)
      ctx.labelTargets.set(endLabelName, ctx.opcodes.length);
      emitOpcode(ctx, { op: 'LABEL', label: endLabelName }, stmt)

      // Patch the ITER_NEXT doneTarget
      ;(iterNextOpcode as { doneTarget: number }).doneTarget = ctx.labelTargets.get(endLabelName)!;

      return;
    }

    // No suspension - add to block as regular statement
    ctx.currentBlockStatements.push(stmt);
    trackUsedVariables(stmt, ctx);
    return;
  }

  // For-in statement - check for suspension points
  if (ts.isForInStatement(stmt)) {
    if (containsSuspensionInStatement(stmt.statement, ctx)) {
      ctx.diagnostics.add(ProcessErrorCode.ForInWithSuspension, stmt);
    }
    ctx.currentBlockStatements.push(stmt);
    trackUsedVariables(stmt, ctx);
    return;
  }

  // Regular for statement - reject suspension points
  if (ts.isForStatement(stmt)) {
    const hasSuspension = containsSuspensionInStatement(stmt.statement, ctx);

    if (hasSuspension) {
      ctx.diagnostics.add(ProcessErrorCode.ForWithSuspension, stmt);
    }

    // Add to block as regular statement (no durable support for classic for)
    ctx.currentBlockStatements.push(stmt);
    trackUsedVariables(stmt, ctx);
    return;
  }

  // Labeled statement (for break/continue targets and observability)
  if (ts.isLabeledStatement(stmt)) {
    const labelName = stmt.label.text;
    flushBlock(ctx);

    // LABEL opcode for jump targets (break/continue)
    ctx.labelTargets.set(labelName, ctx.opcodes.length);
    emitOpcode(ctx, { op: 'LABEL', label: labelName }, stmt);

    // LABEL_ENTER for observability tracking
    emitOpcode(ctx, { op: 'LABEL_ENTER', label: labelName }, stmt);

    // Analyze the inner statement
    analyzeStatement(stmt.statement, ctx);

    // Flush before exit
    flushBlock(ctx);

    // LABEL_EXIT for observability tracking
    emitOpcode(ctx, { op: 'LABEL_EXIT', label: labelName }, stmt);
    return;
  }

  // Break statement
  if (ts.isBreakStatement(stmt)) {
    flushBlock(ctx);
    const label = stmt.label?.text;
    if (label) {
      // Labeled break - jump to the named label
      const jumpOp: Opcode = { op: 'JUMP', target: -1 };
      ctx.pendingLabelPatches.push({ opcode: jumpOp, label, field: 'target' });
      emitOpcode(ctx, jumpOp, stmt);
    } else if (ctx.inRaceBranch && ctx.nestedSwitchDepth === 0) {
      // Unlabeled break inside race switch (not nested switch) - don't emit JUMP.
      // The case's nextStep will handle continuation to the loop-back step.
      // This is equivalent to the switch case ending normally.
      // Note: breaks in nested switches are added to the block as normal statements.
    } else if (ctx.loopStack.length > 0) {
      // Unlabeled break in a loop - jump to current loop end
      const currentLoop = ctx.loopStack[ctx.loopStack.length - 1];
      const jumpOp: Opcode = { op: 'JUMP', target: -1 };
      ctx.pendingLabelPatches.push({ opcode: jumpOp, label: currentLoop.endLabel, field: 'target' });
      emitOpcode(ctx, jumpOp, stmt);
    }
    return;
  }

  // Continue statement
  if (ts.isContinueStatement(stmt)) {
    flushBlock(ctx);
    const label = stmt.label?.text;
    if (label) {
      const jumpOp: Opcode = { op: 'JUMP', target: -1 };
      ctx.pendingLabelPatches.push({ opcode: jumpOp, label, field: 'target' });
      emitOpcode(ctx, jumpOp, stmt);
    } else if (ctx.loopStack.length > 0) {
      // Unlabeled continue - jump to current loop start
      const currentLoop = ctx.loopStack[ctx.loopStack.length - 1];
      const jumpOp: Opcode = { op: 'JUMP', target: -1 };
      ctx.pendingLabelPatches.push({ opcode: jumpOp, label: currentLoop.startLabel, field: 'target' });
      emitOpcode(ctx, jumpOp, stmt);
    }
    return;
  }

  // TSP3004: Throw statement - not allowed in process handlers
  if (ts.isThrowStatement(stmt)) {
    ctx.diagnostics.add(ProcessErrorCode.ThrowNotAllowed, stmt);
    // Still add to block for better error messages
    ctx.currentBlockStatements.push(stmt);
    return;
  }

  // Block statement
  if (ts.isBlock(stmt)) {
    ctx.scopeStack.push(ctx.nextScopeId++);
    emitOpcode(ctx, { op: 'SCOPE_ENTER', scopeId: ctx.scopeStack[ctx.scopeStack.length - 1] }, stmt);
    analyzeStatements(stmt.statements, ctx);
    flushBlock(ctx);
    emitOpcode(ctx, { op: 'SCOPE_EXIT', scopeId: ctx.scopeStack.pop()! }, stmt);
    return;
  }

  // Function declaration - register inner functions with suspension points
  if (ts.isFunctionDeclaration(stmt)) {
    const isAsync = stmt.modifiers?.some(mod => mod.kind === ts.SyntaxKind.AsyncKeyword) ?? false;

    if (isAsync && stmt.name && stmt.body) {
      const hasSuspension = containsSuspensionInBlock(stmt.body, ctx);

      if (hasSuspension) {
        const funcName = stmt.name.text;
        // Register the inner function for potential inlining
        registerInnerFunction(funcName, stmt, ctx);

        // Track as a variable (for reference tracking)
        ctx.variables.set(funcName, {
          name: funcName,
          isUsing: false,
          isSerializable: false,
          declarationNode: stmt,
          usedInBlocks: [],
        });

        // Don't add to block statements - function will be inlined at call site
        return;
      }
    }

    // Non-async or no suspension points - add to block as-is
    ctx.currentBlockStatements.push(stmt);
    trackUsedVariables(stmt, ctx);
    return;
  }

  // Default: add to current block
  ctx.currentBlockStatements.push(stmt);
  trackUsedVariables(stmt, ctx);
}

/**
 * Analyze a variable statement (const/let/using).
 */
function analyzeVariableStatement(stmt: ts.VariableStatement, ctx: AnalyzerContext): void {
  const declarations = stmt.declarationList.declarations;

  for (const decl of declarations) {
    const initializer = decl.initializer;

    // Check for Promise.all/Promise.race with signals (handles both simple and destructuring patterns)
    if (initializer && ts.isAwaitExpression(initializer)) {
      const promiseCombinator = checkPromiseCombinatorWithSignals(initializer.expression, ctx);
      if (promiseCombinator) {
        ctx.diagnostics.add(ProcessErrorCode.PromiseCombinatorWithSignal, initializer, promiseCombinator);
      }
    }

    // TSP1005: Check for non-deterministic operations in initializer
    if (initializer) {
      checkForNonDeterministicOps(initializer, ctx);
    }

    // Check for inner async function with suspension points - register for inlining
    if (
      initializer &&
      ts.isIdentifier(decl.name) &&
      (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
    ) {
      const isAsync =
        initializer.modifiers?.some(mod => mod.kind === ts.SyntaxKind.AsyncKeyword) ?? false;

      if (isAsync) {
        const hasSuspension = ts.isBlock(initializer.body)
          ? containsSuspensionInBlock(initializer.body, ctx)
          : containsSuspension(initializer.body, ctx);

        if (hasSuspension) {
          const funcName = decl.name.text;
          // Register the inner function for potential inlining
          registerInnerFunction(funcName, initializer, ctx);

          // Track as a variable (for reference tracking)
          ctx.variables.set(funcName, {
            name: funcName,
            isUsing: false,
            isSerializable: false,
            declarationNode: decl,
            usedInBlocks: [],
          });

          // Don't add to block statements - function will be inlined at call site
          continue;
        }
      }
    }

    // Check for createSubProcess({ name, path, handler }) declarations
    if (
      initializer &&
      ts.isIdentifier(decl.name) &&
      ts.isCallExpression(initializer) &&
      ts.isIdentifier(initializer.expression) &&
      initializer.expression.text === 'createSubProcess'
    ) {
      const subInfo = extractSubProcessInfo(initializer, decl.name.text, ctx);
      if (subInfo) {
        ctx.subprocesses.push(subInfo);

        // Track the subprocess variable name so call sites can reference it
        ctx.variables.set(decl.name.text, {
          name: decl.name.text,
          isUsing: false,
          isSerializable: false,
          declarationNode: decl,
          usedInBlocks: [],
        });

        // Don't add to block statements - subprocess is compiled separately
        continue;
      }
    }

    // Handle destructuring patterns - both primitive-suspension and service-call await paths.
    if (!ts.isIdentifier(decl.name)) {
      // Detect `const { a, b } = await svc.x()` / `const [a, b] = await svc.x()`.
      // Must be an await on a plain service call - NOT a signal combinator (signal.all)
      // or a scope call, which have their own dedicated emit paths in analyzeAwaitExpression.
      const isDestructureServiceAwait = (() => {
        if (!initializer || !ts.isAwaitExpression(initializer)) return false;
        if (!(ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name))) return false;
        const inner = initializer.expression;
        if (!ts.isCallExpression(inner)) return false;
        if (isWaitForCall(inner, ctx) || isDelayCall(inner, ctx) || isRaceCall(inner, ctx)) return false;
        if (isSignalCombinatorCall(inner, ctx)) return false;
        if (isScopeCall(inner, ctx)) return false;
        return true;
      })();

      if (isDestructureServiceAwait) {
        // `const { a, b } = await svc.x()` or `const [a, b] = await svc.x()` inside
        // a race branch. Without special handling the entire await call is dropped and
        // every destructured name stays undefined.
        //
        // Strategy: emit a BLOCK whose body is:
        //   __blockResult = await svc.x()
        //   a = __blockResult.a   // object: property access
        //   a = __blockResult[0]  // array: index access
        // Because a/b are registered in ctx.variables (and therefore in localVars),
        // the rewriter turns `a = __blockResult.a` into
        // `state.vars.a = __blockResult.a` - exactly what we need.
        flushBlock(ctx);

        const bindingPattern = decl.name as ts.ObjectBindingPattern | ts.ArrayBindingPattern;
        const isObject = ts.isObjectBindingPattern(bindingPattern);

        // Build the synthetic `__blockResult = await svc.x()` statement.
        const syntheticAssignment = ts.factory.createExpressionStatement(
          ts.factory.createBinaryExpression(
            ts.factory.createIdentifier('__blockResult'),
            ts.factory.createToken(ts.SyntaxKind.EqualsToken),
            initializer!,
          ),
        );
        ts.setTextRange(syntheticAssignment, initializer!);

        // Build per-name extract statements and register each name.
        const extractStatements: ts.Statement[] = [];
        const elements = bindingPattern.elements;
        for (let idx = 0; idx < elements.length; idx++) {
          const elem = elements[idx] as ts.BindingElement;
          if (ts.isOmittedExpression(elem as ts.Node)) continue;
          if (!ts.isIdentifier(elem.name)) continue; // skip nested patterns (deferred)

          const localName = elem.name.text;

          // Determine the access expression for this element:
          //   object: __blockResult['propName']  (string-literal bracket access avoids
          //           the rewriter mis-treating the prop identifier as a localVar)
          //   array:  __blockResult[idx]
          let accessExpr: ts.Expression;
          if (isObject) {
            const propName = elem.propertyName
              ? (ts.isIdentifier(elem.propertyName) ? elem.propertyName.text : localName)
              : localName;
            // Use bracket notation with a string literal so the rewriter never
            // mistakes the property name for a localVar and double-rewrites it.
            accessExpr = ts.factory.createElementAccessExpression(
              ts.factory.createIdentifier('__blockResult'),
              ts.factory.createStringLiteral(propName),
            );
          } else {
            accessExpr = ts.factory.createElementAccessExpression(
              ts.factory.createIdentifier('__blockResult'),
              ts.factory.createNumericLiteral(idx),
            );
          }

          // `localName = accessExpr` - the rewriter will turn localName -> state.vars.localName
          extractStatements.push(
            ts.factory.createExpressionStatement(
              ts.factory.createBinaryExpression(
                ts.factory.createIdentifier(localName),
                ts.factory.createToken(ts.SyntaxKind.EqualsToken),
                accessExpr,
              ),
            ),
          );

          // Register in ctx.variables so the rewriter includes the name in localVars.
          ctx.variables.set(localName, {
            name: localName,
            isUsing: false,
            isSerializable: true,
            declarationNode: decl,
            usedInBlocks: [],
          });
        }

        // Collect using-var dependencies from the await expression.
        trackUsedVariables(syntheticAssignment, ctx);
        const blockUses = Array.from(ctx.currentBlockUses);
        ctx.currentBlockUses = new Set();

        const blockStatements = [syntheticAssignment, ...extractStatements];
        const blockId = createBlock(ctx, blockStatements, blockUses);

        emitOpcode(ctx, { op: 'BLOCK', blockId }, initializer!);
        // No STORE: each name's assignment is inlined in the block body itself.
        continue;
      }

      // Destructuring pattern: const { a, b } = await signal(...)
      if (initializer && containsSuspension(initializer, ctx)) {
        flushBlock(ctx);
        // Generate temp variable name for the awaited result
        const tempVar = `__destructure_${ctx.nextScopeId++}`;
        analyzeAwaitExpression(initializer, tempVar, ctx);
      }
      continue;
    }
    const varName = decl.name.text;

    // Check if this is a `using` declaration
    const isUsing = (stmt.declarationList.flags & ts.NodeFlags.Using) !== 0;

    // Early exit: `const alice = await child('alice')` where `child` is a
    // subprocess variable. The result SubRef is JSON-serializable so neither
    // hasSuspension nor the !isJsonSerializable guard would catch it - we
    // must intercept here before the statement lands in a regular BLOCK.
    if (initializer && ts.isAwaitExpression(initializer)) {
      const inner = initializer.expression;
      if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression)) {
        const calleeName = inner.expression.text;
        if (ctx.subprocesses.find(s => s.varName === calleeName)) {
          flushBlock(ctx);
          trySubprocessSpawn(inner, varName, ctx, true);
          registerVariable(ctx, varName, {
            name: varName,
            isUsing: false,
            isSerializable: true,
            declarationNode: decl,
            usedInBlocks: [],
          });
          continue;
        }
      }
    }

    // Check if initializer contains a suspension point
    const hasSuspension = initializer && containsSuspension(initializer, ctx);

    // Check if initializer is an await on a service call (not signal/delay)
    const isServiceAwait = initializer && isAwaitOnServiceCall(initializer, ctx);

    if (varName === 'exports' && initializer && ts.isObjectLiteralExpression(initializer)) {
      // `[const|using] exports = { ... }` - process exports declaration
      // This is a regular persisted var, NOT a using/rehydration var.
      // The rewriter transforms exports.foo -> state.vars.exports.foo like any other local var.
      const fields: ExportFieldInfo[] = [];
      const methods: ExportMethodInfo[] = [];

      for (const prop of initializer.properties) {
        if (ts.isMethodDeclaration(prop) && ts.isIdentifier(prop.name)) {
          methods.push({ name: prop.name.text, node: prop });
        } else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
          if (prop.initializer && (ts.isArrowFunction(prop.initializer) || ts.isFunctionExpression(prop.initializer))) {
            methods.push({ name: prop.name.text, node: prop });
          } else {
            fields.push({ name: prop.name.text, node: prop });
          }
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          fields.push({ name: prop.name.text, node: prop });
        }
      }

      ctx.exports = { fields, methods, declarationNode: decl };

      // Track as a regular serializable variable - NOT isUsing, NOT rehydration
      registerVariable(ctx, varName, {
        name: varName,
        isUsing: false,
        isSerializable: true,
        declarationNode: decl,
        usedInBlocks: [],
      });

      // Add the statement to the current block - it's a normal variable assignment
      ctx.currentBlockStatements.push(stmt);
      trackUsedVariables(stmt, ctx);
    } else if (isUsing && initializer) {
      // `using` declarations become rehydration blocks
      flushBlock(ctx);

      // Track the variable
      registerVariable(ctx, varName, {
        name: varName,
        isUsing: true,
        isSerializable: false,
        declarationNode: decl,
        usedInBlocks: [],
      });

      // Create rehydration block
      ctx.rehydrationBlocks[varName] = {
        deps: extractDependencies(initializer, ctx),
        expression: initializer,
      };

      // Emit REHYDRATE opcode (carries the expression so each opcode site has its own
      // initializer independent of the global rehydrationBlocks map)
      emitOpcode(ctx, { op: 'REHYDRATE', var: varName, blockId: varName, expression: initializer }, stmt);
    } else if (isServiceAwait && !isUsing && !isJsonSerializable(decl, ctx.typeChecker)) {
      // Awaited service call returning a non-JSON value. It only *needs* `using`
      // if the value must survive a suspension (signal/delay/race/yield). When
      // the variable is never read after any suspension in its enclosing scope,
      // `const` is safe - the value lives entirely within one continuation.
      if (isVarReadAfterSuspension(decl, varName, ctx)) {
        ctx.diagnostics.add(ProcessErrorCode.NonSerializableConst, decl, varName);
      }

      // Still process it so we can continue analyzing
      flushBlock(ctx);
      analyzeAwaitExpression(initializer!, varName, ctx);

      // Track the variable for rewriting in subsequent blocks
      registerVariable(ctx, varName, {
        name: varName,
        isUsing: false,
        isSerializable: isSerializableType(decl, ctx.typeChecker),
        declarationNode: decl,
        usedInBlocks: [],
      });
    } else if (hasSuspension && initializer) {
      // Suspending initializer (e.g., const x = await signal(...))
      flushBlock(ctx);
      analyzeAwaitExpression(initializer, varName, ctx);

      // Track the variable for rewriting in subsequent blocks
      registerVariable(ctx, varName, {
        name: varName,
        isUsing: false,
        isSerializable: isSerializableType(decl, ctx.typeChecker),
        declarationNode: decl,
        usedInBlocks: [],
      });
    } else {
      // Check for invalid pattern: storing signal/delay in a variable
      // e.g., const s = signal(orders.paid) - should be: await signal(...)
      if (initializer && isStoredSignalOrDelay(initializer)) {
        const funcName = getSignalOrDelayName(initializer);
        ctx.diagnostics.add(ProcessErrorCode.SignalStoredInVariable, decl, funcName);
      }

      // Regular variable - add to current block
      ctx.currentBlockStatements.push(stmt);
      trackUsedVariables(stmt, ctx);

      registerVariable(ctx, varName, {
        name: varName,
        isUsing: false,
        isSerializable: isSerializableType(decl, ctx.typeChecker),
        declarationNode: decl,
        usedInBlocks: [],
      });
    }
  }
}

/**
 * Check if expression is a direct signal() or delay.xxx() call (not awaited, not race).
 * These must be used directly with await or in switch cases, not stored.
 */
function isStoredSignalOrDelay(expr: ts.Expression): boolean {
  if (!ts.isCallExpression(expr)) return false;

  const callExpr = expr.expression;

  // Check for direct identifier: signal(...)
  if (ts.isIdentifier(callExpr)) {
    const name = callExpr.text;
    // signal() should not be stored - race() is allowed
    return name === 'signal';
  }

  // Check for property access: delay.minutes(...), delay.hours(...), etc.
  if (ts.isPropertyAccessExpression(callExpr)) {
    const obj = callExpr.expression;
    if (ts.isIdentifier(obj) && obj.text === 'delay') {
      const methodName = callExpr.name.text;
      return ['seconds', 'minutes', 'hours', 'days'].includes(methodName);
    }
  }

  return false;
}

/**
 * Get the function name from a signal/delay call for error messages.
 */
function getSignalOrDelayName(expr: ts.Expression): string {
  if (ts.isCallExpression(expr)) {
    const callExpr = expr.expression;
    if (ts.isIdentifier(callExpr)) {
      return callExpr.text;
    }
    // Handle delay.minutes(), delay.hours(), etc.
    if (ts.isPropertyAccessExpression(callExpr)) {
      const obj = callExpr.expression;
      if (ts.isIdentifier(obj) && obj.text === 'delay') {
        return `delay.${callExpr.name.text}`;
      }
    }
  }
  return 'signal';
}

/**
 * Check if an expression is an await on a service call (not signal/delay/race).
 * Service calls return non-serializable objects that need rehydration.
 */
function isAwaitOnServiceCall(expr: ts.Expression, ctx: AnalyzerContext): boolean {
  if (!ts.isAwaitExpression(expr)) return false;

  const inner = expr.expression;
  if (!ts.isCallExpression(inner)) return false;

  // If it's signal/waitFor/delay/race, it's not a service call
  if (isWaitForCall(inner, ctx) || isDelayCall(inner, ctx) || isRaceCall(inner, ctx)) {
    return false;
  }

  // It's an await on something that isn't a process primitive - likely a service call
  return true;
}

/**
 * Return the list of statements a container node holds, or undefined if the
 * container isn't a supported statement container.
 */
function getContainerStatements(container: ts.Node | undefined): readonly ts.Statement[] | undefined {
  if (!container) return undefined;
  if (ts.isBlock(container)) return container.statements;
  if (ts.isSourceFile(container)) return container.statements;
  if (ts.isCaseClause(container) || ts.isDefaultClause(container)) return container.statements;
  if (ts.isModuleBlock(container)) return container.statements;
  return undefined;
}

/**
 * Detect whether a switch statement is a race-switch (cases are signal/delay primitives).
 */
function isRaceSwitchNode(node: ts.SwitchStatement, ctx: AnalyzerContext): boolean {
  for (const clause of node.caseBlock.clauses) {
    if (!ts.isCaseClause(clause)) continue;
    const expr = clause.expression;
    if (!ts.isCallExpression(expr)) continue;
    const prim = getPrimitiveCall(expr, ctx.typeChecker);
    if (prim && (prim.kind === 'signal' || prim.kind === 'delay')) return true;
  }
  return false;
}

/**
 * Walk forward lexically from a declaration, tracking whether any suspension
 * point (signal/delay/race/yield) occurs before a subsequent read of the variable.
 *
 * Returns true if at least one read of `varName` happens AFTER a suspension -
 * i.e., the value must survive state serialization and the declaration needs `using`.
 * Returns false if all reads happen before any suspension, meaning the value
 * never crosses a persistence boundary and `const` is safe.
 *
 * Conservative default: returns true when the container shape is unfamiliar
 * (e.g., declaration sits in a ForOfStatement binding) so we keep the strict
 * check for patterns we don't analyze.
 */
function isVarReadAfterSuspension(
  decl: ts.VariableDeclaration,
  varName: string,
  ctx: AnalyzerContext
): boolean {
  // Walk up to the enclosing VariableStatement.
  let stmtNode: ts.Node = decl;
  while (stmtNode.parent && !ts.isVariableStatement(stmtNode)) {
    stmtNode = stmtNode.parent;
  }
  if (!ts.isVariableStatement(stmtNode)) return true;

  const container = stmtNode.parent;
  const siblings = getContainerStatements(container);
  if (!siblings) return true;

  const idx = siblings.indexOf(stmtNode as ts.Statement);
  if (idx < 0) return true;

  let seenSuspension = false;
  let foundRead = false;

  const visit = (node: ts.Node): void => {
    if (foundRead) return;

    // Nested function bodies have their own execution model - skip.
    if (
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionDeclaration(node)
    ) {
      return;
    }

    // Read of our variable?
    if (ts.isIdentifier(node) && node.text === varName) {
      const parent = node.parent;
      const isDeclName =
        (ts.isVariableDeclaration(parent) && parent.name === node) ||
        (ts.isParameter(parent) && parent.name === node) ||
        (ts.isBindingElement(parent) && parent.name === node);
      if (!isDeclName && seenSuspension) {
        foundRead = true;
        return;
      }
    }

    // Race switch: discriminant and case labels run before suspension;
    // case bodies run after.
    if (ts.isSwitchStatement(node) && isRaceSwitchNode(node, ctx)) {
      visit(node.expression);
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause)) visit(clause.expression);
      }
      seenSuspension = true;
      for (const clause of node.caseBlock.clauses) {
        for (const s of clause.statements) visit(s);
      }
      return;
    }

    // Detect whether this node is itself a suspension point.
    // Children are evaluated before the suspension effect, so visit them first.
    let suspends = false;
    if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression)) {
      const prim = getPrimitiveCall(node.expression, ctx.typeChecker);
      if (prim && (prim.kind === 'signal' || prim.kind === 'delay')) {
        suspends = true;
      }
    }
    if (ts.isYieldExpression(node)) suspends = true;

    ts.forEachChild(node, visit);

    if (suspends) seenSuspension = true;
  };

  for (let i = idx + 1; i < siblings.length; i++) {
    visit(siblings[i]);
    if (foundRead) return true;
  }

  return false;
}

/**
 * Analyze an expression that might contain suspension points.
 */
function analyzeExpression(expr: ts.Expression, ctx: AnalyzerContext): void {
  if (ts.isAwaitExpression(expr)) {
    analyzeAwaitExpression(expr, undefined, ctx);
    return;
  }

  if (ts.isYieldExpression(expr)) {
    analyzeYieldExpression(expr, ctx);
    return;
  }

  if (ts.isCallExpression(expr)) {
    // Check for race() call
    if (isRaceCall(expr, ctx)) {
      // Race is handled at the switch statement level
      return;
    }
  }

  // Non-suspending expression - should have been caught earlier
}

/**
 * Analyze a yield expression.
 * Yields emit events without suspending the process.
 */
function analyzeYieldExpression(expr: ts.YieldExpression, ctx: AnalyzerContext): void {
  // Check if we're in a generator context
  if (!ctx.isGenerator) {
    ctx.diagnostics.add(ProcessErrorCode.YieldInNonGenerator, expr);
    return;
  }

  // Get the yielded value expression (or undefined for bare yield)
  const valueExpr = expr.expression;

  if (valueExpr) {
    // Track the yield for type extraction
    ctx.yields.push(valueExpr);

    // Emit YIELD_EMIT opcode - this doesn't suspend, just emits an event
    emitOpcode(ctx, { op: 'YIELD_EMIT', valueExpr }, expr);
  }
  // Note: bare `yield;` without a value is unusual but valid - we just skip it
}

/**
 * Analyze an await expression.
 */
function analyzeAwaitExpression(
  expr: ts.Expression,
  storeVar: string | undefined,
  ctx: AnalyzerContext
): void {
  // Unwrap AwaitExpression
  let inner = expr;
  if (ts.isAwaitExpression(expr)) {
    inner = expr.expression;
  }

  // Check for waitFor(signal) - direct call
  if (ts.isCallExpression(inner) && isWaitForCall(inner, ctx)) {
    const signalArg = inner.arguments[0];
    const signalInfo = extractSignalInfo(signalArg, ctx);

    if (signalInfo) {
      // Get rehydration deps for this wait point
      const rehydrateDeps = getRehydrationDepsAtPoint(ctx);

      emitOpcode(ctx, {
        op: 'WAIT',
        signal: signalInfo.signalName,
        signalExpr: signalArg,
        rehydrate: rehydrateDeps.length > 0 ? rehydrateDeps : undefined,
      }, expr);

      ctx.signals[signalInfo.signalName] = {
        identity: signalInfo.identity,
        payloadType: signalInfo.payloadType,
      };

      if (storeVar) {
        emitOpcode(ctx, { op: 'STORE', var: storeVar, fromSignal: true }, expr);
      }
    }
    return;
  }

  // Check for delay(duration) - direct call
  if (ts.isCallExpression(inner) && isDelayCall(inner, ctx)) {
    const rehydrateDeps = getRehydrationDepsAtPoint(ctx);
    const delayInfo = extractDelayInfo(inner);

    emitOpcode(ctx, {
      op: 'WAIT',
      signal: '__timer__',
      timer: delayInfo ? { unit: delayInfo.unit, valueExpr: delayInfo.valueExpr } : undefined,
      rehydrate: rehydrateDeps.length > 0 ? rehydrateDeps : undefined,
    }, expr);

    if (storeVar) {
      emitOpcode(ctx, { op: 'STORE', var: storeVar, fromSignal: true }, expr);
    }
    return;
  }

  // Check for signal.all([...]) or signal.all({...}) or signal.settled([...])
  if (ts.isCallExpression(inner) && isSignalCombinatorCall(inner, ctx)) {
    analyzeSignalCombinator(inner, storeVar, ctx);
    return;
  }

  // Check for scope(entities, handler) or scope(signal, entities)
  if (ts.isCallExpression(inner) && isScopeCall(inner, ctx)) {
    analyzeScopeCall(inner, storeVar, ctx);
    return;
  }

  // Check for nested suspension points in complex expressions
  // e.g., (await signal(svc.check)).status === 'paid'
  const suspensions = findSuspensionPoints(expr, ctx.typeChecker);
  if (suspensions.length > 0) {
    // Emit WAIT for each suspension point
    for (let i = 0; i < suspensions.length; i++) {
      const suspension = suspensions[i];
      const primitive = suspension.primitive;

      if (primitive.kind === 'signal') {
        const signalArg = primitive.node.arguments[0];
        const signalInfo = extractSignalInfo(signalArg, ctx);

        if (signalInfo) {
          const rehydrateDeps = getRehydrationDepsAtPoint(ctx);
          emitOpcode(ctx, {
            op: 'WAIT',
            signal: signalInfo.signalName,
            signalExpr: signalArg,
            rehydrate: rehydrateDeps.length > 0 ? rehydrateDeps : undefined,
          }, primitive.node);

          ctx.signals[signalInfo.signalName] = {
            identity: signalInfo.identity,
            payloadType: signalInfo.payloadType,
          };

          // Store intermediate result
          const tempVar = `__await_${ctx.nextScopeId++}`;
          emitOpcode(ctx, { op: 'STORE', var: tempVar, fromSignal: true }, primitive.node);
        }
      } else if (primitive.kind === 'delay') {
        const rehydrateDeps = getRehydrationDepsAtPoint(ctx);
        const delayInfo = extractDelayInfo(primitive.node);
        emitOpcode(ctx, {
          op: 'WAIT',
          signal: '__timer__',
          timer: delayInfo ? { unit: delayInfo.unit, valueExpr: delayInfo.valueExpr } : undefined,
          rehydrate: rehydrateDeps.length > 0 ? rehydrateDeps : undefined,
        }, primitive.node);

        const tempVar = `__await_${ctx.nextScopeId++}`;
        emitOpcode(ctx, { op: 'STORE', var: tempVar, fromSignal: true }, primitive.node);
      }
    }

    // Create a block for the rest of the expression evaluation
    // (Note: in a full implementation, we'd rewrite the expression to use temp vars)
    const blockId = createBlock(ctx, []);

    // Use expr as source position for the block opcode
    emitOpcode(ctx, { op: 'BLOCK', blockId }, expr);

    if (storeVar) {
      emitOpcode(ctx, { op: 'STORE', var: storeVar, fromBlock: true });
    }
    return;
  }

  // Check for inner function call - try to inline it
  if (ts.isCallExpression(inner)) {
    if (tryInlineInnerFunctionCall(inner, storeVar, ctx)) {
      return;
    }
    // Check for subprocess spawn (await playerSeat('alice'))
    if (trySubprocessSpawn(inner, storeVar, ctx, true)) {
      return;
    }
  }

  // Regular async call - becomes a block whose body actually runs the
  // awaited call and stashes the result in __blockResult. Without the
  // synthetic assignment the compiled output would emit
  //   state.vars.x = __blockResult
  // with nothing ever writing __blockResult, so `x` would be undefined.
  //
  // The block body is a single expression statement:
  //   __blockResult = await <inner-call>
  // Identifiers inside <inner-call> (services, using/param vars, ...) get
  // rewritten by the BLOCK codegen visitor just like hand-written block
  // statements, so this stays consistent with every other service-await
  // path.
  const syntheticAssignment = ts.factory.createExpressionStatement(
    ts.factory.createBinaryExpression(
      ts.factory.createIdentifier('__blockResult'),
      ts.factory.createToken(ts.SyntaxKind.EqualsToken),
      expr,
    ),
  );
  // Keep source position on the synthetic statement so source maps and
  // later `usedInBlocks` tracking resolve to the right place.
  ts.setTextRange(syntheticAssignment, expr);

  // Record uses of `using` vars in this awaited expression so the block's
  // enclosing step rehydrates them before replay. We capture uses into
  // `currentBlockUses`, snapshot them into the new block, then reset -
  // `currentBlockUses` is meant to be per-pending-block and we just
  // finished building ours.
  trackUsedVariables(syntheticAssignment, ctx);
  const blockId = createBlock(ctx, [syntheticAssignment], Array.from(ctx.currentBlockUses));
  ctx.currentBlockUses = new Set();

  // Use expr as source position for the block opcode
  emitOpcode(ctx, { op: 'BLOCK', blockId }, expr);

  if (storeVar) {
    emitOpcode(ctx, { op: 'STORE', var: storeVar, fromBlock: true });
  }
}

/**
 * Analyze a while statement.
 */
function analyzeWhileStatement(stmt: ts.WhileStatement, ctx: AnalyzerContext): void {
  flushBlock(ctx);

  // Mark loop start
  const loopStartPc = ctx.opcodes.length;
  const startLabel = `__while_${loopStartPc}`;
  const endLabel = `__while_end_${loopStartPc}`;

  // Register labels in labelTargets for pendingLabelPatches
  ctx.labelTargets.set(startLabel, loopStartPc);

  emitOpcode(ctx, { op: 'LABEL', label: startLabel }, stmt);

  // Push loop onto stack for continue/break handling
  ctx.loopStack.push({ startLabel, endLabel });

  // TSP1013: Detect suspension points in while-loop condition
  if (containsSuspension(stmt.expression, ctx)) {
    ctx.diagnostics.add(ProcessErrorCode.WhileConditionSuspension, stmt.expression);
  }

  // Emit a condition check for non-literal-true conditions. Without this,
  // `while (running)` compiles identically to `while (true)`: the loop body
  // runs forever because the condition is never re-evaluated after each
  // iteration. Setting `running = false` inside a race branch cannot exit
  // the loop.
  //
  // Strategy: evaluate the condition in a BLOCK, STORE to `__condition`,
  // then JUMP_IF(__condition_false) to the end label. This is the same
  // pattern used by the complex-if path in analyzeIfStatement.
  //
  // Skip the check for literal `while (true)` - it's the common infinite-loop
  // pattern used by race-switch handlers and emitting a redundant check would
  // add a pointless BLOCK per iteration.
  let conditionJumpOp: (Opcode & { op: 'JUMP_IF' }) | undefined;
  const isTrueLiteral = stmt.expression.kind === ts.SyntaxKind.TrueKeyword;
  if (!isTrueLiteral) {
    // Build a synthetic block `async () => { return <condition>; }`.
    const conditionReturn = ts.factory.createReturnStatement(stmt.expression);
    ts.setTextRange(conditionReturn, stmt.expression);
    const conditionBlockId = createBlock(ctx, [conditionReturn]);
    emitOpcode(ctx, { op: 'BLOCK', blockId: conditionBlockId }, stmt.expression);
    emitOpcode(ctx, { op: 'STORE', var: '__condition', fromBlock: true });
    conditionJumpOp = { op: 'JUMP_IF', condition: '__condition_false', target: -1 };
    emitOpcode(ctx, conditionJumpOp, stmt);
  }

  // Analyze body
  if (ts.isBlock(stmt.statement)) {
    analyzeStatements(stmt.statement.statements, ctx);
  } else {
    analyzeStatement(stmt.statement, ctx);
  }

  flushBlock(ctx);

  // Pop loop from stack
  ctx.loopStack.pop();

  // Add a "continue" label before the jump for proper step boundaries.
  // This ensures non-returning branches (like signal handlers) have a step
  // that contains the JUMP back to the loop start, instead of falling through.
  const continueLabel = `__while_continue_${loopStartPc}`;
  ctx.labelTargets.set(continueLabel, ctx.opcodes.length);
  emitOpcode(ctx, { op: 'LABEL', label: continueLabel }, stmt);

  // Jump back to loop start (re-evaluates the condition on next iteration)
  emitOpcode(ctx, { op: 'JUMP', target: loopStartPc }, stmt);

  // Register end label and mark loop end for break statements.
  // Also patch the condition check to jump here when the condition is false.
  ctx.labelTargets.set(endLabel, ctx.opcodes.length);
  if (conditionJumpOp) {
    (conditionJumpOp as { target: number }).target = ctx.opcodes.length;
  }
  emitOpcode(ctx, { op: 'LABEL', label: endLabel }, stmt);
}

/**
 * Analyze an if statement.
 *
 * For simple if statements (no suspension points in any branch),
 * we inline them into the current block for cleaner generated code.
 *
 * For if statements with suspension points, we still need separate
 * steps for each branch that contains a suspension.
 */
function analyzeIfStatement(stmt: ts.IfStatement, ctx: AnalyzerContext): void {
  // Check if branches contain suspension points
  const thenHasSuspension = containsSuspensionInStatement(stmt.thenStatement, ctx);
  const elseHasSuspension = stmt.elseStatement
    ? containsSuspensionInStatement(stmt.elseStatement, ctx)
    : false;

  // Simple if - no suspension points, add to current block
  // Codegen will handle it with normal if/else and transform returns
  if (!thenHasSuspension && !elseHasSuspension) {
    // TSP3004: Still check for throw statements inside branches
    checkForThrowStatements(stmt.thenStatement, ctx);
    if (stmt.elseStatement) {
      checkForThrowStatements(stmt.elseStatement, ctx);
    }
    // TSP1005: Check for non-deterministic operations
    checkForNonDeterministicOps(stmt, ctx);

    ctx.currentBlockStatements.push(stmt);
    trackUsedVariables(stmt, ctx);
    return;
  }

  // Complex if with suspension points - use step-based approach
  flushBlock(ctx);

  // Create a block that returns the condition expression
  // This becomes: async () => { return !user }
  const conditionReturn = ts.factory.createReturnStatement(stmt.expression);
  // Copy source position from original condition for source maps
  ts.setTextRange(conditionReturn, stmt.expression);

  const conditionBlockId = createBlock(ctx, [conditionReturn]);

  emitOpcode(ctx, { op: 'BLOCK', blockId: conditionBlockId }, stmt.expression);
  emitOpcode(ctx, { op: 'STORE', var: '__condition', fromBlock: true });

  // Map JUMP_IF to the original if statement for source maps
  const jumpIfFalse: Opcode = { op: 'JUMP_IF', condition: '__condition_false', target: -1 };
  emitOpcode(ctx, jumpIfFalse, stmt);

  // Then branch
  if (ts.isBlock(stmt.thenStatement)) {
    analyzeStatements(stmt.thenStatement.statements, ctx);
  } else {
    analyzeStatement(stmt.thenStatement, ctx);
  }

  flushBlock(ctx);

  if (stmt.elseStatement) {
    const jumpToEnd: Opcode = { op: 'JUMP', target: -1 };
    emitOpcode(ctx, jumpToEnd)

    // Patch the jump-if-false
    ;(jumpIfFalse as { target: number }).target = ctx.opcodes.length;

    // Else branch
    if (ts.isBlock(stmt.elseStatement)) {
      analyzeStatements(stmt.elseStatement.statements, ctx);
    } else {
      analyzeStatement(stmt.elseStatement, ctx);
    }

    flushBlock(ctx)

    // Patch jump-to-end
    ;(jumpToEnd as { target: number }).target = ctx.opcodes.length;
  } else {
    // Patch the jump-if-false
    ;(jumpIfFalse as { target: number }).target = ctx.opcodes.length;
  }
}

/**
 * Analyze a switch statement - might be a race pattern.
 */
function analyzeSwitchStatement(stmt: ts.SwitchStatement, ctx: AnalyzerContext): void {
  const expr = stmt.expression;

  // Race pattern: switch (true) { case signal(r, ...): }
  // Using switch(true) with type guards enables type narrowing in each case
  if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    const raceVarName = findRaceVariableInCases(stmt.caseBlock.clauses, ctx);
    if (raceVarName) {
      analyzeRaceSwitch(stmt, raceVarName, ctx);
      return;
    }

    // TSP1003: Cases contain signal/delay calls but no race() variable
    if (casesContainPrimitiveCalls(stmt.caseBlock.clauses, ctx)) {
      ctx.diagnostics.add(ProcessErrorCode.InvalidRacePattern, stmt);
      return;
    }
  }

  // Regular switch - check if it contains any suspension points
  const hasSuspension = checkSwitchHasSuspension(stmt, ctx);

  if (hasSuspension) {
    // Switch contains suspension - need to decompose (complex, for future)
    flushBlock(ctx);

    // Track nested switch depth so break statements aren't suppressed
    if (ctx.inRaceBranch) {
      ctx.nestedSwitchDepth++;
    }

    for (const clause of stmt.caseBlock.clauses) {
      if (ts.isCaseClause(clause)) {
        analyzeStatements(clause.statements, ctx);
      } else {
        analyzeStatements(clause.statements, ctx);
      }
    }

    if (ctx.inRaceBranch) {
      ctx.nestedSwitchDepth--;
    }
  } else {
    // No suspension - add the entire switch as a statement in the current block
    // The switch (including its case bodies and break statements) will be preserved as-is
    ctx.currentBlockStatements.push(stmt);
    trackUsedVariables(stmt, ctx);
  }
}

/**
 * Check if a switch statement contains any suspension points.
 */
function checkSwitchHasSuspension(stmt: ts.SwitchStatement, ctx: AnalyzerContext): boolean {
  for (const clause of stmt.caseBlock.clauses) {
    for (const s of clause.statements) {
      if (checkHasSuspension(s, ctx)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if a statement contains any suspension points (signal, delay, stream, race, await).
 */
function checkHasSuspension(node: ts.Node, ctx: AnalyzerContext): boolean {
  if (ts.isAwaitExpression(node)) {
    return true;
  }
  if (ts.isCallExpression(node)) {
    if (isWaitForCall(node, ctx) || isDelayCall(node, ctx) || isStreamCall(node, ctx)) {
      return true;
    }
    // Check if it's race()
    const callee = node.expression;
    if (ts.isIdentifier(callee) && callee.text === 'race') {
      return true;
    }
  }
  // Recursively check children
  let found = false;
  ts.forEachChild(node, child => {
    if (checkHasSuspension(child, ctx)) {
      found = true;
    }
  });
  return found;
}

/**
 * Find race variable name from switch cases.
 * Looks for pattern: case signal(r, target) or case delay(r, duration)
 * where r is a variable initialized from race().
 */
function findRaceVariableInCases(
  clauses: ts.NodeArray<ts.CaseOrDefaultClause>,
  ctx: AnalyzerContext
): string | null {
  for (const clause of clauses) {
    if (!ts.isCaseClause(clause)) continue;

    const caseExpr = clause.expression;
    if (!ts.isCallExpression(caseExpr)) continue;

    // Check for signal(r, ...), delay(r, ...), signal.all(r, [...]),
    // signal.settled(r, [...]), or stream(r, ...) - any two-arg race primitive
    const isRacePrimitive =
      (isWaitForCall(caseExpr, ctx) || isDelayCall(caseExpr, ctx) ||
       isSignalCombinatorCall(caseExpr, ctx) || isStreamCall(caseExpr, ctx)) &&
      caseExpr.arguments.length >= 2;
    if (isRacePrimitive) {
      const firstArg = caseExpr.arguments[0];
      if (ts.isIdentifier(firstArg)) {
        const varName = firstArg.text;
        if (isRaceVariable(varName, ctx)) {
          return varName;
        }
      }
    }
  }
  return null;
}

/**
 * Check if any case clause contains signal/delay/stream calls (primitive calls
 * that suggest the user intended a race pattern but forgot the race() variable).
 */
function casesContainPrimitiveCalls(
  clauses: ts.NodeArray<ts.CaseOrDefaultClause>,
  ctx: AnalyzerContext
): boolean {
  for (const clause of clauses) {
    if (!ts.isCaseClause(clause)) continue;
    const caseExpr = clause.expression;
    if (!ts.isCallExpression(caseExpr)) continue;
    if (isWaitForCall(caseExpr, ctx) || isDelayCall(caseExpr, ctx) || isStreamCall(caseExpr, ctx)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a variable was initialized from race().
 * Tracks `const r = race()` declarations.
 */
function isRaceVariable(varName: string, ctx: AnalyzerContext): boolean {
  const varInfo = ctx.variables.get(varName);
  if (!varInfo) return false;

  const declNode = varInfo.declarationNode;
  if (!ts.isVariableDeclaration(declNode)) return false;

  const init = declNode.initializer;
  if (!init) return false;

  // Direct race() call
  if (ts.isCallExpression(init) && isRaceCall(init, ctx)) {
    return true;
  }

  return false;
}

/**
 * Analyze a race switch pattern.
 *
 * Pattern: switch (true) { case signal(r, target): ... case delay(r, duration): ... }
 *
 * Uses switch(true) with type guard functions to enable type narrowing in each case.
 *
 * @param raceVarName - The variable name from race() call
 */
function analyzeRaceSwitch(
  stmt: ts.SwitchStatement,
  raceVarName: string,
  ctx: AnalyzerContext
): void {
  flushBlock(ctx);

  // Track the race variable for rewriting r.xxx to __raceResult.xxx
  ctx.raceVars.add(raceVarName);

  const branches: RaceBranch[] = [];
  const branchBodies: Array<{ statements: ts.Statement[]; jumpTarget: number }> = [];
  const branchSourceNodes = new Map<string, ts.Node>();

  // Collect branches from case clauses
  for (const clause of stmt.caseBlock.clauses) {
    if (!ts.isCaseClause(clause)) continue;

    const caseExpr = clause.expression;
    let branch: RaceBranch | null = null;

    // Pattern: case signal(r, target) or case delay(r, duration)
    if (ts.isCallExpression(caseExpr) && caseExpr.arguments.length >= 2) {
      const firstArg = caseExpr.arguments[0];
      if (ts.isIdentifier(firstArg) && firstArg.text === raceVarName) {
        if (isWaitForCall(caseExpr, ctx)) {
          // signal(r, target) - second arg is the signal
          const signalArg = caseExpr.arguments[1];
          const signalInfo = extractSignalInfo(signalArg, ctx);
          if (signalInfo) {
            branch = {
              id: signalInfo.signalName,
              signal: signalInfo.signalName,
              signalExpr: signalArg, // Store for runtime .signalName access
              jumpTarget: -1,
            };
            ctx.signals[signalInfo.signalName] = {
              identity: signalInfo.identity,
              payloadType: signalInfo.payloadType,
            };
            branchSourceNodes.set(signalInfo.signalName, caseExpr);
          }
        } else if (isDelayCall(caseExpr, ctx)) {
          // delay.unit(r, value) - get unit from method name, value is second arg
          const delayInfo = extractDelayInfo(caseExpr);
          if (delayInfo) {
            branch = {
              id: '__timer__',
              timer: {
                unit: delayInfo.unit,
                valueExpr: delayInfo.valueExpr,
              },
              jumpTarget: -1,
            };
            branchSourceNodes.set('__timer__', caseExpr);
          }
        } else if (isStreamCall(caseExpr, ctx)) {
          // stream(r, entity.field) - second arg is the stream field
          const streamArg = caseExpr.arguments[1];
          const streamInfo = extractStreamInfo(streamArg, ctx);
          if (streamInfo) {
            branch = {
              id: streamInfo.signalName,
              signal: streamInfo.signalName,
              signalExpr: streamArg, // Store for runtime access
              jumpTarget: -1,
            };
            ctx.signals[streamInfo.signalName] = {
              identity: streamInfo.identity,
              payloadType: streamInfo.payloadType,
            };
            branchSourceNodes.set(streamInfo.signalName, caseExpr);
          }
        } else if (isSignalCombinatorCall(caseExpr, ctx)) {
          // signal.all(r, [...]) / signal.settled(r, [...]) inside a race switch
          // is not yet supported - emit a clear compiler error (TSP3012).
          ctx.diagnostics.add(ProcessErrorCode.RaceCombinatorNotSupported, caseExpr);
        }
      }
    }

    if (branch) {
      branches.push(branch);
      branchBodies.push({
        statements: Array.from(clause.statements),
        jumpTarget: -1,
      });
    }
  }

  // Validate non-empty branches
  if (branches.length === 0) {
    ctx.diagnostics.add(ProcessErrorCode.EmptyRace, stmt);
    return;
  }

  // Get rehydration deps
  const rehydrateDeps = getRehydrationDepsAtPoint(ctx);

  // Store branch source nodes before emitting opcode (opcode index will be current length)
  const raceOpcodeIndex = ctx.opcodes.length;
  ctx.raceBranchSourceNodes.set(raceOpcodeIndex, branchSourceNodes);

  // Map RACE_START to original switch statement for source maps
  emitOpcode(ctx, {
    op: 'RACE_START',
    branches,
    rehydrate: rehydrateDeps.length > 0 ? rehydrateDeps : undefined,
  }, stmt);

  // Emit RACE_SUSPEND
  emitOpcode(ctx, { op: 'RACE_SUSPEND' }, stmt);

  // Second pass: emit branch bodies and patch jump targets
  // Set inRaceBranch so break statements don't emit JUMP (they fall through to nextStep)
  const wasInRaceBranch = ctx.inRaceBranch;
  ctx.inRaceBranch = true;

  for (let i = 0; i < branches.length; i++) {
    branches[i].jumpTarget = ctx.opcodes.length;

    // Store the race result
    emitOpcode(ctx, { op: 'STORE', var: '__raceResult', fromRace: true });

    // Analyze branch body
    for (const s of branchBodies[i].statements) {
      analyzeStatement(s, ctx);
    }

    flushBlock(ctx);
  }

  ctx.inRaceBranch = wasInRaceBranch;
}

/**
 * Check if an expression contains a suspension point.
 * Uses type-based detection for reliability.
 */
function containsSuspension(expr: ts.Expression, ctx: AnalyzerContext): boolean {
  // Check for yield expressions (in generator handlers)
  if (ts.isYieldExpression(expr)) {
    return true;
  }

  // Check for yield expressions nested in the expression
  let hasYield = false;
  const checkYield = (node: ts.Node): void => {
    if (hasYield) return;
    if (ts.isYieldExpression(node)) {
      hasYield = true;
      return;
    }
    // Don't recurse into nested functions
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return;
    ts.forEachChild(node, checkYield);
  };
  checkYield(expr);
  if (hasYield) return true;

  return containsSuspensionPoint(expr, ctx.typeChecker);
}

/**
 * Check if a block contains any suspension points.
 */
function containsSuspensionInBlock(block: ts.Block, ctx: AnalyzerContext): boolean {
  for (const stmt of block.statements) {
    if (containsSuspensionInStatement(stmt, ctx)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if an expression contains a call to an inner function with suspension points.
 * These need to be inlined at the call site.
 */
function containsInnerFunctionCall(expr: ts.Expression, ctx: AnalyzerContext): boolean {
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;

    // Check for call expressions to registered inner functions
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee)) {
        const funcInfo = ctx.innerFunctions.get(callee.text);
        if (funcInfo && funcInfo.hasSuspension) {
          found = true;
          return;
        }
      }
    }

    // Skip nested function bodies
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isFunctionDeclaration(node)) {
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(expr);
  return found;
}

/**
 * Check if a statement contains any suspension points (deep search).
 */
function containsSuspensionInStatement(stmt: ts.Statement, ctx: AnalyzerContext): boolean {
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;

    // Check yield expressions (in generator handlers)
    if (ts.isYieldExpression(node)) {
      found = true;
      return;
    }

    // Check await expressions
    if (ts.isAwaitExpression(node)) {
      const inner = node.expression;
      if (ts.isCallExpression(inner)) {
        const primitive = getPrimitiveCall(inner, ctx.typeChecker);
        if (primitive && (primitive.kind === 'signal' || primitive.kind === 'delay')) {
          found = true;
          return;
        }
      }
    }

    // Skip nested function bodies (they have their own scope)
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isFunctionDeclaration(node)) {
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(stmt);
  return found;
}

/**
 * Walk an expression tree looking for async arrow/function expressions with
 * suspension points that are passed as arguments to calls (not assigned to
 * named variables, which get registered for inlining).
 */
function checkForNestedAsyncWithSuspension(expr: ts.Expression, ctx: AnalyzerContext): void {
  const visit = (node: ts.Node): void => {
    // Skip into call expressions to check their arguments
    if (ts.isCallExpression(node)) {
      for (const arg of node.arguments) {
        if ((ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) &&
            arg.modifiers?.some(mod => mod.kind === ts.SyntaxKind.AsyncKeyword)) {
          const hasSuspension = ts.isBlock(arg.body)
            ? containsSuspensionInBlock(arg.body, ctx)
            : containsSuspension(arg.body, ctx);
          if (hasSuspension) {
            ctx.diagnostics.add(ProcessErrorCode.NestedAsyncWithSuspension, arg);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(expr);
}

/**
 * Register an inner function for potential inlining.
 */
function registerInnerFunction(
  name: string,
  node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
  ctx: AnalyzerContext
): InnerFunctionInfo {
  const isAsync = node.modifiers?.some(mod => mod.kind === ts.SyntaxKind.AsyncKeyword) ?? false;

  let hasSuspension = false;
  if (node.body) {
    if (ts.isBlock(node.body)) {
      hasSuspension = containsSuspensionInBlock(node.body, ctx);
    } else if (!ts.isFunctionDeclaration(node)) {
      // Arrow function expression body
      hasSuspension = containsSuspension(node.body, ctx);
    }
  }

  const capturedVars = findCapturedVariables(node, ctx);
  const callsTo = findFunctionCalls(node);

  const info: InnerFunctionInfo = {
    name,
    node,
    hasSuspension,
    isAsync,
    capturedVars,
    inlineCount: 0,
    callsTo,
  };

  ctx.innerFunctions.set(name, info);
  return info;
}

/**
 * Find variables captured from outer scope by a function.
 */
function findCapturedVariables(
  node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
  ctx: AnalyzerContext
): Set<string> {
  const captured = new Set<string>();
  const localVars = new Set<string>();

  // Collect parameters as local variables
  for (const param of node.parameters) {
    if (ts.isIdentifier(param.name)) {
      localVars.add(param.name.text);
    }
  }

  const visit = (n: ts.Node): void => {
    // Track local variable declarations
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      localVars.add(n.name.text);
    }

    // Check identifier references
    if (ts.isIdentifier(n)) {
      const name = n.text;
      // Skip if it's a property access (not a standalone reference)
      const parent = n.parent;
      if (parent && ts.isPropertyAccessExpression(parent) && parent.name === n) {
        return;
      }
      // Skip if it's a function name in a call
      if (parent && ts.isCallExpression(parent) && parent.expression === n) {
        // This is a function call - we track it separately
        return;
      }

      // If it's known in outer scope but not local, it's captured
      if (!localVars.has(name) && ctx.variables.has(name)) {
        captured.add(name);
      }
    }

    ts.forEachChild(n, visit);
  };

  if (node.body) {
    visit(node.body);
  }

  return captured;
}

/**
 * Find which inner functions are called by a function.
 */
function findFunctionCalls(
  node: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration,
): Set<string> {
  const calls = new Set<string>();

  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee)) {
        const name = callee.text;
        // Will be checked against innerFunctions later
        calls.add(name);
      }
    }

    ts.forEachChild(n, visit);
  };

  if (node.body) {
    visit(node.body);
  }

  return calls;
}

/**
 * Check if a function escapes its scope (returned, passed as argument, stored in array/object).
 */
function checkFunctionEscapes(
  name: string,
  containingBlock: ts.NodeArray<ts.Statement>,
): boolean {
  let escapes = false;

  const visit = (n: ts.Node): void => {
    if (escapes) return;

    // Return statement - function escapes if returned
    if (ts.isReturnStatement(n) && n.expression) {
      if (ts.isIdentifier(n.expression) && n.expression.text === name) {
        escapes = true;
        return;
      }
      // Check if returned in object/array literal
      if (containsIdentifierReference(n.expression, name)) {
        const parent = n.expression;
        if (ts.isObjectLiteralExpression(parent) || ts.isArrayLiteralExpression(parent)) {
          escapes = true;
          return;
        }
      }
    }

    // Passed as argument to another function (except await)
    if (ts.isCallExpression(n)) {
      for (const arg of n.arguments) {
        if (ts.isIdentifier(arg) && arg.text === name) {
          // Check if it's an await call to the function itself - that's OK
          const callee = n.expression;
          if (ts.isIdentifier(callee) && callee.text === name) {
            continue; // Calling the function is OK
          }
          escapes = true;
          return;
        }
      }
    }

    // Assigned to object property or array element
    if (ts.isPropertyAssignment(n)) {
      if (ts.isIdentifier(n.initializer) && n.initializer.text === name) {
        escapes = true;
        return;
      }
    }

    if (ts.isArrayLiteralExpression(n)) {
      for (const elem of n.elements) {
        if (ts.isIdentifier(elem) && elem.text === name) {
          escapes = true;
          return;
        }
      }
    }

    ts.forEachChild(n, visit);
  };

  for (const stmt of containingBlock) {
    visit(stmt);
    if (escapes) break;
  }

  return escapes;
}

/**
 * Check if an expression contains a reference to a specific identifier.
 */
function containsIdentifierReference(expr: ts.Expression, name: string): boolean {
  let found = false;

  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && n.text === name) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };

  visit(expr);
  return found;
}

/**
 * Check for mutual recursion between functions.
 * Only checks for A -> B -> A patterns, not self-recursion (A -> A).
 * Self-recursion is detected by the inlining stack check.
 */
function checkMutualRecursion(funcName: string, ctx: AnalyzerContext): string | null {
  const funcInfo = ctx.innerFunctions.get(funcName);
  if (!funcInfo) return null;

  // Check if any function we call (excluding self), calls us back
  for (const calledName of funcInfo.callsTo) {
    // Skip self-recursion - that's handled by the inlining stack
    if (calledName === funcName) continue;

    const calledInfo = ctx.innerFunctions.get(calledName);
    if (calledInfo && calledInfo.callsTo.has(funcName)) {
      return calledName;
    }
  }

  return null;
}

/**
 * Try to inline an inner function call. Returns true if inlined, false if not possible.
 */
function tryInlineInnerFunctionCall(
  callExpr: ts.CallExpression,
  storeVar: string | undefined,
  ctx: AnalyzerContext
): boolean {
  const callee = callExpr.expression;
  if (!ts.isIdentifier(callee)) return false;

  const funcName = callee.text;
  const funcInfo = ctx.innerFunctions.get(funcName);
  if (!funcInfo) return false;

  // Only inline functions with suspension points
  if (!funcInfo.hasSuspension) return false;

  // Check for recursion - is this function already being inlined?
  if (ctx.inliningStack.includes(funcName)) {
    ctx.diagnostics.add(ProcessErrorCode.RecursionDepthUnknown, callExpr, funcName);
    return false;
  }

  // Check for mutual recursion
  const mutualWith = checkMutualRecursion(funcName, ctx);
  if (mutualWith) {
    ctx.diagnostics.add(ProcessErrorCode.MutualRecursion, callExpr, funcName, mutualWith);
    return false;
  }

  // Check inlining depth
  if (ctx.inliningStack.length >= ctx.maxInliningDepth) {
    ctx.diagnostics.add(
      ProcessErrorCode.MaxInliningDepthExceeded,
      callExpr,
      ctx.maxInliningDepth.toString(),
      funcName
    );
    return false;
  }

  // Handle parameterized inner functions:
  // Store each argument into a state variable named after the parameter,
  // then inline the body. The rewriter maps parameter references to state.vars.<param>.
  const params = funcInfo.node.parameters;
  const args = callExpr.arguments;

  if (params.length > 0) {
    for (let i = 0; i < params.length; i++) {
      const param = params[i];
      if (!ts.isIdentifier(param.name)) continue;
      const paramName = param.name.text;

      // Register parameter as a local serializable variable
      ctx.variables.set(paramName, {
        name: paramName,
        isUsing: false,
        isSerializable: true,
        declarationNode: param,
        usedInBlocks: [],
      });

      // Create synthetic assignment: paramName = argExpr
      const argExpr = i < args.length ? args[i] : ts.factory.createIdentifier('undefined');
      const syntheticAssignment = ts.factory.createExpressionStatement(
        ts.factory.createAssignment(
          ts.factory.createIdentifier(paramName),
          argExpr as ts.Expression,
        )
      );
      ctx.currentBlockStatements.push(syntheticAssignment);
      trackUsedVariables(syntheticAssignment, ctx);
    }
  }

  // Increment inline count for this function
  funcInfo.inlineCount++;

  // Push onto inlining stack
  ctx.inliningStack.push(funcName);

  // Inline the function body
  const body = funcInfo.node.body;
  if (body) {
    if (ts.isBlock(body)) {
      analyzeStatements(body.statements, ctx);
    } else {
      // Expression body - analyze as expression
      analyzeExpression(body, ctx);
    }
  }

  // Pop from inlining stack
  ctx.inliningStack.pop();

  return true;
}

/**
 * Check if an expression is a Promise.all/Promise.race/Promise.any with signals.
 * Returns the combinator name if found, null otherwise.
 */
/**
 * Extract subprocess info from a createSubProcess({ name, path, handler }) call.
 * Returns null if the call doesn't match the expected shape.
 */
function extractSubProcessInfo(
  callExpr: ts.CallExpression,
  varName: string,
  ctx: AnalyzerContext
): SubProcessInfo | null {
  const arg = callExpr.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;

  let name: string | undefined;
  let path: string | undefined;
  let handlerNode: ts.ArrowFunction | ts.FunctionExpression | undefined;

  for (const prop of arg.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
      const key = prop.name.text;
      if (key === 'name' && ts.isStringLiteral(prop.initializer)) {
        name = prop.initializer.text;
      } else if (key === 'path' && ts.isStringLiteral(prop.initializer)) {
        path = prop.initializer.text;
      } else if (key === 'handler') {
        if (ts.isArrowFunction(prop.initializer) || ts.isFunctionExpression(prop.initializer)) {
          handlerNode = prop.initializer;
        }
      }
    } else if (ts.isMethodDeclaration(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'handler') {
      // async handler(...) { ... } - method shorthand syntax
      const funcExpr = ts.factory.createFunctionExpression(
        prop.modifiers?.filter(ts.isModifier) as ts.Modifier[] | undefined,
        prop.asteriskToken,
        undefined,
        prop.typeParameters,
        prop.parameters,
        prop.type,
        prop.body ?? ts.factory.createBlock([])
      );
      handlerNode = funcExpr;
    }
  }

  if (!name || !path || !handlerNode) return null;

  // Extract handler parameter names
  const handlerParams = handlerNode.parameters
    .filter(p => ts.isIdentifier(p.name))
    .map(p => (p.name as ts.Identifier).text);

  // Analyze the subprocess handler body recursively
  const analysis = analyzeHandler(handlerNode, ctx.typeChecker);

  return { name, path, varName, handlerNode, handlerParams, analysis };
}

/**
 * Check if a call expression is a subprocess spawn (e.g., `await playerSeat('alice')`)
 * and if so, emit the SUBPROCESS_SPAWN opcode.
 *
 * `awaited` indicates whether the call expression's syntactic parent is an
 * AwaitExpression. The executor uses this to decide whether to suspend the
 * parent until the child reaches DONE (awaited) or continue immediately
 * (detached).
 */
function trySubprocessSpawn(
  callExpr: ts.CallExpression,
  storeVar: string | undefined,
  ctx: AnalyzerContext,
  awaited: boolean
): boolean {
  if (!ts.isIdentifier(callExpr.expression)) return false;
  const calleeName = callExpr.expression.text;

  // Check if this callee name matches a registered subprocess
  const subInfo = ctx.subprocesses.find(s => s.varName === calleeName);
  if (!subInfo) return false;

  const argExprs = Array.from(callExpr.arguments) as ts.Expression[];

  flushBlock(ctx);
  emitOpcode(ctx, {
    op: 'SUBPROCESS_SPAWN',
    name: subInfo.name,
    argExprs,
    storeVar,
    awaited,
  }, callExpr);

  return true;
}

function checkPromiseCombinatorWithSignals(
  expr: ts.Expression,
  ctx: AnalyzerContext
): string | null {
  if (!ts.isCallExpression(expr)) return null;

  const callee = expr.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;

  // Check for Promise.all, Promise.race, Promise.any, Promise.allSettled
  const object = callee.expression;
  const method = callee.name.text;

  if (!ts.isIdentifier(object) || object.text !== 'Promise') return null;

  const combinators = ['all', 'race', 'any', 'allSettled'];
  if (!combinators.includes(method)) return null;

  // Check if any argument contains a signal/delay call
  for (const arg of expr.arguments) {
    if (containsSignalOrDelayCall(arg, ctx)) {
      return `Promise.${method}`;
    }
  }

  return null;
}

/**
 * Check if an expression contains signal() or delay() calls (not awaited).
 */
function containsSignalOrDelayCall(expr: ts.Expression, ctx: AnalyzerContext): boolean {
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;

    if (ts.isCallExpression(node)) {
      const primitive = getPrimitiveCall(node, ctx.typeChecker);
      if (primitive && (primitive.kind === 'signal' || primitive.kind === 'delay')) {
        found = true;
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(expr);
  return found;
}

/**
 * Check if a call is a signal/waitFor call.
 */
function isWaitForCall(node: ts.CallExpression, ctx?: AnalyzerContext): boolean {
  if (ctx) {
    return isPrimitiveSignalCall(node, ctx.typeChecker);
  }
  // Fallback for cases without context
  const expr = node.expression;
  if (ts.isIdentifier(expr)) {
    return expr.text === 'waitFor' || expr.text === 'signal';
  }
  return false;
}

/**
 * Check if a call is a delay call.
 */
function isDelayCall(node: ts.CallExpression, ctx?: AnalyzerContext): boolean {
  if (ctx) {
    return isPrimitiveDelayCall(node, ctx.typeChecker);
  }
  const expr = node.expression;
  if (ts.isIdentifier(expr)) {
    return expr.text === 'delay';
  }
  return false;
}

/**
 * Check if a call is a race call.
 */
function isRaceCall(node: ts.CallExpression, ctx?: AnalyzerContext): boolean {
  if (ctx) {
    return isPrimitiveRaceCall(node, ctx.typeChecker);
  }
  const expr = node.expression;
  if (ts.isIdentifier(expr)) {
    return expr.text === 'race';
  }
  return false;
}

/**
 * Check if a call is a signal.all() or signal.settled() call.
 */
function isSignalCombinatorCall(node: ts.CallExpression, ctx: AnalyzerContext): boolean {
  return isPrimitiveSignalCombinatorCall(node, ctx.typeChecker);
}

/**
 * Check if a call is a stream() call.
 */
function isStreamCall(node: ts.CallExpression, ctx: AnalyzerContext): boolean {
  return isPrimitiveStreamCall(node, ctx.typeChecker);
}

/**
 * Check if a call is a scope() call.
 */
function isScopeCall(node: ts.CallExpression, ctx: AnalyzerContext): boolean {
  return isPrimitiveScopeCall(node, ctx.typeChecker);
}

/**
 * TSP3001/TSP3002: Check if a for-of iterable is a durable iterator
 * (has __durableIterator brand) and validate it has orderBy + serializable cursor.
 *
 * Regular iterables (arrays, Sets) are allowed without checks.
 * Durable iterators (repository queries) must have orderBy for keyset pagination
 * and a serializable cursor type.
 */
function checkDurableIteratorType(iterableExpr: ts.Expression, ctx: AnalyzerContext): void {
  const type = ctx.typeChecker.getTypeAtLocation(iterableExpr);
  if (!type) return;

  // Check for __durableIterator brand property
  const durableProp = type.getProperty('__durableIterator');
  if (!durableProp) return; // Regular iterable - no validation needed

  // TSP3001: Durable iterator must have orderBy
  const orderByProp = type.getProperty('orderBy');
  if (!orderByProp) {
    ctx.diagnostics.add(ProcessErrorCode.InvalidDurableIterator, iterableExpr);
    return;
  }

  // Check if orderBy was actually called (type narrows from function to result)
  const orderByType = ctx.typeChecker.getTypeOfSymbolAtLocation(orderByProp, iterableExpr);
  // If orderBy is still a function type (not called), the query doesn't have ordering
  if (orderByType.getCallSignatures().length > 0) {
    ctx.diagnostics.add(ProcessErrorCode.InvalidDurableIterator, iterableExpr);
    return;
  }

  // TSP3002: Check cursor type is serializable
  const cursorProp = type.getProperty('__cursorType');
  if (cursorProp) {
    const cursorType = ctx.typeChecker.getTypeOfSymbolAtLocation(cursorProp, iterableExpr);
    if (!isCursorTypeSerializable(cursorType, ctx.typeChecker)) {
      const typeName = ctx.typeChecker.typeToString(cursorType);
      ctx.diagnostics.add(ProcessErrorCode.NonSerializableCursor, iterableExpr, typeName);
    }
  }
}

/**
 * Check if a cursor type is JSON-serializable (primitives or plain objects of primitives).
 */
function isCursorTypeSerializable(type: ts.Type, checker: ts.TypeChecker): boolean {
  // Primitives are serializable
  if (type.flags & (ts.TypeFlags.String | ts.TypeFlags.Number | ts.TypeFlags.Boolean | ts.TypeFlags.Null | ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral)) {
    return true;
  }

  // Union types: all members must be serializable
  if (type.isUnion()) {
    return type.types.every(t => isCursorTypeSerializable(t, checker));
  }

  // Object types: all properties must be serializable, and no call signatures (not a function)
  if (type.flags & ts.TypeFlags.Object) {
    if (type.getCallSignatures().length > 0) return false;
    const properties = type.getProperties();
    return properties.every(prop => {
      const propType = checker.getTypeOfSymbol(prop);
      return isCursorTypeSerializable(propType, checker);
    });
  }

  return false;
}

/**
 * Analyze a scope() call.
 * Detects both signal-first and handler forms.
 * Emits SCOPE_START -> SCOPE_HANDLER (if handler form) -> SCOPE_END opcodes.
 */
function analyzeScopeCall(
  call: ts.CallExpression,
  storeVar: string | undefined,
  ctx: AnalyzerContext
): void {
  const args = call.arguments;
  if (args.length < 2) {
    ctx.diagnostics.add(ProcessErrorCode.InvalidScopeArguments, call);
    return;
  }

  const scopeId = ctx.nextScopeBlockId++;

  // Detect which form: signal-first or handler
  // Signal-first: scope(svc.signal, entities, ?idFn)
  // Handler: scope(entities, handler) or scope(entities, idFn/alias, handler)
  const firstArg = args[0];
  const secondArg = args[1];
  const thirdArg = args[2];

  // Check if first arg is a signal reference (property access on a service)
  const signalInfo = ts.isPropertyAccessExpression(firstArg) ? extractSignalInfo(firstArg, ctx) : null;

  if (signalInfo) {
    // Signal-first form: scope(svc.signal, entities, ?idFn)
    ctx.signals[signalInfo.signalName] = {
      identity: signalInfo.identity,
      payloadType: signalInfo.payloadType,
    };

    emitOpcode(ctx, {
      op: 'SCOPE_START',
      scopeId,
      iterableExpr: secondArg,
      idExtractor: thirdArg,
    }, call);

    emitOpcode(ctx, {
      op: 'SCOPE_WAIT',
      scopeId,
      signalExpr: firstArg,
    }, call);
  } else {
    // Handler form: scope(entities, handler) or scope(entities, idFn/alias, handler)
    let handlerArg: ts.Expression;
    let idExtractor: ts.Expression | undefined;
    let paramAlias: string | undefined;

    if (thirdArg && (ts.isArrowFunction(thirdArg) || ts.isFunctionExpression(thirdArg))) {
      // scope(entities, idFn/alias, handler)
      if (ts.isStringLiteral(secondArg)) {
        paramAlias = secondArg.text;
      } else {
        idExtractor = secondArg;
      }
      handlerArg = thirdArg;
    } else if (ts.isArrowFunction(secondArg) || ts.isFunctionExpression(secondArg)) {
      // scope(entities, handler)
      handlerArg = secondArg;
    } else {
      ctx.diagnostics.add(ProcessErrorCode.InvalidScopeArguments, call);
      return;
    }

    // TSP3007: Check handler for yield expressions
    if (ctx.isGenerator && containsYieldExpression(handlerArg)) {
      ctx.diagnostics.add(ProcessErrorCode.ScopeHandlerCannotYield, handlerArg);
    }

    // TSP3009: Check for nested scope collision
    // (scopeStack tracks active scope IDs - we'd need model type tracking for true collision detection,
    // but for now we just prevent any nested scope calls)
    if (ctx.scopeStack.length > 0) {
      ctx.diagnostics.add(ProcessErrorCode.NestedScopeCollision, call);
    }

    // Walk the handler body for nested scope() calls. The handler body
    // is emitted as a single SCOPE_HANDLER opcode without recursive
    // statement analysis, so the TSP3009 check above would never fire
    // for nested scopes. Detect them with a targeted AST walk while the
    // outer scopeId is on the stack.
    const checkNestedScopeIn = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'scope'
      ) {
        ctx.diagnostics.add(ProcessErrorCode.NestedScopeCollision, node);
      }
      ts.forEachChild(node, checkNestedScopeIn);
    };
    ts.forEachChild(handlerArg, checkNestedScopeIn);

    // Extract handler parameter names
    const handlerFn = handlerArg as ts.ArrowFunction | ts.FunctionExpression;
    const handlerParams = handlerFn.parameters.map(p =>
      ts.isIdentifier(p.name) ? p.name.text : `__scope_${scopeId}_param`
    );

    // Extract the handler body
    const handlerBody = ts.isArrowFunction(handlerArg) || ts.isFunctionExpression(handlerArg)
      ? (ts.isBlock(handlerArg.body) ? handlerArg.body : undefined)
      : undefined;

    if (!handlerBody) {
      // Expression body - wrap as block
      const body = (handlerArg as ts.ArrowFunction).body;
      const returnStmt = ts.factory.createReturnStatement(body as ts.Expression);
      const block = ts.factory.createBlock([returnStmt], true);

      emitOpcode(ctx, {
        op: 'SCOPE_START',
        scopeId,
        iterableExpr: firstArg,
        idExtractor,
        paramAlias,
      }, call);

      ctx.scopeStack.push(scopeId);

      emitOpcode(ctx, {
        op: 'SCOPE_HANDLER',
        scopeId,
        handlerBody: block,
        handlerParams,
      }, call);

      ctx.scopeStack.pop();
    } else {
      emitOpcode(ctx, {
        op: 'SCOPE_START',
        scopeId,
        iterableExpr: firstArg,
        idExtractor,
        paramAlias,
      }, call);

      ctx.scopeStack.push(scopeId);

      emitOpcode(ctx, {
        op: 'SCOPE_HANDLER',
        scopeId,
        handlerBody,
        handlerParams,
      }, call);

      ctx.scopeStack.pop();
    }
  }

  const resultVar = storeVar ?? `__scope_${scopeId}_result`;
  emitOpcode(ctx, {
    op: 'SCOPE_END',
    scopeId,
    resultVar,
  }, call);

  if (storeVar) {
    emitOpcode(ctx, { op: 'STORE', var: storeVar, fromBlock: true }, call);
  }
}

/**
 * Check if an expression (function body) contains yield expressions.
 */
function containsYieldExpression(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isYieldExpression(n)) {
      found = true;
      return;
    }
    // Don't descend into nested functions
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) {
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

/**
 * Analyze a signal.all() or signal.settled() call.
 * Emits PARALLEL_START, PARALLEL_WAIT, PARALLEL_COLLECT opcodes.
 */
function analyzeSignalCombinator(
  call: ts.CallExpression,
  storeVar: string | undefined,
  ctx: AnalyzerContext
): void {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return;

  const methodName = callee.name.text;
  const isSettled = methodName === 'settled';
  const arg = call.arguments[0];
  if (!arg) return;

  const parallelId = ctx.nextParallelId++;
  const branches: ParallelBranch[] = [];
  let isObjectForm = false;

  // Determine if it's array form or object form
  if (ts.isArrayLiteralExpression(arg)) {
    // Array form: signal.all([svc.a, svc.b, () => doWork()])
    isObjectForm = false;
    arg.elements.forEach((element, index) => {
      const branch = extractParallelBranch(element, index, ctx);
      if (branch) {
        branches.push(branch);
      }
    });
  } else if (ts.isObjectLiteralExpression(arg)) {
    // Object form: signal.all({ payment: svc.paid, shipping: svc.shipped })
    isObjectForm = true;
    for (const prop of arg.properties) {
      if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
        const key = prop.name.text;
        const branch = extractParallelBranch(prop.initializer, key, ctx);
        if (branch) {
          branches.push(branch);
        }
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        // { svc.paid } shorthand
        const key = prop.name.text;
        const branch = extractParallelBranch(prop.name, key, ctx);
        if (branch) {
          branches.push(branch);
        }
      }
    }
  }

  // Validate non-empty branches
  if (branches.length === 0) {
    ctx.diagnostics.add(ProcessErrorCode.EmptyParallelBlock, call);
    return;
  }

  // Emit PARALLEL_START
  emitOpcode(ctx, {
    op: 'PARALLEL_START',
    parallelId,
    branches,
    isSettled,
  }, call);

  // Emit PARALLEL_WAIT - suspends until all branches complete
  emitOpcode(ctx, {
    op: 'PARALLEL_WAIT',
    parallelId,
  }, call);

  // Emit PARALLEL_COLLECT - collects results into the store variable
  const resultVar = storeVar ?? `__parallel_${parallelId}`;
  emitOpcode(ctx, {
    op: 'PARALLEL_COLLECT',
    parallelId,
    resultVar,
    isObject: isObjectForm,
  }, call);

  if (storeVar) {
    emitOpcode(ctx, { op: 'STORE', var: storeVar, fromBlock: true }, call);
  }
}

/**
 * Extract a parallel branch from an expression.
 * Handles signal references, delay calls, and async functions.
 */
function extractParallelBranch(
  expr: ts.Expression,
  id: string | number,
  ctx: AnalyzerContext
): ParallelBranch | null {
  // Check for signal reference (property access like svc.paid)
  if (ts.isPropertyAccessExpression(expr)) {
    const signalInfo = extractSignalInfo(expr, ctx);
    if (signalInfo) {
      ctx.signals[signalInfo.signalName] = {
        identity: signalInfo.identity,
        payloadType: signalInfo.payloadType,
      };
      return {
        id,
        expr,
        type: 'signal',
      };
    }
  }

  // Check for delay call
  if (ts.isCallExpression(expr) && isDelayCall(expr, ctx)) {
    return {
      id,
      expr,
      type: 'delay',
    };
  }

  // Check for async arrow function: async () => { ... }
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    return {
      id,
      expr,
      type: 'function',
    };
  }

  // Check for function call that might be a signal reference
  if (ts.isCallExpression(expr)) {
    const signalInfo = extractSignalInfo(expr, ctx);
    if (signalInfo) {
      ctx.signals[signalInfo.signalName] = {
        identity: signalInfo.identity,
        payloadType: signalInfo.payloadType,
      };
      return {
        id,
        expr,
        type: 'signal',
      };
    }
    // Otherwise treat as a function call
    return {
      id,
      expr,
      type: 'function',
    };
  }

  // Identifier reference (could be a signal variable)
  if (ts.isIdentifier(expr)) {
    const signalInfo = extractSignalInfo(expr, ctx);
    if (signalInfo) {
      ctx.signals[signalInfo.signalName] = {
        identity: signalInfo.identity,
        payloadType: signalInfo.payloadType,
      };
      return {
        id,
        expr,
        type: 'signal',
      };
    }
  }

  return null;
}

interface ExtractedSignalInfo {
  signalName: string
  identity: string[]
  payloadType: string
}

/**
 * Extract a stable, comment-free name from an expression node used as a
 * signal service or identity argument. Prefers AST-walked names over raw
 * `.getText()` (which includes whitespace + comments from the source).
 *
 * Falls back to `.getText().trim()` for shapes we don't recognize so we
 * don't lose functionality on legacy patterns; the trim at least keeps
 * stray whitespace out of registered metadata.
 */
export function expressionToName(node: ts.Expression): string {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isPropertyAccessExpression(node)) {
    return `${expressionToName(node.expression)}.${node.name.text}`;
  }
  if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  // Unknown shape — fall back but trim source artefacts.
  return node.getText().trim();
}

function extractSignalInfo(
  arg: ts.Expression,
  ctx: AnalyzerContext
): ExtractedSignalInfo | null {
  // Pattern 1: signal(service.signalName) - property access directly
  // e.g., signal(orders.paid), signal(twofa.codeSubmitted)
  if (ts.isPropertyAccessExpression(arg)) {
    const serviceName = expressionToName(arg.expression);
    const methodName = arg.name.text;

    // Get payload type from type checker
    const type = ctx.typeChecker.getTypeAtLocation(arg);
    const payloadType = ctx.typeChecker.typeToString(type);

    // defineSignals builder chain: BuiltSignal carries `readonly path: TPath`
    // and `readonly typesConfig: TTypes` as literal-typed properties. When
    // present, derive the routing name and identity params from the path so
    // metadata matches what `buildSignal()` registers at runtime.
    const builderInfo = extractDefineSignalsInfo(type, ctx);
    if (builderInfo) {
      return {
        signalName: builderInfo.signalName,
        identity: builderInfo.identity,
        payloadType,
      };
    }

    return { signalName: `${serviceName}.${methodName}`, identity: [], payloadType };
  }

  // Pattern 2: signal(service.signalName(identityArgs)) - call expression
  // e.g., signal(payments.received(orderId)) - legacy pattern
  if (ts.isCallExpression(arg)) {
    const callExpr = arg.expression;
    if (ts.isPropertyAccessExpression(callExpr)) {
      const serviceName = expressionToName(callExpr.expression);
      const methodName = callExpr.name.text;
      const signalName = `${serviceName}.${methodName}`;

      // Extract identity from arguments — AST-walk each rather than
      // `.getText()` so the registered identity metadata is just the
      // name, with no source-text whitespace / inline comments leaking
      // in. Path-param identifiers and string literals dominate this
      // position; the fallback handles oddballs.
      const identity = arg.arguments.map(expressionToName);

      // Get payload type from type checker
      const type = ctx.typeChecker.getTypeAtLocation(arg);
      const payloadType = ctx.typeChecker.typeToString(type);

      return { signalName, identity, payloadType };
    }
  }

  // Pattern 3: signal(signalVariable) - identifier reference to createSignal export
  // e.g., signal(r, emailVerified) where emailVerified = createSignal('auth.email.verified', ...)
  if (ts.isIdentifier(arg)) {
    // Try to find the signal name from the symbol's declaration
    const symbol = ctx.typeChecker.getSymbolAtLocation(arg);
    if (symbol) {
      const declarations = symbol.getDeclarations();
      if (declarations && declarations.length > 0) {
        const decl = declarations[0];
        // Look for: const signalName = createSignal('signal.name', ...)
        if (ts.isVariableDeclaration(decl) && decl.initializer) {
          if (ts.isCallExpression(decl.initializer)) {
            const callExpr = decl.initializer.expression;
            if (ts.isIdentifier(callExpr) && callExpr.text === 'createSignal') {
              // First argument is the signal name
              const signalNameArg = decl.initializer.arguments[0];
              if (signalNameArg && ts.isStringLiteral(signalNameArg)) {
                const signalName = signalNameArg.text;

                // Second argument is the identity keys array
                const identityArg = decl.initializer.arguments[1];
                let identity: string[] = [];
                if (identityArg && ts.isArrayLiteralExpression(identityArg)) {
                  identity = identityArg.elements
                    .filter(ts.isStringLiteral)
                    .map(e => e.text);
                }

                // Get payload type from type checker
                const type = ctx.typeChecker.getTypeAtLocation(arg);
                const payloadType = ctx.typeChecker.typeToString(type);

                return { signalName, identity, payloadType };
              }
            }
          }
        }
      }
    }

    // Fallback: use identifier name as signal name
    const signalName = arg.text;
    const type = ctx.typeChecker.getTypeAtLocation(arg);
    const payloadType = ctx.typeChecker.typeToString(type);
    return { signalName, identity: [], payloadType };
  }

  return null;
}

/**
 * If `type` is a `BuiltSignal<TPath, ...>` from defineSignals, extract the
 * literal path and convert it into a routing name + identity params, mirroring
 * `pathToSignalName` / `extractPathParams` in
 * `packages/core/core/src/process/define-signals.ts`.
 *
 * Returns null when the type isn't a builder chain (preserves the legacy
 * `service.method` naming for callers).
 */
function extractDefineSignalsInfo(
  type: ts.Type,
  ctx: AnalyzerContext,
): { signalName: string; identity: string[] } | null {
  const pathSym = type.getProperty('path');
  if (!pathSym) return null;

  const pathDecls = pathSym.getDeclarations();
  if (!pathDecls || pathDecls.length === 0) return null;

  const pathType = ctx.typeChecker.getTypeOfSymbolAtLocation(pathSym, pathDecls[0]);
  if (!pathType.isStringLiteral()) return null;

  const path = pathType.value;
  return {
    signalName: pathToSignalName(path),
    identity: extractPathParams(path),
  };
}

/** Mirror of `pathToSignalName` in process/define-signals.ts (compile-time copy). */
function pathToSignalName(path: string): string {
  if (!path) return 'anonymous';
  return path
    .replace(/^\//, '')
    .replace(/\//g, '.')
    .replace(/:/g, '');
}

/** Mirror of `extractPathParams` in process/define-signals.ts (compile-time copy). */
function extractPathParams(path: string): string[] {
  if (!path) return [];
  const params: string[] = [];
  const regex = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let match;
  while ((match = regex.exec(path)) !== null) {
    params.push(match[1]);
  }
  return params;
}

/**
 * Extract delay info from a delay.unit(r, value) call.
 * Returns the unit and the value expression.
 */
function extractDelayInfo(
  call: ts.CallExpression
): { unit: 'seconds' | 'minutes' | 'hours' | 'days'; valueExpr: ts.Expression } | null {
  const callee = call.expression;

  // Pattern: delay.minutes(r, 5) or delay.minutes(5)
  if (!ts.isPropertyAccessExpression(callee)) {
    return null;
  }

  const unit = callee.name.text;
  if (unit !== 'seconds' && unit !== 'minutes' && unit !== 'hours' && unit !== 'days') {
    return null;
  }

  // Get the value expression - it's either the first arg (simple) or second arg (race pattern)
  const args = call.arguments;
  if (args.length === 0) {
    return null;
  }

  // If 2 args, first is racer, second is value. If 1 arg, it's the value.
  const valueExpr = args.length >= 2 ? args[1] : args[0];

  return { unit, valueExpr };
}

/**
 * Extract stream info from a stream(r, entity.field) call.
 * Returns a signal name with wildcard entity ID: stream:ModelName:*:fieldName
 *
 * The wildcard (*) is resolved at runtime using the process's identity.
 */
function extractStreamInfo(
  arg: ts.Expression,
  ctx: AnalyzerContext
): ExtractedSignalInfo | null {
  // Pattern: stream(r, entity.streamField) - property access on model entity
  // e.g., stream(r, order.statusUpdates) where order: Order
  if (ts.isPropertyAccessExpression(arg)) {
    const fieldName = arg.name.text;

    // Get the entity's type to determine the model name
    const entityType = ctx.typeChecker.getTypeAtLocation(arg.expression);
    let modelName = extractModelNameFromType(entityType, ctx.typeChecker);

    // If extractModelNameFromType returned a wrapper type (Persistent, __type, etc.),
    // trace back through the variable declaration to find the Ref<Model> source type.
    // Pattern: `using room = await roomRef` -> roomRef: Ref<Room> -> extract "Room"
    if (modelName === 'Persistent' || modelName.startsWith('__') || modelName.startsWith('{')) {
      const refModelName = extractModelNameFromRefSource(arg.expression, ctx);
      if (refModelName) {
        modelName = refModelName;
      }
    }

    // Generate wildcard signal name: stream:ModelName:*:fieldName
    // The * is resolved at runtime from process identity
    const signalName = `stream:${modelName}:*:${fieldName}`;

    // Get the stream's element type (Stream<T> -> T)
    const streamType = ctx.typeChecker.getTypeAtLocation(arg);
    let payloadType = ctx.typeChecker.typeToString(streamType);

    // Try to extract the inner type from AsyncIterable<T> or Stream<T>
    // TypeChecker returns the full type, but we want the element type
    if (streamType.aliasTypeArguments && streamType.aliasTypeArguments.length > 0) {
      payloadType = ctx.typeChecker.typeToString(streamType.aliasTypeArguments[0]);
    } else if ((streamType as ts.TypeReference).typeArguments) {
      const typeArgs = (streamType as ts.TypeReference).typeArguments;
      if (typeArgs && typeArgs.length > 0) {
        payloadType = ctx.typeChecker.typeToString(typeArgs[0]);
      }
    }

    return {
      signalName,
      identity: [], // Identity is resolved at runtime from process path params
      payloadType,
    };
  }

  return null;
}

/**
 * Extract model name by tracing a variable back to its Ref<Model> source.
 *
 * For `using room = await roomRef`, finds roomRef's type Ref<Room> and extracts "Room".
 * Also handles direct Ref types and process handler destructured params.
 */
function extractModelNameFromRefSource(
  expr: ts.Expression,
  ctx: AnalyzerContext
): string | null {
  if (!ts.isIdentifier(expr)) return null;

  const symbol = ctx.typeChecker.getSymbolAtLocation(expr);
  if (!symbol) return null;

  const declarations = symbol.getDeclarations();
  if (!declarations || declarations.length === 0) return null;

  for (const decl of declarations) {
    // Pattern: `using room = await roomRef` - check the initializer
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      let initExpr = decl.initializer;

      // Unwrap `await` expression
      if (ts.isAwaitExpression(initExpr)) {
        initExpr = initExpr.expression;
      }

      // Strategy 1: Extract from Ref type arguments
      const refType = ctx.typeChecker.getTypeAtLocation(initExpr);
      const refModelName = extractModelNameFromRefType(refType, ctx.typeChecker);
      if (refModelName) return refModelName;

      // Strategy 2: Extract from ref variable name convention
      // `roomRef` -> remove "Ref" suffix -> "room" -> capitalize -> "Room"
      if (ts.isIdentifier(initExpr)) {
        const refVarName = initExpr.text;
        if (refVarName.endsWith('Ref')) {
          const base = refVarName.slice(0, -3); // Remove "Ref"
          if (base.length > 0) {
            return base.charAt(0).toUpperCase() + base.slice(1);
          }
        }
      }
    }
  }

  return null;
}

/**
 * Extract model name from a Ref<Model> type.
 * Checks symbol name, alias type arguments, and string parsing.
 */
function extractModelNameFromRefType(type: ts.Type, typeChecker: ts.TypeChecker): string | null {
  const typeStr = typeChecker.typeToString(type);

  // Try Ref<Model> pattern in type string
  const refMatch = typeStr.match(/Ref<(?:typeof\s+)?(\w+)>/);
  if (refMatch) {
    return refMatch[1];
  }

  // Check alias type arguments (Ref<T> preserves T)
  if (type.aliasTypeArguments && type.aliasTypeArguments.length > 0) {
    const innerType = type.aliasTypeArguments[0];
    const innerSymbol = innerType.getSymbol() || innerType.aliasSymbol;
    const name = innerSymbol?.getName();
    if (name && !name.startsWith('__') && name !== 'Persistent') {
      return name;
    }
  }

  // Check generic type arguments
  const typeRef = type as ts.TypeReference;
  const typeArgs = typeChecker.getTypeArguments?.(typeRef) ?? [];
  if (typeArgs.length > 0) {
    const innerSymbol = typeArgs[0].getSymbol() || typeArgs[0].aliasSymbol;
    const name = innerSymbol?.getName();
    if (name && !name.startsWith('__') && name !== 'Persistent') {
      return name;
    }
  }

  return null;
}

/**
 * Extract the model name from a type.
 * Handles: Persistent<M> wrappers, Model type aliases, interfaces with __modelName property,
 * or falls back to type symbol name.
 */
function extractModelNameFromType(type: ts.Type, typeChecker: ts.TypeChecker): string {
  // Check if this is a Persistent<M> type reference - extract M
  // Persistent<typeof Room> should extract "Room", not "Persistent"
  const symbol = type.getSymbol() || type.aliasSymbol;
  const symbolName = symbol?.getName();

  if (symbolName === 'Persistent') {
    // Try to get the type argument (the model type inside Persistent<M>)
    const typeRef = type as ts.TypeReference;
    const typeArgs = typeChecker.getTypeArguments?.(typeRef as ts.TypeReference) ?? [];
    if (typeArgs.length > 0) {
      return extractModelNameFromType(typeArgs[0], typeChecker);
    }

    // Persistent<T> is a type alias that resolves to an intersection.
    // When resolved, getTypeArguments returns empty. Try alias type arguments.
    if (type.aliasTypeArguments && type.aliasTypeArguments.length > 0) {
      return extractModelNameFromType(type.aliasTypeArguments[0], typeChecker);
    }

    // For intersection types (resolved Persistent<T>), look for __modelName
    // in the constituent types
    if (type.isIntersection()) {
      for (const constituent of type.types) {
        const modelNameProp = constituent.getProperty('__modelName');
        if (modelNameProp) {
          const propType = typeChecker.getTypeOfSymbol(modelNameProp);
          if (propType.isStringLiteral()) {
            return propType.value;
          }
        }
      }
    }

    // Try __modelName directly on the type
    const modelNameProp = type.getProperty('__modelName');
    if (modelNameProp) {
      const propType = typeChecker.getTypeOfSymbol(modelNameProp);
      if (propType.isStringLiteral()) {
        return propType.value;
      }
    }

    // Try string parsing as last resort
    const typeString = typeChecker.typeToString(type);
    const persistentMatch = typeString.match(/Persistent<(?:typeof\s+)?(\w+)>/);
    if (persistentMatch) {
      return persistentMatch[1];
    }
  }

  // For non-Persistent types, try the symbol name
  if (symbol) {
    const name = symbol.getName();
    // Skip __type and other synthetic names
    if (name && !name.startsWith('__')) {
      return name;
    }
  }

  // Try to find a __modelName property on the type (from defineModel)
  const modelNameProp = type.getProperty('__modelName');
  if (modelNameProp) {
    const propType = typeChecker.getTypeOfSymbol(modelNameProp);
    if (propType.isStringLiteral()) {
      return propType.value;
    }
  }

  // Fallback: use the stringified type and extract likely model name
  const typeString = typeChecker.typeToString(type);
  // Remove Persistent<...> wrapper if present
  const persistentMatch = typeString.match(/Persistent<(?:typeof\s+)?(\w+)>/);
  if (persistentMatch) {
    return persistentMatch[1];
  }

  // Use the type string as-is (might be an interface name or type alias)
  return typeString;
}

function extractDependencies(expr: ts.Expression, ctx: AnalyzerContext): string[] {
  const deps: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const varInfo = ctx.variables.get(node.text);
      if (varInfo) {
        deps.push(node.text);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(expr);
  return deps;
}

function isSerializableType(decl: ts.VariableDeclaration, typeChecker: ts.TypeChecker): boolean {
  const type = typeChecker.getTypeAtLocation(decl);
  const typeString = typeChecker.typeToString(type);

  // Simple heuristic: primitives and plain objects are serializable
  // Complex types like functions, symbols, classes are not
  const nonSerializable = ['Function', 'Symbol', 'Promise', 'AsyncGenerator'];

  for (const ns of nonSerializable) {
    if (typeString.includes(ns)) {
      return false;
    }
  }

  return true;
}

/**
 * Check if a type is JSON-serializable (can be safely stored in process state).
 *
 * JSON-serializable types include:
 * - Primitives: string, number, boolean, null, undefined
 * - Arrays of serializable types
 * - Plain objects with serializable properties
 *
 * Non-serializable types include:
 * - Functions
 * - Symbols
 * - Classes with methods (model instances, services, etc.)
 * - Promises, AsyncGenerators
 * - Types with non-serializable properties
 */
function isJsonSerializable(decl: ts.VariableDeclaration, typeChecker: ts.TypeChecker): boolean {
  const type = typeChecker.getTypeAtLocation(decl);
  return isTypeJsonSerializable(type, typeChecker, new Set());
}

/**
 * True when the type resolves to any/unknown/error - i.e., the type checker
 * has no usable information.
 */
function hasNoTypeInformation(decl: ts.VariableDeclaration, typeChecker: ts.TypeChecker): boolean {
  const type = typeChecker.getTypeAtLocation(decl);
  const flags = type.getFlags();
  return (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
}

function isTypeJsonSerializable(
  type: ts.Type,
  typeChecker: ts.TypeChecker,
  visited: Set<ts.Type>
): boolean {
  // Prevent infinite recursion with recursive types
  if (visited.has(type)) return true;
  visited.add(type);

  const flags = type.getFlags();

  // Primitives are always serializable
  if (
    flags & ts.TypeFlags.String ||
    flags & ts.TypeFlags.Number ||
    flags & ts.TypeFlags.Boolean ||
    flags & ts.TypeFlags.Null ||
    flags & ts.TypeFlags.Undefined ||
    flags & ts.TypeFlags.Void ||
    flags & ts.TypeFlags.BigInt ||
    flags & ts.TypeFlags.StringLiteral ||
    flags & ts.TypeFlags.NumberLiteral ||
    flags & ts.TypeFlags.BooleanLiteral
  ) {
    return true;
  }

  // Union types: all members must be serializable
  if (type.isUnion()) {
    return type.types.every(t => isTypeJsonSerializable(t, typeChecker, visited));
  }

  // Intersection types: check if result is serializable
  if (type.isIntersection()) {
    return type.types.every(t => isTypeJsonSerializable(t, typeChecker, visited));
  }

  // Check for array types
  if (typeChecker.isArrayType(type)) {
    const elementType = typeChecker.getTypeArguments(type as ts.TypeReference)[0];
    if (elementType) {
      return isTypeJsonSerializable(elementType, typeChecker, visited);
    }
    return true;
  }

  // Check for tuple types
  if (typeChecker.isTupleType(type)) {
    const typeArgs = typeChecker.getTypeArguments(type as ts.TypeReference);
    return typeArgs.every(t => isTypeJsonSerializable(t, typeChecker, visited));
  }

  // Object types: check properties
  if (flags & ts.TypeFlags.Object) {
    const objectType = type as ts.ObjectType;
    const objectFlags = objectType.objectFlags;

    // Reject function types
    if (objectFlags & ts.ObjectFlags.Anonymous) {
      const callSignatures = type.getCallSignatures();
      if (callSignatures.length > 0) {
        return false; // It's a function type
      }
    }

    // Check the type string for known non-serializable patterns
    const typeString = typeChecker.typeToString(type);

    // Reject known non-serializable types
    const nonSerializablePatterns = [
      'Promise<',
      'AsyncGenerator',
      'Generator',
      'Symbol',
      'Map<',
      'Set<',
      'WeakMap',
      'WeakSet',
      'ArrayBuffer',
      'DataView',
      'Int8Array',
      'Uint8Array',
      'Float32Array',
      'Float64Array',
      'RegExp',
      'Error',
      'Date', // Date needs special handling for JSON
    ];

    for (const pattern of nonSerializablePatterns) {
      if (typeString.includes(pattern)) {
        return false;
      }
    }

    // Check all properties are serializable
    const properties = type.getProperties();
    for (const prop of properties) {
      // Skip methods (properties with call signatures)
      const propType = typeChecker.getTypeOfSymbol(prop);
      const propCallSigs = propType.getCallSignatures();
      if (propCallSigs.length > 0) {
        return false; // Has methods - not plain data
      }

      // Check property type is serializable
      if (!isTypeJsonSerializable(propType, typeChecker, visited)) {
        return false;
      }
    }

    return true;
  }

  // Default: assume not serializable for safety
  return false;
}

function trackUsedVariables(stmt: ts.Statement, ctx: AnalyzerContext): void {
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const varInfo = ctx.variables.get(node.text);
      if (varInfo?.isUsing) {
        ctx.currentBlockUses.add(node.text);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(stmt);
}

function getRehydrationDepsAtPoint(ctx: AnalyzerContext): string[] {
  const deps: string[] = [];
  for (const [name, info] of ctx.variables) {
    if (info.isUsing) {
      deps.push(name);
    }
  }
  return deps;
}

/**
 * Create a block and track which using variables are used in it.
 */
function createBlock(
  ctx: AnalyzerContext,
  statements: ts.Statement[],
  uses?: string[]
): number {
  const blockId = ctx.blocks.length;
  const blockUses = uses ?? Array.from(ctx.currentBlockUses);

  ctx.blocks.push({
    id: blockId,
    uses: blockUses,
    statements,
  });

  // Update usedInBlocks for each using variable
  for (const varName of blockUses) {
    const varInfo = ctx.variables.get(varName);
    if (varInfo && varInfo.isUsing) {
      varInfo.usedInBlocks.push(blockId);
    }
  }

  return blockId;
}

function flushBlock(ctx: AnalyzerContext): void {
  if (ctx.currentBlockStatements.length > 0) {
    const statements = ctx.currentBlockStatements;
    const blockId = createBlock(ctx, statements);

    // Use first statement as source position for the block opcode
    emitOpcode(ctx, { op: 'BLOCK', blockId }, statements[0]);
    ctx.currentBlockStatements = [];
    ctx.currentBlockUses = new Set();
  }
}

function patchLabels(ctx: AnalyzerContext): void {
  for (const patch of ctx.pendingLabelPatches) {
    const target = ctx.labelTargets.get(patch.label);
    if (target !== undefined) {
      ;(patch.opcode as unknown as Record<string, number>)[patch.field] = target;
    }
  }
}
