/**
 * Parses and formats DI type errors into human-readable messages.
 * Detects errors via branded markers (__brand, _missing, _hint) from MissingDepsError.
 * Error codes: DI1001 missing deps, DI1002 circular, DI1003 unsatisfied constraint.
 */

import ts from 'typescript';

/**
 * Custom error codes for dependency injection.
 * Range: DI1000-DI9999
 *
 * These are offset by 200000 to avoid collision with TypeScript codes
 * (100000 range is used by TSP process errors).
 */
export const DIErrorCode = {
  /**
   * DI1001: Missing dependencies.
   *
   * A component requires dependencies that haven't been added to the builder.
   * Add the missing services/repositories before this component.
   *
   * Example:
   *   .add(UserService)  // Error: requires ModelRepository<User>
   *
   * Fix:
   *   .add(ModelRepository.of(User).bind(PgUser))
   *   .add(UserService)  // Now works
   */
  MissingDependencies: 1001,

  /**
   * DI1002: Circular dependency detected.
   *
   * Two or more components depend on each other in a cycle.
   * Refactor to break the cycle using interfaces or lazy injection.
   */
  CircularDependency: 1002,

  /**
   * DI1003: Unsatisfied constraint.
   *
   * A type constraint (RequiresSatisfied) was not met.
   */
  UnsatisfiedConstraint: 1003,
} as const;

export type DIErrorCode = (typeof DIErrorCode)[keyof typeof DIErrorCode];

/**
 * Base offset for DI error codes to avoid collision with TS/TSP codes.
 */
const DI_CODE_OFFSET = 200000;

/**
 * Format error code for display.
 */
export function formatDIErrorCode(code: DIErrorCode): string {
  return `DI${code}`;
}

/**
 * Check if a diagnostic is a DI-specific error.
 */
export function isDIDiagnostic(diagnostic: ts.Diagnostic): boolean {
  return diagnostic.source === 'justscale-di';
}

/**
 * Get the DI error code from a diagnostic.
 */
export function getDIErrorCode(diagnostic: ts.Diagnostic): DIErrorCode | null {
  if (!isDIDiagnostic(diagnostic)) return null;
  return (diagnostic.code - DI_CODE_OFFSET) as DIErrorCode;
}

/**
 * Markers that indicate a DI-related type error.
 * These come from the MissingDepsError interface in builder/types.ts:
 *   interface MissingDepsError<_C, TMissing> {
 *     readonly __brand: 'MissingDependencies'
 *     readonly _missing: TMissing
 *     readonly _hint: 'Add the missing dependencies before this component'
 *   }
 */
/**
 * Common token patterns and their human-readable formats.
 */
const TOKEN_PATTERNS: Array<{
  pattern: RegExp
  format: (match: RegExpMatchArray) => string
}> = [
  // ModelRepositoryToken<User, {}> or ModelRepositoryToken<User> -> ModelRepository<User>
  {
    pattern: /^ModelRepositoryToken<([^,<>]+)(?:,\s*\{[^}]*\})?>$/,
    format: (m) => `ModelRepository<${m[1].trim()}>`,
  },
  // RepositoryToken<User> -> Repository<User>
  {
    pattern: /^RepositoryToken<([^<>]+)>$/,
    format: (m) => `Repository<${m[1].trim()}>`,
  },
  // typeof AbstractEmailSender -> AbstractEmailSender
  {
    pattern: /^typeof\s+(\w+)$/,
    format: (m) => m[1],
  },
  // ServiceDef<SomeType, {...}> -> Service creating SomeType
  {
    pattern: /^ServiceDef<([^,<>]+)(?:,\s*\{[^}]*\})?>$/,
    format: (m) => `Service<${m[1].trim()}>`,
  },
  // FeatureToken<[...], [...]> -> Feature (we'll get name from context)
  {
    pattern: /^FeatureToken<\[([^\]]*)\],\s*\[([^\]]*)\]>$/,
    format: () => 'Feature',
  },
];

/**
 * Format a single token type string to a human-readable name.
 */
export function formatTokenName(typeStr: string): string {
  const trimmed = typeStr.trim();

  // Try each pattern
  for (const { pattern, format } of TOKEN_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      return format(match);
    }
  }

  // Fallback: clean up common noise
  return trimmed
    .replace(/\s*\{\s*\}/g, '') // Remove empty objects
    .replace(/\s*\[\.\.\.\]/g, '') // Remove [...]
    .replace(/\s+/g, ' '); // Normalize whitespace
}

