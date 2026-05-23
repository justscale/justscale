/**
 * Tests for stream fields
 */

import { describe, test, mock } from 'node:test';
import assert from 'node:assert';

import {
  defineModel,
  field,
  getModelFields,
  STREAM,
  StreamImpl,
  SET_STREAM_CHANNEL,
  isStream,
  type Stream,
} from '../../src/models/index.js';

// =============================================================================
// field.stream() Builder Tests
// =============================================================================

describe('field.stream()', () => {
  test('should create a stream field definition', () => {
    class ChatMessage extends defineModel({
      text: field.string(),
    }) {}

    class Room extends defineModel({
      name: field.string(),
      messages: field.stream(ChatMessage),
    }) {}

    const fields = getModelFields(Room);

    assert.strictEqual(fields.messages.type, 'stream');
    assert.strictEqual(typeof fields.messages.streamTarget, 'function');
    assert.strictEqual(fields.messages.streamProtected, false);
  });

  test('should support protected() modifier', () => {
    class StatusEvent extends defineModel({
      status: field.string(),
    }) {}

    class Order extends defineModel({
      orderId: field.string(),
      statusChanges: field.stream(StatusEvent).protected(),
    }) {}

    const fields = getModelFields(Order);

    assert.strictEqual(fields.statusChanges.type, 'stream');
    assert.strictEqual(fields.statusChanges.streamProtected, true);
  });

  test('should support lazy target for self-reference', () => {
    // Using a function to avoid hoisting issues
    // Define Event model first
    class Event extends defineModel({
      name: field.string(),
    }) {}

    // Then use it with lazy reference
    class Node extends defineModel({
      name: field.string(),
      updates: field.stream(() => Event),
    }) {}

    const fields = getModelFields(Node);

    assert.strictEqual(fields.updates.type, 'stream');
    assert.strictEqual(typeof fields.updates.streamTarget, 'function');
    // The lazy target should resolve to the Event model
    assert.strictEqual(fields.updates.streamTarget!(), Event);
  });
});

// =============================================================================
// StreamImpl Tests
// =============================================================================

