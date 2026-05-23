import { type BackendSubscription, defineService, Logger } from '@justscale/core';
import {
  type PostgresPubSub,
  type PostgresPubSubOptions,
  createPostgresPubSub,
} from './pubsub.js';

/**
 * Options for PostgresChannelBackend.
 */
export interface PostgresChannelBackendOptions extends PostgresPubSubOptions {}

/**
 * PostgreSQL channel backend using LISTEN/NOTIFY.
 */
export class PostgresChannelBackend {
  private pubsub: PostgresPubSub | null = null;
  private readonly options: PostgresChannelBackendOptions;
  private readonly logger: { warn(...args: unknown[]): void; error(...args: unknown[]): void };
  private initPromise: Promise<void> | null = null;
  private closed = false;
  // Tail-promise queue that serializes publish() calls on this backend.
  // Without it, concurrent fire-and-forget publishes can hit sql.notify in an
  // order that does not match the call order - per-publisher FIFO breaks.
  private publishChain: Promise<unknown> = Promise.resolve();
  private pendingSubscriptions = new Map<
    string,
    Array<(message: unknown) => void>
  >();

  constructor(options: PostgresChannelBackendOptions, logger?: { warn(...args: unknown[]): void; error(...args: unknown[]): void }) {
    this.options = options;
    this.logger = logger ?? console;
  }

  /**
   * Initialize the pubsub connection lazily.
   */
  private async ensureInitialized(): Promise<PostgresPubSub> {
    if (this.closed) {
      throw new Error(
        'PostgresChannelBackend: backend is closed; cannot subscribe/publish after close()',
      );
    }
    if (this.pubsub) return this.pubsub;

    if (!this.initPromise) {
      this.initPromise = this.initialize();
    }

    await this.initPromise;
    return this.pubsub!;
  }

  private async initialize(): Promise<void> {
    this.pubsub = await createPostgresPubSub(this.options);

    for (const [channelKey, handlers] of this.pendingSubscriptions) {
      for (const handler of handlers) {
        await this.pubsub.subscribe(channelKey, handler);
      }
    }
    this.pendingSubscriptions.clear();
  }

  /**
   * Subscribe to a channel.
   *
   * Returns a `BackendSubscription` whose `ready` resolves once the
   * underlying postgres `LISTEN` has been ACKed (i.e. NOTIFYs published
   * after `await sub.ready` are guaranteed to be observed). Rejects on
   * connect / LISTEN failure — callers that publish-immediately-after-
   * subscribe MUST await `ready` to avoid lost messages.
   */
  subscribe(
    channelKey: string,
    onMessage: (message: unknown) => void,
  ): BackendSubscription {
    const subscriptionPromise = this.ensureInitialized().then((pubsub) =>
      pubsub.subscribe(channelKey, onMessage),
    );
    // ready resolves to void once the underlying subscription handle is
    // returned (postgres-js awaits the LISTEN internally before resolving).
    const ready = subscriptionPromise.then(() => undefined);
    // Tail catch so an un-awaited ready doesn't trip the unhandled-rejection
    // guard. The original promise still rejects for awaiters.
    ready.catch(() => {});

    let unsubscribed = false;

    return {
      ready,
      [Symbol.dispose]: () => {
        if (unsubscribed) return;
        unsubscribed = true;

        subscriptionPromise
          .then((sub) => sub.unsubscribe())
          .catch((err) => {
            this.logger.error('Error unsubscribing from channel:', err);
          });
      },
    };
  }

  /**
   * Publish a message to a channel.
   * Note: This is fire-and-forget since the interface is synchronous, but
   * calls on this backend are serialized through `publishChain` so they
   * reach sql.notify in call order (per-publisher FIFO).
   *
   * Oversize payloads (PG NOTIFY's 8 KB limit) are validated synchronously
   * and THROW to the caller - otherwise they'd vanish into the async
   * catch-and-log below, producing silent message loss.
   */
  publish(channelKey: string, message: unknown): void {
    // After close, drop new publishes silently. Without this gate, a publish
    // queued concurrently with close() - e.g. from an async process emitting
    // a final signal during teardown - would race pubsub.close() and surface
    // as CONNECTION_CLOSED on the underlying socket. JS's single-threaded
    // model guarantees no interleave between this check and the `closed=true`
    // assignment in close().
    if (this.closed) return;

    // JSON has no representation for `undefined` - coerce to `null` so the
    // payload is a valid JSON string and length-checkable. Without this,
    // `JSON.stringify(undefined)` returns `undefined` and the next line
    // throws `TypeError: Cannot read properties of undefined`.
    const normalized = message === undefined ? null : message;
    const payload = typeof normalized === 'string' ? normalized : JSON.stringify(normalized);
    if (payload.length > 8000) {
      throw new Error(
        `Message too large for PostgreSQL NOTIFY (${payload.length} bytes, max 8000). Consider storing the data elsewhere and sending a reference.`,
      );
    }

    this.publishChain = this.publishChain
      .then(() => this.ensureInitialized())
      .then((pubsub) => pubsub.publish(channelKey, normalized))
      .catch((err) => {
        this.logger.error('Error publishing to channel:', err);
      });
  }

  /**
   * Close the backend and release the dedicated LISTEN connection.
   *
   * Idempotent - calling twice is safe. After close, subscribe/publish throw
   * rather than silently spinning up a new connection (which would leak on
   * test teardown).
   *
   * The kernel auto-invokes this on app.stop() via the AbstractChannelBackend
   * resolution path (mirroring AbstractLockProvider). Drains `publishChain`
   * before tearing down `pubsub` so any in-flight NOTIFY completes against a
   * live connection rather than racing pool teardown and surfacing as a
   * CONNECTION_CLOSED unhandled rejection.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.initPromise) {
      try {
        await this.initPromise;
      } catch {
        // initialization failed; nothing to close
      }
    }

    // Drain in-flight publishes before closing the pubsub connection.
    // publishChain is a chain of fire-and-forget .then() handlers each with
    // its own .catch(); awaiting the tail just waits for the chain to settle.
    try {
      await this.publishChain;
    } catch {
      // Per-publish catches already logged; swallow chain rejection here.
    }

    if (this.pubsub) {
      await this.pubsub.close();
      this.pubsub = null;
    }
    this.initPromise = null;
    this.pendingSubscriptions.clear();
  }
}

/**
 * Create a PostgreSQL channel backend service definition.
 *
 * @example
 * ```typescript
 * import { createClusterBuilder, bindService, AbstractChannelBackend } from '@justscale/core';
 * import { createPostgresChannelBackend } from '@justscale/postgres';
 *
 * createClusterBuilder()
 *   .add(bindService(
 *     AbstractChannelBackend,
 *     createPostgresChannelBackend({ connectionString: 'postgresql://...' })
 *   ))
 *   .build()
 * ```
 */
export function createPostgresChannelBackend(
  options: PostgresChannelBackendOptions,
) {
  return defineService({
    inject: { logger: Logger },
    factory: ({ logger }) => new PostgresChannelBackend(options, logger),
  });
}
