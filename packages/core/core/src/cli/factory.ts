/**
 * CLI route factory for defining CLI commands.
 */

import type { App } from '../index.js';
import type { z } from 'zod';
import {
  type CliRouteBuilder,
  type CliRouteDef,
  type CliBaseContext,
  createCliRouteBuilder,
  INPUT_SCHEMA,
} from './builder/index.js';
import { type RunOptions, run as runCli } from './runner.js';
import type { CliRouteHandler } from './types.js';

/**
 * CLI route factory.
 *
 * @example Builder pattern
 * ```typescript
 * Cli('build')
 *   .input(BuildArgs)
 *   .returns(BuildResult)
 *   .handle(({ src, io }) => {
 *     io.log('Building...')
 *     io.result({ success: true })
 *   })
 * ```
 *
 * @example Direct handler
 * ```typescript
 * Cli('status', StatusArgs, ({ io }) => {
 *   io.result({ branch: 'main', clean: true })
 * })
 * ```
 */
function cliFactory<TCommand extends string>(
  command: TCommand,
): CliRouteBuilder<CliBaseContext, never, {}, TCommand>;
function cliFactory<TCommand extends string, TInput extends z.ZodType>(
  command: TCommand,
  input: TInput,
): CliRouteBuilder<CliBaseContext<z.infer<TInput>>, never, {}, TCommand>;
function cliFactory<TCommand extends string, TInput extends z.ZodType>(
  command: TCommand,
  input: TInput,
  handler: CliRouteHandler<any, z.infer<TInput>>,
): CliRouteDef<TCommand, never, {}>;
function cliFactory<TCommand extends string>(
  command: TCommand,
  inputOrHandler?: z.ZodType | CliRouteHandler<any>,
  maybeHandler?: CliRouteHandler<any>,
):
  | CliRouteDef<TCommand, never, {}>
  | CliRouteBuilder<CliBaseContext, never, {}, TCommand> {
  if (inputOrHandler === undefined) {
    return createCliRouteBuilder<TCommand>(command);
  }

  if (typeof inputOrHandler === 'function') {
    const route: CliRouteDef<TCommand, never, {}> = {
      method: 'CLI',
      path: command,
      steps: [],
      responseSchemas: new Map(),
      handler: inputOrHandler as any,
    };
    return route;
  }

  const inputSchema = inputOrHandler;

  if (maybeHandler !== undefined) {
    const route: CliRouteDef<TCommand, never, {}> = {
      method: 'CLI',
      path: command,
      steps: [],
      responseSchemas: new Map(),
      handler: maybeHandler as any,
      inputSchema,
    }
    ;(route as any)[INPUT_SCHEMA] = inputSchema;
    return route;
  }

  return createCliRouteBuilder<TCommand>(command).input(inputSchema) as any;
}

/** Returns true if the process was started with CLI command arguments. */
function isCommandLineRun(): boolean {
  const argv = process.argv.slice(2);
  // Has arguments and first arg doesn't look like a file path
  return argv.length > 0 && !argv[0].endsWith('.js') && !argv[0].endsWith('.ts');
}

/** Run CLI commands from an app and exit the process. Never returns. */
async function run(
  app: App<any>,
  options: Omit<RunOptions, 'exitOnError'> = {},
): Promise<never> {
  const result = await runCli(app, { ...options, exitOnError: true });
  // If we get here (success without exit), exit cleanly
  process.exit(result.success ? 0 : 1);
}

/** The Cli route factory with static utility methods */
export const Cli = Object.assign(cliFactory, {
  isCommandLineRun,
  run,
});
