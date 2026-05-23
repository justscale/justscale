/**
 * Connects to a JustScale cluster server and executes commands.
 */

import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import {
  type Message,
  type PromptRequest,
  type PromptResponseData,
  type PromptType,
  Methods,
  createRequest,
  createStream,
  isResponse,
  isStream,
  isSuccessResponse,
  isErrorResponse,
} from './protocol.js';
import { SocketTransport, type Transport, getSocketPath } from './transport.js';

export interface ClientOptions {
  /** Socket path to connect to */
  socketPath?: string;
  /** App root directory for socket path discovery */
  appRoot?: string;
  /** Connection timeout in ms */
  timeout?: number;
}

/** Handler for interactive prompts */
export type PromptHandler = (
  promptType: PromptType,
  message: string,
  options?: { defaultValue?: string; choices?: Array<{ label: string; value: string }> }
) => Promise<string | boolean | null>;

export interface CallOptions {
  /** Timeout in ms */
  timeout?: number;
  /** Stream handler for progressive output */
  onStream?: (channel: string, data: unknown) => void;
  /** Handler for interactive prompts from the server */
  onPrompt?: PromptHandler;
}

export interface ClientEvents {
  connect: [];
  disconnect: [];
  error: [error: Error];
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  onStream?: (channel: string, data: unknown) => void;
  onPrompt?: PromptHandler;
  timer?: NodeJS.Timeout;
}

export class ClusterClient extends EventEmitter {
  private transport: Transport | null = null;
  private socketPath: string;
  private pendingRequests = new Map<string, PendingRequest>();
  private connectTimeout: number;

  constructor(options: ClientOptions = {}) {
    super();
    this.socketPath = options.socketPath ?? getSocketPath(options.appRoot ?? process.cwd());
    this.connectTimeout = options.timeout ?? 5000;
  }

  /**
   * Connect to the server.
   */
  async connect(): Promise<void> {
    if (this.transport?.connected) {
      return;
    }

    const isTcp = this.socketPath.startsWith('tcp://');

    if (isTcp) {
      // TCP connection: tcp://host:port
      const url = new URL(this.socketPath);
      const host = url.hostname;
      const port = parseInt(url.port || '9100', 10);

      return new Promise((resolve, reject) => {
        const socket = connect({ host, port });
        const timeout = setTimeout(() => {
          socket.destroy();
          reject(new Error(`Connection timeout: ${host}:${port}`));
        }, this.connectTimeout);

        socket.on('connect', () => {
          clearTimeout(timeout);
          this.transport = new SocketTransport({ socket, auth: { type: 'none' } });
          this.setupTransport();
          this.emit('connect');
          resolve();
        });

        socket.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
    }

    // Unix socket connection
    if (!existsSync(this.socketPath)) {
      throw new Error(`Socket not found: ${this.socketPath}\nIs the app running?`);
    }

    return new Promise((resolve, reject) => {
      const socket = connect(this.socketPath);
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection timeout: ${this.socketPath}`));
      }, this.connectTimeout);

      socket.on('connect', () => {
        clearTimeout(timeout);
        this.transport = new SocketTransport({ socket, auth: { type: 'socket' } });
        this.setupTransport();
        this.emit('connect');
        resolve();
      });

      socket.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /**
   * Disconnect from the server.
   */
  async disconnect(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
      this.emit('disconnect');
    }

    for (const pending of this.pendingRequests.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error('Disconnected'));
    }
    this.pendingRequests.clear();
  }

  /**
   * Check if connected.
   */
  get connected(): boolean {
    return this.transport?.connected ?? false;
  }

  /**
   * Call a method on the server.
   */
  async call<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options: CallOptions = {}
  ): Promise<T> {
    if (!this.transport?.connected) {
      await this.connect();
    }

    const request = createRequest(method, params);
    const id = request.id!;

    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve: resolve as (result: unknown) => void,
        reject,
        onStream: options.onStream,
        onPrompt: options.onPrompt,
      };

      // Set timeout
      if (options.timeout) {
        pending.timer = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${method}`));
        }, options.timeout);
      }

