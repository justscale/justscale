/**
 * Convention-Based Argument Parser
 *
 * Parses CLI arguments based on Zod schema conventions:
 * - Required fields (no default, not optional) = positional args (in order)
 * - Optional or defaulted fields = named flags
 *
 * Supports:
 * - Positional args: `mycli build ./src ./dist`
 * - Long flags: `--verbose`, `--output=./dist`, `--output value`
 * - Short flags from Zod meta: `-v`, `-o ./dist`
 * - Boolean flags: `--verbose` (true), `--no-verbose` (false)
 * - Array flags: `--include=a --include=b`
 */

import {
  ZodArray,
  ZodBoolean,
  ZodDefault,
  ZodNullable,
  ZodNumber,
  ZodObject,
  ZodOptional,
  ZodPipe,
  type ZodType,
} from 'zod';

import type { CliFieldMeta } from './args.js';

/** Argument definition extracted from schema */
export interface ArgDef {
  name: string
  type: 'positional' | 'flag'
  zodType: ZodType
  required: boolean
  hasDefault: boolean
  defaultValue?: unknown
  /** Short flag(s) from CLI metadata */
  short?: string
  /** All flags from CLI metadata (e.g., ['-e', '--email']) */
  flags?: string[]
  description?: string
  /** Example values from zod `.meta({ examples: [...] })` — surfaced in errors/help. */
  examples?: readonly unknown[]
  isBoolean: boolean
  isArray: boolean
  /** CLI metadata (if using typed args) */
  cliMeta?: CliFieldMeta
}

/** Result of parsing raw argv */
export interface ParsedArgs {
  command: string[]
  args: Record<string, unknown>
  errors: string[]
}

/**
 * Extract argument definitions from a Zod schema.
 *
 * Convention:
 * - Required fields = positional (in object key order)
 * - Optional/defaulted = flags
 *
 * Zod v4 meta can specify shortcuts:
 * ```typescript
 * z.boolean().meta({ short: 'v' })  // -v flag
 * ```
 */
export function extractArgDefs(schema: ZodType | undefined): ArgDef[] {
  if (!schema) return [];

  // Unwrap ZodPipe (from .transform(), etc.)
  let innerSchema: ZodType = schema;
  while (innerSchema instanceof ZodPipe) {
    innerSchema = (innerSchema as any).def.in;
  }

  if (!(innerSchema instanceof ZodObject)) {
    return [];
  }

  const shape = innerSchema.shape;
  const defs: ArgDef[] = [];

  for (const [name, field] of Object.entries(shape)) {
    const zodType = field as ZodType;
    const def = analyzeField(name, zodType);
    defs.push(def);
  }

  // Sort: positional first (sorted by position if available), then flags
  const positional = defs.filter((d) => d.type === 'positional');
  const flags = defs.filter((d) => d.type === 'flag');

  // Sort positional args by their position metadata (if available)
  positional.sort((a, b) => {
    const posA = a.cliMeta?.position ?? Number.POSITIVE_INFINITY;
    const posB = b.cliMeta?.position ?? Number.POSITIVE_INFINITY;
    return posA - posB;
  });

  return [...positional, ...flags];
}

/**
 * Analyze a single field to determine if it's positional or a flag.
 * If CLI metadata is present, use it for type determination and flags.
 */
