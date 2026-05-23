/**
 * @justscale/core/process - Switch-Based Code Generator
 *
 * Generates VM-style switch-based execution code from process analysis.
 *
 * The generated code follows this pattern:
 * ```
 * async execute(ctx) {
 *   const { state, services } = ctx
 *   let step = state.step | 0
 *   const __r = [0, undefined]  // [DONE/SUSPEND, payload]
 *
 *   main_loop: while (true) {
 *     switch (step) {
 *       case 0: { ... }
 *       case 1: { ... }
 *     }
 *   }
 *   return __r
 * }
 * ```
 */

import ts from 'typescript';
import type { AnalysisResult, ExportsInfo, SubProcessInfo } from './analyzer.js';
import {
  rewriteStatement,
  rewriteExpression,
  extractParamVars,
  extractParamAliases,
  extractServiceVars,
  extractDeclaredVars,
  cloneExpression,
  type RewriterContext,
} from './rewriter.js';
import { computeStepHash } from './step-hash.js';

export interface SwitchCodeGenInput {
  id: string
  path: string
  version: string
  injectNode: ts.ObjectLiteralExpression | undefined
  typesNode?: ts.Expression
  handler: ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration
  analysis: AnalysisResult
  originalNode?: ts.Node
  typeChecker?: ts.TypeChecker
}

/**
 * Represents a step (case) in the generated switch statement.
 */
export interface Step {
  /** Unique step index (0-based) */
  index: number
  /** Hash for persistence stability */
  hash: string
  /** Step type for semantic meaning */
  type: 'entry' | 'block' | 'resume' | 'branch'
  /** Source line range [start, end] for debugging */
  sourceRange?: [number, number]
  /** Opcodes to execute in this step */
  opcodeRange: { start: number; end: number }
  /** Next step after execution (if not suspended/returned) */
  nextStep?: number
  /** For resume steps: the rehydration deps */
  rehydrateDeps?: string[]
  /** For race branches: branch info */
  branchInfo?: { raceOpcodeIndex: number; branchId: string }
}

/**
 * Result of building steps from opcodes.
 */
export interface StepBuildResult {
  steps: Step[]
  stepMap: Record<string, number>
  sourceMap: Record<number, [number, number]>
}

/**
 * Get the using variables that need rehydration for a step executing the
 * opcode range `[start, end)`.
 *
 * On resume, any `using` var whose initializer runs in this step (via a REHYDRATE
 * opcode) needs to be re-run. Three passes:
 *
 * 1. Vars whose REHYDRATE opcode lives in `[start, end)` - they're local to this step.
 * 2. Vars referenced in BLOCK opcodes within `[start, end)` whose `usedInBlocks` overlaps.
 * 3. Transitive deps: if var A's initializer references using-var B, B must
 *    also be in the prelude. We resolve transitivity here so the caller can
 *    topologically sort them in the emitter.
 *
 * Scanning is bounded to `[start, end)` to avoid leaking vars from sibling race
 * branches or later steps - replaying branch A must never run branch B's
 * `await rooms.lock(...)` just because B's opcodes live after A's in the flat
 * opcode list.
 */
function getRehydrateDepsForStep(
  analysis: AnalysisResult,
  start: number,
  end: number,
): string[] | undefined {
  const { opcodes, rehydrationBlocks } = analysis;
  const usingVarNames = Object.keys(rehydrationBlocks);
  if (usingVarNames.length === 0) return undefined;
  const usingVarSet = new Set(usingVarNames);

  const needed = new Set<string>();

  // REHYDRATE opcodes within [start, end): vars initialized here must be re-run on resume.
  for (let i = start; i < end; i++) {
    const op = opcodes[i];
    if (op.op === 'REHYDRATE') {
      needed.add(op.var);
    }
  }

  // BLOCK opcodes within [start, end): vars referenced (but declared earlier) also need rehydration.
  const usedBlockIds = new Set<number>();
  for (let i = start; i < end; i++) {
    const op = opcodes[i];
    if (op.op === 'BLOCK' && op.blockId !== undefined) {
      usedBlockIds.add(op.blockId);
    }
  }
  for (const varName of usingVarNames) {
    const varInfo = analysis.variables.get(varName);
    if (varInfo && varInfo.usedInBlocks.some(blockId => usedBlockIds.has(blockId))) {
      needed.add(varName);
    }
  }

  // Transitive deps: if A's initializer references using-var B, B must also be rehydrated.
  // Per-opcode REHYDRATE expressions take priority over the global rehydrationBlocks map.
  const opcodeExprByVar = new Map<string, ts.Expression>();
  for (let i = start; i < end; i++) {
    const op = opcodes[i];
    if (op.op === 'REHYDRATE') {
      opcodeExprByVar.set(op.var, op.expression);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const varName of Array.from(needed)) {
      // Get the initializer expression for this var
      const expr = opcodeExprByVar.get(varName) ?? rehydrationBlocks[varName]?.expression;
      if (!expr) continue;
      // Walk the expression to find referenced using-vars
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && usingVarSet.has(node.text) && !needed.has(node.text)) {
          needed.add(node.text);
          changed = true;
        }
        ts.forEachChild(node, visit);
      };
      visit(expr);
    }
  }

  return needed.size > 0 ? Array.from(needed) : undefined;
}

/**
 * Build steps from opcodes.
 * Steps are created for:
 * 1. Entry point (step 0)
 * 2. After each suspension point (WAIT, RACE_SUSPEND)
 * 3. Jump targets (after JUMP_IF, LABEL targets)
 * 4. Race branch handlers
 */
export function buildSteps(analysis: AnalysisResult): StepBuildResult {
  const { opcodes, opcodeSourceNodes, raceBranchSourceNodes } = analysis;
  const steps: Step[] = [];
  const stepMap: Record<string, number> = {};
  const sourceMap: Record<number, [number, number]> = {};

  // First pass: identify step boundaries
  const stepBoundaries = new Set<number>();
  stepBoundaries.add(0); // Entry point

  for (let i = 0; i < opcodes.length; i++) {
    const op = opcodes[i];

    // After WAIT: next opcode is a resume point
    if (op.op === 'WAIT' && i + 1 < opcodes.length) {
      stepBoundaries.add(i + 1);
    }

    // After RACE_SUSPEND: each branch jumpTarget is a resume point
    if (op.op === 'RACE_SUSPEND') {
      // Find the preceding RACE_START
      for (let j = i - 1; j >= 0; j--) {
        const prevOp = opcodes[j];
        if (prevOp.op === 'RACE_START') {
          for (const branch of prevOp.branches) {
            stepBoundaries.add(branch.jumpTarget);
          }
          break;
        }
      }
    }

    // JUMP targets
    if (op.op === 'JUMP') {
      stepBoundaries.add(op.target);
    }

    // JUMP_IF targets (both true and false paths)
    if (op.op === 'JUMP_IF') {
      stepBoundaries.add(op.target);
      if (i + 1 < opcodes.length) {
        stepBoundaries.add(i + 1); // Fall-through path
      }
    }

    // LABEL is a jump target
    if (op.op === 'LABEL') {
      stepBoundaries.add(i);
    }

    // ITER_NEXT doneTarget is a jump target
    if (op.op === 'ITER_NEXT') {
      stepBoundaries.add(op.doneTarget);
    }

    // After PARALLEL_WAIT: next opcode (PARALLEL_COLLECT) is a resume point
    if (op.op === 'PARALLEL_WAIT' && i + 1 < opcodes.length) {
      stepBoundaries.add(i + 1);
    }

    // After SCOPE_WAIT or SCOPE_HANDLER: next opcode is a resume point
    if ((op.op === 'SCOPE_WAIT' || op.op === 'SCOPE_HANDLER') && i + 1 < opcodes.length) {
      stepBoundaries.add(i + 1);
    }

    // SUBPROCESS_SPAWN: next opcode is a resume point (subprocess may suspend)
    if (op.op === 'SUBPROCESS_SPAWN' && i + 1 < opcodes.length) {
      stepBoundaries.add(i + 1);
    }
  }

  // Sort boundaries
  const sortedBoundaries = Array.from(stepBoundaries).sort((a, b) => a - b);

  // Second pass: create steps
  for (let i = 0; i < sortedBoundaries.length; i++) {
    const start = sortedBoundaries[i];
    const end = i + 1 < sortedBoundaries.length ? sortedBoundaries[i + 1] : opcodes.length;

    // Skip empty ranges
    if (start >= opcodes.length) continue;

    // Determine step type and branch info
    let type: Step['type'] = 'block';
    let branchInfo: { raceOpcodeIndex: number; branchId: string } | undefined;
    if (start === 0) {
      type = 'entry';
    } else {
      // Check if this is a resume after WAIT or PARALLEL_WAIT
      const prevOp = start > 0 ? opcodes[start - 1] : null;
      if (prevOp?.op === 'WAIT' || prevOp?.op === 'PARALLEL_WAIT') {
        type = 'resume';
      }
      // Check if this is a race branch target
      for (let j = 0; j < start; j++) {
        const op = opcodes[j];
        if (op.op === 'RACE_START') {
          for (const branch of op.branches) {
            if (branch.jumpTarget === start) {
              type = 'branch';
              branchInfo = { raceOpcodeIndex: j, branchId: branch.id };
              break;
            }
          }
        }
      }
    }

    // Get rehydrate deps for resume points (both WAIT resume and race branches).
    // Only consider blocks inside THIS step's opcode range - pulling deps from
    // later steps or sibling race branches leaks cross-branch `using` vars.
    let rehydrateDeps: string[] | undefined;
    if (start > 0 && (type === 'resume' || type === 'branch')) {
      rehydrateDeps = getRehydrateDepsForStep(analysis, start, end);
    }

    // Compute source range
    let sourceRange: [number, number] | undefined;

    // For branch steps, use the race branch source node (the case clause)
    if (type === 'branch' && branchInfo) {
      const branchNodes = raceBranchSourceNodes.get(branchInfo.raceOpcodeIndex);
      const branchNode = branchNodes?.get(branchInfo.branchId);
      if (branchNode) {
        const sf = branchNode.getSourceFile();
        if (sf) {
          const startLine = sf.getLineAndCharacterOfPosition(branchNode.getStart()).line + 1;
          const endLine = sf.getLineAndCharacterOfPosition(branchNode.getEnd()).line + 1;
          sourceRange = [startLine, endLine];
        }
      }
    }

    // For other steps or as fallback, use opcodes in the range
    if (!sourceRange) {
      for (let j = start; j < end; j++) {
        const sourceNode = opcodeSourceNodes[j];
        if (sourceNode) {
          const sf = sourceNode.getSourceFile();
          if (sf) {
            const startLine = sf.getLineAndCharacterOfPosition(sourceNode.getStart()).line + 1;
            const endLine = sf.getLineAndCharacterOfPosition(sourceNode.getEnd()).line + 1;
            if (!sourceRange) {
              sourceRange = [startLine, endLine];
            } else {
              sourceRange[0] = Math.min(sourceRange[0], startLine);
              sourceRange[1] = Math.max(sourceRange[1], endLine);
            }
          }
        }
      }
    }

    // Compute hash
    const hashInput = {
      type,
      opcodeRange: { start, end },
      index: steps.length,
    };
    const hash = computeStepHash(hashInput, analysis, start);

    const step: Step = {
      index: steps.length,
      hash,
      type,
      sourceRange,
      opcodeRange: { start, end },
      rehydrateDeps,
      branchInfo,
    };

    // Determine next step
    if (end < opcodes.length && !stepBoundaries.has(end)) {
      // Find the step that contains the next opcode
      const nextBoundary = sortedBoundaries.find(b => b > end);
      if (nextBoundary !== undefined) {
        // Will be patched after all steps are created
      }
    }

    stepMap[hash] = step.index;
    if (sourceRange) {
      sourceMap[step.index] = sourceRange;
    }
    steps.push(step);
  }

  // Third pass: patch nextStep references
  // First, compute each race branch's opcode range so we can determine
  // which steps belong to which branch body.
  // Map: raceOpcodeIndex -> array of { branchId, startOpcode, endOpcode }
  const raceBranchRanges = new Map<number, Array<{ branchId: string; start: number; end: number }>>();
  for (let i = 0; i < opcodes.length; i++) {
    const op = opcodes[i];
    if (op.op === 'RACE_START') {
      const ranges: Array<{ branchId: string; start: number; end: number }> = [];
      for (let b = 0; b < op.branches.length; b++) {
        const branch = op.branches[b];
        const start = branch.jumpTarget;
        // End is the next branch's start, or the end of all opcodes
        const end = b + 1 < op.branches.length
          ? op.branches[b + 1].jumpTarget
          : opcodes.length;
        ranges.push({ branchId: branch.id, start, end });
      }
      raceBranchRanges.set(i, ranges);
    }
  }

  // Find the continuation step for each race (first step after all branch bodies)
  const raceContinuationSteps = new Map<number, number>();
  for (const [raceIdx, ranges] of raceBranchRanges) {
    const lastRange = ranges[ranges.length - 1];
    // Find the first step whose opcodes start at or after the last branch's end
    const continuationStep = steps.find(s => s.opcodeRange.start >= lastRange.end);
    if (continuationStep) {
      raceContinuationSteps.set(raceIdx, continuationStep.index);
    }
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const endOpcodeIdx = step.opcodeRange.end - 1;

    if (endOpcodeIdx >= 0 && endOpcodeIdx < opcodes.length) {
      const lastOp = opcodes[endOpcodeIdx];


      // If last opcode is JUMP, set nextStep to the target step
      if (lastOp.op === 'JUMP') {
        const targetStep = steps.find(s => s.opcodeRange.start === lastOp.target);
        if (targetStep) {
          step.nextStep = targetStep.index;
        }
      }
      // If last opcode is WAIT, RACE_SUSPEND, or PARALLEL_WAIT, no nextStep (handled by resume handler)
      else if (lastOp.op === 'WAIT' || lastOp.op === 'RACE_SUSPEND' || lastOp.op === 'PARALLEL_WAIT' || lastOp.op === 'SCOPE_WAIT' || lastOp.op === 'SCOPE_HANDLER') {
        // No nextStep - will be set by resume handler
      }
      // If last opcode is RETURN, no nextStep
      else if (lastOp.op === 'RETURN') {
        // No nextStep
      }
      // Race branch entry: nextStep depends on whether the branch has
      // intermediate steps (e.g. for-of loops creating additional steps).
      // If the next step is still within this branch's body, flow to it.
      // Otherwise, jump to the continuation step after all race branches.
      else if (step.type === 'branch' && step.branchInfo) {
        if (i + 1 < steps.length) {
          const nextStepCandidate = steps[i + 1];
          // Check if next step is another branch entry of the same race
          const isNextBranchEntry = nextStepCandidate.type === 'branch' &&
            nextStepCandidate.branchInfo?.raceOpcodeIndex === step.branchInfo.raceOpcodeIndex;
          if (isNextBranchEntry) {
            // This branch is a single step; jump to continuation after all branches
            let continuation = raceContinuationSteps.get(step.branchInfo.raceOpcodeIndex);
            if (continuation === undefined) {
              // No continuation found by opcode range (happens when last branch extends
              // to end of opcodes, e.g. race inside while(true)). Find the first non-branch
              // step after all branches of this race.
              for (let j = i + 1; j < steps.length; j++) {
                const candidate = steps[j];
                if (candidate.type !== 'branch' || candidate.branchInfo?.raceOpcodeIndex !== step.branchInfo!.raceOpcodeIndex) {
                  continuation = candidate.index;
                  raceContinuationSteps.set(step.branchInfo!.raceOpcodeIndex, continuation);
                  break;
                }
              }
            }
            if (continuation !== undefined) {
              step.nextStep = continuation;
            }
          } else {
            // Branch has more steps; flow to the next one
            step.nextStep = nextStepCandidate.index;
          }
        } else {
          // Last step overall - use continuation if available
          const continuation = raceContinuationSteps.get(step.branchInfo.raceOpcodeIndex);
          if (continuation !== undefined) {
            step.nextStep = continuation;
          }
        }
      }
      // Otherwise, nextStep is the following step - but check if we're at
      // the end of a race branch body, in which case we need to jump to
      // the continuation step (past all branches) instead of falling into
      // the next branch's entry.
      else if (i + 1 < steps.length) {
        const nextCandidate = steps[i + 1];
        // Check if next step is a branch entry (of any race) while current
        // step is within that race's branch body
        if (nextCandidate.type === 'branch' && nextCandidate.branchInfo) {
          const ranges = raceBranchRanges.get(nextCandidate.branchInfo.raceOpcodeIndex);
          const isInSameRace = ranges?.some(
            r => step.opcodeRange.start >= r.start && step.opcodeRange.start < r.end
          );
          if (isInSameRace) {
            // Current step is the last step of a branch body - jump to continuation
            const continuation = raceContinuationSteps.get(nextCandidate.branchInfo.raceOpcodeIndex);
            if (continuation !== undefined) {
              step.nextStep = continuation;
            }
            // else: no continuation (race is at end of handler) - no nextStep
          } else {
            step.nextStep = nextCandidate.index;
          }
        } else {
          step.nextStep = nextCandidate.index;
        }
      }
    }
  }

  return { steps, stepMap, sourceMap };
}

