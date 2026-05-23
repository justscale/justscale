/**
 * Core type definitions for the fluent builder API.
 */

import type { ServiceDef, Service, ServiceToken as CoreServiceToken } from '../core/service.js';
import { SERVICE_PROVIDES } from '../core/service.js';
import type { App } from '../app.js';
import type { ControllerDef } from '../core/controller.js';
import type { RepositoryToken, Repository } from '../models/repository.js';
import type { GuardDef, MiddlewareDef } from '../core/middleware.js';
import type { Stop } from './stop.js';
import type { TypedParams } from '../models/apply-types-config.js';
import type { ConfigComponent, ConfigPartial } from '../features/config/types.js';
import type { ConfigToken } from '../features/config/config-of.js';
import type { SecretComponent, SecretPartial } from '../features/secrets/types.js';
import type { SecretToken } from '../features/secrets/secret-of.js';
import type { FeatureFlagComponent, FeatureFlagPartial } from '../features/feature-flags/types.js';
import type { FeatureFlagToken } from '../features/feature-flags/feature-flag-of.js';
import type { Environment } from '../features/environment/types.js';
// ============================================================================
// Token Types
// ============================================================================

/**
 * Brand for type-level token identification.
 * Ensures Token<A> is not assignable to Token<B>.
 */
declare const TOKEN_BRAND: unique symbol;

/**
 * A typed token for dependency injection.
 *
 * Tokens identify what a component provides or requires.
 * They can be:
 * - ServiceDef (created via defineService)
 * - RepositoryToken (created via Repository.of or ModelRepository.of)
 * - Class/AbstractClass
 * - FeatureToken (created via createFeature)
 */
export type Token<T = unknown> = {
  readonly [TOKEN_BRAND]?: T
  readonly description?: string
};

/**
 * Union of all valid token types in the system.
 */
export type AnyToken =
  | CoreServiceToken
  | RepositoryToken<any>
  | FeatureToken<any, any>;

// ============================================================================
// Feature Types
// ============================================================================

/** Symbol to identify feature tokens */
export const FEATURE_TOKEN = Symbol('core:featureToken');

/** Symbol for feature metadata */
export const FEATURE_META = Symbol('core:featureMeta');

/**
 * Metadata stored on a feature.
 */
export interface FeatureMetadata {
  readonly name?: string
  readonly requires: AnyToken[]
  readonly onStart?: StartHook
  readonly onStop?: StopHook
}

/**
 * Lifecycle hook called when cluster starts.
 */
export type StartHook = (ctx: { resolve: <T>(token: Token<T>) => T }) => Promise<void> | void;

/**
 * Lifecycle hook called when cluster stops.
 */
export type StopHook = () => Promise<void> | void;

export interface FeatureToken<
  TRequires extends AnyToken[] = [],
  TProvides extends AnyToken[] = []
> {
  (builder: Builder<TRequires>): Builder<[...TRequires, ...TProvides]>
  readonly [FEATURE_TOKEN]: true
  readonly [FEATURE_META]: FeatureMetadata
}

// ============================================================================
// Component Types
// ============================================================================

/** Symbol to identify repository bindings */
export const REPO_BINDING = Symbol('core:repoBinding');

/**
 * A binding from a RepositoryToken to its implementation.
 */
export interface RepositoryBinding<T = unknown> {
  readonly [REPO_BINDING]: true
  readonly token: RepositoryToken<T>
  readonly implementation: unknown // StorageModel or ServiceDef
}

/** Symbol to identify service bindings */
export const SERVICE_BINDING = Symbol('core:serviceBinding');

/**
 * A binding from an abstract service token to its implementation.
 * Used to bind abstract classes to concrete implementations.
 *
 * @example
 * ```typescript
 * bindService(AbstractChannelBackend, MemoryChannelBackend)
 * ```
 */
export interface ServiceBinding<T = unknown> {
  readonly [SERVICE_BINDING]: true
  readonly token: CoreServiceToken<T>
  readonly implementation: CoreServiceToken<T>
}

/** Symbol to identify instance bindings */
export const INSTANCE_BINDING = Symbol('core:instanceBinding');

/**
 * A binding from an abstract service token to a concrete instance.
 * Used to bind abstract classes to pre-created instances.
 *
 * @example
 * ```typescript
 * const taskRepo = new InMemoryScheduledTaskRepository()
 * bindInstance(ScheduledTaskRepository, taskRepo)
 * ```
 */
export interface InstanceBinding<T = unknown> {
  readonly [INSTANCE_BINDING]: true
  readonly token: CoreServiceToken<T>
  readonly instance: T
}

/**
 * Check if value is an InstanceBinding.
 */
export function isInstanceBinding(value: unknown): value is InstanceBinding<any> {
  return (
    typeof value === 'object' &&
    value !== null &&
    INSTANCE_BINDING in value &&
    (value as any)[INSTANCE_BINDING] === true
  );
}

/**
 * A callback that extends the builder.
 * Can declare requirements via its type signature.
 */
export type BuilderCallback<
  TRequires extends AnyToken[] = AnyToken[],
  TProvides extends AnyToken[] = AnyToken[]