      this.pendingRequests.set(id, pending);
      this.transport!.send(request).catch((err: Error) => {
        if (pending.timer) clearTimeout(pending.timer);
        this.pendingRequests.delete(id);
        reject(err);
      });
    });
  }

  /**
   * Get system health.
   */
  async health(): Promise<{
    status: string;
    uptime: number;
    memory: NodeJS.MemoryUsage;
  }> {
    return this.call(Methods.SYSTEM_HEALTH);
  }

  /**
   * Get system info.
   */
  async info(): Promise<{
    node: string;
    platform: string;
    arch: string;
    pid: number;
    cwd: string;
  }> {
    return this.call(Methods.SYSTEM_INFO);
  }

  /**
   * List available CLI commands.
   */
  async listCommands(): Promise<string[]> {
    const result = await this.call<{ commands: string[] }>(Methods.CLI_LIST);
    return result.commands;
  }

  /**
   * Invoke a CLI command.
   */
  async invoke<T = unknown>(
    command: string,
    args: Record<string, unknown> = {},
    options: {
      onStdout?: (data: string) => void;
      onStderr?: (data: string) => void;
      onPrompt?: PromptHandler;
      timeout?: number;
    } = {}
  ): Promise<T> {
    return this.call<T>(
      Methods.CLI_INVOKE,
      { command, args },
      {
        timeout: options.timeout,
        onPrompt: options.onPrompt,
        onStream: (channel, data) => {
          if (channel === 'stdout' && options.onStdout) {
            options.onStdout(String(data));
          } else if (channel === 'stderr' && options.onStderr) {
            options.onStderr(String(data));
          }
        },
      }
    );
  }

  private setupTransport(): void {
    if (!this.transport) return;

    this.transport.on('message', (message) => {
      this.handleMessage(message);
    });

    this.transport.on('error', (error) => {
      this.emit('error', error);
    });

    this.transport.on('close', () => {
      this.transport = null;
      this.emit('disconnect');

      for (const pending of this.pendingRequests.values()) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(new Error('Connection closed'));
      }
      this.pendingRequests.clear();
    });
  }

  private handleMessage(message: Message): void {
    const id = message.id;
    if (!id) return;

    const pending = this.pendingRequests.get(id);
    if (!pending) return;

    // Handle stream messages
    if (isStream(message)) {
      // Handle prompt requests specially
      if (message.channel === 'prompt' && pending.onPrompt) {
        this.handlePrompt(id, message.data as PromptRequest, pending.onPrompt);
        return;
      }

      if (pending.onStream) {
        pending.onStream(message.channel, message.data);
      }
      // Don't resolve yet - wait for response
      if (!message.done) return;
    }

    // Handle response messages
    if (isResponse(message)) {
      if (pending.timer) clearTimeout(pending.timer);
      this.pendingRequests.delete(id);

      if (isSuccessResponse(message)) {
        pending.resolve(message.result);
      } else if (isErrorResponse(message)) {
        pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
      }
    }
  }

  private async handlePrompt(
    requestId: string,
    promptReq: PromptRequest,
    handler: PromptHandler
  ): Promise<void> {
    try {
      const value = await handler(promptReq.promptType, promptReq.message, {
        defaultValue: promptReq.defaultValue,
        choices: promptReq.choices,
      });

      const response: PromptResponseData = {
        promptId: promptReq.promptId,
        value,
        cancelled: value === null,
      };

      await this.transport?.send(createStream(requestId, 'prompt_response', response));
    } catch {
      const response: PromptResponseData = {
        promptId: promptReq.promptId,
        value: null,
        cancelled: true,
      };
      await this.transport?.send(createStream(requestId, 'prompt_response', response));
    }
  }
}

/**
 * Create a cluster client.
 */
export function createClusterClient(options?: ClientOptions): ClusterClient {
  return new ClusterClient(options);
}

/**
 * Connect to a cluster server and return a client.
 * Convenience function that creates and connects in one step.
 */
export async function connectToCluster(options?: ClientOptions): Promise<ClusterClient> {
  const client = new ClusterClient(options);
  await client.connect();
  return client;
}
