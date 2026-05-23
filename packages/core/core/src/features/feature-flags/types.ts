import type { z } from 'zod';
import type { Token } from '../../builder/index.js';

export const FEATURE_FLAG_PARTIAL = Symbol('featureFlag:partial');

/**
 * A feature-flag partial - shape and validation for a flag slice.
 *
 * Parallel to ConfigPartial/SecretPartial. Flag values live in memory and
 * may change at runtime: external adapters (LaunchDarkly, Unleash) call
 * FeatureFlagService.update() when they observe a change, which notifies
 * watchers.
 */
export interface FeatureFlagPartial<T> {
  readonly [FEATURE_FLAG_PARTIAL]: true
  readonly key: symbol
  readonly name: string
  readonly schema: z.ZodType<T>
}

export function isFeatureFlagPartial(value: unknown): value is FeatureFlagPartial<unknown> {
  return typeof value === 'object' && value !== null && FEATURE_FLAG_PARTIAL in value;
}

/**
 * Component returned by createFeatureFlagProvider().
 * Builder runs its factory at boot for initial values.
 */
export interface FeatureFlagComponent<P extends readonly FeatureFlagPartial<any>[] = readonly FeatureFlagPartial<any>[]> {
  readonly __featureFlagComponent: true
  readonly provides: P
  readonly inject: Record<string, Token<any>>
  readonly factory: (deps: Record<string, any>) => Record<symbol, any> | Promise<Record<symbol, any>>
}

export function isFeatureFlagComponent(value: unknown): value is FeatureFlagComponent {
  return typeof value === 'object' && value !== null && '__featureFlagComponent' in value;
}
