/**
 * Process TypeScript Compiler
 *
 * Compiles process files (*.process.ts) using TypeScript's compiler API
 * and the process transformer.
 */

import ts from 'typescript';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createProcessTransformer } from '../compiler/transformer.js';

export interface CompilerOptions {
  /** Root directory for finding process files */
  rootDir: string
  /** Output directory for compiled files (default: .justscale/process-cache) */
  cacheDir?: string
  /** Whether to emit source maps */
  sourceMap?: boolean
  /** Verbose logging */
  verbose?: boolean
}

export interface CompileResult {
  /** Compiled JavaScript code (includes inline source map when sourceMap is enabled) */
  code: string
  /**
   * Raw source map JSON when sourceMap is enabled, otherwise undefined.
   * Tooling that wants to attach its own map (esbuild, coverage reporters,
   * stack remappers) should consume this rather than regex-extracting the
   * base64 data URL from `code`.
   */
  map?: string
  /** Whether this was a cache hit */
  cached: boolean
}

/**
 * Process TypeScript compiler.
 */
export class PtsCompiler {
  private readonly rootDir: string;
  private readonly cacheDir: string;
  private readonly sourceMap: boolean;
  private readonly verbose: boolean;

  constructor(options: CompilerOptions) {
    this.rootDir = resolve(options.rootDir);
    this.cacheDir = options.cacheDir ?? join(this.rootDir, '.justscale', 'process-cache');
    this.sourceMap = options.sourceMap ?? false;
    this.verbose = options.verbose ?? false;

    // Ensure output directory exists
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * Compile a process file.
   */
  compile(filePath: string): CompileResult {
    const absolutePath = resolve(filePath);
    const relativePath = relative(this.rootDir, absolutePath);

    // Read source
    const source = readFileSync(absolutePath, 'utf-8');

    if (this.verbose) {
      console.log(`[pts] Compiling: ${relativePath}`);
    }

    // Compile with transformer
    const { code, map } = this.compileFile(absolutePath, source);

    // Write compiled file for debugging
    const outPath = join(this.cacheDir, relativePath.replace(/\.(process\.)?ts$/, '.js'));
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, code);

    return { code, map, cached: false };
  }

  private compileFile(filePath: string, source: string): { code: string; map?: string } {
    // Compiler options - relaxed to handle missing type info. We emit the
    // source map non-inline into a separate buffer so callers that want it
    // as a distinct handle (esbuild plugin, coverage tooling) can have it
    // without re-parsing a data URL. Runtime callers (the Node loader)
    // still get the base64-inlined form appended to `code` below.
    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: false, // Relaxed - we don't need full type checking
      esModuleInterop: true,
      skipLibCheck: true,
      declaration: false,
      sourceMap: this.sourceMap,
      inlineSources: this.sourceMap, // Embed original source in the map
      noEmitOnError: false, // Emit even if there are errors
      isolatedModules: true, // Each file is a module
    };

    // Create a virtual file system for compilation
    const files = new Map<string, string>();
    files.set(filePath, source);

    // Create compiler host
    const host = this.createCompilerHost(files, compilerOptions);

    // Create program
    const program = ts.createProgram([filePath], compilerOptions, host);

    // Get the transformer
    const transformer = createProcessTransformer(program, {
      sourceMap: this.sourceMap,
      verbose: this.verbose,
    });

    // Get source file
    const sourceFile = program.getSourceFile(filePath);

    // Emit with transformer
    let outputCode = '';
    let outputMap: string | undefined;

    program.emit(
      sourceFile,
      (fileName, text) => {
        if (fileName.endsWith('.map')) {
          outputMap = text;
        } else {
          outputCode = text;
        }
      },
      undefined,
      false,
      { before: [transformer] }
    );

    // The existing Node loader path expects the source map to be embedded
    // in the emitted code (no companion .map file is written to disk), so
    // re-inline as a base64 data URL. Strip any TypeScript-emitted
    // sourceMappingURL comment first - with `sourceMap: true` tsc appends
    // a `file.js.map` reference that doesn't exist on disk at runtime.
    if (this.sourceMap && outputMap) {
      // Anchor to start-of-line so we don't mangle source that legitimately
      // contains the literal string "//# sourceMappingURL=" (e.g. tests that
      // assert on this marker). tsc emits the comment on its own line.
      outputCode = outputCode.replace(/(^|\n)\/\/# sourceMappingURL=.*$/m, '');
      const base64 = Buffer.from(outputMap, 'utf-8').toString('base64');
      outputCode += `\n//# sourceMappingURL=data:application/json;base64,${base64}\n`;
    }

    return { code: outputCode, map: outputMap };
  }

  private createCompilerHost(
    files: Map<string, string>,
    options: ts.CompilerOptions
  ): ts.CompilerHost {
    const defaultHost = ts.createCompilerHost(options);

    return {
      ...defaultHost,

      getSourceFile: (fileName, languageVersion, onError) => {
        // Check our virtual files first
        const content = files.get(fileName);
        if (content !== undefined) {
          return ts.createSourceFile(fileName, content, languageVersion, true, ts.ScriptKind.TS);
        }

        // Fall back to default host
        return defaultHost.getSourceFile(fileName, languageVersion, onError);
      },

      fileExists: (fileName) => {
        if (files.has(fileName)) return true;
        return defaultHost.fileExists(fileName);
      },

      readFile: (fileName) => {
        const content = files.get(fileName);
        if (content !== undefined) return content;
        return defaultHost.readFile(fileName);
      },

      // Override to prevent errors about missing files
      getDefaultLibFileName: (options) => {
        return defaultHost.getDefaultLibFileName(options);
      },

      writeFile: () => {
        // No-op - we capture output in emit callback
      },

      getCurrentDirectory: () => this.rootDir,

      getCanonicalFileName: (fileName) => fileName,

      useCaseSensitiveFileNames: () => true,

      getNewLine: () => '\n',
    };
  }
}

/**
 * Create a PTS compiler instance.
 */
export function createCompiler(options: CompilerOptions): PtsCompiler {
  return new PtsCompiler(options);
}
