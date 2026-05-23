import type { Lock, LockService } from '@justscale/core';
import type {
  ModelRepository,
  Persistent,
  Reference,
} from '@justscale/core/models';
import type { z } from 'zod';

/** Options for the populate middleware */
export interface PopulatorOptions<TId = string> {
  /** Transform the route param string to the ID type */
  transform?: (id: string) => TId
  /** Custom error factory when entity not found */
  notFoundError?: (id: TId) => Error
}

/** Shared with @justscale/feature-openapi - must stay Symbol.for */
export const BODY_SCHEMA = Symbol.for('justscale:bodySchema');

/** Shared with @justscale/feature-openapi - must stay Symbol.for */
export const QUERY_SCHEMA = Symbol.for('justscale:querySchema');

export const RESPONSE_SCHEMA = Symbol('justscale:responseSchema');

export const RESPONSE_SCHEMAS = Symbol('justscale:responseSchemas');

export const MIDDLEWARE_RESPONSES = Symbol('justscale:middlewareResponses');

/** Middleware function with attached schema metadata */
export interface SchemaMiddleware {
  [BODY_SCHEMA]?: z.ZodType
  [QUERY_SCHEMA]?: z.ZodType
  [MIDDLEWARE_RESPONSES]?: Record<number, z.ZodType | null>
}

/**
 * Middleware that declares response types it can produce.
 * The TResponses type parameter carries compile-time type info.
 */
export interface MiddlewareWithResponses<
  TContext,
  TAdded extends Record<string, unknown>,
  TResponses extends Record<number, unknown> = {},
> {
  (ctx: TContext): Promise<TAdded> | TAdded
  /** Phantom property to carry response types - not actually accessed at runtime */
  readonly responses?: TResponses
}

/** Extract response types from a middleware, or empty object if none */
export type ExtractMiddlewareResponses<T> = T extends MiddlewareWithResponses<
  any,
  any,
  infer R
>
  ? R
  : {};

/**
 * Helper type to extract entity type from a repository.
 */
type EntityFromRepo<TRepo> = TRepo extends ModelRepository<infer T> ? T : never;

/**
 * Create a populator middleware that fetches an entity by route param.
 * Similar to Laravel's route model binding.
 *
 * Pass the repository and a reference creator (Model.ref) directly from the routes function closure.
 *
 * @example
 * ```typescript
 * createController('/players', {
 *   inject: { players: PlayerRepository },
 *   routes: ({ Get, players }) => ({
 *     getOne: Get('/:playerId')
 *       .use(populate(players, 'player', 'playerId', Player.ref))
 *       .handle(({ player, res }) => {
 *         // player is Persistent<Player>, properly typed!
 *         res.json({ player });
 *       }),
 *   }),
 * });
 * ```
 */
export function populate<
  TRepo extends ModelRepository<any>,
  TContextKey extends string,
>(
  repo: TRepo,
  contextKey: TContextKey,
  paramName: string,
  toRef: (id: string) => Reference<EntityFromRepo<TRepo>>,
  options?: PopulatorOptions,
): (ctx: {
  params: Record<string, string>
  res: { error: (msg: string, status?: number) => void }
}) => Promise<{ [K in TContextKey]: Persistent<EntityFromRepo<TRepo>> }> {
  const notFoundError =
    options?.notFoundError ??
    ((_id: string) => new Error(`${contextKey} not found`));

  const middleware = async (ctx: {
    params: Record<string, string>
    res: { error: (msg: string, status?: number) => void }
  }) => {
    const paramValue = ctx.params[paramName];
    if (paramValue === undefined) {
      ctx.res.error(`Route parameter "${paramName}" not found`, 400);
      throw new Error(`Missing param: ${paramName}`);
    }

    const ref = toRef(paramValue);
    const entity = await repo.get(ref);

    if (!entity) {
      const err = notFoundError(paramValue);
      ctx.res.error(err.message, 404);
      throw err;
    }

    return { [contextKey]: entity } as {
      [K in TContextKey]: Persistent<EntityFromRepo<TRepo>>
    };
  }

  // Attach 404 response for OpenAPI - populate can return 404 when entity not found
  ;(middleware as SchemaMiddleware)[MIDDLEWARE_RESPONSES] = { 404: null };

  return middleware;
}

/**
 * Create a middleware that acquires a lock on an entity already in context.
 * Use after `populate()` to get exclusive access for modifications.
 * The lock is automatically released when the request completes (via onCleanup).
 *
 * @example
 * ```typescript
 * createController('/players', {
 *   inject: { players: PlayerRepository, locks: LockService },
 *   routes: ({ Put, players, locks }) => ({
 *     update: Put('/:playerId')
 *       .use(populate(players, 'player', 'playerId'))
 *       .use(lock('player', locks))
 *       .body(UpdatePlayerSchema)
 *       .handle(async ({ player, body, res }) => {
 *         // player is Lock<Persistent<Player>> - exclusive access!
 *         player.name = body.name;
 *         await players.save(player);
 *         res.json({ player });
 *         // Lock auto-released when request ends
 *       }),
 *   }),
 * });
 * ```
 */
export function lock<TContextKey extends string, T>(
  contextKey: TContextKey,
  lockService: LockService<T>,
): <
  TCtx extends Record<TContextKey, T> & {
    onCleanup: (fn: () => void | Promise<void>) => void
  },
>(
  ctx: TCtx,
) => Promise<{ [K in TContextKey]: Lock<T> }> {
  return async (ctx) => {
    const entity = ctx[contextKey];

    const locked = await lockService.acquire(entity);

    if (!locked) {
      throw new Error(`Failed to acquire lock on ${contextKey}`);
    }

    ctx.onCleanup(() => locked[Symbol.dispose]());

    return { [contextKey]: locked } as { [K in TContextKey]: Lock<T> };
  };
}

