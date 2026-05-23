/**
 * BufferReader - Protobuf Binary Reader
 *
 * A utility class for reading protobuf wire format data.
 */

import { decodeVarint, decodeZigZag, decodeZigZag32 } from './varint.js';
import { WireType, parseFieldKey } from './wire-types.js';

/**
 * A reader for parsing protobuf binary messages.
 */
export class BufferReader {
  private readonly data: Uint8Array;
  private readonly view: DataView;
  private pos = 0;

  /**
   * Create a new BufferReader.
   *
   * @param buffer - The buffer to read from
   */
  constructor(buffer: Uint8Array) {
    this.data = buffer;
    this.view = new DataView(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength,
    );
  }

  /**
   * Get the current position in the buffer.
   */
  get position(): number {
    return this.pos;
  }

  /**
   * Get the number of remaining bytes.
   */
  get remaining(): number {
    return this.data.length - this.pos;
  }

  /**
   * Check if there are more bytes to read.
   */
  get hasMore(): boolean {
    return this.pos < this.data.length;
  }

  /**
   * Read a varint (variable-length integer).
   *
   * @returns The decoded value as bigint
   */
  readVarint(): bigint {
    const { value, bytesRead } = decodeVarint(this.data, this.pos);
    this.pos += bytesRead;
    return value;
  }

  /**
   * Read a varint as a 32-bit number.
   * Truncates the value if it exceeds 32 bits.
   *
   * @returns The decoded value as number
   */
  readVarint32(): number {
    return Number(this.readVarint() & 0xffffffffn);
  }

  /**
   * Read a field tag and return the field number and wire type.
   *
   * @returns Object with fieldNumber and wireType
   */
  readTag(): { fieldNumber: number; wireType: number } {
    const tag = this.readVarint32();
    return parseFieldKey(tag);
  }

  /**
   * Read a signed 32-bit integer with ZigZag decoding (sint32).
   *
   * @returns The decoded signed value
   */
  readSint32(): number {
    return decodeZigZag32(this.readVarint32());
  }

  /**
   * Read a signed 64-bit integer with ZigZag decoding (sint64).
   *
   * @returns The decoded signed value as bigint
   */
  readSint64(): bigint {
    return decodeZigZag(this.readVarint());
  }

  /**
   * Read a boolean value.
   *
   * @returns The decoded boolean
   */
  readBool(): boolean {
    return this.readVarint() !== 0n;
  }

  /**
   * Read a 32-bit fixed integer (little-endian).
   *
   * @returns The decoded value
   */
  readFixed32(): number {
    if (this.pos + 4 > this.data.length) {
      throw new Error('Buffer underflow reading fixed32');
    }
    const value = this.view.getUint32(this.pos, true); // little-endian
    this.pos += 4;
    return value;
  }

  /**
   * Read a 32-bit signed fixed integer (little-endian).
   *
   * @returns The decoded signed value
   */
  readSfixed32(): number {
    if (this.pos + 4 > this.data.length) {
      throw new Error('Buffer underflow reading sfixed32');
    }
    const value = this.view.getInt32(this.pos, true); // little-endian
    this.pos += 4;
    return value;
  }

  /**
   * Read a 64-bit fixed integer (little-endian).
   *
   * @returns The decoded value as bigint
   */
  readFixed64(): bigint {
    if (this.pos + 8 > this.data.length) {
      throw new Error('Buffer underflow reading fixed64');
    }
    const low = BigInt(this.view.getUint32(this.pos, true));
    const high = BigInt(this.view.getUint32(this.pos + 4, true));
    this.pos += 8;
    return (high << 32n) | low;
  }

  /**
   * Read a 64-bit signed fixed integer (little-endian).
   *
   * @returns The decoded signed value as bigint
   */
  readSfixed64(): bigint {
    if (this.pos + 8 > this.data.length) {
      throw new Error('Buffer underflow reading sfixed64');
    }
    const low = BigInt(this.view.getUint32(this.pos, true));
    const high = BigInt(this.view.getInt32(this.pos + 4, true));
    this.pos += 8;
    return (high << 32n) | low;
  }

  /**
   * Read a 32-bit float (IEEE 754).
   *
   * @returns The decoded float value
   */
  readFloat(): number {
    if (this.pos + 4 > this.data.length) {
      throw new Error('Buffer underflow reading float');
    }
    const value = this.view.getFloat32(this.pos, true); // little-endian
    this.pos += 4;
    return value;
  }

  /**
   * Read a 64-bit double (IEEE 754).
   *
   * @returns The decoded double value
   */
  readDouble(): number {
    if (this.pos + 8 > this.data.length) {
      throw new Error('Buffer underflow reading double');
    }
    const value = this.view.getFloat64(this.pos, true); // little-endian
    this.pos += 8;
    return value;
  }

