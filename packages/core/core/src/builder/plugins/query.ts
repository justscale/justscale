/**
 * Query Validation Plugin
 *
 * Validates query parameters using Zod schema and exposes validated data to context.
 * Protocol-agnostic — works with any protocol that has `rawQuery` and `res` in context.
 */

import { type BuilderPlugin, createPlugin } from '../plugin.js';
import type { z } from 'zod';
import { ValidationErrorSchema } from './validation.js';

/**
 * Query validation plugin.
 * Validates rawQuery against schema and exposes as { query: T }.
 *
 * @example
 * ```typescript
 * Get('/users')
 *   .apply(query(z.object({ page: z.coerce.number(), limit: z.coerce.number() })))
 *   .handle(({ query }) => {
 *     // query is typed as { page: number, limit: number }
 *   })
 * ```
 */
export function query<TSchema extends z.ZodType>(
  schema: TSchema,
): BuilderPlugin<
  { rawQuery: Record<string, string>; res: any },
  { rawQuery: Record<string, string>; res: any } & { query: z.infer<TSchema> },
  never,
  never,
  {},
  {},
  any
> {
  type TInput = { rawQuery: Record<string, string>; res: any };
  type TOutput = TInput & { query: z.infer<TSchema> };

  return createPlugin<{}, TInput, TOutput, never, never>({
    build: () => (builder) =>
      builder
        .returns(400, ValidationErrorSchema)
        .guard((ctx) => {
          const result = schema.safeParse(ctx.rawQuery);
          if (!result.success) {
            ctx.res.status(400).json({
              errors: result.error.flatten().fieldErrors,
            });
            return ctx.stop();
          }
          ;(ctx as any).__validatedQuery = result.data;
        })
        .use((ctx: any) => ({
          query: ctx.__validatedQuery as z.infer<TSchema>,
        })),
  });
}
