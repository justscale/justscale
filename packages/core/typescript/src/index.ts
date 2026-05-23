/**
 * @justscale/typescript
 *
 * Drop-in TypeScript replacement with JustScale process compilation support.
 *
 * Features:
 * - ptsc: Drop-in replacement for tsc with process diagnostics (TSPxxxx)
 * - ptscserver: Drop-in replacement for tsserver with IDE support
 * - LSP plugin: Language service plugin for VS Code and other IDEs
 * - Programmatic API: Transpile processes programmatically
 * - Configuration: Custom tsconfig.json section for JustScale options
 *
 * Quick Start:
 * ```bash
 * # Install
 * npm install @justscale/typescript typescript
 *
 * # Use ptsc instead of tsc
 * npx ptsc
 *
 * # Or configure VS Code
 * # Add to settings.json:
 * # "typescript.tsdk": "node_modules/@justscale/typescript/lib"
 * ```
 *
 * @packageDocumentation
 */

// Re-export compiler functionality
export {
  createProcessTransformer,
  compileProcessSource,
  compileProcessFile,
  formatDiagnostics,
  analyzeHandler,
  ProcessErrorCode,
  createProcessDiagnostic,
  formatErrorCode,
  isProcessDiagnostic,
  getProcessErrorCode,
  DiagnosticCollector,
  cli,
  // HMR change detection (pure library fn, consumed by @justscale/core
  // /hmr-watcher in dev mode to pick method-patch vs full-reload).
  detectChanges,
  mightContainServices,
} from './compiler/index.js';

export type {
  ServiceChange,
  ChangeDetectionResult,
} from './compiler/hmr-change-detector.js';

export type {
  ProcessCompilerOptions,
  CompileResult,
  AnalysisResult,
  BlockDefinition,
  SignalInfo,
  VariableInfo,
} from './compiler/index.js';

// Re-export configuration
export {
  parseConfig,
  findConfig,
  isProcessFile,
  defaultConfig,
  mergeConfig,
} from './config/index.js';

export type {
  JustScaleConfig,
  ParsedConfig,
  PluginConfig,
} from './config/index.js';

// Re-export programmatic API
export {
  transpile,
  transpileProject,
  createProgram,
  getProcessDiagnostics,
} from './api.js';

export type {
  TranspileResult,
  TranspileProjectResult,
  TranspileOptions,
} from './api.js';

// Protobuf and Cap'n Proto integrations are not shipped in 0.x.
// They live in private compiler plugins and will graduate to a separate
// `@justscale/format-*` family once the plugin contract stabilises.
