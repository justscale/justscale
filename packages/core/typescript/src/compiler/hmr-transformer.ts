/**
 * HMR (Hot Module Replacement) Transformer
 *
 * TypeScript transformer that enables hot reload for JustScale services.
 *
 * Transforms:
 * 1. Injects stable service IDs into defineService() calls
 * 2. Wraps factory functions with HMR state injection
 * 3. Rewrites variable initializers to use HMR state
 *
 * Example transformation:
 *
 * ```typescript
 * // Input
 * class CacheService extends defineService({
 *   inject: { lifecycle: Lifecycle },
 *   factory: ({ lifecycle }) => {
 *     const cache = new Map()
 *     lifecycle.register('hotReload', () => ({ cache }))
 *     return { get: (k) => cache.get(k) }
 *   }
 * }) {}
 *
 * // Output
 * class CacheService extends defineService({
 *   __serviceId: 'src/services/cache.ts#CacheService',
 *   inject: { lifecycle: Lifecycle },
 *   factory: ((__hmr) =>
 *     ({ lifecycle }) => {
 *       const cache = __hmr?.cache ?? new Map()
 *       lifecycle.register('hotReload', () => ({ cache }))
 *       return { get: (k) => cache.get(k) }
 *     }
 *   )(__getHmrState('src/services/cache.ts#CacheService'))
 * }) {}
 * ```
 */

import ts from 'typescript';
import path from 'node:path';

/**
 * Simple string hash (djb2) to produce a short hex digest.
 */
function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

/**
 * Generate a structural type signature string from a TypeScript type.
 * Recursively walks the type's properties to build a deterministic string.
 */
function hashType(type: ts.Type, checker: ts.TypeChecker, depth = 0): string {
  if (depth > 5) return '*';

  if (type.isStringLiteral()) return `"${type.value}"`;
  if (type.isNumberLiteral()) return `#${type.value}`;
  if (type.flags & ts.TypeFlags.String) return 'string';
  if (type.flags & ts.TypeFlags.Number) return 'number';
  if (type.flags & ts.TypeFlags.Boolean) return 'boolean';
  if (type.flags & ts.TypeFlags.Undefined) return 'undefined';
  if (type.flags & ts.TypeFlags.Null) return 'null';
  if (type.flags & ts.TypeFlags.BigInt) return 'bigint';
  if (type.flags & ts.TypeFlags.Void) return 'void';
  if (type.flags & ts.TypeFlags.Never) return 'never';
  if (type.flags & ts.TypeFlags.Any) return 'any';
  if (type.flags & ts.TypeFlags.Unknown) return 'unknown';

  // Union types
  if (type.isUnion()) {
    const parts = type.types.map(t => hashType(t, checker, depth + 1)).sort();
    return parts.join('|');
  }

  // Intersection types
  if (type.isIntersection()) {
    const parts = type.types.map(t => hashType(t, checker, depth + 1)).sort();
    return parts.join('&');
  }

  // For Map<K,V>, Set<T>, Array<T>: include type args
  const typeArgs = (type as any).typeArguments as ts.Type[] | undefined;
  if (typeArgs && typeArgs.length > 0) {
    const symbol = type.getSymbol();
    const name = symbol?.name ?? 'unknown';
    return `${name}<${typeArgs.map((t: ts.Type) => hashType(t, checker, depth + 1)).join(',')}>`;
  }

  // For objects: sort properties, hash each
  const props = checker.getPropertiesOfType(type);
  if (props.length > 0) {
    const sorted = [...props].sort((a, b) => a.name.localeCompare(b.name));
    const entries = sorted.map(p => {
      const propType = checker.getTypeOfSymbol(p);
      return `${p.name}:${hashType(propType, checker, depth + 1)}`;
    });
    return `{${entries.join(',')}}`;
  }

  return checker.typeToString(type);
}

export interface HmrTransformerOptions {
  /** Enable verbose logging */
  verbose?: boolean
  /** Base directory for relative paths (defaults to cwd) */
  baseDir?: string
  /** Whether to enable HMR transforms (default: true in dev mode) */
  enabled?: boolean
}

