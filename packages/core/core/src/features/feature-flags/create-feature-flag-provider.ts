import type { Token } from '../../builder/index.js';
import type { ServiceToken, InstanceOf } from '../../core/service.js';
import type { FeatureFlagPartial, FeatureFlagComponent } from './types.js';

type InferDeps<T extends Record<string, ServiceToken<any>>> = {
  [K in keyof T]: InstanceOf<T[K]>
};

type FlagFactory<TInject extends Record<string, ServiceToken<any>>> =
  (deps: InferDeps<TInject>) => Record<symbol, any> | Promise<Record<symbol, any>>;

interface CreateFeatureFlagProviderOptions<
  TInject extends Record<string, ServiceToken<any>>,
  P extends readonly FeatureFlagPartial<any>[],
> {
  provides?: P
  inject?: TInject
  factory: FlagFactory<TInject>
}

/**
 * Create a FeatureFlagProvider - loads initial flag values at boot.
 *
 * For reactive updates (external flag system changed a value), an injected
 * adapter subscribes to the source and calls FeatureFlagService.update()
 * to push new values into the container.
 */
export function createFeatureFlagProvider<
  const TInject extends Record<string, ServiceToken<any>> = {},
  const P extends readonly FeatureFlagPartial<any>[] = readonly [],
>(options: CreateFeatureFlagProviderOptions<TInject, P>): FeatureFlagComponent<P> {
  return {
    __featureFlagComponent: true,
    provides: (options.provides ?? []) as P,
    inject: (options.inject ?? {}) as Record<string, Token<any>>,
    factory: options.factory as FlagFactory<Record<string, ServiceToken<any>>>,
  };
}
