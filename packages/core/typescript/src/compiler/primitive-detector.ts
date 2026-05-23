/**
 * @justscale/typescript - Primitive Detection
 *
 * Uses TypeScript's type system to detect process primitives (signal, delay, race)
 * rather than simple string matching. This handles:
 * - Renamed imports (import { signal as s })
 * - Re-exports from other modules
 * - Complex expressions
 */

import ts from 'typescript';

/** Known delay unit methods */
const DELAY_UNITS = new Set(['seconds', 'minutes', 'hours', 'days']);

/** Known signal combinator methods */
const SIGNAL_COMBINATORS = new Set(['all', 'settled']);

/** The module we're looking for primitives from */
const PROCESS_MODULE = '@justscale/core/process';

/**
 * Result of checking if an expression is a process primitive call.
 */
export interface PrimitiveCallInfo {
  kind: 'signal' | 'delay' | 'race' | 'signal.all' | 'signal.settled' | 'stream' | 'scope'
  /** For race switch patterns: the race variable if present */
  raceVar?: string
  /** The call expression node */
  node: ts.CallExpression
  /** For delay: the time unit (seconds, minutes, hours, days) */
  delayUnit?: 'seconds' | 'minutes' | 'hours' | 'days'
  /** For signal.all/settled: whether it's the object form (vs array) */
  isObjectForm?: boolean
}

/**
 * Check if a call expression is a process primitive call.
 * Uses the type checker to resolve the actual symbol being called.
 */
export function getPrimitiveCall(
  node: ts.CallExpression,
  typeChecker: ts.TypeChecker
): PrimitiveCallInfo | null {
  const callee = node.expression;

  // Check for delay.xxx() pattern (property access: delay.minutes, delay.hours, etc.)
  if (ts.isPropertyAccessExpression(callee)) {
    const delayResult = checkDelayPropertyAccess(callee, node, typeChecker);
    if (delayResult) return delayResult;

    // Check for signal.all() or signal.settled() pattern
    const signalCombinatorResult = checkSignalCombinatorCall(callee, node, typeChecker);
    if (signalCombinatorResult) return signalCombinatorResult;
  }

  // Get the symbol of the function being called
  const symbol = typeChecker.getSymbolAtLocation(callee);
  if (!symbol) {
    // Fallback: try identifier matching for cases where type checker fails
    return getPrimitiveCallByName(node);
  }

  // Follow aliases to get the original symbol
  const originalSymbol = symbol.flags & ts.SymbolFlags.Alias
    ? typeChecker.getAliasedSymbol(symbol)
    : symbol;

  // Check if the symbol is declared in @justscale/core/process
  const declarations = originalSymbol.getDeclarations();
  if (!declarations || declarations.length === 0) {
    return getPrimitiveCallByName(node);
  }

  // Check if any declaration is from the process module
  const isFromProcessModule = declarations.some(decl => {
    const sourceFile = decl.getSourceFile();
    const fileName = sourceFile.fileName;

    // Check if it's from @justscale/core/process
    return (
      fileName.includes('@justscale/core/process') ||
      fileName.includes('justscale/process') ||
      // Also check the module specifier in imports
      isImportedFromProcessModule(decl, typeChecker)
    );
  });

  if (!isFromProcessModule) {
    return getPrimitiveCallByName(node);
  }

  // Get the primitive name
  const primitiveName = originalSymbol.getName();

  if (primitiveName === 'signal' || primitiveName === 'waitFor') {
    return { kind: 'signal', node };
  }

  if (primitiveName === 'race') {
    return { kind: 'race', node };
  }

  if (primitiveName === 'stream') {
    return { kind: 'stream', node };
  }

  if (primitiveName === 'scope') {
    return { kind: 'scope', node };
  }

  return null;
}

/**
 * Check for delay.xxx() pattern (delay.seconds, delay.minutes, etc.)
 */
