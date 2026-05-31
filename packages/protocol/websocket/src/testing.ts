/**
 * WebSocket Testing Transport
 *
 * Provides WebSocket transport for testing JustScale applications.
 */

import type { TestTransport, TransportState } from '@justscale/testing';
import WebSocket from 'ws';

// ============================================================================
// WebSocket Transport Options
// ============================================================================

export interface WsTransportOptions {
  /** Port the HTTP server is running on (required) */
  port: number
}

// ============================================================================
// WebSocket Test Connection
// ============================================================================

/**
 * A WebSocket test connection with typed messages.
 */
export interface WsTestConnection<TMessage = unknown> {
  /** Send a message to the server */
  send(data: unknown): void

  /** Wait for the next message */
  receive(): Promise<TMessage>

  /** Async iterator for all messages */
  messages(): AsyncIterable<TMessage>

  /** Close the connection */
  close(code?: number, reason?: string): void

  /** Wait for connection to close */
  waitForClose(): Promise<{ code: number; reason: string }>

  /** Current connection state (same as WebSocket.readyState) */
  readonly readyState: number

  /** Whether the connection is open */
  readonly isOpen: boolean
}

/**
 * A buffered WebSocket connection that collects messages in the background.
 *
 * Unlike WsTestConnection where you must actively receive/iterate messages,
 * BufferedWsConnection collects all messages automatically. This is useful
 * for testing scenarios where you need to:
 * - Wait for a message matching a specific predicate
 * - Check if a message was received at any point
 * - Verify that certain messages were NOT received
 */
export interface BufferedWsConnection<TMessage = unknown> {
  /** Send a message to the server */
  send(data: unknown): void

  /** Close the connection */
  close(code?: number, reason?: string): void

  /** Wait for connection to close */
  waitForClose(): Promise<{ code: number; reason: string }>

  /** Current connection state (same as WebSocket.readyState) */
  readonly readyState: number

  /** Whether the connection is open */
  readonly isOpen: boolean

  /**
   * Wait for a message matching the predicate.
   * Checks already-buffered messages first, then waits for new ones.
   *
   * @example
   * ```typescript
   * const msg = await conn.waitFor(m => m.type === 'users');
   * ```
   */
  waitFor(
    predicate: (msg: TMessage) => boolean,
    timeout?: number,
  ): Promise<TMessage>

  /**
   * Check if any buffered message matches the predicate.
   *
   * @example
   * ```typescript
   * assert.ok(!conn.hasMessage(m => m.type === 'error'));
   * ```
   */
  hasMessage(predicate: (msg: TMessage) => boolean): boolean

  /**
   * Get all buffered messages, optionally filtered by predicate.
   *
   * @example
   * ```typescript
   * const errors = conn.getMessages(m => m.type === 'error');
   * ```
   */
  getMessages(predicate?: (msg: TMessage) => boolean): TMessage[]

  /**
   * Clear the message buffer.
   * Useful between test steps to isolate assertions.
   *
   * @example
   * ```typescript
   * await conn.waitFor(m => m.type === 'joined');
   * conn.clearMessages();
   * // Now only check for messages after join
   * ```
   */
  clearMessages(): void
}

// ============================================================================
// WebSocket Transport Client
// ============================================================================

/**
 * WebSocket transport client for testing.
 */
export interface WsTransportClient {
  /** Base WebSocket URL (ws://localhost:port) */
  readonly baseUrl: string

  /**
   * Connect to a WebSocket endpoint.
   *
   * @example
   * ```typescript
   * const conn = await client.ws.connect('/chat/room/123');
   * conn.send({ type: 'message', content: 'Hello' });
   * const msg = await conn.receive();
   * conn.close();
   * ```
   */
  connect<TMessage = unknown>(path: string): Promise<WsTestConnection<TMessage>>

  /**
   * Connect to a WebSocket endpoint with message buffering.
   *
   * Unlike `connect()`, this automatically collects all messages in the background,
   * allowing you to wait for specific messages or check if messages were received.
   *
   * @example
   * ```typescript
   * const conn = await client.ws.connectBuffered<ChatMessage>('/chat?user=alice');
   *
   * conn.send({ command: 'room/123/join' });
   * await conn.waitFor(m => m.type === 'users');
   * conn.clearMessages();
   *
   * conn.send({ command: 'room/123/message', payload: { content: 'hi' } });
   * await conn.waitFor(m => m.type === 'message' && m.content === 'hi');
   *
   * // Verify no errors occurred
   * assert.ok(!conn.hasMessage(m => m.type === 'error'));
   *
   * conn.close();
   * ```
   */
  connectBuffered<TMessage = unknown>(
    path: string,
  ): Promise<BufferedWsConnection<TMessage>>
}

// ============================================================================
// Transport Implementation
// ============================================================================

/**
 * Create a buffered WebSocket connection from a raw connection.
 * Starts background message collection immediately.
 */
