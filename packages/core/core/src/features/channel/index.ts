/**
 * Channel - Pub/Sub Channels
 *
 * Provides typed pub/sub messaging with:
 * - Per-channel subscriptions (async iterables)
 * - Reference counting for cluster optimization
 * - Hooks for cluster integration
 *
 * @example Basic usage
 * ```typescript
 * import { createChannels } from "@justscale/core";
 * import type { Ref } from "@justscale/core/models";
 * import { Room } from "./room.model";
 *
 * // Define typed channels
 * const RoomChannels = createChannels<ServerMessage>();
 *
 * // Inject into service - channels key off Ref<T>, not string IDs.
 * const ChatService = defineService({
 *   inject: { channels: RoomChannels },
 *   factory: ({ channels }) => ({
 *     subscribe(room: Ref<Room>) {
 *       return channels.subscribe(room);
 *     },
 *     broadcast(room: Ref<Room>, msg: ServerMessage) {
 *       channels.publish(room, msg);
 *     },
 *   }),
 * });
 * ```
 */

// Feature
export { ChannelFeature } from './feature.js';

// Main factory
export { createChannels } from './channels.js';
export type { ChannelsDef } from './channels.js';

// Backend (for implementing custom backends)
export { AbstractChannelBackend, MemoryChannelBackend } from './backend.js';
export type { BackendSubscription, ChannelBackend, ChannelBackendInstance } from './backend.js';

// Types
export type {
  Channel,
  ChannelKey,
  ChannelSubscription,
  ChannelsInstance,
  ChannelsOptions,
  ChannelHooks,
} from './types.js';
export { resolveChannelKey } from './types.js';

// Internal (for advanced use)
export { createChannel } from './channel.js';
export type { ChannelInternal } from './channel.js';
