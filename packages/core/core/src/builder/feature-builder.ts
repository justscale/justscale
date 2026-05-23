/**
 * Feature Builder V2
 *
 * Fluent builder for creating features with type-safe requirement tracking.
 *
 * @example
 * ```typescript
 * const AuthFeature = createFeatureBuilder()
 *   .name('auth')
 *   .requires(ModelRepository.of(User))
 *   .requires(ModelRepository.of(Session))
 *   .onStart(async ({ resolve }) => {
 *     const auth = resolve(AuthService)
 *     await auth.initialize()
 *   })
 *   .provides((b) => b
 *     .add(AuthService)
 *     .add(AuthController)
 *   )
 * ```
 */

import type {
  Builder,
  AnyToken,
  FeatureToken,
  FeatureMetadata,
  StartHook,
  StopHook,
} from './types.js';
import { FEATURE_TOKEN, FEATURE_META } from './types.js';

// ============================================================================
// Feature Builder Interface
// ============================================================================

/**
 * Fluent builder for creating features.
 *
 * Each `.requires()` call accumulates the requirement in the phantom type,
 * enabling TypeScript to track what the feature needs.
 *
 * When requiring another Feature, that feature's provides become available
 * to use in your `.provides()` callback.
 *
 * @typeParam TRequires - Tuple of required tokens (accumulated)
 * @typeParam TAvailable - Tuple of tokens available from required features
 */
export interface FeatureBuilder<
  TRequires extends AnyToken[] = [],
  TAvailable extends AnyToken[] = [],
> {
  /**
   * Declare a dependency on a token or feature.
   *
   * The token must be provided before this feature is added to a builder.
   * When requiring a Feature, that feature's provides become available.
   *
   * @example
   * ```typescript
   * createFeatureBuilder()
   *   .requires(ModelRepository.of(User))
   *   .requires(PgClient)
   *   .requires(DatabaseFeature) // DatabaseFeature's provides are now available
   * ```
   */
  requires<T extends AnyToken>(
    token: T
  ): T extends FeatureToken<any, infer TFeatureProv extends AnyToken[]>
    ? FeatureBuilder<[...TRequires, T], [...TAvailable, ...TFeatureProv]>
    : FeatureBuilder<[...TRequires, T], TAvailable>

  /**
   * Set a human-readable name for this feature.
   *
   * Used in error messages and debugging.
   */
  name(name: string): FeatureBuilder<TRequires, TAvailable>

  /**
   * Add a lifecycle hook called when the cluster starts.
   *
   * @example
   * ```typescript
   * .onStart(async ({ resolve }) => {
   *   const db = resolve(PgClient)
   *   await db.connect()
   * })
   * ```
   */
  onStart(hook: StartHook): FeatureBuilder<TRequires, TAvailable>

  /**
   * Add a lifecycle hook called when the cluster stops.
   *
   * @example
   * ```typescript
   * .onStop(async () => {
   *   await cleanup()
   * })
   * ```
   */
  onStop(hook: StopHook): FeatureBuilder<TRequires, TAvailable>

  /**
   * Define what this feature provides.
   *
   * The callback receives a builder that has all required tokens available
   * (including provides from required features), and returns a builder with
   * the provided components added.
   *
   * @example
   * ```typescript
   * .provides((b) => b
   *   .add(AuthService)
   *   .add(AuthController)
   * )
   * ```
   */
  provides<TProvides extends AnyToken[]>(
    fn: (
      builder: Builder<[...TRequires, ...TAvailable]>
    ) => Builder<[...TRequires, ...TAvailable, ...TProvides]>
  ): FeatureToken<TRequires, TProvides>
}

// ============================================================================
// Feature Builder Implementation
// ============================================================================

/**
 * Internal state for feature builder.
 */
interface FeatureBuilderState {
  name?: string
  requires: AnyToken[]
  onStart?: StartHook
  onStop?: StopHook
}

/**
 * Feature builder implementation.
 */