/**
 * Generate the compiled switch-based process.
 */
export function generateSwitchProcess(
  factory: ts.NodeFactory,
  input: SwitchCodeGenInput
): ts.Expression {
  const { id, path, version, injectNode, handler, analysis, originalNode } = input;

  // Build rewriter context
  // Subprocess varNames are compile-time constructs - the compiler emits
  // SUBPROCESS_SPAWN opcodes for calls to them, so they must never be
  // rewritten to state.vars.* or treated as persisted locals.
  const subprocessVarNames = new Set(analysis.subprocesses.map(s => s.varName));
  const rewriterCtx: RewriterContext = {
    paramVars: extractParamVars(handler),
    paramAliases: extractParamAliases(handler),
    serviceVars: extractServiceVars(handler),
    localVars: new Set(
      Array.from(analysis.variables.entries())
        .filter(([name, info]) => !info.isUsing && !subprocessVarNames.has(name))
        .map(([name]) => name)
    ),
    usingVars: new Set(
      Array.from(analysis.variables.entries())
        .filter(([_, info]) => info.isUsing)
        .map(([name]) => name)
    ),
    raceVars: analysis.raceVars,
  };

  // Build steps from opcodes
  const { steps, stepMap, sourceMap } = buildSteps(analysis);

  // Generate the execute function
  const executeFunction = generateExecuteFunction(factory, steps, analysis, rewriterCtx, handler);

  // Build property assignments for the __createProcess call
  const processProperties: ts.ObjectLiteralElementLike[] = [
    factory.createPropertyAssignment('id', factory.createStringLiteral(id)),
    factory.createPropertyAssignment('path', factory.createStringLiteral(path)),
    factory.createPropertyAssignment('version', factory.createStringLiteral(version)),
    factory.createPropertyAssignment(
      'inject',
      injectNode ?? factory.createObjectLiteralExpression([])
    ),
    factory.createPropertyAssignment(
      'stepMap',
      generateStepMapObject(factory, stepMap)
    ),
    factory.createPropertyAssignment(
      'sourceMap',
      generateSourceMapObject(factory, sourceMap)
    ),
    factory.createPropertyAssignment(
      'signals',
      generateSignalsObject(factory, analysis.signals)
    ),
    factory.createPropertyAssignment('execute', executeFunction),
  ];

  // Emit types config when provided (for runtime ref wrapping of params)
  if (input.typesNode) {
    processProperties.push(
      factory.createPropertyAssignment('types', input.typesNode)
    );
  }

  // Emit exports metadata when handler uses `using exports = { ... }`
  if (analysis.exports) {
    processProperties.push(
      factory.createPropertyAssignment(
        'exports',
        generateExportsMetadata(factory, analysis.exports)
      )
    );
  }

  // Emit subprocess definitions
  if (analysis.subprocesses.length > 0) {
    processProperties.push(
      factory.createPropertyAssignment(
        'subprocesses',
        factory.createArrayLiteralExpression(
          analysis.subprocesses.map(sub => generateSubProcessDefinition(factory, sub, rewriterCtx.serviceVars)),
          true
        )
      )
    );
  }

  // Build the __createProcess({ ... }) call
  const callExpr: ts.Expression = factory.createCallExpression(
    factory.createIdentifier('__createProcess'),
    undefined,
    [factory.createObjectLiteralExpression(processProperties, true)]
  );

  // If exports exist, wrap with a type assertion so TExports flows through to the declaration
  if (analysis.exports && input.typeChecker) {
    const exportsTypeNode = buildExportsTypeNode(factory, analysis.exports, input.typeChecker);
    if (exportsTypeNode) {
      // Emit: __createProcess({...}) as __WithExports<typeof __createProcess({...}), TExports>
      // We use a helper type to avoid repeating all generic args.
      // __withExports is: <T, E>(def: T) => T & { data: E }
      // Add a phantom property to carry TExports through to __createProcess.
      // __createProcess infers TExports from compiled.__exportsType.
      processProperties.push(
        factory.createPropertyAssignment(
          '__exportsType',
          factory.createAsExpression(
            factory.createVoidExpression(factory.createNumericLiteral(0)),
            exportsTypeNode,
          ),
        ),
      );
    }
  }

  if (originalNode) {
    return ts.setTextRange(callExpr, originalNode);
  }
  return callExpr;
}

/**
 * Generate the stepMap object: { 'entry_abc': 0, ... }
 */
function generateStepMapObject(
  factory: ts.NodeFactory,
  stepMap: Record<string, number>
): ts.ObjectLiteralExpression {
  return factory.createObjectLiteralExpression(
    Object.entries(stepMap).map(([hash, index]) =>
      factory.createPropertyAssignment(
        factory.createStringLiteral(hash),
        factory.createNumericLiteral(index)
      )
    ),
    true
  );
}

/**
 * Generate the sourceMap object: { 0: [5, 10], ... }
 */
function generateSourceMapObject(
  factory: ts.NodeFactory,
  sourceMap: Record<number, [number, number]>
): ts.ObjectLiteralExpression {
  return factory.createObjectLiteralExpression(
    Object.entries(sourceMap).map(([index, range]) =>
      factory.createPropertyAssignment(
        factory.createNumericLiteral(parseInt(index)),
        factory.createArrayLiteralExpression([
          factory.createNumericLiteral(range[0]),
          factory.createNumericLiteral(range[1]),
        ])
      )
    ),
    true
  );
}

/**
 * Generate the signals object.
 */
function generateSignalsObject(
  factory: ts.NodeFactory,
  signals: Record<string, { identity: string[]; payloadType: string }>
): ts.ObjectLiteralExpression {
  return factory.createObjectLiteralExpression(
    Object.entries(signals).map(([name, info]) =>
      factory.createPropertyAssignment(
        factory.createStringLiteral(name),
        factory.createObjectLiteralExpression([
          factory.createPropertyAssignment(
            'identity',
            factory.createArrayLiteralExpression(
              info.identity.map(i => factory.createStringLiteral(i))
            )
          ),
          factory.createPropertyAssignment(
            'payloadType',
            factory.createStringLiteral(info.payloadType)
          ),
        ])
      )
    ),
    true
  );
}

/**
 * Generate a compiled subprocess definition object.
 * Each subprocess gets its own execute function, step map, and signal definitions.
 */
