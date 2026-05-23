/**
 * Convert a camelCase identifier to snake_case.
 *
 * Postgres normalizes unquoted identifiers to lowercase, so `createdAt`
 * becomes `createdat` in the catalog. Passing names through this helper
 * before emitting DDL keeps column names aligned with the snake_case
 * names the query compiler uses at read/write time.
 */
export function toSnakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