class FeatureBuilderImpl<
  TRequires extends AnyToken[] = [],
  TAvailable extends AnyToken[] = [],
> implements FeatureBuilder<TRequires, TAvailable>
{
  constructor(private state: FeatureBuilderState = { requires: [] }) {}

  requires<T extends AnyToken>(
    token: T
  ): T extends FeatureToken<any, infer TFeatureProv extends AnyToken[]>
    ? FeatureBuilder<[...TRequires, T], [...TAvailable, ...TFeatureProv]>
    : FeatureBuilder<[...TRequires, T], TAvailable> {
    return new FeatureBuilderImpl({
      ...this.state,
      requires: [...this.state.requires, token],
    }) as any;
  }

  name(name: string): FeatureBuilder<TRequires, TAvailable> {
    return new FeatureBuilderImpl({
      ...this.state,
      name,
    });
  }

  onStart(hook: StartHook): FeatureBuilder<TRequires, TAvailable> {
    return new FeatureBuilderImpl({
      ...this.state,
      onStart: hook,
    });
  }

  onStop(hook: StopHook): FeatureBuilder<TRequires, TAvailable> {
    return new FeatureBuilderImpl({
      ...this.state,
      onStop: hook,
    });
  }

  provides<TProvides extends AnyToken[]>(
    fn: (
      builder: Builder<[...TRequires, ...TAvailable]>
    ) => Builder<[...TRequires, ...TAvailable, ...TProvides]>
  ): FeatureToken<TRequires, TProvides> {
    const metadata: FeatureMetadata = {
      name: this.state.name,
      requires: this.state.requires,
      onStart: this.state.onStart,
      onStop: this.state.onStop,
    };

    // Create the feature function
    const feature = ((builder: Builder<TRequires>) => {
      return fn(builder as any);
    }) as unknown as FeatureToken<TRequires, TProvides>;

    // Attach metadata
    Object.defineProperties(feature, {
      [FEATURE_TOKEN]: { value: true, enumerable: false },
      [FEATURE_META]: { value: metadata, enumerable: false },
    });

    return feature;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new feature builder.
 *
 * Features are reusable bundles of services and controllers that can be
 * added to a cluster. They declare their requirements via `.requires()`
 * and what they provide via `.provides()`.
 *
 * @example
 * ```typescript
 * // Simple feature with no requirements
 * const LoggingFeature = createFeatureBuilder()
 *   .provides((b) => b.add(LoggerService))
 *
 * // Feature with requirements
 * const AuthFeature = createFeatureBuilder()
 *   .name('auth')
 *   .requires(ModelRepository.of(User))
 *   .requires(ModelRepository.of(Session))
 *   .provides((b) => b
 *     .add(AuthService)
 *     .add(SessionService)
 *     .add(AuthController)
 *   )
 *
 * // Feature with lifecycle hooks
 * const DatabaseFeature = createFeatureBuilder()
 *   .name('database')
 *   .onStart(async ({ resolve }) => {
 *     const client = resolve(PgClient)
 *     await client.connect()
 *   })
 *   .onStop(async () => {
 *     // cleanup
 *   })
 *   .provides((b) => b.add(PgClient))
 * ```
 */
export function createFeatureBuilder(): FeatureBuilder<[], []> {
  return new FeatureBuilderImpl();
}

// ============================================================================
// Feature Utilities
// ============================================================================

/**
 * Get the metadata from a feature token.
 */
export function getFeatureMetadata(
  feature: FeatureToken<any, any>
): FeatureMetadata {
  return feature[FEATURE_META];
}

/**
 * Get the requirements from a feature token.
 */
export function getFeatureRequirements(
  feature: FeatureToken<any, any>
): AnyToken[] {
  return feature[FEATURE_META].requires;
}

/**
 * Get the name from a feature token.
 */
export function getFeatureName(
  feature: FeatureToken<any, any>
): string | undefined {
  return feature[FEATURE_META].name;
}
