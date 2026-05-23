import postgres, { type Sql, type Options } from 'postgres';
import type { PostgresClientOptions } from '../client/client.js';
import { hashStringToBigInt } from '../utils/hash.js';

/**
 * PostgreSQL LISTEN/NOTIFY channel names are limited to 63 characters.
 * Longer names are automatically hashed to fit within this limit.
 */
const MAX_CHANNEL_NAME_LENGTH = 63;

interface SimpleLogger {
  debug(message: string, attributes?: Record<string, unknown>): void
  info(message: string, attributes?: Record<string, unknown>): void
  warn(message: string, attributes?: Record<string, unknown>): void
  error(message: string, attributes?: Record<string, unknown>): void
}

// ============================================================================
// Types
// ============================================================================

/**
 * Message handler callback.
 * Note: Unlike Redis's (channel, message) signature, Postgres handlers receive only the message.
 * The ChannelBackend interface abstracts this difference - consumers use channels, not raw pub/sub.
 */
export type MessageHandler = (message: unknown) => void | Promise<void>;

export interface Subscription extends Disposable {
  /** The channel name */
  readonly channel: string
  unsubscribe(): Promise<void>
}

export interface PostgresPubSubOptions extends PostgresClientOptions {
  /** Prefix for channel names (default: none) */
  channelPrefix?: string
  /** Parse JSON messages (default: true) */
  parseJson?: boolean
}

/**
 * PostgreSQL pub/sub using LISTEN/NOTIFY.
 *
 * Uses a dedicated connection for listening (required by PostgreSQL).
 *
 * @example
 * ```typescript
 * const pubsub = await createPostgresPubSub({
 *   connectionString: process.env.DATABASE_URL
 * });
 *
 * // Subscribe
 * const sub = await pubsub.subscribe('user-events', (message) => {
 *   console.log('Received:', message);
 * });
 *
 * // Publish
 * await pubsub.publish('user-events', { userId: '123', action: 'login' });
 *
 * // Unsubscribe
 * await sub.unsubscribe();
 * // Or use `using` keyword
 * using sub2 = await pubsub.subscribe('other-channel', handler);
 *
 * // Cleanup
 * await pubsub.close();
 * ```
 */
export class PostgresPubSub {
  private readonly sql: Sql<{}>;
  private readonly prefix: string;
  private readonly parseJson: boolean;
  private readonly logger: SimpleLogger;
  private readonly subscriptions = new Map<string, Set<MessageHandler>>();
  private readonly listenHandles = new Map<
    string,
    { unlisten: () => Promise<void> }
  >();
  private closed = false;

  constructor(
    sql: Sql<{}>,
    options: PostgresPubSubOptions,
    logger: SimpleLogger,
  ) {
    this.sql = sql;
    this.prefix = options.channelPrefix ?? '';
    this.parseJson = options.parseJson ?? true;
    this.logger = logger;
  }

  /**
   * Get the full channel name with prefix.
   * Long channel names are automatically hashed to fit PostgreSQL's 63-char limit.
   */
  private getFullChannel(channel: string): string {
    const fullChannel = this.prefix ? `${this.prefix}:${channel}` : channel;

    // PostgreSQL LISTEN/NOTIFY channel names are limited to 63 characters
    if (fullChannel.length <= MAX_CHANNEL_NAME_LENGTH) {
      return fullChannel;
    }

    // Hash the channel name to fit within the limit
    // Format: first 20 chars + "_h_" + hash (up to 17 chars) = 40 chars max
    const hash = hashStringToBigInt(fullChannel).toString(36);
    const prefix = fullChannel.slice(0, 20);
    return `${prefix}_h_${hash}`;
  }

  private handleMessage(channel: string, payload: string): void {
    const handlers = this.subscriptions.get(channel);
    if (!handlers || handlers.size === 0) return;

    let message: unknown = payload;

    if (this.parseJson) {
      try {
        message = JSON.parse(payload);
      } catch {
        message = payload;
      }
    }

    for (const handler of handlers) {
      try {
        const result = handler(message);
        if (result instanceof Promise) {
          result.catch((err) => {
            this.logger.error('PubSub handler error', { channel, error: err });
          });
        }
      } catch (err) {
        this.logger.error('PubSub handler error', { channel, error: err });
      }
    }
  }

