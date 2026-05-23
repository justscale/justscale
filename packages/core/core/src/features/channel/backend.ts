/**
 * Channel Backend
 *
 * Abstract service for channel backends (Memory, Redis, etc.)
 * Backends handle remote pub/sub - channels handle local subscription state.
 */

import { defineAbstract, defineService } from '../../core/index.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Per-call subscription handle returned by `ChannelBackend.subscribe`.
 *
 * `ready` resolves when the backend has fully wired the subscription
 * (e.g. PG `LISTEN` ACK in, Redis `SUBSCRIBE` ACK in). Reject on backend
 * connect / listen failure — DO NOT silently swallow, otherwise callers
 * that publish-immediately-after-subscribe lose messages and have no
 * observable signal to wait on.
 *
 * In-memory / no-op backends should return an already-resolved promise.
 */
export interface BackendSubscription extends Disposable {
  readonly ready: Promise<void>
}

/**
 * Channel backend interface.
 */
export interface ChannelBackend {
  /**
   * Subscribe to a remote channel.
   * Called when the first local subscriber joins a channel.
   *
   * @param channelKey - The channel key to subscribe to
   * @param onMessage - Callback invoked when a remote message arrives
   * @returns Subscription handle: dispose to unsubscribe; await `.ready` to
   *   block on the backend ACK before publishing on this channel.
   */
  subscribe(
    channelKey: string,
    onMessage: (message: unknown) => void,
  ): BackendSubscription

  /**
   * Publish a message to a remote channel.
   * Called when a message is published locally.
   *
   * @param channelKey - The channel key to publish to
   * @param message - The message to publish
   */
  publish(channelKey: string, message: unknown): void

  /**
   * Close and clean up resources.
   * Called during app shutdown.
   */
  close(): Promise<void>
}

// ============================================================================
// Abstract Service Token (uses abstract class for stable identity across modules)
// ============================================================================

/**
 * Abstract channel backend for dependency injection.
 * Implementations (Memory, Redis, etc.) can be bound using bindService.
 *
 * Use `bindService` to register an implementation:
 *
 * @example Using Redis backend
 * ```typescript
 * import { createClusterBuilder, bindService, AbstractChannelBackend } from "@justscale/core";
 * import { RedisChannelBackend } from "@justscale/redis";
 *
 * createClusterBuilder()
 *   .add(bindService(AbstractChannelBackend, RedisChannelBackend()))
 *   .add(RoomChannels)
 *   .build()
 * ```
 *
 * @example Using default Memory backend
 * ```typescript
 * import { createClusterBuilder, bindService, AbstractChannelBackend, MemoryChannelBackend } from "@justscale/core";
 *
 * createClusterBuilder()
 *   .add(bindService(AbstractChannelBackend, MemoryChannelBackend))
 *   .add(RoomChannels)
 *   .build()
 * ```
 */
export abstract class AbstractChannelBackend extends defineAbstract<ChannelBackend>('AbstractChannelBackend') {}

// ============================================================================
// Memory Implementation
// ============================================================================

/**
 * In-memory channel backend (no-op for remote operations).
 * Used as the default when no external backend is configured.
 * Messages are only delivered to local subscribers.
 *
 * @example
 * ```typescript
 * import { createClusterBuilder, bindService, AbstractChannelBackend, MemoryChannelBackend } from "@justscale/core";
 *
 * createClusterBuilder()
 *   .add(bindService(AbstractChannelBackend, MemoryChannelBackend))
 *   .build()
 * ```
 */
export class MemoryChannelBackend extends defineService({
  inject: {},
  provides: [AbstractChannelBackend],
  factory: (): ChannelBackend => ({
    subscribe(
      _channelKey: string,
      _onMessage: (message: unknown) => void,
    ): BackendSubscription {
      // No-op - there are no remote messages in local-only mode. ready is
      // already-resolved so callers can await uniformly.
      return { ready: Promise.resolve(), [Symbol.dispose]: () => {} };
    },

    publish(_channelKey: string, _message: unknown): void {
      // No-op - no remote delivery in local-only mode
    },

    async close(): Promise<void> {
      // No-op - nothing to close
    },
  }),
}) {}

// Type for the backend instance
export type ChannelBackendInstance = ChannelBackend;