/**
 * Creates a TypeScript transformer for HMR support.
 *
 * This should be used in dev mode only. In production builds,
 * set enabled: false to skip all HMR transforms.
 */
export function createHmrTransformer(
  program: ts.Program,
  options: HmrTransformerOptions = {}
): ts.TransformerFactory<ts.SourceFile> {
  const enabled = options.enabled ?? true;
  const baseDir = options.baseDir ?? process.cwd();

  return (context: ts.TransformationContext) => {
    const factory = context.factory;
    const typeChecker = program.getTypeChecker();

    return (sourceFile: ts.SourceFile) => {
      if (!enabled) {
        return sourceFile;
      }

      // Skip node_modules and declaration files
      if (
        sourceFile.fileName.includes('node_modules') ||
        sourceFile.isDeclarationFile
      ) {
        return sourceFile;
      }

      if (options.verbose) {
        console.log(`[hmr-transformer] Processing: ${sourceFile.fileName}`);
      }

      // Track if we need to add __getHmrState import
      let needsHmrImport = false;

      // Track class names for service ID generation
      let currentClassName: string | undefined;

      const visitor = (node: ts.Node): ts.Node => {
        // Track class declarations for service ID naming
        if (ts.isClassDeclaration(node) && node.name) {
          currentClassName = node.name.text;
          const result = ts.visitEachChild(node, visitor, context);
          currentClassName = undefined;
          return result;
        }

        // Look for defineService() calls
        if (ts.isCallExpression(node)) {
          const expr = node.expression;
          if (ts.isIdentifier(expr) && expr.text === 'defineService') {
            const transformed = transformDefineService(
              node,
              sourceFile,
              factory,
              baseDir,
              currentClassName,
              options,
              typeChecker
            );
            if (transformed !== node) {
              needsHmrImport = true;
            }
            return transformed;
          }
        }

        return ts.visitEachChild(node, visitor, context);
      };

      // First pass: transform defineService calls
      let transformedFile = ts.visitNode(sourceFile, visitor) as ts.SourceFile;

      // Second pass: add __getHmrState import if needed
      if (needsHmrImport) {
        transformedFile = addHmrImport(factory, transformedFile);
      }

      return transformedFile;
    };
  };
}

/**
 * Transform a defineService() call to add HMR support.
 */
