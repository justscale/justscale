/**
 * Compiler plugin interface for native-file-format integrations.
 *
 * Each format (protobuf, capnp, graphql) registers a plugin that wires its
 * resolver, compiler host, and transformer into the ptsc/loader/language-service
 * pipeline without being hardcoded in those entrypoints.
 *
 * The registry lives here; entrypoints import './plugins' (the barrel) to
 * trigger registration, then call getPlugins() to iterate.
 *
 * Public-release patch: swap src/plugins/index.ts for an empty barrel.
 * The dist/plugins/ folder is excluded from the published package.json#files.
 */

import type ts from 'typescript';

// ============================================================================
// ModuleInfo — common shape across all format resolvers
// ============================================================================

/**
 * Common shape returned by every format resolver.
 *
 * - sourceMap: proto + capnp provide this; graphql does not (optional).
 * - errors: all formats provide { message, severity, source }; proto/capnp call
 *   them CompileError with a slightly different shape, but all have .message and
 *   .severity so the optional-fields path works without disrupting existing code.
 */
export interface ModuleInfo {
  /** Virtual .d.ts path */
  declarationPath: string
  /** Virtual .js path */
  runtimePath: string
  /** Generated TypeScript declaration */
  declaration: string
  /** Generated JavaScript runtime */
  runtime: string
  /** Source map JSON — present for proto/capnp, absent for graphql (v1: optional) */
  sourceMap?: string
  /** Compilation errors */
  errors: Array<{ message: string; severity: string; source?: string }>
}

// ============================================================================
// Resolver abstraction
// ============================================================================

export interface FormatResolver {
  isImport(specifier: string): boolean
  resolveModule(specifier: string, containingFile: string): ModuleInfo | undefined
}

// ============================================================================
// CompilerPlugin
// ============================================================================

export interface CompilerPlugin {
  name: string
  /** File extensions handled, e.g. ['.proto'] */
  extensions: string[]

  /**
   * Create a resolver instance for this format.
   * The resolver is stateful (cache) so the plugin factory is called once per
   * compile run and the returned resolver is threaded through host + transformer.
   */
  createResolver(options: { baseDir: string; sourceMapMode?: 'external' | 'inline' }): FormatResolver

  /**
   * Wrap an existing compiler host to intercept virtual .d.ts reads for this format.
   */
  createAwareCompilerHost(
    options: ts.CompilerOptions,
    resolver: FormatResolver,
    existingHost?: ts.CompilerHost,
  ): ts.CompilerHost

  /**
   * Create a TypeScript transformer that rewrites format imports and collects diagnostics.
   */
  createTransformer(
    program: ts.Program,
    resolver: FormatResolver,
    diagnosticsCollector: ts.Diagnostic[],
  ): ts.TransformerFactory<ts.SourceFile>

  /**
   * Get files emitted by the transformer for this format (to be written to outDir).
   * Returns a Map<outputPath, content>.
   */
  getEmittedFiles(resolver: FormatResolver): Map<string, string>

  /**
   * Clear the emitted-files map before a fresh emit.
   */
  clearEmittedFiles(resolver: FormatResolver): void

  /**
   * For the language-service: return format-specific diagnostics for a single import.
   * Receives the raw info returned by resolveModule.
   */
  getDiagnosticsForImport(
    info: ModuleInfo,
    importPath: string,
    sourceFile: ts.SourceFile,
    ts: typeof import('typescript'),
  ): ts.Diagnostic[]
}

// ============================================================================
// Registry
// ============================================================================

const plugins: CompilerPlugin[] = [];

export function register(plugin: CompilerPlugin): void {
  plugins.push(plugin);
}

export function getPlugins(): readonly CompilerPlugin[] {
  return plugins;
}