function analyzeField(name: string, zodType: ZodType): ArgDef {
  let currentType: ZodType = zodType;
  let required = true;
  let hasDefault = false;
  let defaultValue: unknown;
  let short: string | undefined;
  let flags: string[] | undefined;
  let description: string | undefined;
  let examples: readonly unknown[] | undefined;
  let cliMeta: CliFieldMeta | undefined;
  let position: number | undefined;

  // Check for CLI metadata first (from typed args)
  const topLevelMeta = zodType.meta?.();
  if (
    topLevelMeta &&
    typeof topLevelMeta === 'object' &&
    'cli' in topLevelMeta
  ) {
    cliMeta = (topLevelMeta as { cli: CliFieldMeta }).cli;
    description = cliMeta.description || cliMeta.prompt;
    flags = cliMeta.flags;
    position = cliMeta.position;

    // Extract short flag from flags array
    if (flags) {
      const shortFlag = flags.find(
        (f) => f.startsWith('-') && !f.startsWith('--'),
      );
      if (shortFlag) {
        short = shortFlag.slice(1); // Remove leading -
      }
    }
  }

  // Unwrap wrappers to find the inner type
  while (true) {
    // Check for meta (Zod v4) - fallback for non-CLI metadata
    if (!cliMeta) {
      const meta = currentType.meta?.() as Record<string, unknown> | undefined;
      if (meta) {
        if (typeof meta.short === 'string') short = meta.short;
        if (typeof meta.description === 'string') description = meta.description;
        if (Array.isArray(meta.examples)) examples = meta.examples;
        else if (meta.example !== undefined) examples = [meta.example];
      }
    }

    // Check description
    if (!description && currentType.description) {
      description = currentType.description;
    }

    if (currentType instanceof ZodOptional) {
      required = false;
      currentType = (currentType as any).def.innerType;
    } else if (currentType instanceof ZodDefault) {
      hasDefault = true;
      // Zod v4: defaultValue is a direct property, not a function
      const defValue = (currentType as any).def.defaultValue;
      defaultValue = typeof defValue === 'function' ? defValue() : defValue;
      currentType = (currentType as any).def.innerType;
    } else if (currentType instanceof ZodNullable) {
      required = false;
      currentType = (currentType as any).def.innerType;
    } else if (currentType instanceof ZodPipe) {
      currentType = (currentType as any).def.in;
    } else {
      break;
    }
  }

  const isBoolean = currentType instanceof ZodBoolean;
  const isArray = currentType instanceof ZodArray;

  // Determine if positional or flag:
  // 1. If CLI metadata has position, it's positional
  // 2. Otherwise, use convention (required without default = positional)
  let type: 'positional' | 'flag';
  if (position !== undefined) {
    type = 'positional';
  } else if (cliMeta && flags && flags.length > 0) {
    // Has explicit flags = definitely a flag
    type = 'flag';
  } else {
    // Fall back to convention
    type = required && !hasDefault ? 'positional' : 'flag';
  }

  return {
    name,
    type,
    zodType,
    required,
    hasDefault,
    defaultValue,
    short,
    flags,
    description,
    examples,
    isBoolean,
    isArray,
    cliMeta,
  };
}

/**
 * Parse raw argv into structured arguments based on schema.
 *
 * @param argv Raw command line arguments (e.g., process.argv.slice(2))
 * @param argDefs Argument definitions from extractArgDefs
 */
export function parseArgv(argv: string[], argDefs: ArgDef[]): ParsedArgs {
  const positionalDefs = argDefs.filter((d) => d.type === 'positional');
  const flagDefs = argDefs.filter((d) => d.type === 'flag');

  // Build lookup maps
  const flagByName = new Map<string, ArgDef>();
  const flagByShort = new Map<string, ArgDef>();

  for (const def of flagDefs) {
    // Map by field name and kebab-case
    flagByName.set(def.name, def);
    flagByName.set(toKebabCase(def.name), def);

    // Map by explicit flags from CLI metadata
    if (def.flags) {
      for (const flag of def.flags) {
        if (flag.startsWith('--')) {
          flagByName.set(flag.slice(2), def);
        } else if (flag.startsWith('-')) {
          flagByShort.set(flag.slice(1), def);
        }
      }
    }

    // Legacy: map by short if no explicit flags
    if (def.short && !def.flags) {
      flagByShort.set(def.short, def);
    }
  }

  const command: string[] = [];
  const args: Record<string, unknown> = {};
  const errors: string[] = [];
  const arrayValues = new Map<string, unknown[]>();

  let positionalIndex = 0;
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];

    if (arg === '--') {
      // Everything after -- is positional
      i++;
      while (i < argv.length) {
        if (positionalIndex < positionalDefs.length) {
          setValue(
            positionalDefs[positionalIndex],
            argv[i],
            args,
            arrayValues,
          );
          positionalIndex++;
        }
        i++;
      }
      break;
    }

    if (arg.startsWith('--no-')) {
      // Boolean negation: --no-verbose
      const name = arg.slice(5);
      const def = flagByName.get(name);
      if (def?.isBoolean) {
        args[def.name] = false;
      } else {
        errors.push(`Unknown flag: ${arg}`);
      }
      i++;
    } else if (arg.startsWith('--')) {
      // Long flag: --verbose, --output=value, --output value
      const eqIndex = arg.indexOf('=');
      let name: string;
      let value: string | undefined;

      if (eqIndex !== -1) {
        name = arg.slice(2, eqIndex);
        value = arg.slice(eqIndex + 1);
      } else {
        name = arg.slice(2);
      }

      const def = flagByName.get(name);
      if (!def) {
        errors.push(`Unknown flag: --${name}`);
        i++;
        continue;
      }

      if (def.isBoolean) {
        args[def.name] = value !== undefined ? value !== 'false' : true;
      } else if (value !== undefined) {
        setValue(def, value, args, arrayValues);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        i++;
        setValue(def, argv[i], args, arrayValues);
      } else {
        errors.push(`Flag --${name} requires a value`);
      }
      i++;
    } else if (arg.startsWith('-') && arg.length > 1) {
      // Short flag: -v, -o value, -o=value
      const eqIndex = arg.indexOf('=');
      let short: string;
      let value: string | undefined;

      if (eqIndex !== -1) {
        short = arg.slice(1, eqIndex);
        value = arg.slice(eqIndex + 1);
      } else {
        short = arg.slice(1);
      }

      // Handle combined short flags like -abc
      if (short.length > 1 && eqIndex === -1) {
        for (const s of short) {
          const def = flagByShort.get(s);
          if (def?.isBoolean) {
            args[def.name] = true;
          } else if (!def) {
            errors.push(`Unknown short flag: -${s}`);
          }
        }
        i++;
        continue;
      }

      const def = flagByShort.get(short);
      if (!def) {
        errors.push(`Unknown short flag: -${short}`);
        i++;
        continue;
      }

      if (def.isBoolean) {
        args[def.name] = value !== undefined ? value !== 'false' : true;
      } else if (value !== undefined) {
        setValue(def, value, args, arrayValues);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        i++;
        setValue(def, argv[i], args, arrayValues);
      } else {
        errors.push(`Flag -${short} requires a value`);
      }
      i++;
    } else {
      // Positional argument or subcommand.
      // Positionals go through setValue for the same coercion a flag
      // value would get — `cmd 42` now behaves like `cmd --count 42`.
      if (positionalIndex < positionalDefs.length) {
        setValue(positionalDefs[positionalIndex], arg, args, arrayValues);
        positionalIndex++;
      } else {
        // Could be a subcommand
        command.push(arg);
      }
      i++;
    }
  }

  // Apply array values
  for (const [name, values] of arrayValues) {
    args[name] = values;
  }

  // Apply defaults for missing flags
  for (const def of flagDefs) {
    if (!(def.name in args)) {
      if (def.hasDefault) {
        args[def.name] = def.defaultValue;
      } else if (def.isArray) {
        args[def.name] = [];
      }
    }
  }

  return { command, args, errors };
}

