/**
 * JustScale TypeScript Server Library
 *
 * This module re-exports our patched TypeScript for IDE integration.
 * JetBrains loads this when using our lib/ as the TypeScript SDK.
 */

import { createLogger } from './logger';
import type * as TS from 'typescript';

let filterUsingExportsDiagnostics: ((diagnostics: TS.Diagnostic[]) => TS.Diagnostic[]) | null = null;
try {
  const errors = require('../dist/compiler/errors.js');
  filterUsingExportsDiagnostics = errors.filterUsingExportsDiagnostics;
} catch { /* errors.js not available in all environments */ }

const log = createLogger('tsserverlibrary');

log.info('JustScale TSServerLibrary loading...');

// Re-export our patched TypeScript
// This ensures JetBrains gets the proto-aware version
const ts = require('./typescript') as typeof TS & {
  server?: {
    Project?: { prototype: Record<string, unknown> }
  }
};

// Load the real tsserverlibrary to get ts.server
const realTsServerLib = require('typescript/lib/tsserverlibrary') as typeof TS & {
  server?: {
    Project?: { prototype: Record<string, unknown> }
  }
};

log.info('JustScale TSServerLibrary ready', { version: ts.version });

// Import process analyzer dynamically
let analyzeHandler: ((handler: TS.Node, typeChecker: TS.TypeChecker) => { diagnostics: TS.Diagnostic[] }) | null = null;
let formatErrorCode: ((code: number) => string) | null = null;

try {
  const analyzer = require('@justscale/typescript/api');
  analyzeHandler = analyzer.analyzeHandler;
  formatErrorCode = analyzer.formatErrorCode;
  log.info('Process analyzer loaded');
} catch (err) {
  log.info('Process analyzer not available', { error: String(err) });
}

/**
 * Check if a source file is a process file
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
  if (!analyzeHandler) {
    return [];
  }

  const diagnostics: TS.Diagnostic[] = [];
  const typeChecker = program.getTypeChecker();

  const visit = (node: TS.Node): void => {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isIdentifier(expr) && expr.text === 'createProcess') {
        const configArg = node.arguments[0];
        if (configArg && ts.isObjectLiteralExpression(configArg)) {
          // Find handler
          for (const prop of configArg.properties) {
            if (ts.isMethodDeclaration(prop)) {
              if (ts.isIdentifier(prop.name) && prop.name.text === 'handler') {
                const analysis = analyzeHandler(prop, typeChecker);
                diagnostics.push(...analysis.diagnostics.map(d => ({
                  ...d,
                  messageText: formatDiagnosticMessage(d),
                })));
              }
            } else if (ts.isPropertyAssignment(prop)) {
              if (ts.isIdentifier(prop.name) && prop.name.text === 'handler') {
                if (ts.isFunctionExpression(prop.initializer) || ts.isArrowFunction(prop.initializer)) {
                  const analysis = analyzeHandler(prop.initializer, typeChecker);
                  diagnostics.push(...analysis.diagnostics.map(d => ({
                    ...d,
                    messageText: formatDiagnosticMessage(d),
                  })));
                }
              }
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return diagnostics;
}

function formatDiagnosticMessage(diagnostic: TS.Diagnostic): string {
  const code = diagnostic.code - 100000;
  const tspCode = formatErrorCode ? formatErrorCode(code) : `TSP${code}`;
  const message = typeof diagnostic.messageText === 'string'
    ? diagnostic.messageText
    : diagnostic.messageText.messageText;
  return `${tspCode}: ${message}`;
}

// Patch the Project prototype from the real tsserverlibrary
if (realTsServerLib.server?.Project) {
  const ProjectProto = realTsServerLib.server.Project.prototype as {
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

      // Create wrapped version
      const originalGetSemanticDiagnostics = ls.getSemanticDiagnostics.bind(ls);

      ls.getSemanticDiagnostics = (fileName: string): TS.Diagnostic[] => {
        log.info('getSemanticDiagnostics: called', { fileName });

        const original = originalGetSemanticDiagnostics(fileName);
        const program = ls.getProgram();

        if (!program) {
          return original;
        }

        const sourceFile = program.getSourceFile(fileName);
        if (!sourceFile) {
          return original;
        }

        const isProcess = isProcessFile(sourceFile);
        log.info('getSemanticDiagnostics: isProcessFile', { fileName, isProcess });

        if (!isProcess) {
          return original;
        }

        const filtered = filterUsingExportsDiagnostics ? filterUsingExportsDiagnostics(original as any) as TS.Diagnostic[] : original;

        log.info('getSemanticDiagnostics: analyzing process file', { fileName });

        try {
          const processDiagnostics = getProcessDiagnostics(sourceFile, program);

          log.info('getSemanticDiagnostics: complete', {
            fileName,
            originalCount: original.length,
            filteredCount: filtered.length,
            processCount: processDiagnostics.length,
          });

          return [...filtered, ...processDiagnostics];
        } catch (err) {
          log.error('getSemanticDiagnostics: error', { fileName, error: String(err) });
          return original;
        }
      };

      lsAny.__justscale_wrapped = true;
      return ls;
    };

    ProjectProto.__justscale_patched = true;
    log.info('Patched ts.server.Project.prototype.getLanguageService');
  }
} else {
  log.warn('ts.server.Project not found in tsserverlibrary');
}

// Re-export the patched ts with server from real tsserverlibrary
const merged = {
  ...ts,
  server: realTsServerLib.server,
};

export = merged;