function transformDefineService(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  factory: ts.NodeFactory,
  baseDir: string,
  className: string | undefined,
  options: HmrTransformerOptions,
  typeChecker?: ts.TypeChecker
): ts.CallExpression {
  // Get the config argument
  const configArg = node.arguments[0];
  if (!configArg || !ts.isObjectLiteralExpression(configArg)) {
    return node;
  }

  // Generate stable service ID
  const relativePath = path.relative(baseDir, sourceFile.fileName);
  const exportName = className ?? 'Anonymous';
  const serviceId = `${relativePath}#${exportName}`;

  if (options.verbose) {
    console.log(`[hmr-transformer] Service ID: ${serviceId}`);
  }

  // Find the factory property
  let factoryProp: ts.PropertyAssignment | undefined;
  let factoryIndex = -1;
  const properties: ts.ObjectLiteralElementLike[] = [];

  for (let i = 0; i < configArg.properties.length; i++) {
    const prop = configArg.properties[i];
    if (
      ts.isPropertyAssignment(prop) &&
      ts.isIdentifier(prop.name) &&
      prop.name.text === 'factory'
    ) {
      factoryProp = prop;
      factoryIndex = i;
    }
    properties.push(prop);
  }

  if (!factoryProp) {
    // No factory property found, just add service ID
    return addServiceIdToConfig(node, configArg, factory, serviceId);
  }

  // Check if factory has a hotReload registration
  const factoryBody = factoryProp.initializer;
  const hotReloadVars = findHotReloadVariables(factoryBody);

  if (hotReloadVars.length === 0) {
    // No hotReload handler, just add service ID
    return addServiceIdToConfig(node, configArg, factory, serviceId);
  }

  if (options.verbose) {
    console.log(`[hmr-transformer] HotReload vars: ${hotReloadVars.join(', ')}`);
  }

  // Compute type hashes for each HMR variable
  const typeHashes = computeTypeHashes(factoryBody, hotReloadVars, typeChecker);

  // Transform the factory:
  // 1. Wrap in IIFE that receives __hmr
  // 2. Rewrite variable initializers to use __hmr?.x ?? original
  const wrappedFactory = wrapFactoryWithHmr(
    factoryBody,
    factory,
    serviceId,
    hotReloadVars,
    typeHashes
  );

  // Replace factory property
  const newFactoryProp = factory.createPropertyAssignment(
    factory.createIdentifier('factory'),
    wrappedFactory
  );

  // Build new properties array with __serviceId and wrapped factory
  const newProperties: ts.ObjectLiteralElementLike[] = [
    // Add __serviceId first
    factory.createPropertyAssignment(
      factory.createIdentifier('__serviceId'),
      factory.createStringLiteral(serviceId)
    ),
  ];

  for (let i = 0; i < properties.length; i++) {
    if (i === factoryIndex) {
      newProperties.push(newFactoryProp);
    } else {
      newProperties.push(properties[i]);
    }
  }

  // Create new config object
  const newConfig = factory.createObjectLiteralExpression(newProperties, true);

  // Return new defineService call
  return factory.createCallExpression(
    node.expression,
    node.typeArguments,
    [newConfig]
  );
}

/**
 * Add __serviceId to a defineService config without wrapping the factory.
 */
function addServiceIdToConfig(
  node: ts.CallExpression,
  config: ts.ObjectLiteralExpression,
  factory: ts.NodeFactory,
  serviceId: string
): ts.CallExpression {
  // Check if __serviceId already exists
  for (const prop of config.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ts.isIdentifier(prop.name) &&
      prop.name.text === '__serviceId'
    ) {
      return node; // Already has service ID
    }
  }

  const newProperties: ts.ObjectLiteralElementLike[] = [
    factory.createPropertyAssignment(
      factory.createIdentifier('__serviceId'),
      factory.createStringLiteral(serviceId)
    ),
    ...config.properties,
  ];

  const newConfig = factory.createObjectLiteralExpression(newProperties, true);

  return factory.createCallExpression(
    node.expression,
    node.typeArguments,
    [newConfig]
  );
}

/**
 * Compute type hashes for HMR variables by finding their declarations
 * and using the TypeChecker to get structural type info.
 *
 * Returns a map of variable name -> type hash string.
 * If no TypeChecker is available, returns empty map (fallback to key-only validation).
 */
function computeTypeHashes(
  factoryBody: ts.Expression,
  hotReloadVars: string[],
  typeChecker?: ts.TypeChecker
): Record<string, string> {
  const hashes: Record<string, string> = {};

  if (!typeChecker) {
    // No type checker available - use empty string as fallback hash
    for (const v of hotReloadVars) {
      hashes[v] = '';
    }
    return hashes;
  }

  const varSet = new Set(hotReloadVars);
  const declarations = new Map<string, ts.VariableDeclaration>();

  // Walk the factory body to find variable declarations
  const findDecls = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (varSet.has(node.name.text)) {
        declarations.set(node.name.text, node);
      }
    }
    ts.forEachChild(node, findDecls);
  };
  ts.forEachChild(factoryBody, findDecls);

  for (const v of hotReloadVars) {
    const decl = declarations.get(v);
    if (decl) {
      try {
        const type = typeChecker.getTypeAtLocation(decl);
        const sig = hashType(type, typeChecker);
        hashes[v] = simpleHash(sig);
      } catch {
        // If type checking fails, use empty hash (always matches empty)
        hashes[v] = '';
      }
    } else {
      hashes[v] = '';
    }
  }

  return hashes;
}

