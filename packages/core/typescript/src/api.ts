/**
 * Programmatic API for the JustScale TypeScript compiler.
 *
 * @example
 * ```typescript
 * import { transpile, transpileProject } from '@justscale/typescript/api'
 * const result = transpile(source, 'example.process.ts')
 * ```
 */

import ts from 'typescript';
import { resolve } from 'node:path';
import { analyzeHandler } from './compiler/analyzer.js';
import { filterUsingExportsDiagnostics } from './compiler/errors.js';
import { createProcessTransformer } from './compiler/transformer.js';
import { extractAndInjectExportsTypes, createModifiedHost } from './compiler/exports-prepass.js';
import { parseConfig, defaultConfig, type JustScaleConfig } from './config/index.js';

/**
 * Result of transpiling a single file
 */
export interface TranspileResult {
  /** Transpiled JavaScript code */
  code: string
  /** Source map (if enabled) */
  sourceMap?: string
  /** Declaration file content (if enabled) */
  declaration?: string
  /** Diagnostics from compilation */
  diagnostics: ts.Diagnostic[]
  /** Whether compilation was successful (no errors) */
  success: boolean
}

/**
 * Result of transpiling a project
 */
export interface TranspileProjectResult {
  /** Results for each file */
  files: Map<string, TranspileResult>
  /** Project-wide diagnostics */
  diagnostics: ts.Diagnostic[]
  /** Whether compilation was successful */
  success: boolean
}

/**
 * Options for transpilation
 */
export interface TranspileOptions {
  /** TypeScript compiler options */
  compilerOptions?: ts.CompilerOptions
  /** JustScale-specific options */
  justscale?: JustScaleConfig
  /** Custom transformers to apply before JustScale transformer */
  transformers?: ts.CustomTransformers
  /** Generate source maps */
  sourceMap?: boolean
  /** Generate declaration files */
  declaration?: boolean
}

/**
 * Transpile a single TypeScript source string
 *
 * @param source - TypeScript source code
 * @param fileName - Virtual file name (affects process detection)
 * @param options - Compilation options
 * @returns Transpilation result
 *
 * @example
 * ```typescript
 * const result = transpile(`
 *   import { createProcess, delay } from '@justscale/core/process'
 *
 *   export const myProcess = createProcess({
 *     name: 'my-process',
 *     async handler() {
 *       await delay(1000)
 *       return 'done'
 *     }
 *   })
 * `, 'example.process.ts')
 *
 * console.log(result.code)
 * ```
 */
export function transpile(
  source: string,
  fileName = 'input.ts',
  options: TranspileOptions = {}
): TranspileResult {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    // Include ES2022 lib by default for Promise, async/await, etc.
    lib: ['lib.es2022.d.ts'],
    ...options.compilerOptions,
    sourceMap: options.sourceMap ?? options.compilerOptions?.sourceMap,
    declaration: options.declaration ?? options.compilerOptions?.declaration,
  };

  const jsConfig = options.justscale ?? defaultConfig;

  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    compilerOptions.target ?? ts.ScriptTarget.ES2022,
    true
  );

  const defaultHost = ts.createCompilerHost(compilerOptions);
  const host: ts.CompilerHost = {
    ...defaultHost,
    getSourceFile: (name, languageVersion) => {
      if (name === fileName) return sourceFile;
      // Use the default host to load lib files and other dependencies
      return defaultHost.getSourceFile(name, languageVersion);
    },
    writeFile: () => {}, // We'll capture output differently
    fileExists: (name) => name === fileName || defaultHost.fileExists(name),
    readFile: (name) => {
      if (name === fileName) return source;
      return defaultHost.readFile(name);
    },
  };

  const program1 = ts.createProgram([fileName], compilerOptions, host);
  const modifiedSources = extractAndInjectExportsTypes(program1);
  let program: ts.Program;
  if (modifiedSources.size > 0) {
    const modifiedText = modifiedSources.get(fileName);
    if (modifiedText) {
      const host2: ts.CompilerHost = {
        ...host,
        getSourceFile: (name, languageVersionOrOptions, onError) => {
          if (name === fileName) {
            return ts.createSourceFile(name, modifiedText, languageVersionOrOptions as ts.ScriptTarget, true);
          }
          return host.getSourceFile!(name, languageVersionOrOptions, onError);
        },
        readFile: (name) => {
          if (name === fileName) return modifiedText;
          return host.readFile!(name);
        },
      };
      program = ts.createProgram([fileName], compilerOptions, host2, program1);
    } else {
      program = program1;
    }
  } else {
    program = program1;
  }

  const finalSourceFile = program.getSourceFile(fileName)!;

  const diagnostics: ts.Diagnostic[] = filterUsingExportsDiagnostics([
    ...program.getSyntacticDiagnostics(finalSourceFile),
    ...program.getSemanticDiagnostics(finalSourceFile),
  ]);

  const processDiagnostics = getProcessDiagnosticsForFile(program, finalSourceFile, jsConfig);
  diagnostics.push(...processDiagnostics);

  let code = '';
  let sourceMap: string | undefined;
  let declaration: string | undefined;

  program.emit(
    finalSourceFile,
    (name, text) => {
      if (name.endsWith('.map')) {
        sourceMap = text;
      } else if (name.endsWith('.d.ts')) {
        declaration = text;
      } else {
        code = text;
      }
    },
    undefined,
    undefined,
    {
      before: [
        ...(options.transformers?.before ?? []),
        createProcessTransformer(program, { verbose: jsConfig.verbose ?? false }),
      ],
      after: options.transformers?.after,
      afterDeclarations: options.transformers?.afterDeclarations,
    }
  );

  const hasErrors = diagnostics.some((d) => d.category === ts.DiagnosticCategory.Error);

  return {
    code,
    sourceMap,
    declaration,
    diagnostics,
    success: !hasErrors,
  };
}

