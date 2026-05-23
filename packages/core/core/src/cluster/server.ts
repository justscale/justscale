/**
 * Cluster server - listens for incoming connections and dispatches protocol messages.
 * Method handlers are registered by plugins.
 */

import { EventEmitter } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { setInMap, type App } from '../index.js';
import {
  type Message,
  type PromptRequest,
  type PromptResponseData,
  type PromptType,
  Methods,
  ErrorCodes,
  createResponse,
  createErrorResponse,
  createStream,
  isRequest,
  isStream,
} from './protocol.js';
import {
  SocketTransport,
  type Transport,
  getSocketPath,
  cleanupSocket,
  getPeerCredentials,
} from './transport.js';

export interface ServerOptions {
  /** Socket path (auto-generated if not provided) */
  socketPath?: string;
  /** App root directory for socket path generation */
  appRoot?: string;
}

export interface ServerEvents {
  listening: [path: string];
  connection: [transport: Transport];
  error: [error: Error];
  close: [];
}

/** Method handler function */
export type MethodHandler = (
  params: Record<string, unknown> | undefined,
  context: HandlerContext
) => Promise<unknown>;

/** Context passed to method handlers */
export interface HandlerContext {
  /** The transport this request came from */
  transport: Transport;
  /** Send a stream message */
  stream: (channel: string, data: unknown, done?: boolean) => Promise<void>;
  /** Request user input via the client */
  prompt: (type: PromptType, message: string, options?: PromptOptions) => Promise<string | boolean | null>;
  /** The JustScale app (if attached) */
  app?: App<any>;
  /** The cluster server instance */
  server: ClusterServer;
}

export interface PromptOptions {
  defaultValue?: string;
  choices?: Array<{ label: string; value: string }>;
}

export class ClusterServer extends EventEmitter {
  private server: Server | null = null;
  private socketPath: string;
  private connections = new Set<Transport>();
  private handlers = new Map<string, MethodHandler>();
  private app?: App<any>;
  /** Pending prompt responses: requestId -> (promptId -> resolver) */
  private pendingPrompts = new Map<string, Map<string, (response: PromptResponseData) => void>>();
  /** Maps transport to the set of request IDs it owns */
  private transportRequests = new Map<Transport, Set<string>>();
  private promptCounter = 0;

  constructor(options: ServerOptions = {}) {
    super();
    this.socketPath = options.socketPath ?? getSocketPath(options.appRoot ?? process.cwd());

    // Register built-in handlers
    this.registerBuiltinHandlers();
  }

  /**
   * Attach a JustScale app for CLI command execution.
   */
  attachApp(app: App<any>): this {
    this.app = app;
    return this;
  }

  /**
   * Register a method handler.
   */
  handle(method: string, handler: MethodHandler): this {
    this.handlers.set(method, handler);
    return this;
  }

  /**
   * Start listening for connections.
   */
  async listen(): Promise<string> {
    if (this.server) {
      throw new Error('Server already listening');
    }

    // Clean up existing socket
    cleanupSocket(this.socketPath);

    return new Promise((resolve, reject) => {
      this.server = createServer((socket: Socket) => {
        this.handleConnection(socket);
      });

      this.server.on('error', (error) => {
        this.emit('error', error);
        reject(error);
      });

      this.server.listen(this.socketPath, () => {
        this.emit('listening', this.socketPath);
        resolve(this.socketPath);
      });
    });
  }

  /**
   * Stop the server.
   */
  async close(): Promise<void> {
    // Close all connections
    const closePromises = [...this.connections].map((t) => t.close());
    await Promise.all(closePromises);
    this.connections.clear();

    // Close server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    // Clean up socket file
    cleanupSocket(this.socketPath);

    this.emit('close');
  }

  /**
   * Get the socket path.
   */
  get path(): string {
    return this.socketPath;
  }

