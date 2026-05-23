/**
 * Built-in process quick fixes.
 *
 * Provides code actions for common process compiler diagnostics (TSPxxxx).
 * These are registered alongside package-contributed quick fixes.
 */

import type ts from 'typescript';

// Process diagnostic codes (100000 + TSPxxxx)
const TSP1004 = 101004; // Handler must be async
const TSP1007 = 101007; // Try-catch around suspension

interface ProcessCodeFix {
  errorCode: number
  fixName: string
  description: string
  apply: (sourceFile: ts.SourceFile, diagnostic: ts.Diagnostic, tsLib: typeof ts) => ts.FileTextChanges[] | null
}

/**
 * TSP1004: Handler must be async function
 * Fix: add `async` keyword to the handler
 */
const fixAsyncHandler: ProcessCodeFix = {
  errorCode: TSP1004,
  fixName: 'justscale.process.add-async',
  description: 'Add async to process handler',
  apply(sourceFile, diagnostic, tsLib) {
    const start = diagnostic.start;
    if (start === undefined) return null;

    const node = findNodeAtPosition(sourceFile, start, tsLib);
    if (!node) return null;

    // Find the function expression/arrow function
    let fn: ts.Node | undefined = node;
    while (fn && !tsLib.isFunctionExpression(fn) && !tsLib.isArrowFunction(fn) && !tsLib.isMethodDeclaration(fn)) {
      fn = fn.parent;
    }
    if (!fn) return null;

    // Insert `async ` before the function keyword or parameters
    const insertPos = fn.getStart(sourceFile);

    return [{
      fileName: sourceFile.fileName,
      textChanges: [{
        span: { start: insertPos, length: 0 },
        newText: 'async ',
      }],
    }];
  },
};

/**
 * TSP1007: Try-catch around suspension points
 * Fix: remove the try-catch wrapper
 */
const fixRemoveTryCatch: ProcessCodeFix = {
  errorCode: TSP1007,
  fixName: 'justscale.process.remove-try-catch',
  description: 'Remove try-catch (not allowed around suspension points)',
  apply(sourceFile, diagnostic, tsLib) {
    const start = diagnostic.start;
    if (start === undefined) return null;

    const node = findNodeAtPosition(sourceFile, start, tsLib);
    if (!node) return null;

    // Find the try statement
    let tryStmt: ts.Node | undefined = node;
    while (tryStmt && !tsLib.isTryStatement(tryStmt)) {
      tryStmt = tryStmt.parent;
    }
    if (!tryStmt || !tsLib.isTryStatement(tryStmt)) return null;

    // Replace try { ...body... } catch { ... } with just the body
    const tryBlock = tryStmt.tryBlock;
    const bodyText = tryBlock.statements.map(s => s.getFullText(sourceFile)).join('');

    return [{
      fileName: sourceFile.fileName,
      textChanges: [{
        span: { start: tryStmt.getStart(sourceFile), length: tryStmt.getEnd() - tryStmt.getStart(sourceFile) },
        newText: bodyText.trim(),
      }],
    }];
  },
};

export const processCodeFixes: ProcessCodeFix[] = [
  fixAsyncHandler,
  fixRemoveTryCatch,
];

/**
 * Get process-specific code fixes for the given error codes.
 */
export function getProcessCodeFixes(
  sourceFile: ts.SourceFile,
  diagnostics: readonly ts.Diagnostic[],
  errorCodes: readonly number[],
  tsLib: typeof ts,
): ts.CodeFixAction[] {
  const fixes: ts.CodeFixAction[] = [];

  for (const fix of processCodeFixes) {
    if (!errorCodes.includes(fix.errorCode)) continue;

    // Find all matching diagnostics (not just the first)
    for (const diagnostic of diagnostics) {
      if (diagnostic.code !== fix.errorCode || diagnostic.file !== sourceFile) continue;

      const changes = fix.apply(sourceFile, diagnostic, tsLib);
      if (changes) {
        fixes.push({
          fixName: fix.fixName,
          description: fix.description,
          changes,
        });
      }
    }
  }

  return fixes;
}

function findNodeAtPosition(sourceFile: ts.SourceFile, position: number, tsLib: typeof ts): ts.Node | undefined {
  function find(node: ts.Node): ts.Node | undefined {
    if (position >= node.getStart(sourceFile) && position < node.getEnd()) {
      return tsLib.forEachChild(node, find) || node;
    }
    return undefined;
  }
  return find(sourceFile);
}
