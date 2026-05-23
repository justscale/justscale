import { z } from 'zod';

export interface PaginationOptions {
  /** Maximum allowed limit (default: 100) */
  maxLimit?: number;
  /** Default limit when not specified (default: 20) */
  defaultLimit?: number;
}

/**
 * Limit/offset pagination schema for `.query()`.
 *
 * @example
 * ```typescript
 * Get('/tickets').query(pagination()).handle(({ query }) => {
 *   // query.limit: number (default 20, max 100), query.offset: number
 * })
 * ```
 */
export function pagination(opts?: PaginationOptions) {
  const maxLimit = opts?.maxLimit ?? 100;
  const defaultLimit = opts?.defaultLimit ?? 20;
  return z.object({
    limit: z.coerce.number().int().min(1).max(maxLimit).default(defaultLimit),
    offset: z.coerce.number().int().min(0).default(0),
  });
}
