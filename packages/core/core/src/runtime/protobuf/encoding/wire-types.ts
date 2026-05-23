/**
 * Protobuf Wire Types
 *
 * Defines the wire types used in protobuf binary encoding.
 * See: https://protobuf.dev/programming-guides/encoding/
 */

/**
 * Wire type constants for protobuf encoding.
 * Each field in a protobuf message is encoded with a tag that includes
 * the field number and wire type.
 */
export const WireType = {
  /** Variable-length integer (int32, int64, uint32, uint64, sint32, sint64, bool, enum) */
  Varint: 0,
  /** 64-bit fixed (fixed64, sfixed64, double) */
  Fixed64: 1,
  /** Length-delimited (string, bytes, embedded messages, packed repeated fields) */
  LengthDelimited: 2,
  /** Start group (deprecated) */
  StartGroup: 3,
  /** End group (deprecated) */
  EndGroup: 4,
  /** 32-bit fixed (fixed32, sfixed32, float) */
  Fixed32: 5,
} as const;

export type WireTypeValue = (typeof WireType)[keyof typeof WireType];

/**
 * Create a field key (tag) from field number and wire type.
 * The tag is encoded as: (field_number << 3) | wire_type
 *
 * @param fieldNumber - The field number (1-based)
 * @param wireType - The wire type (0-5)
 * @returns The encoded tag value
 */
export function makeFieldKey(fieldNumber: number, wireType: number): number {
  return (fieldNumber << 3) | wireType;
}

/**
 * Parse a field key (tag) into field number and wire type.
 *
 * @param key - The encoded tag value
 * @returns Object with fieldNumber and wireType
 */
export function parseFieldKey(key: number): {
  fieldNumber: number
  wireType: number
} {
  return {
    fieldNumber: key >>> 3,
    wireType: key & 0x7,
  };
}

/**
 * Get the wire type for a protobuf scalar type.
 *
 * @param protoType - The protobuf type name (e.g., 'int32', 'string', 'double')
 * @returns The wire type value
 */
export function getWireTypeForScalar(protoType: string): WireTypeValue {
  switch (protoType) {
    // Varint types
    case 'int32':
    case 'int64':
    case 'uint32':
    case 'uint64':
    case 'sint32':
    case 'sint64':
    case 'bool':
    case 'enum':
      return WireType.Varint;

    // 64-bit fixed types
    case 'fixed64':
    case 'sfixed64':
    case 'double':
      return WireType.Fixed64;

    // 32-bit fixed types
    case 'fixed32':
    case 'sfixed32':
    case 'float':
      return WireType.Fixed32;

    // Length-delimited types
    case 'string':
    case 'bytes':
      return WireType.LengthDelimited;

    // Messages are also length-delimited
    default:
      return WireType.LengthDelimited;
  }
}

/**
 * Check if a proto type uses zigzag encoding.
 * sint32 and sint64 use zigzag encoding for efficient negative number representation.
 */
export function usesZigZag(protoType: string): boolean {
  return protoType === 'sint32' || protoType === 'sint64';
}

/**
 * Check if a proto type is a 64-bit integer type.
 */
export function is64BitType(protoType: string): boolean {
  return (
    protoType === 'int64' ||
    protoType === 'uint64' ||
    protoType === 'sint64' ||
    protoType === 'fixed64' ||
    protoType === 'sfixed64'
  );
}