function createBufferedConnection<TMessage>(
  conn: WsTestConnection<TMessage>,
): BufferedWsConnection<TMessage> {
  const messages: TMessage[] = [];
  const listeners: Array<(msg: TMessage) => void> = []

  // Start background message collection
  ;(async () => {
    try {
      for await (const msg of conn.messages()) {
        messages.push(msg);
        // Notify any waiting listeners
        for (const listener of listeners) {
          listener(msg);
        }
      }
    } catch {
      // Connection closed
    }
  })();

  return {
    send(data: unknown) {
      conn.send(data);
    },

    close(code?: number, reason?: string) {
      conn.close(code, reason);
    },

    waitForClose() {
      return conn.waitForClose();
    },

    get readyState() {
      return conn.readyState;
    },

    get isOpen() {
      return conn.isOpen;
    },

    waitFor(
      predicate: (msg: TMessage) => boolean,
      timeout = 1000,
    ): Promise<TMessage> {
      // Check existing messages first
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = listeners.indexOf(listener);
          if (idx !== -1) listeners.splice(idx, 1);
          reject(new Error('Timeout waiting for message'));
        }, timeout);

        const listener = (msg: TMessage) => {
          if (predicate(msg)) {
            clearTimeout(timer);
            const idx = listeners.indexOf(listener);
            if (idx !== -1) listeners.splice(idx, 1);
            resolve(msg);
          }
        };

        listeners.push(listener);
      });
    },

    hasMessage(predicate: (msg: TMessage) => boolean): boolean {
      return messages.some(predicate);
    },

    getMessages(predicate?: (msg: TMessage) => boolean): TMessage[] {
      return predicate ? messages.filter(predicate) : [...messages];
    },

    clearMessages() {
      messages.length = 0;
    },
  };
}

/**
 * Create a WebSocket test connection.
 */
function createConnection<TMessage>(ws: WebSocket): WsTestConnection<TMessage> {
  const messageQueue: TMessage[] = [];
  let messageResolver: ((msg: TMessage) => void) | null = null;
  let closeInfo: { code: number; reason: string } | null = null;
  let closeResolver: ((info: { code: number; reason: string }) => void) | null =
    null;
  let closed = false;

  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString()) as TMessage;
      if (messageResolver) {
        messageResolver(parsed);
        messageResolver = null;
      } else {
        messageQueue.push(parsed);
      }
    } catch {
      // Invalid JSON - ignore in tests
    }
  });

  ws.on('close', (code, reason) => {
    closed = true;
    closeInfo = { code, reason: reason.toString() };
    closeResolver?.(closeInfo);
    // Resolve any pending receive with rejection
    if (messageResolver) {
      // We don't have a good way to reject, so just leave it pending
      messageResolver = null;
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket test error:', err);
    closed = true;
  });

  return {
    send(data: unknown) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
      }
    },

    async receive(): Promise<TMessage> {
      if (messageQueue.length > 0) {
        return messageQueue.shift()!;
      }
      if (closed) {
        throw new Error('Connection closed');
      }
      return new Promise((resolve) => {
        messageResolver = resolve;
      });
    },

    async *messages(): AsyncIterable<TMessage> {
      while (!closed) {
        try {
          yield await this.receive();
        } catch {
          break;
        }
      }
    },

    close(code?: number, reason?: string) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(code, reason);
      }
    },

    async waitForClose(): Promise<{ code: number; reason: string }> {
      if (closeInfo) return closeInfo;
      return new Promise((resolve) => {
        closeResolver = resolve;
      });
    },

    get readyState() {
      return ws.readyState;
    },

    get isOpen() {
      return ws.readyState === WebSocket.OPEN;
    },
  };
}

/**
 * WebSocket transport for testing.
 *
 * @example
 * ```typescript
 * import { createTestClient } from '@justscale/testing';
 * import { httpTransport } from '@justscale/http/testing';
 * import { wsTransport } from '@justscale/websocket/testing';
 *
 * const client = await createTestClient(app, {
 *   transports: { http: httpTransport, ws: wsTransport },
 *   transportOptions: {
 *     http: { port: 0 },
 *     ws: { port: 3001 } // Must match HTTP port
 *   }
 * });
 *
 * // Connect to a WebSocket endpoint
 * const conn = await client.ws.connect('/chat/room/123');
 *
 * // Send and receive messages
 * conn.send({ type: 'message', content: 'Hello' });
 * const response = await conn.receive();
 *
 * // Or use async iteration
 * for await (const msg of conn.messages()) {
 *   console.log('Received:', msg);
 *   if (msg.type === 'done') break;
 * }
 *
 * conn.close();
 * await client.close();
 * ```
 */
export const wsTransport: TestTransport<WsTransportClient, WsTransportOptions> =
  {
    async setup(
      state: TransportState,
      options?: WsTransportOptions,
    ): Promise<WsTransportClient> {
      if (!options?.port) {
        throw new Error('wsTransport requires port option');
      }

      const baseUrl = `ws://localhost:${options.port}`;
      const connections: WebSocket[] = [];

      // Register cleanup
      state.cleanupFns.push(async () => {
        for (const ws of connections) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close();
          }
        }
      });

      return {
        baseUrl,

        async connect<TMessage = unknown>(
          path: string,
        ): Promise<WsTestConnection<TMessage>> {
          const ws = new WebSocket(`${baseUrl}${path}`);
          connections.push(ws);

          await new Promise<void>((resolve, reject) => {
            ws.once('open', resolve);
            ws.once('error', reject);
          });

          return createConnection<TMessage>(ws);
        },

        async connectBuffered<TMessage = unknown>(
          path: string,
        ): Promise<BufferedWsConnection<TMessage>> {
          const ws = new WebSocket(`${baseUrl}${path}`);
          connections.push(ws);

          await new Promise<void>((resolve, reject) => {
            ws.once('open', resolve);
            ws.once('error', reject);
          });

          const conn = createConnection<TMessage>(ws);
          return createBufferedConnection(conn);
        },
      };
    },
  };
