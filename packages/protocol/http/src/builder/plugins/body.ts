import { type BuilderPlugin, createPlugin } from '@justscale/core';
import { z } from 'zod';
import { ValidationErrorSchema } from '@justscale/core';

export { ValidationErrorSchema };

/**
 * Validates rawBody against schema and adds `body` to context. Responds 400 on failure.
 *
 * @example
 * ```typescript
 * Post('/users')
 *   .apply(body(z.object({ name: z.string() })))
 *   .handle(({ body }) => { ... })
 * ```
 */
export function body<TSchema extends z.ZodType>(
  schema: TSchema,
): BuilderPlugin<
  { rawBody: unknown; res: any },
  { rawBody: unknown; res: any } & { body: z.infer<TSchema> },
  never,
  never,
  {},
  {},
  any,
  unknown,
  z.infer<TSchema>
> {
  type TInput = { rawBody: unknown; res: any };
  type TOutput = TInput & { body: z.infer<TSchema> };

  return createPlugin<{}, TInput, TOutput, never, never>({
    // No DI deps needed
    build: () => (builder) =>
      builder
        .returns(400, ValidationErrorSchema)
        .guard((ctx) => {
          const result = schema.safeParse(ctx.rawBody);
          if (!result.success) {
            ctx.res.status(400).json({
              errors: result.error.flatten().fieldErrors,
            });
            return ctx.stop();
          }
          ;(ctx as any).__validatedBody = result.data;
        })
        .use((ctx: any) => ({ body: ctx.__validatedBody as z.infer<TSchema> })),
  });
}