/**
 * Transpile a TypeScript project from a tsconfig.json
 *
 * @param configPath - Path to tsconfig.json
 * @param options - Additional options to override config
 * @returns Results for all files in the project
 *
 * @example
 * ```typescript
 * const result = transpileProject('./tsconfig.json')
 *
 * if (result.success) {
 *   for (const [file, output] of result.files) {
 *     console.log(`${file}: ${output.code.length} bytes`)
 *   }
 * } else {
 *   console.error('Compilation failed:', result.diagnostics)
 * }
 * ```
 */
export function transpileProject(
  configPath: string,
  options: TranspileOptions = {}
): TranspileProjectResult {
  const resolvedPath = resolve(configPath);
  const config = parseConfig(resolvedPath, options.compilerOptions);

  const mergedOptions: ts.CompilerOptions = {
    ...config.compilerOptions,
    ...options.compilerOptions,
  };

  const jsConfig: JustScaleConfig = {
    ...config.justscale,
    ...options.justscale,
  };

  const program1 = ts.createProgram({
    rootNames: config.fileNames,
    options: mergedOptions,
    projectReferences: config.projectReferences,
  });

  const modifiedSources = extractAndInjectExportsTypes(program1);
  let program: ts.Program;
  if (modifiedSources.size > 0) {
    const defaultHost = ts.createCompilerHost(mergedOptions);
    const host2 = createModifiedHost(defaultHost, modifiedSources);
    program = ts.createProgram({
      rootNames: config.fileNames,
      options: mergedOptions,
      projectReferences: config.projectReferences,
      host: host2,
      oldProgram: program1,
    });
  } else {
    program = program1;
  }

  const allDiagnostics: ts.Diagnostic[] = filterUsingExportsDiagnostics([
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ]);

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (sourceFile.fileName.includes('node_modules')) continue;

    const processDiagnostics = getProcessDiagnosticsForFile(program, sourceFile, jsConfig);
    allDiagnostics.push(...processDiagnostics);
  }

  const files = new Map<string, TranspileResult>();

  const emitResult = program.emit(
    undefined,
    (fileName, text, writeByteOrderMark, onError, sourceFiles) => {
      if (!sourceFiles || sourceFiles.length === 0) return;

      const sourceFile = sourceFiles[0];
      const originalName = sourceFile.fileName;

      const existing = files.get(originalName) ?? {
        code: '',
        diagnostics: [],
        success: true,
      };

      if (fileName.endsWith('.map')) {
        existing.sourceMap = text;
      } else if (fileName.endsWith('.d.ts')) {
        existing.declaration = text;
      } else {
        existing.code = text;
      }

      files.set(originalName, existing);
    },
    undefined,
    undefined,
    {
      before: [
        ...(options.transformers?.before ?? []),
        createProcessTransformer(program, { verbose: jsConfig.verbose ?? false }),
      ],
      after: options.transformers?.after,
      afterDeclarations: options.transformers?.afterDeclarations,
    }
  );

  allDiagnostics.push(...emitResult.diagnostics);

  const hasErrors = allDiagnostics.some((d) => d.category === ts.DiagnosticCategory.Error);

  return {
    files,
    diagnostics: allDiagnostics,
    success: !hasErrors,
  };
}

