/**
 * Channel Implementation
 *
 * A single pub/sub channel with subscription tracking.
 */

import type { Channel, ChannelHooks, ChannelSubscription } from './types.js';

// Trace logging
const TRACE_ENABLED = process.env.JUSTSCALE_TRACE === '1' || process.env.JUSTSCALE_TRACE === 'true';
function trace(message: string, data?: Record<string, unknown>): void {
  if (!TRACE_ENABLED) return;
  const timestamp = new Date().toISOString();
  const dataStr = data ? ' ' + JSON.stringify(data) : '';
  console.debug(`[${timestamp}] [TRACE] [Channel] ${message}${dataStr}`);
}

/**
 * Extended channel interface with internal delivery method.
 */
export interface ChannelInternal<TMessage> extends Channel<TMessage> {
  /** Deliver a message to subscribers without triggering onPublish hook */
  deliverLocal(message: TMessage): void
}

/**
 * Simple hash function for message deduplication.
 */
function hashMessage(message: unknown): string {
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

/**
 * Create a channel instance.
 */
export function createChannel<TMessage>(
  key: string,
  hooks?: ChannelHooks,
): ChannelInternal<TMessage> {
  // Active subscribers (callbacks that receive messages)
  const subscribers = new Set<(msg: TMessage) => void>();

  // Shared readiness for all subscribers on this channel. Set by the first
  // subscriber to the onFirstSubscriber hook's promise (which transitively
  // awaits backend.subscribe.ready and any cluster registry hook). All
  // subsequent subscribers attach to the same promise — they share the
  // wire-level subscription, so they're "ready" when it is. Reset on last
  // unsubscribe so a re-subscribe (incl. retry-after-failure) re-issues.
  let firstSubscriberReady: Promise<void> = Promise.resolve();

  // Track recently published messages to avoid self-delivery duplicates.
  // When a message is published locally, it's delivered to subscribers immediately.
  // Then the onPublish hook sends it to the backend (Postgres NOTIFY), which
  // loops back to deliverLocal on the same instance. We skip these duplicates.
  //
  // A Map<hash, count> (multiset) is used instead of a Set so that N identical
  // sync publishes each claim exactly one loopback echo without colliding.
  // A plain Set would collapse two identical hashes into one entry, making the
  // second loopback echo appear to be a remote message and delivering a duplicate.
  const recentlyPublished = new Map<string, number>();

  return {
    get key() {
      return key;
    },

    get subscriberCount() {
      return subscribers.size;
    },

    subscribe(): ChannelSubscription<TMessage> {
      trace('subscribe', { key, currentSubscribers: subscribers.size });
      // Message queue for this subscription
      const queue: TMessage[] = [];
      let resolve: (() => void) | null = null;
      let disposed = false;

      // Callback that receives messages
      const callback = (msg: TMessage) => {
        trace('callback', { key, disposed, queueLength: queue.length, msgType: (msg as Record<string, unknown>).type });
        if (disposed) return;
        queue.push(msg);
        if (resolve) {
          trace('callback.resolving', { key });
          resolve();
          resolve = null;
        }
      };

      // Track if this is the first subscriber
      const wasEmpty = subscribers.size === 0;

      // Register subscriber
      subscribers.add(callback);
      trace('subscribe.added', { key, newCount: subscribers.size, wasEmpty });

      // Notify hook if first subscriber. Capture the resulting promise as
      // the channel's `firstSubscriberReady` so subscribers can `await
      // sub.ready` to block on backend ACK + cluster registry. We
      // intentionally let the hook's rejection propagate via `.ready`
      // (callers expect a publish-immediately-after-subscribe race signal),
      // and tail-catch here only to silence the unhandled-rejection guard
      // for fire-and-forget callers who never await `.ready`.
      if (wasEmpty && hooks?.onFirstSubscriber) {
        firstSubscriberReady = Promise.resolve(hooks.onFirstSubscriber(key));
        firstSubscriberReady.catch(() => {});
      }
      const subscriptionReady = firstSubscriberReady;

      // Cleanup function
      const cleanup = () => {
        if (disposed) return;
        disposed = true;

        // Trace cleanup with stack trace
        if (TRACE_ENABLED) {
          const stack = new Error().stack?.split('\n').slice(2, 8).join('\n');
          trace('cleanup', { key, subscribersBeforeDelete: subscribers.size, stack });
        }

        // Unregister subscriber
        subscribers.delete(callback);

        // Wake up any waiting iterator so it can exit
        if (resolve) {
          resolve();
          resolve = null;
        }

        // Notify hook if last subscriber
        if (subscribers.size === 0 && hooks?.onLastUnsubscribe) {
          Promise.resolve(hooks.onLastUnsubscribe(key)).catch(() => {
            // Swallow errors in hooks
          });
          // Reset readiness so a future first-subscribe re-issues the hook.
          // Without this, a retry-after-failure would inherit the rejected
          // promise from the previous attempt.
          firstSubscriberReady = Promise.resolve();
        }
      };

      // Create the subscription
      const subscription: ChannelSubscription<TMessage> = {
        async *[Symbol.asyncIterator]() {
          try {
            while (!disposed) {
              // Wait for messages if queue is empty
              if (queue.length === 0) {
                await new Promise<void>((r) => {
                  resolve = r;
                });
              }

              // Yield all queued messages
              while (queue.length > 0 && !disposed) {
                yield queue.shift()!;
              }
            }
          } finally {
            // Cleanup when generator exits (normal, return, or throw)
            cleanup();
          }
        },

        get channelKey() {
          return key;
        },

        get active() {
          return !disposed;
        },

        ready: subscriptionReady,
        unsubscribe: cleanup,
        [Symbol.dispose]: cleanup,
      };

      return subscription;
    },

    publish(message: TMessage): void {
      trace('publish', { key, subscriberCount: subscribers.size, msgType: (message as Record<string, unknown>).type });

      // Track this message to avoid self-delivery duplicates.
      // Increment the counter for this hash so each publish claims exactly
      // one future loopback echo.
      const hash = hashMessage(message);
      recentlyPublished.set(hash, (recentlyPublished.get(hash) ?? 0) + 1);

      // Clean up the counter after a short delay to prevent memory leak.
      // The decrement on deliverLocal handles normal cases; this is the fallback
      // for backends that never echo back (e.g. unit tests with a no-op backend).
      setTimeout(() => {
        const count = recentlyPublished.get(hash);
        if (count !== undefined) {
          if (count <= 1) {
            recentlyPublished.delete(hash);
          } else {
            recentlyPublished.set(hash, count - 1);
          }
        }
      }, 5_000);

      // Deliver to all local subscribers
      for (const callback of subscribers) {
        callback(message);
      }
      trace('publish.delivered', { key });

      // Notify hook for cluster broadcast.
      // Wrap in try/catch before Promise.resolve so synchronous throws from
      // encoding (e.g. circular structures) are swallowed the same way async
      // rejections are - backend publish failures must not crash local delivery.
      if (hooks?.onPublish) {
        try {
          Promise.resolve(hooks.onPublish(key, message)).catch(() => {
            // Swallow async errors in hooks
          });
        } catch {
          // Swallow sync errors in hooks
        }
      }
    },

    deliverLocal(message: TMessage): void {
      // Deliver to all local subscribers WITHOUT triggering onPublish hook
      // Used for messages received from remote nodes

      // Skip if this message was just published locally (self-delivery duplicate).
      // Decrement the counter rather than deleting outright: if the same message
      // was published N times, each loopback echo consumes exactly one slot.
      const hash = hashMessage(message);
      const count = recentlyPublished.get(hash);
      if (count !== undefined && count > 0) {
        trace('deliverLocal.skipped', { key, reason: 'self-delivery duplicate' });
        if (count <= 1) {
          recentlyPublished.delete(hash);
        } else {
          recentlyPublished.set(hash, count - 1);
        }
        return;
      }

      trace('deliverLocal', { key, subscriberCount: subscribers.size, msgType: (message as Record<string, unknown>).type });
      for (const callback of subscribers) {
        callback(message);
      }
    },
  };
}