function generateSubProcessDefinition(
  factory: ts.NodeFactory,
  sub: SubProcessInfo,
  parentServiceVars: Set<string> = new Set()
): ts.ObjectLiteralExpression {
  const subAnalysis = sub.analysis;

  // Build subprocess rewriter context.
  // The subprocess handler closes over the parent's injected services, so
  // identifiers like `signals` must be rewritten to `services.signals` just
  // as they are in the parent execute function. Inherit parent serviceVars.
  const subRewriterCtx: RewriterContext = {
    paramVars: new Set(sub.handlerParams),
    paramAliases: new Map(),
    serviceVars: parentServiceVars,
    localVars: new Set(
      Array.from(subAnalysis.variables.entries())
        .filter(([_, info]) => !info.isUsing)
        .map(([name]) => name)
    ),
    usingVars: new Set(
      Array.from(subAnalysis.variables.entries())
        .filter(([_, info]) => info.isUsing)
        .map(([name]) => name)
    ),
    raceVars: subAnalysis.raceVars,
  };

  // Build steps from subprocess opcodes
  const { steps, stepMap } = buildSteps(subAnalysis);

  // Generate the subprocess execute function
  const executeFunction = generateExecuteFunction(factory, steps, subAnalysis, subRewriterCtx, sub.handlerNode);

  const properties: ts.ObjectLiteralElementLike[] = [
    factory.createPropertyAssignment('name', factory.createStringLiteral(sub.name)),
    factory.createPropertyAssignment('path', factory.createStringLiteral(sub.path)),
    factory.createPropertyAssignment(
      'params',
      factory.createArrayLiteralExpression(sub.handlerParams.map(p => factory.createStringLiteral(p)))
    ),
    factory.createPropertyAssignment('stepMap', generateStepMapObject(factory, stepMap)),
    factory.createPropertyAssignment('signals', generateSignalsObject(factory, subAnalysis.signals)),
    factory.createPropertyAssignment('execute', executeFunction),
  ];

  if (subAnalysis.exports) {
    properties.push(
      factory.createPropertyAssignment('exports', generateExportsMetadata(factory, subAnalysis.exports))
    );
  }

  return factory.createObjectLiteralExpression(properties, true);
}

/**
 * Build a TypeNode for the exports type using the type checker.
 * Extracts the type from the `using exports = { ... }` declaration and converts
 * it to a TypeNode that can be emitted as a type argument on __createProcess.
 */
function buildExportsTypeNode(
  factory: ts.NodeFactory,
  exports: ExportsInfo,
  typeChecker: ts.TypeChecker,
): ts.TypeNode | undefined {
  const declNode = exports.declarationNode;
  if (!ts.isVariableDeclaration(declNode)) return undefined;

  const type = typeChecker.getTypeAtLocation(declNode);
  const typeNode = typeChecker.typeToTypeNode(
    type,
    declNode,
    ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.WriteArrayAsGenericType,
  );
  return typeNode;
}

/**
 * Generate exports metadata: { fields: ['count', 'name'], methods: { getCount() { ... } } }
 * Methods are emitted as-is from the source AST so they can be reattached on resume.
 */
function generateExportsMetadata(
  factory: ts.NodeFactory,
  exports: ExportsInfo
): ts.ObjectLiteralExpression {
  const fieldsArray = factory.createArrayLiteralExpression(
    exports.fields.map(f => factory.createStringLiteral(f.name))
  );

  const methodProperties: ts.ObjectLiteralElementLike[] = [];
  for (const method of exports.methods) {
    if (ts.isMethodDeclaration(method.node)) {
      // method declaration: getCount() { ... } -> getCount: function() { ... }
      const funcExpr = factory.createFunctionExpression(
        method.node.modifiers?.filter(m => m.kind === ts.SyntaxKind.AsyncKeyword),
        undefined,
        undefined,
        method.node.typeParameters,
        method.node.parameters,
        method.node.type,
        method.node.body ?? factory.createBlock([])
      );
      methodProperties.push(
        factory.createPropertyAssignment(factory.createStringLiteral(method.name), funcExpr)
      );
    } else if (ts.isPropertyAssignment(method.node)) {
      // arrow/function expression: getFirst: () => 'x' or compute: function() { ... }
      methodProperties.push(
        factory.createPropertyAssignment(
          factory.createStringLiteral(method.name),
          method.node.initializer
        )
      );
    }
  }

  return factory.createObjectLiteralExpression([
    factory.createPropertyAssignment('fields', fieldsArray),
    factory.createPropertyAssignment(
      'methods',
      factory.createObjectLiteralExpression(methodProperties, true)
    ),
  ], true);
}

/**
 * Generate the execute function.
 */
function generateExecuteFunction(
  factory: ts.NodeFactory,
  steps: Step[],
  analysis: AnalysisResult,
  rewriterCtx: RewriterContext,
  handler: ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration
): ts.ArrowFunction {
  // Get the handler's closing brace for source mapping the function exit
  const handlerBody = handler.body;
  const closingBracePos = handlerBody && ts.isBlock(handlerBody) ? handlerBody.end : handler.end;
  const statements: ts.Statement[] = [];

  // Source range for the original handler, used to map generated boilerplate
  const handlerRange = { pos: handler.pos, end: handler.end };

  // const { state, services } = ctx
  const ctxDestructure = factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [
        factory.createVariableDeclaration(
          factory.createObjectBindingPattern([
            factory.createBindingElement(undefined, undefined, 'state'),
            factory.createBindingElement(undefined, undefined, 'services'),
          ]),
          undefined,
          undefined,
          factory.createIdentifier('ctx')
        ),
      ],
      ts.NodeFlags.Const
    )
  );
  ts.setSourceMapRange(ctxDestructure, handlerRange);
  statements.push(ctxDestructure);

  // Declare local variables for using vars
  const usingVars = Array.from(rewriterCtx.usingVars);
  if (usingVars.length > 0) {
    statements.push(
      factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(
          usingVars.map(v =>
            factory.createVariableDeclaration(v, undefined, undefined, undefined)
          ),
          ts.NodeFlags.Let
        )
      )
    );
  }

  // let step = state.step | 0
  const stepDecl = factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [
        factory.createVariableDeclaration(
          'step',
          undefined,
          undefined,
          factory.createBinaryExpression(
            factory.createPropertyAccessExpression(
              factory.createIdentifier('state'),
              'step'
            ),
            ts.SyntaxKind.BarToken,
            factory.createNumericLiteral(0)
          )
        ),
      ],
      ts.NodeFlags.Let
    )
  );
  ts.setSourceMapRange(stepDecl, handlerRange);
  statements.push(stepDecl);

  // const __r: [number, unknown] = [0, undefined]
  const rDecl = factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [
        factory.createVariableDeclaration(
          '__r',
          undefined,
          factory.createTupleTypeNode([
            factory.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword),
            factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          ]),
          factory.createArrayLiteralExpression([
            factory.createNumericLiteral(0),
            factory.createIdentifier('undefined'),
          ])
        ),
      ],
      ts.NodeFlags.Const
    )
  );
  ts.setSourceMapRange(rDecl, handlerRange);
  statements.push(rDecl);

  // let __blockResult: unknown
  const blockResultDecl = factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [
        factory.createVariableDeclaration(
          '__blockResult',
          undefined,
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          undefined
        ),
      ],
      ts.NodeFlags.Let
    )
  );
  ts.setSourceMapRange(blockResultDecl, handlerRange);
  statements.push(blockResultDecl);

  // let __raceResult: unknown
  const raceResultDecl = factory.createVariableStatement(
    undefined,
    factory.createVariableDeclarationList(
      [
        factory.createVariableDeclaration(
          '__raceResult',
          undefined,
          factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
          undefined
        ),
      ],
      ts.NodeFlags.Let
    )
  );
  ts.setSourceMapRange(raceResultDecl, handlerRange);
  statements.push(raceResultDecl);

  // const __dispose: (Disposable | undefined)[] = [undefined, ...]
  if (usingVars.length > 0) {
    statements.push(
      factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(
          [
            factory.createVariableDeclaration(
              '__dispose',
              undefined,
              undefined,
              factory.createArrayLiteralExpression(
                usingVars.map(() => factory.createIdentifier('undefined'))
              )
            ),
          ],
          ts.NodeFlags.Const
        )
      )
    );

    // let __dispose_i = 0
    statements.push(
      factory.createVariableStatement(
        undefined,
        factory.createVariableDeclarationList(
          [
            factory.createVariableDeclaration(
              '__dispose_i',
              undefined,
              undefined,
              factory.createNumericLiteral(0)
            ),
          ],
          ts.NodeFlags.Let
        )
      )
    );
  }

  // Generate the main_loop: while (true) { switch (step) { ... } }
  const switchCases: ts.CaseOrDefaultClause[] = steps.map(step =>
    generateSwitchCase(factory, step, steps, analysis, rewriterCtx)
  );

  // Add default case
  switchCases.push(
    factory.createDefaultClause([
      factory.createThrowStatement(
        factory.createNewExpression(
          factory.createIdentifier('Error'),
          undefined,
          [
            factory.createTemplateExpression(
              factory.createTemplateHead('Invalid step: '),
              [
                factory.createTemplateSpan(
                  factory.createIdentifier('step'),
                  factory.createTemplateTail('')
                ),
              ]
            ),
          ]
        )
      ),
    ])
  );

  const switchStatement = factory.createSwitchStatement(
    factory.createIdentifier('step'),
    factory.createCaseBlock(switchCases)
  );

  const whileStatement = factory.createWhileStatement(
    factory.createTrue(),
    factory.createBlock([switchStatement], true)
  );

  // Add label: main_loop
  const labeledWhile = factory.createLabeledStatement('main_loop', whileStatement);
  statements.push(labeledWhile);

  // Cleanup: dispose using vars
  if (usingVars.length > 0) {
    // while (__dispose_i > 0) { __dispose[--__dispose_i]?.[Symbol.dispose]?.() }
    statements.push(
      factory.createWhileStatement(
        factory.createBinaryExpression(
          factory.createIdentifier('__dispose_i'),
          ts.SyntaxKind.GreaterThanToken,
          factory.createNumericLiteral(0)
        ),
        factory.createBlock([
          factory.createExpressionStatement(
            factory.createCallChain(
              factory.createElementAccessChain(
                factory.createElementAccessChain(
                  factory.createIdentifier('__dispose'),
                  factory.createToken(ts.SyntaxKind.QuestionDotToken),
                  factory.createPrefixUnaryExpression(
                    ts.SyntaxKind.MinusMinusToken,
                    factory.createIdentifier('__dispose_i')
                  )
                ),
                factory.createToken(ts.SyntaxKind.QuestionDotToken),
                factory.createPropertyAccessExpression(
                  factory.createIdentifier('Symbol'),
                  'dispose'
                )
              ),
              factory.createToken(ts.SyntaxKind.QuestionDotToken),
              undefined,
              []
            )
          ),
        ])
      )
    );
  }

  // Suspend handling: persist locals to state
  // if (__r[0] === 1) { state.step = step; ... }
  // Map to closing brace - this is function exit logic
  const stateStepAssign = factory.createExpressionStatement(
    factory.createBinaryExpression(
      factory.createPropertyAccessExpression(
        factory.createIdentifier('state'),
        'step'
      ),
      ts.SyntaxKind.EqualsToken,
      factory.createIdentifier('step')
    )
  );
  const suspendIfStmt = factory.createIfStatement(
    factory.createBinaryExpression(
      factory.createElementAccessExpression(
        factory.createIdentifier('__r'),
        factory.createNumericLiteral(0)
      ),
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      factory.createNumericLiteral(0) // not DONE - save step on SUSPEND or SUBPROCESS
    ),
    factory.createBlock([
      stateStepAssign,
      // Locals are already persisted: block rewriting transforms `const x = ...`
      // to `state.vars.x = ...`, so all locals survive suspension points.
    ])
  );
  const closingRange = { pos: closingBracePos - 1, end: closingBracePos };
  ts.setSourceMapRange(stateStepAssign, closingRange);
  ts.setTextRange(suspendIfStmt, closingRange);
  ts.setSourceMapRange(suspendIfStmt, closingRange);
  statements.push(suspendIfStmt);

  // return __r - map to closing brace for clean function exit in debugger
  const returnStmt = factory.createReturnStatement(factory.createIdentifier('__r'));
  ts.setTextRange(returnStmt, closingRange);
  ts.setSourceMapRange(returnStmt, closingRange);
  statements.push(returnStmt);

  // Create the async arrow function
  const arrowFn = factory.createArrowFunction(
    [factory.createModifier(ts.SyntaxKind.AsyncKeyword)],
    undefined,
    [factory.createParameterDeclaration(undefined, undefined, 'ctx')],
    undefined,
    factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    factory.createBlock(statements, true)
  );

  // Map generated nodes back to original handler for source maps
  ts.setSourceMapRange(arrowFn, handlerRange);
  if (handlerBody && ts.isBlock(handlerBody)) {
    const bodyRange = { pos: handlerBody.pos, end: handlerBody.end };
    ts.setSourceMapRange(switchStatement, bodyRange);
    ts.setSourceMapRange(whileStatement, bodyRange);
    ts.setSourceMapRange(labeledWhile, bodyRange);
  }

  return arrowFn;
}

