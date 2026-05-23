/**
 * Channels Factory
 *
 * Create a typed channels service for pub/sub messaging.
 */

import type { ServiceDef } from '../../core/index.js';
import {
  AbstractChannelBackend,
  type BackendSubscription,
  type ChannelBackend,
} from './backend.js';
import { type ChannelInternal, createChannel } from './channel.js';
import {
  type Channel,
  type ChannelHooks,
  type ChannelKey,
  type ChannelSubscription,
  type ChannelsInstance,
  type ChannelsOptions,
  resolveChannelKey,
} from './types.js';

// Processable protocol support
import {
  encodeProcessable,
  decodeProcessable,
} from '../../process/serialization.js';

const PAYLOAD_TAG = '__$p';

/** Encode a message for cross-node delivery using Processable protocol */
function encodeForBackend(
  message: unknown,
  descriptor: ProcessDescriptor | undefined,
): unknown {
  // Use explicit descriptor if provided (e.g. for proto schemas)
  if (descriptor) {
    return { [PAYLOAD_TAG]: descriptor.name, d: descriptor.serialize(message as any) };
  }
  // Auto-detect from message value (class instances, objects with [Symbol.process])
  return encodeProcessable(message);
}

/** Decode a message received from the backend */
function decodeFromBackend(
  message: unknown,
  descriptor: ProcessDescriptor | undefined,
): unknown {
  // Check for Processable-encoded message (from explicit descriptor encoding)
  if (
    message != null &&
    typeof message === 'object' &&
    PAYLOAD_TAG in (message as any)
  ) {
    const encoded = message as Record<string, unknown>;
    const name = encoded[PAYLOAD_TAG] as string;
    // Use explicit descriptor if name matches
    if (descriptor && descriptor.name === name) {
      return descriptor.deserialize(encoded.d as any);
    }
  }
  // Fall back to generic decode (handles both __$p tagged and non-tagged)
  return decodeProcessable(message);
}

/**
 * Dependencies for channels service.
 */
type ChannelsDeps = { backend: typeof AbstractChannelBackend };

/**
 * Channels service definition.
 * Injectable into services and controllers via defineService inject.
 * Extends ServiceDef for DI compatibility.
 */
export interface ChannelsDef<TMessage>
  extends ServiceDef<ChannelsInstance<TMessage>, ChannelsDeps> {
  withHooks(hooks: ChannelHooks): ChannelsDef<TMessage>
}

/**
 * Create a typed channels service.
 *
 * Channels provide pub/sub messaging where:
 * - Subscribers receive messages via async iterables
 * - Publishers broadcast to all subscribers of a channel
 * - Hooks enable cluster integration for multi-node deployments
 *
 * @example Basic usage
 * ```typescript
 * // Define channels service
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
 *
 * @example With cluster hooks
 * ```typescript
 * const RoomChannels = createChannels<ServerMessage>().withHooks({
 *   onFirstSubscriber: async (key) => {
 *     // Register this node's interest at cluster level
 *     await clusterRegistry.subscribe(Room.ref`${key}`);
 *   },
 *   onLastUnsubscribe: async (key) => {
 *     // Unregister when no local subscribers remain
 *     await clusterRegistry.unsubscribe(Room.ref`${key}`);
 *   },
 *   onPublish: (key, msg) => {
 *     // Broadcast to other nodes via event bus - wire format carries
 *     // the key; each recipient rebuilds its own typed ref.
 *     events.emit(`room.${msg.type}`, { roomKey: key, ...msg });
 *   },
 * });
 * ```
 *
 * @example In contextual controller
 * ```typescript
 * const join = Procedure("room/:roomId/join")
 *   .handle(async function*({ params }) {
 *     // Boundary: convert the raw path param to a typed reference.
 *     const room = Room.ref`${params.roomId}`;
 *     const subscription = channels.subscribe(room);
 *
 *     // Stream messages to client
 *     for await (const msg of subscription) {
 *       yield msg;
 *     }
 *     // Subscription auto-cleaned when generator exits
 *   });
 * ```
 */
