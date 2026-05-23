/**
 * Channel Feature
 *
 * Provides pub/sub channels with pluggable backends.
 * Requires a channel backend to be registered before adding this feature.
 */

import { createFeatureBuilder } from '../../builder/index.js';
import { AbstractChannelBackend } from './backend.js';

/**
 * Channel Feature
 *
 * Validates that a channel backend has been registered.
 * Add a backend using `bindService` before adding this feature.
 *
 * @example Using memory backend (for testing or single-node)
 * ```typescript
 * import { ChannelFeature, MemoryChannelBackend, AbstractChannelBackend, bindService } from '@justscale/core';
 *
 * const cluster = createClusterBuilder()
 *   .add(MemoryChannelBackend)
 *   .add(bindService(AbstractChannelBackend, MemoryChannelBackend))
 *   .add(ChannelFeature)
 *   .add(ChatService)
 *   .build();
 * ```
 *
 * @example Using Redis backend (for production/multi-node)
 * ```typescript
 * import { ChannelFeature, AbstractChannelBackend, bindService } from '@justscale/core';
 * import { RedisChannelBackend } from '@justscale/redis';
 *
 * const cluster = createClusterBuilder()
 *   .add(RedisChannelBackend)
 *   .add(bindService(AbstractChannelBackend, RedisChannelBackend))
 *   .add(ChannelFeature)
 *   .add(ChatService)
 *   .build();
 * ```
 */
export const ChannelFeature = createFeatureBuilder()
  .name('channel')
  .requires(AbstractChannelBackend)
  .provides((b) => b);