/**
 * Emit a single rehydrate-prelude entry: varName = expr; __dispose[__dispose_i++] = varName.
 * Uses the expression from the REHYDRATE opcode so that sibling branches with the same
 * variable name each use their own initializer.
 */
function emitRehydrateEntry(
  factory: ts.NodeFactory,
  varName: string,
  expression: ts.Expression,
  rewriterCtx: RewriterContext,
  out: ts.Statement[]
): void {
  const rewrittenExpr = rewriteExpression(factory, expression, rewriterCtx);
  out.push(
    factory.createExpressionStatement(
      factory.createBinaryExpression(
        factory.createIdentifier(varName),
        ts.SyntaxKind.EqualsToken,
        rewrittenExpr
      )
    )
  );
  out.push(
    factory.createExpressionStatement(
      factory.createBinaryExpression(
        factory.createElementAccessExpression(
          factory.createIdentifier('__dispose'),
          factory.createPostfixUnaryExpression(
            factory.createIdentifier('__dispose_i'),
            ts.SyntaxKind.PlusPlusToken
          )
        ),
        ts.SyntaxKind.EqualsToken,
        factory.createIdentifier(varName)
      )
    )
  );
}

/**
 * Topologically sort rehydrate deps so that a var whose initializer references
 * another using-var is emitted after that dep.
 *
 * The expression carried on each REHYDRATE opcode is the authoritative source;
 * deps extracted from it tell us what other using-vars must be available first.
 */
function topoSortRehydrateDeps(
  varNames: string[],
  rehydrateOpcodeExprs: Map<string, ts.Expression>,
  usingVars: Set<string>
): string[] {
  // Build adjacency: varName -> set of using-vars it depends on
  const deps = new Map<string, Set<string>>();
  for (const v of varNames) {
    deps.set(v, new Set());
    const expr = rehydrateOpcodeExprs.get(v);
    if (expr) {
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && usingVars.has(node.text) && node.text !== v) {
          deps.get(v)!.add(node.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(expr);
    }
  }

  // Kahn's algorithm
  const inDegree = new Map<string, number>();
  for (const v of varNames) inDegree.set(v, 0);
  for (const [, ds] of deps) {
    for (const d of ds) {
      if (inDegree.has(d)) {
        // d is a dep of something; increment in-degree of the dependent
      }
    }
  }
  // Actually: inDegree[v] = number of vars in varNames that v depends on
  for (const v of varNames) {
    let count = 0;
    for (const d of deps.get(v)!) {
      if (inDegree.has(d)) count++;
    }
    inDegree.set(v, count);
  }

  const queue = varNames.filter(v => inDegree.get(v) === 0);
  const result: string[] = [];
  while (queue.length > 0) {
    const v = queue.shift()!;
    result.push(v);
    // Vars that depend on v can now have their in-degree reduced
    for (const other of varNames) {
      if (deps.get(other)?.has(v)) {
        const newDeg = inDegree.get(other)! - 1;
        inDegree.set(other, newDeg);
        if (newDeg === 0) queue.push(other);
      }
    }
  }

  // If cycle (shouldn't happen in valid code), append remaining
  for (const v of varNames) {
    if (!result.includes(v)) result.push(v);
  }
  return result;
}

/**
 * Generate a switch case for a step.
 */
function generateSwitchCase(
  factory: ts.NodeFactory,
  step: Step,
  steps: Step[],
  analysis: AnalysisResult,
  rewriterCtx: RewriterContext
): ts.CaseClause {
  const { opcodes, rehydrationBlocks } = analysis;
  const caseStatements: ts.Statement[] = [];

  // Add comment with step hash
  // This is done via synthetic comments on the first statement

  // For branch steps, the first opcode is always STORE __raceResult fromRace.
  // That STORE must run before the rehydrate prelude so that initializers that
  // reference the race result (e.g. `using lk = await svc.lock(r.id)`) can
  // resolve `r` correctly.
  //
  // Collect the REHYDRATE opcodes in this step's range so we can:
  //  - use each opcode's own expression (not the global rehydrationBlocks map)
  //    for the correct per-branch initializer
  //  - skip those REHYDRATE opcodes when iterating later (no double-acquire)
  const rehydrateOpcodeExprs = new Map<string, ts.Expression>();
  const rehydrateOpcodeIndices = new Set<number>();
  for (let i = step.opcodeRange.start; i < step.opcodeRange.end; i++) {
    const op = opcodes[i];
    if (op.op === 'REHYDRATE') {
      rehydrateOpcodeExprs.set(op.var, op.expression);
      rehydrateOpcodeIndices.add(i);
    }
  }

  // For branch steps: emit any leading STORE opcodes FIRST, before the rehydrate prelude.
  // Leading STORE opcodes are at the very beginning of the branch range (the fromRace STORE).
  const leadingStoreIndices = new Set<number>();
  if (step.type === 'branch') {
    for (let i = step.opcodeRange.start; i < step.opcodeRange.end; i++) {
      const op = opcodes[i];
      if (op.op === 'STORE' && op.fromRace) {
        const stmts = generateOpcodeStatements(factory, op, step, steps, analysis, rewriterCtx, i);
        const sourceNode = analysis.opcodeSourceNodes[i];
        const stepSourceRng = getStepSourceRange(step, analysis);
        const opcodeRange = sourceNode ? { pos: sourceNode.pos, end: sourceNode.end } : stepSourceRng;
        if (opcodeRange) stmts.forEach(s => ts.setSourceMapRange(s, opcodeRange));
        caseStatements.push(...stmts);
        leadingStoreIndices.add(i);
      } else {
        // Stop at first non-STORE opcode
        break;
      }
    }
  }

  // Handle rehydration prelude for resume steps (and branch steps after STORE).
  // Resolve the expression from the REHYDRATE opcode within this step's range when
  // available (per-branch expression from REHYDRATE opcode), otherwise fall back to rehydrationBlocks.
  if (step.rehydrateDeps && step.rehydrateDeps.length > 0) {
    // Build a map of expressions to use for each dep
    const exprMap = new Map<string, ts.Expression>();
    for (const varName of step.rehydrateDeps) {
      // Prefer the expression carried on the REHYDRATE opcode in this step
      const opcodeExpr = rehydrateOpcodeExprs.get(varName);
      if (opcodeExpr) {
        exprMap.set(varName, opcodeExpr);
      } else {
        // Var was declared in a prior step; look up in global map
        const rehydBlock = rehydrationBlocks[varName];
        if (rehydBlock) exprMap.set(varName, rehydBlock.expression);
      }
    }

    // Topologically sort so deps are emitted before dependents
    const depsToEmit = step.rehydrateDeps.filter(v => exprMap.has(v));
    const sorted = topoSortRehydrateDeps(depsToEmit, exprMap, rewriterCtx.usingVars);

    for (const varName of sorted) {
      const expr = exprMap.get(varName)!;
      emitRehydrateEntry(factory, varName, expr, rewriterCtx, caseStatements);
    }
  }

  // Compute step-level source range for fallback when individual opcodes lack source nodes
  const stepSourceRange = getStepSourceRange(step, analysis);

  // For race-branch steps, thread the continuation step through as the
  // target for unlabeled `break` and `continue` statements that the user
  // wrote inside their `switch(true) { case signal(...): ... }` branch bodies.
  // Both statements inside an if-body of a race branch need to advance `step`
  // to the continuation before restarting main_loop. See transformStatement.
  const stepCtx: RewriterContext =
    step.type === 'branch' && step.nextStep !== undefined
      ? { ...rewriterCtx, breakTarget: step.nextStep, continueTarget: step.nextStep }
      : rewriterCtx;

  // Process opcodes in this step's range, skipping:
  //  - leading STORE opcodes already emitted above (branch steps, branch-result-first ordering)
  //  - REHYDRATE opcodes for vars in the rehydrate prelude (no double-acquire)
  for (let i = step.opcodeRange.start; i < step.opcodeRange.end; i++) {
    if (leadingStoreIndices.has(i)) continue;
    // Skip REHYDRATE opcodes for vars already emitted by the rehydrate prelude (no double-acquire)
    if (rehydrateOpcodeIndices.has(i)) {
      const op = opcodes[i];
      if (op.op === 'REHYDRATE' && step.rehydrateDeps?.includes(op.var)) continue;
    }

    const opcode = opcodes[i];
    const stmts = generateOpcodeStatements(factory, opcode, step, steps, analysis, stepCtx, i);

    // Map generated statements to the opcode's original source node for source maps
    const sourceNode = analysis.opcodeSourceNodes[i];
    const opcodeRange = sourceNode
      ? { pos: sourceNode.pos, end: sourceNode.end }
      : stepSourceRange; // fallback to step-level range
    if (opcodeRange) {
      for (const stmt of stmts) {
        ts.setSourceMapRange(stmt, opcodeRange);
      }
    }

    caseStatements.push(...stmts);
  }

  // Add explicit fallthrough to nextStep if the step doesn't end with a control flow statement.
  // This handles race branches that don't emit JUMP (their break is a no-op).
  if (step.nextStep !== undefined) {
    // Check if last statement is a control flow (break, continue, return equiv)
    const lastStmt = caseStatements[caseStatements.length - 1];
    const hasControlFlow = lastStmt && (
      ts.isBreakStatement(lastStmt) ||
      ts.isContinueStatement(lastStmt)
    );

    if (!hasControlFlow) {
      // step = nextStep; continue main_loop
      caseStatements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createIdentifier('step'),
            ts.SyntaxKind.EqualsToken,
            factory.createNumericLiteral(step.nextStep)
          )
        )
      );
      caseStatements.push(factory.createContinueStatement(factory.createIdentifier('main_loop')));
    }
  }

  // Create the case clause
  const caseClause = factory.createCaseClause(
    factory.createNumericLiteral(step.index),
    [factory.createBlock(caseStatements, true)]
  );

  // Map case clause to original source range for source maps
  const sourceRange = getStepSourceRange(step, analysis);
  if (sourceRange) {
    ts.setSourceMapRange(caseClause, sourceRange);
  }

  return caseClause;
}

/**
 * Get the original source byte range (pos/end) for a step,
 * derived from the opcode source nodes in the analysis.
 */
function getStepSourceRange(
  step: Step,
  analysis: AnalysisResult
): { pos: number; end: number } | undefined {
  const { opcodeSourceNodes, raceBranchSourceNodes } = analysis;

  // For branch steps, prefer the race branch source node
  if (step.type === 'branch' && step.branchInfo) {
    const branchNodes = raceBranchSourceNodes.get(step.branchInfo.raceOpcodeIndex);
    const branchNode = branchNodes?.get(step.branchInfo.branchId);
    if (branchNode) {
      return { pos: branchNode.pos, end: branchNode.end };
    }
  }

  // For other steps, compute range from opcode source nodes
  let pos: number | undefined;
  let end: number | undefined;
  for (let j = step.opcodeRange.start; j < step.opcodeRange.end; j++) {
    const sourceNode = opcodeSourceNodes[j];
    if (sourceNode) {
      if (pos === undefined || sourceNode.pos < pos) pos = sourceNode.pos;
      if (end === undefined || sourceNode.end > end) end = sourceNode.end;
    }
  }
  if (pos !== undefined && end !== undefined) {
    return { pos, end };
  }
  return undefined;
}

/**
 * Transform a statement for codegen.
 * Handles if statements specially - transforming their returns to __r[1] = expr; break main_loop;
 * Returns transformed statements (may be multiple for a single input).
 */
