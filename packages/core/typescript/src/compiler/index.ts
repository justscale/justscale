/**
 * @justscale/core/process - Compiler
 *
 * TypeScript transformer that compiles process handlers into switch-based
 * VM-style execution for durable process execution.
 */

export { createProcessTransformer } from './transformer.js';
export type { ProcessCompilerOptions } from './transformer.js';

// HMR (Hot Module Replacement) Transformer
export { createHmrTransformer } from './hmr-transformer.js';
export type { HmrTransformerOptions } from './hmr-transformer.js';

// HMR Change Detection (for dev server)
export { detectChanges, mightContainServices } from './hmr-change-detector.js';
export type {
  ServiceChange,
  ChangeDetectionResult,
} from './hmr-change-detector.js';

export { compileProcessSource, compileProcessFile, formatDiagnostics } from './compile.js';
export type { CompileResult } from './compile.js';

export { analyzeHandler, expressionToName } from './analyzer.js';
export type { AnalysisResult, BlockDefinition, SignalInfo, VariableInfo, ExportsInfo, ExportFieldInfo, ExportMethodInfo, SubProcessInfo } from './analyzer.js';

export {
  ProcessErrorCode,
  createProcessDiagnostic,
  formatErrorCode,
  isProcessDiagnostic,
  getProcessErrorCode,
  DiagnosticCollector,
  filterUsingExportsDiagnostics,
} from './errors.js';

export { main as cli } from './cli.js';
