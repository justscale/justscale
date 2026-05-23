import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSerializedClass, type FieldDef } from '../../../src/runtime/protobuf/serialized.js';
import { BufferWriter } from '../../../src/runtime/protobuf/encoding/writer.js';
import { BufferReader } from '../../../src/runtime/protobuf/encoding/reader.js';
import { WireType } from '../../../src/runtime/protobuf/encoding/wire-types.js';

const simpleFields: FieldDef[] = [
  { number: 1, name: 'name', type: 'string' },
  { number: 2, name: 'age', type: 'int32' },
];

interface Simple { name: string; age: number; }

describe('Serialized<T>', () => {
  const Simple = createSerializedClass<Simple>({ fields: simpleFields });

  describe('fromObject', () => {
    it('creates from plain object and reads back', () => {
      const s = Simple.fromObject({ name: 'Alice', age: 30 });
      assert.strictEqual(s.name, 'Alice');
      assert.strictEqual(s.age, 30);
    });

    it('has bytes', () => {
      const s = Simple.fromObject({ name: 'Bob', age: 25 });
      assert.ok(s.bytes instanceof Uint8Array);
      assert.ok(s.bytes.length > 0);
    });

    it('returns defaults for missing fields', () => {
      const s = Simple.fromObject({});
      assert.strictEqual(s.name, '');
      assert.strictEqual(s.age, 0);
    });
  });

  describe('from (raw bytes)', () => {
    it('reads fields from protobuf bytes', () => {
      // Manually encode using our fromObject, then re-read with from()
      const original = Simple.fromObject({ name: 'Eve', age: 42 });
      const bytes = original.bytes;

      const s = Simple.from(bytes);
      assert.strictEqual(s.name, 'Eve');
      assert.strictEqual(s.age, 42);
    });
  });

  describe('setters', () => {
    it('setting a field updates the value', () => {
      const s = Simple.fromObject({ name: 'Alice', age: 30 });
      assert.strictEqual(s.name, 'Alice');

      s.name = 'Bob';
      assert.strictEqual(s.name, 'Bob');
    });

    it('setting grows the bytes (append, last wins)', () => {
      const s = Simple.fromObject({ name: 'A', age: 1 });
      const origLen = s.bytes.length;

      s.name = 'A much longer name';
      assert.ok(s.bytes.length > origLen, 'bytes should have grown');
      assert.strictEqual(s.name, 'A much longer name');
    });

    it('new bytes are valid protobuf (roundtrip via from)', () => {
      const s1 = Simple.fromObject({ name: 'X', age: 5 });
      s1.name = 'Updated';
      s1.age = 99;

      // Create a new view from the raw bytes — should read the updated values
      const s2 = Simple.from(s1.bytes);
      assert.strictEqual(s2.name, 'Updated');
      assert.strictEqual(s2.age, 99);
    });
  });

  describe('different inputs produce different bytes', () => {
    it('different values are not equal', () => {
      const a = Simple.fromObject({ name: 'A', age: 1 });
      const b = Simple.fromObject({ name: 'B', age: 2 });
      assert.notDeepStrictEqual(a.bytes, b.bytes);
    });
  });

  describe('bool fields', () => {
    const BoolSchema = createSerializedClass<{ active: boolean }>({
      fields: [{ number: 1, name: 'active', type: 'bool' }],
    });

    it('roundtrips true', () => {
      const s = BoolSchema.fromObject({ active: true });
      assert.strictEqual(s.active, true);
    });

    it('roundtrips false', () => {
      const s = BoolSchema.fromObject({ active: false });
      assert.strictEqual(s.active, false);
    });

    it('default is false', () => {
      const s = BoolSchema.fromObject({});
      assert.strictEqual(s.active, false);
    });
  });

  describe('wire compatibility with BufferWriter/Reader', () => {
    it('Serialized bytes can be read by BufferReader', () => {
      const s = Simple.fromObject({ name: 'Test', age: 7 });
      const reader = new BufferReader(s.bytes);

      // Read field 1: string
      const tag1 = reader.readTag();
      assert.strictEqual(tag1.fieldNumber, 1);
      assert.strictEqual(tag1.wireType, WireType.LengthDelimited);
      const name = reader.readString();
      assert.strictEqual(name, 'Test');

      // Read field 2: int32
      const tag2 = reader.readTag();
      assert.strictEqual(tag2.fieldNumber, 2);
      assert.strictEqual(tag2.wireType, WireType.Varint);
      const age = Number(reader.readVarint());
      assert.strictEqual(age, 7);
    });

    it('BufferWriter bytes can be read by Serialized', () => {
      const writer = new BufferWriter();
      writer.writeTag(1, WireType.LengthDelimited);
      writer.writeString('FromWriter');
      writer.writeTag(2, WireType.Varint);
      writer.writeVarint(55);
      const bytes = writer.finish();

      const s = Simple.from(bytes);
      assert.strictEqual(s.name, 'FromWriter');
      assert.strictEqual(s.age, 55);
    });

    it('byte output matches between Serialized and BufferWriter', () => {
      const s = Simple.fromObject({ name: 'Hi', age: 3 });

      const writer = new BufferWriter();
      writer.writeTag(1, WireType.LengthDelimited);
      writer.writeString('Hi');
      writer.writeTag(2, WireType.Varint);
      writer.writeVarint(3);
      const writerBytes = writer.finish();

      assert.deepStrictEqual(s.bytes, writerBytes);
    });
  });

  describe('sint32 (zigzag)', () => {
    const Schema = createSerializedClass<{ value: number }>({
      fields: [{ number: 1, name: 'value', type: 'sint32' }],
    });

    it('roundtrips positive', () => {
      const s = Schema.fromObject({ value: 42 });
      assert.strictEqual(s.value, 42);
    });

    it('roundtrips negative', () => {
      const s = Schema.fromObject({ value: -1 });
      assert.strictEqual(s.value, -1);
    });

    it('roundtrips large negative', () => {
      const s = Schema.fromObject({ value: -12345 });
      assert.strictEqual(s.value, -12345);
    });

    it('roundtrips zero', () => {
      const s = Schema.fromObject({ value: 0 });
      assert.strictEqual(s.value, 0);
    });

    it('roundtrips via from(bytes)', () => {
      const s1 = Schema.fromObject({ value: -99 });
      const s2 = Schema.from(s1.bytes);
      assert.strictEqual(s2.value, -99);
    });
  });

  describe('negative int32 (10-byte varint)', () => {
    const Schema = createSerializedClass<{ value: number }>({
      fields: [{ number: 1, name: 'value', type: 'int32' }],
    });

    it('roundtrips -1', () => {
      const s = Schema.fromObject({ value: -1 });
      const s2 = Schema.from(s.bytes);
      assert.strictEqual(s2.value, -1);
    });

    it('roundtrips -2147483648 (INT32_MIN)', () => {
      const s = Schema.fromObject({ value: -2147483648 });
      const s2 = Schema.from(s.bytes);
      assert.strictEqual(s2.value, -2147483648);
    });
  });

  describe('fixed32/sfixed32', () => {
    const Schema = createSerializedClass<{ u: number; s: number }>({
      fields: [
        { number: 1, name: 'u', type: 'fixed32' },
        { number: 2, name: 's', type: 'sfixed32' },
      ],
    });

    it('roundtrips', () => {
      const s = Schema.fromObject({ u: 0xDEADBEEF, s: -42 });
      const s2 = Schema.from(s.bytes);
      assert.strictEqual(s2.u, 0xDEADBEEF);
      assert.strictEqual(s2.s, -42);
    });
  });

  describe('fixed64/sfixed64', () => {
    const Schema = createSerializedClass<{ u: number; s: number }>({
      fields: [
        { number: 1, name: 'u', type: 'fixed64' },
        { number: 2, name: 's', type: 'sfixed64' },
      ],
    });

    it('roundtrips', () => {
      const s = Schema.fromObject({ u: 123456789, s: -987654321 });
      const s2 = Schema.from(s.bytes);
      assert.strictEqual(s2.u, 123456789);
      assert.strictEqual(s2.s, -987654321);
    });
  });

  describe('double', () => {
    const Schema = createSerializedClass<{ value: number }>({
      fields: [{ number: 1, name: 'value', type: 'double' }],
    });

    it('roundtrips PI', () => {
      const s = Schema.fromObject({ value: Math.PI });
      assert.strictEqual(s.value, Math.PI);
    });

    it('roundtrips negative', () => {
      const s = Schema.fromObject({ value: -1.5 });
      assert.strictEqual(s.value, -1.5);
    });

    it('roundtrips Infinity', () => {
      const s = Schema.fromObject({ value: Infinity });
      assert.strictEqual(s.value, Infinity);
    });
  });

  describe('float', () => {
    const Schema = createSerializedClass<{ value: number }>({
      fields: [{ number: 1, name: 'value', type: 'float' }],
    });

    it('roundtrips (with float precision)', () => {
      const s = Schema.fromObject({ value: 3.14 });
      assert.ok(Math.abs(s.value - 3.14) < 0.001);
    });
  });

  describe('bytes field with binary data', () => {
    const Schema = createSerializedClass<{ data: Uint8Array }>({
      fields: [{ number: 1, name: 'data', type: 'bytes' }],
    });

    it('roundtrips binary data', () => {
      const binary = new Uint8Array([0, 1, 2, 255, 128, 64]);
      const s = Schema.fromObject({ data: binary });
      const s2 = Schema.from(s.bytes);
      assert.deepStrictEqual(s2.data, binary);
    });

    it('handles empty bytes', () => {
      const s = Schema.fromObject({ data: new Uint8Array(0) });
      assert.strictEqual(s.data.length, 0);
    });
  });

  describe('repeated fields', () => {
    const Schema = createSerializedClass<{ tags: string[]; scores: number[] }>({
      fields: [
        { number: 1, name: 'tags', type: 'string', repeated: true },
        { number: 2, name: 'scores', type: 'int32', repeated: true },
      ],
    });

    it('roundtrips repeated strings', () => {
      const s = Schema.fromObject({ tags: ['a', 'b', 'c'] } as any);
      assert.deepStrictEqual(s.tags, ['a', 'b', 'c']);
    });

    it('empty repeated is empty array', () => {
      const s = Schema.fromObject({} as any);
      assert.deepStrictEqual(s.tags, []);
      assert.deepStrictEqual(s.scores, []);
    });
  });

  describe('last-wins semantics', () => {
    it('later value overwrites earlier for same field', () => {
      // Manually construct bytes with field 1 written twice
      const s1 = Simple.fromObject({ name: 'First', age: 1 });
      s1.name = 'Second';  // appends, so bytes have both
      const s2 = Simple.from(s1.bytes);
      assert.strictEqual(s2.name, 'Second');  // last wins
    });
  });

  describe('oneof', () => {
    interface Result { error?: string; value?: number; }
    const ResultSchema = createSerializedClass<Result>({
      fields: [
        { number: 1, name: 'error', type: 'string', oneOf: 'result' },
        { number: 2, name: 'value', type: 'int32', oneOf: 'result' },
      ],
      oneOfs: [{ name: 'result', fields: ['error', 'value'] }],
    });

    it('reads the set field', () => {
      const s = ResultSchema.fromObject({ error: 'fail' });
      assert.strictEqual(s.error, 'fail');
      assert.strictEqual(s.value, undefined);
    });

    it('reads the other field', () => {
      const s = ResultSchema.fromObject({ value: 42 });
      assert.strictEqual(s.value, 42);
      assert.strictEqual(s.error, undefined);
    });

    it('setting one clears the other', () => {
      const s = ResultSchema.fromObject({ error: 'fail' });
      assert.strictEqual(s.error, 'fail');
      assert.strictEqual(s.value, undefined);

      s.value = 99;
      assert.strictEqual(s.value, 99);
      assert.strictEqual(s.error, undefined); // should be cleared
    });

    it('last set wins after roundtrip', () => {
      const s = ResultSchema.fromObject({ error: 'first' });
      s.value = 42;  // set value after error
      const s2 = ResultSchema.from(s.bytes);
      assert.strictEqual(s2.value, 42);
      assert.strictEqual(s2.error, undefined);
    });

    it('both absent returns defaults', () => {
      const s = ResultSchema.fromObject({});
      assert.strictEqual(s.error, undefined);
      assert.strictEqual(s.value, undefined);
    });
  });

  describe('nested messages', () => {
    const AddressSchema = createSerializedClass<{ street: string; city: string }>({
      fields: [
        { number: 1, name: 'street', type: 'string' },
        { number: 2, name: 'city', type: 'string' },
      ],
    });

    const PersonSchema = createSerializedClass<{ name: string; address: { street: string; city: string } }>({
      fields: [
        { number: 1, name: 'name', type: 'string' },
        { number: 2, name: 'address', type: 'message', messageSchema: { fields: AddressSchema as any, create: (b: Uint8Array) => (AddressSchema as any).from(b) } as any },
      ],
    });

    it('reads nested message fields', () => {
      // Create address bytes first
      const addr = AddressSchema.fromObject({ street: '123 Main', city: 'Springfield' });
      // Create person with address as nested bytes
      const person = PersonSchema.fromObject({ name: 'Homer', address: addr as any });
      assert.strictEqual(person.name, 'Homer');
    });
  });

  // CONTRACT: buildIndex (lazy on first field access) must reject truncated
  // or oversize-length inputs at the offending tag rather than silently
  // building a corrupt index whose entries point past the buffer end.
  // Same defense-in-depth as reader.skip() — we may receive bytes from a
  // wire/disk source that doesn't share our trust assumptions.

  describe('buildIndex rejects malformed bytes', () => {
    const ScalarSchema = createSerializedClass<{ a: number; b: number; c: bigint; d: string }>({
      fields: [
        { number: 1, name: 'a', type: 'fixed32' },
        { number: 2, name: 'b', type: 'fixed32' },
        { number: 3, name: 'c', type: 'fixed64' },
        { number: 4, name: 'd', type: 'string' },
      ],
    });

    it('throws on truncated fixed32', () => {
      // Tag for field 1, wireType=Fixed32(5) → (1<<3)|5 = 13 = 0x0d
      // Then only 2 bytes (need 4).
      const truncated = new Uint8Array([0x0d, 0xaa, 0xbb]);
      const s = ScalarSchema.from(truncated);
      assert.throws(() => s.a, /Truncated fixed32/);
    });

    it('throws on truncated fixed64', () => {
      // Tag for field 3, wireType=Fixed64(1) → (3<<3)|1 = 25 = 0x19
      // Then only 3 bytes (need 8).
      const truncated = new Uint8Array([0x19, 0x01, 0x02, 0x03]);
      const s = ScalarSchema.from(truncated);
      assert.throws(() => s.c, /Truncated fixed64/);
    });

    it('throws on length-delimited prefix that exceeds buffer', () => {
      // Tag for field 4 (string), wireType=LengthDelimited(2) → (4<<3)|2 = 34 = 0x22
      // Length prefix says 100 bytes, only 3 bytes follow.
      const truncated = new Uint8Array([0x22, 0x64, 0x01, 0x02, 0x03]);
      const s = ScalarSchema.from(truncated);
      assert.throws(() => s.d, /Truncated length-delimited/);
    });

    it('exact-fit length-delimited succeeds', () => {
      // Tag 0x22 (field 4, length-delimited), length=3, then exactly 3 bytes "abc"
      const exact = new Uint8Array([0x22, 0x03, 0x61, 0x62, 0x63]);
      const s = ScalarSchema.from(exact);
      assert.strictEqual(s.d, 'abc');
    });
  });
});