function setValue(
  def: ArgDef,
  value: string,
  args: Record<string, unknown>,
  arrayValues: Map<string, unknown[]>,
): void {
  const coerced = coerceValue(value, def);

  if (def.isArray) {
    if (!arrayValues.has(def.name)) {
      arrayValues.set(def.name, []);
    }
    arrayValues.get(def.name)!.push(coerced);
  } else {
    args[def.name] = coerced;
  }
}

function coerceValue(value: string, def: ArgDef): unknown {
  // Try to coerce based on the inner type
  let innerType: ZodType = def.zodType;

  // Unwrap wrappers
  while (
    innerType instanceof ZodOptional ||
    innerType instanceof ZodDefault ||
    innerType instanceof ZodNullable ||
    innerType instanceof ZodPipe
  ) {
    if (innerType instanceof ZodPipe) {
      innerType = (innerType as any).def.in;
    } else {
      innerType = (innerType as any).def.innerType;
    }
  }

  // Handle arrays - get inner type
  if (innerType instanceof ZodArray) {
    innerType = (innerType as any).def.type;
  }

  if (innerType instanceof ZodNumber) {
    const num = Number(value);
    return Number.isNaN(num) ? value : num;
  }

  if (innerType instanceof ZodBoolean) {
    return value === 'true' || value === '1' || value === 'yes';
  }

  return value;
}

