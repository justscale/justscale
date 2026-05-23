/**
 * Exports Pre-pass
 *
 * Two-pass compilation for process exports type inference.
 *
 * Pass 1: Create a TypeScript program, find `using exports = { ... }` declarations
 *         in process handlers, extract the type via typeChecker.getTypeAtLocation().
 * Pass 2: Inject `__exportsType: void 0 as unknown as <ExportsType>` into the
 *         createProcess config, re-create the program. TypeScript now infers TExports
 *         correctly from the phantom property.
 *
 * Non-exported types referenced by the exports (e.g. local interfaces) are
 * automatically exported so the declaration emitter can reference them.
 *
 * This gives us correct types everywhere: type checking, .d.ts output, IDE.
 */

import ts from 'typescript';

interface ExportsInjection {
  /** The config object literal node (argument to createProcess) */
  configNode: ts.ObjectLiteralExpression
  /** The exports type printed as text */
  typeText: string
  /** Positions of non-exported type declarations that need `export` added */
  autoExportPositions: number[]
}

/**
 * Extract exports types from all process files in a program and return
 * modified source texts with `__exportsType` phantom properties injected.
 *
 * Returns a map from file name to modified source text.
 * Only files that contain createProcess calls with `using exports` are included.
 */
export function extractAndInjectExportsTypes(
  program: ts.Program,
): Map<string, string> {
  const typeChecker = program.getTypeChecker();
  const printer = ts.createPrinter();
  const modifiedSources = new Map<string, string>();

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || sourceFile.fileName.includes('node_modules')) continue;

    const injections = findExportsInjections(sourceFile, typeChecker, printer);
    if (injections.length === 0) continue;

    const modifiedText = applyInjections(sourceFile.text, injections);
    modifiedSources.set(sourceFile.fileName, modifiedText);
  }

  return modifiedSources;
}

/**
 * Create a compiler host that serves modified source for specific files,
 * falling back to the base host for everything else.
 */
