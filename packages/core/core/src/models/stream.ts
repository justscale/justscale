/**
 * Stream Field Implementation
 *
 * Provides pub/sub streams as first-class model fields.
 * Streams are AsyncIterable<T> for subscription and have a publish() method.
 *
 * @example
 * ```typescript
 * const Room = defineModel('Room', {
 *   name: field.string(),
 *   messages: field.stream(ChatMessage),
 * })
 *
 * // Subscribe
 * for await (const msg of room.messages) {
 *   console.log(msg.text)
 * }
 *
 * // Publish
 * room.messages.publish({ user: userRef, text: 'hello' })
 * ```
 */

import type { ChannelSubscription } from '../features/channel/types.js';

// ============================================================================
// Symbols
// ============================================================================

/** Symbol to mark an object as a Stream */
export const STREAM = Symbol('models:stream');

/** Symbol-keyed method to attach channel (internal use by repository) */
export const SET_STREAM_CHANNEL = Symbol('models:stream:setChannel');

/** Symbol-keyed method to attach signal emitter for process wakeup */
export const SET_STREAM_SIGNAL_EMITTER = Symbol('models:stream:setSignalEmitter');

// ============================================================================
// Stream Types
// ============================================================================

/**
 * A stream field that provides pub/sub messaging on a model.
 *
 * Implements AsyncIterable<T> for subscription via `for await...of`.
 * Provides publish() method for broadcasting messages.
 * Implements Disposable for cleanup via `using` syntax.
 *
 * @example
 * ```typescript
 * // Subscribe to messages
 * for await (const msg of room.messages) {
 *   console.log(msg.text)
 * }
 *
 * // Publish a message
 * room.messages.publish({ user: userRef, text: 'hello' })
 *
 * // Manual cleanup (or use `using` on entity)
 * room.messages.disconnect()
 * ```
 */
export interface Stream<T> extends AsyncIterable<T>, Disposable {
  readonly [STREAM]: true

  /**
   * Async iterator - enables `for await (const msg of stream) { ... }`
   * Delegates to underlying channel's async iterator.
   */
  [Symbol.asyncIterator](): AsyncIterator<T>

  /**
   * Publish a message to all subscribers.
   *
   * For protected streams, requires the entity to be locked.
   *
   * @throws Error if stream is not connected (entity not from repository)
   * @throws Error if stream is protected and entity is not locked
   */
  publish(message: T): void

  /** Check if stream has active channel connection */
  readonly isConnected: boolean

  /**
   * Disconnect from the channel and clean up resources.
   * Safe to call multiple times.
   */
  disconnect(): void
}

// ============================================================================
// Stream Implementation
// ============================================================================

/**
 * Stream implementation that wraps a channel subscription.
 * Created by repository during entity hydration.
 */
export class StreamImpl<T> implements Stream<T> {
  readonly [STREAM] = true as const;

  private channel: ChannelSubscription<T> | null = null;
  private publishFn: ((msg: T) => void) | null = null;
  private readonly protectedMode: boolean;
  private lockChecker: (() => boolean) | null = null;

  /** Signal emitter for waking up processes waiting on stream() */
  private signalEmitter: ((channelKey: string, message: T) => void) | null = null;
  /** Channel key for signal emission (tableName:entityId:fieldName) */
  private channelKey: string | null = null;

  constructor(isProtected: boolean) {
    this.protectedMode = isProtected;
  }

  /**
   * Attach the channel subscription and publish function.
   * Called by repository during entity hydration.
   *
   * @internal
   */
  [SET_STREAM_CHANNEL](
    channel: ChannelSubscription<T>,
    publish: (msg: T) => void,
    lockChecker?: () => boolean,
  ): void {
    this.channel = channel;
    this.publishFn = publish;
    this.lockChecker = lockChecker ?? null;
  }

  /**
   * Attach a signal emitter for process wakeup.
   * When publish() is called, this emitter is invoked to wake up any
   * processes that are suspended on stream(r, entity.field).
   *
   * Called by repository during entity hydration when SignalBus is available.
   *
   * @internal
   */
  [SET_STREAM_SIGNAL_EMITTER](
    channelKey: string,
    emitter: (channelKey: string, message: T) => void,
  ): void {
    this.channelKey = channelKey;
    this.signalEmitter = emitter;
  }

  /**
   * Async generator that delegates to the channel's async iterator.
   * Uses `yield*` to forward all messages from the underlying channel.
   */
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    if (!this.channel) {
      throw new Error('Stream not connected. Ensure entity is loaded via repository.');
    }
    // Delegate to channel's async iterator
    // Channel's [Symbol.asyncIterator] yields messages as they arrive.
    yield* this.channel;
  }

  publish(message: T): void {
    if (!this.publishFn) {
      throw new Error('Stream not connected. Ensure entity is loaded via repository.');
    }
    if (this.protectedMode && this.lockChecker && !this.lockChecker()) {
      throw new Error('Protected stream requires Lock<T> to publish.');
    }

    // Publish to local subscribers (channel)
    this.publishFn(message);

    // Emit signal for process wakeup (if configured)
    // This wakes up any processes waiting on stream(r, entity.field)
    if (this.signalEmitter && this.channelKey) {
      try {
        this.signalEmitter(this.channelKey, message);
      } catch (err) {
        // Don't let signal emission failure break the publish
        console.error('[Stream] Signal emission failed:', err);
      }
    }
  }

  get isConnected(): boolean {
    return this.channel !== null && this.publishFn !== null;
  }

  /**
   * Disconnect from the channel and clean up resources.
   * Unsubscribes from the underlying channel subscription.
   * Safe to call multiple times.
   */
  disconnect(): void {
    if (this.channel) {
      this.channel.unsubscribe();
      this.channel = null;
    }
    this.publishFn = null;
    this.lockChecker = null;
    this.signalEmitter = null;
    this.channelKey = null;
  }

  /**
   * Disposable implementation for `using` syntax.
   * Automatically cleans up when the stream goes out of scope.
   */
  [Symbol.dispose](): void {
    this.disconnect();
  }
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if a value is a Stream.
 *
 * @example
 * ```typescript
 * if (isStream(value)) {
 *   for await (const msg of value) {
 *     console.log(msg)
 *   }
 * }
 * ```
 */
export function isStream(value: unknown): value is Stream<unknown> {
  return typeof value === 'object' && value !== null && STREAM in value;
}