  async subscribe(
    channel: string,
    handler: MessageHandler,
  ): Promise<Subscription> {
    const fullChannel = this.getFullChannel(channel);

    let handlers = this.subscriptions.get(fullChannel);
    if (!handlers) {
      handlers = new Set();
      this.subscriptions.set(fullChannel, handlers);

      // postgres.js listen returns { unlisten: () => Promise<void> }
      const listenResult = await this.sql.listen(fullChannel, (payload) => {
        this.handleMessage(fullChannel, payload);
      });

      this.listenHandles.set(
        fullChannel,
        listenResult as { unlisten: () => Promise<void> },
      );
    }
    handlers.add(handler);

    this.logger.debug('Subscribed to channel', { channel: fullChannel });

    const subscription: Subscription = {
      channel,
      unsubscribe: async () => {
        handlers!.delete(handler);

        if (handlers!.size === 0) {
          this.subscriptions.delete(fullChannel);
          const handle = this.listenHandles.get(fullChannel);
          if (handle) {
            await handle.unlisten();
            this.listenHandles.delete(fullChannel);
          }
          this.logger.debug('Unsubscribed from channel', {
            channel: fullChannel,
          });
        }
      },
      [Symbol.dispose]: () => {
        subscription.unsubscribe().catch((err) => {
          this.logger.error('Error unsubscribing', { channel, error: err });
        });
      },
    };

    return subscription;
  }

  /**
   * Publish a message to a channel.
   * @throws Error if message exceeds PostgreSQL NOTIFY's ~8 KB payload limit
   */
  async publish(channel: string, message: unknown): Promise<void> {
    const fullChannel = this.getFullChannel(channel);

    const payload =
      typeof message === 'string' ? message : JSON.stringify(message);

    if (payload.length > 8000) {
      throw new Error(
        `Message too large for PostgreSQL NOTIFY (${payload.length} bytes, max 8000). Consider storing the data elsewhere and sending a reference.`,
      );
    }

    await this.sql.notify(fullChannel, payload);

    this.logger.debug('Published to channel', {
      channel: fullChannel,
      size: payload.length,
    });
  }

  get channels(): string[] {
    return Array.from(this.subscriptions.keys()).map((ch) =>
      this.prefix ? ch.slice(this.prefix.length + 1) : ch,
    );
  }

  /**
   * Close the pub/sub connection. Idempotent.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Unlisten all channels
    for (const [_channel, handle] of this.listenHandles) {
      await handle.unlisten();
    }
    this.listenHandles.clear();
    this.subscriptions.clear();

    await this.sql.end();
    this.logger.debug('PostgresPubSub closed');
  }
}

function buildPubSubPostgresOptions(
  options: PostgresPubSubOptions,
): Options<{}> {
  return {
    max: 1, // PubSub needs only one connection
    idle_timeout: 0, // Don't timeout idle connection
    connect_timeout: options.connectTimeout ?? 10,
  };
}

/**
 * Create a PostgreSQL pub/sub instance.
 *
 * @example
 * ```typescript
 * const pubsub = await createPostgresPubSub({
 *   connectionString: process.env.DATABASE_URL,
 *   channelPrefix: 'myapp',
 * });
 *
 * // Subscribe with Disposable
 * using sub = await pubsub.subscribe('events', (msg) => console.log(msg));
 *
 * // Publish
 * await pubsub.publish('events', { type: 'user_created', userId: '123' });
 * ```
 */
export async function createPostgresPubSub(
  options: PostgresPubSubOptions,
  logger?: SimpleLogger,
): Promise<PostgresPubSub> {
  const pgOptions = buildPubSubPostgresOptions(options);

  const sql = options.connectionString
    ? postgres(options.connectionString, pgOptions)
    : postgres({
      ...pgOptions,
      host: options.host ?? 'localhost',
      port: options.port ?? 5432,
      database: options.database,
      username: options.username,
      password: options.password,
      ssl: options.ssl,
    });

  const defaultLogger: SimpleLogger = {
    debug: () => {},
    info: () => {},
    warn: console.warn,
    error: console.error,
  };

  return new PostgresPubSub(sql, options, logger ?? defaultLogger);
}
