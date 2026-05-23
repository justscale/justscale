#!/usr/bin/env node
/**
 * ptsc - Process TypeScript Compiler
 *
 * Drop-in replacement for tsc that compiles JustScale durable processes.
 * Supports all tsc command-line options and behaviors.
 *
 * Features:
 * - Full tsc CLI compatibility (all options work identically)
 * - Process diagnostics (TSPxxxx error codes)
 * - Transforms createProcess() calls into opcode-based execution
 * - Supports project references with -b mode
 * - Watch mode support
 * - Custom justscale section in tsconfig.json
 *
 * Usage (exactly like tsc):
 *   ptsc                          # Compile using nearest tsconfig.json
 *   ptsc --noEmit                 # Type check only
 *   ptsc -p tsconfig.json         # Use specific config
 *   ptsc -b tsconfig.build.json   # Build mode with project references
 *   ptsc --watch                  # Watch mode
 *   ptsc --init                   # Initialize a new tsconfig.json
 *   ptsc --help                   # Show help
 *   ptsc --version                # Show version
 *   ptsc file.ts                  # Compile a single file
 *
 * JustScale-specific options (via tsconfig.json):
 * ```json
 * {
 *   "compilerOptions": { ... },
 *   "justscale": {
 *     "processFilePattern": "*.process.ts",
 *     "strict": true,
 *     "verbose": false
 *   }
 * }
 * ```
 */

import ts from 'typescript';
import { resolve, dirname, basename, join, relative, sep } from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';
import { analyzeHandler } from './analyzer.js';
import { filterUsingExportsDiagnostics } from './errors.js';
import { createProcessTransformer } from './transformer.js';
import { extractAndInjectExportsTypes, createModifiedHost } from './exports-prepass.js';
import { parseConfig, defaultConfig, type JustScaleConfig, type ParsedConfig } from '../config/index.js';
import '../plugins/index.js';
import { getPlugins, type FormatResolver } from '../plugins/types.js';

// Version from package.json
const VERSION = '0.1.0';

// Parse command line arguments
const args = process.argv.slice(2);

// Handle --version
if (args.includes('--version') || args.includes('-v')) {
  console.log(`ptsc Version ${VERSION}`);
  console.log(`TypeScript ${ts.version}`);
  process.exit(0);
}

// Handle --help
if (args.includes('--help') || args.includes('-h') || args.includes('-?')) {
  printHelp();
  process.exit(0);
}

// Handle --init
if (args.includes('--init')) {
  initConfig();
  process.exit(0);
}

// Normalize -b/--build to --project - same compile pipeline, just a different flag name.
// tsc treats -b specially (incremental, project references) but our pipeline handles
// all of that through the standard path with proto/process transforms.
const buildModeIndex = args.findIndex((arg) => arg === '-b' || arg === '--build');
if (buildModeIndex !== -1) {
  args[buildModeIndex] = '--project';
}

// Parse command line using TypeScript's parser
const parsedCommandLine = ts.parseCommandLine(args);

if (parsedCommandLine.errors.length > 0) {
  console.error(ts.formatDiagnosticsWithColorAndContext(parsedCommandLine.errors, formatHost()));
  process.exit(1);
}

// Find tsconfig
let configPath: string | undefined;
if (parsedCommandLine.options.project) {
  configPath = resolve(parsedCommandLine.options.project);
} else if (parsedCommandLine.fileNames.length === 0) {
  // No files specified, look for tsconfig
  configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, 'tsconfig.json');
}

// If we have a config, parse it
let parsedConfig: ParsedConfig | undefined;
let justscaleConfig: JustScaleConfig = { ...defaultConfig };

