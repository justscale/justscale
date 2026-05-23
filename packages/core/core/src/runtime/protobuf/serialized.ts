/**
 * Serialized<T> — A Uint8Array that acts as a live view of a protobuf message.
 *
 * No separate encode/decode step. Getters read directly from the bytes.
 * Setters write directly to the bytes (append, protobuf last-wins).
 * You pay for what you access.
 */

import { decodeVarint, encodeVarint as encodeVarintTo, encodeZigZag32, decodeZigZag32, encodeZigZag, decodeZigZag } from './encoding/varint.js';
import { WireType, parseFieldKey, makeFieldKey } from './encoding/wire-types.js';

function encodeVarintBytes(value: bigint): Uint8Array {
  const buf: number[] = [];
  encodeVarintTo(value, buf);
  return new Uint8Array(buf);
}

export type ScalarType =
  | 'string' | 'bytes'
  | 'int32' | 'uint32' | 'sint32' | 'fixed32' | 'sfixed32'
  | 'int64' | 'uint64' | 'sint64' | 'fixed64' | 'sfixed64'
  | 'bool' | 'float' | 'double' | 'enum'
  | 'message';

export interface FieldDef {
  number: number;
  name: string;
  type: ScalarType;
  repeated?: boolean;
  packed?: boolean;
  /** Name of the oneof group this field belongs to (if any) */
  oneOf?: string;
  messageSchema?: SerializedSchema<any>;
}

export interface OneOfDef {
  name: string;
  fields: string[];
}

export interface SerializedSchema<T> {
  fields: FieldDef[];
  create(bytes?: Uint8Array): Serialized<T>;
}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/**
 * Scan protobuf bytes and build a tag → offset index.
 * For repeated fields, stores all offsets. For scalars, stores last (protobuf last-wins).
 */
function buildIndex(data: Uint8Array): Map<number, { offset: number; length: number; wireType: number }[]> {
  const index = new Map<number, { offset: number; length: number; wireType: number }[]>();
  let pos = 0;

  while (pos < data.length) {
    const { value: tagBigint, bytesRead: tagBytes } = decodeVarint(data, pos);
    const tag = Number(tagBigint);
    pos += tagBytes;

    const { fieldNumber, wireType } = parseFieldKey(tag);
    const valueStart = pos;

    // Skip value based on wire type. Bounds-check the fixed/length-delimited
    // advances so a truncated or malformed message fails at the offending
    // tag rather than silently building a corrupt index whose entries
    // point past the buffer end.
    switch (wireType) {
      case WireType.Varint: {
        const { bytesRead } = decodeVarint(data, pos);
        pos += bytesRead;
        break;
      }
      case WireType.Fixed64:
        if (pos + 8 > data.length) {
          throw new Error(`Truncated fixed64 at position ${valueStart}`);
        }
        pos += 8;
        break;
      case WireType.Fixed32:
        if (pos + 4 > data.length) {
          throw new Error(`Truncated fixed32 at position ${valueStart}`);
        }
        pos += 4;
        break;
      case WireType.LengthDelimited: {
        const { value: len, bytesRead } = decodeVarint(data, pos);
        const lenNum = Number(len);
        if (lenNum < 0) {
          throw new Error(`Invalid length-delimited size ${lenNum} at position ${valueStart}`);
        }
        if (pos + bytesRead + lenNum > data.length) {
          throw new Error(`Truncated length-delimited field at position ${valueStart}`);
        }
        pos += bytesRead + lenNum;
        break;
      }
      default:
        throw new Error(`Unknown wire type ${wireType} at position ${valueStart}`);
    }

    const entry = { offset: valueStart, length: pos - valueStart, wireType };
    let entries = index.get(fieldNumber);
    if (!entries) {
      entries = [];
      index.set(fieldNumber, entries);
    }
    entries.push(entry);
  }

  return index;
}