describe('StreamImpl', () => {
  test('should create stream with protected mode false', () => {
    const stream = new StreamImpl<{ text: string }>(false);

    assert.ok(STREAM in stream);
    assert.strictEqual(stream[STREAM], true);
    assert.strictEqual(stream.isConnected, false);
  });

  test('should create stream with protected mode true', () => {
    const stream = new StreamImpl<{ text: string }>(true);

    assert.ok(STREAM in stream);
    assert.strictEqual(stream.isConnected, false);
  });

  test('should throw when publishing without channel connection', () => {
    const stream = new StreamImpl<{ text: string }>(false);

    assert.throws(
      () => stream.publish({ text: 'hello' }),
      /Stream not connected/
    );
  });

  test('should throw when iterating without channel connection', async () => {
    const stream = new StreamImpl<{ text: string }>(false);

    const iterator = stream[Symbol.asyncIterator]();

    await assert.rejects(
      async () => await iterator.next(),
      /Stream not connected/
    );
  });

  test('should be connected after setting channel', () => {
    const stream = new StreamImpl<{ text: string }>(false);

    // Create mock channel subscription
    const mockSubscription = {
      [Symbol.asyncIterator]: async function* () {
        yield { text: 'test' };
      },
      channelKey: 'test:123:messages',
      active: true,
      ready: Promise.resolve(),
      unsubscribe: () => {},
      [Symbol.dispose]: () => {},
    };

    const publishFn = mock.fn();

    stream[SET_STREAM_CHANNEL](mockSubscription, publishFn);

    assert.strictEqual(stream.isConnected, true);
  });

  test('should publish messages through channel', () => {
    const stream = new StreamImpl<{ text: string }>(false);

    const mockSubscription = {
      [Symbol.asyncIterator]: async function* () {},
      channelKey: 'test:123:messages',
      active: true,
      ready: Promise.resolve(),
      unsubscribe: () => {},
      [Symbol.dispose]: () => {},
    };

    const publishFn = mock.fn();
    stream[SET_STREAM_CHANNEL](mockSubscription, publishFn);

    stream.publish({ text: 'hello world' });

    assert.strictEqual(publishFn.mock.callCount(), 1);
    assert.deepStrictEqual(publishFn.mock.calls[0].arguments[0], { text: 'hello world' });
  });

  test('should iterate messages from channel', async () => {
    const stream = new StreamImpl<{ text: string }>(false);

    const messages = [
      { text: 'message 1' },
      { text: 'message 2' },
      { text: 'message 3' },
    ];

    const mockSubscription = {
      async *[Symbol.asyncIterator]() {
        for (const msg of messages) {
          yield msg;
        }
      },
      channelKey: 'test:123:messages',
      active: true,
      ready: Promise.resolve(),
      unsubscribe: () => {},
      [Symbol.dispose]: () => {},
    };

    stream[SET_STREAM_CHANNEL](mockSubscription, () => {});

    const received: { text: string }[] = [];
    for await (const msg of stream) {
      received.push(msg);
    }

    assert.deepStrictEqual(received, messages);
  });

  test('should enforce protected mode when lock checker returns false', () => {
    const stream = new StreamImpl<{ text: string }>(true);

    const mockSubscription = {
      [Symbol.asyncIterator]: async function* () {},
      channelKey: 'test:123:messages',
      active: true,
      ready: Promise.resolve(),
      unsubscribe: () => {},
      [Symbol.dispose]: () => {},
    };

    const publishFn = mock.fn();
    const lockChecker = () => false; // Not locked

    stream[SET_STREAM_CHANNEL](mockSubscription, publishFn, lockChecker);

    assert.throws(
      () => stream.publish({ text: 'hello' }),
      /Protected stream requires Lock<T> to publish/
    );
  });

  test('should allow publish on protected stream when locked', () => {
    const stream = new StreamImpl<{ text: string }>(true);

    const mockSubscription = {
      [Symbol.asyncIterator]: async function* () {},
      channelKey: 'test:123:messages',
      active: true,
      ready: Promise.resolve(),
      unsubscribe: () => {},
      [Symbol.dispose]: () => {},
    };

    const publishFn = mock.fn();
    const lockChecker = () => true; // Locked

    stream[SET_STREAM_CHANNEL](mockSubscription, publishFn, lockChecker);

    // Should not throw
    stream.publish({ text: 'hello' });

    assert.strictEqual(publishFn.mock.callCount(), 1);
  });

  test('should allow publish on non-protected stream without lock', () => {
    const stream = new StreamImpl<{ text: string }>(false);

    const mockSubscription = {
      [Symbol.asyncIterator]: async function* () {},
      channelKey: 'test:123:messages',
      active: true,
      ready: Promise.resolve(),
      unsubscribe: () => {},
      [Symbol.dispose]: () => {},
    };

    const publishFn = mock.fn();
    // No lock checker for non-protected stream

    stream[SET_STREAM_CHANNEL](mockSubscription, publishFn);

    // Should not throw
    stream.publish({ text: 'hello' });

    assert.strictEqual(publishFn.mock.callCount(), 1);
  });
});

// =============================================================================
// isStream Type Guard Tests
// =============================================================================

describe('isStream()', () => {
  test('should return true for StreamImpl', () => {
    const stream = new StreamImpl<unknown>(false);
    assert.strictEqual(isStream(stream), true);
  });

  test('should return false for null', () => {
    assert.strictEqual(isStream(null), false);
  });

  test('should return false for undefined', () => {
    assert.strictEqual(isStream(undefined), false);
  });

  test('should return false for plain object', () => {
    assert.strictEqual(isStream({ foo: 'bar' }), false);
  });

  test('should return false for array', () => {
    assert.strictEqual(isStream([1, 2, 3]), false);
  });

  test('should return false for number', () => {
    assert.strictEqual(isStream(42), false);
  });

  test('should return false for string', () => {
    assert.strictEqual(isStream('stream'), false);
  });
});

// =============================================================================
// Type Inference Tests (compile-time checks)
// =============================================================================

