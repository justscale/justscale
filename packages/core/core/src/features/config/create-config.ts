import type { Token } from '../../builder/index.js';
import type { ServiceToken, InstanceOf } from '../../core/service.js';
import type { ConfigPartial, ConfigComponent } from './types.js';

type InferDeps<T extends Record<string, ServiceToken<any>>> = {
  [K in keyof T]: InstanceOf<T[K]>
};

type ConfigFactory<TInject extends Record<string, ServiceToken<any>>> =
  (deps: InferDeps<TInject>) => Record<symbol, any> | Promise<Record<symbol, any>>;

interface CreateConfigOptions<
  TInject extends Record<string, ServiceToken<any>>,
  P extends readonly ConfigPartial<any>[],
> {
  provides?: P
  inject?: TInject
  factory: ConfigFactory<TInject>
}

/**
 * Create a config component that provides multiple partials.
 *
 * When `provides` is passed, the builder validates factory output against
 * each partial's zod schema at boot. When omitted, values are registered
 * as-is without validation (kept for backward-compat with older tests).
 */
export function createConfig<
  const TInject extends Record<string, ServiceToken<any>> = {},
  const P extends readonly ConfigPartial<any>[] = readonly [],
>(options: CreateConfigOptions<TInject, P>): ConfigComponent<P> {
  return {
    __configComponent: true,
    provides: (options.provides ?? []) as P,
    inject: (options.inject ?? {}) as Record<string, Token<any>>,
    factory: options.factory as ConfigFactory<Record<string, ServiceToken<any>>>,
  };
}
