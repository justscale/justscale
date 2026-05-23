/**
 * CLI Route Builder Factory
 *
 * Creates CLI route builders that extend the core builder with CLI-specific methods.
 */

// Import from the leaf builder module rather than the package barrel
// `../../index.js` — the barrel re-exports features/config/cli, which
// pulls in Cli from cli/index.ts. Going through it here would put
// cli/service.ts back into the TDZ by the time cluster.ts reads
// CliService.
import { createBaseBuilder, createBuilderState } from '../../builder/create-builder.js';
import type { z } from 'zod';
import type { CliBaseContext, CliRouteBuilder, CliRouteDef } from './types.js';

/** Symbol to store input schema on route */
export const INPUT_SCHEMA = Symbol('cli.inputSchema');

/** Symbol to store one-line description on route (for top-level `--help`). */
export const CLI_DESCRIPTION = Symbol('cli.description');

/** Read the input schema from a route definition. */
export function getInputSchema(route: unknown): z.ZodType | undefined {
  return (route as Record<symbol, unknown>)?.[INPUT_SCHEMA] as z.ZodType | undefined;
}

/** Read the one-line command description from a route definition. */
export function getCliDescription(route: unknown): string | undefined {
  return (route as Record<symbol, unknown>)?.[CLI_DESCRIPTION] as string | undefined;
}

/**
 * Create a CLI route builder.
 * Extends the core builder with CLI-specific methods.
 */
export function createCliRouteBuilder<TCommand extends string>(
  command: TCommand,
): CliRouteBuilder<CliBaseContext, never, {}, TCommand> {
  const state = createBuilderState();
  const base = createBaseBuilder(state, command);

  // Track input schema + optional description
  let inputSchema: z.ZodType | undefined;
  let description: string | undefined;

  const builder: CliRouteBuilder<any, any, any, any> = {
    // Delegate core methods to base builder
    use(middleware) {
      base.use(middleware);
      return builder;
    },

    guard(check) {
      base.guard(check);
      return builder;
    },

    apply(plugin) {
      // Plugin transforms builder
      return plugin(builder as any) as any;
    },

    returns(status: number, schema?: z.ZodType, permission?: any) {
      base.returns(status, schema as any, permission);
      return builder;
    },

    types(types) {
      base.types(types);
      return builder;
    },

    // CLI-specific: input schema for arguments
    input(schema) {
      inputSchema = schema;
      return builder;
    },

    // One-line summary shown by top-level `--help` and the per-command
    // help header. Keep it short — a usage sentence, not a paragraph.
    describe(text) {
      description = text;
      return builder;
    },

    handle(handler) {
      const routeDef = base.handle(handler);
      const cliRouteDef: CliRouteDef<TCommand, any, any> = {
        ...routeDef,
        method: 'CLI',
        inputSchema,
        description,
      }
      ;(cliRouteDef as any)[INPUT_SCHEMA] = inputSchema;
      ;(cliRouteDef as any)[CLI_DESCRIPTION] = description;
      return cliRouteDef;
    },
  };

  return builder as any;
}

/**
 * CLI command factory.
 * Creates a builder for the given command name.
 *
 * @example
 * ```typescript
 * const buildRoute = Cli('build')
 *   .input(z.object({ src: z.string() }))
 *   .use(ctx => ({ srcPath: resolve(ctx.args.src) }))
 *   .guard(ctx => {
 *     if (!existsSync(ctx.srcPath)) {
 *       ctx.io.error('Source not found')
 *       return ctx.stop()
 *     }
 *   })
 *   .handle(ctx => {
 *     ctx.io.log(`Building from ${ctx.srcPath}`)
 *   })
 * ```
 */
export const Cli = <TCommand extends string>(command: TCommand) =>
  createCliRouteBuilder(command);
