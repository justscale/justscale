/**
 * DI error codes and diagnostics. See formatter.ts for details.
 */

export {
  // Error codes
  DIErrorCode,
  formatDIErrorCode,
  isDIDiagnostic,
  getDIErrorCode,
  createDIDiagnostic,
  // Parsing utilities
  formatTokenName,
  parseUnionType,
  extractGenericArgs,
  hasDIErrorMarkers,
  parseMissingDepsError,
  // Formatting
  formatDIError,
  // Diagnostic processing
  isDITypeDiagnostic,
  rewriteDIDiagnostic,
  processDIDiagnostics,
  // Types
  type ParsedDIError,
} from './formatter.js';
