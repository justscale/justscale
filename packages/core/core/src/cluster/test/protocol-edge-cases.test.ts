/**
 * Edge-case tests for the cluster wire protocol.
 *
 * Covers: framing edge cases, zero-length payloads, over-large frames,
 * chunk boundaries, reset(), mixed wire formats, and message-builder
 * invariants.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeFrame,
  encodeFrameV2,
  FrameDecoder,
  createRequest,
  createResponse,
  createErrorResponse,
  createStream,
  createEvent,
  setProtoCodec,
  ErrorCodes,
  PROTOCOL_V1_CBOR,
  WIRE_FORMAT_CBOR,
  WIRE_FORMAT_PROTO,
  isRequest,
  isResponse,
  isSuccessResponse,
  isErrorResponse,
  isStream,
  isEvent,
  type Message,
  type ProtoCodec,
} from '../protocol.js';

const jsonCodec: ProtoCodec = {
  encode: (m) => new TextEncoder().encode(JSON.stringify(m)),
  decode: (d) => JSON.parse(new TextDecoder().decode(d)) as Message,
};

// Matches LENGTH_SIZE in protocol.ts — the 4-byte big-endian length header.
const LENGTH_HEADER_SIZE = 4;

describe('Cluster protocol edge cases', () => {
  describe('framing: byte-by-byte reassembly', () => {
    it('decoder accepts one byte at a time', () => {
      const msg = createRequest('method.x', { n: 1 });
      const frame = encodeFrame(msg);
      const decoder = new FrameDecoder();
      let emitted: Message[];
      for (let i = 0; i < frame.length - 1; i++) {
        emitted = decoder.push(new Uint8Array([frame[i]!]));
        assert.equal(emitted.length, 0, `byte ${i} should be buffered`);
        assert.equal(decoder.hasPending, true);
      }
      emitted = decoder.push(new Uint8Array([frame[frame.length - 1]!]));
      assert.equal(emitted.length, 1);
      assert.equal(decoder.hasPending, false);
    });

    it('decoder accepts two complete frames in one push', () => {
      const a = encodeFrame(createRequest('a'));
      const b = encodeFrame(createResponse('id-b', { ok: 1 }));
      const merged = new Uint8Array(a.length + b.length);
      merged.set(a);
      merged.set(b, a.length);
      const d = new FrameDecoder();
      const msgs = d.push(merged);
      assert.equal(msgs.length, 2);
      assert.ok(isRequest(msgs[0]!));
      assert.ok(isResponse(msgs[1]!));
    });

    it('handles 1.5 frames: one complete, one partial', () => {
      const a = encodeFrame(createRequest('a'));
      const b = encodeFrame(createRequest('b'));
      const cut = Math.floor(b.length / 2);
      const first = new Uint8Array(a.length + cut);
      first.set(a);
      first.set(b.slice(0, cut), a.length);
      const d = new FrameDecoder();
      let msgs = d.push(first);
      assert.equal(msgs.length, 1);
      assert.equal(decoderPending(d), true);
      msgs = d.push(b.slice(cut));
      assert.equal(msgs.length, 1);
      assert.equal((msgs[0] as any).method, 'b');
    });

    it('reset() clears pending buffer', () => {
      const d = new FrameDecoder();
      d.push(new Uint8Array([0, 0, 0, 10, 1, 2, 3])); // partial
      assert.equal(decoderPending(d), true);
      d.reset();
      assert.equal(decoderPending(d), false);
    });
  });

  describe('framing: rejection paths', () => {
    it('rejects frames that declare > 16MB payload (CBOR oversize path)', () => {
      // Any length header with high byte >= 0x02 is strictly oversized
      // (>= 0x02_00_00_00 = 32MB, well above the 16MB limit). The decoder
      // must route this through the too-large guard instead of routing
      // by first-byte into the wrong codec branch.
      const buf = new Uint8Array(LENGTH_HEADER_SIZE);
      // 0x02_00_00_00 = 33554432 bytes declared -> far over MAX.
      new DataView(buf.buffer).setUint32(0, 0x02_00_00_00, false);
      const d = new FrameDecoder();
      assert.throws(() => d.push(buf), /too large/i);
    });

    it('rejects frames whose length sits exactly between 16MB and proto tag', () => {
      // Reproduces the original bug: a CBOR sender claiming 16MB + 1 has
      // first byte 0x01, which used to route to the proto branch and
      // bypass the CBOR oversize guard. With proper discrimination this
      // must throw "too large" (the proto branch also guards, so either
      // way the oversized claim is rejected). If no proto codec is
      // registered, the oversize check must fire BEFORE the missing-codec
      // check, because the payload can never be valid.
      setProtoCodec(null as unknown as ProtoCodec);
      const buf = new Uint8Array(1 + LENGTH_HEADER_SIZE);
      // A 4-byte BE length of 16MB + 1 starting at offset 0 begins with
      // 0x01, matching the proto marker by coincidence. With the fix the
      // decoder now reads it as proto, sees length > MAX, and throws.
      buf[0] = 0x01;
      new DataView(buf.buffer).setUint32(1, 16 * 1024 * 1024 + 1, false);
      const d = new FrameDecoder();
      assert.throws(() => d.push(buf), /too large/i);
    });

    it('rejects proto frames with oversized declared length', () => {
      setProtoCodec(jsonCodec);
      const buf = new Uint8Array(5);
      buf[0] = WIRE_FORMAT_PROTO;
      new DataView(buf.buffer).setUint32(1, 20 * 1024 * 1024, false);
      const d = new FrameDecoder();
      assert.throws(() => d.push(buf), /too large/i);
    });

    it('proto frame without registered codec throws', () => {
      setProtoCodec(null as unknown as ProtoCodec);
      const d = new FrameDecoder();
      // Build a proto frame manually (won't decode because codec is null)
      const header = new Uint8Array(5);
      header[0] = WIRE_FORMAT_PROTO;
      new DataView(header.buffer).setUint32(1, 4, false);
      const body = new Uint8Array([1, 2, 3, 4]);
      const combined = new Uint8Array(header.length + body.length);
      combined.set(header);
      combined.set(body, header.length);
      assert.throws(
        () => d.push(combined),
        /proto codec|Proto codec/,
      );
    });

    it('encodeFrameV2(PROTO) throws when no codec is registered', () => {
      setProtoCodec(null as unknown as ProtoCodec);
      assert.throws(
        () => encodeFrameV2(createRequest('x'), WIRE_FORMAT_PROTO),
        /Proto codec not registered/,
      );
    });
  });

  describe('message builders', () => {
    it('createRequest produces a unique id per call', () => {
      const a = createRequest('m');
      const b = createRequest('m');
      assert.notEqual(a.id, b.id);
      assert.equal(a.type, 'request');
      assert.equal(a.v, PROTOCOL_V1_CBOR);
    });

    it('createRequest accepts a caller-provided id', () => {
      const m = createRequest('m', undefined, 'fixed-id');
      assert.equal(m.id, 'fixed-id');
    });

    it('createResponse carries result and ok=true', () => {
      const m = createResponse('id-1', { x: 2 });
      assert.equal(m.ok, true);
      assert.deepEqual(m.result, { x: 2 });
    });

    it('createErrorResponse carries error code+message', () => {
      const m = createErrorResponse('id-1', ErrorCodes.INVALID_PARAMS, 'boom');
      assert.equal(m.ok, false);
      assert.equal(m.error.code, ErrorCodes.INVALID_PARAMS);
      assert.equal(m.error.message, 'boom');
    });

    it('createStream increments seq per (id,channel) and resets on done', () => {
      const s1 = createStream('sid', 'out', 'a');
      const s2 = createStream('sid', 'out', 'b');
      const s3 = createStream('sid', 'out', 'c', true); // done resets counter
      const s4 = createStream('sid', 'out', 'd');
      assert.ok(s1.seq! < s2.seq!);
      assert.ok(s2.seq! < s3.seq!);
      // After done, counter resets — s4 should start again (seq=1 in fresh run)
      assert.ok(s4.seq! <= s3.seq!);
    });

    it('createStream separates seq between different channels', () => {
      const a1 = createStream('sid2', 'stdout', 1);
      const b1 = createStream('sid2', 'stderr', 2);
      // Both start from 1 because distinct channels
      assert.equal(a1.seq, b1.seq);
    });

    it('createEvent has no id and no response contract', () => {
      const e = createEvent('tick', { t: 1 });
      assert.equal(e.type, 'event');
      assert.equal((e as any).id, undefined);
    });
  });

  describe('type guards', () => {
    it('identify each message type correctly', () => {
      const req = createRequest('x');
      const ok = createResponse('id', null);
      const err = createErrorResponse('id', 'E', 'x');
      const stream = createStream('id', 'c', 0);
      const event = createEvent('e');
      assert.ok(isRequest(req));
      assert.ok(isResponse(ok));
      assert.ok(isSuccessResponse(ok));
      assert.ok(!isErrorResponse(ok));
      assert.ok(isErrorResponse(err));
      assert.ok(!isSuccessResponse(err));
      assert.ok(isStream(stream));
      assert.ok(isEvent(event));
    });
  });

  describe('round-trip: every builder through encodeFrame', () => {
    it('request', () => {
      const m = createRequest('m', { a: 1 });
      const d = new FrameDecoder();
      const [back] = d.push(encodeFrame(m));
      assert.deepEqual(back, m);
    });
    it('response', () => {
      const m = createResponse('id', { list: [1, 2, 3] });
      const d = new FrameDecoder();
      const [back] = d.push(encodeFrame(m));
      assert.deepEqual(back, m);
    });
    it('stream (not done)', () => {
      const m = createStream('id', 'stdout', 'hello');
      const d = new FrameDecoder();
      const [back] = d.push(encodeFrame(m));
      assert.equal((back as any).channel, 'stdout');
    });
    it('event', () => {
      const m = createEvent('hi', { n: 7 });
      const d = new FrameDecoder();
      const [back] = d.push(encodeFrame(m));
      assert.equal((back as any).event, 'hi');
    });
  });

  describe('proto wire format', () => {
    beforeEach(() => setProtoCodec(jsonCodec));

    it('preserves type+content through proto frame', () => {
      const m = createStream('s', 'progress', { pct: 50 });
      const f = encodeFrameV2(m, WIRE_FORMAT_PROTO);
      assert.equal(f[0], WIRE_FORMAT_PROTO);
      const d = new FrameDecoder();
      const [back] = d.push(f);
      assert.equal(back.type, 'stream');
      assert.equal((back as any).channel, 'progress');
    });

    it('mixed stream: CBOR then proto then CBOR decodes cleanly', () => {
      const f1 = encodeFrame(createRequest('c1'));
      const f2 = encodeFrameV2(createEvent('p'), WIRE_FORMAT_PROTO);
      const f3 = encodeFrame(createResponse('r', true));
      const merged = new Uint8Array(f1.length + f2.length + f3.length);
      merged.set(f1);
      merged.set(f2, f1.length);
      merged.set(f3, f1.length + f2.length);
      const d = new FrameDecoder();
      const msgs = d.push(merged);
      assert.equal(msgs.length, 3);
      assert.equal(msgs[0]!.type, 'request');
      assert.equal(msgs[1]!.type, 'event');
      assert.equal(msgs[2]!.type, 'response');
    });
  });
});

// Helper because FrameDecoder.hasPending is a getter.
function decoderPending(d: FrameDecoder): boolean {
  return d.hasPending;
}
