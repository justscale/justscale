/**
 * CLI Route Builder Types
 *
 * Extends core RouteBuilder with CLI-specific methods.
 */

import type {
  BuilderPlugin,
  ExtractAddedFromMiddleware,
  ExtractStepDeps,
  ResponseEntry,
  RouteBuilderV2 as RouteBuilder,
  RouteDefV2 as RouteDef,
  Stop,
} from '../../index.js';
import type { GuardDef, MiddlewareDef } from '../../core/middleware.js';
import type { ServiceToken } from '../../core/service.js';
import type { z } from 'zod';
import type { CliIO } from '../io.js';

/**
 * CLI method type - used as route method identifier.
 */
export type CliMethod = 'CLI';

/**
 * CLI-specific base context provided by the protocol.
 * This is what the runner injects before route execution.
 */
export interface CliBaseContext<
  TArgs = Record<string, unknown>,
  TResult = void,
> {
  /** Parsed command arguments */
  args: TArgs
  /** CLI I/O interface for input/output */
  io: CliIO<TResult>
}

/**
 * CLI Route Builder - extends core RouteBuilder with CLI-specific methods.
 *
 * @typeParam TContext - Accumulated context from middleware
 * @typeParam TReturns - Union of possible responses (ResponseEntry union)
 * @typeParam TRequirements - Accumulated DI requirements from plugins
 * @typeParam TCommand - Command name literal
 */
export interface CliRouteBuilder<
  TContext,
  TReturns,
  TRequirements,
  TCommand extends string,
> extends RouteBuilder<TContext, TReturns, TRequirements, TCommand> {
  // Override base methods to return CliRouteBuilder
  // TypeScript limitation: can't use `this` type, must explicitly override

  /**
   * Add middleware that extends context.
   * Cannot stop execution - always returns additions.
   * Accepts either a plain function or a MiddlewareDef (with DI).
   * DI-aware middleware accumulates its inject deps into TRequirements,
   * which flows through `RequiresOf<ControllerDef>` for type-level check.
   */
  use<
    TMw extends
      | ((ctx: TContext) => object | Promise<object>)
      | MiddlewareDef<object, any>,
  >(
    middleware: TMw,
  ): CliRouteBuilder<
    TContext & ExtractAddedFromMiddleware<TMw>,
    TReturns,
    TRequirements | ExtractStepDeps<TMw>,
    TCommand
  >

  /**
   * Add guard that can stop execution.
   * Cannot add to context - only checks and potentially stops.
   * Accepts a guard function, a GuardDef (with DI), or an array of
   * GuardDefs (any-match semantics).
   */
  guard<
    TG extends
      | ((ctx: TContext & { stop(): Stop }) => void | Stop | boolean | Promise<void | Stop | boolean>)
      | GuardDef<Record<string, ServiceToken>>
      | readonly GuardDef<Record<string, ServiceToken>>[],
  >(
    check: TG,
  ): CliRouteBuilder<
    TContext,
    TReturns,
    TRequirements | ExtractStepDeps<TG>,
    TCommand
  >

  /**
   * Apply a plugin that can chain multiple operations.
   * Plugins can add use/guard/returns in any combination.
   */
  apply<TCtxOut, TRetOut, TReqOut>(
    plugin: BuilderPlugin<
      TContext,
      TCtxOut,
      TReturns,
      TRetOut,
      TRequirements,
      TReqOut,
      TCommand
    >,
  ): CliRouteBuilder<TCtxOut, TRetOut, TReqOut, TCommand>

  /**
   * Declare a possible response with schema.
   */
  returns<TStatus extends number, TSchema extends z.ZodType>(
    status: TStatus,
    schema: TSchema,
  ): CliRouteBuilder<
    TContext,
    TReturns | ResponseEntry<TStatus, z.infer<TSchema>>,
    TRequirements,
    TCommand
  >

  /**
   * Declare a possible response without body.
   */
  returns<TStatus extends number>(
    status: TStatus,
  ): CliRouteBuilder<
    TContext,
    TReturns | ResponseEntry<TStatus, void>,
    TRequirements,
    TCommand
  >

  // CLI-specific methods

  /**
   * Specify the input schema for arguments.
   * Uses convention-based parsing:
   * - Required fields = positional args (in declaration order)
   * - Optional/defaulted fields = named flags
   *
   * @example
   * ```typescript
   * Cli('build')
   *   .input(z.object({
   *     src: z.string(),           // positional: build <src>
   *     verbose: z.boolean().default(false)  // flag: --verbose
   *   }))
   *   .handle(({ args }) => {
   *     // args is typed as { src: string, verbose: boolean }
   *   })
   * ```
   */
  input<TSchema extends z.ZodType>(
    schema: TSchema,
  ): CliRouteBuilder<
    Omit<TContext, 'args'> & { args: z.infer<TSchema> },
    TReturns,
    TRequirements,
    TCommand
  >

  /**
   * One-line summary surfaced by `just --help` and prefixed to the
   * per-command `--help` output.
   *
   * @example
   * ```typescript
   * Cli('user add')
   *   .describe('Create a new user account')
   *   .input(...)
   * ```
   */
  describe(text: string): CliRouteBuilder<TContext, TReturns, TRequirements, TCommand>

  /**
   * Set final handler.
   */
  handle(
    handler: (ctx: TContext) => void | Promise<void>,
  ): CliRouteDef<TCommand, TReturns, TRequirements>
}

/**
 * CLI-specific route definition.
 * Extends core RouteDef with CLI method and optional input schema.
 */
export interface CliRouteDef<TCommand extends string, TReturns, TRequirements>
  extends RouteDef<TCommand, TReturns, TRequirements> {
  method: CliMethod
  /** Input schema for argument validation */
  inputSchema?: z.ZodType
  /** One-line summary from `.describe()` — surfaced in `--help`. */
  description?: string
}