/**
 * Find variables that are returned from a hotReload registration.
 *
 * Looks for patterns like:
 *   lifecycle.register('hotReload', () => ({ cache, count }))
 */
function findHotReloadVariables(factoryBody: ts.Expression): string[] {
  const vars: string[] = [];

  const visitor = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      // Check for lifecycle.register('hotReload', ...)
      const expr = node.expression;
      if (
        ts.isPropertyAccessExpression(expr) &&
        expr.name.text === 'register' &&
        node.arguments.length >= 2
      ) {
        const hookArg = node.arguments[0];
        if (ts.isStringLiteral(hookArg) && hookArg.text === 'hotReload') {
          // Found hotReload registration, extract variable names from return
          const handler = node.arguments[1];
          if (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler)) {
            extractReturnedVariables(handler.body, vars);
          }
        }
      }
    }
    ts.forEachChild(node, visitor);
  };

  ts.forEachChild(factoryBody, visitor);
  return vars;
}

/**
 * Extract variable names from a return expression like { cache, count }.
 */
function extractReturnedVariables(body: ts.ConciseBody, vars: string[]): void {
  // Handle arrow function with direct object return: () => ({ x, y })
  if (ts.isParenthesizedExpression(body)) {
    const inner = body.expression;
    if (ts.isObjectLiteralExpression(inner)) {
      extractFromObjectLiteral(inner, vars);
      return;
    }
  }

  // Handle object literal directly
  if (ts.isObjectLiteralExpression(body)) {
    extractFromObjectLiteral(body, vars);
    return;
  }

  // Handle block body with return statement
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      if (ts.isReturnStatement(stmt) && stmt.expression) {
        if (ts.isObjectLiteralExpression(stmt.expression)) {
          extractFromObjectLiteral(stmt.expression, vars);
        }
      }
    }
  }
}

/**
 * Extract variable names from object literal shorthand properties.
 */
function extractFromObjectLiteral(
  obj: ts.ObjectLiteralExpression,
  vars: string[]
): void {
  for (const prop of obj.properties) {
    if (ts.isShorthandPropertyAssignment(prop)) {
      // { cache } -> variable name is 'cache'
      vars.push(prop.name.text);
    } else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
      // { cache: cache } -> variable name is the value if it's an identifier
      if (ts.isIdentifier(prop.initializer)) {
        vars.push(prop.initializer.text);
      }
    }
  }
}

/**
 * Wrap a factory function with HMR state injection.
 *
 * Transforms:
 *   ({ lifecycle }) => { const cache = new Map(); ... }
 * Into:
 *   ((__hmr) => ({ lifecycle }) => { const cache = __hmr?.cache ?? new Map(); ... })(__validateHmrState(__getHmrState('id'), {cache: 'a1b2c3'}))
 *
 * The __validateHmrState call ensures that stale or structurally incompatible
 * state is discarded rather than silently injected. It compares per-variable
 * type hashes to detect type changes between reloads.
 */
function wrapFactoryWithHmr(
  factoryBody: ts.Expression,
  factory: ts.NodeFactory,
  serviceId: string,
  hotReloadVars: string[],
  typeHashes: Record<string, string>
): ts.Expression {
  // Rewrite variable initializers in the factory body
  const rewrittenFactory = rewriteVariableInitializers(
    factoryBody,
    factory,
    hotReloadVars
  );

  // Create the wrapper: ((__hmr) => rewrittenFactory)
  const hmrParam = factory.createParameterDeclaration(
    undefined,
    undefined,
    factory.createIdentifier('__hmr'),
    undefined,
    undefined,
    undefined
  );

  const wrapperArrow = factory.createArrowFunction(
    undefined,
    undefined,
    [hmrParam],
    undefined,
    factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken),
    rewrittenFactory
  );

  // Create the IIFE call: (wrapper)(__validateHmrState(__getHmrState('serviceId'), {var1: 'hash1', var2: 'hash2'}, 'serviceId'))
  const getHmrStateCall = factory.createCallExpression(
    factory.createIdentifier('__getHmrState'),
    undefined,
    [factory.createStringLiteral(serviceId)]
  );

  // Build { varName: 'typeHash', ... } object literal
  const schemaProperties = hotReloadVars.map(v =>
    factory.createPropertyAssignment(
      factory.createIdentifier(v),
      factory.createStringLiteral(typeHashes[v] ?? '')
    )
  );
  const expectedSchema = factory.createObjectLiteralExpression(schemaProperties, false);

  const validateCall = factory.createCallExpression(
    factory.createIdentifier('__validateHmrState'),
    undefined,
    [getHmrStateCall, expectedSchema, factory.createStringLiteral(serviceId)]
  );

  return factory.createCallExpression(
    factory.createParenthesizedExpression(wrapperArrow),
    undefined,
    [validateCall]
  );
}

