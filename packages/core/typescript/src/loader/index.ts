/**
 * @justscale/typescript/loader
 *
 * PTS (Process TypeScript) compiler and loader for JustScale.
 *
 * ## Usage
 *
 * ### As a Node.js loader (recommended)
 *
 * ```bash
 * node --import @justscale/typescript/register --import tsx ./app.ts
 * ```
 *
 * ### Programmatic compilation
 *
 * ```typescript
 * import { createCompiler } from '@justscale/typescript/loader'
 *
 * const compiler = createCompiler({ rootDir: process.cwd() })
 * const result = compiler.compile('./processes/order.process.ts')
 * ```
 */

export { PtsCompiler, createCompiler } from './incremental.js';
export type { CompilerOptions, CompileResult } from './incremental.js';
