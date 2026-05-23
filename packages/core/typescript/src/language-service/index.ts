/**
 * TypeScript Language Service Plugin for @justscale/typescript
 *
 * Provides enhanced IDE support:
 * - TSPxxxx diagnostics for JustScale processes
 * - Proto and Cap'n Proto schema integration (.proto, .capnp files)
 * - Human-readable DI error messages
 *
 * Based on TypeScriptToLua's plugin pattern.
 *
 * Usage in tsconfig.json:
 * {
 *   "compilerOptions": {
 *     "plugins": [{ "name": "@justscale/typescript/language-service" }]
 *   }
 * }
 */

import type ts from 'typescript';
import '../plugins/index.js';
import { getPlugins, type FormatResolver } from '../plugins/types.js';
import { processDIDiagnostics } from '../di-errors/index.js';
import { filterUsingExportsDiagnostics } from '../compiler/errors.js';
import { extractAndInjectExportsTypes } from '../compiler/exports-prepass.js';
import { findConfig, defaultConfig } from '../config/index.js';
import type { JustScaleConfig } from '../config/index.js';
import { type QuickFixDefinition, discoverQuickFixes, watchLockfile } from './quick-fix-discovery.js';
import { getProcessCodeFixes } from './process-quick-fixes.js';

// Types for the Language Service Plugin API
type TS = typeof ts;
type LanguageService = ts.LanguageService;
type Program = ts.Program;
type SourceFile = ts.SourceFile;
type Diagnostic = ts.Diagnostic;
type Node = ts.Node;
type ObjectLiteralExpression = ts.ObjectLiteralExpression;
type FunctionExpression = ts.FunctionExpression;
type ArrowFunction = ts.ArrowFunction;
type MethodDeclaration = ts.MethodDeclaration;

interface ServerHost {
  readFile(path: string, encoding?: string): string | undefined
}

interface Project {
  log(message: string): void
  getProjectName(): string
}

const pluginMarker = Symbol('processPluginMarker');

interface PluginProjectInfo {
  getCurrentDirectory(): string
}

class ProcessPlugin {
  private pluginResolvers: FormatResolver[];
  private config: JustScaleConfig;
  private processModules: string[];

  /** Modified source texts with __exportsType injected */
  private modifiedSnapshots = new Map<string, string>();
  /** Version at which each file was injected - used for cache invalidation */
  private injectedAtVersion = new Map<string, string>();
  /** Whether the initial exports extraction has been done */
  private exportsExtracted = false;

  /** Quick fixes discovered from installed packages */
  private quickFixes: QuickFixDefinition[] = [];
  private quickFixesLoaded = false;
  private stopWatchingLockfile?: () => void;

  private origGetSnapshot: (fileName: string) => ts.IScriptSnapshot | undefined;
  private origGetVersion: (fileName: string) => string;

  constructor(
    private readonly ts: TS,
    private readonly languageService: LanguageService,
    private readonly host: LanguageServiceHost,
    private readonly project: Project & Partial<PluginProjectInfo>,
    private readonly serverHost: ServerHost
  ) {
    // Initialize schema resolvers via plugin registry
    const baseDir = project.getCurrentDirectory?.() || process.cwd();
    this.pluginResolvers = getPlugins().map(plugin =>
      plugin.createResolver({ baseDir, sourceMapMode: 'external' })
    );

    // Load JustScale config from tsconfig.json
    const parsed = findConfig(baseDir);
    this.config = parsed?.justscale ?? { ...defaultConfig };
    this.processModules = this.config.processModules ?? defaultConfig.processModules;

    // Discover quick fixes from installed packages (async, non-blocking)
    this.loadQuickFixes(baseDir);

    // Override host to serve modified snapshots with __exportsType injected
    this.origGetSnapshot = host.getScriptSnapshot.bind(host);
    this.origGetVersion = host.getScriptVersion.bind(host);

    host.getScriptSnapshot = (fileName: string) => {
      const version = this.origGetVersion(fileName);
      const injectedAt = this.injectedAtVersion.get(fileName);

      // Cache invalidation: if file changed since injection, clear stale cache
      if (injectedAt && injectedAt !== version) {
        this.modifiedSnapshots.delete(fileName);
        this.injectedAtVersion.delete(fileName);
        this.exportsExtracted = false; // re-extract on next diagnostics call
      }

      const modified = this.modifiedSnapshots.get(fileName);
      if (modified) {
        return this.ts.ScriptSnapshot.fromString(modified);
      }
      return this.origGetSnapshot(fileName);
    };

    host.getScriptVersion = (fileName: string) => {
      const version = this.origGetVersion(fileName);
      if (this.modifiedSnapshots.has(fileName)) {
        return version + '-exports';
      }
      return version;
    };
  }