/**
 * Rewrite variable declarations to use HMR state.
 *
 * Transforms:
 *   const cache = new Map()
 * Into:
 *   const cache = __hmr?.cache ?? new Map()
 */
function rewriteVariableInitializers(
  node: ts.Expression,
  factory: ts.NodeFactory,
  hotReloadVars: string[]
): ts.Expression {
  const varSet = new Set(hotReloadVars);

  // Recursive rewriter for variable declarations
  function rewriteNode(n: ts.Node): ts.Node {
    // Look for variable declarations
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      const varName = n.name.text;
      if (varSet.has(varName) && n.initializer) {
        // Rewrite: const x = init  ->  const x = __hmr?.x ?? init
        const hmrAccess = factory.createPropertyAccessChain(
          factory.createIdentifier('__hmr'),
          factory.createToken(ts.SyntaxKind.QuestionDotToken),
          factory.createIdentifier(varName)
        );
        const nullishCoalesce = factory.createBinaryExpression(
          hmrAccess,
          factory.createToken(ts.SyntaxKind.QuestionQuestionToken),
          n.initializer
        );
        return factory.updateVariableDeclaration(
          n,
          n.name,
          n.exclamationToken,
          n.type,
          nullishCoalesce
        );
      }
    }

    // For variable statements, we need to manually visit children
    if (ts.isVariableStatement(n)) {
      const newDeclarations = n.declarationList.declarations.map(decl =>
        rewriteNode(decl) as ts.VariableDeclaration
      );
      const newList = factory.updateVariableDeclarationList(
        n.declarationList,
        newDeclarations
      );
      return factory.updateVariableStatement(n, n.modifiers, newList);
    }

    // For blocks, manually visit statements
    if (ts.isBlock(n)) {
      const newStatements = n.statements.map(stmt => rewriteNode(stmt) as ts.Statement);
      return factory.updateBlock(n, newStatements);
    }

    // For arrow functions in the body (nested)
    if (ts.isArrowFunction(n)) {
      if (ts.isBlock(n.body)) {
        const newBody = rewriteNode(n.body) as ts.Block;
        return factory.updateArrowFunction(
          n,
          n.modifiers,
          n.typeParameters,
          n.parameters,
          n.type,
          n.equalsGreaterThanToken,
          newBody
        );
      }
      return n;
    }

    // For function expressions (nested)
    if (ts.isFunctionExpression(n)) {
      const newBody = rewriteNode(n.body) as ts.Block;
      return factory.updateFunctionExpression(
        n,
        n.modifiers,
        n.asteriskToken,
        n.name,
        n.typeParameters,
        n.parameters,
        n.type,
        newBody
      );
    }

    // For other nodes, try to visit children manually for known types
    if (ts.isReturnStatement(n)) {
      return factory.updateReturnStatement(
        n,
        n.expression ? rewriteNode(n.expression) as ts.Expression : undefined
      );
    }

    if (ts.isExpressionStatement(n)) {
      return factory.updateExpressionStatement(
        n,
        rewriteNode(n.expression) as ts.Expression
      );
    }

    if (ts.isCallExpression(n)) {
      const newArgs = n.arguments.map(arg => rewriteNode(arg) as ts.Expression);
      return factory.updateCallExpression(
        n,
        rewriteNode(n.expression) as ts.Expression,
        n.typeArguments,
        newArgs
      );
    }

    if (ts.isPropertyAccessExpression(n)) {
      return factory.updatePropertyAccessExpression(
        n,
        rewriteNode(n.expression) as ts.Expression,
        n.name
      );
    }

    if (ts.isObjectLiteralExpression(n)) {
      const newProperties = n.properties.map(prop => {
        if (ts.isPropertyAssignment(prop)) {
          return factory.updatePropertyAssignment(
            prop,
            prop.name,
            rewriteNode(prop.initializer) as ts.Expression
          );
        }
        return prop;
      });
      return factory.updateObjectLiteralExpression(n, newProperties);
    }

    // Return unchanged for nodes we don't handle
    return n;
  }

  // Handle arrow function vs function expression at top level
  if (ts.isArrowFunction(node)) {
    if (ts.isBlock(node.body)) {
      const newBody = rewriteNode(node.body) as ts.Block;
      return factory.updateArrowFunction(
        node,
        node.modifiers,
        node.typeParameters,
        node.parameters,
        node.type,
        node.equalsGreaterThanToken,
        newBody
      );
    }
    return node;
  }

  if (ts.isFunctionExpression(node)) {
    const newBody = rewriteNode(node.body) as ts.Block;
    return factory.updateFunctionExpression(
      node,
      node.modifiers,
      node.asteriskToken,
      node.name,
      node.typeParameters,
      node.parameters,
      node.type,
      newBody
    );
  }

  return node;
}

