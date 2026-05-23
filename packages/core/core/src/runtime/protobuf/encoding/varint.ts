/**
 * Varint Encoding (LEB128)
 *
 * Protobuf uses LEB128 (Little Endian Base 128) encoding for variable-length integers.
 * Each byte uses 7 bits for data and 1 bit (MSB) as a continuation flag.
 *
 * ZigZag encoding is used for signed integers (sint32, sint64) to efficiently
 * represent small negative numbers.
 */

/**
 * Encode a value as a varint (LEB128) into a buffer array.
 *
 * @param value - The value to encode (number or bigint)
 * @param buffer - The array to append bytes to
 */
export function encodeVarint(value: number | bigint, buffer: number[]): void {
  let v = typeof value === 'number' ? BigInt(value) : value;

  // Handle negative numbers by treating as unsigned 64-bit
  if (v < 0n) {
    v = v + 0x10000000000000000n; // Add 2^64 to get unsigned representation
  }

  while (v > 0x7fn) {
    buffer.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  buffer.push(Number(v));
}

/**
 * Decode a varint (LEB128) from a buffer.
 *
 * @param buffer - The buffer to read from
 * @param offset - The offset to start reading from
 * @returns Object with decoded value and number of bytes read
 */
export function decodeVarint(
  buffer: Uint8Array,
  offset: number,
): { value: bigint; bytesRead: number } {
  let result = 0n;
  let shift = 0n;
  let bytesRead = 0;

  while (offset + bytesRead < buffer.length) {
    const byte = buffer[offset + bytesRead];
    bytesRead++;

    result |= BigInt(byte & 0x7f) << shift;

    if ((byte & 0x80) === 0) {
      return { value: result, bytesRead };
    }

    shift += 7n;

    // Protect against malformed varints (max 10 bytes for 64-bit)
    if (bytesRead > 10) {
      throw new Error('Varint is too long');
    }
  }

  throw new Error('Unexpected end of buffer while reading varint');
}

/**
 * Encode a signed integer using ZigZag encoding.
 * Maps signed integers to unsigned integers in a way that small absolute values
 * produce small encoded values:
 *   0 -> 0, -1 -> 1, 1 -> 2, -2 -> 3, 2 -> 4, ...
 *
 * @param value - The signed value to encode
 * @returns The zigzag-encoded unsigned value
 */
export function encodeZigZag(value: number | bigint): bigint {
  const v = typeof value === 'number' ? BigInt(value) : value;
  // (n << 1) ^ (n >> 63) for 64-bit, (n << 1) ^ (n >> 31) for 32-bit
  // Using 63 for all cases since we're using bigint
  return (v << 1n) ^ (v >> 63n);
}

/**
 * Decode a ZigZag-encoded unsigned integer back to signed.
 *
 * @param value - The zigzag-encoded unsigned value
 * @returns The decoded signed value
 */
export function decodeZigZag(value: bigint): bigint {
  // (n >>> 1) ^ -(n & 1)
  return (value >> 1n) ^ -(value & 1n);
}

/**
 * Encode a signed 32-bit integer using ZigZag encoding.
 * Optimized for 32-bit values.
 *
 * @param value - The signed 32-bit value
 * @returns The zigzag-encoded value as a number
 */
export function encodeZigZag32(value: number): number {
  return (value << 1) ^ (value >> 31);
}

/**
 * Decode a ZigZag-encoded 32-bit integer.
 *
 * @param value - The zigzag-encoded value
 * @returns The decoded signed value
 */
export function decodeZigZag32(value: number): number {
  return (value >>> 1) ^ -(value & 1);
}

/**
 * Calculate the number of bytes needed to encode a varint.
 *
 * @param value - The value to encode
 * @returns The number of bytes needed
 */
export function varintSize(value: number | bigint): number {
  let v = typeof value === 'number' ? BigInt(value) : value;

  // Handle negative numbers
  if (v < 0n) {
    return 10; // Negative numbers always take 10 bytes in protobuf
  }

  let size = 1;
  while (v > 0x7fn) {
    v >>= 7n;
    size++;
  }
  return size;
}