> = (builder: Builder<TRequires>) => Builder<[...TRequires, ...TProvides]>;

/**
 * All component types that can be added to a builder.
 */
export type Component =
  | ServiceDef<any, any>           // defineService result (object form)
  | Service<any, any>              // defineService result (class extends)
  | ControllerDef<any>             // createController result
  | RepositoryBinding<any>         // ModelRepository.of(X).bind(Y)
  | ServiceBinding<any>            // bindService(Abstract, Impl)
  | InstanceBinding<any>           // bindInstance(Abstract, instance)
  | FeatureToken<any, any>         // createFeature result
  | BuilderCallback<any, any>      // Inline callback
  | ConfigComponent                 // createConfig result
  | SecretComponent                 // createSecretProvider result
  | FeatureFlagComponent            // createFeatureFlagProvider result
  | Environment                     // createEnvironment result
  | import('../justscale.js').BuiltApp<any, any>  // Sub-app (.build() result)
  | Component[];                    // Array of components

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if value is a ServiceDef.
 * Handles both defineService object-form and class-extends-function forms.
 */
export function isServiceDef(value: unknown): value is ServiceDef<any, any> {
  // defineService (object form) returns an object with deps and factory
  if (typeof value === 'object' && value !== null) {
    return 'deps' in value && 'factory' in value;
  }
  // defineService returns a function with deps and factory as static properties
  if (typeof value === 'function') {
    return 'deps' in value && 'factory' in value;
  }
  return false;
}

/**
 * Check if value is a ControllerDef.
 */
export function isControllerDef(value: unknown): value is ControllerDef<any> {
  // Controllers have settings (from createController) and factory (from ServiceDef)
  // They also have prefix for backwards compat
  return (
    typeof value === 'object' &&
    value !== null &&
    'settings' in value &&
    'factory' in value &&
    'prefix' in value
  );
}

/**
 * Check if value is a RepositoryBinding.
 */
export function isRepositoryBinding(value: unknown): value is RepositoryBinding<any> {
  return (
    typeof value === 'object' &&
    value !== null &&
    REPO_BINDING in value &&
    (value as any)[REPO_BINDING] === true
  );
}

/**
 * Check if value is a ServiceBinding.
 */
export function isServiceBinding(value: unknown): value is ServiceBinding<any> {
  return (
    typeof value === 'object' &&
    value !== null &&
    SERVICE_BINDING in value &&
    (value as any)[SERVICE_BINDING] === true
  );
}

/**
 * Check if value is a FeatureToken.
 */
export function isFeatureToken(value: unknown): value is FeatureToken<any, any> {
  return (
    typeof value === 'function' &&
    FEATURE_TOKEN in value &&
    (value as any)[FEATURE_TOKEN] === true
  );
}

/**
 * Check if value is a BuilderCallback (function but not feature).
 */
export function isBuilderCallback(value: unknown): value is BuilderCallback<any, any> {
  return typeof value === 'function' && !isFeatureToken(value);
}

/**
 * Check if value is a component array.
 */
export function isComponentArray(value: unknown): value is Component[] {
  return Array.isArray(value);
}

// ============================================================================
// ProvidesOf - Extract what a component provides
// ============================================================================

type ConstructorOf<T> = T extends InstanceType<infer C> ? C : never;
type IsClassInstance<T> = ConstructorOf<T> extends never ? false : true;

/** Extract SERVICE_PROVIDES tokens from a component. */
type ExtractServiceProvides<C> =
  C extends { [SERVICE_PROVIDES]: infer TProvides extends CoreServiceToken[] }
    ? TProvides
    : [];

/**
 * Extract what tokens a component provides to the builder.
 *
 * For ServiceDefs: provides both the ServiceDef itself AND the class constructor
 * if the instance type is a class instance. This allows services that create
 * AbstractPostgresClient instances to satisfy dependencies on typeof AbstractPostgresClient.
 *
 * For services with `provides` option: also provides the tokens listed in SERVICE_PROVIDES.
 *
 * @example
 * ```typescript
 * ProvidesOf<ServiceDef<AbstractPostgresClient, {...}>>  // [ServiceDef, typeof AbstractPostgresClient]
 * ProvidesOf<RepositoryBinding<User>>                     // [RepositoryToken<User>]
 * ProvidesOf<FeatureToken<[], [A, B]>>                    // [A, B]
 * ProvidesOf<Component[]>                                 // flattened provides
 * ProvidesOf<ServiceWithProvides>                         // [Service, ...provides tokens]
 * ```
 */
