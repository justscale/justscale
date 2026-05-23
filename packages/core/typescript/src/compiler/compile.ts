/**
 * @justscale/core/process - Compile Utility
 *
 * Programmatic API to compile process files.
 */

import ts from 'typescript';
import { createProcessTransformer, type ProcessCompilerOptions } from './transformer.js';
import { extractAndInjectExportsTypes, createModifiedHost } from './exports-prepass.js';
import { readFileSync, writeFileSync } from 'fs';

export interface CompileResult {
  outputText: string
  declarationText?: string
  sourceMapText?: string
  diagnostics: ts.Diagnostic[]
}

/**
 * Compile a single TypeScript source string containing process definitions.
 */
export function compileProcessSource(
  source: string,
  fileName: string = 'process.ts',
  options: ProcessCompilerOptions = {}
): CompileResult {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    sourceMap: options.sourceMap ?? false,
    strict: false,
    esModuleInterop: true,
    skipLibCheck: true,
    noEmitOnError: false,
  };

  const files = new Map<string, string>();
  files.set(fileName, source);

  const host = createCompilerHost(files, compilerOptions);
  const program1 = ts.createProgram([fileName], compilerOptions, host);
  const modifiedSources = extractAndInjectExportsTypes(program1);
  let program: ts.Program;
  if (modifiedSources.size > 0) {
    const host2 = createModifiedHost(host, modifiedSources);
    program = ts.createProgram([fileName], compilerOptions, host2, program1);
  } else {
    program = program1;
  }

  const diagnostics: ts.Diagnostic[] = [];
  const processDiagnostics: ts.Diagnostic[] = [];
  let outputText = '';
  let declarationText: string | undefined;
  let sourceMapText: string | undefined;

  const sourceFile = program.getSourceFile(fileName);

  const emitResult = program.emit(
    sourceFile,
    (outFileName, text) => {
      if (outFileName.endsWith('.js')) {
        outputText = text;
      } else if (outFileName.endsWith('.d.ts')) {
        declarationText = text;
      } else if (outFileName.endsWith('.js.map')) {
        sourceMapText = text;
      }
    },
    undefined,
    false,
    {
      before: [createProcessTransformer(program, {
        ...options,
        diagnosticsCollector: processDiagnostics,
      })],
    }
  );

  diagnostics.push(...emitResult.diagnostics);
  diagnostics.push(...processDiagnostics);

  return {
    outputText,
    declarationText,
    sourceMapText,
    diagnostics: diagnostics.filter(d =>
      // Filter out "cannot find module" errors (but keep process errors)
      (d.code !== 2307 && d.code !== 2304) || d.source === 'justscale-process'
    ),
  };
}

/**
 * Compile a process file and write the output.
 */
export function compileProcessFile(
  inputPath: string,
  outputPath?: string,
  options: ProcessCompilerOptions = {}
): CompileResult {
  const source = readFileSync(inputPath, 'utf-8');
  const result = compileProcessSource(source, inputPath, options);

  if (outputPath && result.outputText) {
    writeFileSync(outputPath, result.outputText);

    if (result.declarationText) {
      writeFileSync(outputPath.replace('.js', '.d.ts'), result.declarationText);
    }

    if (result.sourceMapText) {
      writeFileSync(outputPath + '.map', result.sourceMapText);
    }
  }

  return result;
}

/**
 * Create a compiler host with virtual files.
 */
function createCompilerHost(
  files: Map<string, string>,
  options: ts.CompilerOptions
): ts.CompilerHost {
  const defaultHost = ts.createCompilerHost(options);

  return {
    ...defaultHost,
    getSourceFile: (fileName, languageVersion) => {
      const content = files.get(fileName);
      if (content !== undefined) {
        return ts.createSourceFile(fileName, content, languageVersion);
      }
      return defaultHost.getSourceFile(fileName, languageVersion);
    },
    fileExists: (fileName) => {
      return files.has(fileName) || defaultHost.fileExists(fileName);
    },
    readFile: (fileName) => {
      return files.get(fileName) ?? defaultHost.readFile(fileName);
    },
    writeFile: () => {},
  };
}

/**
 * Format diagnostics for display.
 */
export function formatDiagnostics(diagnostics: ts.Diagnostic[]): string {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => process.cwd(),
    getCanonicalFileName: (f) => f,
    getNewLine: () => '\n',
  });
}
