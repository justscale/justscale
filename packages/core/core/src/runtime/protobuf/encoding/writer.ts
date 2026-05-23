/**
 * BufferWriter - Protobuf Binary Writer
 *
 * A utility class for writing protobuf wire format data.
 * Accumulates bytes in chunks and concatenates them in finish().
 */

import { encodeVarint, encodeZigZag, encodeZigZag32 } from './varint.js';
import { type WireTypeValue, makeFieldKey } from './wire-types.js';

/**
 * A writer for constructing protobuf binary messages.
 * Uses a chunked approach for efficiency - collects bytes in an array
 * and only concatenates when finish() is called.
 */
export class BufferWriter {
  private buffer: number[] = [];

  /**
   * Write a varint (variable-length integer).
   *
   * @param value - The value to write (number or bigint)
   * @returns this for chaining
   */
  writeVarint(value: number | bigint): this {
    encodeVarint(value, this.buffer);
    return this;
  }

  /**
   * Write a field tag (field number + wire type).
   *
   * @param fieldNumber - The field number (1-based)
   * @param wireType - The wire type
   * @returns this for chaining
   */
  writeTag(fieldNumber: number, wireType: WireTypeValue): this {
    return this.writeVarint(makeFieldKey(fieldNumber, wireType));
  }

  /**
   * Write a signed 32-bit integer using ZigZag encoding (sint32).
   *
   * @param value - The signed value
   * @returns this for chaining
   */
  writeSint32(value: number): this {
    return this.writeVarint(encodeZigZag32(value));
  }

  /**
   * Write a signed 64-bit integer using ZigZag encoding (sint64).
   *
   * @param value - The signed value (bigint)
   * @returns this for chaining
   */
  writeSint64(value: bigint): this {
    return this.writeVarint(encodeZigZag(value));
  }

  /**
   * Write a boolean value (encoded as varint 0 or 1).
   *
   * @param value - The boolean value
   * @returns this for chaining
   */
  writeBool(value: boolean): this {
    this.buffer.push(value ? 1 : 0);
    return this;
  }

  /**
   * Write a 32-bit fixed integer (little-endian).
   *
   * @param value - The 32-bit value
   * @returns this for chaining
   */
  writeFixed32(value: number): this {
    this.buffer.push(value & 0xff);
    this.buffer.push((value >>> 8) & 0xff);
    this.buffer.push((value >>> 16) & 0xff);
    this.buffer.push((value >>> 24) & 0xff);
    return this;
  }

  /**
   * Write a 32-bit signed fixed integer (little-endian).
   *
   * @param value - The signed 32-bit value
   * @returns this for chaining
   */
  writeSfixed32(value: number): this {
    return this.writeFixed32(value);
  }

  /**
   * Write a 64-bit fixed integer (little-endian).
   *
   * @param value - The 64-bit value (bigint)
   * @returns this for chaining
   */
  writeFixed64(value: bigint): this {
    const low = Number(value & 0xffffffffn);
    const high = Number((value >> 32n) & 0xffffffffn);
    this.writeFixed32(low);
    this.writeFixed32(high);
    return this;
  }

  /**
   * Write a 64-bit signed fixed integer (little-endian).
   *
   * @param value - The signed 64-bit value (bigint)
   * @returns this for chaining
   */
  writeSfixed64(value: bigint): this {
    return this.writeFixed64(value);
  }

  /**
   * Write a 32-bit float (IEEE 754).
   *
   * @param value - The float value
   * @returns this for chaining
   */
  writeFloat(value: number): this {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true); // little-endian
    for (let i = 0; i < 4; i++) {
      this.buffer.push(view.getUint8(i));
    }
    return this;
  }

  /**
   * Write a 64-bit double (IEEE 754).
   *
   * @param value - The double value
   * @returns this for chaining
   */
  writeDouble(value: number): this {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true); // little-endian
    for (let i = 0; i < 8; i++) {
      this.buffer.push(view.getUint8(i));
    }
    return this;
  }

  /**
   * Write raw bytes.
   *
   * @param data - The bytes to write
   * @returns this for chaining
   */
  writeBytes(data: Uint8Array): this {
    for (let i = 0; i < data.length; i++) {
      this.buffer.push(data[i]);
    }
    return this;
  }

  /**
   * Write a length-delimited field (length prefix + data).
   * Used for strings, bytes, and embedded messages.
   *
   * @param data - The data to write
   * @returns this for chaining
   */
  writeLengthDelimited(data: Uint8Array): this {
    this.writeVarint(data.length);
    return this.writeBytes(data);
  }

  /**
   * Write a string (UTF-8 encoded, length-delimited).
   *
   * @param value - The string value
   * @returns this for chaining
   */
  writeString(value: string): this {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(value);
    return this.writeLengthDelimited(bytes);
  }

  /**
   * Fork the writer to write a sub-message.
   * Returns a new BufferWriter that can be used to write the sub-message,
   * then call join() to append it with length prefix.
   *
   * @returns A new BufferWriter for the sub-message
   */
  fork(): BufferWriter {
    return new BufferWriter();
  }

  /**
   * Join a forked sub-message writer with length prefix.
   *
   * @param subWriter - The forked writer with sub-message data
   * @returns this for chaining
   */
  join(subWriter: BufferWriter): this {
    const subData = subWriter.finish();
    return this.writeLengthDelimited(subData);
  }

  /**
   * Get the current length of the buffer.
   */
  get length(): number {
    return this.buffer.length;
  }

  /**
   * Reset the writer for reuse.
   *
   * @returns this for chaining
   */
  reset(): this {
    this.buffer = [];
    return this;
  }

  /**
   * Finish writing and return the complete buffer.
   *
   * @returns The encoded bytes
   */
  finish(): Uint8Array {
    return new Uint8Array(this.buffer);
  }
}
