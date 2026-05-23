/**
 * JustScale TypeScript
 *
 * Drop-in TypeScript SDK that injects JustScale process diagnostics
 * (TSP* errors) into the IDE language service without requiring the
 * tsserver LSP plugin to be loaded.
 *
 * Usage:
 *   // In VS Code settings.json:
 *   { "typescript.tsdk": "node_modules/@justscale/typescript/lib" }
 *
 *   // In JetBrains:
 *   Settings > Languages > TypeScript > TypeScript package path
 */

import { createLogger } from './logger';
import type * as TS from 'typescript';

// Process analyzer is loaded dynamically at runtime to avoid rootDir issues
// These will be populated when the lib is used from a built package
let analyzeHandler: ((handler: TS.Node, typeChecker: TS.TypeChecker) => { diagnostics: TS.Diagnostic[] }) | null = null;
let formatErrorCode: ((code: number) => string) | null = null;
let filterUsingExportsDiagnostics: ((diagnostics: TS.Diagnostic[]) => TS.Diagnostic[]) | null = null;
let extractAndInjectExportsTypes: ((program: TS.Program) => Map<string, string>) | null = null;

// Try to load process analyzer from built dist
try {
  const analyzer = require('@justscale/typescript/api');
  analyzeHandler = analyzer.analyzeHandler;
  formatErrorCode = analyzer.formatErrorCode;
  const errors = require('../dist/compiler/errors.js');
  filterUsingExportsDiagnostics = errors.filterUsingExportsDiagnostics;
  const prepass = require('../dist/compiler/exports-prepass.js');
  extractAndInjectExportsTypes = prepass.extractAndInjectExportsTypes;
} catch {
  // Not available yet (during build) or not installed
}

const log = createLogger('typescript');

log.info('JustScale TypeScript loading...');

const ts: typeof TS = require('typescript');

log.info('TypeScript loaded', { version: ts.version });

// TypeScript Language Service plugins are not reliably loaded by all IDEs
// (especially JetBrains). We patch createLanguageService directly to inject
// process-specific diagnostics (TSP errors) without requiring plugin loading.

const originalCreateLanguageService = ts.createLanguageService;

/**
 * Check if a source file is a process file (imports from @justscale/core/process
 * or has .process. in the filename).
 */