function readField(data: Uint8Array, offset: number, wireType: number, fieldType: ScalarType): unknown {
  switch (fieldType) {
    case 'string': {
      const { value: len, bytesRead } = decodeVarint(data, offset);
      return textDecoder.decode(data.subarray(offset + bytesRead, offset + bytesRead + Number(len)));
    }
    case 'bytes': {
      const { value: len, bytesRead } = decodeVarint(data, offset);
      return data.slice(offset + bytesRead, offset + bytesRead + Number(len));
    }
    case 'int32':
    case 'enum': {
      const { value } = decodeVarint(data, offset);
      // Negative int32 is encoded as 10-byte unsigned varint
      // Truncate to 32 bits and sign-extend
      return Number(BigInt.asIntN(32, value));
    }
    case 'uint32': {
      const { value } = decodeVarint(data, offset);
      return Number(value) >>> 0;
    }
    case 'sint32': {
      const { value } = decodeVarint(data, offset);
      return decodeZigZag32(Number(value));
    }
    case 'sint64': {
      const { value } = decodeVarint(data, offset);
      return Number(decodeZigZag(value));
    }
    case 'int64':
    case 'uint64': {
      const { value } = decodeVarint(data, offset);
      return Number(value);
    }
    case 'bool': {
      const { value } = decodeVarint(data, offset);
      return value !== 0n;
    }
    case 'fixed32': {
      const view = new DataView(data.buffer, data.byteOffset + offset, 4);
      return view.getUint32(0, true);
    }
    case 'sfixed32': {
      const view = new DataView(data.buffer, data.byteOffset + offset, 4);
      return view.getInt32(0, true);
    }
    case 'float': {
      const view = new DataView(data.buffer, data.byteOffset + offset, 4);
      return view.getFloat32(0, true);
    }
    case 'fixed64': {
      const view = new DataView(data.buffer, data.byteOffset + offset, 8);
      return Number(view.getBigUint64(0, true));
    }
    case 'sfixed64': {
      const view = new DataView(data.buffer, data.byteOffset + offset, 8);
      return Number(view.getBigInt64(0, true));
    }
    case 'double': {
      const view = new DataView(data.buffer, data.byteOffset + offset, 8);
      return view.getFloat64(0, true);
    }
    case 'message': {
      const { value: len, bytesRead } = decodeVarint(data, offset);
      return data.subarray(offset + bytesRead, offset + bytesRead + Number(len));
    }
    default:
      return undefined;
  }
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function encodeField(fieldNumber: number, fieldType: ScalarType, value: unknown): Uint8Array {
  const parts: Uint8Array[] = [];

  switch (fieldType) {
    case 'string': {
      const strBytes = textEncoder.encode(String(value));
      parts.push(encodeVarintBytes(BigInt(makeFieldKey(fieldNumber, WireType.LengthDelimited))));
      parts.push(encodeVarintBytes(BigInt(strBytes.length)));
      parts.push(strBytes);
      break;
    }
    case 'bytes': {
      const bytes = value as Uint8Array;
      parts.push(encodeVarintBytes(BigInt(makeFieldKey(fieldNumber, WireType.LengthDelimited))));
      parts.push(encodeVarintBytes(BigInt(bytes.length)));
      parts.push(bytes);
      break;
    }
    case 'int32':
    case 'uint32':
    case 'int64':
    case 'uint64':
    case 'enum': {
      parts.push(encodeVarintBytes(BigInt(makeFieldKey(fieldNumber, WireType.Varint))));
      parts.push(encodeVarintBytes(BigInt(Number(value))));
      break;
    }
    case 'sint32': {
      parts.push(encodeVarintBytes(BigInt(makeFieldKey(fieldNumber, WireType.Varint))));
      parts.push(encodeVarintBytes(BigInt(encodeZigZag32(Number(value)))));
      break;
    }
    case 'sint64': {
      parts.push(encodeVarintBytes(BigInt(makeFieldKey(fieldNumber, WireType.Varint))));
      parts.push(encodeVarintBytes(encodeZigZag(BigInt(Number(value)))));
      break;
    }
    case 'bool': {
      parts.push(encodeVarintBytes(BigInt(makeFieldKey(fieldNumber, WireType.Varint))));
      parts.push(encodeVarintBytes(value ? 1n : 0n));
      break;
    }
    case 'fixed32': {
      parts.push(encodeVarintBytes(BigInt(makeFieldKey(fieldNumber, WireType.Fixed32))));
      const buf = new Uint8Array(4);
      new DataView(buf.buffer).setUint32(0, Number(value), true);
      parts.push(buf);
      break;
    }
    case 'sfixed32': {
      parts.push(encodeVarintBytes(BigInt(makeFieldKey(fieldNumber, WireType.Fixed32))));
      const buf = new Uint8Array(4);
      new DataView(buf.buffer).setInt32(0, Number(value), true);
      parts.push(buf);
      break;
    }
    case 'float': {
      parts.push(encodeVarintBytes(BigInt(makeFieldKey(fieldNumber, WireType.Fixed32))));
      const buf = new Uint8Array(4);
      new DataView(buf.buffer).setFloat32(0, Number(value), true);
      parts.push(buf);
      break;
    }
    case 'fixed64': {
      parts.push(encodeVarintBytes(BigInt(makeFieldKey(fieldNumber, WireType.Fixed64))));
      const buf = new Uint8Array(8);
      new DataView(buf.buffer).setBigUint64(0, BigInt(Number(value)), true);
      parts.push(buf);
      break;
    }
    case 'sfixed64': {
      parts.push(encodeVarintBytes(BigInt(makeFieldKey(fieldNumber, WireType.Fixed64))));
      const buf = new Uint8Array(8);
      new DataView(buf.buffer).setBigInt64(0, BigInt(Number(value)), true);
      parts.push(buf);
      break;
    }
    case 'double': {
      parts.push(encodeVarintBytes(BigInt(makeFieldKey(fieldNumber, WireType.Fixed64))));
      const buf = new Uint8Array(8);
      new DataView(buf.buffer).setFloat64(0, Number(value), true);
      parts.push(buf);
      break;
    }
    case 'message': {
      const bytes = value as Uint8Array;
      parts.push(encodeVarintBytes(BigInt(makeFieldKey(fieldNumber, WireType.LengthDelimited))));
      parts.push(encodeVarintBytes(BigInt(bytes.length)));
      parts.push(bytes);
      break;
    }
  }

  return concatBytes(parts);
}

/**
 * Create a Serialized<T> class for a specific proto schema.
 * Returns a constructor that wraps bytes and provides typed field access.
 */
export function createSerializedClass<T>(schema: { fields: FieldDef[]; oneOfs?: OneOfDef[] }): {
  from(bytes: Uint8Array): Serialized<T>;
  fromObject(obj: Partial<T>): Serialized<T>;
} {
  const fieldsByName = new Map<string, FieldDef>();
  const fieldsByNumber = new Map<number, FieldDef>();
  for (const f of schema.fields) {
    fieldsByName.set(f.name, f);
    fieldsByNumber.set(f.number, f);
  }

  // Build oneOf sibling map: field name → names of other fields in the same oneOf group
  const oneOfSiblings = new Map<string, string[]>();
  if (schema.oneOfs) {
    for (const group of schema.oneOfs) {
      for (const fieldName of group.fields) {
        oneOfSiblings.set(fieldName, group.fields.filter(f => f !== fieldName));
      }
    }
  }

  class SerializedImpl {
    private _bytes: Uint8Array;
    private _index: Map<number, { offset: number; length: number; wireType: number }[]> | null = null;
    private _cache = new Map<string, unknown>();

    constructor(bytes: Uint8Array) {
      this._bytes = bytes;
    }

    private getIndex() {
      if (!this._index) {
        this._index = buildIndex(this._bytes);
      }
      return this._index;
    }

    /** Get the raw bytes */
    get bytes(): Uint8Array {
      return this._bytes;
    }

    /** Byte length */
    get length(): number {
      return this._bytes.length;
    }
  }

  // Add getters/setters for each field
  for (const field of schema.fields) {
    Object.defineProperty(SerializedImpl.prototype, field.name, {
      get(this: any) {
        if (this._cache.has(field.name)) {
          return this._cache.get(field.name);
        }

        const index = this.getIndex();
        const entries = index.get(field.number);
        if (!entries || entries.length === 0) {
          // For oneOf fields, missing means "not the active one" → undefined
          const def = field.oneOf ? undefined : getDefault(field.type, field.repeated);
          this._cache.set(field.name, def);
          return def;
        }

        if (field.repeated) {
          const values: unknown[] = [];
          for (const e of entries) {
            if (e.wireType === WireType.LengthDelimited && field.type !== 'string' && field.type !== 'bytes' && field.type !== 'message') {
              // Packed encoding: single length-delimited field with concatenated values
              values.push(...readPackedField(this._bytes, e.offset, e.length, field.type));
            } else {
              values.push(readField(this._bytes, e.offset, e.wireType, field.type));
            }
          }
          this._cache.set(field.name, values);
          return values;
        }

        // Last wins for scalars
        const last = entries[entries.length - 1];

        // For oneOf fields: check if a sibling field appears later in the bytes
        const siblings = oneOfSiblings.get(field.name);
        if (siblings) {
          const index = this.getIndex();
          for (const siblingName of siblings) {
            const siblingField = fieldsByName.get(siblingName);
            if (!siblingField) continue;
            const siblingEntries = index.get(siblingField.number);
            if (siblingEntries && siblingEntries.length > 0) {
              const siblingLast = siblingEntries[siblingEntries.length - 1];
              if (siblingLast.offset > last.offset) {
                // Sibling was written after us — we're not the active oneOf
                this._cache.set(field.name, undefined);
                return undefined;
              }
            }
          }
        }

        let value = readField(this._bytes, last.offset, last.wireType, field.type);

        // For nested messages, wrap in Serialized view
        if (field.type === 'message' && field.messageSchema && value instanceof Uint8Array) {
          value = field.messageSchema.create(value);
        }

        this._cache.set(field.name, value);
        return value;
      },

      set(this: any, value: unknown) {
        this._cache.set(field.name, value);

        // Clear sibling oneOf fields from cache (only one can be set)
        const siblings = oneOfSiblings.get(field.name);
        if (siblings) {
          for (const sibling of siblings) {
            this._cache.delete(sibling);
          }
        }

        // Encode the new value and append (protobuf last-wins)
        let encodedValue: Uint8Array;
        if (field.type === 'message' && value && typeof value === 'object' && 'bytes' in value) {
          encodedValue = encodeField(field.number, field.type, (value as any).bytes);
        } else {
          encodedValue = encodeField(field.number, field.type, value);
        }

        // Grow the buffer
        const newBytes = new Uint8Array(this._bytes.length + encodedValue.length);
        newBytes.set(this._bytes);
        newBytes.set(encodedValue, this._bytes.length);
        this._bytes = newBytes;
        this._index = null; // Invalidate index
      },

      enumerable: true,
      configurable: true,
    });
  }

  return {
    from(bytes: Uint8Array): Serialized<T> {
      return new SerializedImpl(bytes) as unknown as Serialized<T>;
    },
    fromObject(obj: Partial<T>): Serialized<T> {
      const parts: Uint8Array[] = [];
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        const field = fieldsByName.get(key);
        if (!field || value === undefined || value === null) continue;

        if (field.repeated && Array.isArray(value)) {
          // Encode each element as a separate tag+value
          for (const item of value) {
            if (field.type === 'message' && item && typeof item === 'object' && 'bytes' in item) {
              parts.push(encodeField(field.number, field.type, (item as any).bytes));
            } else {
              parts.push(encodeField(field.number, field.type, item));
            }
          }
        } else if (field.type === 'message' && value && typeof value === 'object' && 'bytes' in value) {
          parts.push(encodeField(field.number, field.type, (value as any).bytes));
        } else {
          parts.push(encodeField(field.number, field.type, value));
        }
      }

      const bytes = concatBytes(parts);

      return new SerializedImpl(bytes) as unknown as Serialized<T>;
    },
  };
}

