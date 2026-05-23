/**
 * @justscale/core/process - TypeScript Transformer
 *
 * Transforms createProcess() calls into compiled opcode-based processes.
 */

import ts from 'typescript';
import { analyzeHandler } from './analyzer.js';
import { generateSwitchProcess } from './switch-codegen.js';
import { computeVersionHash } from './step-hash.js';

export interface ProcessCompilerOptions {
  /** Generate source maps for debugging */
  sourceMap?: boolean
  /** Verbose logging during compilation */
  verbose?: boolean
  /** Collector for diagnostics generated during compilation */
  diagnosticsCollector?: ts.Diagnostic[]
}

/**
 * Creates a TypeScript transformer for compiling durable processes.
 *
 * Usage with tsc programmatic API:
 * ```typescript
 * const result = ts.emit(program, undefined, undefined, false, {
 *   before: [createProcessTransformer(program)]
 * })
 * ```
 *
 * Usage with ptsc (project compiler):
 * ptsc handles this automatically via the build pipeline.
 */
export function createProcessTransformer(
  program: ts.Program,
  options: ProcessCompilerOptions = {}
): ts.TransformerFactory<ts.SourceFile> {
  return (context: ts.TransformationContext) => {
    const typeChecker = program.getTypeChecker();
    const factory = context.factory;

    return (sourceFile: ts.SourceFile) => {
      if (options.verbose) {
        console.log(`[process-compiler] Visiting: ${sourceFile.fileName}`);
      }

      // Track if we need to add __createProcess / DurableArrayIterator imports
      let needsRuntimeImport = false;
      let needsIteratorImport = false;

      const visitor = (node: ts.Node): ts.Node => {
        // Look for createProcess() calls
        if (ts.isCallExpression(node)) {
          const expr = node.expression;
          if (ts.isIdentifier(expr) && expr.text === 'createProcess') {
            if (options.verbose) {
              console.log('[process-compiler] Found createProcess call');
            }
            needsRuntimeImport = true;
            const flags = { needsIteratorImport: false };
            const transformed = transformCreateProcess(
              node,
              typeChecker,
              context,
              options,
              flags
            );
            if (flags.needsIteratorImport) {
              needsIteratorImport = true;
            }
            return transformed;
          }
        }

        return ts.visitEachChild(node, visitor, context);
      };

      // First pass: transform createProcess calls
      let transformedFile = ts.visitNode(sourceFile, visitor) as ts.SourceFile;

      // Second pass: update imports if needed
      if (needsRuntimeImport) {
        transformedFile = updateImports(factory, transformedFile, needsIteratorImport);
      }

      return transformedFile;
    };
  };
}

/**
 * Update imports to add __createProcess and remove unused createProcess.
 */
function updateImports(
  factory: ts.NodeFactory,
  sourceFile: ts.SourceFile,
  needsIteratorImport: boolean
): ts.SourceFile {
  const statements: ts.Statement[] = [];
  let foundProcessImport = false;

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt)) {
      // Check if this is the @justscale/core/process import
      const moduleSpecifier = stmt.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpecifier) && moduleSpecifier.text === '@justscale/core/process') {
        foundProcessImport = true;
        const importClause = stmt.importClause;

        if (importClause && importClause.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
          // Get current import specifiers
          const existingSpecifiers = importClause.namedBindings.elements;
          const newSpecifiers: ts.ImportSpecifier[] = [];

          // Keep all specifiers except createProcess, add __createProcess
          let hasCreateProcess = false;
          for (const spec of existingSpecifiers) {
            if (spec.name.text === 'createProcess') {
              hasCreateProcess = true;
              // Skip createProcess, we'll add __createProcess instead
            } else {
              newSpecifiers.push(spec);
            }
          }

          // Add __createProcess if we had createProcess
          if (hasCreateProcess) {
            newSpecifiers.push(
              factory.createImportSpecifier(
                false,
                undefined,
                factory.createIdentifier('__createProcess')
              )
            );
          }

          // Add DurableArrayIterator if any process uses for-of loops
          if (needsIteratorImport && !newSpecifiers.some(s => s.name.text === 'DurableArrayIterator')) {
            newSpecifiers.push(
              factory.createImportSpecifier(
                false,
                undefined,
                factory.createIdentifier('DurableArrayIterator')
              )
            );
          }

          // Create new import declaration
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
    statements.push(stmt);
  }

  // If no @justscale/core/process import found, add one
  if (!foundProcessImport) {
    const specifiers = [
      factory.createImportSpecifier(
        false,
        undefined,
        factory.createIdentifier('__createProcess')
      ),
    ];
    if (needsIteratorImport) {
      specifiers.push(
        factory.createImportSpecifier(
          false,
          undefined,
          factory.createIdentifier('DurableArrayIterator')
        )
      );
    }
    statements.unshift(
      factory.createImportDeclaration(
        undefined,
        factory.createImportClause(
          false,
          undefined,
          factory.createNamedImports(specifiers)
        ),
        factory.createStringLiteral('@justscale/core/process'),
        undefined
      )
    );
  }

  return factory.updateSourceFile(sourceFile, statements);
}

