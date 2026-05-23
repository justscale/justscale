/**
 * Shared test utilities for the process compiler tests.
 *
 * Provides structured parsing of generated code for thorough verification,
 * TypeScript AST helpers, and common assertions.
 */

import ts from 'typescript';
import assert from 'node:assert';

// ============================================================================
// Output Parsing Utilities
// ============================================================================

/**
 * Structured data extracted from generated process code.
 */
export interface ParsedOutput {
  // stepMap: hash -> index mappings
  stepMapEntries: Record<string, number>
  stepMapCount: number

  // sourceMap: index -> [startLine, endLine] mappings
  sourceMapEntries: Record<number, [number, number]>
  sourceMapCount: number

  // Signals registered in the process
  signalNames: string[]

  // Structure verification
  caseCount: number
  hasMainLoop: boolean
  hasWhileTrue: boolean
  hasSwitchStep: boolean
  hasBreakMainLoop: boolean
  hasContinueMainLoop: boolean
  hasDonePattern: boolean
  hasSuspendPattern: boolean
  hasDispose: boolean
  hasDefaultCase: boolean

  // Process metadata
  version: string | null
  id: string | null
  path: string | null

  // Race handling
  raceConfigs: number
  raceBranches: number
}

/**
 * Parse the generated output to extract structured information for verification.
 */
export function parseOutput(outputText: string): ParsedOutput {
  // Extract stepMap entries
  const stepMapMatch = outputText.match(/stepMap:\s*\{([^}]+)\}/);
  const stepMapEntries: Record<string, number> = {};
  if (stepMapMatch) {
    const entries = stepMapMatch[1].matchAll(/["']([^"']+)["']\s*:\s*(\d+)/g);
    for (const [, hash, index] of entries) {
      stepMapEntries[hash] = parseInt(index, 10);
    }
  }

  // Extract sourceMap entries
  const sourceMapMatch = outputText.match(/sourceMap:\s*\{([^}]+)\}/);
  const sourceMapEntries: Record<number, [number, number]> = {};
  if (sourceMapMatch) {
    const entries = sourceMapMatch[1].matchAll(/(\d+)\s*:\s*\[(\d+),\s*(\d+)\]/g);
    for (const [, index, start, end] of entries) {
      sourceMapEntries[parseInt(index, 10)] = [parseInt(start, 10), parseInt(end, 10)];
    }
  }

  // Extract signals
  const signalsMatch = outputText.match(/signals:\s*\{([\s\S]*?)\n\s*\},?\s*\n\s*execute/);
  const signalNames: string[] = [];
  if (signalsMatch) {
    const names = signalsMatch[1].matchAll(/["']([^"']+)["']\s*:/g);
    for (const [, name] of names) {
      signalNames.push(name);
    }
  }

  // Count case statements
  const caseMatches = outputText.match(/case \d+:/g) || [];
  const caseCount = caseMatches.length;

  // Check for specific patterns
  const hasMainLoop = outputText.includes('main_loop:');
  const hasWhileTrue = outputText.includes('while (true)');
  const hasSwitchStep = outputText.includes('switch (step)');
  const hasBreakMainLoop = outputText.includes('break main_loop');
  const hasContinueMainLoop = outputText.includes('continue main_loop');
  const hasDonePattern = outputText.includes('__r[0] = 0');
  const hasSuspendPattern = outputText.includes('__r[0] = 1');
  const hasDispose = outputText.includes('__dispose');
  const hasDefaultCase = outputText.includes('default:');

  // Extract version
  const versionMatch = outputText.match(/version:\s*["']([^"']+)["']/);
  const version = versionMatch ? versionMatch[1] : null;

  // Extract id
  const idMatch = outputText.match(/id:\s*["']([^"']+)["']/);
  const id = idMatch ? idMatch[1] : null;

  // Extract path
  const pathMatch = outputText.match(/path:\s*["']([^"']+)["']/);
  const path = pathMatch ? pathMatch[1] : null;

  // Count race configs (race: followed by anything)
  const raceConfigs = (outputText.match(/race:/g) || []).length;

  // Count race branches in __raceBranches arrays
  const raceBranches = (outputText.match(/resumeStep:/g) || []).length;

  return {
    stepMapEntries,
    stepMapCount: Object.keys(stepMapEntries).length,
    sourceMapEntries,
    sourceMapCount: Object.keys(sourceMapEntries).length,
    signalNames,
    caseCount,
    hasMainLoop,
    hasWhileTrue,
    hasSwitchStep,
    hasBreakMainLoop,
    hasContinueMainLoop,
    hasDonePattern,
    hasSuspendPattern,
    hasDispose,
    hasDefaultCase,
    version,
    id,
    path,
    raceConfigs,
    raceBranches,
  };
}

