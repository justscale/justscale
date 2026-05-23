/**
 * Contribution pattern - multi-implementation tokens.
 *
 * `defineContribution<T>` creates an abstract DI token that accepts multiple
 * implementations. The framework provides a default aggregator that collects
 * contributions via `register(t: T)` and exposes the aggregated interface
 * defined by the `aggregate` function.
 *
 * `createContribution(Token, { inject, factory })` creates a self-registering
 * contribution service. When added to the app, it injects the default
 * aggregator, calls its `register()` method with the factory output, and
 * returns the impl.
 *
 * @example
 * ```typescript
 * // 1. Declare the multi-impl token
 * abstract class AbstractPrincipalProvider extends defineContribution<PrincipalProvider>(
 *   'AbstractPrincipalProvider',
 *   {
 *     aggregate: (contribs) => ({
 *       async resolve(ctx) {
 *         const lists = await Promise.all(contribs.map((c) => c.resolve(ctx)));
 *         return lists.flat();
 *       },
 *     }),
 *   },
 * ) {}
 *
 * // 2. Create independent contributions
 * export const AuthResolver = createContribution(AbstractPrincipalProvider, {
 *   inject: { users: UserRepository },
 *   factory: ({ users }) => ({
 *     async resolve(ctx) { / * ... * / return []; },
 *   }),
 * });
 *
 * // 3. Add them to the app - default aggregator is auto-registered
 * JustScale()
 *   .add(AuthResolver)
 *   .add(DomainResolver)
 *   .build();
 * ```
 */

import {
  type AbstractClass,
  type ServiceDef,
  type ServiceFactory,
  type ServiceToken,
  type ResolvedDeps,
  defineService,
  defineAbstract,
} from './service.js';

// ============================================================================
// Symbols - runtime markers for the builder + container
// ============================================================================

/** Marks an abstract class as a contribution token (vs a single-impl abstract). */
export const CONTRIBUTION_MARKER = Symbol('justscale:contributionMarker');

/**
 * On a contribution-marked abstract class, holds the default aggregating
 * service def. The builder registers this once when it sees any contribution
 * referencing the token (see `justscale.ts` processComponent).
 */
export const CONTRIBUTION_DEFAULT = Symbol('justscale:contributionDefault');

/**
 * On a service def created via `createContribution()`, points to the parent
 * contribution token. The builder uses this to auto-register the default
 * aggregator.
 */
export const CONTRIBUTES_TO = Symbol('justscale:contributesTo');

// ============================================================================
// Types
// ============================================================================

/**
 * @internal Registry interface the default aggregator implements.
 * Never exposed on the public abstract token's type.
 */
interface ContributionRegistry<T> {
  register(contribution: T): void;
}

/**
 * A contribution-kind abstract class. Same as `AbstractClass<T>` plus a
 * brand symbol so `createContribution()` can type-check its argument.
 */
export type ContributionAbstractClass<T> = AbstractClass<T> & {
  readonly [CONTRIBUTION_MARKER]: true;
};

// ============================================================================
// defineContribution
// ============================================================================

/**
 * Define an abstract DI token that accepts multiple contributions.
 *
 * Returns an abstract class you extend with `abstract class X extends ...`
 * (same shape as `defineAbstract`). The difference:
 * - `defineAbstract` is a SINGLE-impl token - bind one via `bindService`.
 * - `defineContribution` is a MULTI-impl token - add contributions via
 *   `createContribution(X, { ... })`. The framework auto-wires a default
 *   aggregator that calls the `aggregate` function with all registered
 *   contributions.
 *
 * @param name Human-readable name for debugging and error messages.
 * @param opts `aggregate` - builds the aggregated interface from the list
 *   of registered contributions. Called lazily (every time the aggregated
 *   interface is used, OR cached - see note below).
 *
 * @example
 * ```typescript
 * abstract class AbstractPrincipalProvider extends defineContribution<PrincipalProvider>(
 *   'AbstractPrincipalProvider',
 *   {
 *     aggregate: (contribs) => ({
 *       async resolve(ctx) {
 *         const lists = await Promise.all(contribs.map((c) => c.resolve(ctx)));
 *         return lists.flat();
 *       },
 *     }),
 *   },
 * ) {}
 * ```
 */
export function defineContribution<T>(
  name: string,
  opts: { aggregate: (contributions: readonly T[]) => T },
): ContributionAbstractClass<T> {
  const abstractToken = defineAbstract<T>(name);

  // The default aggregator: exposes BOTH the aggregated T interface AND register().
  // Only T is reachable via the abstract token; register() is found via runtime cast.
  const defaultService = defineService({
    inject: {} as Record<string, ServiceToken>,
    factory: () => {
      const contributions: T[] = [];
      const aggregated = opts.aggregate(contributions);
      return Object.assign(aggregated as object, {
        register(contribution: T) {
          contributions.push(contribution);
        },
      }) as T & ContributionRegistry<T>;
    },
    provides: [abstractToken as unknown as ServiceToken],
  });

  // Stamp metadata on the abstract token
  Object.defineProperty(abstractToken, CONTRIBUTION_MARKER, {
    value: true,
    enumerable: false,
    configurable: false,
  });
  Object.defineProperty(abstractToken, CONTRIBUTION_DEFAULT, {
    value: defaultService,
    enumerable: false,
    configurable: false,
  });

  return abstractToken as unknown as ContributionAbstractClass<T>;
}

