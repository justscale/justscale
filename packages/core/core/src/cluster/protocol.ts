/**
 * Wire protocol for inter-process and inter-node communication.
 * Frame format: [4 bytes big-endian length][CBOR payload]
 */

import { encode, decode } from 'cbor-x';

/** CBOR wire format (default for local CLI communication) */
export const PROTOCOL_V1_CBOR = 1;
/** Proto wire format (v2 for inter-node cluster communication) */
export const PROTOCOL_V2_PROTO = 2;

export const PROTOCOL_VERSION = PROTOCOL_V1_CBOR;

/**
 * Wire format version markers.
 * First byte of the frame header indicates the encoding format:
 * - 0x00: CBOR v1 (4-byte BE length + CBOR payload)
 * - 0x01: Proto v2 (1-byte version + 4-byte BE length + proto payload)
 */
export const WIRE_FORMAT_CBOR = 0x00;
export const WIRE_FORMAT_PROTO = 0x01;

export type MessageType = 'request' | 'response' | 'stream' | 'event';

export type AuthLevel = 'none' | 'socket' | 'shared-secret' | 'pubkey' | 'mtls';

export interface AuthNone {
  type: 'none';
}

export interface AuthSocket {
  type: 'socket';
  uid?: number;
  gid?: number;
  pid?: number;
}

export interface AuthSharedSecret {
  type: 'shared-secret';
  token: string;
}

export interface AuthPubkey {
  type: 'pubkey';
  publicKey: Uint8Array;
  signature: Uint8Array;
  challenge?: Uint8Array;
}

export type AuthInfo = AuthNone | AuthSocket | AuthSharedSecret | AuthPubkey;

interface BaseMessage {
  /** Protocol version */
  v: number;
  /** Correlation ID for request/response matching */
  id?: string;
  /** Message type */
  type: MessageType;
}

export interface RequestMessage extends BaseMessage {
  type: 'request';
  /** Method namespace.name (e.g., "cli.invoke", "system.health") */
  method: string;
  /** Method parameters */
  params?: Record<string, unknown>;
}

export interface SuccessResponse extends BaseMessage {
  type: 'response';
  ok: true;
  result?: unknown;
}

export interface ErrorResponse extends BaseMessage {
  type: 'response';
  ok: false;
  error: {
    code: string;
    message: string;
    data?: unknown;
  };
}

export type ResponseMessage = SuccessResponse | ErrorResponse;

export interface StreamMessage extends BaseMessage {
  type: 'stream';
  /** Stream channel: stdout, stderr, progress, prompt, prompt_response, etc. */
  channel: string;
  /** Stream data */
  data: unknown;
  /** Is this the final message in the stream? */
  done?: boolean;
  /**
   * Monotonically increasing sequence number within a stream (scoped to id + channel).
   * Used to detect and reorder out-of-order delivery on non-TCP transports.
   */
  seq?: number;
}

export type PromptType = 'text' | 'password' | 'confirm' | 'select';

/** Server -> Client: Request input from user */
export interface PromptRequest {
  promptId: string;
  promptType: PromptType;
  message: string;
  defaultValue?: string;
  choices?: Array<{ label: string; value: string }>;  // for select
}

/** Client -> Server: User's response to prompt */
export interface PromptResponseData {
  promptId: string;
  value: string | boolean | null;
  cancelled?: boolean;
}

export interface EventMessage extends BaseMessage {
  type: 'event';
  /** Event name */
  event: string;
  /** Event payload */
  payload?: unknown;
}

export type Message = RequestMessage | ResponseMessage | StreamMessage | EventMessage;

export const ErrorCodes = {
  // Protocol errors
  PARSE_ERROR: 'PARSE_ERROR',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',

  // Method errors
  METHOD_NOT_FOUND: 'METHOD_NOT_FOUND',
  INVALID_PARAMS: 'INVALID_PARAMS',

  // Authentication errors
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  AUTH_FAILED: 'AUTH_FAILED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',

  // Execution errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export const Methods = {
  // CLI commands
  CLI_INVOKE: 'cli.invoke',
  CLI_LIST: 'cli.list',

  // System management
  SYSTEM_HEALTH: 'system.health',
  SYSTEM_INFO: 'system.info',
  SYSTEM_SHUTDOWN: 'system.shutdown',
  SYSTEM_RELOAD: 'system.reload',

  // Authentication
  AUTH_HANDSHAKE: 'auth.handshake',
  AUTH_CHALLENGE: 'auth.challenge',
  AUTH_VERIFY: 'auth.verify',

  MESH_DISCOVER: 'mesh.discover',
  MESH_JOIN: 'mesh.join',
  MESH_LEAVE: 'mesh.leave',
  MESH_ROUTE: 'mesh.route',
} as const;