  private log(message: string) {
    this.project.log(`[justscale-plugin] ${this.project.getProjectName()}: ${message}`);
  }

  private _analyzer?: typeof import('../compiler/analyzer.js');
  private _analyzerLoadAttempted = false;
  private get analyzer() {
    if (!this._analyzer && !this._analyzerLoadAttempted) {
      this._analyzerLoadAttempted = true;
      // This require may fail during initial package build (before dist exists).
      // That's expected - analyzer becomes available after first build.
      try {
        this._analyzer = require('../compiler/analyzer.js');
      } catch {
        // Not built yet - process diagnostics won't be available until rebuild
      }
    }
    return this._analyzer;
  }

  public wrap(): LanguageService {
    this.log('Wrapping language service');

    const intercept: Partial<LanguageService> = Object.create(null)
    ;(intercept as Record<symbol, ProcessPlugin>)[pluginMarker] = this;
    intercept.getSemanticDiagnostics = this.getSemanticDiagnostics.bind(this);
    intercept.getCodeFixesAtPosition = this.getCodeFixesAtPosition.bind(this);

    return new Proxy(this.languageService, {
      get: (target, property) =>
        (intercept as unknown as Record<string | symbol, unknown>)[property] ??
        (target as unknown as Record<string | symbol, unknown>)[property],
    });
  }

  private loadQuickFixes(baseDir: string) {
    discoverQuickFixes(baseDir, (msg) => this.log(msg))
      .then((fixes) => {
        this.quickFixes = fixes;
        this.quickFixesLoaded = true;
        if (fixes.length > 0) {
          this.log(`Discovered ${fixes.length} quick fix(es) from packages`);
        }
      })
      .catch((err) => {
        this.log(`Failed to discover quick fixes: ${err}`);
        this.quickFixesLoaded = true;
      });

    // Watch lockfile for dependency changes
    this.stopWatchingLockfile = watchLockfile(baseDir, () => {
      this.quickFixesLoaded = false;
      discoverQuickFixes(baseDir, (msg) => this.log(msg))
        .then((fixes) => {
          this.quickFixes = fixes;
          this.quickFixesLoaded = true;
          this.log(`Re-discovered ${fixes.length} quick fix(es) after lockfile change`);
        })
        .catch(() => { this.quickFixesLoaded = true; });
    }, (msg) => this.log(msg));
  }

  private getCodeFixesAtPosition(
    fileName: string,
    start: number,
    end: number,
    errorCodes: readonly number[],
    formatOptions: ts.FormatCodeSettings,
    preferences: ts.UserPreferences,
  ): readonly ts.CodeFixAction[] {
    // Get standard TS code fixes first
    const standardFixes = this.languageService.getCodeFixesAtPosition(
      fileName, start, end, errorCodes, formatOptions, preferences,
    );

    const program = this.languageService.getProgram();
    if (!program) return standardFixes;

    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) return standardFixes;

    // Process-specific quick fixes (built-in, for TSPxxxx diagnostics)
    const diagnostics = this.languageService.getSemanticDiagnostics(fileName);
    const processFixes = getProcessCodeFixes(sourceFile, diagnostics, errorCodes, this.ts);

