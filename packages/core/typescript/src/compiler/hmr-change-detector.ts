/**
 * HMR Change Detector
 *
 * Analyzes two versions of TypeScript source code to determine:
 * 1. Which services changed
 * 2. What kind of changes occurred (method-only vs structural)
 * 3. Which specific methods changed (for method patching)
 *
 * This enables the dev server to choose between:
 * - method-patch: Only method bodies changed, can do in-place patching
 * - full-reload: Structural changes, need full service reload with state migration
 */

import ts from 'typescript';

export interface ServiceChange {
  /** Stable service ID (file#ClassName) */
  serviceId: string
  /** Type of change detected */
  changeType: 'method-only' | 'structural'
  /** List of changed method names (only for method-only changes) */
  changedMethods: string[]
  /** Description of what changed (for debugging) */
  reason: string
}

export interface ChangeDetectionResult {
  /** Whether any services changed */
  hasChanges: boolean
  /** List of changed services */
  services: ServiceChange[]
  /** Services that were added (new file or new class) */
  added: string[]
  /** Services that were removed */
  removed: string[]
}

interface ServiceSignature {
  /** Service ID */
  id: string
  /** Class name */
  className: string
  /** Inject object signature (stringified) */
  injectSignature: string
  /** Method signatures: name -> normalized signature */
  methods: Map<string, string>
  /** Method bodies: name -> normalized body */
  methodBodies: Map<string, string>
  /** Has hotReload hook registered */
  hasHotReload: boolean
}

/**
 * Detect changes between two versions of a source file.
 *
 * @param oldSource - Previous version of the source code
 * @param newSource - New version of the source code
 * @param fileName - File path (for service ID generation)
 * @param baseDir - Base directory for relative paths
 */
export function detectChanges(
  oldSource: string,
  newSource: string,
  fileName: string,
  baseDir: string = process.cwd()
): ChangeDetectionResult {
  const oldServices = extractServiceSignatures(oldSource, fileName, baseDir);
  const newServices = extractServiceSignatures(newSource, fileName, baseDir);

  const result: ChangeDetectionResult = {
    hasChanges: false,
    services: [],
    added: [],
    removed: [],
  };

  // Find added services
  for (const [id] of newServices) {
    if (!oldServices.has(id)) {
      result.added.push(id);
      result.hasChanges = true;
    }
  }

  // Find removed services
  for (const [id] of oldServices) {
    if (!newServices.has(id)) {
      result.removed.push(id);
      result.hasChanges = true;
    }
  }

  // Compare existing services
  for (const [id, newSig] of newServices) {
    const oldSig = oldServices.get(id);
    if (!oldSig) continue; // Already handled as added

    const change = compareServiceSignatures(oldSig, newSig);
    if (change) {
      result.services.push(change);
      result.hasChanges = true;
    }
  }

  return result;
}

/**
 * Extract service signatures from source code.
 */
function extractServiceSignatures(
  source: string,
  fileName: string,
  baseDir: string
): Map<string, ServiceSignature> {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const services = new Map<string, ServiceSignature>();
  const relativePath = getRelativePath(fileName, baseDir);

  const visitor = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.text;

      // Check if this class extends defineService
      const extendsDefineService = node.heritageClauses?.some((clause) =>
        clause.types.some((type) => {
          if (ts.isCallExpression(type.expression)) {
            const expr = type.expression.expression;
            return ts.isIdentifier(expr) && expr.text === 'defineService';
          }
          return false;
        })
      );

      if (extendsDefineService) {
        const sig = extractSingleServiceSignature(
          node,
          className,
          relativePath
        );
        if (sig) {
          services.set(sig.id, sig);
        }
      }
    }

    ts.forEachChild(node, visitor);
  };

  ts.forEachChild(sourceFile, visitor);
  return services;
}

/**
 * Extract signature for a single service class.
 */