function transformStatement(
  factory: ts.NodeFactory,
  stmt: ts.Statement,
  rewriterCtx: RewriterContext
): ts.Statement[] {
  // Unlabeled `break` inside an if-body of a race branch: rewrite to jump
  // to the race's continuation step. Without this the compiled case ends
  // with a naked `break;` that exits `switch(step)` but leaves `step`
  // unchanged, re-entering the same branch body on the next iteration of
  // `main_loop` - infinite loop.
  //
  // We only rewrite here, not inside user-written for/while/switch bodies
  // (those fall through to the `rewriteStatement` path which preserves
  // their `break` verbatim so it continues to target the user's own
  // construct).
  if (
    ts.isBreakStatement(stmt) &&
    !stmt.label &&
    rewriterCtx.breakTarget !== undefined
  ) {
    return [
      ts.setTextRange(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createIdentifier('step'),
            ts.SyntaxKind.EqualsToken,
            factory.createNumericLiteral(rewriterCtx.breakTarget)
          )
        ),
        stmt
      ),
      factory.createContinueStatement(factory.createIdentifier('main_loop')),
    ];
  }

  // Unlabeled `continue` inside an if-body of a race branch: same class of
  // bug as the `break` case above. A naked `continue` restarts `main_loop`
  // without advancing `step`, causing the same branch body to run again -
  // infinite loop. Rewrite to `step = continueTarget; continue main_loop;`.
  if (
    ts.isContinueStatement(stmt) &&
    !stmt.label &&
    rewriterCtx.continueTarget !== undefined
  ) {
    return [
      ts.setTextRange(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createIdentifier('step'),
            ts.SyntaxKind.EqualsToken,
            factory.createNumericLiteral(rewriterCtx.continueTarget)
          )
        ),
        stmt
      ),
      factory.createContinueStatement(factory.createIdentifier('main_loop')),
    ];
  }

  // Return statement -> __r[1] = expr; break main_loop;
  if (ts.isReturnStatement(stmt)) {
    const returnExpr = stmt.expression
      ? rewriteExpression(factory, stmt.expression, rewriterCtx)
      : factory.createIdentifier('undefined');

    return [
      // __r[0] = 0 (DONE)
      factory.createExpressionStatement(
        factory.createBinaryExpression(
          factory.createElementAccessExpression(
            factory.createIdentifier('__r'),
            factory.createNumericLiteral(0)
          ),
          ts.SyntaxKind.EqualsToken,
          factory.createNumericLiteral(0)
        )
      ),
      // __r[1] = returnExpr
      ts.setTextRange(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createElementAccessExpression(
              factory.createIdentifier('__r'),
              factory.createNumericLiteral(1)
            ),
            ts.SyntaxKind.EqualsToken,
            returnExpr
          )
        ),
        stmt
      ),
      // break main_loop
      factory.createBreakStatement(factory.createIdentifier('main_loop')),
    ];
  }

  // If statement -> transform with rewritten condition and transformed body
  if (ts.isIfStatement(stmt)) {
    const condition = rewriteExpression(factory, stmt.expression, rewriterCtx);

    // Transform then branch
    const thenStatements: ts.Statement[] = [];
    if (ts.isBlock(stmt.thenStatement)) {
      for (const s of stmt.thenStatement.statements) {
        thenStatements.push(...transformStatement(factory, s, rewriterCtx));
      }
    } else {
      thenStatements.push(...transformStatement(factory, stmt.thenStatement, rewriterCtx));
    }

    // Transform else branch if exists
    let elseStatement: ts.Statement | undefined;
    if (stmt.elseStatement) {
      const elseStatements: ts.Statement[] = [];
      if (ts.isBlock(stmt.elseStatement)) {
        for (const s of stmt.elseStatement.statements) {
          elseStatements.push(...transformStatement(factory, s, rewriterCtx));
        }
      } else if (ts.isIfStatement(stmt.elseStatement)) {
        // else if - recursively transform
        elseStatements.push(...transformStatement(factory, stmt.elseStatement, rewriterCtx));
      } else {
        elseStatements.push(...transformStatement(factory, stmt.elseStatement, rewriterCtx));
      }
      elseStatement = factory.createBlock(elseStatements, true);
    }

    return [
      ts.setTextRange(
        factory.createIfStatement(
          condition,
          factory.createBlock(thenStatements, true),
          elseStatement
        ),
        stmt
      ),
    ];
  }

  // Other statements - just rewrite
  return [rewriteStatement(factory, stmt, rewriterCtx)];
}

/**
 * Find the step index that contains a given opcode index.
 */
function findStepIndexForOpcode(steps: Step[], opcodeIndex: number): number {
  for (const step of steps) {
    if (opcodeIndex >= step.opcodeRange.start && opcodeIndex < step.opcodeRange.end) {
      return step.index;
    }
  }
  // If the opcode index is a boundary point, find the step that starts at that index
  const step = steps.find(s => s.opcodeRange.start === opcodeIndex);
  return step?.index ?? 0;
}

/**
 * Wrap an expression with `expr[Symbol.asyncIterator]()` to obtain an iterator from an iterable.
 */
function wrapWithAsyncIterator(factory: ts.NodeFactory, expr: ts.Expression): ts.CallExpression {
  return factory.createCallExpression(
    factory.createElementAccessExpression(
      expr,
      factory.createPropertyAccessExpression(
        factory.createIdentifier('Symbol'),
        'asyncIterator'
      )
    ),
    undefined,
    []
  );
}

/**
 * Generate statements for a single opcode within a step.
 */