function isProcessFile(sourceFile: TS.SourceFile): boolean {
  if (sourceFile.fileName.includes('.process.')) {
    return true;
  }

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const moduleSpecifier = statement.moduleSpecifier;
      if (ts.isStringLiteral(moduleSpecifier)) {
        if (moduleSpecifier.text === '@justscale/core/process') {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Get process-specific diagnostics for a source file.
 */
function getProcessDiagnostics(
  sourceFile: TS.SourceFile,
  program: TS.Program
): TS.Diagnostic[] {
  const diagnostics: TS.Diagnostic[] = [];
  const typeChecker = program.getTypeChecker();

  // Find all createProcess calls
  const visit = (node: TS.Node): void => {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isIdentifier(expr) && expr.text === 'createProcess') {
        const configArg = node.arguments[0];
        if (configArg && ts.isObjectLiteralExpression(configArg)) {
          const handlerDiagnostics = analyzeProcessConfig(
            configArg,
            typeChecker,
          );
          diagnostics.push(...handlerDiagnostics);
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return diagnostics;
}

/**
 * Analyze a createProcess config and return diagnostics.
 */
function analyzeProcessConfig(
  configObj: TS.ObjectLiteralExpression,
  typeChecker: TS.TypeChecker,
): TS.Diagnostic[] {
  // Analyzer not available (during build or not installed)
  if (!analyzeHandler) {
    return [];
  }

  // Find the handler property
  let handler: TS.FunctionExpression | TS.ArrowFunction | TS.MethodDeclaration | undefined;

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

    if (prop.name.text === 'handler') {
      if (
        ts.isFunctionExpression(prop.initializer) ||
        ts.isArrowFunction(prop.initializer)
      ) {
        handler = prop.initializer;
      }
    }
  }

  if (!handler) {
    return [];
  }

  // Analyze the handler
  const analysis = analyzeHandler(handler, typeChecker);

  // Format diagnostic messages with TSP codes
  return analysis.diagnostics.map(d => ({
    ...d,
    messageText: formatDiagnosticMessage(d),
  }));
}

/**
 * Format diagnostic message with TSP code prefix.
 */
function formatDiagnosticMessage(diagnostic: TS.Diagnostic): string {
  const code = diagnostic.code - 100000; // Get our error code back
  const tspCode = formatErrorCode ? formatErrorCode(code) : `TSP${code}`;

  const message =
    typeof diagnostic.messageText === 'string'
      ? diagnostic.messageText
      : diagnostic.messageText.messageText;

  return `${tspCode}: ${message}`;
}

/**
 * Patched createLanguageService that injects process diagnostics.
 */
function patchedCreateLanguageService(
  host: TS.LanguageServiceHost,
  documentRegistry?: TS.DocumentRegistry,
  syntaxOnlyOrLanguageServiceMode?: boolean | TS.LanguageServiceMode
): TS.LanguageService {
  log.info('createLanguageService: CALLED - wrapping with process diagnostics');

  const originalLS = originalCreateLanguageService(
    host,
    documentRegistry,
    syntaxOnlyOrLanguageServiceMode
  );

  log.info('createLanguageService: original LS created, now wrapping');

  // Create a proxy that intercepts getSemanticDiagnostics
  const proxy: TS.LanguageService = Object.create(null);

  // Copy all methods from the original language service
  for (const k of Object.keys(originalLS) as Array<keyof TS.LanguageService>) {
    const x = originalLS[k];
    // @ts-expect-error - dynamic property assignment
    proxy[k] = typeof x === 'function' ? x.bind(originalLS) : x;
  }

  // Override getSemanticDiagnostics to add process errors
  proxy.getSemanticDiagnostics = (fileName: string): TS.Diagnostic[] => {
    log.info('getSemanticDiagnostics: called', { fileName });

    const original = originalLS.getSemanticDiagnostics(fileName);
    const program = originalLS.getProgram();

    if (!program) {
      log.info('getSemanticDiagnostics: no program');
      return original;
    }

    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) {
      log.info('getSemanticDiagnostics: no sourceFile');
      return original;
    }

    // Only check process files
    const isProcess = isProcessFile(sourceFile);
    log.info('getSemanticDiagnostics: isProcessFile check', { fileName, isProcess });

    if (!isProcess) {
      return original;
    }

    const filtered = filterUsingExportsDiagnostics ? filterUsingExportsDiagnostics(original as any) as TS.Diagnostic[] : original;

    log.info('getSemanticDiagnostics: analyzing process file', { fileName, analyzerLoaded: !!analyzeHandler });

    try {
      const processDiagnostics = getProcessDiagnostics(sourceFile, program);

      log.info('getSemanticDiagnostics: analysis complete', {
        fileName,
        originalCount: original.length,
        filteredCount: filtered.length,
        processCount: processDiagnostics.length,
      });

      if (processDiagnostics.length > 0) {
        log.info('getSemanticDiagnostics: found process errors', {
          fileName,
          count: processDiagnostics.length,
          errors: processDiagnostics.map(d => ({
            code: d.code,
            message: typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText
          }))
        });
      }

      return [...filtered, ...processDiagnostics];
    } catch (err) {
      log.error('getSemanticDiagnostics: error analyzing process file', {
        fileName,
        error: String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
      return original;
    }
  };

  log.info('createLanguageService: wrapped LS ready');
  return proxy;
}

log.info('Patched createLanguageService function created');

// The bundled tsserver has its own copy of createLanguageService that we can't
// patch. Instead, we patch the Project class prototype to intercept
// getLanguageService() and wrap the returned service.

const tsServer = (ts as unknown as { server?: { Project?: { prototype: unknown } } }).server;
if (tsServer?.Project) {
  const ProjectProto = tsServer.Project.prototype as {
    getLanguageService?: () => TS.LanguageService
    __justscale_patched?: boolean
  };

  if (ProjectProto.getLanguageService && !ProjectProto.__justscale_patched) {
    const originalGetLanguageService = ProjectProto.getLanguageService;

    ProjectProto.getLanguageService = function (this: unknown): TS.LanguageService {
      const ls = originalGetLanguageService.call(this);

      // Check if we already wrapped this language service
      const lsAny = ls as { __justscale_wrapped?: boolean };
      if (lsAny.__justscale_wrapped) {
        return ls;
      }

      log.info('Project.getLanguageService: wrapping language service');

      // Two-pass exports type injection state
      // Project IS the LanguageServiceHost (has getScriptSnapshot/getScriptVersion)
      const project = this as {
        getScriptSnapshot?: (fileName: string) => TS.IScriptSnapshot | undefined
        getScriptVersion?: (fileName: string) => string
      };
      let exportsExtracted = false;
      const modifiedSnapshots = new Map<string, string>();
      const injectedAtVersion = new Map<string, string>();

      // Override Project's getScriptSnapshot/getScriptVersion for exports injection
      if (extractAndInjectExportsTypes && project.getScriptSnapshot && project.getScriptVersion) {
        const origGetSnapshot = project.getScriptSnapshot.bind(project);
        const origGetVersion = project.getScriptVersion.bind(project);

        project.getScriptSnapshot = (fn: string) => {
          const version = origGetVersion(fn);
          const injAt = injectedAtVersion.get(fn);
          // Cache invalidation on file change
          if (injAt && injAt !== version) {
            modifiedSnapshots.delete(fn);
            injectedAtVersion.delete(fn);
            exportsExtracted = false;
          }
          const modified = modifiedSnapshots.get(fn);
          if (modified) {
            return ts.ScriptSnapshot.fromString(modified);
          }
          return origGetSnapshot(fn);
        };

        project.getScriptVersion = (fn: string) => {
          const version = origGetVersion(fn);
          if (modifiedSnapshots.has(fn)) {
            return version + '-exports';
          }
          return version;
        };

        log.info('Project: host overridden for exports type injection');
      }

      // Create wrapped version
      const originalGetSemanticDiagnostics = ls.getSemanticDiagnostics.bind(ls);

      ls.getSemanticDiagnostics = (fileName: string): TS.Diagnostic[] => {
        // Two-pass: on first call, extract exports types and inject into host snapshots
        if (!exportsExtracted && extractAndInjectExportsTypes) {
          exportsExtracted = true;
          try {
            const program = ls.getProgram();
            if (program) {
              const modified = extractAndInjectExportsTypes(program);
              if (modified.size > 0) {
                for (const [file, text] of modified) {
                  modifiedSnapshots.set(file, text);
                  try {
                    const origGetVersion = (project.getScriptVersion as any);
                    // Get base version (without our suffix) for cache tracking
                    const v = typeof origGetVersion === 'function' ? origGetVersion(file) : '0';
                    injectedAtVersion.set(file, String(v).replace('-exports', ''));
                  } catch { injectedAtVersion.set(file, '0'); }
                }
                log.info('Exports injection: injected types', {
                  count: modified.size,
                  files: [...modified.keys()],
                });
              }
            }
          } catch (err) {
            log.error('Exports injection error', { error: String(err) });
          }
        }

        const original = originalGetSemanticDiagnostics(fileName);
        const program = ls.getProgram();

        if (!program) {
          return original;
        }

        const sourceFile = program.getSourceFile(fileName);
        if (!sourceFile) {
          return original;
        }

        if (!isProcessFile(sourceFile)) {
          return original;
        }

        const filtered = filterUsingExportsDiagnostics ? filterUsingExportsDiagnostics(original as any) as TS.Diagnostic[] : original;

        try {
          const processDiagnostics = getProcessDiagnostics(sourceFile, program);
          return [...filtered, ...processDiagnostics];
        } catch (err) {
          log.error('getSemanticDiagnostics: error', {
            fileName,
            error: String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
          return filtered;
        }
      };

      lsAny.__justscale_wrapped = true;
      return ls;
    };

    ProjectProto.__justscale_patched = true;
    log.info('Patched ts.server.Project.prototype.getLanguageService');
  } else {
    log.warn('Could not patch ts.server.Project - getLanguageService not found or already patched');
  }
} else {
  log.info('ts.server.Project not available yet (will be patched when tsserver loads)');
}

const justscale = {
  version: '0.1.0',

  isProcessFile(sourceFile: TS.SourceFile): boolean {
    if (sourceFile.fileName.includes('.process.')) return true;

    for (const stmt of sourceFile.statements) {
      if (ts.isImportDeclaration(stmt)) {
        const moduleSpecifier = stmt.moduleSpecifier;
        if (ts.isStringLiteral(moduleSpecifier)) {
          if (moduleSpecifier.text === '@justscale/core/process') {
            return true;
          }
        }
      }
    }
    return false;
  },
};

const extendedTs = new Proxy(ts, {
  get(target, prop, receiver) {
    if (prop === 'createLanguageService') {
      return patchedCreateLanguageService;
    }
    if (prop === 'justscale') {
      return justscale;
    }
    return Reflect.get(target, prop, receiver);
  },
}) as typeof TS & { justscale: typeof justscale };

log.info('JustScale TypeScript ready', {
  tsVersion: ts.version,
  justscaleVersion: justscale.version,
});

// Replace in require cache so other modules get our patched version
const typescriptModulePath = require.resolve('typescript');
log.info('Replacing typescript module in require cache', { path: typescriptModulePath });

for (const [path, mod] of Object.entries(require.cache)) {
  if (path.endsWith('/typescript/lib/typescript.js') && mod) {
    log.info('Patching typescript in cache', { path });
    mod.exports = extendedTs;
  }
}

// Export the patched TypeScript
export = extendedTs;