// ============================================================================
// TypeScript AST Utilities
// ============================================================================

/**
 * Create a handler function from source code.
 */
export function createHandler(code: string): ts.ArrowFunction | ts.FunctionExpression {
  const sourceFile = ts.createSourceFile(
    'test.ts',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  let handler: ts.ArrowFunction | ts.FunctionExpression | undefined;

  const visit = (node: ts.Node) => {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      handler = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (!handler) {
    throw new Error('No function found in code');
  }
  return handler;
}

/**
 * Create a handler with its source file.
 */
export function createHandlerWithSourceFile(code: string): {
  handler: ts.ArrowFunction | ts.FunctionExpression
  sourceFile: ts.SourceFile
} {
  const sourceFile = ts.createSourceFile(
    'test.ts',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  let handler: ts.ArrowFunction | ts.FunctionExpression | undefined;

  const visit = (node: ts.Node) => {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      handler = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (!handler) {
    throw new Error('No function found in code');
  }
  return { handler, sourceFile };
}

/**
 * Create a minimal TypeScript type checker for testing.
 */
export function createTypeChecker(): ts.TypeChecker {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    strict: true,
  };

  const host = ts.createCompilerHost(options);
  const program = ts.createProgram(['test.ts'], options, {
    ...host,
    getSourceFile: (fileName) => {
      if (fileName === 'test.ts') {
        return ts.createSourceFile(fileName, '', ts.ScriptTarget.Latest);
      }
      return host.getSourceFile(fileName, ts.ScriptTarget.Latest);
    },
  });

  return program.getTypeChecker();
}

// ============================================================================
// Assertion Utilities
// ============================================================================

/**
 * Assert that all step hashes have valid prefixes.
 */
export function assertValidStepHashes(stepMapEntries: Record<string, number>): void {
  const validPrefixes = ['entry_', 'block_', 'resume_', 'branch_'];
  for (const hash of Object.keys(stepMapEntries)) {
    const hasValidPrefix = validPrefixes.some(p => hash.startsWith(p));
    assert.ok(hasValidPrefix, `Step hash should have valid prefix: ${hash}`);
  }
}

/**
 * Assert that step indices are sequential starting from 0.
 */
export function assertSequentialIndices(stepMapEntries: Record<string, number>): void {
  const indices = Object.values(stepMapEntries).sort((a, b) => a - b);
  for (let i = 0; i < indices.length; i++) {
    assert.strictEqual(indices[i], i, `Index ${i} should be ${i}, got ${indices[i]}`);
  }
}

/**
 * Assert that sourceMap entries have valid line ranges.
 */
export function assertValidSourceMapRanges(sourceMapEntries: Record<number, [number, number]>): void {
  for (const [index, range] of Object.entries(sourceMapEntries)) {
    assert.ok(Array.isArray(range), `Entry ${index} should be array`);
    assert.strictEqual(range.length, 2, `Entry ${index} should have 2 elements`);
    assert.ok(range[0] > 0, `Entry ${index} start line should be positive`);
    assert.ok(range[1] >= range[0], `Entry ${index} end line should be >= start line`);
  }
}

/**
 * Assert the VM structure is present.
 */
export function assertVMStructure(parsed: ParsedOutput): void {
  assert.ok(parsed.hasMainLoop, 'Should have main_loop label');
  assert.ok(parsed.hasWhileTrue, 'Should have while(true)');
  assert.ok(parsed.hasSwitchStep, 'Should have switch(step)');
  assert.ok(parsed.hasDefaultCase, 'Should have default case');
  assert.ok(parsed.hasBreakMainLoop, 'Should have break main_loop');
}

/**
 * Assert stepMap and case count match.
 */
export function assertStepCaseMatch(parsed: ParsedOutput): void {
  assert.strictEqual(
    parsed.caseCount,
    parsed.stepMapCount,
    `Case count (${parsed.caseCount}) should match stepMap count (${parsed.stepMapCount})`
  );
}

/**
 * Assert sourceMap and stepMap counts match.
 */
export function assertSourceMapMatch(parsed: ParsedOutput): void {
  assert.strictEqual(
    parsed.sourceMapCount,
    parsed.stepMapCount,
    `sourceMap count (${parsed.sourceMapCount}) should match stepMap count (${parsed.stepMapCount})`
  );
}
