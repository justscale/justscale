import type { Prettify } from '@justscale/core/plugin';
import type { Ref, Persistent, Lock } from '@justscale/core/models';
import type { PermEntries, NameOf, PermOf, BodyOf, ExtractBodyForStatus } from '@justscale/core';

export type ResponseMap = Record<number, unknown>;

export type ResponseForStatus<
  TResponses extends ResponseMap,
  S extends number,
> = S extends keyof TResponses ? TResponses[S] : unknown;

/**
 * Accepts either the raw schema type OR a Persistent/Lock entity when the
 * schema has `id: z.ref(Model)`. The `id` field is a self-reference - the
 * entity IS the thing, so the framework derives the id during serialization.
 * Also handles arrays: `z.array(TicketSchema)` accepts `Persistent<Ticket>[]`.
 * Recurses into object properties so wrapper shapes like `{ user: Entity }` work.
 */
export type JsonInput<T> = T extends readonly (infer E)[]
  ? JsonInput<E>[]
  : T extends { id: Ref<infer M> }
    ? Persistent<M> | Lock<Persistent<M>>
    : T extends object
      ? { [K in keyof T]: JsonInput<T[K]> }
      : T;

export interface TypedJsonResponse<TResponses extends ResponseMap> {
  json(
    data: JsonInput<TResponses extends { 200: infer T }
      ? T
      : TResponses[keyof TResponses]>,
  ): void
  error(message: string, status?: number): void
  status<S extends number>(
    code: S,
  ): S extends keyof TResponses
    ? TypedStatusedResponse<TResponses[S]>
    : TypedStatusedResponse<unknown>
}

export type TypedStatusedResponse<T> = T extends void
  ? { end(): void }
  : { json(data: JsonInput<T>): void };

export interface HttpContext<
  TResponses extends ResponseMap = { 200: unknown },
> {
  body: unknown
  query: Record<string, string>
  headers: Record<string, string>
  res: TypedJsonResponse<TResponses>
}

export type ReplaceRes<TContext, TResponses extends ResponseMap> = Prettify<
  Omit<TContext, 'res'> & { res: TypedJsonResponse<TResponses> }
>;

// ============================================================================
// Permission-scoped res (discriminated union narrowing)
// ============================================================================

/**
 * A single permission variant of `res` - only accepts the body schema declared
 * with this permission. Also supports `res.status()` for unpermissioned responses.
 */
export type PermissionResVariant<E, TAllReturns> = {
  readonly permission: NameOf<PermOf<E>>
  json(data: JsonInput<BodyOf<E>>): void
  error(message: string, status?: number): void
  status<S extends number>(
    code: S,
  ): S extends ExtractStatusesOf<TAllReturns>
    ? TypedStatusedResponse<ExtractBodyForStatus<TAllReturns, S>>
    : TypedStatusedResponse<unknown>
};

type ExtractStatusesOf<T> = T extends { status: infer S } ? S : never;

export type DistributePermissionVariants<R> =
  PermEntries<R> extends infer E
    ? E extends any
      ? PermissionResVariant<E, R>
      : never
    : never;

export type HasPermissionReturns<R> =
  [PermEntries<R>] extends [never] ? false : true;

/**
 * Compute the final res type for a handler:
 * - If permission-scoped returns exist -> discriminated union on `.permission`
 * - Otherwise -> status-indexed `TypedJsonResponse`
 */
export type ResponseFor<TReturns> =
  HasPermissionReturns<TReturns> extends true
    ? DistributePermissionVariants<TReturns>
    : TypedJsonResponse<BuildResponseMap<TReturns>>;

type BuildResponseMap<TReturns> = [TReturns] extends [never]
  ? Record<number, unknown>
  : UnionToIntersection<ReturnsToResponseMap<TReturns>> extends infer M
    ? { [K in keyof M]: M[K] }
    : Record<number, unknown>;

type ReturnsToResponseMap<T> = T extends { status: infer S extends number; body: infer B }
  ? { [K in S]: B }
  : {};

type UnionToIntersection<U> =
  (U extends any ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

export type ReplaceResPermissionAware<TContext, TReturns> = Prettify<
  Omit<TContext, 'res'> & { res: ResponseFor<TReturns> }
>;

export type AddResponse<
  TResponses extends ResponseMap,
  TStatus extends number,
  TType,
> = TResponses & { [K in TStatus]: TType };

export type HttpRouteContext<
  _TDeps = Record<string, unknown>,
  TParams = Record<string, string>,
> = Prettify<HttpContext & { params: TParams }>;

export type HttpRouteHandler<
  TDeps = Record<string, unknown>,
  TParams = Record<string, string>,
> = (ctx: HttpRouteContext<TDeps, TParams>) => void | Promise<void>;

declare module '@justscale/core' {
  interface ControllerSettings {
    prefix?: string
  }

  interface TransportContext {
    params: Record<string, string>
    body: unknown
    query: Record<string, string>
    headers: Record<string, string>
    res: TypedJsonResponse<ResponseMap>
  }

  interface SupportedMethods {
    GET: { transport: 'http'; hasBody: false; idempotent: true }
    POST: { transport: 'http'; hasBody: true; idempotent: false }
    PUT: { transport: 'http'; hasBody: true; idempotent: true }
    DELETE: { transport: 'http'; hasBody: false; idempotent: true }
    PATCH: { transport: 'http'; hasBody: true; idempotent: false }
  }
}

declare module '@justscale/core/plugin' {
  // Augment RouteContext with HTTP additions
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface RouteContext<TDeps, TParams> extends HttpContext {}
}
