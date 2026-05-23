/**
 * Tests for BufferWriter.
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { BufferWriter } from '../../../../src/runtime/protobuf/encoding/writer.js';
import { BufferReader } from '../../../../src/runtime/protobuf/encoding/reader.js';
import { WireType } from '../../../../src/runtime/protobuf/encoding/wire-types.js';

describe('BufferWriter', () => {
  describe('writeVarint', () => {
    test('writes single byte varint', () => {
      const writer = new BufferWriter();
      writer.writeVarint(1);
      assert.deepEqual(writer.finish(), new Uint8Array([0x01]));
    });

    test('writes multi-byte varint', () => {
      const writer = new BufferWriter();
      writer.writeVarint(300);
      assert.deepEqual(writer.finish(), new Uint8Array([0xac, 0x02]));
    });

    test('chains multiple writes', () => {
      const writer = new BufferWriter();
      writer.writeVarint(1).writeVarint(2).writeVarint(3);
      assert.deepEqual(writer.finish(), new Uint8Array([0x01, 0x02, 0x03]));
    });
  });

  describe('writeTag', () => {
    test('writes field 1 varint tag', () => {
      const writer = new BufferWriter();
      writer.writeTag(1, WireType.Varint);
      // (1 << 3) | 0 = 8
      assert.deepEqual(writer.finish(), new Uint8Array([0x08]));
    });

    test('writes field 1 length-delimited tag', () => {
      const writer = new BufferWriter();
      writer.writeTag(1, WireType.LengthDelimited);
      // (1 << 3) | 2 = 10
      assert.deepEqual(writer.finish(), new Uint8Array([0x0a]));
    });
  });

  describe('writeBool', () => {
    test('writes false as 0', () => {
      const writer = new BufferWriter();
      writer.writeBool(false);
      assert.deepEqual(writer.finish(), new Uint8Array([0x00]));
    });

    test('writes true as 1', () => {
      const writer = new BufferWriter();
      writer.writeBool(true);
      assert.deepEqual(writer.finish(), new Uint8Array([0x01]));
    });
  });

  describe('writeFixed32', () => {
    test('writes 32-bit value little-endian', () => {
      const writer = new BufferWriter();
      writer.writeFixed32(0x12345678);
      assert.deepEqual(writer.finish(), new Uint8Array([0x78, 0x56, 0x34, 0x12]));
    });

    test('writes zero', () => {
      const writer = new BufferWriter();
      writer.writeFixed32(0);
      assert.deepEqual(writer.finish(), new Uint8Array([0x00, 0x00, 0x00, 0x00]));
    });
  });

  describe('writeFixed64', () => {
    test('writes 64-bit value little-endian', () => {
      const writer = new BufferWriter();
      writer.writeFixed64(0x123456789abcdef0n);
      assert.deepEqual(
        writer.finish(),
        new Uint8Array([0xf0, 0xde, 0xbc, 0x9a, 0x78, 0x56, 0x34, 0x12]),
      );
    });
  });

  describe('writeFloat', () => {
    test('writes IEEE 754 float', () => {
      const writer = new BufferWriter();
      writer.writeFloat(1.0);
      // 1.0 as IEEE 754 float = 0x3f800000
      assert.deepEqual(writer.finish(), new Uint8Array([0x00, 0x00, 0x80, 0x3f]));
    });
  });

  describe('writeDouble', () => {
    test('writes IEEE 754 double', () => {
      const writer = new BufferWriter();
      writer.writeDouble(1.0);
      // 1.0 as IEEE 754 double = 0x3ff0000000000000
      assert.deepEqual(
        writer.finish(),
        new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f]),
      );
    });
  });

  describe('writeString', () => {
    test('writes length-delimited string', () => {
      const writer = new BufferWriter();
      writer.writeString('hello');
      // Length (5) + 'hello'
      assert.deepEqual(
        writer.finish(),
        new Uint8Array([0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]),
      );
    });

    test('writes empty string', () => {
      const writer = new BufferWriter();
      writer.writeString('');
      assert.deepEqual(writer.finish(), new Uint8Array([0x00]));
    });

    test('writes UTF-8 string', () => {
      const writer = new BufferWriter();
      writer.writeString('\u00e9'); // e with acute accent
      // Length (2) + UTF-8 bytes
      assert.deepEqual(writer.finish(), new Uint8Array([0x02, 0xc3, 0xa9]));
    });
  });

  describe('writeBytes', () => {
    test('writes raw bytes', () => {
      const writer = new BufferWriter();
      writer.writeBytes(new Uint8Array([0x01, 0x02, 0x03]));
      assert.deepEqual(writer.finish(), new Uint8Array([0x01, 0x02, 0x03]));
    });
  });

  describe('writeLengthDelimited', () => {
    test('writes length prefix + data', () => {
      const writer = new BufferWriter();
      writer.writeLengthDelimited(new Uint8Array([0x01, 0x02, 0x03]));
      assert.deepEqual(writer.finish(), new Uint8Array([0x03, 0x01, 0x02, 0x03]));
    });
  });

  describe('writeSint32', () => {
    test('writes ZigZag encoded value', () => {
      const writer = new BufferWriter();
      writer.writeSint32(-1);
      // ZigZag(-1) = 1
      assert.deepEqual(writer.finish(), new Uint8Array([0x01]));
    });

    test('writes positive value', () => {
      const writer = new BufferWriter();
      writer.writeSint32(1);
      // ZigZag(1) = 2
      assert.deepEqual(writer.finish(), new Uint8Array([0x02]));
    });
  });

  // Coverage gap: writeSint64/writeSfixed32/writeSfixed64 had no tests at all,
  // surfaced by --experimental-test-coverage funcs % showing 86.36%.

  describe('writeSint64', () => {
    test('encodes ZigZag(-1) as varint 1', () => {
      const writer = new BufferWriter();
      writer.writeSint64(-1n);
      assert.deepEqual(writer.finish(), new Uint8Array([0x01]));
    });

    test('encodes INT64_MIN as 10-byte varint', () => {
      const writer = new BufferWriter();
      writer.writeSint64(-(1n << 63n));
      // ZigZag(INT64_MIN) = 2^64-1 → 10-byte varint of all-ones+0x01
      const out = writer.finish();
      assert.equal(out.length, 10);
    });
  });

  describe('writeSfixed32', () => {
    test('writes -1 as 0xffffffff little-endian', () => {
      const writer = new BufferWriter();
      writer.writeSfixed32(-1);
      assert.deepEqual(writer.finish(), new Uint8Array([0xff, 0xff, 0xff, 0xff]));
    });
  });

  describe('writeSfixed64', () => {
    test('writes -1n as 8 bytes of 0xff little-endian', () => {
      const writer = new BufferWriter();
      writer.writeSfixed64(-1n);
      assert.deepEqual(
        writer.finish(),
        new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      );
    });

    test('roundtrips with readSfixed64', () => {
      // Pin that writer + reader agree on sfixed64 byte layout — the
      // writeSfixed64 path delegates to writeFixed64 which splits via
      // 32-bit halves; a sign-extension regression there would silently
      // skew the high half.
      const writer = new BufferWriter();
      writer.writeSfixed64(-(1n << 62n));
      const reader = new BufferReader(writer.finish());
      assert.equal(reader.readSfixed64(), -(1n << 62n));
    });
  });

  describe('fork and join', () => {
    test('creates sub-message with length prefix', () => {
      const writer = new BufferWriter();
      writer.writeTag(1, WireType.LengthDelimited);

      const sub = writer.fork();
      sub.writeTag(1, WireType.Varint);
      sub.writeVarint(42);

      writer.join(sub);

      // Tag (10) + Length (2) + SubTag (8) + Value (42)
      assert.deepEqual(writer.finish(), new Uint8Array([0x0a, 0x02, 0x08, 0x2a]));
    });
  });

  describe('reset', () => {
    test('clears buffer for reuse', () => {
      const writer = new BufferWriter();
      writer.writeVarint(1);
      writer.reset();
      writer.writeVarint(2);
      assert.deepEqual(writer.finish(), new Uint8Array([0x02]));
    });
  });

  describe('length', () => {
    test('returns current buffer length', () => {
      const writer = new BufferWriter();
      assert.equal(writer.length, 0);
      writer.writeVarint(1);
      assert.equal(writer.length, 1);
      writer.writeString('hello');
      assert.equal(writer.length, 7); // 1 + length(1) + 'hello'(5)
    });
  });

  describe('complete message example', () => {
    test('writes a simple protobuf message', () => {
      // Message: { name: "Alice", age: 30 }
      // Field 1 (name): tag=10, string="Alice"
      // Field 2 (age): tag=16, varint=30
      const writer = new BufferWriter();

      // Write name field
      writer.writeTag(1, WireType.LengthDelimited);
      writer.writeString('Alice');

      // Write age field
      writer.writeTag(2, WireType.Varint);
      writer.writeVarint(30);

      const result = writer.finish();
      // Tag1(10) + Len(5) + "Alice" + Tag2(16) + 30
      assert.deepEqual(
        result,
        new Uint8Array([0x0a, 0x05, 0x41, 0x6c, 0x69, 0x63, 0x65, 0x10, 0x1e]),
      );
    });
  });
});