/**
 * Create a TypeScript Program with JustScale extensions
 *
 * Use this for advanced use cases where you need full control over
 * the compilation process.
 *
 * @param fileNames - Files to include in the program
 * @param options - Compiler options
 * @returns A TypeScript Program
 *
 * @example
 * ```typescript
 * const program = createProgram(['./src/index.ts'], {
 *   target: ts.ScriptTarget.ES2022,
 *   module: ts.ModuleKind.NodeNext,
 * })
 *
 * // Get process diagnostics
 * const diagnostics = getProcessDiagnostics(program)
 *
 * // Custom emit with transformer
 * program.emit(undefined, undefined, undefined, undefined, {
 *   before: [createProcessTransformer(program)]
 * })
 * ```
 */
export function createProgram(
  fileNames: string[],
  options?: ts.CompilerOptions
): ts.Program {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    ...options,
  };

  return ts.createProgram({
    rootNames: fileNames,
    options: compilerOptions,
  });
}

/**
 * Get JustScale process diagnostics for a program
 *
 * @param program - TypeScript program
 * @param config - JustScale configuration
 * @returns Array of diagnostics
 */
export function getProcessDiagnostics(
  program: ts.Program,
  config: JustScaleConfig = defaultConfig
): ts.Diagnostic[] {
  const diagnostics: ts.Diagnostic[] = [];

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (sourceFile.fileName.includes('node_modules')) continue;

    diagnostics.push(...getProcessDiagnosticsForFile(program, sourceFile, config));
  }

  return diagnostics;
}

/**
 * Get process diagnostics for a single file
 */
function getProcessDiagnosticsForFile(
  program: ts.Program,
  sourceFile: ts.SourceFile,
  config: JustScaleConfig
): ts.Diagnostic[] {
  const diagnostics: ts.Diagnostic[] = [];
  const typeChecker = program.getTypeChecker();
  const processModules = config.processModules ?? defaultConfig.processModules;

  // Check if this is a process file
  if (!isProcessFile(sourceFile, config, processModules)) {
    return diagnostics;
  }

  // Find createProcess calls and analyze
  ts.forEachChild(sourceFile, function visit(node) {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isIdentifier(expr) && expr.text === 'createProcess') {
        const configArg = node.arguments[0];
        if (configArg && ts.isObjectLiteralExpression(configArg)) {
          const handler = findHandler(configArg);
          if (handler) {
            const analysis = analyzeHandler(handler, typeChecker);
            diagnostics.push(...analysis.diagnostics);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  });

  return diagnostics;
}

function isProcessFile(
  sourceFile: ts.SourceFile,
  config: JustScaleConfig,
  processModules: string[]
): boolean {
  const pattern = config.processFilePattern;
  if (pattern && sourceFile.fileName.includes(pattern.replace('*', ''))) {
    return true;
  }

  if (sourceFile.fileName.includes('.process.')) return true;

  for (const stmt of sourceFile.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const moduleSpecifier = stmt.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpecifier)) {
        if (processModules.includes(moduleSpecifier.text)) {
          return true;
        }
      }
    }
  }
  return false;
}

function findHandler(
  configObj: ts.ObjectLiteralExpression
): ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration | undefined {
  for (const prop of configObj.properties) {
    if (ts.isMethodDeclaration(prop)) {
      if (ts.isIdentifier(prop.name) && prop.name.text === 'handler') {
        return prop;
      }
    } else if (ts.isPropertyAssignment(prop)) {
      if (ts.isIdentifier(prop.name) && prop.name.text === 'handler') {
        if (ts.isFunctionExpression(prop.initializer) || ts.isArrowFunction(prop.initializer)) {
          return prop.initializer;
        }
      }
    }
  }
  return undefined;
}

/**
 * Format diagnostics for console output
 */
export function formatDiagnostics(diagnostics: ts.Diagnostic[]): string {
  const host: ts.FormatDiagnosticsHost = {
    getCanonicalFileName: (path) => path,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  };

  return ts.formatDiagnosticsWithColorAndContext(diagnostics, host);
}

// Re-export the transformer for custom usage
export { createProcessTransformer } from './compiler/transformer.js';
export { analyzeHandler } from './compiler/analyzer.js';
export { formatErrorCode, ProcessErrorCode } from './compiler/errors.js';
export { parseConfig, defaultConfig } from './config/index.js';
export type { JustScaleConfig, ParsedConfig } from './config/index.js';