  /**
   * Read raw bytes of a specific length.
   *
   * @param length - The number of bytes to read
   * @returns The bytes as Uint8Array
   */
  readBytes(length: number): Uint8Array {
    if (this.pos + length > this.data.length) {
      throw new Error('Buffer underflow reading bytes');
    }
    const bytes = this.data.slice(this.pos, this.pos + length);
    this.pos += length;
    return bytes;
  }

  /**
   * Read a length-delimited field (length prefix + data).
   *
   * @returns The data as Uint8Array
   */
  readLengthDelimited(): Uint8Array {
    const length = this.readVarint32();
    return this.readBytes(length);
  }

  /**
   * Read a string (UTF-8 encoded, length-delimited).
   *
   * @returns The decoded string
   */
  readString(): string {
    const bytes = this.readLengthDelimited();
    const decoder = new TextDecoder();
    return decoder.decode(bytes);
  }

  /**
   * Skip a field based on its wire type.
   * Used for handling unknown fields.
   *
   * @param wireType - The wire type of the field to skip
   */
  skip(wireType: number): void {
    switch (wireType) {
      case WireType.Varint:
        this.readVarint();
        break;
      case WireType.Fixed64:
        this.advance(8);
        break;
      case WireType.LengthDelimited: {
        const length = this.readVarint32();
        // Negative or oversize length from a malformed message would
        // otherwise silently advance pos past the buffer; subsequent
        // reads then fail with cryptic "Buffer underflow" errors far
        // from the actual problem. Reject at the skip site instead.
        if (length < 0) {
          throw new Error(`Invalid length-delimited size: ${length}`);
        }
        this.advance(length);
        break;
      }
      case WireType.StartGroup:
        // Skip until EndGroup (deprecated, but handle for compatibility)
        this.skipGroup();
        break;
      case WireType.EndGroup:
        // Should not encounter this directly
        break;
      case WireType.Fixed32:
        this.advance(4);
        break;
      default:
        throw new Error(`Unknown wire type: ${wireType}`);
    }
  }

  /**
   * Advance the read cursor by `n` bytes, throwing if that would
   * pass the buffer end. Mirrors readBytes's bounds check so skip
   * paths fail at the actual problem rather than several reads later.
   */
  private advance(n: number): void {
    if (this.pos + n > this.data.length) {
      throw new Error(
        `Buffer underflow advancing by ${n} (pos=${this.pos}, len=${this.data.length})`,
      );
    }
    this.pos += n;
  }

  /**
   * Skip a group (deprecated protobuf feature).
   * Groups are nested structures delimited by StartGroup/EndGroup tags.
   */
  private skipGroup(): void {
    while (this.hasMore) {
      const { wireType } = this.readTag();
      if (wireType === WireType.EndGroup) {
        return;
      }
      this.skip(wireType);
    }
    throw new Error('Unexpected end of buffer while skipping group');
  }

  /**
   * Create a sub-reader for a length-delimited field.
   * The sub-reader operates on a slice of the buffer.
   *
   * @returns A new BufferReader for the sub-message
   */
  readSubMessage(): BufferReader {
    const bytes = this.readLengthDelimited();
    return new BufferReader(bytes);
  }

  /**
   * Read packed repeated values as varints.
   *
   * @returns Array of decoded values as bigint
   */
  readPackedVarint(): bigint[] {
    const bytes = this.readLengthDelimited();
    const subReader = new BufferReader(bytes);
    const values: bigint[] = [];
    while (subReader.hasMore) {
      values.push(subReader.readVarint());
    }
    return values;
  }

  /**
   * Read packed repeated values as 32-bit fixed integers.
   *
   * @returns Array of decoded values
   */
  readPackedFixed32(): number[] {
    const bytes = this.readLengthDelimited();
    const subReader = new BufferReader(bytes);
    const values: number[] = [];
    while (subReader.hasMore) {
      values.push(subReader.readFixed32());
    }
    return values;
  }

  /**
   * Read packed repeated values as 64-bit fixed integers.
   *
   * @returns Array of decoded values as bigint
   */
  readPackedFixed64(): bigint[] {
    const bytes = this.readLengthDelimited();
    const subReader = new BufferReader(bytes);
    const values: bigint[] = [];
    while (subReader.hasMore) {
      values.push(subReader.readFixed64());
    }
    return values;
  }

  /**
   * Read packed repeated values as floats.
   *
   * @returns Array of decoded float values
   */
  readPackedFloat(): number[] {
    const bytes = this.readLengthDelimited();
    const subReader = new BufferReader(bytes);
    const values: number[] = [];
    while (subReader.hasMore) {
      values.push(subReader.readFloat());
    }
    return values;
  }

  /**
   * Read packed repeated values as doubles.
   *
   * @returns Array of decoded double values
   */
  readPackedDouble(): number[] {
    const bytes = this.readLengthDelimited();
    const subReader = new BufferReader(bytes);
    const values: number[] = [];
    while (subReader.hasMore) {
      values.push(subReader.readDouble());
    }
    return values;
  }
}