describe('Stream type inference', () => {
  test('should infer correct types for stream field', () => {
    class ChatMessage extends defineModel({
      text: field.string(),
      sender: field.string(),
    }) {}

    class Room extends defineModel({
      name: field.string(),
      messages: field.stream(ChatMessage),
    }) {}

    // Verify the field definition has correct stream type
    const fields = getModelFields(Room);
    assert.strictEqual(fields.messages.type, 'stream');

    // Create a connected stream for type checking
    const stream = new StreamImpl<{ text: string; sender: string }>(false);

    // Set up mock channel
    const mockChannel = {
      async *[Symbol.asyncIterator]() {},
      channelKey: 'test',
      active: true,
      ready: Promise.resolve(),
      unsubscribe: () => {},
      [Symbol.dispose]: () => {},
    };
    stream[SET_STREAM_CHANNEL](mockChannel, () => {});

    // Type check: should accept correct shape
    stream.publish({ text: 'hello', sender: 'user1' });

    assert.ok(true, 'Types compile correctly');
  });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe('Stream Edge Cases', () => {
  test('should handle publishing null', () => {
    const stream = new StreamImpl<null>(false);

    const published: unknown[] = [];
    const mockChannel = {
      async *[Symbol.asyncIterator]() {},
      channelKey: 'test',
      active: true,
      ready: Promise.resolve(),
      unsubscribe: () => {},
      [Symbol.dispose]: () => {},
    };
    stream[SET_STREAM_CHANNEL](mockChannel, (msg) => published.push(msg));

    stream.publish(null);

    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0], null);
  });

  test('should handle publishing undefined', () => {
    const stream = new StreamImpl<undefined>(false);

    const published: unknown[] = [];
    const mockChannel = {
      async *[Symbol.asyncIterator]() {},
      channelKey: 'test',
      active: true,
      ready: Promise.resolve(),
      unsubscribe: () => {},
      [Symbol.dispose]: () => {},
    };
    stream[SET_STREAM_CHANNEL](mockChannel, (msg) => published.push(msg));

    stream.publish(undefined);

    assert.strictEqual(published.length, 1);
    assert.strictEqual(published[0], undefined);
  });

  test('should handle publishing empty object', () => {
    const stream = new StreamImpl<Record<string, never>>(false);

    const published: unknown[] = [];
    const mockChannel = {
      async *[Symbol.asyncIterator]() {},
      channelKey: 'test',
      active: true,
      ready: Promise.resolve(),
      unsubscribe: () => {},
      [Symbol.dispose]: () => {},
    };
    stream[SET_STREAM_CHANNEL](mockChannel, (msg) => published.push(msg));

    stream.publish({});

    assert.strictEqual(published.length, 1);
    assert.deepStrictEqual(published[0], {});
  });

  test('should support early termination with break', async () => {
    const stream = new StreamImpl<{ index: number }>(false);

    const messages = [
      { index: 0 },
      { index: 1 },
      { index: 2 },
      { index: 3 },
      { index: 4 },
    ];

    let messageIndex = 0;
    const mockChannel = {
      async *[Symbol.asyncIterator]() {
        while (messageIndex < messages.length) {
          yield messages[messageIndex++];
        }
      },
      channelKey: 'test',
      active: true,
      ready: Promise.resolve(),
      unsubscribe: () => {},
      [Symbol.dispose]: () => {},
    };
    stream[SET_STREAM_CHANNEL](mockChannel, () => {});

    const received: { index: number }[] = [];
    for await (const msg of stream) {
      received.push(msg);
      if (msg.index >= 2) break; // Early termination
    }

    assert.strictEqual(received.length, 3);
    assert.strictEqual(received[2].index, 2);
  });

  test('should handle concurrent publish calls', () => {
    const stream = new StreamImpl<{ id: number }>(false);

    const published: unknown[] = [];
    const mockChannel = {
      async *[Symbol.asyncIterator]() {},
      channelKey: 'test',
      active: true,
      ready: Promise.resolve(),
      unsubscribe: () => {},
      [Symbol.dispose]: () => {},
    };
    stream[SET_STREAM_CHANNEL](mockChannel, (msg) => published.push(msg));

    // Publish 100 messages synchronously
    for (let i = 0; i < 100; i++) {
      stream.publish({ id: i });
    }

    assert.strictEqual(published.length, 100);
    for (let i = 0; i < 100; i++) {
      assert.strictEqual((published[i] as { id: number }).id, i);
    }
  });

  test('should not be JSON serializable (streams are ephemeral)', () => {
    const stream = new StreamImpl<{ text: string }>(false);

    const mockChannel = {
      async *[Symbol.asyncIterator]() {},
      channelKey: 'test',
      active: true,
      ready: Promise.resolve(),
      unsubscribe: () => {},
      [Symbol.dispose]: () => {},
    };
    stream[SET_STREAM_CHANNEL](mockChannel, () => {});

    // When serializing, stream should become {} or be excluded
    const json = JSON.stringify({ name: 'test', stream });
    const parsed = JSON.parse(json);

    // Stream symbol properties won't serialize
    assert.strictEqual(parsed.name, 'test');
    // The stream object serializes but loses its functionality
    assert.ok('stream' in parsed);
  });

  test('protected stream should check lock on each publish', () => {
    const stream = new StreamImpl<{ status: string }>(true);

    let isLocked = false;
    const lockChecker = () => isLocked;

    const published: unknown[] = [];
    const mockChannel = {
      async *[Symbol.asyncIterator]() {},
      channelKey: 'test',
      active: true,
      ready: Promise.resolve(),
      unsubscribe: () => {},
      [Symbol.dispose]: () => {},
    };
    stream[SET_STREAM_CHANNEL](mockChannel, (msg) => published.push(msg), lockChecker);

    // First publish fails - not locked
    assert.throws(() => stream.publish({ status: 'a' }), /Protected stream/);

    // Acquire lock
    isLocked = true;
    stream.publish({ status: 'b' }); // Works

    // Release lock
    isLocked = false;
    assert.throws(() => stream.publish({ status: 'c' }), /Protected stream/);

    // Re-acquire
    isLocked = true;
    stream.publish({ status: 'd' }); // Works again

    assert.strictEqual(published.length, 2);
    assert.deepStrictEqual(published[0], { status: 'b' });
    assert.deepStrictEqual(published[1], { status: 'd' });
  });

  test('should handle large messages', () => {
    const stream = new StreamImpl<{ data: string }>(false);

    const published: unknown[] = [];
    const mockChannel = {
      async *[Symbol.asyncIterator]() {},
      channelKey: 'test',
      active: true,
      ready: Promise.resolve(),
      unsubscribe: () => {},
      [Symbol.dispose]: () => {},
    };
    stream[SET_STREAM_CHANNEL](mockChannel, (msg) => published.push(msg));

    // 1MB message
    const largeData = 'x'.repeat(1024 * 1024);
    stream.publish({ data: largeData });

    assert.strictEqual(published.length, 1);
    assert.strictEqual((published[0] as { data: string }).data.length, 1024 * 1024);
  });
});