export type ProvidesOf<C> =
  // Service definition provides itself, constructor type (if class), AND SERVICE_PROVIDES tokens
  C extends ServiceDef<infer T, any>
    ? IsClassInstance<T> extends true
      ? [C, ConstructorOf<T>, ...ExtractServiceProvides<C>]
      : [C, ...ExtractServiceProvides<C>]
  // Service class (defineService) provides itself AND SERVICE_PROVIDES tokens
    : C extends Service<any, any>
      ? [C, ...ExtractServiceProvides<C>]
    // Repository binding provides the token
      : C extends RepositoryBinding<infer T>
        ? [RepositoryToken<T>]
      // Service binding provides the abstract token
        : C extends ServiceBinding<infer T>
          ? [CoreServiceToken<T>]
        // Instance binding provides the abstract token
          : C extends InstanceBinding<infer T>
            ? [CoreServiceToken<T>]
          // Feature provides its declared provides
            : C extends FeatureToken<any, infer TProvides>
              ? TProvides
            // Callback - extract from return type
              : C extends (b: Builder<any>) => Builder<infer TNew>
                ? TNew extends [...any[], ...infer TProvides]
                  ? TProvides
                  : []
              // Controller provides itself
                : C extends ControllerDef<any>
                  ? [C]
                // Config component provides ConfigTokens for declared partials
                  : C extends ConfigComponent<infer CP>
                    ? ConfigTokensFor<CP>
                  // Secret component provides SecretTokens for declared partials
                    : C extends SecretComponent<infer SP>
                      ? SecretTokensFor<SP>
                    // FeatureFlag component provides FeatureFlagTokens for declared partials
                      : C extends FeatureFlagComponent<infer FP>
                        ? FeatureFlagTokensFor<FP>
                      // Environment expands into inner services + providers - flatten ProvidesOf
                      // across both tuples so only those specific tokens land in TProvided.
                      // Previously returned [AnyToken], which silently satisfied ANY downstream
                      // requirement and disabled compile-time DI checks (e.g. .add(env).add(AuthFeature)
                      // would compile even with Session repo missing).
                        : C extends Environment<infer EnvS, infer EnvP>
                          ? [...FlattenProvidesTuple<EnvS>, ...FlattenProvidesTuple<EnvP>]
                        // Array - flatten provides of all items
                          : C extends readonly (infer Item)[]
                            ? FlattenProvides<Item>
                          // Unknown
                            : [];

type ConfigTokensFor<P> = P extends readonly [infer H, ...infer Rest]
  ? H extends ConfigPartial<infer T>
    ? [ConfigToken<T>, ...ConfigTokensFor<Rest>]
    : ConfigTokensFor<Rest>
  : [];

type SecretTokensFor<P> = P extends readonly [infer H, ...infer Rest]
  ? H extends SecretPartial<infer T>
    ? [SecretToken<T>, ...SecretTokensFor<Rest>]
    : SecretTokensFor<Rest>
  : [];

type FeatureFlagTokensFor<P> = P extends readonly [infer H, ...infer Rest]
  ? H extends FeatureFlagPartial<infer T>
    ? [FeatureFlagToken<T>, ...FeatureFlagTokensFor<Rest>]
    : FeatureFlagTokensFor<Rest>
  : [];

/**
 * Walk a tuple of Components and concat each element's ProvidesOf.
 * Used by `Environment<S, P>` to surface the exact set of tokens an env's
 * inner services and providers supply, so consumers downstream of
 * `.add(env)` get the same compile-time DI check as without the env.
 */
type FlattenProvidesTuple<Items> =
  Items extends readonly [infer Head, ...infer Rest]
    ? [...Extract<ProvidesOf<Head>, readonly unknown[]>, ...FlattenProvidesTuple<Rest>]
    : [];

/**
 * Flatten provides from array items.
 * Uses NonRecursiveComponent to avoid infinite recursion.
 */
type NonRecursiveComponent =
  | ServiceDef<any, any>
  | ControllerDef<any>
  | RepositoryBinding<any>
  | ServiceBinding<any>
  | InstanceBinding<any>
  | FeatureToken<any, any>
  | BuilderCallback<any, any>;

type FlattenProvides<T> = T extends NonRecursiveComponent ? ProvidesOf<T>[number] : never;

// ============================================================================
// RequiresOf - Extract what a component requires
// ============================================================================

/**
 * Extract the dep tokens from a deps record.
 */
type DepsToTokens<TDeps> = TDeps extends Record<string, infer V> ? V : never;

/**
 * Extract transport requirements from a single route definition.
 *
 * A route factory (e.g., `Get()` from @justscale/http) stamps `__transportRequires`
 * on its return type as a brand to declare what the transport needs (typically a
 * Config partial). Routes that don't stamp this (any existing route at the time
 * step 3 lands) yield `never` - RequiresOf is unchanged for them.
 *
 * The field exists at the type level only (no runtime data required for this
 * compile-time check - runtime adapter install happens via build-phase ALS).
 */
type ExtractRouteTransportRequires<R> =
  R extends { readonly __transportRequires: readonly (infer T)[] } ? T : never;

/**
 * Aggregate transport requirements across all routes in a controller's routes shape.
 * Handles both record form (`{ list: Get(...) }`) and array form.
 */
type ControllerTransportRequires<TRoutes> =
  TRoutes extends readonly (infer Route)[]
    ? ExtractRouteTransportRequires<Route>
    : TRoutes extends Record<string, infer Route>
      ? ExtractRouteTransportRequires<Route>
      : never;

/**
 * Extract the inject deps from a MiddlewareDef or GuardDef.
 *
 * Plain middleware/guard functions (not passed through `createMiddleware` /
 * `createGuard`) carry no DI metadata - they yield `never`, matching the
 * behavior of the existing transport-requires stamp. Only DI-aware
 * middleware contributes to the controller's require set.
 */
