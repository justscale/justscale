/**
 * Tests for StreamImpl signal emission capability.
 *
 * Verifies that streams can emit signals to wake up suspended processes
 * when publish() is called.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  StreamImpl,
  SET_STREAM_CHANNEL,
  SET_STREAM_SIGNAL_EMITTER,
} from '../../src/models/stream.js';

describe('StreamImpl signal emission', () => {
  describe('[SET_STREAM_SIGNAL_EMITTER]', () => {
    it('configures signal emitter on stream', () => {
      const stream = new StreamImpl<{ status: string }>(false);

      // Setup mock channel first (required for publish to work)
      const mockSubscription = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return { done: true, value: undefined };
            }
          };
        },
        unsubscribe() {}
      };
      stream[SET_STREAM_CHANNEL](mockSubscription as any, () => {});

      // Setup signal emitter
      const channelKey = 'orders:abc123:statusUpdates';
      let emittedKey: string | null = null;
      let emittedMessage: unknown = null;

      stream[SET_STREAM_SIGNAL_EMITTER](channelKey, (key, message) => {
        emittedKey = key;
        emittedMessage = message;
      });

      // Publish should trigger signal emitter
      const testMessage = { status: 'shipped' };
      stream.publish(testMessage);

      assert.strictEqual(emittedKey, channelKey);
      assert.deepStrictEqual(emittedMessage, testMessage);
    });

    it('stores channel key for signal emission', () => {
      const stream = new StreamImpl<number>(false);

      // Setup mock channel
      stream[SET_STREAM_CHANNEL](
        { [Symbol.asyncIterator]() { return { async next() { return { done: true, value: undefined }; } }; }, unsubscribe() {} } as any,
        () => {}
      );

      // Setup emitter with specific channel key
      const channelKey = 'users:user-123:notifications';
      let capturedKey: string | null = null;

      stream[SET_STREAM_SIGNAL_EMITTER](channelKey, (key) => {
        capturedKey = key;
      });

      stream.publish(42);
      assert.strictEqual(capturedKey, channelKey);
    });
  });

  describe('publish() with signal emitter', () => {
    let mockPublishCalled: boolean;
    let mockPublishMessage: unknown;
    let signalEmitterCalled: boolean;
    let signalEmitterKey: string | null;
    let signalEmitterMessage: unknown;

    beforeEach(() => {
      mockPublishCalled = false;
      mockPublishMessage = null;
      signalEmitterCalled = false;
      signalEmitterKey = null;
      signalEmitterMessage = null;
    });

    function setupStream(): StreamImpl<{ event: string }> {
      const stream = new StreamImpl<{ event: string }>(false);

      // Setup mock channel
      const mockSubscription = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return { done: true, value: undefined };
            }
          };
        },
        unsubscribe() {}
      };

      stream[SET_STREAM_CHANNEL](mockSubscription as any, (msg) => {
        mockPublishCalled = true;
        mockPublishMessage = msg;
      });

      stream[SET_STREAM_SIGNAL_EMITTER]('test:entity:field', (key, msg) => {
        signalEmitterCalled = true;
        signalEmitterKey = key;
        signalEmitterMessage = msg;
      });

      return stream;
    }

    it('calls both local publishFn and signal emitter', () => {
      const stream = setupStream();
      const message = { event: 'created' };

      stream.publish(message);

      assert.ok(mockPublishCalled, 'Local publish should be called');
      assert.deepStrictEqual(mockPublishMessage, message);
      assert.ok(signalEmitterCalled, 'Signal emitter should be called');
      assert.strictEqual(signalEmitterKey, 'test:entity:field');
      assert.deepStrictEqual(signalEmitterMessage, message);
    });

    it('calls local publish even if no signal emitter configured', () => {
      const stream = new StreamImpl<string>(false);

      // Only setup channel, no signal emitter
      stream[SET_STREAM_CHANNEL](
        { [Symbol.asyncIterator]() { return { async next() { return { done: true, value: undefined }; } }; }, unsubscribe() {} } as any,
        (msg) => {
          mockPublishCalled = true;
          mockPublishMessage = msg;
        }
      );

      stream.publish('test');

      assert.ok(mockPublishCalled);
      assert.strictEqual(mockPublishMessage, 'test');
    });

    it('catches and logs signal emitter errors', () => {
      const stream = new StreamImpl<string>(false);

      stream[SET_STREAM_CHANNEL](
        { [Symbol.asyncIterator]() { return { async next() { return { done: true, value: undefined }; } }; }, unsubscribe() {} } as any,
        (msg) => {
          mockPublishCalled = true;
        }
      );

      // Setup emitter that throws
      stream[SET_STREAM_SIGNAL_EMITTER]('test:key', () => {
        throw new Error('Signal emission failed');
      });

      // Should not throw - error is caught and logged
      assert.doesNotThrow(() => {
        stream.publish('test');
      });

      // Local publish should still have been called
      assert.ok(mockPublishCalled);
    });
  });

  describe('disconnect() clears signal emitter', () => {
    it('clears signalEmitter and channelKey on disconnect', () => {
      const stream = new StreamImpl<string>(false);

      stream[SET_STREAM_CHANNEL](
        { [Symbol.asyncIterator]() { return { async next() { return { done: true, value: undefined }; } }; }, unsubscribe() {} } as any,
        () => {}
      );

      let emitterCalled = false;
      stream[SET_STREAM_SIGNAL_EMITTER]('key', () => {
        emitterCalled = true;
      });

      // Disconnect
      stream.disconnect();

      // Trying to publish should throw (not connected)
      assert.throws(() => {
        stream.publish('test');
      }, /Stream not connected/);

      // Emitter should not have been called
      assert.ok(!emitterCalled);
    });

    it('is safe to call disconnect multiple times', () => {
      const stream = new StreamImpl<string>(false);

      stream[SET_STREAM_CHANNEL](
        { [Symbol.asyncIterator]() { return { async next() { return { done: true, value: undefined }; } }; }, unsubscribe() {} } as any,
        () => {}
      );

      stream[SET_STREAM_SIGNAL_EMITTER]('key', () => {});

      // Multiple disconnects should not throw
      assert.doesNotThrow(() => {
        stream.disconnect();
        stream.disconnect();
        stream.disconnect();
      });
    });
  });

  describe('backward compatibility', () => {
    it('works without signalEmitter (existing behavior)', () => {
      const stream = new StreamImpl<number>(false);

      let publishedValue: number | null = null;
      stream[SET_STREAM_CHANNEL](
        { [Symbol.asyncIterator]() { return { async next() { return { done: true, value: undefined }; } }; }, unsubscribe() {} } as any,
        (msg) => {
          publishedValue = msg;
        }
      );

      // No SET_STREAM_SIGNAL_EMITTER call

      stream.publish(123);

      assert.strictEqual(publishedValue, 123);
    });
  });
});
