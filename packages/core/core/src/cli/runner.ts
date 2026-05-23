/**
 * Executes CLI commands. Supports both terminal execution and programmatic invocation.
 */

import type { App } from '../index.js';
import { executeRoute } from '../builder/execute.js';
import { runInFullRequestScope } from '../core/context.js';
import type { z } from 'zod';
import { getCliDescription, getInputSchema } from './builder/create-cli-builder.js';
import { type CliIO, createMockIO, createTerminalIO } from './io.js';
import {
  type ArgDef,
  extractArgDefs,
  generateCompletions,
  generateHelp,
  generateUsage,
  parseArgv,
} from './parser.js';
import { getResultSchema } from './types.js';

/** Route with CLI-specific metadata */
interface CliRoute {
  path: string
  prefix: string
  fullCommand: string
  route: any
  argDefs: ArgDef[]
  inputSchema?: z.ZodType
  resultSchema?: z.ZodType
  /** One-line summary from `Cli(...).describe(...)`. */
  description?: string
}

/** Result of running a command */
export interface RunResult {
  success: boolean
  result?: unknown
  error?: Error
  output?: string[]
}

/** Options for the CLI runner */
export interface RunOptions {
  /** Custom argv (default: process.argv.slice(2)) */
  argv?: string[]
  /** Enable verbose output */
  verbose?: boolean
  /** Custom IO implementation */
  io?: CliIO<unknown>
  /** Exit process on error (default: true) */
  exitOnError?: boolean
  /** Show help with --help (default: true) */
  helpFlag?: boolean
  /** Application name for help text */
  name?: string
}

/**
 * Build a map of CLI routes from an app.
 * Combines controller prefix (subcommand namespace) with route path (command).
 */
export function buildRouteMap(
  app: App<any>,
): Map<string, CliRoute & { deps: Record<string, unknown> }> {
  const routes = new Map<string, CliRoute & { deps: Record<string, unknown> }>();

  for (const controller of app.controllers) {
    const prefix =
      (controller.settings as any)?.command ||
      (controller.settings as any)?.prefix ||
      '';

    for (const compiledRoute of controller.routes) {
      if ((compiledRoute as any).method !== 'CLI') continue;

      const route = compiledRoute as unknown as any;
      const commandName = route.path;
      const fullCommand = prefix ? `${prefix} ${commandName}` : commandName;
      const inputSchema = getInputSchema(route);
      const resultSchema = getResultSchema(route);
      const argDefs = extractArgDefs(inputSchema || route.schema);

      routes.set(fullCommand, {
        path: commandName,
        prefix,
        fullCommand,
        route,
        argDefs,
        inputSchema,
        resultSchema,
        description: getCliDescription(route) ?? (route as { description?: string }).description,
        deps: controller.deps,
      });
    }
  }

  return routes;
}

/**
 * Prompt for missing required arguments using CLI metadata.
 * Only prompts if the field has CLI metadata with a prompt string.
 *
 * @param args - Parsed arguments (will be mutated)
 * @param argDefs - Argument definitions
 * @param io - CLI IO for prompting
 */
async function promptForMissingArgs(
  args: Record<string, unknown>,
  argDefs: ArgDef[],
  io: CliIO<unknown>,
): Promise<void> {
  for (const def of argDefs) {
    if (args[def.name] !== undefined || def.hasDefault || !def.required) {
      continue;
    }

    const cliMeta = def.cliMeta;
    const label = cliMeta?.prompt ?? def.description ?? humanizeArgName(def.name);

    if (cliMeta?.secret) {
      const value = await io.password(`${label}:`);
      if (cliMeta.confirm) {
        const confirm = await io.password(`Confirm ${label.toLowerCase()}:`);
        if (value !== confirm) {
          throw new Error(`${label} confirmation does not match`);
        }
      }
      args[def.name] = value;
    } else if (def.isBoolean) {
      args[def.name] = await io.confirm(`${label}?`);
    } else {
      args[def.name] = await io.prompt(`${label}:`);
    }
  }
}

