/**
 * In-Memory Adapters
 *
 * Simple in-memory implementations for development and testing.
 * These are not suitable for production multi-node deployments.
 *
 * @example
 * ```typescript
 * import { InMemoryLockFeature } from '@justscale/core/memory'
 *
 * JustScale()
 *   .add(InMemoryLockFeature)
 *   .build()
 * ```
 */

export {
  InMemoryLockProvider,
  createInMemoryLockProvider,
  type InMemoryLockProviderInstance,
} from '../lock/memory.js';
export { InMemoryLockFeature } from './lock-feature.js';