function getDefault(type: ScalarType, repeated?: boolean): unknown {
  if (repeated) return [];
  switch (type) {
    case 'string': return '';
    case 'int32': case 'uint32': case 'sint32': case 'fixed32': case 'sfixed32':
    case 'int64': case 'uint64': case 'sint64': case 'fixed64': case 'sfixed64':
    case 'float': case 'double': case 'enum': return 0;
    case 'bool': return false;
    case 'bytes': return new Uint8Array(0);
    case 'message': return undefined;
  }
}

function readPackedField(data: Uint8Array, offset: number, length: number, fieldType: ScalarType): unknown[] {
  const values: unknown[] = [];
  let pos = offset;

  // Read length prefix
  const { value: packedLen, bytesRead: lenBytes } = decodeVarint(data, pos);
  pos += lenBytes;
  const packedEnd = pos + Number(packedLen);

  while (pos < packedEnd) {
    switch (fieldType) {
      case 'int32': case 'enum': {
        const { value, bytesRead } = decodeVarint(data, pos);
        values.push(Number(value) | 0);
        pos += bytesRead;
        break;
      }
      case 'uint32': {
        const { value, bytesRead } = decodeVarint(data, pos);
        values.push(Number(value) >>> 0);
        pos += bytesRead;
        break;
      }
      case 'sint32': {
        const { value, bytesRead } = decodeVarint(data, pos);
        values.push(decodeZigZag32(Number(value)));
        pos += bytesRead;
        break;
      }
      case 'int64': case 'uint64': {
        const { value, bytesRead } = decodeVarint(data, pos);
        values.push(Number(value));
        pos += bytesRead;
        break;
      }
      case 'sint64': {
        const { value, bytesRead } = decodeVarint(data, pos);
        values.push(Number(decodeZigZag(value)));
        pos += bytesRead;
        break;
      }
      case 'bool': {
        const { value, bytesRead } = decodeVarint(data, pos);
        values.push(value !== 0n);
        pos += bytesRead;
        break;
      }
      case 'fixed32': {
        values.push(new DataView(data.buffer, data.byteOffset + pos, 4).getUint32(0, true));
        pos += 4;
        break;
      }
      case 'sfixed32': {
        values.push(new DataView(data.buffer, data.byteOffset + pos, 4).getInt32(0, true));
        pos += 4;
        break;
      }
      case 'float': {
        values.push(new DataView(data.buffer, data.byteOffset + pos, 4).getFloat32(0, true));
        pos += 4;
        break;
      }
      case 'fixed64': {
        values.push(Number(new DataView(data.buffer, data.byteOffset + pos, 8).getBigUint64(0, true)));
        pos += 8;
        break;
      }
      case 'sfixed64': {
        values.push(Number(new DataView(data.buffer, data.byteOffset + pos, 8).getBigInt64(0, true)));
        pos += 8;
        break;
      }
      case 'double': {
        values.push(new DataView(data.buffer, data.byteOffset + pos, 8).getFloat64(0, true));
        pos += 8;
        break;
      }
      default:
        return values;
    }
  }
  return values;
}

/**
 * Branded type: a protobuf message that lives as bytes.
 * Access fields like a normal object — reads/writes go through the bytes.
 */
export type Serialized<T> = T & {
  /** The raw protobuf bytes */
  readonly bytes: Uint8Array;
  /** Byte length */
  readonly length: number;
};
