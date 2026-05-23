/**
 * CLI Utilities
 *
 * Helper functions for CLI commands.
 */

/**
 * Get nested value from object by dot-separated path
 */
export function getPath(obj: any, path: string): unknown {
  const keys = path.split('.');
  let current = obj;
  for (const key of keys) {
    if (current === undefined || current === null) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Format value for display (mask secrets)
 */
export function formatValue(value: unknown, isSecret = false): string {
  if (isSecret) return '[secret] ••••••••';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}
