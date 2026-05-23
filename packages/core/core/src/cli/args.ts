/**
 * Typed CLI Arguments
 *
 * Type-safe CLI argument definitions with metadata for prompts, flags, and validation.
 * Uses Zod v4's metadata system with branded types for compile-time enforcement.
 *
 * @example
 * ```typescript
 * import { cliArgs, arg } from "@justscale/cli";
 * import { z } from "zod";
 *
 * const CreateUserArgs = cliArgs({
 *   email: arg(z.string().email(), {
 *     prompt: 'Email address',
 *     flags: ['-e', '--email'],
 *   }),
 *   password: arg(z.string().min(8), {
 *     prompt: 'Password',
 *     secret: true,
 *     confirm: true,
 *   }),
 *   role: arg(z.enum(['admin', 'user']).default('user'), {
 *     prompt: 'Role',
 *     flags: ['-r', '--role'],
 *   }),
 * });
 *
 * // Positional args (first two are positional):
 * const AddUserArgs = cliArgs({
 *   name: arg(z.string(), { prompt: 'Username', position: 0 }),
 *   team: arg(z.string(), { prompt: 'Team', position: 1 }),
 *   admin: arg(z.boolean().default(false), { prompt: 'Admin?', flags: ['--admin'] }),
 * });
 * // CLI: add-user john engineering --admin
 * ```
 */

import { ZodObject, type ZodType, z } from 'zod';

// ============================================================================
// CLI Field Metadata
// ============================================================================

/**
 * Metadata for a CLI field.
 * Defines how the field is prompted, validated, and parsed.
 */
export interface CliFieldMeta {
  /** Prompt message shown when asking for input */
  prompt: string
  /** CLI flags for this argument (e.g., ['-e', '--email']) */
  flags?: string[]
  /** Hide input (for passwords) */
  secret?: boolean
  /** Ask twice for confirmation (used with secret) */
  confirm?: boolean
  /** Position for positional args (0, 1, 2...). Omit for flag-only args. */
  position?: number
  /** Description shown in help text (overrides Zod's .describe()) */
  description?: string
}

// ============================================================================
// Branded Type for Type-Safe CLI Args
// ============================================================================

/** Brand symbol for CLI args - ensures compile-time enforcement */
declare const CLI_ARG_BRAND: unique symbol;

/**
 * A CLI-enabled field schema.
 * Brands the Zod type to ensure it has CLI metadata attached.
 */
export type CliArg<T extends ZodType = ZodType> = T & {
  readonly [CLI_ARG_BRAND]: CliFieldMeta
};

/**
 * Shape type that requires all fields to be CliArg.
 * Used by cliArgs() to enforce metadata on all fields.
 */
export type CliArgsShape = Record<string, CliArg<ZodType>>;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a CLI argument with metadata.
 * Attaches CLI metadata to a Zod schema and brands the type.
 *
 * @param schema - Zod schema for validation
 * @param meta - CLI metadata (prompt, flags, secret, etc.)
 * @returns Branded CliArg type
 *
 * @example
 * ```typescript
 * // Simple flag argument
 * arg(z.string().email(), { prompt: 'Email', flags: ['-e', '--email'] })
 *
 * // Secret with confirmation
 * arg(z.string().min(8), { prompt: 'Password', secret: true, confirm: true })
 *
 * // Positional argument
 * arg(z.string(), { prompt: 'Name', position: 0 })
 * ```
 */
export function arg<T extends ZodType>(
  schema: T,
  meta: CliFieldMeta,
): CliArg<T> {
  // Use Zod v4's .meta() to attach CLI metadata
  const withMeta = schema.meta({ cli: meta });
  return withMeta as CliArg<T>;
}

/**
 * Create a CLI input schema from CliArg fields.
 * ONLY accepts CliArg fields - raw Zod schemas will cause a compile error.
 *
 * @param shape - Object with CliArg fields
 * @returns Zod object schema with CLI metadata preserved
 *
 * @example
 * ```typescript
 * // This compiles:
 * const Args = cliArgs({
 *   email: arg(z.string().email(), { prompt: 'Email' }),
 * });
 *
 * // This FAILS to compile (missing arg() wrapper):
 * const Args = cliArgs({
 *   email: z.string().email(), // Error: Type 'ZodString' is not assignable to 'CliArg'
 * });
 * ```
 */
export function cliArgs<T extends CliArgsShape>(
  shape: T,
): ZodObject<{ [K in keyof T]: T[K] extends CliArg<infer U> ? U : never }> {
  // Use z.object() to create the schema - preserves metadata on fields
  return z.object(shape) as any;
}

// ============================================================================
// Metadata Extraction
// ============================================================================

/**
 * Extract CLI metadata from a schema shape.
 * Used by the parser/runner to get prompts, flags, etc.
 *
 * @param schema - ZodObject schema created with cliArgs()
 * @returns Map of field name to CLI metadata
 */
export function extractCliMeta(schema: ZodType): Map<string, CliFieldMeta> {
  const result = new Map<string, CliFieldMeta>();

  // Handle ZodObject
  if (schema instanceof ZodObject) {
    const shape = schema.shape;
    for (const [key, fieldSchema] of Object.entries(shape)) {
      const meta = (fieldSchema as ZodType).meta?.();
      if (meta && typeof meta === 'object' && 'cli' in meta) {
        result.set(key, (meta as { cli: CliFieldMeta }).cli);
      }
    }
  }

  return result;
}

/**
 * Get CLI metadata for a single field.
 *
 * @param schema - Zod schema with metadata
 * @returns CLI metadata or undefined
 */
export function getCliMeta(schema: ZodType): CliFieldMeta | undefined {
  const meta = schema.meta?.();
  if (meta && typeof meta === 'object' && 'cli' in meta) {
    return (meta as { cli: CliFieldMeta }).cli;
  }
  return undefined;
}

/**
 * Check if a schema has CLI metadata.
 */
export function hasCliMeta(schema: ZodType): boolean {
  return getCliMeta(schema) !== undefined;
}

// ============================================================================
// Argument Ordering
// ============================================================================

/**
 * Get positional arguments in order.
 * Returns fields with position metadata, sorted by position number.
 *
 * @param schema - ZodObject schema with CLI metadata
 * @returns Array of [fieldName, metadata] sorted by position
 */
export function getPositionalArgs(
  schema: ZodType,
): Array<[string, CliFieldMeta]> {
  const meta = extractCliMeta(schema);
  const positional: Array<[string, CliFieldMeta]> = [];

  for (const [key, fieldMeta] of meta) {
    if (fieldMeta.position !== undefined) {
      positional.push([key, fieldMeta]);
    }
  }

  // Sort by position
  positional.sort((a, b) => (a[1].position ?? 0) - (b[1].position ?? 0));

  return positional;
}

/**
 * Get flag arguments (non-positional).
 * Returns fields without position metadata.
 *
 * @param schema - ZodObject schema with CLI metadata
 * @returns Array of [fieldName, metadata]
 */
export function getFlagArgs(schema: ZodType): Array<[string, CliFieldMeta]> {
  const meta = extractCliMeta(schema);
  const flags: Array<[string, CliFieldMeta]> = [];

  for (const [key, fieldMeta] of meta) {
    if (fieldMeta.position === undefined) {
      flags.push([key, fieldMeta]);
    }
  }

  return flags;
}