/**
 * Parse a union type string into individual types.
 * Handles nested generics correctly.
 *
 * Example: "A<B> | C | D<E, F>" -> ["A<B>", "C", "D<E, F>"]
 */
export function parseUnionType(typeStr: string): string[] {
  const results: string[] = [];
  let current = '';
  let depth = 0;

  for (const char of typeStr) {
    if (char === '<' || char === '[' || char === '(') {
      depth++;
      current += char;
    } else if (char === '>' || char === ']' || char === ')') {
      depth--;
      current += char;
    } else if (char === '|' && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) {
        results.push(trimmed);
      }
      current = '';
    } else {
      current += char;
    }
  }

  const trimmed = current.trim();
  if (trimmed) {
    results.push(trimmed);
  }

  return results;
}

/**
 * Extract the inner types from a generic type.
 * Example: "MissingDepsError<A, B>" -> ["A", "B"]
 */
export function extractGenericArgs(typeStr: string): string[] {
  const start = typeStr.indexOf('<');
  if (start === -1) return [];

  // Find matching >
  let depth = 1;
  let end = start + 1;
  for (; end < typeStr.length && depth > 0; end++) {
    if (typeStr[end] === '<') depth++;
    else if (typeStr[end] === '>') depth--;
  }

  const inner = typeStr.slice(start + 1, end - 1);

  // Split by top-level commas
  const args: string[] = [];
  let current = '';
  depth = 0;

  for (const char of inner) {
    if (char === '<' || char === '[' || char === '(') {
      depth++;
      current += char;
    } else if (char === '>' || char === ']' || char === ')') {
      depth--;
      current += char;
    } else if (char === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    args.push(current.trim());
  }

  return args;
}

/**
 * Parsed MissingDepsError information.
 */
export interface ParsedDIError {
  /** The component being added (if extractable) */
  component: string | null
  /** Human-readable component name */
  componentName: string
  /** The missing dependency tokens */
  missingDeps: string[]
  /** Human-readable missing dependency names */
  missingDepNames: string[]
}

/**
 * Check if a type string contains DI error markers.
 * Looks for the branded fields from MissingDepsError:
 *   - __brand: 'MissingDependencies'
 *   - _missing: <type>
 *   - _hint: 'Add the missing dependencies...'
 */
export function hasDIErrorMarkers(typeStr: string): boolean {
  // Look for the branded markers
  return (
    // __brand: "MissingDependencies" or __brand: 'MissingDependencies'
    /\b__brand\s*:\s*["']MissingDependencies["']/.test(typeStr) ||
    // _missing: <some type>
    /\b_missing\s*:/.test(typeStr) ||
    // _hint: "Add the missing dependencies..."
    /\b_hint\s*:\s*["']Add the missing dependencies/.test(typeStr) ||
    // The generic type name itself
    typeStr.includes('MissingDepsError')
  );
}

/**
 * Extract the _missing type value from a type string.
 * Looks for patterns like: _missing: TypeA | TypeB
 */
function extractMissingFromBrandedType(typeStr: string): string | null {
  // Match _missing: <type> where type ends at ; or }
  const match = typeStr.match(/_missing\s*:\s*([^;}\n]+)/);
  if (match) {
    return match[1].trim();
  }
  return null;
}

/**
 * Parse a MissingDepsError type string.
 * Handles both:
 *   1. Generic form: MissingDepsError<Component, Missing>
 *   2. Structural form: { __brand: 'MissingDependencies'; _missing: Type; _hint: ... }
 *
 * @param typeStr The full type string
 * @returns Parsed error info, or null if not a MissingDepsError
 */
export function parseMissingDepsError(typeStr: string): ParsedDIError | null {
  // First, check for structural form with _missing field
  const missingFromBranded = extractMissingFromBrandedType(typeStr);
  if (missingFromBranded) {
    const missingDeps = parseUnionType(missingFromBranded);
    return {
      component: null,
      componentName: 'component',
      missingDeps,
      missingDepNames: missingDeps.map(formatTokenName),
    };
  }

  // Try generic form: MissingDepsError<Component, Missing>
  if (!typeStr.includes('MissingDepsError')) {
    return null;
  }

  // Find the MissingDepsError part
  const match = typeStr.match(/MissingDepsError</);
  if (!match) return null;

  const startIdx = typeStr.indexOf('MissingDepsError<');
  let depth = 1;
  let endIdx = startIdx + 'MissingDepsError<'.length;

  for (; endIdx < typeStr.length && depth > 0; endIdx++) {
    if (typeStr[endIdx] === '<') depth++;
    else if (typeStr[endIdx] === '>') depth--;
  }

  const errorPart = typeStr.slice(startIdx, endIdx);
  const args = extractGenericArgs(errorPart);

  if (args.length < 2) {
    return null;
  }

  const [component, missing] = args;
  const missingDeps = parseUnionType(missing);

  return {
    component,
    componentName: formatTokenName(component),
    missingDeps,
    missingDepNames: missingDeps.map(formatTokenName),
  };
}

/**
 * Format a parsed DI error into a human-readable message.
 * Includes the DI error code prefix.
 */
export function formatDIError(parsed: ParsedDIError, code: DIErrorCode = DIErrorCode.MissingDependencies): string {
  const codePrefix = formatDIErrorCode(code);
  const lines: string[] = [];

  lines.push(`${codePrefix}: Missing dependencies for ${parsed.componentName}:`);
  lines.push('');

  for (const depName of parsed.missingDepNames) {
    lines.push(`  - ${depName}`);
  }

  lines.push('');
  lines.push('Hint: Add the missing dependencies before this component using .add()');
  lines.push('      For repositories, use ModelRepository.of(Model).bind(StorageModel)');

  return lines.join('\n');
}

/**
 * Check if a diagnostic is a DI-related type error.
 * Uses the branded markers (__brand, _missing, _hint) for reliable detection.
 */
export function isDITypeDiagnostic(diagnostic: ts.Diagnostic): boolean {
  const messageText = getDiagnosticMessageText(diagnostic);
  return (
    // Check for branded markers first (most reliable)
    hasDIErrorMarkers(messageText) ||
    // Fallback patterns for edge cases
    messageText.includes('RequiresSatisfied') ||
    (messageText.includes('is not assignable') && messageText.includes('FeatureToken'))
  );
}

/**
 * Get the full message text from a diagnostic.
 */
function getDiagnosticMessageText(diagnostic: ts.Diagnostic): string {
  if (typeof diagnostic.messageText === 'string') {
    return diagnostic.messageText;
  }
  // DiagnosticMessageChain - flatten it
  return flattenDiagnosticMessageChain(diagnostic.messageText);
}

/**
 * Flatten a diagnostic message chain into a single string.
 */
function flattenDiagnosticMessageChain(chain: ts.DiagnosticMessageChain): string {
  let result = chain.messageText;
  if (chain.next) {
    for (const next of chain.next) {
      result += '\n' + flattenDiagnosticMessageChain(next);
    }
  }
  return result;
}

/**
 * Try to rewrite a diagnostic with better DI error formatting.
 * Returns null if the diagnostic shouldn't be rewritten.
 */
export function rewriteDIDiagnostic(diagnostic: ts.Diagnostic): ts.Diagnostic | null {
  if (!isDITypeDiagnostic(diagnostic)) {
    return null;
  }

  const messageText = getDiagnosticMessageText(diagnostic);
  const parsed = parseMissingDepsError(messageText);

  if (!parsed) {
    return null;
  }

  const errorCode = DIErrorCode.MissingDependencies;
  const newMessage = formatDIError(parsed, errorCode);

  return {
    ...diagnostic,
    messageText: newMessage,
    code: DI_CODE_OFFSET + errorCode,
    source: 'justscale-di',
  };
}

/**
 * Create a DI diagnostic from scratch.
 */
export function createDIDiagnostic(
  code: DIErrorCode,
  file: ts.SourceFile | undefined,
  start: number,
  length: number,
  message: string
): ts.Diagnostic {
  return {
    file,
    start,
    length,
    messageText: `${formatDIErrorCode(code)}: ${message}`,
    category: ts.DiagnosticCategory.Error,
    code: DI_CODE_OFFSET + code,
    source: 'justscale-di',
  };
}

/**
 * Process diagnostics and rewrite DI errors with better messages.
 */
export function processDIDiagnostics(diagnostics: readonly ts.Diagnostic[]): ts.Diagnostic[] {
  return diagnostics.map((diag) => {
    const rewritten = rewriteDIDiagnostic(diag);
    return rewritten ?? diag;
  });
}