/** "emailAddress" → "Email address"; "email" → "Email". */
function humanizeArgName(name: string): string {
  const spaced = name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** How the arg is addressed on the CLI - `<email>` for positional, `--name` for flag. */
function refFor(name: string, def: ArgDef | undefined): string {
  if (!def) return name;
  if (def.type === 'positional') return `<${def.name}>`;
  return def.flags?.[0] ?? `--${def.name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`;
}

/** The human-friendly label from `.describe()` / `.meta({ label })`, fallback to ref. */
function labelFor(name: string, def: ArgDef | undefined): string {
  const described = def?.description?.trim();
  if (described) return described;
  return refFor(name, def);
}

/** Turn a zod issue into a one-line CLI error. */
function formatValidationIssue(
  issue: z.core.$ZodIssue,
  def: ArgDef | undefined,
): string {
  const name = String(issue.path[0] ?? '');
  const ref = refFor(name, def);
  const label = labelFor(name, def);
  // Include the CLI-addressable ref in parens when we're leading with the
  // description, so users can still see what to type.
  const subject = label === ref ? ref : `${label} (${ref})`;

  if (issue.code === 'invalid_type' && (issue as { input?: unknown }).input === undefined) {
    return def?.type === 'flag' ? `missing option: ${subject}` : `missing argument: ${subject}`;
  }
  if (issue.code === 'invalid_type') {
    const expected = (issue as { expected?: string }).expected ?? 'valid value';
    return `${subject}: expected ${expected}`;
  }
  if (issue.code === 'too_small') {
    const min = (issue as { minimum?: number | bigint }).minimum;
    const type = (issue as { type?: string }).type;
    const unit = type === 'string' ? 'characters' : type === 'array' ? 'items' : '';
    return `${subject}: must be at least ${min}${unit ? ` ${unit}` : ''}`;
  }
  if (issue.code === 'too_big') {
    const max = (issue as { maximum?: number | bigint }).maximum;
    const type = (issue as { type?: string }).type;
    const unit = type === 'string' ? 'characters' : type === 'array' ? 'items' : '';
    return `${subject}: must be at most ${max}${unit ? ` ${unit}` : ''}`;
  }
  if (issue.code === 'invalid_format') {
    const format = (issue as { format?: string }).format;
    return format ? `${subject}: invalid ${format}` : `${subject}: invalid format`;
  }
  return `${subject}: ${issue.message}`;
}

/**
 * Match argv to a CLI route.
 */
function matchRoute(
  argv: string[],
  routes: Map<string, CliRoute & { deps: Record<string, unknown> }>,
): {
  route: CliRoute & { deps: Record<string, unknown> }
  remainingArgv: string[]
} | null {
  const sortedKeys = [...routes.keys()].sort((a, b) => {
    const aWords = a.split(' ').length;
    const bWords = b.split(' ').length;
    return bWords - aWords;
  });

  for (const key of sortedKeys) {
    const parts = key.split(' ');
    let matches = true;

    for (let i = 0; i < parts.length; i++) {
      if (argv[i] !== parts[i]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return {
        route: routes.get(key)!,
        remainingArgv: argv.slice(parts.length),
      };
    }
  }

  return null;
}

/**
 * Group key for the help screen. Prefer the controller's explicit
 * prefix; if there isn't one, fall back to the first word of a
 * multi-word command (`user add` → group `user`). Single-word commands
 * stay at the top level.
 */
function groupKey(route: CliRoute): string {
  if (route.prefix) return route.prefix;
  const parts = route.fullCommand.split(' ');
  return parts.length > 1 ? parts[0]! : '';
}

/**
 * Generate application help text - grouped by command prefix (or by
 * first command word when no prefix is set), with descriptions
 * aligned so the command list is easy to scan.
 */
export function generateAppHelp(
  name: string,
  routes: Map<string, CliRoute & { deps: Record<string, unknown> }>,
): string {
  const lines: string[] = [];

  // `name === ''` is the shell-help path: we're already inside a REPL
  // ("justscale> help"), so prefixing commands with a program name is
  // noise. Skip the usage banner and jump straight to the command list.
  if (name !== '') {
    lines.push(`Usage: ${name} <command> [options]`);
    lines.push('');
  }

  const byGroup = new Map<string, CliRoute[]>();
  for (const route of routes.values()) {
    const key = groupKey(route);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key)!.push(route);
  }

  // Stable order: top-level (single-word commands) first, then
  // namespaced groups alphabetically.
  const ordered = [...byGroup.entries()].sort(([a], [b]) => {
    if (a === '' && b !== '') return -1;
    if (b === '' && a !== '') return 1;
    return a.localeCompare(b);
  });

  const widest = Math.max(
    0,
    ...[...routes.values()].map((r) => r.fullCommand.length),
  );
  const colWidth = Math.min(widest, 32);

  const padRight = (text: string): string =>
    text + ' '.repeat(Math.max(1, colWidth - text.length + 2));

  let firstGroup = true;
  for (const [group, groupRoutes] of ordered) {
    if (!firstGroup) lines.push('');
    firstGroup = false;

    lines.push(group === '' ? 'Commands:' : `${group}:`);

    groupRoutes.sort((a, b) => a.fullCommand.localeCompare(b.fullCommand));

    for (const route of groupRoutes) {
      // Inside a named group, show the sub-command (strip the group
      // prefix) so the repeated group noun doesn't dominate each row.
      let shown = route.fullCommand;
      if (group !== '' && shown.startsWith(`${group} `)) {
        shown = shown.slice(group.length + 1);
      }
      const desc = route.description ? padRight(shown) + route.description : shown;
      lines.push(`  ${desc}`);
    }
  }

  lines.push('');
  lines.push(`Run '${name} <command> --help' for details on a command.`);

  return lines.join('\n');
}

/** Run CLI commands from an app. */
export async function run(
  app: App<any>,
  options: RunOptions = {},
): Promise<RunResult> {
  const {
    argv = process.argv.slice(2),
    verbose = false,
    exitOnError = true,
    helpFlag = true,
    name = 'cli',
  } = options;

  const routes = buildRouteMap(app);

  const topLevelIO =
    options.io ??
    createTerminalIO({
      verbose,
      onResult: () => {},
    });

  if (argv[0] === '__complete') {
    const cursor = Number(argv[1] ?? '0');
    const words = argv.slice(2);
    for (const candidate of generateCompletions(words, cursor, routes.values())) {
      topLevelIO.log(candidate);
    }
    return { success: true };
  }

  if (
    helpFlag &&
    (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h')
  ) {
    topLevelIO.log(generateAppHelp(name, routes));
    return { success: true };
  }

  const match = matchRoute(argv, routes);

  if (!match) {
    const error = new Error(`Unknown command: ${argv.join(' ')}`);
    topLevelIO.error(error.message);
    topLevelIO.error(`Run '${name} --help' for usage.`);
    if (exitOnError) process.exit(1);
    return { success: false, error };
  }

  const { route: cliRoute, remainingArgv } = match;

  // Handle --help for specific command
  if (helpFlag && remainingArgv.includes('--help')) {
    topLevelIO.log(generateHelp(cliRoute.fullCommand, cliRoute.argDefs, cliRoute.description));
    return { success: true };
  }

  let collectedResult: unknown;
  const io =
    options.io ||
    createTerminalIO({
      verbose,
      resultSchema: cliRoute.resultSchema,
      onResult: (data) => {
        collectedResult = data;
      },
    });

  const parsed = parseArgv(remainingArgv, cliRoute.argDefs);

  if (parsed.errors.length > 0) {
    for (const err of parsed.errors) {
      io.error(`Error: ${err}`);
    }
    if (exitOnError) process.exit(1);
    return { success: false, error: new Error(parsed.errors.join('; ')) };
  }

  if (io.isInteractive) {
    try {
      await promptForMissingArgs(parsed.args, cliRoute.argDefs, io);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      io.error(err.message);
      if (exitOnError) process.exit(1);
      return { success: false, error: err };
    }
  }

  if (cliRoute.inputSchema) {
    const result = cliRoute.inputSchema.safeParse(parsed.args);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const name = String(issue.path[0] ?? '');
        const def = cliRoute.argDefs.find((d) => d.name === name);
        io.error(`error: ${formatValidationIssue(issue, def)}`);
        if (def?.examples && def.examples.length > 0) {
          const shown = def.examples.slice(0, 2).map((e) => JSON.stringify(e)).join(', ');
          io.error(`       example: ${shown}`);
        }
      }
      io.error('');
      io.error(generateUsage(cliRoute.fullCommand, cliRoute.argDefs));
      io.error('');
      io.error(`Run \`just ${cliRoute.fullCommand} --help\` for details.`);
      if (exitOnError) process.exit(1);
      return { success: false, error: result.error };
    }
    Object.assign(parsed.args, result.data);
  }

  const context = {
    args: parsed.args,
    io,
  };

  try {
    await runInFullRequestScope(
      {
        container: app.container,
        type: 'cli',
        name: cliRoute.fullCommand,
        metadata: {
          'cli.command': cliRoute.fullCommand,
          'cli.prefix': cliRoute.prefix,
        },
      },
      async () => {
        const route = cliRoute.route as any;
        if (route.steps && Array.isArray(route.steps)) {
          await executeRoute(route, context);
        } else {
          await app.execute(
            {
              route: cliRoute.route as any,
              deps: cliRoute.deps,
              params: {},
            },
            context,
          );
        }
      }
    );

    return { success: true, result: collectedResult };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    io.error(`Error: ${err.message}`);
    if (verbose && err.stack) {
      io.error(err.stack);
    }
    if (exitOnError) process.exit(1);
    return { success: false, error: err };
  }
}