const LENGTH_SIZE = 4;
const MAX_MESSAGE_SIZE = 16 * 1024 * 1024; // 16MB max

export type WireFormat = typeof WIRE_FORMAT_CBOR | typeof WIRE_FORMAT_PROTO;

export interface ProtoCodec {
  encode(message: Message): Uint8Array
  decode(data: Uint8Array): Message
}

let protoCodec: ProtoCodec | null = null;

export function setProtoCodec(codec: ProtoCodec): void {
  protoCodec = codec;
}

export function getProtoCodec(): ProtoCodec | null {
  return protoCodec;
}

/**
 * Encode a message to a framed buffer.
 * Frame format: [4 bytes big-endian length][CBOR payload]
 */
export function encodeFrame(message: Message): Uint8Array {
  const payload = encode(message);
  const frame = new Uint8Array(LENGTH_SIZE + payload.length);
  const view = new DataView(frame.buffer);

  view.setUint32(0, payload.length, false); // big-endian
  frame.set(payload, LENGTH_SIZE);

  return frame;
}

/**
 * Encode a message to a framed buffer with explicit wire format.
 * - CBOR: [4-byte BE length][CBOR payload]
 * - Proto: [0x01][4-byte BE length][proto payload]
 */
export function encodeFrameV2(message: Message, format: WireFormat = WIRE_FORMAT_CBOR): Uint8Array {
  if (format === WIRE_FORMAT_PROTO) {
    if (!protoCodec) {
      throw new Error('Proto codec not registered. Call setProtoCodec() first.');
    }
    const payload = protoCodec.encode(message);
    const frame = new Uint8Array(1 + LENGTH_SIZE + payload.length);
    const view = new DataView(frame.buffer);
    frame[0] = WIRE_FORMAT_PROTO;
    view.setUint32(1, payload.length, false);
    frame.set(payload, 1 + LENGTH_SIZE);
    return frame;
  }

  // CBOR v1 (default)
  return encodeFrame(message);
}

/**
 * Frame decoder for streaming data.
 * Auto-detects CBOR v1 and proto v2 wire formats.
 */