function checkDelayPropertyAccess(
  callee: ts.PropertyAccessExpression,
  node: ts.CallExpression,
  typeChecker: ts.TypeChecker
): PrimitiveCallInfo | null {
  const methodName = callee.name.text;

  // Check if method is a valid delay unit
  if (!DELAY_UNITS.has(methodName)) {
    return null;
  }

  const obj = callee.expression;

  // Try type-based detection first
  const symbol = typeChecker.getSymbolAtLocation(obj);
  if (symbol) {
    const originalSymbol = symbol.flags & ts.SymbolFlags.Alias
      ? typeChecker.getAliasedSymbol(symbol)
      : symbol;

    const declarations = originalSymbol.getDeclarations();
    if (declarations && declarations.length > 0) {
      const isFromProcessModule = declarations.some(decl => {
        const sourceFile = decl.getSourceFile();
        const fileName = sourceFile.fileName;
        return (
          fileName.includes('@justscale/core/process') ||
          fileName.includes('justscale/process') ||
          isImportedFromProcessModule(decl, typeChecker)
        );
      });

      if (isFromProcessModule && originalSymbol.getName() === 'delay') {
        return {
          kind: 'delay',
          node,
          delayUnit: methodName as 'seconds' | 'minutes' | 'hours' | 'days',
        };
      }
    }
  }

  // Fallback: check by identifier name
  if (ts.isIdentifier(obj) && obj.text === 'delay') {
    return {
      kind: 'delay',
      node,
      delayUnit: methodName as 'seconds' | 'minutes' | 'hours' | 'days',
    };
  }

  return null;
}

/**
 * Check for signal.all() or signal.settled() pattern.
 */
function checkSignalCombinatorCall(
  callee: ts.PropertyAccessExpression,
  node: ts.CallExpression,
  typeChecker: ts.TypeChecker
): PrimitiveCallInfo | null {
  const methodName = callee.name.text;

  // Check if method is a valid signal combinator
  if (!SIGNAL_COMBINATORS.has(methodName)) {
    return null;
  }

  const obj = callee.expression;

  // Determine if it's object form or array form by looking at the first argument
  let isObjectForm = false;
  const args = node.arguments;
  if (args.length > 0) {
    const firstArg = args[0];
    // If first arg is an object literal, it's object form
    // If first arg is array literal, it's array form
    isObjectForm = ts.isObjectLiteralExpression(firstArg);
  }

  // Try type-based detection first
  const symbol = typeChecker.getSymbolAtLocation(obj);
  if (symbol) {
    const originalSymbol = symbol.flags & ts.SymbolFlags.Alias
      ? typeChecker.getAliasedSymbol(symbol)
      : symbol;

    const declarations = originalSymbol.getDeclarations();
    if (declarations && declarations.length > 0) {
      const isFromProcessModule = declarations.some(decl => {
        const sourceFile = decl.getSourceFile();
        const fileName = sourceFile.fileName;
        return (
          fileName.includes('@justscale/core/process') ||
          fileName.includes('justscale/process') ||
          isImportedFromProcessModule(decl, typeChecker)
        );
      });

      if (isFromProcessModule && originalSymbol.getName() === 'signal') {
        return {
          kind: methodName === 'all' ? 'signal.all' : 'signal.settled',
          node,
          isObjectForm,
        };
      }
    }
  }

  // Fallback: check by identifier name
  if (ts.isIdentifier(obj) && obj.text === 'signal') {
    return {
      kind: methodName === 'all' ? 'signal.all' : 'signal.settled',
      node,
      isObjectForm,
    };
  }

  return null;
}

/**
 * Fallback: Check by identifier name when type checker can't resolve.
 * This handles cases in isolated compilation where full type info isn't available.
 */
function getPrimitiveCallByName(node: ts.CallExpression): PrimitiveCallInfo | null {
  const callee = node.expression;

  // Check for delay.xxx() pattern
  if (ts.isPropertyAccessExpression(callee)) {
    const methodName = callee.name.text;
    if (DELAY_UNITS.has(methodName) && ts.isIdentifier(callee.expression) && callee.expression.text === 'delay') {
      return {
        kind: 'delay',
        node,
        delayUnit: methodName as 'seconds' | 'minutes' | 'hours' | 'days',
      };
    }

    // Check for signal.all() / signal.settled() pattern
    if (SIGNAL_COMBINATORS.has(methodName) && ts.isIdentifier(callee.expression) && callee.expression.text === 'signal') {
      let isObjectForm = false;
      if (node.arguments.length > 0) {
        isObjectForm = ts.isObjectLiteralExpression(node.arguments[0]);
      }
      return {
        kind: methodName === 'all' ? 'signal.all' : 'signal.settled',
        node,
        isObjectForm,
      };
    }
  }

  if (ts.isIdentifier(callee)) {
    const name = callee.text;

    if (name === 'signal' || name === 'waitFor') {
      return { kind: 'signal', node };
    }

    if (name === 'race') {
      return { kind: 'race', node };
    }

    if (name === 'stream') {
      return { kind: 'stream', node };
    }

    if (name === 'scope') {
      return { kind: 'scope', node };
    }
  }

  return null;
}