    // Package-contributed quick fixes
    const packageFixes: ts.CodeFixAction[] = [];

    if (this.quickFixes.length > 0) {
      const checker = program.getTypeChecker();
      const node = findNodeAtPosition(sourceFile, start, this.ts);

      if (node) {
        for (const qf of this.quickFixes) {
          try {
            if (qf.when(node, checker, this.ts)) {
              const changes = qf.fix(node, checker, this.ts);
              packageFixes.push({
                fixName: qf.id,
                description: qf.label,
                changes,
              });
            }
          } catch (err) {
            this.log(`Quick fix '${qf.id}' error: ${err}`);
          }
        }
      }
    }

    return [...standardFixes, ...processFixes, ...packageFixes];
  }

  private getSemanticDiagnostics(fileName: string): Diagnostic[] {
    // Two-pass exports type injection:
    // On first call, extract `using exports` types from the type checker and
    // inject __exportsType into source snapshots. TypeScript re-checks with
    // correct TExports on the next call.
    if (!this.exportsExtracted) {
      this.exportsExtracted = true;

      try {
        const program = this.languageService.getProgram();
        if (program) {
          const modified = extractAndInjectExportsTypes(program);
          if (modified.size > 0) {
            for (const [file, text] of modified) {
              this.modifiedSnapshots.set(file, text);
              this.injectedAtVersion.set(file, this.origGetVersion(file));
            }
            this.log(`Injected export types for ${modified.size} file(s)`);
          }
        }
      } catch (e) {
        this.log(`Error extracting exports types: ${e}`);
      }
    }

    const diagnostics = this.languageService.getSemanticDiagnostics(fileName);
    const program = this.languageService.getProgram();
    if (!program) return diagnostics;

    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile || sourceFile.isDeclarationFile) return diagnostics;

    // Process DI errors for better readability (applies to all files)
    const processed = processDIDiagnostics(diagnostics);

    const additionalDiagnostics: Diagnostic[] = [];

    // Check for process file diagnostics
    if (this.isProcessFile(sourceFile)) {
      try {
        const processDiagnostics = this.getProcessDiagnostics(program, sourceFile);
        additionalDiagnostics.push(...processDiagnostics);
      } catch (e) {
        this.log(`Error getting process diagnostics: ${e}`);
      }
    }

    // Check for schema (proto/capnp) import diagnostics
    try {
      const schemaDiagnostics = this.getSchemaDiagnostics(sourceFile);
      additionalDiagnostics.push(...schemaDiagnostics);
    } catch (e) {
      this.log(`Error getting schema diagnostics: ${e}`);
    }

    // Filter TS2850 for `using exports` declarations
    const filtered = filterUsingExportsDiagnostics(processed);

    return [...filtered, ...additionalDiagnostics];
  }

  private getSchemaDiagnostics(sourceFile: SourceFile): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const plugins = getPlugins();

    // Visit all imports to find format-specific imports (proto, capnp, graphql, ...)
    this.ts.forEachChild(sourceFile, (node) => {
      if (this.ts.isImportDeclaration(node)) {
        const moduleSpecifier = node.moduleSpecifier;
        if (this.ts.isStringLiteral(moduleSpecifier)) {
          const importPath = moduleSpecifier.text;

          for (let i = 0; i < plugins.length; i++) {
            const plugin = plugins[i];
            const resolver = this.pluginResolvers[i];
            if (resolver.isImport(importPath)) {
              const info = resolver.resolveModule(importPath, sourceFile.fileName);
              if (info) {
                const pluginDiags = plugin.getDiagnosticsForImport(
                  info,
                  importPath,
                  sourceFile,
                  this.ts,
                );
                // Override start/length to point at the import specifier
                for (const diag of pluginDiags) {
                  diagnostics.push({
                    ...diag,
                    start: moduleSpecifier.getStart() + 1,
                    length: importPath.length,
                  });
                }
              }
            }
          }
        }
      }
    });

    return diagnostics;
  }

  private isProcessFile(sourceFile: SourceFile): boolean {
    // Check filename pattern from config
    const pattern = this.config.processFilePattern ?? defaultConfig.processFilePattern;
    if (pattern) {
      const stripped = pattern.replace(/\*/g, '');
      if (sourceFile.fileName.includes(stripped)) return true;
    }

    // Check imports against configured process modules
    for (const stmt of sourceFile.statements) {
      if (this.ts.isImportDeclaration(stmt)) {
        const moduleSpecifier = stmt.moduleSpecifier;
        if (this.ts.isStringLiteral(moduleSpecifier)) {
          if (this.processModules.includes(moduleSpecifier.text)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  private getProcessDiagnostics(program: Program, sourceFile: SourceFile): Diagnostic[] {
    if (!this.analyzer) return [];

    const diagnostics: Diagnostic[] = [];
    const typeChecker = program.getTypeChecker();

    const visit = (node: Node): void => {
      if (this.ts.isCallExpression(node)) {
        const expr = node.expression;
        if (this.ts.isIdentifier(expr) && expr.text === 'createProcess') {
          const configArg = node.arguments[0];
          if (configArg && this.ts.isObjectLiteralExpression(configArg)) {
            const handler = this.findHandler(configArg);
            if (handler) {
              const analysis = this.analyzer!.analyzeHandler(handler, typeChecker);
              diagnostics.push(...analysis.diagnostics);
            }
          }
        }
      }
      this.ts.forEachChild(node, visit);
    };

    visit(sourceFile);
    return diagnostics;
  }

  private findHandler(
    configObj: ObjectLiteralExpression
  ): FunctionExpression | ArrowFunction | MethodDeclaration | undefined {
    for (const prop of configObj.properties) {
      if (this.ts.isMethodDeclaration(prop)) {
        if (this.ts.isIdentifier(prop.name) && prop.name.text === 'handler') {
          return prop;
        }
      } else if (this.ts.isPropertyAssignment(prop)) {
        if (this.ts.isIdentifier(prop.name) && prop.name.text === 'handler') {
          if (
            this.ts.isFunctionExpression(prop.initializer) ||
            this.ts.isArrowFunction(prop.initializer)
          ) {
            return prop.initializer;
          }
        }
      }
    }
    return undefined;
  }
}

interface LanguageServiceHost {
  getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined
  getScriptVersion(fileName: string): string
}

interface PluginCreateInfo {
  languageService: LanguageService
  languageServiceHost: LanguageServiceHost
  project: Project
  serverHost: ServerHost
}

interface PluginModule {
  create(info: PluginCreateInfo): LanguageService
}

interface PluginModuleFactory {
  (mod: { typescript: TS }): PluginModule
}

/**
 * Find the most specific AST node at a given position.
 */
function findNodeAtPosition(sourceFile: ts.SourceFile, position: number, tsInstance: TS): ts.Node | undefined {
  function find(node: ts.Node): ts.Node | undefined {
    if (position >= node.getStart(sourceFile) && position < node.getEnd()) {
      return tsInstance.forEachChild(node, find) || node;
    }
    return undefined;
  }
  return find(sourceFile);
}

/**
 * Plugin factory - entry point for TypeScript Language Service.
 */
const init: PluginModuleFactory = ({ typescript }) => {
  return {
    create({ languageService, languageServiceHost, project, serverHost }) {
      // Check if we're already wrapped
      const existing = (languageService as unknown as Record<symbol, ProcessPlugin>)[pluginMarker];
      if (existing) {
        return languageService;
      }

      const plugin = new ProcessPlugin(typescript, languageService, languageServiceHost, project, serverHost);
      return plugin.wrap();
    },
  };
};

// ESM default export
export default init

// CommonJS compatibility for tsserver
;(init as any).default = init;
if (typeof module !== 'undefined') module.exports = init;