export class FrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0);

  /**
   * Push data into the decoder buffer.
   * Returns decoded messages (may be empty if incomplete).
   */
  push(data: Uint8Array): Message[] {
    // Append to buffer
    const newBuffer = new Uint8Array(this.buffer.length + data.length);
    newBuffer.set(this.buffer);
    newBuffer.set(data, this.buffer.length);
    this.buffer = newBuffer;

    const messages: Message[] = [];

    while (this.buffer.length >= LENGTH_SIZE) {
      // Wire format is discriminated by the first byte:
      //   0x00 -> CBOR v1: first byte is the high byte of the 4-byte BE length,
      //           which must be 0x00 because MAX_MESSAGE_SIZE is 16MB
      //           (0x01_00_00_00) - a valid CBOR length fits in 24 bits.
      //   0x01 -> Proto v2: explicit marker tag, followed by 4-byte BE length.
      // Any other value is invalid on the wire. This lets us run the oversize
      // guard on CBOR frames: a first byte >= 0x01 with the CBOR layout would
      // decode to a length >= 16MB, so we surface that as "too large" before
      // the codec branch instead of leaving it to ambiguous auto-detect.
      const firstByte = this.buffer[0];

      if (firstByte === WIRE_FORMAT_PROTO) {
        // Proto v2: [0x01][4 bytes BE length][proto payload]
        if (this.buffer.length < 1 + LENGTH_SIZE) break;

        const view = new DataView(this.buffer.buffer, this.buffer.byteOffset);
        const payloadLength = view.getUint32(1, false);

        if (payloadLength > MAX_MESSAGE_SIZE) {
          throw new Error(`Message too large: ${payloadLength} bytes`);
        }

        const frameLength = 1 + LENGTH_SIZE + payloadLength;
        if (this.buffer.length < frameLength) break;

        if (!protoCodec) {
          throw new Error('Received proto-encoded frame but no proto codec registered');
        }

        const payload = this.buffer.slice(1 + LENGTH_SIZE, frameLength);
        messages.push(protoCodec.decode(payload));
        this.buffer = this.buffer.slice(frameLength);
      } else if (firstByte === WIRE_FORMAT_CBOR) {
        // CBOR v1: [4-byte BE length][CBOR payload]
        // First byte must be 0x00 for a valid CBOR frame because the length
        // is bounded by MAX_MESSAGE_SIZE (16MB) which fits in 24 bits.
        const view = new DataView(this.buffer.buffer, this.buffer.byteOffset);
        const payloadLength = view.getUint32(0, false);

        if (payloadLength > MAX_MESSAGE_SIZE) {
          throw new Error(`Message too large: ${payloadLength} bytes`);
        }

        const frameLength = LENGTH_SIZE + payloadLength;
        if (this.buffer.length < frameLength) break;

        const payload = this.buffer.slice(LENGTH_SIZE, frameLength);
        messages.push(decode(payload) as Message);
        this.buffer = this.buffer.slice(frameLength);
      } else {
        // A first byte other than 0x00 (CBOR) or 0x01 (proto) is not a
        // valid frame - surface as "too large" to match the oversize guard path.
        const view = new DataView(this.buffer.buffer, this.buffer.byteOffset);
        const payloadLength = view.getUint32(0, false);
        throw new Error(`Message too large: ${payloadLength} bytes`);
      }
    }

    return messages;
  }

  /**
   * Reset the decoder state.
   */
  reset(): void {
    this.buffer = new Uint8Array(0);
  }

  /**
   * Check if there's pending data in the buffer.
   */
  get hasPending(): boolean {
    return this.buffer.length > 0;
  }
}

let messageCounter = 0;

function generateId(): string {
  return `${Date.now().toString(36)}-${(++messageCounter).toString(36)}`;
}

/**
 * Create a request message.
 */
export function createRequest(
  method: string,
  params?: Record<string, unknown>,
  id?: string
): RequestMessage {
  return {
    v: PROTOCOL_VERSION,
    id: id ?? generateId(),
    type: 'request',
    method,
    params,
  };
}

/**
 * Create a success response.
 */
export function createResponse(id: string, result?: unknown): SuccessResponse {
  return {
    v: PROTOCOL_VERSION,
    id,
    type: 'response',
    ok: true,
    result,
  };
}

/**
 * Create an error response.
 */
export function createErrorResponse(
  id: string,
  code: ErrorCode | string,
  message: string,
  data?: unknown
): ErrorResponse {
  return {
    v: PROTOCOL_VERSION,
    id,
    type: 'response',
    ok: false,
    error: { code, message, data },
  };
}

const streamSeqCounters = new Map<string, number>();

/**
 * Create a stream message.
 */
export function createStream(
  id: string,
  channel: string,
  data: unknown,
  done = false
): StreamMessage {
  const key = `${id}:${channel}`;
  const seq = (streamSeqCounters.get(key) ?? 0) + 1;

  if (done) {
    streamSeqCounters.delete(key);
  } else {
    streamSeqCounters.set(key, seq);
  }

  return {
    v: PROTOCOL_VERSION,
    id,
    type: 'stream',
    channel,
    data,
    done,
    seq,
  };
}

/**
 * Create an event message.
 */
export function createEvent(event: string, payload?: unknown): EventMessage {
  return {
    v: PROTOCOL_VERSION,
    type: 'event',
    event,
    payload,
  };
}

export function isRequest(msg: Message): msg is RequestMessage {
  return msg.type === 'request';
}

export function isResponse(msg: Message): msg is ResponseMessage {
  return msg.type === 'response';
}

export function isSuccessResponse(msg: Message): msg is SuccessResponse {
  return msg.type === 'response' && (msg as ResponseMessage).ok === true;
}

export function isErrorResponse(msg: Message): msg is ErrorResponse {
  return msg.type === 'response' && (msg as ResponseMessage).ok === false;
}

export function isStream(msg: Message): msg is StreamMessage {
  return msg.type === 'stream';
}

export function isEvent(msg: Message): msg is EventMessage {
  return msg.type === 'event';
}