function toKebabCase(str: string): string {
  return str.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * A minimal route shape used by shell-completion — all we need is the
 * fully-qualified command path and its arg defs.
 */
export interface CompletionRoute {
  readonly fullCommand: string
  readonly argDefs: readonly ArgDef[]
}

/**
 * Produce shell-completion candidates for `just __complete`. Given the
 * current word list and cursor index, return the set of strings that
 * should complete the word under the cursor.
 *
 * Rules:
 *  - The word currently being typed is `words[index]` (may be empty).
 *  - Words before the cursor form a prefix used to narrow candidates.
 *  - If the prefix exactly matches a registered command, suggest that
 *    command's FLAG names (filtered by the partial word).
 *  - Otherwise suggest the next-word candidates — either the first word
 *    of every command (when the prefix is empty) or the word that comes
 *    right after the prefix within matching commands.
 */
export function generateCompletions(
  words: readonly string[],
  index: number,
  routes: Iterable<CompletionRoute>,
): string[] {
  const partial = words[index] ?? '';
  const prior = words.slice(0, Math.max(0, index));
  const priorStr = prior.join(' ');

  const routeList = [...routes];

  // Exact-match: prior words are a full command → suggest flags.
  const exact = routeList.find((r) => r.fullCommand === priorStr);
  if (exact && priorStr !== '') {
    const flagNames = exact.argDefs
      .filter((d) => d.type === 'flag')
      .map((d) =>
        d.flags && d.flags.length > 0
          ? d.flags.find((f) => f.startsWith('--')) ?? d.flags[0]!
          : `--${d.name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()}`,
      );
    return dedupeSorted(flagNames.filter((f) => f.startsWith(partial)));
  }

  // Next-word: for each command whose fullCommand starts with
  // `${priorStr} ...` (or any command if priorStr is empty), collect
  // the word that comes after `priorStr`.
  const suggestions = new Set<string>();
  for (const r of routeList) {
    const parts = r.fullCommand.split(' ');
    if (priorStr === '') {
      const head = parts[0];
      if (head && head.startsWith(partial)) suggestions.add(head);
      continue;
    }
    if (!r.fullCommand.startsWith(`${priorStr} `)) continue;
    const rest = r.fullCommand.slice(priorStr.length + 1);
    const nextWord = rest.split(' ')[0];
    if (nextWord && nextWord.startsWith(partial)) suggestions.add(nextWord);
  }
  return dedupeSorted([...suggestions]);
}

function dedupeSorted(arr: readonly string[]): string[] {
  return [...new Set(arr)].sort();
}

/**
 * Produce the single-line usage string for a command, e.g.
 * `Usage: just user add <email> [--name <name>]`.
 */
export function generateUsage(commandName: string, argDefs: ArgDef[]): string {
  const positional = argDefs.filter((d) => d.type === 'positional');
  const flags = argDefs.filter((d) => d.type === 'flag');

  let usage = `Usage: ${commandName}`;
  for (const def of positional) {
    usage += def.required ? ` <${def.name}>` : ` [${def.name}]`;
  }
  for (const def of flags) {
    const long = def.flags?.[0] ?? `--${toKebabCase(def.name)}`;
    const valuePart = def.isBoolean ? '' : ` <${def.name}>`;
    usage += def.required ? ` ${long}${valuePart}` : ` [${long}${valuePart}]`;
  }
  return usage;
}

/**
 * Generate help text for a command.
 */
export function generateHelp(
  commandName: string,
  argDefs: ArgDef[],
  description?: string,
): string {
  const positional = argDefs.filter((d) => d.type === 'positional');
  const flags = argDefs.filter((d) => d.type === 'flag');

  const lines: string[] = [];

  if (description) {
    lines.push(description);
    lines.push('');
  }

  lines.push(generateUsage(commandName, argDefs));
  lines.push('');

  const exampleSuffix = (def: ArgDef): string =>
    def.examples && def.examples.length > 0
      ? ` (e.g. ${def.examples.slice(0, 2).map((e) => JSON.stringify(e)).join(', ')})`
      : '';

  // Positional arguments
  if (positional.length > 0) {
    lines.push('Arguments:');
    for (const def of positional) {
      const desc = def.description || '';
      lines.push(`  ${def.name.padEnd(20)} ${desc}${exampleSuffix(def)}`);
    }
    lines.push('');
  }

  // Flags
  if (flags.length > 0) {
    lines.push('Options:');
    for (const def of flags) {
      // Use explicit flags from metadata if available
      let flagStr: string;
      if (def.flags && def.flags.length > 0) {
        flagStr = def.flags.join(', ');
      } else {
        const short = def.short ? `-${def.short}, ` : '    ';
        const long = `--${toKebabCase(def.name)}`;
        flagStr = `${short}${long}`;
      }
      const desc = def.description || '';
      const defaultStr = def.hasDefault
        ? ` (default: ${JSON.stringify(def.defaultValue)})`
        : '';
      lines.push(`  ${flagStr.padEnd(24)} ${desc}${defaultStr}${exampleSuffix(def)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Match command from argv to route commands.
 *
 * @param argv Raw argv (command parts already extracted)
 * @param routes Map of command paths to routes
 * @returns Matched route path and remaining argv
 */
export function matchCommand(
  argv: string[],
  routes: Map<string, unknown>,
): { path: string; argv: string[] } | null {
  // Try longest match first
  for (let len = argv.length; len >= 1; len--) {
    const path = argv.slice(0, len).join(' ');
    if (routes.has(path)) {
      return { path, argv: argv.slice(len) };
    }
  }

  return null;
}