/**
 * Transform a createProcess() call into compiled opcodes.
 */
function transformCreateProcess(
  node: ts.CallExpression,
  typeChecker: ts.TypeChecker,
  context: ts.TransformationContext,
  options: ProcessCompilerOptions,
  flags?: { needsIteratorImport: boolean }
): ts.Node {
  const factory = context.factory;

  // Get the config argument
  const configArg = node.arguments[0];
  if (!configArg || !ts.isObjectLiteralExpression(configArg)) {
    // Not a valid createProcess call, leave it unchanged
    return node;
  }

  // Extract config properties
  const config = extractProcessConfig(configArg);
  if (!config) {
    if (options.verbose) {
      console.log('[process-compiler] Failed to extract config');
    }
    return node;
  }

  if (options.verbose) {
    console.log(`[process-compiler] Compiling process: ${config.path}`);
  }

  // Analyze the handler to produce opcodes
  const analysis = analyzeHandler(config.handler, typeChecker);

  // Check if the analysis produced any ITER opcodes
  if (flags && analysis.opcodes.some(o => o.op === 'ITER_START')) {
    flags.needsIteratorImport = true;
  }

  // Collect any diagnostics from analysis
  if (options.diagnosticsCollector && analysis.diagnostics.length > 0) {
    options.diagnosticsCollector.push(...analysis.diagnostics);
  }

  // Generate version hash from opcode structure
  const version = computeVersionHash(analysis);

  // Generate the compiled switch-based process
  // Pass original node for source map positioning
  return generateSwitchProcess(factory, {
    id: config.id,
    path: config.path,
    version,
    injectNode: config.injectNode,
    typesNode: config.typesNode,
    handler: config.handler,
    analysis,
    originalNode: node,
    typeChecker,
  });
}

interface ProcessConfig {
  id: string
  path: string
  injectNode: ts.ObjectLiteralExpression | undefined
  typesNode: ts.Expression | undefined
  handler: ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration
}

/**
 * Extract configuration from the createProcess() argument.
 */
function extractProcessConfig(
  configObj: ts.ObjectLiteralExpression,
): ProcessConfig | null {
  let path: string | undefined;
  let injectNode: ts.ObjectLiteralExpression | undefined;
  let typesNode: ts.Expression | undefined;
  let handler: ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration | undefined;

  for (const prop of configObj.properties) {
    // Handle method declarations: async handler() {}
    if (ts.isMethodDeclaration(prop)) {
      if (ts.isIdentifier(prop.name) && prop.name.text === 'handler') {
        handler = prop;
      }
      continue;
    }

    if (!ts.isPropertyAssignment(prop)) continue;
    if (!ts.isIdentifier(prop.name)) continue;

    const name = prop.name.text;

    switch (name) {
      case 'path':
        if (ts.isStringLiteral(prop.initializer)) {
          path = prop.initializer.text;
        }
        break;

      case 'inject':
        if (ts.isObjectLiteralExpression(prop.initializer)) {
          injectNode = prop.initializer;
        }
        break;

      case 'types':
        typesNode = prop.initializer;
        break;

      case 'handler':
        if (
          ts.isFunctionExpression(prop.initializer) ||
          ts.isArrowFunction(prop.initializer)
        ) {
          handler = prop.initializer;
        }
        break;
    }
  }

  if (!path || !handler) {
    return null;
  }

  const id = path.replace(/[/:]/g, '_').replace(/^_/, '');

  return { id, path, injectNode, typesNode, handler };
}