export function createChannels<TMessage>(
  options: ChannelsOptions = {},
): ChannelsDef<TMessage> {
  const prefix = options.prefix ?? '';

  // Trace helper
  const TRACE_ENABLED = process.env.JUSTSCALE_TRACE === '1' || process.env.JUSTSCALE_TRACE === 'true';
  function trace(message: string, data?: Record<string, unknown>): void {
    if (!TRACE_ENABLED) return;
    const timestamp = new Date().toISOString();
    const dataStr = data ? ' ' + JSON.stringify(data) : '';
    console.debug(`[${timestamp}] [TRACE] [Channels] ${message}${dataStr}`);
  }

  const descriptor = options.descriptor;

  const createInstance = (
    hooks: ChannelHooks | undefined,
    backend: ChannelBackend,
  ): ChannelsInstance<TMessage> => {
    // Unique instance ID for debugging
    const instanceId = `channels_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    trace('createInstance', { instanceId, prefix });

    // Channel storage (lazy creation)
    const channels = new Map<string, ChannelInternal<TMessage>>();
    // Backend subscriptions (for cleanup)
    const backendSubs = new Map<string, BackendSubscription>();

    // Apply prefix to channel key for backend communication
    const toBackendKey = (channelKey: string) => `${prefix}${channelKey}`;

    // Safely invoke a user hook: swallow sync throws and async rejections.
    // User hooks are transport-side observability and must never crash the
    // framework's pub/sub path.
    const safeInvokeHook = (fn: (() => void | Promise<void>) | undefined, label: string): void => {
      if (!fn) return;
      try {
        const result = fn();
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch((err) => {
            trace('userHook.asyncRejected', { instanceId, hook: label, error: String(err) });
            return undefined;
          });
        }
      } catch (err) {
        trace('userHook.syncThrew', { instanceId, hook: label, error: String(err) });
      }
    };

    // Wrap hooks to integrate with backend
    const effectiveHooks: ChannelHooks = {
      onFirstSubscriber: (channelKey: string): Promise<void> => {
        // Call user hook first (errors swallowed - observability only,
        // independent of backend readiness so a buggy user hook can't break
        // signal delivery).
        safeInvokeHook(
          hooks?.onFirstSubscriber ? () => hooks.onFirstSubscriber!(channelKey) : undefined,
          'onFirstSubscriber',
        );

        // Subscribe to backend for remote messages (with prefix). Returning
        // the backend's `.ready` here is what makes ChannelSubscription.ready
        // wait for the LISTEN/SUBSCRIBE ACK — without it,
        // publish-immediately-after-subscribe would race the wire setup.
        const backendKey = toBackendKey(channelKey);
        trace('onFirstSubscriber.backendSubscribe', { instanceId, channelKey, backendKey });
        const sub = backend.subscribe(backendKey, (msg) => {
          // Decode Processable-encoded messages from remote nodes
          const decoded = decodeFromBackend(msg, descriptor);
          trace('backendCallback', { instanceId, channelKey, backendKey, hasChannel: channels.has(channelKey), subscriberCount: channels.get(channelKey)?.subscriberCount ?? 0 });
          const channel = channels.get(channelKey);
          if (channel && channel.subscriberCount > 0) {
            channel.deliverLocal(decoded as TMessage);
          }
        });
        backendSubs.set(channelKey, sub);
        return sub.ready;
      },

      onLastUnsubscribe: (channelKey: string) => {
        // Unsubscribe from backend
        const sub = backendSubs.get(channelKey);
        if (sub) {
          sub[Symbol.dispose]();
          backendSubs.delete(channelKey);
        }

        // Call user hook (errors swallowed - observability only)
        safeInvokeHook(
          hooks?.onLastUnsubscribe ? () => hooks.onLastUnsubscribe!(channelKey) : undefined,
          'onLastUnsubscribe',
        );
      },

      onPublish: (channelKey: string, message: unknown) => {
        // Encode message for cross-node delivery (Processable protocol)
        const encoded = encodeForBackend(message, descriptor);
        // Publish to backend for remote delivery (with prefix)
        const backendKey = toBackendKey(channelKey);
        trace('onPublish.toBackend', { instanceId, channelKey, backendKey });
        backend.publish(backendKey, encoded);

        // Call user hook with original message, not encoded (errors swallowed)
        safeInvokeHook(
          hooks?.onPublish ? () => hooks.onPublish!(channelKey, message) : undefined,
          'onPublish',
        );
      },
    };

    const getOrCreateChannel = (
      channelKey: string,
    ): ChannelInternal<TMessage> => {
      let channel = channels.get(channelKey);
      if (!channel) {
        channel = createChannel<TMessage>(channelKey, effectiveHooks);
        channels.set(channelKey, channel);
      }
      return channel;
    };

    return {
      configureHooks(_hooks: ChannelHooks): void {
      },

      subscribe(channelKey: ChannelKey): ChannelSubscription<TMessage> {
        const key = resolveChannelKey(channelKey);
        trace('subscribe', { instanceId, channelKey: key });
        const channel = getOrCreateChannel(key);
        return channel.subscribe();
      },

      publish(channelKey: ChannelKey, message: TMessage): void {
        const key = resolveChannelKey(channelKey);
        trace('publish', { instanceId, channelKey: key, subscriberCount: channels.get(key)?.subscriberCount ?? 0 });
        const channel = getOrCreateChannel(key);
        channel.publish(message);
      },

      deliverRemote(channelKey: ChannelKey, message: TMessage): void {
        const key = resolveChannelKey(channelKey);
        trace('deliverRemote', { instanceId, channelKey: key, hasChannel: channels.has(key), subscriberCount: channels.get(key)?.subscriberCount ?? 0 });
        // Decode Processable-encoded messages
        const decoded = decodeFromBackend(message, descriptor) as TMessage;
        // Only deliver if we have subscribers (otherwise ignore)
        const channel = channels.get(key);
        if (channel && channel.subscriberCount > 0) {
          // Deliver to local subscribers without triggering onPublish hook
          // (to avoid re-broadcasting back to cluster)
          channel.deliverLocal(decoded);
        }
      },

      getChannel(channelKey: ChannelKey): Channel<TMessage> {
        return getOrCreateChannel(resolveChannelKey(channelKey));
      },

      hasSubscribers(channelKey: ChannelKey): boolean {
        const channel = channels.get(resolveChannelKey(channelKey));
        return channel ? channel.subscriberCount > 0 : false;
      },

      getActiveChannels(): string[] {
        return Array.from(channels.entries())
          .filter(([, ch]) => ch.subscriberCount > 0)
          .map(([key]) => key);
      },

      close(): void {
        // Dispose all backend subscriptions
        for (const [, sub] of backendSubs) {
          sub[Symbol.dispose]();
        }
        backendSubs.clear();
        channels.clear();
      },
    };
  };

  return {
    deps: { backend: AbstractChannelBackend },
    factory: ({ backend }: { backend: ChannelBackend }) =>
      createInstance(options.hooks, backend),

    withHooks(hooks: ChannelHooks): ChannelsDef<TMessage> {
      return createChannels<TMessage>({ ...options, hooks });
    },
  } as unknown as ChannelsDef<TMessage>;
}
