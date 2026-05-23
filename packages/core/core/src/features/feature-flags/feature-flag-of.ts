import type { Token } from '../../builder/index.js';
import type { FeatureFlagPartial } from './types.js';

declare const FEATURE_FLAG_TOKEN_BRAND: unique symbol;

export interface FeatureFlagToken<T> extends Token<T> {
  readonly [FEATURE_FLAG_TOKEN_BRAND]?: T
  readonly description: string
  readonly key: symbol
  resolve(container: { get(key: symbol): T }): T
}

const tokenCache = new WeakMap<FeatureFlagPartial<any>, FeatureFlagToken<any>>();

export const FeatureFlag = {
  of<T>(partial: FeatureFlagPartial<T>): FeatureFlagToken<T> {
    const cached = tokenCache.get(partial);
    if (cached) return cached as FeatureFlagToken<T>;
    const token: FeatureFlagToken<T> = {
      description: `FeatureFlag.of(${partial.name})`,
      key: partial.key,
      resolve: (container: { get: (key: symbol) => T }) => container.get(partial.key),
    } as FeatureFlagToken<T>;
    tokenCache.set(partial, token);
    return token;
  },
};