// =============================================================================
// Disposable and Cleanup Tests
// =============================================================================

describe('Stream Disposable', () => {
  test('disconnect() should unsubscribe from channel', () => {
    const stream = new StreamImpl<{ text: string }>(false);

    let unsubscribeCalled = false;
    const mockChannel = {
      async *[Symbol.asyncIterator]() {},
      channelKey: 'test',
      active: true,
      ready: Promise.resolve(),
      unsubscribe: () => {
        unsubscribeCalled = true;
      },
      [Symbol.dispose]: () => {},
    };
    stream[SET_STREAM_CHANNEL](mockChannel, () => {});

    assert.strictEqual(stream.isConnected, true);

    stream.disconnect();

    assert.strictEqual(unsubscribeCalled, true);
    assert.strictEqual(stream.isConnected, false);
  });

  test('disconnect() should be safe to call multiple times', () => {
    const stream = new StreamImpl<{ text: string }>(false);

    let unsubscribeCount = 0;
    const mockChannel = {
      async *[Symbol.asyncIterator]() {},
      channelKey: 'test',
      active: true,
      ready: Promise.resolve(),
      unsubscribe: () => {
        unsubscribeCount++;
      },
      [Symbol.dispose]: () => {},
    };
    stream[SET_STREAM_CHANNEL](mockChannel, () => {});

    stream.disconnect();
    stream.disconnect();
    stream.disconnect();

    // Should only call unsubscribe once
    assert.strictEqual(unsubscribeCount, 1);
    assert.strictEqual(stream.isConnected, false);
  });

  test('disconnect() on unconnected stream should be safe', () => {
    const stream = new StreamImpl<{ text: string }>(false);

    // Should not throw
    stream.disconnect();

    assert.strictEqual(stream.isConnected, false);
  });

  test('[Symbol.dispose] should call disconnect()', () => {
    const stream = new StreamImpl<{ text: string }>(false);

    let unsubscribeCalled = false;
    const mockChannel = {
      async *[Symbol.asyncIterator]() {},
      channelKey: 'test',
      active: true,
      ready: Promise.resolve(),
      unsubscribe: () => {
        unsubscribeCalled = true;
      },
      [Symbol.dispose]: () => {},
    };
    stream[SET_STREAM_CHANNEL](mockChannel, () => {});

    // Call Symbol.dispose directly
    stream[Symbol.dispose]();

    assert.strictEqual(unsubscribeCalled, true);
    assert.strictEqual(stream.isConnected, false);
  });

  test('should work with using syntax', () => {
    let unsubscribeCalled = false;

    // Simulate using syntax behavior
    {
      const stream = new StreamImpl<{ text: string }>(false);
      const mockChannel = {
        async *[Symbol.asyncIterator]() {},
        channelKey: 'test',
        active: true,
        ready: Promise.resolve(),
        unsubscribe: () => {
          unsubscribeCalled = true;
        },
        [Symbol.dispose]: () => {},
      };
      stream[SET_STREAM_CHANNEL](mockChannel, () => {});

      // Manually call dispose at end of block (simulating using)
      stream[Symbol.dispose]();
    }

    assert.strictEqual(unsubscribeCalled, true);
  });

  test('publish should fail after disconnect', () => {
    const stream = new StreamImpl<{ text: string }>(false);

    const mockChannel = {
      async *[Symbol.asyncIterator]() {},
      channelKey: 'test',
      active: true,
      ready: Promise.resolve(),
      unsubscribe: () => {},
      [Symbol.dispose]: () => {},
    };
    stream[SET_STREAM_CHANNEL](mockChannel, () => {});

    stream.disconnect();

    assert.throws(
      () => stream.publish({ text: 'hello' }),
      /Stream not connected/
    );
  });

  test('iteration should fail after disconnect', async () => {
    const stream = new StreamImpl<{ text: string }>(false);

    const mockChannel = {
      async *[Symbol.asyncIterator]() {
        yield { text: 'test' };
      },
      channelKey: 'test',
      active: true,
      ready: Promise.resolve(),
      unsubscribe: () => {},
      [Symbol.dispose]: () => {},
    };
    stream[SET_STREAM_CHANNEL](mockChannel, () => {});

    stream.disconnect();

    const iterator = stream[Symbol.asyncIterator]();
    await assert.rejects(
      async () => await iterator.next(),
      /Stream not connected/
    );
  });

  test('disconnect should clear lock checker', () => {
    const stream = new StreamImpl<{ text: string }>(true);

    const mockChannel = {
      async *[Symbol.asyncIterator]() {},
      channelKey: 'test',
      active: true,
      ready: Promise.resolve(),
      unsubscribe: () => {},
      [Symbol.dispose]: () => {},
    };
    const lockChecker = () => true;
    stream[SET_STREAM_CHANNEL](mockChannel, () => {}, lockChecker);

    stream.disconnect();

    // After disconnect, publish should fail with "not connected" not "protected"
    assert.throws(
      () => stream.publish({ text: 'hello' }),
      /Stream not connected/
    );
  });
});