/**
 * Invoke a CLI command programmatically.
 * Returns typed result if the command has a result schema.
 *
 * @example
 * ```typescript
 * const result = await invoke(app, 'build', { src: './src', verbose: true });
 * ```
 */
export async function invoke<TResult = unknown>(
  app: App<any>,
  command: string,
  args: Record<string, unknown> = {},
): Promise<TResult> {
  const routes = buildRouteMap(app);
  const cliRoute = routes.get(command);

  if (!cliRoute) {
    throw new Error(`Unknown command: ${command}`);
  }

  // Validate args
  if (cliRoute.inputSchema) {
    const result = cliRoute.inputSchema.safeParse(args);
    if (!result.success) {
      throw result.error;
    }
    // biome-ignore lint/style/noParameterAssign: intentional transformation of validated input
    args = result.data as Record<string, unknown>;
  }

  // Create mock IO to capture result
  let capturedResult: unknown;
  const io = createMockIO<unknown>();
  const originalResult = io.result.bind(io)
  ;(io as any).result = (data: unknown) => {
    capturedResult = data;
    originalResult(data);
  };

  // Build context
  const context: Record<string, unknown> = {
    args,
    io,
  };

  await runInFullRequestScope(
    {
      container: app.container,
      type: 'cli',
      name: command,
      metadata: {
        'cli.command': command,
        'cli.programmatic': true,
      },
    },
    async () => {
      const route = cliRoute.route as any;
      if (route.steps && Array.isArray(route.steps)) {
        await executeRoute(route, context);
      } else {
        await app.execute(
          {
            route: cliRoute.route as any,
            deps: cliRoute.deps,
            params: {},
          },
          context,
        );
      }
    }
  );

  return capturedResult as TResult;
}

/** Create a programmatic CLI client from an app. */
export function createClient(app: App<any>): {
  invoke<TResult = unknown>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<TResult>
  routes: string[]
} {
  const routes = buildRouteMap(app);

  return {
    async invoke<TResult = unknown>(
      command: string,
      args: Record<string, unknown> = {},
    ): Promise<TResult> {
      return invoke<TResult>(app, command, args);
    },
    routes: [...routes.keys()],
  };
}