/**
 * Type guard: is this a contribution-kind abstract class?
 */
export function isContributionToken(value: unknown): value is ContributionAbstractClass<unknown> {
  return (
    (typeof value === 'function' || typeof value === 'object') &&
    value !== null &&
    (value as { [CONTRIBUTION_MARKER]?: true })[CONTRIBUTION_MARKER] === true
  );
}

/**
 * Retrieve the default aggregating service for a contribution token.
 * Used by the builder to auto-register the default once.
 */
export function getContributionDefault<T>(
  token: ContributionAbstractClass<T>,
): ServiceDef<T & ContributionRegistry<T>, {}> {
  return (token as unknown as { [CONTRIBUTION_DEFAULT]: ServiceDef<T & ContributionRegistry<T>, {}> })[
    CONTRIBUTION_DEFAULT
  ];
}

// ============================================================================
// createContribution
// ============================================================================

/**
 * Create a self-registering contribution to a multi-impl token.
 *
 * Returns a `ServiceDef` that, when resolved, injects the contribution token
 * (resolving to the default aggregator), calls the user's `factory` to build
 * the contribution, registers it with the aggregator via `.register()`, and
 * returns the contribution.
 *
 * @example
 * ```typescript
 * export const AuthResolver = createContribution(AbstractPrincipalProvider, {
 *   inject: { users: UserRepository },
 *   factory: ({ users }) => ({
 *     async resolve(ctx) {
 *       if (!ctx.user) return [];
 *       return [{ type: User, ref: User.ref(ctx.user) }];
 *     },
 *   }),
 * });
 * ```
 */
export function createContribution<
  T,
  const TDeps extends Record<string, ServiceToken>,
>(
  token: ContributionAbstractClass<T>,
  config: {
    inject: TDeps;
    factory: ServiceFactory<ResolvedDeps<TDeps>, T>;
  },
): ServiceDef<T, TDeps> {
  if (!isContributionToken(token)) {
    throw new TypeError(
      'createContribution() requires a defineContribution token. ' +
        'For single-impl abstracts created with defineAbstract, use bindService() instead.',
    );
  }

  // Wraps the user's factory: injects the parent aggregator, calls factory,
  // registers the result, and returns the contribution for individual resolution.
  const parentKey = '__contributionParent' as const;
  const mergedDeps: Record<string, ServiceToken> = {
    ...config.inject,
    [parentKey]: token as unknown as ServiceToken<T>,
  };

  const wrappedFactory = (async (
    deps: Record<string, unknown>,
    resolve: unknown,
  ): Promise<T> => {
    // Split parent out; rest are user's injects
    const parent = deps[parentKey] as T & ContributionRegistry<T>;
    const { [parentKey]: _ignored, ...userDeps } = deps;
    // Call user's factory - may be sync or async
    const contribution = await config.factory(
      userDeps as ResolvedDeps<TDeps>,
      resolve as Parameters<typeof config.factory>[1],
    );
    parent.register(contribution);
    return contribution;
  }) as unknown as ServiceFactory<
    ResolvedDeps<TDeps & { readonly __contributionParent: ContributionAbstractClass<T> }>,
    T
  >;

  const serviceDef = defineService({
    inject: mergedDeps as TDeps & { readonly __contributionParent: typeof token },
    factory: wrappedFactory,
  }) as unknown as ServiceDef<T, TDeps>;

  // Attach the parent reference so the builder can auto-register the default aggregator
  Object.defineProperty(serviceDef, CONTRIBUTES_TO, {
    value: token,
    enumerable: false,
    configurable: false,
  });

  return serviceDef;
}

/**
 * Type guard: is this service def a contribution?
 */
export function isContribution(value: unknown): value is ServiceDef<unknown, any> & {
  [CONTRIBUTES_TO]: ContributionAbstractClass<unknown>;
} {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    CONTRIBUTES_TO in value &&
    (value as { [CONTRIBUTES_TO]?: unknown })[CONTRIBUTES_TO] !== undefined
  );
}

/**
 * Get the contribution parent token from a contribution service def.
 */
export function getContributionParent<T>(
  def: ServiceDef<T, any>,
): ContributionAbstractClass<T> | undefined {
  return (def as unknown as { [CONTRIBUTES_TO]?: ContributionAbstractClass<T> })[CONTRIBUTES_TO];
}