function generateOpcodeStatements(
  factory: ts.NodeFactory,
  opcode: AnalysisResult['opcodes'][number],
  step: Step,
  steps: Step[],
  analysis: AnalysisResult,
  rewriterCtx: RewriterContext,
  opcodeIndex: number
): ts.Statement[] {
  const statements: ts.Statement[] = [];
  const { blocks, rehydrationBlocks } = analysis;

  switch (opcode.op) {
    case 'BLOCK': {
      const block = blocks[opcode.blockId];
      if (block && block.statements.length > 0) {
        // Extract variables declared in this block, excluding localVars which persist
        // blockLocalVars are for variables that DON'T need state.vars rewriting
        const allDeclaredVars = extractDeclaredVars(block.statements);
        const blockLocalVars = new Set(
          Array.from(allDeclaredVars).filter(v => !rewriterCtx.localVars.has(v))
        );
        const blockCtx: RewriterContext = { ...rewriterCtx, blockLocalVars };

        // Rewrite and add each statement
        for (const stmt of block.statements) {
          // If statements - transform with special return handling
          if (ts.isIfStatement(stmt)) {
            statements.push(...transformStatement(factory, stmt, blockCtx));
          }
          // Return statements at block level - use __blockResult for later RETURN opcode
          else if (ts.isReturnStatement(stmt)) {
            const returnExpr = stmt.expression
              ? rewriteExpression(factory, stmt.expression, blockCtx)
              : factory.createIdentifier('undefined');

            statements.push(
              ts.setTextRange(
                factory.createExpressionStatement(
                  factory.createBinaryExpression(
                    factory.createIdentifier('__blockResult'),
                    ts.SyntaxKind.EqualsToken,
                    returnExpr
                  )
                ),
                stmt
              )
            );
          }
          // Variable statements - transform localVar declarations to state.vars assignments
          else if (ts.isVariableStatement(stmt)) {
            for (const decl of stmt.declarationList.declarations) {
              if (ts.isIdentifier(decl.name)) {
                const varName = decl.name.text;

                // LocalVar (but not raceVar) -> state.vars.xxx = initializer
                // These need to persist across suspension points
                // Race vars stay local (the result is in __raceResult after resumption)
                if (rewriterCtx.localVars.has(varName) && !rewriterCtx.raceVars.has(varName)) {
                  const initializer = decl.initializer
                    ? rewriteExpression(factory, decl.initializer, blockCtx)
                    : factory.createIdentifier('undefined');

                  statements.push(
                    ts.setTextRange(
                      factory.createExpressionStatement(
                        factory.createBinaryExpression(
                          factory.createPropertyAccessExpression(
                            factory.createPropertyAccessExpression(
                              factory.createIdentifier('state'),
                              'vars'
                            ),
                            varName
                          ),
                          ts.SyntaxKind.EqualsToken,
                          initializer
                        )
                      ),
                      stmt
                    )
                  );
                  continue;
                }
              }

              // Other declarations - keep as variable statement with rewritten initializer
              // This handles usingVars, destructuring, etc.
              const newInitializer = decl.initializer
                ? rewriteExpression(factory, decl.initializer, blockCtx)
                : undefined;
              statements.push(
                factory.createVariableStatement(
                  stmt.modifiers,
                  factory.createVariableDeclarationList(
                    [factory.createVariableDeclaration(decl.name, decl.exclamationToken, decl.type, newInitializer)],
                    stmt.declarationList.flags
                  )
                )
              );
            }
          }
          // Other statements - just rewrite
          else {
            statements.push(rewriteStatement(factory, stmt, blockCtx));
          }
        }
      }
      break;
    }

    case 'STORE': {
      // For race results: __raceResult = state.vars.__raceResult (load from state)
      // For block/signal results: state.vars.varName = __blockResult / ctx.signalPayload
      if (opcode.fromRace) {
        // Load race result from state.vars (set by executor) into local variable
        statements.push(
          factory.createExpressionStatement(
            factory.createBinaryExpression(
              factory.createIdentifier('__raceResult'),
              ts.SyntaxKind.EqualsToken,
              factory.createPropertyAccessExpression(
                factory.createPropertyAccessExpression(
                  factory.createIdentifier('state'),
                  'vars'
                ),
                '__raceResult'
              )
            )
          )
        );
        break;
      }

      // state.vars.varName = __blockResult / ctx.signalPayload
      let valueExpr: ts.Expression;
      if (opcode.fromBlock) {
        valueExpr = factory.createIdentifier('__blockResult');
      } else if (opcode.fromSignal) {
        valueExpr = factory.createPropertyAccessExpression(
          factory.createIdentifier('ctx'),
          'signalPayload'
        );
      } else {
        valueExpr = factory.createIdentifier('undefined');
      }

      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createPropertyAccessExpression(
              factory.createPropertyAccessExpression(
                factory.createIdentifier('state'),
                'vars'
              ),
              opcode.var
            ),
            ts.SyntaxKind.EqualsToken,
            valueExpr
          )
        )
      );
      break;
    }

    case 'REHYDRATE': {
      // Use the expression carried on the opcode (each branch site has its own
      // expression, so two sibling branches declaring `using v = X()` and `using v = Y()`
      // will each emit their own correct initializer rather than sharing the last-write
      // from the global rehydrationBlocks map).
      const expr = opcode.expression ?? rehydrationBlocks[opcode.var]?.expression;
      if (expr) {
        const rewrittenExpr = rewriteExpression(factory, expr, rewriterCtx);
        // varName = await ... (expression may already be an await, don't double-wrap)
        const awaitedExpr = ts.isAwaitExpression(rewrittenExpr)
          ? rewrittenExpr
          : factory.createAwaitExpression(rewrittenExpr);
        statements.push(
          factory.createExpressionStatement(
            factory.createBinaryExpression(
              factory.createIdentifier(opcode.var),
              ts.SyntaxKind.EqualsToken,
              awaitedExpr
            )
          )
        );
        // __dispose[__dispose_i++] = varName
        statements.push(
          factory.createExpressionStatement(
            factory.createBinaryExpression(
              factory.createElementAccessExpression(
                factory.createIdentifier('__dispose'),
                factory.createPostfixUnaryExpression(
                  factory.createIdentifier('__dispose_i'),
                  ts.SyntaxKind.PlusPlusToken
                )
              ),
              ts.SyntaxKind.EqualsToken,
              factory.createIdentifier(opcode.var)
            )
          )
        );
      }
      break;
    }

    case 'WAIT': {
      // Find the resume step for this wait
      const resumeStepIndex = step.nextStep ?? step.index + 1;

      // step = resumeStep
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createIdentifier('step'),
            ts.SyntaxKind.EqualsToken,
            factory.createNumericLiteral(resumeStepIndex)
          )
        )
      );

      // __r[0] = 1 (SUSPEND)
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createElementAccessExpression(
              factory.createIdentifier('__r'),
              factory.createNumericLiteral(0)
            ),
            ts.SyntaxKind.EqualsToken,
            factory.createNumericLiteral(1)
          )
        )
      );

      // __r[1] = { signal: '...' } or { timer: { ... } }
      let suspendConfig: ts.Expression;
      if (opcode.signal === '__timer__') {
        // Timer suspend - use unit-based format: { timer: { seconds: 30 } }
        const timerProperties = opcode.timer
          ? [
            factory.createPropertyAssignment(
              opcode.timer.unit,
              rewriteExpression(factory, cloneExpression(factory, opcode.timer.valueExpr), rewriterCtx)
            ),
          ]
          : [];
        suspendConfig = factory.createObjectLiteralExpression([
          factory.createPropertyAssignment(
            'timer',
            factory.createObjectLiteralExpression(timerProperties)
          ),
        ]);
      } else if (opcode.signalExpr) {
        // Use the signal expression and access .signalName at runtime
        suspendConfig = factory.createObjectLiteralExpression([
          factory.createPropertyAssignment(
            'signal',
            factory.createPropertyAccessExpression(
              rewriteExpression(factory, opcode.signalExpr, rewriterCtx),
              'signalName'
            )
          ),
        ]);
      } else {
        // Fallback to static signal name (legacy)
        suspendConfig = factory.createObjectLiteralExpression([
          factory.createPropertyAssignment(
            'signal',
            factory.createStringLiteral(opcode.signal)
          ),
        ]);
      }

      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createElementAccessExpression(
              factory.createIdentifier('__r'),
              factory.createNumericLiteral(1)
            ),
            ts.SyntaxKind.EqualsToken,
            suspendConfig
          )
        )
      );

      // break main_loop
      statements.push(factory.createBreakStatement(factory.createIdentifier('main_loop')));
      break;
    }

    case 'RACE_START': {
      // Generate race suspend config
      // Convert branch.jumpTarget (opcode index) to step index for each branch
      const raceBranches = opcode.branches.map(branch => {
        const branchStepIndex = findStepIndexForOpcode(steps, branch.jumpTarget);

        // For stream branches (stream:ModelName:*:fieldName), use the static signal name
        // For signal branches, access .signalName on the signal service call
        const isStreamBranch = branch.signal?.startsWith('stream:');
        const signalAssignment = branch.signalExpr
          ? isStreamBranch
            ? [
              // Stream: use the static signal name from analysis (with wildcard)
              factory.createPropertyAssignment(
                'signal',
                factory.createStringLiteral(branch.signal!)
              ),
            ]
            : [
              // Signal: access .signalName on the rewritten signal expression
              factory.createPropertyAssignment(
                'signal',
                factory.createPropertyAccessExpression(
                  rewriteExpression(factory, branch.signalExpr, rewriterCtx),
                  'signalName'
                )
              ),
            ]
          : [];

        return factory.createObjectLiteralExpression([
          factory.createPropertyAssignment('id', factory.createStringLiteral(branch.id)),
          ...signalAssignment,
          ...(branch.timer
            ? [
              factory.createPropertyAssignment(
                'timer',
                factory.createObjectLiteralExpression([
                  // Use unit-based format for persistence: { seconds: X } or { minutes: X }
                  // This is human-readable in the database and can be recalculated on resume
                  factory.createPropertyAssignment(
                    branch.timer.unit, // 'seconds', 'minutes', 'hours', 'days'
                    // Clone and rewrite the value expression (may contain state.vars references)
                    rewriteExpression(factory, cloneExpression(factory, branch.timer.valueExpr), rewriterCtx)
                  ),
                ])
              ),
            ]
            : []),
          factory.createPropertyAssignment(
            'resumeStep',
            factory.createNumericLiteral(branchStepIndex)
          ),
        ]);
      });

      // Store for use by RACE_SUSPEND
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createPropertyAccessExpression(
              factory.createPropertyAccessExpression(
                factory.createIdentifier('state'),
                'vars'
              ),
              '__raceBranches'
            ),
            ts.SyntaxKind.EqualsToken,
            factory.createArrayLiteralExpression(raceBranches, true)
          )
        )
      );
      break;
    }

    case 'RACE_SUSPEND': {
      // __r[0] = 1 (SUSPEND)
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createElementAccessExpression(
              factory.createIdentifier('__r'),
              factory.createNumericLiteral(0)
            ),
            ts.SyntaxKind.EqualsToken,
            factory.createNumericLiteral(1)
          )
        )
      );

      // __r[1] = { race: state.vars.__raceBranches }
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createElementAccessExpression(
              factory.createIdentifier('__r'),
              factory.createNumericLiteral(1)
            ),
            ts.SyntaxKind.EqualsToken,
            factory.createObjectLiteralExpression([
              factory.createPropertyAssignment(
                'race',
                factory.createPropertyAccessExpression(
                  factory.createPropertyAccessExpression(
                    factory.createIdentifier('state'),
                    'vars'
                  ),
                  '__raceBranches'
                )
              ),
            ])
          )
        )
      );

      // break main_loop
      statements.push(factory.createBreakStatement(factory.createIdentifier('main_loop')));
      break;
    }

    case 'JUMP': {
      // Find the step that contains the target opcode and convert to step index
      const targetStepIndex = findStepIndexForOpcode(steps, opcode.target);
      // step = targetStepIndex
      // continue main_loop
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createIdentifier('step'),
            ts.SyntaxKind.EqualsToken,
            factory.createNumericLiteral(targetStepIndex)
          )
        )
      );
      statements.push(factory.createContinueStatement(factory.createIdentifier('main_loop')));
      break;
    }

    case 'JUMP_IF': {
      // if (condition) { step = target; continue main_loop }
      // For now, we assume __condition is in state.vars
      const condition = opcode.condition === '__condition_false'
        ? factory.createPrefixUnaryExpression(
          ts.SyntaxKind.ExclamationToken,
          factory.createPropertyAccessExpression(
            factory.createPropertyAccessExpression(
              factory.createIdentifier('state'),
              'vars'
            ),
            '__condition'
          )
        )
        : factory.createPropertyAccessExpression(
          factory.createPropertyAccessExpression(
            factory.createIdentifier('state'),
            'vars'
          ),
          opcode.condition
        );

      // Convert opcode target index to step index
      const targetStepIndex = findStepIndexForOpcode(steps, opcode.target);

      statements.push(
        factory.createIfStatement(
          condition,
          factory.createBlock([
            factory.createExpressionStatement(
              factory.createBinaryExpression(
                factory.createIdentifier('step'),
                ts.SyntaxKind.EqualsToken,
                factory.createNumericLiteral(targetStepIndex)
              )
            ),
            factory.createContinueStatement(factory.createIdentifier('main_loop')),
          ])
        )
      );
      break;
    }

    case 'LABEL': {
      // Labels don't generate code - they're just markers for jump targets
      break;
    }

    case 'LABEL_ENTER': {
      // Initialize label tracking arrays if needed
      // state.labelStack = state.labelStack ?? []
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createPropertyAccessExpression(
              factory.createIdentifier('state'),
              'labelStack'
            ),
            ts.SyntaxKind.EqualsToken,
            factory.createBinaryExpression(
              factory.createPropertyAccessExpression(
                factory.createIdentifier('state'),
                'labelStack'
              ),
              ts.SyntaxKind.QuestionQuestionToken,
              factory.createArrayLiteralExpression([])
            )
          )
        )
      );

      // state.labelHistory = state.labelHistory ?? []
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createPropertyAccessExpression(
              factory.createIdentifier('state'),
              'labelHistory'
            ),
            ts.SyntaxKind.EqualsToken,
            factory.createBinaryExpression(
              factory.createPropertyAccessExpression(
                factory.createIdentifier('state'),
                'labelHistory'
              ),
              ts.SyntaxKind.QuestionQuestionToken,
              factory.createArrayLiteralExpression([])
            )
          )
        )
      );

      // state.labelStack.push('labelName')
      statements.push(
        factory.createExpressionStatement(
          factory.createCallExpression(
            factory.createPropertyAccessExpression(
              factory.createPropertyAccessExpression(
                factory.createIdentifier('state'),
                'labelStack'
              ),
              'push'
            ),
            undefined,
            [factory.createStringLiteral(opcode.label)]
          )
        )
      );

      // state.label = 'labelName'
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createPropertyAccessExpression(
              factory.createIdentifier('state'),
              'label'
            ),
            ts.SyntaxKind.EqualsToken,
            factory.createStringLiteral(opcode.label)
          )
        )
      );

      // state.labelHistory.push({ label: 'labelName', enteredAt: state.step })
      statements.push(
        factory.createExpressionStatement(
          factory.createCallExpression(
            factory.createPropertyAccessExpression(
              factory.createPropertyAccessExpression(
                factory.createIdentifier('state'),
                'labelHistory'
              ),
              'push'
            ),
            undefined,
            [
              factory.createObjectLiteralExpression([
                factory.createPropertyAssignment('label', factory.createStringLiteral(opcode.label)),
                factory.createPropertyAssignment(
                  'enteredAt',
                  factory.createPropertyAccessExpression(
                    factory.createIdentifier('state'),
                    'step'
                  )
                ),
              ]),
            ]
          )
        )
      );

      // Keep history bounded: if (state.labelHistory.length > 50) state.labelHistory.shift()
      statements.push(
        factory.createIfStatement(
          factory.createBinaryExpression(
            factory.createPropertyAccessExpression(
              factory.createPropertyAccessExpression(
                factory.createIdentifier('state'),
                'labelHistory'
              ),
              'length'
            ),
            ts.SyntaxKind.GreaterThanToken,
            factory.createNumericLiteral(50)
          ),
          factory.createExpressionStatement(
            factory.createCallExpression(
              factory.createPropertyAccessExpression(
                factory.createPropertyAccessExpression(
                  factory.createIdentifier('state'),
                  'labelHistory'
                ),
                'shift'
              ),
              undefined,
              []
            )
          )
        )
      );
      break;
    }

    case 'LABEL_EXIT': {
      // state.labelStack?.pop()
      statements.push(
        factory.createExpressionStatement(
          factory.createCallChain(
            factory.createPropertyAccessChain(
              factory.createPropertyAccessExpression(
                factory.createIdentifier('state'),
                'labelStack'
              ),
              factory.createToken(ts.SyntaxKind.QuestionDotToken),
              'pop'
            ),
            undefined,
            undefined,
            []
          )
        )
      );

      // state.label = state.labelStack?.[state.labelStack.length - 1]
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createPropertyAccessExpression(
              factory.createIdentifier('state'),
              'label'
            ),
            ts.SyntaxKind.EqualsToken,
            factory.createElementAccessChain(
              factory.createPropertyAccessExpression(
                factory.createIdentifier('state'),
                'labelStack'
              ),
              factory.createToken(ts.SyntaxKind.QuestionDotToken),
              factory.createBinaryExpression(
                factory.createPropertyAccessExpression(
                  factory.createPropertyAccessExpression(
                    factory.createIdentifier('state'),
                    'labelStack'
                  ),
                  'length'
                ),
                ts.SyntaxKind.MinusToken,
                factory.createNumericLiteral(1)
              )
            )
          )
        )
      );

      // Find the last entry for this label in history and set exitedAt
      // const __lastEntry = state.labelHistory?.findLast(e => e.label === 'labelName' && e.exitedAt === undefined)
      // if (__lastEntry) __lastEntry.exitedAt = state.step
      const lastEntryVarName = `__lastEntry_${opcode.label.replace(/\W/g, '_')}`;
      statements.push(
        factory.createVariableStatement(
          undefined,
          factory.createVariableDeclarationList(
            [
              factory.createVariableDeclaration(
                lastEntryVarName,
                undefined,
                undefined,
                factory.createCallChain(
                  factory.createPropertyAccessChain(
                    factory.createPropertyAccessExpression(
                      factory.createIdentifier('state'),
                      'labelHistory'
                    ),
                    factory.createToken(ts.SyntaxKind.QuestionDotToken),
                    'findLast'
                  ),
                  undefined,
                  undefined,
                  [
                    factory.createArrowFunction(
                      undefined,
                      undefined,
                      [factory.createParameterDeclaration(undefined, undefined, 'e')],
                      undefined,
                      factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                      factory.createBinaryExpression(
                        factory.createBinaryExpression(
                          factory.createPropertyAccessExpression(
                            factory.createIdentifier('e'),
                            'label'
                          ),
                          ts.SyntaxKind.EqualsEqualsEqualsToken,
                          factory.createStringLiteral(opcode.label)
                        ),
                        ts.SyntaxKind.AmpersandAmpersandToken,
                        factory.createBinaryExpression(
                          factory.createPropertyAccessExpression(
                            factory.createIdentifier('e'),
                            'exitedAt'
                          ),
                          ts.SyntaxKind.EqualsEqualsEqualsToken,
                          factory.createIdentifier('undefined')
                        )
                      )
                    ),
                  ]
                )
              ),
            ],
            ts.NodeFlags.Const
          )
        )
      );

      statements.push(
        factory.createIfStatement(
          factory.createIdentifier(lastEntryVarName),
          factory.createExpressionStatement(
            factory.createBinaryExpression(
              factory.createPropertyAccessExpression(
                factory.createIdentifier(lastEntryVarName),
                'exitedAt'
              ),
              ts.SyntaxKind.EqualsToken,
              factory.createPropertyAccessExpression(
                factory.createIdentifier('state'),
                'step'
              )
            )
          )
        )
      );
      break;
    }

    case 'RETURN': {
      // __r[0] = 0 (DONE)
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createElementAccessExpression(
              factory.createIdentifier('__r'),
              factory.createNumericLiteral(0)
            ),
            ts.SyntaxKind.EqualsToken,
            factory.createNumericLiteral(0)
          )
        )
      );

      // __r[1] = result (from __blockResult or literal)
      // The return value comes from the preceding BLOCK opcode
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createElementAccessExpression(
              factory.createIdentifier('__r'),
              factory.createNumericLiteral(1)
            ),
            ts.SyntaxKind.EqualsToken,
            factory.createIdentifier('__blockResult')
          )
        )
      );

      // break main_loop
      statements.push(factory.createBreakStatement(factory.createIdentifier('main_loop')));
      break;
    }

    case 'YIELD_EMIT': {
      // Emit a value without suspending: ctx.emit(rewrittenValueExpr)
      const emitValue = rewriteExpression(factory, opcode.valueExpr, rewriterCtx);
      statements.push(
        factory.createExpressionStatement(
          factory.createCallExpression(
            factory.createPropertyAccessExpression(
              factory.createIdentifier('ctx'),
              'emit'
            ),
            undefined,
            [emitValue]
          )
        )
      );
      break;
    }

    case 'SCOPE_ENTER':
    case 'SCOPE_EXIT': {
      // Scope opcodes are handled implicitly by the using var cleanup
      break;
    }

    case 'SCOPE_START': {
      // Evaluate entities and store them in state vars for the executor
      // Generated: state.vars.__scope_N_entities = Array.from(rewrittenIterableExpr)
      const entitiesExpr = rewriteExpression(factory, opcode.iterableExpr, rewriterCtx);
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createElementAccessExpression(
              factory.createPropertyAccessExpression(
                factory.createIdentifier('state'),
                'vars'
              ),
              factory.createStringLiteral(`__scope_${opcode.scopeId}_entities`)
            ),
            ts.SyntaxKind.EqualsToken,
            factory.createCallExpression(
              factory.createPropertyAccessExpression(
                factory.createIdentifier('Array'),
                'from'
              ),
              undefined,
              [entitiesExpr]
            )
          )
        )
      );

      // Store idExtractor if provided
      // Generated: state.vars.__scope_N_idFn = rewrittenIdExtractor
      if (opcode.idExtractor) {
        const idExpr = rewriteExpression(factory, opcode.idExtractor, rewriterCtx);
        statements.push(
          factory.createExpressionStatement(
            factory.createBinaryExpression(
              factory.createElementAccessExpression(
                factory.createPropertyAccessExpression(
                  factory.createIdentifier('state'),
                  'vars'
                ),
                factory.createStringLiteral(`__scope_${opcode.scopeId}_idFn`)
              ),
              ts.SyntaxKind.EqualsToken,
              idExpr
            )
          )
        );
      }

      // Store param alias if provided
      if (opcode.paramAlias) {
        statements.push(
          factory.createExpressionStatement(
            factory.createBinaryExpression(
              factory.createElementAccessExpression(
                factory.createPropertyAccessExpression(
                  factory.createIdentifier('state'),
                  'vars'
                ),
                factory.createStringLiteral(`__scope_${opcode.scopeId}_alias`)
              ),
              ts.SyntaxKind.EqualsToken,
              factory.createStringLiteral(opcode.paramAlias)
            )
          )
        );
      }
      break;
    }

    case 'SCOPE_WAIT': {
      // Signal-first form: suspend with scope config
      const signalExpr = rewriteExpression(factory, opcode.signalExpr, rewriterCtx);
      const resumeStepIndex = step.nextStep ?? step.index + 1;

      // step = resumeStep
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createIdentifier('step'),
            ts.SyntaxKind.EqualsToken,
            factory.createNumericLiteral(resumeStepIndex)
          )
        )
      );

      // __r[0] = 1 (SUSPEND)
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createElementAccessExpression(
              factory.createIdentifier('__r'),
              factory.createNumericLiteral(0)
            ),
            ts.SyntaxKind.EqualsToken,
            factory.createNumericLiteral(1)
          )
        )
      );

      // __r[1] = { scope: { scopeId, type: 'signal', signal, resumeStep } }
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createElementAccessExpression(
              factory.createIdentifier('__r'),
              factory.createNumericLiteral(1)
            ),
            ts.SyntaxKind.EqualsToken,
            factory.createObjectLiteralExpression([
              factory.createPropertyAssignment(
                'scope',
                factory.createObjectLiteralExpression([
                  factory.createPropertyAssignment('scopeId', factory.createNumericLiteral(opcode.scopeId)),
                  factory.createPropertyAssignment('type', factory.createStringLiteral('signal')),
                  factory.createPropertyAssignment('signal',
                    factory.createPropertyAccessExpression(signalExpr, 'signalName')
                  ),
                  factory.createPropertyAssignment('resumeStep', factory.createNumericLiteral(resumeStepIndex)),
                ])
              ),
            ])
          )
        )
      );

      // break main_loop
      statements.push(factory.createBreakStatement(factory.createIdentifier('main_loop')));
      break;
    }

    case 'SCOPE_HANDLER': {
      // Handler form: suspend with scope config
      const resumeStepIndex = step.nextStep ?? step.index + 1;

      // step = resumeStep
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createIdentifier('step'),
            ts.SyntaxKind.EqualsToken,
            factory.createNumericLiteral(resumeStepIndex)
          )
        )
      );

      // __r[0] = 1 (SUSPEND)
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createElementAccessExpression(
              factory.createIdentifier('__r'),
              factory.createNumericLiteral(0)
            ),
            ts.SyntaxKind.EqualsToken,
            factory.createNumericLiteral(1)
          )
        )
      );

      // __r[1] = { scope: { scopeId, type: 'handler', resumeStep } }
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createElementAccessExpression(
              factory.createIdentifier('__r'),
              factory.createNumericLiteral(1)
            ),
            ts.SyntaxKind.EqualsToken,
            factory.createObjectLiteralExpression([
              factory.createPropertyAssignment(
                'scope',
                factory.createObjectLiteralExpression([
                  factory.createPropertyAssignment('scopeId', factory.createNumericLiteral(opcode.scopeId)),
                  factory.createPropertyAssignment('type', factory.createStringLiteral('handler')),
                  factory.createPropertyAssignment('resumeStep', factory.createNumericLiteral(resumeStepIndex)),
                ])
              ),
            ])
          )
        )
      );

      // break main_loop
      statements.push(factory.createBreakStatement(factory.createIdentifier('main_loop')));
      break;
    }

    case 'SCOPE_NEXT': {
      // Not used in current codegen - per-entity iteration handled by executor
      break;
    }

    case 'SCOPE_END': {
      // Collect scope results from state vars
      // Generated: state.vars.resultVar = state.vars.__scope_N_results
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createElementAccessExpression(
              factory.createPropertyAccessExpression(
                factory.createIdentifier('state'),
                'vars'
              ),
              factory.createStringLiteral(opcode.resultVar)
            ),
            ts.SyntaxKind.EqualsToken,
            factory.createElementAccessExpression(
              factory.createPropertyAccessExpression(
                factory.createIdentifier('state'),
                'vars'
              ),
              factory.createStringLiteral(`__scope_${opcode.scopeId}_results`)
            )
          )
        )
      );
      break;
    }

    case 'ITER_START': {
      // Initialize iterator from iterable expression
      // const __iter_N = state.vars.__cursor_N
      //   ? iterable[FromCursor](state.vars.__cursor_N)
      //   : createDurableArrayIterator(iterable)
      const iterVarName = `__iter_${opcode.loopId}`;

      // First, store the iterable expression in a temp var
      const iterableVarName = `__iterable_${opcode.loopId}`;
      const rewrittenIterable = rewriteExpression(factory, opcode.iterableExpr, rewriterCtx);

      statements.push(
        factory.createVariableStatement(
          undefined,
          factory.createVariableDeclarationList(
            [factory.createVariableDeclaration(iterableVarName, undefined, undefined, rewrittenIterable)],
            ts.NodeFlags.Const
          )
        )
      );

      // Check if cursor exists in state.vars, if so use FromCursor, otherwise create new
      // const __iter_N = state.vars.__cursor_N !== undefined
      //   ? (__iterable_N[FromCursor] ? __iterable_N[FromCursor](state.vars.__cursor_N) : createDurableArrayIterator(__iterable_N, state.vars.__cursor_N))
      //   : (__iterable_N[FromCursor] ? __iterable_N : createDurableArrayIterator(__iterable_N))
      const cursorAccess = factory.createPropertyAccessExpression(
        factory.createPropertyAccessExpression(
          factory.createIdentifier('state'),
          'vars'
        ),
        opcode.cursorVar
      );

      // Symbol.for('justscale:FromCursor') is emitted into user code (cross-realm) - keep Symbol.for.
      const fromCursorSymbolExpr = factory.createCallExpression(
        factory.createPropertyAccessExpression(
          factory.createIdentifier('Symbol'),
          'for'
        ),
        undefined,
        [factory.createStringLiteral('justscale:FromCursor')]
      );

      const hasFromCursor = factory.createBinaryExpression(
        fromCursorSymbolExpr,
        ts.SyntaxKind.InKeyword,
        factory.createIdentifier(iterableVarName)
      );

      // If cursor exists
      const withCursor = factory.createConditionalExpression(
        hasFromCursor,
        factory.createToken(ts.SyntaxKind.QuestionToken),
        // Iterable has FromCursor - use it, then get iterator
        wrapWithAsyncIterator(factory,
          factory.createCallExpression(
            factory.createElementAccessExpression(
              factory.createIdentifier(iterableVarName),
              factory.createCallExpression(
                factory.createPropertyAccessExpression(
                  factory.createIdentifier('Symbol'),
                  'for'
                ),
                undefined,
                [factory.createStringLiteral('justscale:FromCursor')]
              )
            ),
            undefined,
            [cursorAccess]
          )
        ),
        factory.createToken(ts.SyntaxKind.ColonToken),
        // Array - wrap with DurableArrayIterator
        factory.createNewExpression(
          factory.createIdentifier('DurableArrayIterator'),
          undefined,
          [factory.createIdentifier(iterableVarName), cursorAccess]
        )
      );

      // If no cursor exists
      const withoutCursor = factory.createConditionalExpression(
        hasFromCursor,
        factory.createToken(ts.SyntaxKind.QuestionToken),
        // Iterable has FromCursor - get iterator from iterable
        wrapWithAsyncIterator(factory, factory.createIdentifier(iterableVarName)),
        factory.createToken(ts.SyntaxKind.ColonToken),
        // Array - wrap with DurableArrayIterator
        factory.createNewExpression(
          factory.createIdentifier('DurableArrayIterator'),
          undefined,
          [factory.createIdentifier(iterableVarName)]
        )
      );

      // Complete conditional
      const iteratorInit = factory.createConditionalExpression(
        factory.createBinaryExpression(
          cursorAccess,
          ts.SyntaxKind.ExclamationEqualsEqualsToken,
          factory.createIdentifier('undefined')
        ),
        factory.createToken(ts.SyntaxKind.QuestionToken),
        withCursor,
        factory.createToken(ts.SyntaxKind.ColonToken),
        withoutCursor
      );

      statements.push(
        factory.createVariableStatement(
          undefined,
          factory.createVariableDeclarationList(
            [factory.createVariableDeclaration(iterVarName, undefined, undefined, iteratorInit)],
            ts.NodeFlags.Const
          )
        )
      );
      break;
    }

    case 'ITER_NEXT': {
      // Fetch next item from iterator
      // const { value, done } = await __iter_N.next()
      // if (done) { step = doneTarget; continue main_loop }
      // state.vars.itemVar = value
      const iterVarName = `__iter_${opcode.loopId}`;
      const resultVarName = `__iterResult_${opcode.loopId}`;

      // const __iterResult_N = await __iter_N.next()
      statements.push(
        factory.createVariableStatement(
          undefined,
          factory.createVariableDeclarationList(
            [
              factory.createVariableDeclaration(
                resultVarName,
                undefined,
                undefined,
                factory.createAwaitExpression(
                  factory.createCallExpression(
                    factory.createPropertyAccessExpression(
                      factory.createIdentifier(iterVarName),
                      'next'
                    ),
                    undefined,
                    []
                  )
                )
              ),
            ],
            ts.NodeFlags.Const
          )
        )
      );

      // if (__iterResult_N.done) { step = doneTarget; continue main_loop }
      const doneTarget = findStepIndexForOpcode(steps, opcode.doneTarget);
      statements.push(
        factory.createIfStatement(
          factory.createPropertyAccessExpression(
            factory.createIdentifier(resultVarName),
            'done'
          ),
          factory.createBlock([
            factory.createExpressionStatement(
              factory.createBinaryExpression(
                factory.createIdentifier('step'),
                ts.SyntaxKind.EqualsToken,
                factory.createNumericLiteral(doneTarget)
              )
            ),
            factory.createContinueStatement(factory.createIdentifier('main_loop')),
          ])
        )
      );

      // state.vars.itemVar = __iterResult_N.value
      // Find the ITER_START opcode to get the itemVar name
      let itemVarName = '__item';
      for (let j = opcodeIndex - 1; j >= 0; j--) {
        const prevOp = analysis.opcodes[j];
        if (prevOp.op === 'ITER_START' && prevOp.loopId === opcode.loopId) {
          itemVarName = prevOp.itemVar;
          break;
        }
      }

      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createPropertyAccessExpression(
              factory.createPropertyAccessExpression(
                factory.createIdentifier('state'),
                'vars'
              ),
              itemVarName
            ),
            ts.SyntaxKind.EqualsToken,
            factory.createPropertyAccessExpression(
              factory.createIdentifier(resultVarName),
              'value'
            )
          )
        )
      );
      break;
    }

    case 'ITER_SAVE': {
      // Save cursor position before suspension
      // state.vars.__cursor_N = __iter_N[DurableCursor]?.() ?? state.vars.__cursor_N
      const iterVarName = `__iter_${opcode.loopId}`;

      // Try to get cursor from iterator if it supports DurableCursor
      const getCursor = factory.createCallChain(
        factory.createElementAccessChain(
          factory.createIdentifier(iterVarName),
          factory.createToken(ts.SyntaxKind.QuestionDotToken),
          factory.createCallExpression(
            factory.createPropertyAccessExpression(
              factory.createIdentifier('Symbol'),
              'for'
            ),
            undefined,
            [factory.createStringLiteral('justscale:DurableCursor')]
          )
        ),
        undefined,
        undefined,
        []
      );

      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createPropertyAccessExpression(
              factory.createPropertyAccessExpression(
                factory.createIdentifier('state'),
                'vars'
              ),
              opcode.cursorVar
            ),
            ts.SyntaxKind.EqualsToken,
            factory.createBinaryExpression(
              getCursor,
              ts.SyntaxKind.QuestionQuestionToken,
              factory.createPropertyAccessExpression(
                factory.createPropertyAccessExpression(
                  factory.createIdentifier('state'),
                  'vars'
                ),
                opcode.cursorVar
              )
            )
          )
        )
      );
      break;
    }

    case 'PARALLEL_START': {
      // Initialize parallel context in state.vars (persisted across suspension)
      // state.vars.__parallel_N = { pending: N, results: [], errors: [], isSettled: bool }
      const parallelVarName = `__parallel_${opcode.parallelId}`;
      const branchCount = opcode.branches.length;

      // Create parallel context initialization
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createPropertyAccessExpression(
              factory.createPropertyAccessExpression(
                factory.createIdentifier('state'),
                'vars'
              ),
              parallelVarName
            ),
            ts.SyntaxKind.EqualsToken,
            factory.createObjectLiteralExpression([
              factory.createPropertyAssignment('parallelId', factory.createNumericLiteral(opcode.parallelId)),
              factory.createPropertyAssignment('pending', factory.createNumericLiteral(branchCount)),
              factory.createPropertyAssignment('results', factory.createArrayLiteralExpression([])),
              factory.createPropertyAssignment('errors', factory.createArrayLiteralExpression([])),
              factory.createPropertyAssignment('isSettled', opcode.isSettled ? factory.createTrue() : factory.createFalse()),
              factory.createPropertyAssignment('branches', factory.createArrayLiteralExpression(
                opcode.branches.map((branch) =>
                  factory.createObjectLiteralExpression([
                    factory.createPropertyAssignment('id', typeof branch.id === 'number'
                      ? factory.createNumericLiteral(branch.id)
                      : factory.createStringLiteral(branch.id as string)
                    ),
                    factory.createPropertyAssignment('type', factory.createStringLiteral(branch.type)),
                    factory.createPropertyAssignment('expr', rewriteExpression(factory, cloneExpression(factory, branch.expr), rewriterCtx)),
                  ])
                )
              )),
            ], true)
          )
        )
      );
      break;
    }

    case 'PARALLEL_WAIT': {
      // Subscribe to all branches and suspend
      // This is a suspension point - we'll return SUSPEND with parallel info
      const parallelVarName = `__parallel_${opcode.parallelId}`;

      // Set state.step to the resume step (PARALLEL_COLLECT is next)
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createPropertyAccessExpression(
              factory.createIdentifier('state'),
              'step'
            ),
            ts.SyntaxKind.EqualsToken,
            factory.createBinaryExpression(
              factory.createIdentifier('step'),
              ts.SyntaxKind.PlusToken,
              factory.createNumericLiteral(1)
            )
          )
        )
      );

      // __r[0] = SUSPEND
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createElementAccessExpression(
              factory.createIdentifier('__r'),
              0
            ),
            ts.SyntaxKind.EqualsToken,
            factory.createIdentifier('SUSPEND')
          )
        )
      );

      // __r[1] = { parallel: state.vars.__parallel_N }
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createElementAccessExpression(
              factory.createIdentifier('__r'),
              1
            ),
            ts.SyntaxKind.EqualsToken,
            factory.createObjectLiteralExpression([
              factory.createPropertyAssignment('parallel', factory.createPropertyAccessExpression(
                factory.createPropertyAccessExpression(
                  factory.createIdentifier('state'),
                  'vars'
                ),
                parallelVarName
              )),
            ])
          )
        )
      );

      // break main_loop (use same pattern as WAIT/RACE_SUSPEND)
      statements.push(factory.createBreakStatement(factory.createIdentifier('main_loop')));
      break;
    }

    case 'PARALLEL_COLLECT': {
      // Collect results from parallel execution
      // The results are stored in state.vars.__parallel_N.results by the runtime
      const parallelVarName = `__parallel_${opcode.parallelId}`;

      // Helper: generates state.vars.__parallel_N
      const stateVarsParallel = () => factory.createPropertyAccessExpression(
        factory.createPropertyAccessExpression(
          factory.createIdentifier('state'),
          'vars'
        ),
        parallelVarName
      );

      if (opcode.isObject) {
        // Object form: convert array results to object using branch IDs as keys
        // state.vars.result = Object.fromEntries(state.vars.__parallel_N.branches.map((b, i) => [b.id, state.vars.__parallel_N.results[i]]))
        statements.push(
          factory.createExpressionStatement(
            factory.createBinaryExpression(
              factory.createPropertyAccessExpression(
                factory.createPropertyAccessExpression(
                  factory.createIdentifier('state'),
                  'vars'
                ),
                opcode.resultVar
              ),
              ts.SyntaxKind.EqualsToken,
              factory.createCallExpression(
                factory.createPropertyAccessExpression(
                  factory.createIdentifier('Object'),
                  'fromEntries'
                ),
                undefined,
                [
                  factory.createCallExpression(
                    factory.createPropertyAccessExpression(
                      factory.createPropertyAccessExpression(
                        stateVarsParallel(),
                        'branches'
                      ),
                      'map'
                    ),
                    undefined,
                    [
                      factory.createArrowFunction(
                        undefined,
                        undefined,
                        [
                          factory.createParameterDeclaration(undefined, undefined, 'b'),
                          factory.createParameterDeclaration(undefined, undefined, 'i'),
                        ],
                        undefined,
                        factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
                        factory.createArrayLiteralExpression([
                          factory.createPropertyAccessExpression(factory.createIdentifier('b'), 'id'),
                          factory.createElementAccessExpression(
                            factory.createPropertyAccessExpression(
                              stateVarsParallel(),
                              'results'
                            ),
                            factory.createIdentifier('i')
                          ),
                        ])
                      ),
                    ]
                  ),
                ]
              )
            )
          )
        );
      } else {
        // Array form: directly assign results array
        // state.vars.result = state.vars.__parallel_N.results
        statements.push(
          factory.createExpressionStatement(
            factory.createBinaryExpression(
              factory.createPropertyAccessExpression(
                factory.createPropertyAccessExpression(
                  factory.createIdentifier('state'),
                  'vars'
                ),
                opcode.resultVar
              ),
              ts.SyntaxKind.EqualsToken,
              factory.createPropertyAccessExpression(
                stateVarsParallel(),
                'results'
              )
            )
          )
        );
      }
      break;
    }

    case 'SUBPROCESS_SPAWN': {
      // Set step to resume point
      const resumeStepIndex = step.nextStep ?? step.index + 1;
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createIdentifier('step'),
            ts.SyntaxKind.EqualsToken,
            factory.createNumericLiteral(resumeStepIndex)
          )
        )
      );

      // __r[0] = 2 (SUBPROCESS)
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createElementAccessExpression(
              factory.createIdentifier('__r'),
              factory.createNumericLiteral(0)
            ),
            ts.SyntaxKind.EqualsToken,
            factory.createNumericLiteral(2)
          )
        )
      );

      // __r[1] = { name: '...', args: [...], storeVar: '...', awaited: true }
      const spawnProperties: ts.ObjectLiteralElementLike[] = [
        factory.createPropertyAssignment('name', factory.createStringLiteral(opcode.name)),
        factory.createPropertyAssignment(
          'args',
          factory.createArrayLiteralExpression(
            opcode.argExprs.map((arg: ts.Expression) => rewriteExpression(factory, cloneExpression(factory, arg), rewriterCtx))
          )
        ),
        factory.createPropertyAssignment(
          'awaited',
          opcode.awaited ? factory.createTrue() : factory.createFalse()
        ),
      ];
      if (opcode.storeVar) {
        spawnProperties.push(
          factory.createPropertyAssignment('storeVar', factory.createStringLiteral(opcode.storeVar))
        );
      }
      statements.push(
        factory.createExpressionStatement(
          factory.createBinaryExpression(
            factory.createElementAccessExpression(
              factory.createIdentifier('__r'),
              factory.createNumericLiteral(1)
            ),
            ts.SyntaxKind.EqualsToken,
            factory.createObjectLiteralExpression(spawnProperties)
          )
        )
      );

      // break main_loop
      statements.push(factory.createBreakStatement(factory.createIdentifier('main_loop')));
      break;
    }

    case 'SUBPROCESS_DECL': {
      // Declaration opcodes don't generate runtime code - they're metadata only
      break;
    }
  }

  return statements;
}

