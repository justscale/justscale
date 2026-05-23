/**
 * Tests for varint encoding (LEB128) and ZigZag encoding.
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  encodeVarint,
  decodeVarint,
  encodeZigZag,
  decodeZigZag,
  encodeZigZag32,
  decodeZigZag32,
  varintSize,
} from '../../../../src/runtime/protobuf/encoding/varint.js';

describe('Varint Encoding', () => {
  test('encodes single byte values (0-127)', () => {
    const buf: number[] = [];
    encodeVarint(0, buf);
    assert.deepEqual(buf, [0x00]);

    buf.length = 0;
    encodeVarint(1, buf);
    assert.deepEqual(buf, [0x01]);

    buf.length = 0;
    encodeVarint(127, buf);
    assert.deepEqual(buf, [0x7f]);
  });

  test('encodes multi-byte values', () => {
    const buf: number[] = [];
    encodeVarint(128, buf);
    assert.deepEqual(buf, [0x80, 0x01]);

    buf.length = 0;
    encodeVarint(300, buf);
    assert.deepEqual(buf, [0xac, 0x02]);

    buf.length = 0;
    encodeVarint(16384, buf);
    assert.deepEqual(buf, [0x80, 0x80, 0x01]);
  });

  test('encodes large values', () => {
    const buf: number[] = [];
    encodeVarint(0xffffffff, buf);
    // 4294967295 = 0x0f 0xff 0xff 0xff 0xff in LEB128
    assert.deepEqual(buf, [0xff, 0xff, 0xff, 0xff, 0x0f]);
  });

  test('encodes bigint values', () => {
    const buf: number[] = [];
    encodeVarint(BigInt('9223372036854775807'), buf); // max int64
    assert.equal(buf.length, 9);
  });

  // Negative inputs are sign-extended to a 10-byte unsigned varint via the
  // `v + 2^64` wrap. Pin both that the size is 10 AND that the value
  // round-trips when re-decoded as a 64-bit unsigned (matches the
  // `int32-encoded-as-negative` proto3 wire shape).
  test('encodes negative numbers as 10-byte unsigned-extended varint', () => {
    const buf: number[] = [];
    encodeVarint(-1, buf);
    assert.equal(buf.length, 10, '-1 must take 10 bytes (sign-extended)');

    const decoded = decodeVarint(new Uint8Array(buf), 0);
    assert.equal(decoded.bytesRead, 10);
    // -1 sign-extended to uint64 = 2^64 - 1 = 0xFFFFFFFFFFFFFFFF
    assert.equal(decoded.value, (1n << 64n) - 1n);
  });

  test('decodes single byte values', () => {
    const result = decodeVarint(new Uint8Array([0x00]), 0);
    assert.equal(result.value, 0n);
    assert.equal(result.bytesRead, 1);

    const result2 = decodeVarint(new Uint8Array([0x7f]), 0);
    assert.equal(result2.value, 127n);
    assert.equal(result2.bytesRead, 1);
  });

  test('decodes multi-byte values', () => {
    const result = decodeVarint(new Uint8Array([0x80, 0x01]), 0);
    assert.equal(result.value, 128n);
    assert.equal(result.bytesRead, 2);

    const result2 = decodeVarint(new Uint8Array([0xac, 0x02]), 0);
    assert.equal(result2.value, 300n);
    assert.equal(result2.bytesRead, 2);
  });

  test('decodes at offset', () => {
    const buf = new Uint8Array([0x00, 0x00, 0xac, 0x02]);
    const result = decodeVarint(buf, 2);
    assert.equal(result.value, 300n);
    assert.equal(result.bytesRead, 2);
  });

  test('roundtrip encode/decode', () => {
    const testValues = [0, 1, 127, 128, 255, 256, 16383, 16384, 2097151, 268435455];
    for (const value of testValues) {
      const buf: number[] = [];
      encodeVarint(value, buf);
      const result = decodeVarint(new Uint8Array(buf), 0);
      assert.equal(result.value, BigInt(value), `Roundtrip failed for ${value}`);
    }
  });
});

describe('ZigZag Encoding', () => {
  test('encodes signed values to unsigned', () => {
    // ZigZag mapping: 0->0, -1->1, 1->2, -2->3, 2->4, ...
    assert.equal(encodeZigZag(0), 0n);
    assert.equal(encodeZigZag(-1), 1n);
    assert.equal(encodeZigZag(1), 2n);
    assert.equal(encodeZigZag(-2), 3n);
    assert.equal(encodeZigZag(2), 4n);
    assert.equal(encodeZigZag(-2147483648), 4294967295n);
  });

  test('decodes unsigned values to signed', () => {
    assert.equal(decodeZigZag(0n), 0n);
    assert.equal(decodeZigZag(1n), -1n);
    assert.equal(decodeZigZag(2n), 1n);
    assert.equal(decodeZigZag(3n), -2n);
    assert.equal(decodeZigZag(4n), 2n);
  });

  test('roundtrip encode/decode', () => {
    const testValues = [0, 1, -1, 127, -128, 32767, -32768, 2147483647, -2147483648];
    for (const value of testValues) {
      const encoded = encodeZigZag(value);
      const decoded = decodeZigZag(encoded);
      assert.equal(decoded, BigInt(value), `Roundtrip failed for ${value}`);
    }
  });

  // The encoder uses `n >> 63n` for both 32-bit and 64-bit values,
  // relying on BigInt's sign-extending arithmetic right shift to give
  // -1n for any negative input regardless of width. Pin the 64-bit
  // boundary cases since INT64_MIN is the worst case for shift width.

  test('encodes INT64_MAX correctly', () => {
    const INT64_MAX = (1n << 63n) - 1n; // 9223372036854775807
    const encoded = encodeZigZag(INT64_MAX);
    // sint64 spec: INT64_MAX → 2 * INT64_MAX = 0xFFFFFFFFFFFFFFFE
    assert.equal(encoded, (1n << 64n) - 2n);
    assert.equal(decodeZigZag(encoded), INT64_MAX, 'roundtrip INT64_MAX');
  });

  test('encodes INT64_MIN correctly (worst-case sign-extension)', () => {
    const INT64_MIN = -(1n << 63n); // -9223372036854775808
    const encoded = encodeZigZag(INT64_MIN);
    // sint64 spec: INT64_MIN → 2 * |INT64_MIN| - 1 = 0xFFFFFFFFFFFFFFFF
    assert.equal(encoded, (1n << 64n) - 1n);
    assert.equal(decodeZigZag(encoded), INT64_MIN, 'roundtrip INT64_MIN');
  });

  test('CONTRACT: ZigZag is INT64-bounded; beyond-int64 BigInts do not roundtrip', () => {
    // The encoder uses `n >> 63n` which is correct for [-2^63, 2^63).
    // BigInts outside that range get an out-of-range high-bit signal
    // mixed in and don't roundtrip cleanly. Pinning this contract so a
    // future "use uint128" claim has to also widen the shift.
    const big = 1n << 100n; // way beyond int64
    const encoded = encodeZigZag(big);
    const decoded = decodeZigZag(encoded);
    assert.notStrictEqual(decoded, big, 'beyond-int64 BigInts do NOT roundtrip — by design');
  });
});

describe('ZigZag32 Encoding', () => {
  test('encodes signed 32-bit values', () => {
    assert.equal(encodeZigZag32(0), 0);
    assert.equal(encodeZigZag32(-1), 1);
    assert.equal(encodeZigZag32(1), 2);
    assert.equal(encodeZigZag32(-2), 3);
  });

  test('decodes unsigned 32-bit values', () => {
    assert.equal(decodeZigZag32(0), 0);
    assert.equal(decodeZigZag32(1), -1);
    assert.equal(decodeZigZag32(2), 1);
    assert.equal(decodeZigZag32(3), -2);
  });

  test('roundtrip encode/decode', () => {
    const testValues = [0, 1, -1, 127, -128, 32767, -32768];
    for (const value of testValues) {
      const encoded = encodeZigZag32(value);
      const decoded = decodeZigZag32(encoded);
      assert.equal(decoded, value, `Roundtrip failed for ${value}`);
    }
  });
});

describe('Varint Size', () => {
  test('calculates size for small values', () => {
    assert.equal(varintSize(0), 1);
    assert.equal(varintSize(127), 1);
    assert.equal(varintSize(128), 2);
    assert.equal(varintSize(16383), 2);
    assert.equal(varintSize(16384), 3);
  });

  test('negative numbers always take 10 bytes', () => {
    assert.equal(varintSize(-1), 10);
    assert.equal(varintSize(-1000), 10);
  });
});
