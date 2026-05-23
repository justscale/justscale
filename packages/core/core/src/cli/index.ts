/**
 * @justscale/cli
 *
 * CLI Route Factory Plugin
 *
 * Provides the Cli route factory for building command-line interfaces.
 * Supports builder pattern with middleware, typed input/output, and
 * interactive I/O.
 *
 * @example Controller with subcommands
 * ```typescript
 * import { createController } from "@justscale/core";
 * import "@justscale/cli";
 * import { z } from "zod";
 *
 * const MigrateArgs = z.object({
 *   direction: z.enum(['up', 'down']),
 *   steps: z.number().default(1),
 *   verbose: z.boolean().default(false),
 * });
 *
 * const MigrateResult = z.object({
 *   applied: z.number(),
 *   pending: z.number(),
 * });
 *
 * export const DbController = createController('db', {
 *   routes: ({ Cli }) => ({
 *     migrate: Cli('migrate')
 *       .input(MigrateArgs)
 *       .returns(MigrateResult)
 *       .handle(async ({ args, io }) => {
 *         const spinner = io.spinner('Running migrations...');
 *         // ... run migrations
 *         spinner.success('Migrations complete');
 *         io.result({ applied: 3, pending: 0 });
 *       }),
 *
 *     seed: Cli('seed')
 *       .input(z.object({ file: z.string().optional() }))
 *       .handle(async ({ args, io }) => {
 *         io.log('Seeding database...');
 *       }),
 *   }),
 * });
 * ```
 *
 * @example Running the CLI
 * ```typescript
 * import { createApp } from "@justscale/core";
 * import { run } from "@justscale/cli";
 * import { DbController } from "./controllers/db";
 *
 * const app = createApp({
 *   controllers: [DbController],
 * });
 *
 * // Terminal execution
 * await run(app, { name: 'mycli' });
 * // $ mycli db migrate up --verbose
 *
 * // Programmatic invocation
 * import { invoke } from "@justscale/cli";
 * const result = await invoke(app, 'db migrate', { direction: 'up' });
 * ```
 */

import { registerRouteFactory } from '../core/index.js';
import { Cli } from './factory.js';
// Side-effect import to apply module augmentation (SupportedMethods)
import './types.js';

// Re-export everything
export { Cli } from './factory.js';
export {
  createCliRouteBuilder,
  INPUT_SCHEMA,
  getInputSchema,
  type CliRouteBuilder,
  type CliRouteDef,
  type CliMethod,
  type CliBaseContext,
} from './builder/index.js';
export {
  run,
  invoke,
  createClient,
  type RunOptions,
  type RunResult,
} from './runner.js';
export {
  createTerminalIO,
  createMockIO,
  type CliIO,
  type TerminalIOOptions,
  type ProgressBar,
  type Spinner,
  type TableColumn,
} from './io.js';
export {
  extractArgDefs,
  parseArgv,
  generateHelp,
  matchCommand,
  type ArgDef,
  type ParsedArgs,
} from './parser.js';
export type {
  CliFactory,
  CliContext,
  CliRouteContext,
  CliRouteHandler,
} from './types.js';
export { RESULT_SCHEMA, getResultSchema } from './types.js';
export { createLocalAdapter, type CliAdapter } from './adapter.js';
export { registerCliHandlers } from './cluster.js';
export {
  CliService,
  LazyCliService,
  createCliService,
  type ICliService,
} from './service.js';
export {
  arg,
  cliArgs,
  extractCliMeta,
  getCliMeta,
  hasCliMeta,
  getPositionalArgs,
  getFlagArgs,
  type CliFieldMeta,
  type CliArg,
  type CliArgsShape,
} from './args.js';

// Import types for augmentation side effect
import './types.js';

// Import cluster integration - auto-registers CLI as transport plugin
import './cluster.js';

// Register the Cli factory
registerRouteFactory('Cli', Cli);
