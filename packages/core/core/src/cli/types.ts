/**
 * CLI Plugin Type Augmentation
 *
 * Extends core interfaces for CLI transport:
 * - ControllerSettings: adds 'command' for subcommand namespace
 * - TransportContext: adds 'args' and 'io'
 * - RouteFactories: adds Cli
 */

import type { Prettify } from '../core/index.js';
import type { z } from 'zod';
import type { CliRouteBuilder, CliRouteDef, CliBaseContext } from './builder/index.js';
import type { CliIO } from './io.js';

/** Result schema symbol for typed results */
export const RESULT_SCHEMA = Symbol('cli.resultSchema');

/** Read the result schema from a route definition. */
export function getResultSchema(route: unknown): z.ZodType | undefined {
  return (route as Record<symbol, unknown>)?.[RESULT_SCHEMA] as z.ZodType | undefined;
}

/**
 * Extract positional args and flags from a Zod object schema.
 * Convention: required fields (no default, not optional) = positional args
 * Everything else = named flags
 */
export type ExtractArgs<T extends z.ZodType> = T extends z.ZodObject<
  infer Shape
>
  ? { [K in keyof Shape]: z.infer<Shape[K]> }
  : Record<string, unknown>;

/**
 * CLI-specific context additions
 */
export interface CliContext<TArgs = Record<string, unknown>, TResult = void> {
  /** Parsed command arguments */
  args: TArgs
  /** CLI I/O interface for input/output */
  io: CliIO<TResult>
}

/**
 * Full CLI route context with deps flattened.
 * Instead of { deps: { db }, args, io } you get { db, args, io }
 */
export type CliRouteContext<
  TDeps = Record<string, unknown>,
  TArgs = Record<string, unknown>,
  TResult = void,
> = Prettify<TDeps & CliContext<TArgs, TResult>>;

/** CLI route handler */
export type CliRouteHandler<
  TDeps = Record<string, unknown>,
  TArgs = Record<string, unknown>,
  TResult = void,
> = (ctx: CliRouteContext<TDeps, TArgs, TResult>) => void | Promise<void>;

/** CLI factory - supports both direct handler and builder pattern */
export type CliFactory<TDeps> = {
  // Builder pattern (1 arg - command name only)
  <TCommand extends string>(
    command: TCommand,
  ): CliRouteBuilder<CliBaseContext, never, {}, TCommand>

  // Builder with input schema (2 args)
  <TCommand extends string, TInput extends z.ZodType>(
    command: TCommand,
    input: TInput,
  ): CliRouteBuilder<CliBaseContext<z.infer<TInput>>, never, {}, TCommand>

  // Direct handler with schema (3 args)
  <TCommand extends string, TInput extends z.ZodType>(
    command: TCommand,
    input: TInput,
    handler: CliRouteHandler<TDeps, z.infer<TInput>>,
  ): CliRouteDef<TCommand, never, {}>
};

// Note: CLI types are now defined directly in core since CLI is built-in:
// - SupportedMethods.CLI → plugin/plugin.ts
// - ControllerSettings.command → controller/controller.ts
// - TransportContext.args/io → controller/controller.ts
// - RouteFactories.Cli → plugin/plugin.ts
