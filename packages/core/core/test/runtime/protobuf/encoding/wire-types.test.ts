/**
 * Tests for wire type utilities.
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  WireType,
  makeFieldKey,
  parseFieldKey,
  getWireTypeForScalar,
  usesZigZag,
  is64BitType,
} from '../../../../src/runtime/protobuf/encoding/wire-types.js';

describe('Wire Type Constants', () => {
  test('has correct values', () => {
    assert.equal(WireType.Varint, 0);
    assert.equal(WireType.Fixed64, 1);
    assert.equal(WireType.LengthDelimited, 2);
    assert.equal(WireType.StartGroup, 3);
    assert.equal(WireType.EndGroup, 4);
    assert.equal(WireType.Fixed32, 5);
  });
});

describe('Field Key Encoding', () => {
  test('makeFieldKey encodes field number and wire type', () => {
    // Field 1, Varint: (1 << 3) | 0 = 8
    assert.equal(makeFieldKey(1, WireType.Varint), 8);

    // Field 1, LengthDelimited: (1 << 3) | 2 = 10
    assert.equal(makeFieldKey(1, WireType.LengthDelimited), 10);

    // Field 2, Fixed32: (2 << 3) | 5 = 21
    assert.equal(makeFieldKey(2, WireType.Fixed32), 21);

    // Field 15, Varint: (15 << 3) | 0 = 120
    assert.equal(makeFieldKey(15, WireType.Varint), 120);
  });

  test('parseFieldKey decodes field number and wire type', () => {
    const result1 = parseFieldKey(8);
    assert.equal(result1.fieldNumber, 1);
    assert.equal(result1.wireType, 0);

    const result2 = parseFieldKey(10);
    assert.equal(result2.fieldNumber, 1);
    assert.equal(result2.wireType, 2);

    const result3 = parseFieldKey(21);
    assert.equal(result3.fieldNumber, 2);
    assert.equal(result3.wireType, 5);
  });

  test('roundtrip encode/decode', () => {
    for (let fieldNum = 1; fieldNum <= 100; fieldNum++) {
      for (let wireType = 0; wireType <= 5; wireType++) {
        const key = makeFieldKey(fieldNum, wireType);
        const parsed = parseFieldKey(key);
        assert.equal(parsed.fieldNumber, fieldNum);
        assert.equal(parsed.wireType, wireType);
      }
    }
  });
});

describe('getWireTypeForScalar', () => {
  test('returns Varint for integer types', () => {
    assert.equal(getWireTypeForScalar('int32'), WireType.Varint);
    assert.equal(getWireTypeForScalar('int64'), WireType.Varint);
    assert.equal(getWireTypeForScalar('uint32'), WireType.Varint);
    assert.equal(getWireTypeForScalar('uint64'), WireType.Varint);
    assert.equal(getWireTypeForScalar('sint32'), WireType.Varint);
    assert.equal(getWireTypeForScalar('sint64'), WireType.Varint);
    assert.equal(getWireTypeForScalar('bool'), WireType.Varint);
    assert.equal(getWireTypeForScalar('enum'), WireType.Varint);
  });

  test('returns Fixed64 for 64-bit fixed types', () => {
    assert.equal(getWireTypeForScalar('fixed64'), WireType.Fixed64);
    assert.equal(getWireTypeForScalar('sfixed64'), WireType.Fixed64);
    assert.equal(getWireTypeForScalar('double'), WireType.Fixed64);
  });

  test('returns Fixed32 for 32-bit fixed types', () => {
    assert.equal(getWireTypeForScalar('fixed32'), WireType.Fixed32);
    assert.equal(getWireTypeForScalar('sfixed32'), WireType.Fixed32);
    assert.equal(getWireTypeForScalar('float'), WireType.Fixed32);
  });

  test('returns LengthDelimited for string and bytes', () => {
    assert.equal(getWireTypeForScalar('string'), WireType.LengthDelimited);
    assert.equal(getWireTypeForScalar('bytes'), WireType.LengthDelimited);
  });

  test('returns LengthDelimited for unknown types (messages)', () => {
    assert.equal(getWireTypeForScalar('MyMessage'), WireType.LengthDelimited);
    assert.equal(getWireTypeForScalar('google.protobuf.Timestamp'), WireType.LengthDelimited);
  });
});

describe('usesZigZag', () => {
  test('returns true for sint32 and sint64', () => {
    assert.equal(usesZigZag('sint32'), true);
    assert.equal(usesZigZag('sint64'), true);
  });

  test('returns false for other types', () => {
    assert.equal(usesZigZag('int32'), false);
    assert.equal(usesZigZag('int64'), false);
    assert.equal(usesZigZag('uint32'), false);
    assert.equal(usesZigZag('string'), false);
  });
});

describe('is64BitType', () => {
  test('returns true for 64-bit integer types', () => {
    assert.equal(is64BitType('int64'), true);
    assert.equal(is64BitType('uint64'), true);
    assert.equal(is64BitType('sint64'), true);
    assert.equal(is64BitType('fixed64'), true);
    assert.equal(is64BitType('sfixed64'), true);
  });

  test('returns false for 32-bit and other types', () => {
    assert.equal(is64BitType('int32'), false);
    assert.equal(is64BitType('uint32'), false);
    assert.equal(is64BitType('double'), false);
    assert.equal(is64BitType('string'), false);
  });
});