if (configPath) {
  if (!existsSync(configPath)) {
    console.error(`error TS6053: File '${configPath}' not found.`);
    process.exit(1);
  }

  parsedConfig = parseConfig(configPath, parsedCommandLine.options);

  if (parsedConfig.errors.length > 0) {
    console.error(ts.formatDiagnosticsWithColorAndContext(parsedConfig.errors, formatHost()));
    process.exit(1);
  }

  justscaleConfig = parsedConfig.justscale;
} else if (parsedCommandLine.fileNames.length > 0) {
  // Compile specific files without tsconfig
  parsedConfig = {
    compilerOptions: {
      ...parsedCommandLine.options,
      // Default options for standalone compilation
      target: parsedCommandLine.options.target ?? ts.ScriptTarget.ES2022,
      module: parsedCommandLine.options.module ?? ts.ModuleKind.NodeNext,
      moduleResolution: parsedCommandLine.options.moduleResolution ?? ts.ModuleResolutionKind.NodeNext,
    },
    fileNames: parsedCommandLine.fileNames,
    justscale: defaultConfig,
    configFilePath: '',
    errors: [],
  };
} else {
  console.error('error: Cannot find tsconfig.json');
  process.exit(1);
}

if (parsedConfig.compilerOptions.watch) {
  runWatchMode(configPath!, parsedConfig);
} else {
  const exitCode = runBuild(parsedConfig, justscaleConfig);
  process.exit(exitCode);
}