/**
 * Check if a declaration is imported from the process module.
 */
function isImportedFromProcessModule(
  decl: ts.Declaration,
  _typeChecker: ts.TypeChecker
): boolean {
  // Walk up to find the import declaration
  let node: ts.Node = decl;
  while (node && !ts.isSourceFile(node)) {
    if (ts.isImportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpecifier)) {
        return moduleSpecifier.text === PROCESS_MODULE;
      }
    }
    node = node.parent;
  }
  return false;
}

/**
 * Check if an expression contains any suspension points (await on primitives).
 * This is a deep check that handles:
 * - Direct: await signal(x)
 * - Nested: const { a } = await signal(x)
 * - Complex: (await signal(x)).value + (await signal(y)).value
 */
export function containsSuspensionPoint(
  expr: ts.Expression,
  typeChecker: ts.TypeChecker
): boolean {
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;

    // Check for await expressions
    if (ts.isAwaitExpression(node)) {
      const inner = node.expression;

      // Direct call: await signal(x), await signal.all([...]), etc.
      if (ts.isCallExpression(inner)) {
        const primitive = getPrimitiveCall(inner, typeChecker);
        if (primitive && (
          primitive.kind === 'signal' ||
          primitive.kind === 'delay' ||
          primitive.kind === 'signal.all' ||
          primitive.kind === 'signal.settled' ||
          primitive.kind === 'scope'
        )) {
          found = true;
          return;
        }
      }
    }

    // Recurse into children
    ts.forEachChild(node, visit);
  };

  visit(expr);
  return found;
}

/**
 * Find all await expressions on primitives within an expression.
 * Returns them in order of appearance.
 */
export function findSuspensionPoints(
  expr: ts.Expression,
  typeChecker: ts.TypeChecker
): Array<{ await: ts.AwaitExpression; primitive: PrimitiveCallInfo }> {
  const results: Array<{ await: ts.AwaitExpression; primitive: PrimitiveCallInfo }> = [];

  const visit = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node)) {
      const inner = node.expression;

      if (ts.isCallExpression(inner)) {
        const primitive = getPrimitiveCall(inner, typeChecker);
        if (primitive && (
          primitive.kind === 'signal' ||
          primitive.kind === 'delay' ||
          primitive.kind === 'signal.all' ||
          primitive.kind === 'signal.settled' ||
          primitive.kind === 'scope'
        )) {
          results.push({ await: node, primitive });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(expr);
  return results;
}

/**
 * Check if an expression is a signal.all() or signal.settled() call.
 */
export function isSignalCombinatorCall(
  node: ts.CallExpression,
  typeChecker: ts.TypeChecker
): boolean {
  const primitive = getPrimitiveCall(node, typeChecker);
  return primitive?.kind === 'signal.all' || primitive?.kind === 'signal.settled';
}

/**
 * Check if an expression is a race() call.
 */
export function isRaceCall(
  node: ts.CallExpression,
  typeChecker: ts.TypeChecker
): boolean {
  const primitive = getPrimitiveCall(node, typeChecker);
  return primitive?.kind === 'race';
}

/**
 * Check if an expression is a signal() or waitFor() call.
 */
export function isSignalCall(
  node: ts.CallExpression,
  typeChecker: ts.TypeChecker
): boolean {
  const primitive = getPrimitiveCall(node, typeChecker);
  return primitive?.kind === 'signal';
}

/**
 * Check if an expression is a delay() call.
 */
export function isDelayCall(
  node: ts.CallExpression,
  typeChecker: ts.TypeChecker
): boolean {
  const primitive = getPrimitiveCall(node, typeChecker);
  return primitive?.kind === 'delay';
}

/**
 * Check if an expression is a scope() call.
 */
export function isScopeCall(
  node: ts.CallExpression,
  typeChecker: ts.TypeChecker
): boolean {
  const primitive = getPrimitiveCall(node, typeChecker);
  return primitive?.kind === 'scope';
}

/**
 * Check if an expression is a stream() call.
 */
export function isStreamCall(
  node: ts.CallExpression,
  typeChecker: ts.TypeChecker
): boolean {
  const primitive = getPrimitiveCall(node, typeChecker);
  return primitive?.kind === 'stream';
}