export type ExtractStepDeps<Step> =
  Step extends MiddlewareDef<any, infer TDeps>
    ? DepsToTokens<TDeps>
    : Step extends GuardDef<infer TDeps>
      ? DepsToTokens<TDeps>
      : Step extends readonly GuardDef<infer TDeps>[]
        ? DepsToTokens<TDeps>
        : never;

/**
 * Extract the "added" context type from a middleware value. Handles:
 *   - plain functions returning an object or Promise<object>
 *   - DI-aware MiddlewareDef (produces a middleware whose return is the added type)
 *
 * Returns `never` for values that don't match either shape - callers
 * compose this with `TContext & ExtractAddedFromMiddleware<TMw>` so
 * `never` neutralises via intersection with whatever context exists.
 */
export type ExtractAddedFromMiddleware<TMw> =
  TMw extends MiddlewareDef<infer TAdded, any>
    ? TAdded
    : TMw extends (...args: any[]) => infer R
      ? R extends Promise<infer A>
        ? A
        : R
      : never;

/**
 * Extract the TRequirements type parameter from a RouteDef.
 *
 * The type parameter accumulates middleware/guard deps as `.use()` and
 * `.guard()` calls are chained on a route builder. Here we pull it off
 * the finalized `RouteDef<TPath, TReturns, TRequirements, TBody>`
 * signature.
 */
type ExtractRouteRequirements<R> =
  R extends RouteDef<any, any, infer TReq, any> ? TReq : never;

/**
 * Aggregate middleware/guard requirements across all routes in a
 * controller's routes shape. Mirror of `ControllerTransportRequires`.
 */
type ControllerRouteRequirements<TRoutes> =
  TRoutes extends readonly (infer Route)[]
    ? ExtractRouteRequirements<Route>
    : TRoutes extends Record<string, infer Route>
      ? ExtractRouteRequirements<Route>
      : never;

/**
 * Extract what tokens a component requires (direct dependencies).
 *
 * For controllers, this includes:
 *   - injected services (from `inject: { ... }`)
 *   - transport requirements from route factories (e.g., `Get()` implying
 *     an HTTP adapter token)
 *   - middleware/guard inject deps attached to routes via `.use()` / `.guard()`
 */
export type RequiresOf<C> =
  // Controller - extract from its TDeps AND from route-level transport requires
  C extends ControllerDef<infer TDeps, infer TRoutes, any>
    ? (
        | DepsToTokens<TDeps>
        | ControllerTransportRequires<TRoutes>
        | ControllerRouteRequirements<TRoutes>
    )[]
  // Service definition requires its deps
    : C extends ServiceDef<any, infer TDeps>
      ? DepsToTokens<TDeps>[]
    // Service class (defineService) requires its deps
      : C extends Service<any, infer TDeps>
        ? DepsToTokens<TDeps>[]
      // Feature requires its declared requirements
        : C extends FeatureToken<infer TRequires, any>
          ? TRequires
        // Callback - extract from parameter type
          : C extends (b: Builder<infer TReq>) => any
            ? TReq
          // Repository bindings, service bindings, arrays
            : [];

/**
 * Recursively extract transitive requirements.
 * If C requires S, and S is a ServiceDef that requires T, then C transitively requires T.
 *
 * For Repository ServiceDefs (where instance extends Repository<any>), we require BOTH
 * the ServiceDef itself AND its transitive deps. This ensures repositories are explicitly registered.
 *
 * For other ServiceDefs (inline services), we only require transitive deps - they're
 * auto-created by the container on demand.
 *
 * For class tokens and other non-ServiceDef requirements, we require them as-is.
 */
export type TransitiveRequiresOf<C> =
  RequiresOf<C> extends (infer Req)[]
    ? Req extends ServiceDef<infer TInstance, infer TDeps>
      ? TInstance extends Repository<any>
        // For repository services: require both the ServiceDef AND transitive deps
        ? Req | DepsToTokens<TDeps>
        // For other ServiceDefs (inline): only require transitive deps
        : DepsToTokens<TDeps>
      // For ProcessDefinition deps: ignore - processes resolve deps through container at runtime
      : Req extends { path: string; deps: Record<string, any> }
        ? never
      // For non-ServiceDef deps (classes, etc.): require them directly
        : Req
    : never;

// ============================================================================
// RequiresSatisfied - Check if requirements are met
// ============================================================================

/**
 * Check if token T is satisfied by token H (either same type or H provides T).
 * Uses wrapper to avoid distribution over unions.
 */
type TokenSatisfies<T, H> =
  [T] extends [H] ? true : [H] extends [T] ? true : false;

/**
 * Check if a token T is provided in the TProvided tuple.
 * Returns true if any provided token satisfies the requirement.
 */
export type IsProvided<T, TProvided extends AnyToken[]> =
  TProvided extends [infer Head, ...infer Tail extends AnyToken[]]
    ? TokenSatisfies<T, Head> extends true
      ? true
      : IsProvided<T, Tail>
    : false;

