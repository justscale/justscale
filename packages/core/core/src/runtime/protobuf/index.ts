export {
  BufferWriter,
  BufferReader,
  WireType,
  type WireTypeValue,
  makeFieldKey,
  parseFieldKey,
  getWireTypeForScalar,
  usesZigZag,
  is64BitType,
  encodeVarint,
  decodeVarint,
  encodeZigZag,
  decodeZigZag,
  encodeZigZag32,
  decodeZigZag32,
  varintSize,
} from './encoding/index.js';

export {
  createSerializedClass,
  type Serialized,
  type SerializedSchema,
  type FieldDef,
  type OneOfDef,
  type ScalarType,
} from './serialized.js';
