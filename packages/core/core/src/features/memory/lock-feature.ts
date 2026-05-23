/**
 * In-Memory Lock Feature
 *
 * Provides in-memory locking for single-node apps, development, and testing.
 * For distributed locking across multiple instances, use PostgresLockFeature.
 *
 * @example
 * ```typescript
 * import JustScale from '@justscale/core'
 * import { InMemoryLockFeature } from '@justscale/core/memory'
 * import { InMemoryProcessFeature } from '@justscale/core/process'
 *
 * JustScale()
 *   .add(InMemoryLockFeature)
 *   .add(InMemoryProcessFeature)
 *   .build()
 * ```
 */

import { createFeatureBuilder } from '../../builder/index.js';
import { InMemoryLockProvider } from '../lock/memory.js';

export const InMemoryLockFeature = createFeatureBuilder()
  .name('InMemoryLock')
  .provides((b) =>
    b.add(InMemoryLockProvider),  // Auto-provides AbstractLockProvider via SERVICE_PROVIDES
  );