/**
 * Get the missing requirements from a list of requirements.
 */
type MissingRequirements<TRequired, TProvided extends AnyToken[]> =
  TRequired extends (infer Req)[]
    ? Req extends AnyToken
      ? IsProvided<Req, TProvided> extends true
        ? never
        : Req
      : never
    : never;

/**
 * Error type shown when dependencies are missing.
 * The error message includes which dependencies are missing.
 */
export interface MissingDepsError<_C, TMissing> {
  readonly __brand: 'MissingDependencies'
  readonly _missing: TMissing
  readonly _hint: 'Add the missing dependencies before this component'
}

/**
 * Type constraint that enforces dependencies are satisfied at compile time.
 * Returns the component type C if all requirements are met,
 * otherwise returns a MissingDepsError which won't accept the component.
 */
export type RequiresSatisfied<C, TProvided extends AnyToken[]> =
  MissingRequirements<TransitiveRequiresOf<C>[], TProvided> extends never
    ? C
    : MissingDepsError<C, MissingRequirements<TransitiveRequiresOf<C>[], TProvided>>;

/**
 * Remove a token from a tuple.
 * Used by .override() to remove the old token before adding the new one.
 */
export type RemoveFromTuple<T, Tuple extends any[]> =
  Tuple extends [infer H, ...infer Rest extends any[]]
    ? TokenSatisfies<T, H> extends true
      ? RemoveFromTuple<T, Rest>  // Skip the match
      : [H, ...RemoveFromTuple<T, Rest>]  // Keep non-matches
    : [];

// ============================================================================
// Sub-app composition - type-level TRequires checking
// ============================================================================

/**
 * Extract a built sub-app's TRequires tuple. Sub-apps carry their requires
 * tuple in a phantom `__requires` field on `IBuiltApp<TProvided, TRequires>`;
 * this utility pulls it back out so a parent builder can verify its own
 * TProvided covers the sub-app's surface before accepting the `.add()`.
 *
 * Returns `never` for non-sub-app components - callers fall through to
 * the regular `RequiresSatisfied` path in that case.
 */
type ExtractSubAppRequires<C> =
  C extends { readonly __requires: infer R }
    ? R extends readonly AnyToken[]
      ? R
      : never
    : never;

/**
 * Error shown when a sub-app is `.add()`-ed into a builder that doesn't
 * provide all of the sub-app's declared `.requires(...)`. Distinct from
 * `MissingDepsError` so the hint can point at the sub-app's surface.
 */
export interface MissingSubAppRequiresError<_C, TMissing> {
  readonly __brand: 'MissingSubAppRequires'
  readonly _missing: TMissing
  readonly _hint: 'This sub-app declared .requires() tokens not provided by the enclosing JustScale(). Add them before .add()-ing the sub-app.'
}

/**
 * `.add()` gate used by the Builder. Branches on whether the added
 * component is a built sub-app (carries `__requires`). Sub-apps check
 * their TRequires against TProvided; everything else falls through to
 * the regular component dep check.
 */
export type AddCheck<C, TProvided extends AnyToken[]> =
  ExtractSubAppRequires<C> extends infer SR
    ? [SR] extends [never]
      ? RequiresSatisfied<C, TProvided>
      : SR extends AnyToken[]
        ? MissingRequirements<SR, TProvided> extends never
          ? C
          : MissingSubAppRequiresError<C, MissingRequirements<SR, TProvided>>
        : RequiresSatisfied<C, TProvided>
    : RequiresSatisfied<C, TProvided>;

/**
 * Error shown when a builder with unresolved `.requires()` tries to
 * compile. Sub-apps can `.build()` on their own (for shipping as a unit),
 * but must be composed into a parent to `.compile()` successfully.
 */
export interface CannotCompileSubAppError<TMissing> {
  readonly __brand: 'CannotCompileSubApp'
  readonly _missing: TMissing
  readonly _hint: 'This builder declared .requires(). .add() it into a parent JustScale() that provides the tokens, then compile the parent.'
}

/**
 * Gate used by `IBuiltApp.compile()`. Empty TRequires → real App type.
 * Non-empty TRequires → branded error that the caller gets back when they
 * try to use the compiled value, surfacing the misuse at its call site.
 */
export type CompileResult<TRequires extends AnyToken[], TApp> =
  TRequires extends readonly []
    ? TApp
    : CannotCompileSubAppError<TRequires[number]>;

// ============================================================================
// Builder Interface (forward declaration for types)
// ============================================================================

/**
 * Fluent builder for creating clusters.
 *
 * Two phantom type parameters track the builder's state:
 *
 * - `TProvided` - tokens that have been added via `.add()` (and satisfy
 *   other components' `.inject` requirements).
 * - `TRequires` - tokens declared via `.requires()` that the builder
 *   expects an enclosing scope to provide. Non-empty TRequires marks the
 *   builder as a *sub-app*: it cannot compile standalone; it must be
 *   `.add()`-ed into a parent `JustScale()` that covers the requires.
 *
 * @typeParam TProvided - Tuple of tokens that have been added
 * @typeParam TRequires - Tuple of tokens declared via `.requires()`
 */
