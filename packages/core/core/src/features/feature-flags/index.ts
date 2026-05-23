/**
 * @justscale/core/feature-flags
 *
 * Reactive feature-flag management. Values live in memory, update via
 * external adapters, observable via `.watch()`.
 */

export {
  FEATURE_FLAG_PARTIAL,
  isFeatureFlagPartial,
  isFeatureFlagComponent,
} from './types.js';
export type {
  FeatureFlagPartial,
  FeatureFlagComponent,
} from './types.js';

export { defineFeatureFlagPartial } from './define-feature-flag-partial.js';
export { FeatureFlag } from './feature-flag-of.js';
export type { FeatureFlagToken } from './feature-flag-of.js';

export { createFeatureFlagProvider } from './create-feature-flag-provider.js';

export { FeatureFlagServiceDef } from './feature-flag-service.js';
export type { FeatureFlagService } from './feature-flag-service.js';