  /**
   * Check if listening.
   */
  get listening(): boolean {
    return this.server?.listening ?? false;
  }

  private handleConnection(socket: Socket): void {
    // Get peer credentials for auth
    const creds = getPeerCredentials(socket);
    const transport = new SocketTransport({
      socket,
      auth: creds ? { type: 'socket', ...creds } : { type: 'socket' },
    });

    this.connections.add(transport);
    this.emit('connection', transport);

    transport.on('message', (message) => {
      this.handleMessage(message, transport);
    });

    transport.on('error', (error) => {
      this.emit('error', error);
    });

    transport.on('close', () => {
      this.connections.delete(transport);

      // Reject all pending prompt resolvers for this transport
      const requestIds = this.transportRequests.get(transport);
      if (requestIds) {
        for (const reqId of requestIds) {
          const resolvers = this.pendingPrompts.get(reqId);
          if (resolvers) {
            for (const [, reject] of resolvers) {
              reject({ cancelled: true, value: null } as PromptResponseData);
            }
            this.pendingPrompts.delete(reqId);
          }
        }
        this.transportRequests.delete(transport);
      }
    });
  }

  private async handleMessage(message: Message, transport: Transport): Promise<void> {
    if (isStream(message) && message.channel === 'prompt_response' && message.id) {
      const requestPrompts = this.pendingPrompts.get(message.id);
      if (requestPrompts) {
        const data = message.data as PromptResponseData;
        const resolver = requestPrompts.get(data.promptId);
        if (resolver) {
          resolver(data);
          requestPrompts.delete(data.promptId);
        }
      }
      return;
    }

    if (!isRequest(message)) {
      return;
    }

    const { id, method, params } = message;
    if (!id) {
      return;
    }

    const handler = this.handlers.get(method);
    if (!handler) {
      await transport.send(
        createErrorResponse(id, ErrorCodes.METHOD_NOT_FOUND, `Unknown method: ${method}`)
      );
      return;
    }

    const promptResolvers = new Map<string, (response: PromptResponseData) => void>();
    using _ = setInMap(this.pendingPrompts, id, promptResolvers);

    let reqSet = this.transportRequests.get(transport);
    if (!reqSet) {
      reqSet = new Set();
      this.transportRequests.set(transport, reqSet);
    }
    reqSet.add(id);
    using __ = {
      [Symbol.dispose]() {
        reqSet.delete(id);
      },
    };

    const context: HandlerContext = {
      transport,
      app: this.app,
      server: this,
      stream: async (channel, data, done) => {
        await transport.send(createStream(id, channel, data, done));
      },
      prompt: async (type, promptMessage, options) => {
        const promptId = `p${++this.promptCounter}`;

        // Send prompt request to client
        const promptRequest: PromptRequest = {
          promptId,
          promptType: type,
          message: promptMessage,
          defaultValue: options?.defaultValue,
          choices: options?.choices,
        };
        await transport.send(createStream(id, 'prompt', promptRequest));

        // Wait for response using promise
        const response = await new Promise<PromptResponseData>((resolve) => {
          promptResolvers.set(promptId, resolve);
        });

        if (response.cancelled) {
          return null;
        }
        return response.value;
      },
    };

    try {
      const result = await handler(params, context);
      await transport.send(createResponse(id, result));
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      await transport.send(createErrorResponse(id, ErrorCodes.INTERNAL_ERROR, errMessage));
    }
  }

  private registerBuiltinHandlers(): void {
    this.handle(Methods.SYSTEM_HEALTH, async () => {
      return {
        status: 'healthy',
        uptime: process.uptime(),
        memory: process.memoryUsage(),
      };
    });

    this.handle(Methods.SYSTEM_INFO, async () => {
      return {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
        cwd: process.cwd(),
      };
    });

  }
}

/**
 * Create a cluster server.
 */
export function createClusterServer(options?: ServerOptions): ClusterServer {
  return new ClusterServer(options);
}