function runBuild(config: ParsedConfig, jsConfig: JustScaleConfig): number {
  const verbose = jsConfig.verbose;

  if (verbose) {
    console.log(`Compiling ${config.fileNames.length} file(s)...`);
  }

  const baseDir = config.configFilePath ? dirname(config.configFilePath) : process.cwd();
  const plugins = getPlugins();

  // Create one resolver per plugin
  const pluginResolvers: FormatResolver[] = plugins.map(plugin =>
    plugin.createResolver({
      baseDir,
      sourceMapMode: 'external',
    })
  );

  // Chain compiler hosts: each plugin wraps the previous host
  const combinedHost = plugins.reduce<ts.CompilerHost | undefined>(
    (prevHost, plugin, i) =>
      plugin.createAwareCompilerHost(config.compilerOptions, pluginResolvers[i], prevHost),
    undefined,
  ) ?? ts.createCompilerHost(config.compilerOptions);

  const program1 = ts.createProgram({
    rootNames: config.fileNames,
    options: config.compilerOptions,
    projectReferences: config.projectReferences,
    host: combinedHost,
  });

  // Two-pass: extract `using exports` types, inject __exportsType, re-create program.
  // TypeScript infers TExports correctly from the phantom property; oldProgram reuses unchanged files.
  const modifiedSources = extractAndInjectExportsTypes(program1);
  let program: ts.Program;
  if (modifiedSources.size > 0) {
    const host2 = createModifiedHost(combinedHost, modifiedSources);
    program = ts.createProgram({
      rootNames: config.fileNames,
      options: config.compilerOptions,
      projectReferences: config.projectReferences,
      host: host2,
      oldProgram: program1,
    });
    if (verbose) {
      console.log(`[ptsc] Re-parsed ${modifiedSources.size} file(s) with injected export types`);
    }
  } else {
    program = program1;
  }

  const pluginDiagnostics: ts.Diagnostic[][] = plugins.map(() => []);

  const diagnostics = filterUsingExportsDiagnostics([
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getSyntacticDiagnostics(),
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ]);

  const processDiagnostics = getProcessDiagnostics(program, jsConfig);
  const allDiagnostics = [...diagnostics, ...processDiagnostics];

  if (allDiagnostics.length > 0) {
    console.log(ts.formatDiagnosticsWithColorAndContext(allDiagnostics, formatHost()));
  }

  if (!config.compilerOptions.noEmit) {
    // Clear emitted-file maps before fresh emit
    plugins.forEach((plugin, i) => plugin.clearEmittedFiles(pluginResolvers[i]));

    const pluginTransformers = plugins.map((plugin, i) =>
      plugin.createTransformer(program, pluginResolvers[i], pluginDiagnostics[i])
    );

    const emitResult = program.emit(
      undefined, // targetSourceFile - emit all files
      undefined, // writeFile - use default
      undefined, // cancellationToken
      undefined, // emitOnlyDtsFiles
      {
        before: [
          createProcessTransformer(program, { verbose: verbose ?? false }),
          ...pluginTransformers,
        ],
      }
    );
    allDiagnostics.push(...emitResult.diagnostics);
    pluginDiagnostics.forEach(diags => allDiagnostics.push(...diags));

    const outDir = config.compilerOptions.outDir;
    const rootDir = config.compilerOptions.rootDir;

    // Helper to ensure directory exists
    const mkdirp = (p: string): void => {
      const parent = dirname(p);
      if (!existsSync(parent)) mkdirp(parent);
      if (!existsSync(p)) ts.sys.createDirectory(p);
    };

    for (let i = 0; i < plugins.length; i++) {
      const emittedFiles = plugins[i].getEmittedFiles(pluginResolvers[i]);
      for (const [filePath, content] of emittedFiles) {
        let outputPath = filePath;
        if (outDir) {
          if (rootDir) {
            const relativePath = relative(rootDir, filePath);
            outputPath = join(outDir, relativePath);
          } else {
            outputPath = join(outDir, basename(filePath));
          }
          const canonicalOutDir = resolve(outDir);
          const canonicalOutPath = resolve(outputPath);
          if (canonicalOutPath !== canonicalOutDir && !canonicalOutPath.startsWith(canonicalOutDir + sep)) {
            throw new Error(
              `Refusing to emit ${filePath}: resolved output ${canonicalOutPath} escapes outDir ${canonicalOutDir}`
            );
          }
        }

        const dir = dirname(outputPath);
        if (!existsSync(dir)) mkdirp(dir);
        ts.sys.writeFile(outputPath, content);

        if (verbose) {
          console.log(`  Emitted: ${outputPath}`);
        }
      }
    }
  } else {
    const pluginTransformers = plugins.map((plugin, i) =>
      plugin.createTransformer(program, pluginResolvers[i], pluginDiagnostics[i])
    );
    for (const sourceFile of program.getSourceFiles()) {
      if (!sourceFile.isDeclarationFile) {
        ts.transform(sourceFile, pluginTransformers);
      }
    }
    pluginDiagnostics.forEach(diags => allDiagnostics.push(...diags));
  }

  const schemaDiagnostics = pluginDiagnostics.flat();
  if (schemaDiagnostics.length > 0) {
    console.log(ts.formatDiagnosticsWithColorAndContext(schemaDiagnostics, formatHost()));
  }

  const errorCount = allDiagnostics.filter(
    (d) => d.category === ts.DiagnosticCategory.Error
  ).length;

  if (errorCount > 0) {
    console.log('');
    console.log(
      `Found ${errorCount} error${errorCount > 1 ? 's' : ''}.`
    );
  }

  return errorCount > 0 ? 1 : 0;
}

function runWatchMode(configPath: string, config: ParsedConfig): void {
  const jsConfig = config.justscale;

  const host = ts.createWatchCompilerHost(
    configPath,
    config.compilerOptions,
    ts.sys,
    ts.createEmitAndSemanticDiagnosticsBuilderProgram,
    reportDiagnostic,
    reportWatchStatus
  );

  const originalAfterProgramCreate = host.afterProgramCreate;
  host.afterProgramCreate = (builderProgram) => {
    const program1 = builderProgram.getProgram();

    const modifiedSources = extractAndInjectExportsTypes(program1);
    let program: ts.Program;
    if (modifiedSources.size > 0) {
      const host2 = createModifiedHost(
        ts.createCompilerHost(config.compilerOptions),
        modifiedSources,
      );
      program = ts.createProgram({
        rootNames: program1.getRootFileNames() as string[],
        options: program1.getCompilerOptions(),
        host: host2,
        oldProgram: program1,
      });
    } else {
      program = program1;
    }

    const processDiagnostics = getProcessDiagnostics(program, jsConfig);
    for (const diag of processDiagnostics) {
      reportDiagnostic(diag);
    }

    if (!config.compilerOptions.noEmit) {
      program.emit(
        undefined,
        undefined,
        undefined,
        undefined,
        {
          before: [createProcessTransformer(program, { verbose: jsConfig.verbose ?? false })],
        }
      );
    }

    if (originalAfterProgramCreate) {
      originalAfterProgramCreate(builderProgram);
    }
  };

  ts.createWatchProgram(host);
}