/**
 * Add __getHmrState import from @justscale/core.
 */
function addHmrImport(
  factory: ts.NodeFactory,
  sourceFile: ts.SourceFile
): ts.SourceFile {
  const statements: ts.Statement[] = [];
  let foundCoreImport = false;

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const moduleSpecifier = stmt.moduleSpecifier;
      if (
        ts.isStringLiteral(moduleSpecifier) &&
        moduleSpecifier.text === '@justscale/core'
      ) {
        foundCoreImport = true;
        const importClause = stmt.importClause;

        if (
          importClause &&
          importClause.namedBindings &&
          ts.isNamedImports(importClause.namedBindings)
        ) {
          // Check which HMR imports are already present
          const existingNames = new Set(
            importClause.namedBindings.elements.map(spec => spec.name.text)
          );
          const hmrImports = ['__getHmrState', '__validateHmrState'];
          const missing = hmrImports.filter(name => !existingNames.has(name));

          if (missing.length > 0) {
            // Add missing HMR imports
            const newSpecifiers = [
              ...importClause.namedBindings.elements,
              ...missing.map(name =>
                factory.createImportSpecifier(
                  false,
                  undefined,
                  factory.createIdentifier(name)
                )
              ),
            ];

            statements.push(
              factory.createImportDeclaration(
                stmt.modifiers,
                factory.createImportClause(
                  importClause.isTypeOnly,
                  importClause.name,
                  factory.createNamedImports(newSpecifiers)
                ),
                moduleSpecifier,
                stmt.attributes
              )
            );
            continue;
          }
        }
      }
    }
    statements.push(stmt);
  }

  // If no @justscale/core import found, add one
  if (!foundCoreImport) {
    statements.unshift(
      factory.createImportDeclaration(
        undefined,
        factory.createImportClause(
          false,
          undefined,
          factory.createNamedImports([
            factory.createImportSpecifier(
              false,
              undefined,
              factory.createIdentifier('__getHmrState')
            ),
            factory.createImportSpecifier(
              false,
              undefined,
              factory.createIdentifier('__validateHmrState')
            ),
          ])
        ),
        factory.createStringLiteral('@justscale/core'),
        undefined
      )
    );
  }

  return factory.updateSourceFile(sourceFile, statements);
}