export interface Builder<
  TProvided extends AnyToken[] = [],
  TRequires extends AnyToken[] = [],
> {
  /**
   * Add a component to the builder.
   *
   * Components can be:
   * - Services (defineService result)
   * - Controllers (createController result)
   * - Repository bindings (ModelRepository.of(X).bind(Y))
   * - Features (createFeature result)
   * - Callbacks ((b) => b.add(...))
   * - Arrays of components
   * - Sub-apps (another `JustScale()...build()` that used `.requires()`)
   *
   * Dependencies are checked at compile time. For normal components the
   * check is "does TProvided satisfy this component's `.inject` deps?".
   * For sub-apps the check is "does TProvided satisfy the sub-app's
   * declared `.requires(...)`?". Both produce branded compile errors
   * when unsatisfied.
   *
   * @example
   * ```typescript
   * createClusterBuilder()
   *   .add(PgClient)
   *   .add(ModelRepository.of(User).bind(PgUser))
   *   .add(UserService)
   *   .add(AuthFeature)
   *   .build()
   * ```
   */
  add<C extends Component>(
    component: AddCheck<C, TProvided>
  ): Builder<[...TProvided, ...ProvidesOf<C>], TRequires>

  /**
   * Append controller defs discovered at runtime (no compile-time dep checking).
   *
   * Intended for infrastructure (e.g. the `just` CLI runner) that needs to
   * register controllers whose existence isn't known until install time -
   * typically CLI controllers contributed by installed packages. Their deps
   * resolve against the same container as the user's app, so injected
   * repositories/services are shared.
   *
   * Prefer `.add()` for anything you type-check at authoring time.
   *
   * @internal
   */
  addControllers(
    controllers: ReadonlyArray<import('../core/controller.js').ControllerDef<any>>
  ): Builder<TProvided, TRequires>

  /**
   * Override an existing token with a new implementation.
   *
   * This is useful for replacing built-in services (Logger, Lifecycle)
   * or for testing purposes. The token must already be in TProvided.
   *
   * @example
   * ```typescript
   * createClusterBuilder()
   *   .add(InMemoryProcessStorage)
   *   .override(Logger, CustomLogger)  // Replace built-in Logger
   *   .build()
   * ```
   */
  override<
    TToken extends TProvided[number],  // Must exist in TProvided
    TImpl extends AnyToken              // The replacement
  >(
    token: TToken,
    implementation: TImpl
  ): Builder<[...RemoveFromTuple<TToken, TProvided>, TImpl], TRequires>

  /**
   * Declare a token this builder needs from a parent scope.
   *
   * Adding `.requires(T)` turns this builder into a *sub-app*: the
   * resulting TRequires tuple captures everything the builder expects
   * the enclosing `JustScale()` to provide. Downstream `.add()`s see
   * T in TProvided, so components that inject T type-check as usual.
   * But `.compile()` on a builder with non-empty TRequires yields a
   * branded error - the builder must be `.add()`-ed into a parent that
   * covers the requires.
   *
   * At runtime, the parent resolves T and bridges it into the sub-app's
   * container via `createScopedBridge`, so calls through T from inside
   * the sub-app execute in the parent's async scope.
   *
   * The token type is captured as-is (not widened to the full
   * `ServiceToken<T>` union) - so the parent's `IsProvided` check can
   * match the exact shape the consumer passed, without having to
   * satisfy every member of the ServiceToken union.
   *
   * @see CORE_PHILOSOPHY.md principle 9
   */
  requires<T extends AnyToken>(
    token: T,
  ): Builder<[...TProvided, T], [...TRequires, T]>

  /**
   * Build the cluster.
   *
   * Validates all dependencies are satisfied and creates the runnable
   * cluster. The returned built value is typed with both TProvided and
   * TRequires so downstream composers (parents `.add()`-ing this) can
   * type-check that they cover the sub-app's requires.
   */
  build(): import('../justscale.js').BuiltApp<TProvided, TRequires>
}

/**
 * Extract controller types from a tuple of tokens.
 */
export type ExtractControllers<TProvided extends AnyToken[]> =
  TProvided extends [infer Head, ...infer Tail extends AnyToken[]]
    ? Head extends import('../core/controller.js').ControllerDef<any>
      ? [Head, ...ExtractControllers<Tail>]
      : ExtractControllers<Tail>
    : [];

/**
 * A built cluster ready to serve.
 * @typeParam TProvided - Tuple of all tokens that were provided to the builder
 */
export interface BuiltCluster<TProvided extends AnyToken[] = AnyToken[]> {
  /**
   * Compile the cluster into an App instance.
   * This creates the actual runtime with match() and execute() methods.
   */
  compile(): App<ExtractControllers<TProvided>>

  /**
   * The DI container for resolving services.
   */
  readonly container: import('../core/service.js').Container

  /**
   * Start serving on the specified protocols.
   * Internally calls compile() if not already compiled.
   */
  serve(options?: ServeOptions): Promise<void>

  /**
   * Stop the cluster gracefully.
   */
  stop(): Promise<void>

  /**
   * Resolve a token from the container.
   */
  resolve<T>(token: Token<T>): Promise<T>
}

