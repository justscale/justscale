/**
 * Protobuf Binary Encoding
 *
 * This module provides utilities for encoding and decoding protobuf wire format.
 *
 * @example
 * ```typescript
 * import { BufferWriter, BufferReader, WireType } from '@justscale/protobuf/encoding'
 *
 * // Encode a message
 * const writer = new BufferWriter()
 * writer.writeTag(1, WireType.LengthDelimited)
 * writer.writeString('hello')
 * const bytes = writer.finish()
 *
 * // Decode a message
 * const reader = new BufferReader(bytes)
 * const { fieldNumber, wireType } = reader.readTag()
 * const value = reader.readString()
 * ```
 */

// Wire types and field key utilities
export {
  WireType,
  type WireTypeValue,
  makeFieldKey,
  parseFieldKey,
  getWireTypeForScalar,
  usesZigZag,
  is64BitType,
} from './wire-types.js';

// Varint encoding utilities
export {
  encodeVarint,
  decodeVarint,
  encodeZigZag,
  decodeZigZag,
  encodeZigZag32,
  decodeZigZag32,
  varintSize,
} from './varint.js';

// Buffer writer
export { BufferWriter } from './writer.js';

// Buffer reader
export { BufferReader } from './reader.js';
