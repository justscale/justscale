/**
 * Shared validation schemas for builder plugins.
 */

import { z } from 'zod';

/**
 * Schema for validation error responses (400).
 * Used by body and query validation plugins.
 */
export const ValidationErrorSchema = z.object({
  errors: z.record(z.string(), z.array(z.string())),
});