/**
 * Re-exported from cluster/cluster.ts so IBuiltApp.serve(options?) has the
 * same signature as BuiltApp.serve(options?). Single source of truth -
 * previously these diverged and IBuiltApp silently disagreed with runtime.
 */
import type { ServeOptions } from '../cluster/cluster.js';
export type { ServeOptions };

// ============================================================================
// Route Builder Types (Middleware Unification)
// ============================================================================

/**
 * Extract added context type from a middleware function.
 */
export type ExtractMiddlewareAdded<T> =
  T extends (ctx: any) => infer R
    ? R extends Promise<infer A> ? A : R
    : never;

/**
 * Response entry in TReturns union.
 * `TPermission` is the permission def type when declared via
 * `.returns(status, schema, permission)`. Defaults to `unknown` for
 * unpermissioned returns.
 */
export interface ResponseEntry<TStatus extends number, TBody, TPermission = unknown> {
  status: TStatus
  body: TBody
  permission: TPermission
}

/**
 * Extract status codes from TReturns union.
 */
export type ExtractStatuses<T> = T extends ResponseEntry<infer S, any, any> ? S : never;

/**
 * Extract body type for a specific status code.
 */
export type ExtractBodyForStatus<T, TStatus extends number> =
  T extends ResponseEntry<TStatus, infer B, any> ? B : never;

// ============================================================================
// Permission-scoped returns: type utilities (proven in spike)
// ============================================================================

/**
 * Shape of a permission def with a name discriminator - anything structural
 * matching this can be used as a `.returns()` permission argument.
 */
export interface PermissionDefLike<TName extends string = string> {
  readonly name: TName
}

/** Extract the permission type from a single ResponseEntry. */
export type PermOf<E> = E extends ResponseEntry<any, any, infer P> ? P : never;

/** Extract the body type from a single ResponseEntry. */
export type BodyOf<E> = E extends ResponseEntry<any, infer B, any> ? B : never;

/** Extract the permission name from a PermissionDefLike. */
export type NameOf<P> = P extends PermissionDefLike<infer N> ? N : never;

/**
 * Filter a ResponseEntry union down to entries that have a permission
 * (i.e. TPermission extends PermissionDefLike).
 */
export type PermEntries<R> = R extends ResponseEntry<any, any, infer P>
  ? P extends PermissionDefLike<any> ? R : never
  : never;

/**
 * Build a discriminated union variant `{ permission, json }` from a single entry.
 * Uses single-infer helpers to avoid TypeScript's multi-infer-union quirk.
 */
export type ToPermissionVariant<E> = E extends any
  ? { readonly permission: NameOf<PermOf<E>>; json(data: BodyOf<E>): void }
  : never;

/** Build the full discriminated union for a permission-scoped res. */
export type PermissionVariants<R> = ToPermissionVariant<PermEntries<R>>;

/**
 * A resolved execution step - fn is always a callable function.
 * Used in CompiledRoute after GuardDef resolution.
 */
export interface Step {
  type: 'use' | 'guard'
  fn: (ctx: any) => any
}

/**
 * An unresolved step - discriminated by type:
 * - 'use': fn may be a MiddlewareDef (DI) or plain middleware function
 * - 'guard': fn may be a GuardDef (DI), array of GuardDefs (OR semantics), or plain guard function
 *
 * Stored in RouteDef (builder output). Resolved to Step[] by createController.
 */
export type UnresolvedStep =
  | { type: 'use'; fn: ((ctx: any) => any) | MiddlewareDef }
  // biome-ignore lint/suspicious/noExplicitAny: GuardDef is contravariant in TDeps - must accept any specific inject type
  | { type: 'guard'; fn: ((ctx: any) => any) | GuardDef<any> | readonly GuardDef<any>[] };

/**
 * Finalized route definition (builder output - steps are unresolved).
 * GuardDefs in steps are resolved by createController via the DI container.
 */
export interface RouteDef<
  TPath extends string,
  TReturns,
  TRequirements,
  TBody = unknown
> {
  path: TPath
  steps: UnresolvedStep[]
  responseSchemas: Map<number, import('zod').ZodType | null>
  handler: (ctx: any) => any
  /** Model types for path param → Reference transformation */
  types?: Record<string, abstract new (...args: any[]) => any>
  /**
   * Permission-scoped returns - declared via `.returns(status, schema, permission)`.
   * Consumed by the `permissions` middleware to determine which permission the
   * current caller matches (sets `res.permission`).
   */
  permissionReturns?: ReadonlyArray<{
    status: number
    schema: import('zod').ZodType | null
    permission: PermissionDefLike
  }>
}

/**
 * Base route builder interface.
 *
 * @typeParam TContext - Accumulated context from middleware
 * @typeParam TReturns - Union of possible responses (ResponseEntry union)
 * @typeParam TRequirements - Accumulated DI requirements from plugins
 * @typeParam TPath - Route path literal for param extraction
 * @typeParam TBody - Request body type (accumulated via body() calls)
 */
export interface RouteBuilder<
  TContext,
  TReturns,
  TRequirements,
  TPath extends string,
  TBody = unknown,
  THandlerReturn = void | Promise<void>