export function createModifiedHost(
  baseHost: ts.CompilerHost,
  modifiedSources: Map<string, string>,
): ts.CompilerHost {
  return {
    ...baseHost,
    getSourceFile: (name, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
      if (modifiedSources.has(name)) {
        return ts.createSourceFile(
          name,
          modifiedSources.get(name)!,
          languageVersionOrOptions as ts.ScriptTarget,
          true,
        );
      }
      return baseHost.getSourceFile(name, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
    },
    readFile: (name) => {
      if (modifiedSources.has(name)) return modifiedSources.get(name)!;
      return baseHost.readFile(name);
    },
  };
}

/**
 * Find all createProcess calls with `using exports` in a source file
 * and extract the exports type for injection.
 */
function findExportsInjections(
  sourceFile: ts.SourceFile,
  typeChecker: ts.TypeChecker,
  printer: ts.Printer,
): ExportsInjection[] {
  const injections: ExportsInjection[] = [];

  ts.forEachChild(sourceFile, function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'createProcess'
    ) {
      const configArg = node.arguments[0];
      if (configArg && ts.isObjectLiteralExpression(configArg)) {
        const handler = findHandler(configArg);
        if (handler) {
          const exportDecl = findExportsDeclaration(handler);
          if (exportDecl) {
            const type = typeChecker.getTypeAtLocation(exportDecl);
            const typeNode = typeChecker.typeToTypeNode(
              type,
              exportDecl,
              ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.WriteArrayAsGenericType,
            );
            if (typeNode) {
              const typeText = printer.printNode(ts.EmitHint.Unspecified, typeNode, sourceFile);

              // Find non-exported types referenced by the exports type
              // and collect their declaration positions so we can auto-export them
              const autoExportPositions = findNonExportedTypePositions(type, typeChecker, sourceFile);

              injections.push({ configNode: configArg, typeText, autoExportPositions });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  });

  return injections;
}

/**
 * Find non-exported types referenced by the exports type and return
 * the source positions of their declarations (where we need to add `export`).
 *
 * Uses a simple approach: walk the type node text produced by typeToTypeNode
 * and look for identifiers that reference non-exported local declarations.
 * This avoids recursive type walking which can stack overflow on circular types.
 */
function findNonExportedTypePositions(
  type: ts.Type,
  typeChecker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): number[] {
  const positions: number[] = [];
  const checked = new Set<string>();

  // Collect all named types visible in the source file
  const localTypes = new Map<string, ts.Declaration>();
  for (const stmt of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(stmt) && !hasExportModifier(stmt)) {
      localTypes.set(stmt.name.text, stmt);
    } else if (ts.isTypeAliasDeclaration(stmt) && !hasExportModifier(stmt)) {
      localTypes.set(stmt.name.text, stmt);
    } else if (ts.isEnumDeclaration(stmt) && !hasExportModifier(stmt)) {
      localTypes.set(stmt.name.text, stmt);
    }
  }

  if (localTypes.size === 0) return [];

  // Walk the type (breadth-first, depth-limited) to find references to local types
  const queue: ts.Type[] = [type];
  const visited = new Set<number>(); // use type id to avoid revisiting

  while (queue.length > 0 && visited.size < 100) {
    const t = queue.shift()!;
    const id = (t as any).id as number | undefined;
    if (id !== undefined && visited.has(id)) continue;
    if (id !== undefined) visited.add(id);

    // Check if this type's symbol matches a local non-exported type
    const sym = t.getSymbol() ?? t.aliasSymbol;
    if (sym && !checked.has(sym.name) && localTypes.has(sym.name)) {
      checked.add(sym.name);
      const decl = localTypes.get(sym.name)!;
      positions.push(decl.getStart());
    }

    // Enqueue type arguments
    const typeArgs = (t as any).typeArguments ?? (t as any).resolvedTypeArguments;
    if (Array.isArray(typeArgs)) {
      for (const arg of typeArgs) queue.push(arg);
    }

    // Enqueue union/intersection members
    if (t.isUnion() || t.isIntersection()) {
      for (const member of t.types) queue.push(member);
    }

    // Enqueue property types (limited - only direct properties)
    try {
      for (const prop of typeChecker.getPropertiesOfType(t)) {
        const propType = typeChecker.getTypeOfSymbol(prop);
        queue.push(propType);
      }
    } catch {
      // getPropertiesOfType can throw on some synthetic types
    }

    // Enqueue call signature return/param types
    for (const sig of t.getCallSignatures()) {
      queue.push(typeChecker.getReturnTypeOfSignature(sig));
      for (const param of sig.getParameters()) {
        queue.push(typeChecker.getTypeOfSymbol(param));
      }
    }
  }

  return [...new Set(positions)];
}

function hasExportModifier(node: ts.Declaration): boolean {
  return (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) ?? false;
}

/**
 * Find the handler function in a createProcess config object.
 */
function findHandler(
  configObj: ts.ObjectLiteralExpression,
): ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration | undefined {
  for (const prop of configObj.properties) {
    if (ts.isMethodDeclaration(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'handler') {
      return prop;
    }
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === 'handler') {
      if (ts.isFunctionExpression(prop.initializer) || ts.isArrowFunction(prop.initializer)) {
        return prop.initializer;
      }
    }
  }
  return undefined;
}

/**
 * Find `using exports = { ... }` in a handler body.
 * Simple AST walk - no full analyzer needed.
 */
function findExportsDeclaration(
  handler: ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration,
): ts.VariableDeclaration | undefined {
  const body = handler.body;
  if (!body || !ts.isBlock(body)) return undefined;

  for (const stmt of body.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.name.text === 'exports' &&
        decl.initializer &&
        ts.isObjectLiteralExpression(decl.initializer)
      ) {
        return decl;
      }
    }
  }
  return undefined;
}

/**
 * Apply exports type injections into source text.
 * - Inserts `__exportsType: void 0 as unknown as <type>` into each createProcess config
 * - Adds `export` to non-exported type declarations referenced by the exports type
 *
 * Uses AST node positions for precise insertion - not pattern matching.
 */
function applyInjections(sourceText: string, injections: ExportsInjection[]): string {
  // Collect all modifications: { position, text } sorted by position descending
  const mods: { pos: number, insert: string }[] = [];

  for (const { configNode, typeText, autoExportPositions } of injections) {
    // 1. Inject __exportsType into config object
    const closingBracePos = configNode.end - 1;
    const lastProp = configNode.properties[configNode.properties.length - 1];
    if (!lastProp) continue;

    const textBetween = sourceText.substring(lastProp.end, closingBracePos);
    const hasTrailingComma = textBetween.includes(',');
    const comma = hasTrailingComma ? '' : ',';
    mods.push({ pos: closingBracePos, insert: `${comma} __exportsType: void 0 as unknown as ${typeText}` });

    // 2. Add `export` to non-exported type declarations
    for (const pos of autoExportPositions) {
      mods.push({ pos, insert: 'export ' });
    }
  }

  // Sort by position descending so later insertions don't shift earlier positions
  mods.sort((a, b) => b.pos - a.pos);

  // Deduplicate by position (same type might be referenced by multiple processes)
  const seen = new Set<number>();
  const uniqueMods = mods.filter(m => {
    if (seen.has(m.pos)) return false;
    seen.add(m.pos);
    return true;
  });

  let result = sourceText;
  for (const { pos, insert } of uniqueMods) {
    result = result.slice(0, pos) + insert + result.slice(pos);
  }

  return result;
}
