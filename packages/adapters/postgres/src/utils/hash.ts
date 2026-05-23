/**
 * Hash Utility
 *
 * Provides hashing functions for converting lock keys to bigint values
 * suitable for PostgreSQL advisory locks.
 *
 * Uses FNV-1a algorithm for good distribution and low collision rate.
 */

/**
 * FNV-1a hash constants for 64-bit
 */
const FNV_PRIME = 1099511628211n;
const FNV_OFFSET = 14695981039346656037n;

/**
 * Convert a string to a bigint hash using FNV-1a algorithm.
 *
 * FNV-1a provides good distribution and is fast for short strings.
 * The result is a signed 64-bit integer suitable for pg_advisory_lock.
 *
 * @param str The string to hash
 * @returns A bigint hash value
 *
 * @example
 * ```typescript
 * const lockId = hashStringToBigInt('User:123');
 * await sql`SELECT pg_try_advisory_lock(${lockId})`;
 * ```
 */
export function hashStringToBigInt(str: string): bigint {
  let hash = FNV_OFFSET;

  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * FNV_PRIME) & 0xffffffffffffffffn; // Keep as 64-bit
  }

  // Convert to signed 64-bit for PostgreSQL (advisory locks use int8)
  // PostgreSQL int8 range: -9223372036854775808 to 9223372036854775807
  if (hash > 9223372036854775807n) {
    hash = hash - 18446744073709551616n;
  }

  return hash;
}

/**
 * Create a lock key from model name and ID.
 *
 * @param modelName The model/entity name (e.g., 'User', 'Order')
 * @param id The entity ID
 * @returns A formatted lock key string
 *
 * @example
 * ```typescript
 * const key = createLockKey('User', '123');  // 'User:123'
 * const lockId = hashStringToBigInt(key);
 * ```
 */
export function createLockKey(modelName: string, id: string | number): string {
  return `${modelName}:${id}`;
}

/**
 * Hash a lock key directly to bigint.
 *
 * Convenience function combining createLockKey and hashStringToBigInt.
 *
 * @param modelName The model/entity name
 * @param id The entity ID
 * @returns A bigint hash suitable for advisory locks
 */
export function hashLockKey(modelName: string, id: string | number): bigint {
  return hashStringToBigInt(createLockKey(modelName, id));
}
