/**
 * Tests for BufferReader.
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { BufferReader } from '../../../../src/runtime/protobuf/encoding/reader.js';
import { BufferWriter } from '../../../../src/runtime/protobuf/encoding/writer.js';
import { WireType } from '../../../../src/runtime/protobuf/encoding/wire-types.js';

describe('BufferReader', () => {
  describe('readVarint', () => {
    test('reads single byte varint', () => {
      const reader = new BufferReader(new Uint8Array([0x01]));
      assert.equal(reader.readVarint(), 1n);
    });

    test('reads multi-byte varint', () => {
      const reader = new BufferReader(new Uint8Array([0xac, 0x02]));
      assert.equal(reader.readVarint(), 300n);
    });

    test('advances position', () => {
      const reader = new BufferReader(new Uint8Array([0x01, 0xac, 0x02]));
      reader.readVarint();
      assert.equal(reader.position, 1);
      reader.readVarint();
      assert.equal(reader.position, 3);
    });
  });

  describe('readVarint32', () => {
    test('reads varint as 32-bit number', () => {
      const reader = new BufferReader(new Uint8Array([0xac, 0x02]));
      assert.equal(reader.readVarint32(), 300);
    });
  });

  describe('readTag', () => {
    test('reads field tag', () => {
      const reader = new BufferReader(new Uint8Array([0x08]));
      const tag = reader.readTag();
      assert.equal(tag.fieldNumber, 1);
      assert.equal(tag.wireType, WireType.Varint);
    });

    test('reads length-delimited tag', () => {
      const reader = new BufferReader(new Uint8Array([0x0a]));
      const tag = reader.readTag();
      assert.equal(tag.fieldNumber, 1);
      assert.equal(tag.wireType, WireType.LengthDelimited);
    });
  });

  describe('readBool', () => {
    test('reads false', () => {
      const reader = new BufferReader(new Uint8Array([0x00]));
      assert.equal(reader.readBool(), false);
    });

    test('reads true', () => {
      const reader = new BufferReader(new Uint8Array([0x01]));
      assert.equal(reader.readBool(), true);
    });
  });

  describe('readFixed32', () => {
    test('reads 32-bit value little-endian', () => {
      const reader = new BufferReader(new Uint8Array([0x78, 0x56, 0x34, 0x12]));
      assert.equal(reader.readFixed32(), 0x12345678);
    });
  });

  describe('readSfixed32', () => {
    test('reads signed 32-bit value', () => {
      const reader = new BufferReader(new Uint8Array([0xff, 0xff, 0xff, 0xff]));
      assert.equal(reader.readSfixed32(), -1);
    });
  });

  describe('readFixed64', () => {
    test('reads 64-bit value little-endian', () => {
      const reader = new BufferReader(
        new Uint8Array([0xf0, 0xde, 0xbc, 0x9a, 0x78, 0x56, 0x34, 0x12]),
      );
      assert.equal(reader.readFixed64(), 0x123456789abcdef0n);
    });
  });

  describe('readFloat', () => {
    test('reads IEEE 754 float', () => {
      const reader = new BufferReader(new Uint8Array([0x00, 0x00, 0x80, 0x3f]));
      assert.equal(reader.readFloat(), 1.0);
    });
  });

  describe('readDouble', () => {
    test('reads IEEE 754 double', () => {
      const reader = new BufferReader(
        new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f]),
      );
      assert.equal(reader.readDouble(), 1.0);
    });
  });

  describe('readString', () => {
    test('reads length-delimited string', () => {
      const reader = new BufferReader(
        new Uint8Array([0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f]),
      );
      assert.equal(reader.readString(), 'hello');
    });

    test('reads empty string', () => {
      const reader = new BufferReader(new Uint8Array([0x00]));
      assert.equal(reader.readString(), '');
    });

    test('reads UTF-8 string', () => {
      const reader = new BufferReader(new Uint8Array([0x02, 0xc3, 0xa9]));
      assert.equal(reader.readString(), '\u00e9');
    });
  });

  describe('readBytes', () => {
    test('reads raw bytes', () => {
      const reader = new BufferReader(new Uint8Array([0x01, 0x02, 0x03]));
      assert.deepEqual(reader.readBytes(3), new Uint8Array([0x01, 0x02, 0x03]));
    });
  });

  describe('readLengthDelimited', () => {
    test('reads length prefix + data', () => {
      const reader = new BufferReader(new Uint8Array([0x03, 0x01, 0x02, 0x03]));
      assert.deepEqual(reader.readLengthDelimited(), new Uint8Array([0x01, 0x02, 0x03]));
    });
  });

  describe('readSint32', () => {
    test('reads ZigZag decoded value', () => {
      const reader = new BufferReader(new Uint8Array([0x01]));
      assert.equal(reader.readSint32(), -1);
    });

    test('reads positive value', () => {
      const reader = new BufferReader(new Uint8Array([0x02]));
      assert.equal(reader.readSint32(), 1);
    });
  });

  describe('readSint64', () => {
    test('reads ZigZag decoded 64-bit value', () => {
      const reader = new BufferReader(new Uint8Array([0x01]));
      assert.equal(reader.readSint64(), -1n);
    });
  });

  describe('skip', () => {
    test('skips varint field', () => {
      const reader = new BufferReader(new Uint8Array([0xac, 0x02, 0x42]));
      reader.skip(WireType.Varint);
      assert.equal(reader.position, 2);
    });

    test('skips fixed32 field', () => {
      const reader = new BufferReader(new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x42]));
      reader.skip(WireType.Fixed32);
      assert.equal(reader.position, 4);
    });

    test('skips fixed64 field', () => {
      const reader = new BufferReader(
        new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x42]),
      );
      reader.skip(WireType.Fixed64);
      assert.equal(reader.position, 8);
    });

    test('skips length-delimited field', () => {
      const reader = new BufferReader(new Uint8Array([0x03, 0x01, 0x02, 0x03, 0x42]));
      reader.skip(WireType.LengthDelimited);
      assert.equal(reader.position, 4);
    });

    // Pre-fix bug: skip() did `pos += length` without bounds checking.
    // A malformed message with a huge length prefix would silently
    // advance pos past the buffer; subsequent reads then failed with
    // cryptic "Buffer underflow" errors at the next read site, not the
    // actual problem. Now bounded — fails at the skip site.

    test('REJECTS length-delimited skip past buffer end', () => {
      // Length prefix says 100 bytes, only 3 actual bytes after.
      // Pre-fix this would have set pos = 1 + 100 = 101, way past
      // the 4-byte buffer. Now throws at skip time.
      const reader = new BufferReader(new Uint8Array([0x64, 0x01, 0x02, 0x03]));
      assert.throws(() => reader.skip(WireType.LengthDelimited), /Buffer underflow/);
    });

    test('REJECTS fixed32 skip past buffer end', () => {
      const reader = new BufferReader(new Uint8Array([0x01]));
      assert.throws(() => reader.skip(WireType.Fixed32), /Buffer underflow/);
    });

    test('REJECTS fixed64 skip past buffer end', () => {
      const reader = new BufferReader(new Uint8Array([0x01, 0x02]));
      assert.throws(() => reader.skip(WireType.Fixed64), /Buffer underflow/);
    });

    test('exact-fit length-delimited skip succeeds without error', () => {
      // Length 3, buffer has exactly 3 bytes after the length prefix.
      const reader = new BufferReader(new Uint8Array([0x03, 0xaa, 0xbb, 0xcc]));
      assert.doesNotThrow(() => reader.skip(WireType.LengthDelimited));
      assert.equal(reader.position, 4, 'pos lands exactly at buffer end');
      assert.equal(reader.hasMore, false);
    });
  });

  // Coverage gap: each fixed-width reader has its own underflow throw,
  // pinned individually so a refactor that consolidates them can't drop
  // a check silently. Exposed by --experimental-test-coverage report
  // showing the throw branches as unhit.

  describe('fixed-width readers reject underflow', () => {
    test('readFixed32 throws on short buffer', () => {
      assert.throws(
        () => new BufferReader(new Uint8Array([0x01, 0x02])).readFixed32(),
        /Buffer underflow reading fixed32/,
      );
    });

    test('readSfixed32 throws on short buffer', () => {
      assert.throws(
        () => new BufferReader(new Uint8Array([0x01])).readSfixed32(),
        /Buffer underflow reading sfixed32/,
      );
    });

    test('readFixed64 throws on short buffer', () => {
      assert.throws(
        () => new BufferReader(new Uint8Array([0x01, 0x02, 0x03, 0x04])).readFixed64(),
        /Buffer underflow reading fixed64/,
      );
    });

    test('readSfixed64 throws on short buffer', () => {
      assert.throws(
        () => new BufferReader(new Uint8Array([0x01, 0x02, 0x03])).readSfixed64(),
        /Buffer underflow reading sfixed64/,
      );
    });

    test('readFloat throws on short buffer', () => {
      assert.throws(
        () => new BufferReader(new Uint8Array([0x01, 0x02])).readFloat(),
        /Buffer underflow reading float/,
      );
    });

    test('readDouble throws on short buffer', () => {
      assert.throws(
        () => new BufferReader(new Uint8Array([0x01, 0x02, 0x03, 0x04])).readDouble(),
        /Buffer underflow reading double/,
      );
    });

    test('readBytes throws when length exceeds remaining', () => {
      assert.throws(
        () => new BufferReader(new Uint8Array([0x01, 0x02])).readBytes(5),
        /Buffer underflow reading bytes/,
      );
    });
  });

  describe('readSfixed64 happy path (sign extension)', () => {
    test('reads -1 (all-ones little-endian)', () => {
      const reader = new BufferReader(
        new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
      );
      assert.equal(reader.readSfixed64(), -1n);
    });

    test('reads INT64_MIN', () => {
      // 0x8000000000000000 little-endian = INT64_MIN
      const reader = new BufferReader(
        new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80]),
      );
      assert.equal(reader.readSfixed64(), -(1n << 63n));
    });
  });

  describe('packed readers cover remaining shapes', () => {
    test('readPackedFixed64 reads two values', () => {
      // Length=16, then two 8-byte LE values: 1n, 2n
      const reader = new BufferReader(new Uint8Array([
        0x10,
        0x01, 0, 0, 0, 0, 0, 0, 0,
        0x02, 0, 0, 0, 0, 0, 0, 0,
      ]));
      assert.deepEqual(reader.readPackedFixed64(), [1n, 2n]);
    });

    test('readPackedFloat reads two floats', () => {
      // Length=8, two 4-byte floats: 1.0, 2.0
      const reader = new BufferReader(new Uint8Array([
        0x08,
        0x00, 0x00, 0x80, 0x3f,
        0x00, 0x00, 0x00, 0x40,
      ]));
      assert.deepEqual(reader.readPackedFloat(), [1.0, 2.0]);
    });

    test('readPackedDouble reads one double', () => {
      // Length=8, one 8-byte double: 1.0
      const reader = new BufferReader(new Uint8Array([
        0x08,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f,
      ]));
      assert.deepEqual(reader.readPackedDouble(), [1.0]);
    });
  });

  describe('remaining and hasMore', () => {
    test('reports remaining bytes', () => {
      const reader = new BufferReader(new Uint8Array([0x01, 0x02, 0x03]));
      assert.equal(reader.remaining, 3);
      assert.equal(reader.hasMore, true);
      reader.readVarint();
      assert.equal(reader.remaining, 2);
      assert.equal(reader.hasMore, true);
    });

    test('hasMore is false at end', () => {
      const reader = new BufferReader(new Uint8Array([0x01]));
      reader.readVarint();
      assert.equal(reader.hasMore, false);
      assert.equal(reader.remaining, 0);
    });
  });

  describe('readSubMessage', () => {
    test('creates sub-reader for embedded message', () => {
      // Length (2) + data (08, 2a) representing tag(1)=varint, value=42
      const reader = new BufferReader(new Uint8Array([0x02, 0x08, 0x2a, 0x42]));
      const sub = reader.readSubMessage();
      const tag = sub.readTag();
      assert.equal(tag.fieldNumber, 1);
      assert.equal(sub.readVarint(), 42n);
      assert.equal(reader.position, 3); // Main reader moved past the sub-message
    });
  });

  describe('packed repeated fields', () => {
    test('readPackedVarint reads array of varints', () => {
      // Length (3) + values (1, 2, 3)
      const reader = new BufferReader(new Uint8Array([0x03, 0x01, 0x02, 0x03]));
      const values = reader.readPackedVarint();
      assert.deepEqual(values, [1n, 2n, 3n]);
    });

    test('readPackedFixed32 reads array of fixed32', () => {
      // Length (8) + two 32-bit values
      const reader = new BufferReader(
        new Uint8Array([0x08, 0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]),
      );
      const values = reader.readPackedFixed32();
      assert.deepEqual(values, [1, 2]);
    });
  });

  describe('roundtrip with BufferWriter', () => {
    test('reads what writer wrote', () => {
      const writer = new BufferWriter();
      writer.writeTag(1, WireType.LengthDelimited);
      writer.writeString('Alice');
      writer.writeTag(2, WireType.Varint);
      writer.writeVarint(30);

      const reader = new BufferReader(writer.finish());

      // Read first field
      const tag1 = reader.readTag();
      assert.equal(tag1.fieldNumber, 1);
      assert.equal(tag1.wireType, WireType.LengthDelimited);
      assert.equal(reader.readString(), 'Alice');

      // Read second field
      const tag2 = reader.readTag();
      assert.equal(tag2.fieldNumber, 2);
      assert.equal(tag2.wireType, WireType.Varint);
      assert.equal(reader.readVarint(), 30n);

      assert.equal(reader.hasMore, false);
    });

    test('handles nested messages', () => {
      const writer = new BufferWriter();
      writer.writeTag(1, WireType.LengthDelimited);

      const sub = writer.fork();
      sub.writeTag(1, WireType.Varint);
      sub.writeVarint(42);
      writer.join(sub);

      const reader = new BufferReader(writer.finish());

      const tag1 = reader.readTag();
      assert.equal(tag1.fieldNumber, 1);
      assert.equal(tag1.wireType, WireType.LengthDelimited);

      const subReader = reader.readSubMessage();
      const innerTag = subReader.readTag();
      assert.equal(innerTag.fieldNumber, 1);
      assert.equal(subReader.readVarint(), 42n);
    });
  });
});