> {
  /**
   * Add middleware that extends context.
   * Cannot stop execution - always returns additions.
   * Accepts either a plain function or a MiddlewareDef (with DI).
   *
   * When passed a DI-aware MiddlewareDef (built via `createMiddleware`),
   * the middleware's `inject` deps are accumulated into TRequirements,
   * which flows through to `RequiresOf<ControllerDef>` so that
   * `.add(Controller)` type-checks at the builder level.
   */
  use<
    TMw extends
      | ((ctx: TContext) => object | Promise<object>)
      | MiddlewareDef<object, any>,
  >(
    middleware: TMw,
  ): RouteBuilder<
    TContext & ExtractAddedFromMiddleware<TMw>,
    TReturns,
    TRequirements | ExtractStepDeps<TMw>,
    TPath,
    TBody,
    THandlerReturn
  >

  /**
   * Add guard that can stop execution.
   * Cannot add to context - only checks and potentially stops.
   * Accepts a guard function, a GuardDef (with DI), or an array of GuardDefs (any match = allow).
   *
   * DI-aware GuardDefs contribute their inject deps to TRequirements
   * (same treatment as `.use()` - see there for the rationale).
   */
  guard<
    TG extends
      | ((ctx: TContext & { stop(): Stop }) => void | Stop | boolean | Promise<void | Stop | boolean>)
      | GuardDef
      | readonly GuardDef[],
  >(
    check: TG,
  ): RouteBuilder<
    TContext,
    TReturns,
    TRequirements | ExtractStepDeps<TG>,
    TPath,
    TBody,
    THandlerReturn
  >

  /**
   * Apply a plugin that can chain multiple operations.
   * Plugins can add use/guard/returns in any combination.
   */
  apply<TCtxOut, TRetOut, TReqOut, TBodyOut = TBody>(
    plugin: BuilderPlugin<TContext, TCtxOut, TReturns, TRetOut, TRequirements, TReqOut, TPath, TBody, TBodyOut>
  ): RouteBuilder<TCtxOut, TRetOut, TReqOut, TPath, TBodyOut, THandlerReturn>

  /**
   * Declare a permission-scoped response.
   *
   * Multiple `.returns()` calls with the same status and different permissions
   * build a discriminated union on `res.permission` - the handler branches via
   * `switch(res.permission)` and TypeScript narrows `res.json()` per case.
   *
   * Requires `.use(permissions)` middleware (or equivalent) to set `res.permission`.
   */
  returns<
    TStatus extends number,
    TSchema extends import('zod').ZodType,
    TPermission extends PermissionDefLike,
  >(
    status: TStatus,
    schema: TSchema,
    permission: TPermission,
  ): RouteBuilder<
    TContext,
    TReturns | ResponseEntry<TStatus, import('zod').infer<TSchema>, TPermission>,
    TRequirements,
    TPath,
    TBody,
    THandlerReturn
  >

  /**
   * Declare a possible response with schema.
   */
  returns<TStatus extends number, TSchema extends import('zod').ZodType>(
    status: TStatus,
    schema: TSchema
  ): RouteBuilder<
    TContext,
    TReturns | ResponseEntry<TStatus, import('zod').infer<TSchema>>,
    TRequirements,
    TPath,
    TBody,
    THandlerReturn
  >

  /**
   * Declare a possible response without body.
   */
  returns<TStatus extends number>(
    status: TStatus
  ): RouteBuilder<
    TContext,
    TReturns | ResponseEntry<TStatus, void>,
    TRequirements,
    TPath,
    TBody,
    THandlerReturn
  >

  /**
   * Declare model types for path params.
   * Transforms matching params from `string` to `Reference<T>`.
   */
  types<TTypes extends Record<string, abstract new (...args: any[]) => any>>(
    types: TTypes,
  ): RouteBuilder<
    Omit<TContext, 'params'> & { params: TypedParams<TPath, TTypes> },
    TReturns,
    TRequirements,
    TPath,
    TBody,
    THandlerReturn
  >

  /**
   * Set final handler.
   */
  handle(
    handler: (ctx: TContext) => THandlerReturn
  ): RouteDef<TPath, TReturns, TRequirements, TBody>
}

/**
 * Forward declaration for BuilderPlugin.
 * Full implementation with PLUGIN_SYMBOL, requirements, and resolve() in plugin.ts
 *
 * This minimal declaration is here to avoid circular dependencies between
 * types.ts (RouteBuilder needs BuilderPlugin) and plugin.ts (BuilderPlugin needs RouteBuilder).
 */
export interface BuilderPlugin<
  TCtxIn,
  TCtxOut,
  TRetIn,
  TRetOut,
  TReqIn,
  TReqOut,
  TPath extends string,
  TBodyIn = unknown,
  TBodyOut = TBodyIn,
  THandlerReturn = void | Promise<void>
> {
  (builder: RouteBuilder<TCtxIn, TRetIn, TReqIn, TPath, TBodyIn, THandlerReturn>): RouteBuilder<TCtxOut, TRetOut, TReqOut, TPath, TBodyOut, THandlerReturn>
}