function getProcessDiagnostics(program: ts.Program, config: JustScaleConfig): ts.Diagnostic[] {
  const diagnostics: ts.Diagnostic[] = [];
  const typeChecker = program.getTypeChecker();
  const processModules = config.processModules ?? defaultConfig.processModules;

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (sourceFile.fileName.includes('node_modules')) continue;
    if (!isProcessFile(sourceFile, config, processModules)) continue;

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
  }

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

function formatHost(): ts.FormatDiagnosticsHost {
  return {
    getCanonicalFileName: (path) => path,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => ts.sys.newLine,
  };
}

function reportDiagnostic(diagnostic: ts.Diagnostic): void {
  console.log(ts.formatDiagnosticsWithColorAndContext([diagnostic], formatHost()));
}

function reportWatchStatus(diagnostic: ts.Diagnostic): void {
  console.log(ts.formatDiagnostic(diagnostic, formatHost()));
}

function printHelp(): void {
  console.log(`
ptsc - Process TypeScript Compiler
Drop-in replacement for tsc with JustScale process compilation support.

Version: ${VERSION}
TypeScript: ${ts.version}

Usage:
  ptsc [options] [file...]

Examples:
  ptsc                          Compile using nearest tsconfig.json
  ptsc hello.ts                 Compile a single file
  ptsc --noEmit                 Type check only (no output)
  ptsc -p tsconfig.json         Use specific config file
  ptsc -b tsconfig.build.json   Build mode with project references
  ptsc -w                       Watch mode
  ptsc --init                   Initialize tsconfig.json

Common Options:
  -w, --watch                   Watch input files
  -p, --project <path>          Compile the project given the path to tsconfig.json
  -b, --build                   Build one or more projects and their dependencies
  --noEmit                      Disable emitting files from compilation
  --declaration                 Generate .d.ts declaration files
  --outDir <path>               Redirect output structure to the directory
  --rootDir <path>              Specify root directory of input files
  --strict                      Enable all strict type-checking options
  --target <version>            Set ECMAScript target version
  --module <type>               Specify module code generation
  -h, --help                    Show this help message
  -v, --version                 Print version information

JustScale Options (in tsconfig.json):
  {
    "justscale": {
      "processFilePattern": "*.process.ts",  // File pattern for processes
      "strict": true,                         // Strict process checking
      "verbose": false,                       // Verbose output
      "processModules": ["@justscale/core/process"]
    }
  }

Process Diagnostics (TSPxxxx):
  TSP0001: Missing await on suspension point
  TSP0002: Variable captured across suspension point
  TSP0003: Invalid process handler signature
  TSP0004: Unsupported control flow in process

For more information, see: https://justscale.sh/docs/typescript
`);
}

function initConfig(): void {
  const configPath = resolve(process.cwd(), 'tsconfig.json');

  if (existsSync(configPath)) {
    console.error(`error: tsconfig.json already exists at ${configPath}`);
    process.exit(1);
  }

  const config = {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      outDir: './dist',
      rootDir: './src',
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      plugins: [
        { name: '@justscale/typescript/language-service' }
      ]
    },
    justscale: {
      processFilePattern: '*.process.ts',
      strict: true,
      verbose: false
    },
    include: ['src/**/*'],
    exclude: ['node_modules', 'dist']
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(`Created tsconfig.json at ${configPath}`);
}
