/**
 * Channel Types
 *
 * Core types for the channels pub/sub system.
 */

/**
 * A channel key: a plain string or anything with an `identifier` property
 * (e.g. a Reference from a model).
 */
export type ChannelKey = string | { readonly identifier: string };

/** Resolve a ChannelKey to a plain string. */
export function resolveChannelKey(key: ChannelKey): string {
  return typeof key === 'string' ? key : key.identifier;
}

/**
 * A subscription to a channel.
 * Implements AsyncIterable for streaming messages and Disposable for cleanup.
 */
export interface ChannelSubscription<TMessage>
  extends AsyncIterable<TMessage>,
  Disposable {
  /** Unsubscribe from the channel */
  unsubscribe(): void

  /** The channel key this subscription is for */
  readonly channelKey: string

  /** Whether this subscription is still active */
  readonly active: boolean

  /**
   * Resolves when the underlying backend subscription has been ACKed (e.g.
   * Postgres LISTEN, Redis SUBSCRIBE), AND the cluster `onFirstSubscriber`
   * hook (if any) has completed. Messages published before this settles may
   * be missed at the backend level.
   *
   * Reject on backend connect / listen failure — callers that
   * publish-immediately-after-subscribe MUST `await sub.ready` first.
   *
   * For local-only channels (no remote backend), resolves synchronously.
   */
  readonly ready: Promise<void>
}

/**
 * A single channel instance that can be published to and subscribed from.
 */
export interface Channel<TMessage> {
  /** The channel key */
  readonly key: string

  /** Current number of local subscribers */
  readonly subscriberCount: number

  /** Subscribe to this channel */
  subscribe(): ChannelSubscription<TMessage>

  /** Publish a message to all subscribers */
  publish(message: TMessage): void
}

/**
 * Hooks for cluster integration.
 * Called when subscription state changes on this node.
 */
export interface ChannelHooks {
  /**
   * Called when the first subscriber joins a channel on this node.
   * Use this to register interest at the cluster level.
   */
  onFirstSubscriber?: (channelKey: string) => void | Promise<void>

  /**
   * Called when the last subscriber leaves a channel on this node.
   * Use this to unregister interest at the cluster level.
   */
  onLastUnsubscribe?: (channelKey: string) => void | Promise<void>

  /**
   * Called when a message is published locally.
   * Use this to broadcast to other cluster nodes.
   */
  onPublish?: (channelKey: string, message: unknown) => void | Promise<void>
}

/**
 * Options for creating a channels service.
 */
export interface ChannelsOptions {
  /**
   * Prefix for channel keys when communicating with the backend.
   * E.g., "room:" means channel "123" becomes "room:123" for the backend.
   * @default ""
   */
  prefix?: string

  /** Hooks for cluster integration */
  hooks?: ChannelHooks

  /**
   * Process descriptor for encoding/decoding messages via the Processable protocol.
   *
   * When provided, messages are encoded before cross-node delivery and decoded
   * on receipt. This enables efficient binary serialization for proto types.
   *
   * If not provided, messages from class instances with static [Symbol.process]
   * are automatically detected and encoded at publish time.
   *
   * @example Proto channels
   * ```typescript
   * import { ChatEventSchema } from './events.proto'
   * const RoomChannels = createChannels<ChatEvent>({
   *   descriptor: ChatEventSchema[Symbol.process],
   * })
   * ```
   */
  descriptor?: ProcessDescriptor
}

/**
 * Runtime instance of a channels service.
 */
export interface ChannelsInstance<TMessage> {
  /** Configure hooks at runtime. Prefer withHooks() on the ChannelsDef instead. */
  configureHooks(hooks: ChannelHooks): void

  /**
   * Subscribe to a channel by key.
   * Returns an async iterable subscription.
   *
   * @example
   * ```typescript
   * const subscription = channels.subscribe(Room.ref`123`);
   * for await (const msg of subscription) {
   *   client.send(msg);
   * }
   * ```
   */
  subscribe(channelKey: ChannelKey): ChannelSubscription<TMessage>

  /**
   * Publish a message to a channel.
   * Message is delivered to all local subscribers and (via hooks) to remote nodes.
   *
   * @example
   * ```typescript
   * channels.publish(Room.ref`123`, { type: "message", content: "Hello!" });
   * ```
   */
  publish(channelKey: ChannelKey, message: TMessage): void

  /**
   * Deliver a message from a remote node.
   * Use this in your cluster event handler.
   *
   * @example
   * ```typescript
   * // In event controller
   * onRoomEvent: Events.on("room.*").handle(({ payload }) => {
   *   channels.deliverRemote(payload.room, payload);
   * })
   * ```
   */
  deliverRemote(channelKey: ChannelKey, message: TMessage): void

  /**
   * Get a channel by key (creates if not exists).
   */
  getChannel(channelKey: ChannelKey): Channel<TMessage>

  /**
   * Check if a channel has any local subscribers.
   */
  hasSubscribers(channelKey: ChannelKey): boolean

  /**
   * Get all channel keys that have subscribers.
   */
  getActiveChannels(): string[]

  /**
   * Close the channels instance and release all resources.
   * Disposes all backend subscriptions and clears channel state.
   * Call this when shutting down to ensure clean exit.
   */
  close(): void
}
