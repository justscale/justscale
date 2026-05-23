/**
 * Transport abstraction - unified interface for Unix/TCP socket connections.
 */

import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import type { Message, AuthInfo, WireFormat } from './protocol.js';
import { FrameDecoder, encodeFrameV2, WIRE_FORMAT_CBOR } from './protocol.js';

export interface TransportEvents {
  message: [message: Message];
  error: [error: Error];
  close: [];
  connect: [];
}

/**
 * Abstract transport interface.
 * Implementations handle the actual I/O.
 */
export interface Transport {
  /** Send a message */
  send(message: Message): Promise<void>;
  /** Close the transport */
  close(): Promise<void>;
  /** Check if connected */
  readonly connected: boolean;
  /** Authentication info for this connection */
  readonly auth: AuthInfo;
  /** Event handlers */
  on<K extends keyof TransportEvents>(event: K, listener: (...args: TransportEvents[K]) => void): void;
  off<K extends keyof TransportEvents>(event: K, listener: (...args: TransportEvents[K]) => void): void;
  once<K extends keyof TransportEvents>(event: K, listener: (...args: TransportEvents[K]) => void): void;
}

export interface SocketTransportOptions {
  /** Socket instance */
  socket: Socket;
  /** Auth info (e.g., from SO_PEERCRED) */
  auth?: AuthInfo;
  /**
   * Wire format for outgoing messages.
   * - WIRE_FORMAT_CBOR (0x00): CBOR encoding (default, backward compatible)
   * - WIRE_FORMAT_PROTO (0x01): Proto encoding (requires proto codec registered)
   *
   * Incoming messages are auto-detected regardless of this setting.
   * Set to WIRE_FORMAT_PROTO for inter-node cluster communication.
   * @default WIRE_FORMAT_CBOR
   */
  wireFormat?: WireFormat;
}

/**
 * Transport implementation for Node.js sockets (Unix/TCP).
 */
export class SocketTransport extends EventEmitter implements Transport {
  private socket: Socket;
  private decoder = new FrameDecoder();
  private _connected = true;
  private _auth: AuthInfo;
  private _wireFormat: WireFormat;

  constructor(options: SocketTransportOptions) {
    super();
    this.socket = options.socket;
    this._auth = options.auth ?? { type: 'socket' };
    this._wireFormat = options.wireFormat ?? WIRE_FORMAT_CBOR;

    this.socket.on('data', (data: Buffer) => {
      try {
        const messages = this.decoder.push(new Uint8Array(data));
        for (const message of messages) {
          this.emit('message', message);
        }
      } catch (error) {
        this.emit('error', error instanceof Error ? error : new Error(String(error)));
      }
    });

    this.socket.on('error', (error) => {
      this.emit('error', error);
    });

    this.socket.on('close', () => {
      this._connected = false;
      this.emit('close');
    });

    this.socket.on('connect', () => {
      this._connected = true;
      this.emit('connect');
    });
  }

  get connected(): boolean {
    return this._connected && !this.socket.destroyed;
  }

  get auth(): AuthInfo {
    return this._auth;
  }

  /** The wire format used for outgoing messages */
  get wireFormat(): WireFormat {
    return this._wireFormat;
  }

  async send(message: Message): Promise<void> {
    if (!this.connected) {
      throw new Error('Transport not connected');
    }

    const frame = encodeFrameV2(message, this._wireFormat);
    return new Promise((resolve, reject) => {
      this.socket.write(frame, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.socket.destroyed) {
        resolve();
        return;
      }

      this.socket.once('close', () => resolve());
      this.socket.end();

      // Force destroy after timeout
      setTimeout(() => {
        if (!this.socket.destroyed) {
          this.socket.destroy();
        }
        resolve();
      }, 1000);
    });
  }
}

import { join } from 'node:path';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * Get the runtime directory for JustScale sockets.
 */
export function getSocketDir(): string {
  const runtimeDir = process.env.XDG_RUNTIME_DIR;
  const baseDir = runtimeDir
    ? join(runtimeDir, 'justscale')
    : join(process.env.TMPDIR || '/tmp', 'justscale');

  // Ensure directory exists
  if (!existsSync(baseDir)) {
    mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  }

  return baseDir;
}

/**
 * Generate a socket path for an app.
 * Uses a hash of the app's root path for uniqueness.
 */
export function getSocketPath(appRoot: string): string {
  const hash = createHash('sha256').update(appRoot).digest('hex').slice(0, 12);
  return join(getSocketDir(), `app-${hash}.sock`);
}

/**
 * Clean up a socket file if it exists.
 */
export function cleanupSocket(socketPath: string): void {
  try {
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Get peer credentials from a Unix socket (SO_PEERCRED).
 * Returns null on platforms without SO_PEERCRED or when unavailable.
 */
export function getPeerCredentials(socket: Socket): { uid: number; gid: number; pid: number } | null {
  try {
    const fd = (socket as any)._handle?.fd;
    if (fd === undefined) return null;
    return null;
  } catch {
    return null;
  }
}
