import type { z } from 'zod';
import { FEATURE_FLAG_PARTIAL, type FeatureFlagPartial } from './types.js';

/**
 * Define a feature-flag partial with a Zod schema.
 *
 * The returned object carries a fresh `Symbol('featureFlag:<name>')` on
 * `.key`. Plain `Symbol()` (not `Symbol.for`) so two features that happen
 * to pick the same name get distinct tokens and do not silently share a
 * container slot. Consumers import the token object from the declaring
 * module and inject it via `FeatureFlag.of(partial)`; no string-keyed
 * lookup is involved.
 *
 * @example
 * const CheckoutFlags = defineFeatureFlagPartial('checkout', z.object({
 *   newPayment: z.boolean(),
 *   cohort: z.enum(['a', 'b']),
 * }))
 */
export function defineFeatureFlagPartial<T extends z.ZodType>(
  name: string,
  schema: T,
): FeatureFlagPartial<z.infer<T>> {
  return {
    [FEATURE_FLAG_PARTIAL]: true,
    key: Symbol(`featureFlag:${name}`),
    name,
    schema: schema as z.ZodType<z.infer<T>>,
  };
}
