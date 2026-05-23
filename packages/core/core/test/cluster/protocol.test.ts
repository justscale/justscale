import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeFrame,
  encodeFrameV2,
  FrameDecoder,
  createRequest,
  createResponse,
  createStream,
  createEvent,
  setProtoCodec,
  WIRE_FORMAT_CBOR,
  WIRE_FORMAT_PROTO,
  type Message,
  type ProtoCodec,
} from '../../src/cluster/protocol.js';

describe('Cluster Protocol', () => {
  describe('CBOR v1 framing (existing)', () => {
    it('encodes and decodes a request', () => {
      const msg = createRequest('cli.invoke', { command: 'test' });
      const frame = encodeFrame(msg);
      const decoder = new FrameDecoder();
      const [decoded] = decoder.push(new Uint8Array(frame));
      assert.equal(decoded.type, 'request');
      assert.equal((decoded as any).method, 'cli.invoke');
      assert.deepEqual((decoded as any).params, { command: 'test' });
    });

    it('encodes and decodes a response', () => {
      const msg = createResponse('test-id', { status: 'ok' });
      const frame = encodeFrame(msg);
      const decoder = new FrameDecoder();
      const [decoded] = decoder.push(new Uint8Array(frame));
      assert.equal(decoded.type, 'response');
      assert.equal((decoded as any).ok, true);
      assert.deepEqual((decoded as any).result, { status: 'ok' });
    });

    it('handles multiple frames in one push', () => {
      const msg1 = createRequest('test.a');
      const msg2 = createRequest('test.b');
      const frame1 = encodeFrame(msg1);
      const frame2 = encodeFrame(msg2);

      const combined = new Uint8Array(frame1.length + frame2.length);
      combined.set(frame1);
      combined.set(frame2, frame1.length);

      const decoder = new FrameDecoder();
      const messages = decoder.push(combined);
      assert.equal(messages.length, 2);
      assert.equal((messages[0] as any).method, 'test.a');
      assert.equal((messages[1] as any).method, 'test.b');
    });

    it('handles partial frames', () => {
      const msg = createRequest('test.partial', { data: 'hello' });
      const frame = encodeFrame(msg);

      const decoder = new FrameDecoder();
      // Send first half
      const half = Math.floor(frame.length / 2);
      let messages = decoder.push(new Uint8Array(frame.slice(0, half)));
      assert.equal(messages.length, 0);
      assert.ok(decoder.hasPending);

      // Send second half
      messages = decoder.push(new Uint8Array(frame.slice(half)));
      assert.equal(messages.length, 1);
      assert.equal((messages[0] as any).method, 'test.partial');
    });

    it('encodeFrameV2 with CBOR produces same output as encodeFrame', () => {
      const msg = createRequest('test.compat');
      const v1 = encodeFrame(msg);
      const v2 = encodeFrameV2(msg, WIRE_FORMAT_CBOR);
      assert.deepEqual(v1, v2);
    });
  });

  describe('Proto v2 framing', () => {
    // Simple JSON-based proto codec for testing (simulates proto encode/decode)
    const testProtoCodec: ProtoCodec = {
      encode(message: Message): Uint8Array {
        return new TextEncoder().encode(JSON.stringify(message));
      },
      decode(data: Uint8Array): Message {
        return JSON.parse(new TextDecoder().decode(data));
      },
    };

    beforeEach(() => {
      setProtoCodec(testProtoCodec);
    });

    it('encodes with 0x01 version byte prefix', () => {
      const msg = createRequest('test.proto');
      const frame = encodeFrameV2(msg, WIRE_FORMAT_PROTO);
      assert.equal(frame[0], WIRE_FORMAT_PROTO);
    });

    it('round-trips through proto framing', () => {
      const msg = createRequest('test.proto', { key: 'value' });
      const frame = encodeFrameV2(msg, WIRE_FORMAT_PROTO);

      const decoder = new FrameDecoder();
      const [decoded] = decoder.push(frame);
      assert.equal(decoded.type, 'request');
      assert.equal((decoded as any).method, 'test.proto');
      assert.deepEqual((decoded as any).params, { key: 'value' });
    });

    it('auto-detects CBOR vs proto in mixed stream', () => {
      const cborMsg = createRequest('test.cbor');
      const protoMsg = createEvent('test.proto.event', { x: 1 });

      const cborFrame = encodeFrame(cborMsg);
      const protoFrame = encodeFrameV2(protoMsg, WIRE_FORMAT_PROTO);

      // Combine CBOR + proto frames
      const combined = new Uint8Array(cborFrame.length + protoFrame.length);
      combined.set(cborFrame);
      combined.set(protoFrame, cborFrame.length);

      const decoder = new FrameDecoder();
      const messages = decoder.push(combined);
      assert.equal(messages.length, 2);
      assert.equal(messages[0].type, 'request');
      assert.equal((messages[0] as any).method, 'test.cbor');
      assert.equal(messages[1].type, 'event');
      assert.equal((messages[1] as any).event, 'test.proto.event');
    });

    it('handles partial proto frames', () => {
      const msg = createStream('s1', 'stdout', 'hello world', false);
      const frame = encodeFrameV2(msg, WIRE_FORMAT_PROTO);

      const decoder = new FrameDecoder();
      const half = Math.floor(frame.length / 2);
      let messages = decoder.push(frame.slice(0, half));
      assert.equal(messages.length, 0);

      messages = decoder.push(frame.slice(half));
      assert.equal(messages.length, 1);
      assert.equal((messages[0] as any).channel, 'stdout');
    });

    it('throws if proto codec not registered', () => {
      setProtoCodec(null as any)
      // Manually reset to null
      ;(globalThis as any).__protoCodecCleared = true;

      const msg = createRequest('test.fail');
      assert.throws(
        () => encodeFrameV2(msg, WIRE_FORMAT_PROTO),
        /Proto codec not registered/,
      );

      // Restore for other tests
      setProtoCodec(testProtoCodec);
    });
  });

  describe('stream sequence numbers', () => {
    it('increments sequence within a stream', () => {
      const s1 = createStream('seq-test', 'data', 'a');
      const s2 = createStream('seq-test', 'data', 'b');
      const s3 = createStream('seq-test', 'data', 'c', true);

      assert.ok(s1.seq! < s2.seq!);
      assert.ok(s2.seq! < s3.seq!);
    });
  });
});