function extractSingleServiceSignature(
  classNode: ts.ClassDeclaration,
  className: string,
  relativePath: string
): ServiceSignature | null {
  const id = `${relativePath}#${className}`;

  // Find the defineService call in heritage clause
  const heritageClause = classNode.heritageClauses?.find((clause) =>
    clause.types.some((type) => {
      if (ts.isCallExpression(type.expression)) {
        const expr = type.expression.expression;
        return ts.isIdentifier(expr) && expr.text === 'defineService';
      }
      return false;
    })
  );

  if (!heritageClause) return null;

  const defineServiceType = heritageClause.types.find((type) => {
    if (ts.isCallExpression(type.expression)) {
      const expr = type.expression.expression;
      return ts.isIdentifier(expr) && expr.text === 'defineService';
    }
    return false;
  });

  if (!defineServiceType || !ts.isCallExpression(defineServiceType.expression)) {
    return null;
  }

  const callExpr = defineServiceType.expression;
  const configArg = callExpr.arguments[0];
  if (!configArg || !ts.isObjectLiteralExpression(configArg)) {
    return null;
  }

  // Extract inject signature
  let injectSignature = '';
  let factoryNode: ts.ArrowFunction | ts.FunctionExpression | null = null;
  let hasHotReload = false;

  for (const prop of configArg.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
      if (prop.name.text === 'inject') {
        injectSignature = normalizeNode(prop.initializer);
      } else if (prop.name.text === 'factory') {
        if (
          ts.isArrowFunction(prop.initializer) ||
          ts.isFunctionExpression(prop.initializer)
        ) {
          factoryNode = prop.initializer;
          // Check for hotReload registration
          hasHotReload = containsHotReloadRegistration(factoryNode.body);
        }
      }
    }
  }

  if (!factoryNode) {
    return null;
  }

  // Extract method signatures and bodies from factory return
  const { methods, methodBodies } = extractMethodsFromFactory(factoryNode);

  return {
    id,
    className,
    injectSignature,
    methods,
    methodBodies,
    hasHotReload,
  };
}

/**
 * Extract method signatures and bodies from factory function.
 */
function extractMethodsFromFactory(
  factory: ts.ArrowFunction | ts.FunctionExpression
): { methods: Map<string, string>; methodBodies: Map<string, string> } {
  const methods = new Map<string, string>();
  const methodBodies = new Map<string, string>();

  // Find return statement in factory
  const returnedObject = findReturnedObject(factory.body);
  if (!returnedObject) {
    return { methods, methodBodies };
  }

  for (const prop of returnedObject.properties) {
    if (ts.isMethodDeclaration(prop) && ts.isIdentifier(prop.name)) {
      const name = prop.name.text;
      methods.set(name, getMethodSignature(prop));
      methodBodies.set(name, normalizeNode(prop.body ?? prop));
    } else if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
      const name = prop.name.text;
      if (
        ts.isArrowFunction(prop.initializer) ||
        ts.isFunctionExpression(prop.initializer)
      ) {
        methods.set(name, getPropertyFunctionSignature(prop.initializer));
        methodBodies.set(name, normalizeNode(prop.initializer.body));
      }
    } else if (
      ts.isShorthandPropertyAssignment(prop) &&
      ts.isIdentifier(prop.name)
    ) {
      // Shorthand like { myFunc } - we can't compare bodies easily
      const name = prop.name.text;
      methods.set(name, 'shorthand');
      methodBodies.set(name, 'shorthand');
    }
  }

  return { methods, methodBodies };
}

/**
 * Find the returned object literal in a factory body.
 */
function findReturnedObject(
  body: ts.ConciseBody
): ts.ObjectLiteralExpression | null {
  // Direct object return: () => ({ ... })
  if (ts.isParenthesizedExpression(body)) {
    const inner = body.expression;
    if (ts.isObjectLiteralExpression(inner)) {
      return inner;
    }
  }

  if (ts.isObjectLiteralExpression(body)) {
    return body;
  }

  // Block with return statement
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      if (ts.isReturnStatement(stmt) && stmt.expression) {
        if (ts.isObjectLiteralExpression(stmt.expression)) {
          return stmt.expression;
        }
      }
    }
  }

  return null;
}

/**
 * Get signature of a method declaration (params + return type).
 */
function getMethodSignature(method: ts.MethodDeclaration): string {
  const params = method.parameters
    .map((p) => {
      const name = ts.isIdentifier(p.name) ? p.name.text : '?';
      const type = p.type ? normalizeNode(p.type) : 'any';
      return `${name}:${type}`;
    })
    .join(',');
  const returnType = method.type ? normalizeNode(method.type) : 'any';
  return `(${params})=>${returnType}`;
}

/**
 * Get signature of a function property (arrow/function expression).
 */
function getPropertyFunctionSignature(
  fn: ts.ArrowFunction | ts.FunctionExpression
): string {
  const params = fn.parameters
    .map((p) => {
      const name = ts.isIdentifier(p.name) ? p.name.text : '?';
      const type = p.type ? normalizeNode(p.type) : 'any';
      return `${name}:${type}`;
    })
    .join(',');
  const returnType = fn.type ? normalizeNode(fn.type) : 'any';
  return `(${params})=>${returnType}`;
}

/**
 * Check if a function body contains a hotReload registration.
 */
function containsHotReloadRegistration(body: ts.ConciseBody): boolean {
  let found = false;

  const visitor = (node: ts.Node): void => {
    if (found) return;

    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (
        ts.isPropertyAccessExpression(expr) &&
        expr.name.text === 'register' &&
        node.arguments.length >= 1
      ) {
        const hookArg = node.arguments[0];
        if (ts.isStringLiteral(hookArg) && hookArg.text === 'hotReload') {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visitor);
  };

  if (ts.isBlock(body)) {
    ts.forEachChild(body, visitor);
  }
  return found;
}

/**
 * Compare two service signatures and determine what changed.
 */
function compareServiceSignatures(
  oldSig: ServiceSignature,
  newSig: ServiceSignature
): ServiceChange | null {
  // Check for structural changes that require full reload
  if (oldSig.injectSignature !== newSig.injectSignature) {
    return {
      serviceId: newSig.id,
      changeType: 'structural',
      changedMethods: [],
      reason: 'inject dependencies changed',
    };
  }

  // Check if methods were added or removed
  const oldMethods = new Set(oldSig.methods.keys());
  const newMethods = new Set(newSig.methods.keys());

  for (const name of newMethods) {
    if (!oldMethods.has(name)) {
      return {
        serviceId: newSig.id,
        changeType: 'structural',
        changedMethods: [],
        reason: `method added: ${name}`,
      };
    }
  }

  for (const name of oldMethods) {
    if (!newMethods.has(name)) {
      return {
        serviceId: newSig.id,
        changeType: 'structural',
        changedMethods: [],
        reason: `method removed: ${name}`,
      };
    }
  }

  // Check if method signatures changed.
  //
  // This comparison includes TypeScript type annotations because normalizeNode
  // uses getText() which preserves the original source text. This means a
  // type-only change like (x: string) => void -> (x: number) => void IS
  // detected as a structural change and triggers a full reload. This is
  // intentionally conservative: while types are erased at runtime, a type
  // change in a parameter often accompanies a semantic change in the method
  // body or its callers. If this causes excessive full reloads in practice,
  // the signature comparison could be relaxed to strip type annotations.
  for (const [name, oldSigStr] of oldSig.methods) {
    const newSigStr = newSig.methods.get(name);
    if (oldSigStr !== newSigStr) {
      return {
        serviceId: newSig.id,
        changeType: 'structural',
        changedMethods: [],
        reason: `method signature changed: ${name}`,
      };
    }
  }

  // Check for method body changes (can use method-patch)
  const changedMethods: string[] = [];
  for (const [name, oldBody] of oldSig.methodBodies) {
    const newBody = newSig.methodBodies.get(name);
    if (oldBody !== newBody) {
      changedMethods.push(name);
    }
  }

  if (changedMethods.length > 0) {
    // If service doesn't have hotReload hook, we need full reload
    if (!newSig.hasHotReload) {
      return {
        serviceId: newSig.id,
        changeType: 'structural',
        changedMethods: [],
        reason: 'method body changed but no hotReload hook',
      };
    }

    return {
      serviceId: newSig.id,
      changeType: 'method-only',
      changedMethods,
      reason: `method bodies changed: ${changedMethods.join(', ')}`,
    };
  }

  // No changes
  return null;
}

/**
 * Normalize a node to a string for comparison.
 * Strips whitespace and formatting differences.
 */
function normalizeNode(node: ts.Node): string {
  // Get the source file from the node itself
  const sourceFile = node.getSourceFile();
  if (sourceFile) {
    // Use getText() which extracts from the original source
    try {
      return node.getText(sourceFile).replace(/\s+/g, ' ').trim();
    } catch {
      // Fall through to printer approach
    }
  }

  // Fallback: use printer for synthesized nodes
  const printer = ts.createPrinter({
    newLine: ts.NewLineKind.LineFeed,
    removeComments: true,
  });

  const dummySourceFile = ts.createSourceFile(
    'temp.ts',
    '',
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS
  );

  return printer
    .printNode(ts.EmitHint.Unspecified, node, dummySourceFile)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Get relative path for service ID.
 */
function getRelativePath(fileName: string, baseDir: string): string {
  if (fileName.startsWith(baseDir)) {
    return fileName.slice(baseDir.length).replace(/^\//, '');
  }
  return fileName;
}

/**
 * Quick check if a file might contain services.
 * Use this for early filtering in file watchers.
 */
export function mightContainServices(source: string): boolean {
  return source.includes('defineService');
}
