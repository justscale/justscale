import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createChannels } from '../../../src/features/channel/channels.js';
import { MemoryChannelBackend } from '../../../src/features/channel/backend.js';
import { registerProcessType } from '../../../src/process/serialization.js';

// Trigger builtins
import '../../../src/process/builtin-serializers.js';

// Simulated proto schema
const OrderEventSchema = {
  [Symbol.process]: {
    name: 'test.channel.OrderEvent',
    serialize: (v: { type: string; orderId: string }) => ({
      t: v.type,
      o: v.orderId,
    }),
    deserialize: (d: Uint8Array | object) => {
      const data = d as { t: string; o: string };
      return { type: data.t, orderId: data.o };
    },
  } satisfies ProcessDescriptor<{ type: string; orderId: string }>,
};
registerProcessType(OrderEventSchema[Symbol.process]);

// Class-based Processable type
class ChatMessage {
  constructor(public text: string, public sender: string) {}
  static [Symbol.process]: ProcessDescriptor<ChatMessage> = {
    name: 'test.channel.ChatMessage',
    serialize: (v: ChatMessage) => ({ t: v.text, s: v.sender }),
    deserialize: (d: Uint8Array | object) => {
      const data = d as { t: string; s: string };
      return new ChatMessage(data.t, data.s);
    },
  };
}
registerProcessType(ChatMessage[Symbol.process]);

// Fake backend that captures what's published
function createCapturingBackend() {
  const published: { key: string; message: unknown }[] = [];
  const subscribers = new Map<string, (message: unknown) => void>();

  const backend = {
    subscribe(channelKey: string, onMessage: (message: unknown) => void): Disposable {
      subscribers.set(channelKey, onMessage);
      return { [Symbol.dispose]: () => subscribers.delete(channelKey) };
    },
    publish(channelKey: string, message: unknown): void {
      published.push({ key: channelKey, message });
    },
    async close() {},
  };

  return {
    backend,
    published,
    subscribers,
    simulateRemoteMessage(key: string, message: unknown) {
      const cb = subscribers.get(key);
      if (cb) cb(message);
    },
  };
}

describe('Processable channels', () => {
  describe('with explicit descriptor', () => {
    it('encodes messages for the backend', async () => {
      const { backend, published } = createCapturingBackend();
      type OrderEvent = { type: string; orderId: string };

      const factory = createChannels<OrderEvent>({
        descriptor: OrderEventSchema[Symbol.process],
      });
      const channels = (factory as any).factory({ backend });

      // Subscribe to trigger backend subscription
      const sub = channels.subscribe('orders');
      channels.publish('orders', { type: 'created', orderId: 'ord-1' });

      // Backend should receive encoded form
      assert.equal(published.length, 1);
      const sent = published[0].message as any;
      assert.equal(sent.__$p, 'test.channel.OrderEvent');
      assert.deepEqual(sent.d, { t: 'created', o: 'ord-1' });

      sub.unsubscribe();
    });

    it('decodes messages from the backend', async () => {
      const { backend, simulateRemoteMessage } = createCapturingBackend();
      type OrderEvent = { type: string; orderId: string };

      const factory = createChannels<OrderEvent>({
        descriptor: OrderEventSchema[Symbol.process],
      });
      const channels = (factory as any).factory({ backend });

      const received: OrderEvent[] = [];
      const sub = channels.subscribe('orders');

      // Start consuming in background
      const consumer = (async () => {
        for await (const msg of sub) {
          received.push(msg);
          if (received.length >= 1) break;
        }
      })();

      // Simulate encoded message from remote node
      await new Promise(r => setTimeout(r, 10));
      simulateRemoteMessage('orders', {
        __$p: 'test.channel.OrderEvent',
        d: { t: 'shipped', o: 'ord-2' },
      });

      await consumer;
      assert.equal(received.length, 1);
      assert.deepEqual(received[0], { type: 'shipped', orderId: 'ord-2' });

      sub.unsubscribe();
    });
  });

  describe('with auto-detection (class instances)', () => {
    it('auto-detects Processable on class instances at publish time', () => {
      const { backend, published } = createCapturingBackend();

      const factory = createChannels<ChatMessage>();
      const channels = (factory as any).factory({ backend });

      const sub = channels.subscribe('chat');
      channels.publish('chat', new ChatMessage('hello', 'alice'));

      assert.equal(published.length, 1);
      const sent = published[0].message as any;
      assert.equal(sent.__$p, 'test.channel.ChatMessage');
      assert.deepEqual(sent.d, { t: 'hello', s: 'alice' });

      sub.unsubscribe();
    });

    it('decodes auto-detected messages from backend via registry', async () => {
      const { backend, simulateRemoteMessage } = createCapturingBackend();

      const factory = createChannels<ChatMessage>();
      const channels = (factory as any).factory({ backend });

      const received: ChatMessage[] = [];
      const sub = channels.subscribe('chat');

      const consumer = (async () => {
        for await (const msg of sub) {
          received.push(msg);
          if (received.length >= 1) break;
        }
      })();

      await new Promise(r => setTimeout(r, 10));
      simulateRemoteMessage('chat', {
        __$p: 'test.channel.ChatMessage',
        d: { t: 'world', s: 'bob' },
      });

      await consumer;
      assert.equal(received.length, 1);
      assert.ok(received[0] instanceof ChatMessage);
      assert.equal(received[0].text, 'world');
      assert.equal(received[0].sender, 'bob');

      sub.unsubscribe();
    });
  });

  describe('without Processable (plain messages)', () => {
    it('passes plain messages through unchanged', () => {
      const { backend, published } = createCapturingBackend();

      const factory = createChannels<{ text: string }>();
      const channels = (factory as any).factory({ backend });

      const sub = channels.subscribe('plain');
      channels.publish('plain', { text: 'hello' });

      assert.equal(published.length, 1);
      assert.deepEqual(published[0].message, { text: 'hello' });
      // No __$p tag
      assert.equal((published[0].message as any).__$p, undefined);

      sub.unsubscribe();
    });
  });

  describe('deliverRemote', () => {
    it('decodes Processable-encoded messages', () => {
      const { backend } = createCapturingBackend();

      const factory = createChannels<ChatMessage>();
      const channels = (factory as any).factory({ backend });

      const received: ChatMessage[] = [];
      const sub = channels.subscribe('chat');

      // Manually consume one message synchronously
      const iter = sub[Symbol.asyncIterator]();

      channels.deliverRemote('chat', {
        __$p: 'test.channel.ChatMessage',
        d: { t: 'remote', s: 'eve' },
      } as any);

      // The message should be in the queue now
      iter.next().then((result: any) => {
        if (!result.done) {
          received.push(result.value);
        }
      });

      // Give microtask time to process
      return new Promise<void>(resolve => {
        setTimeout(() => {
          assert.equal(received.length, 1);
          assert.ok(received[0] instanceof ChatMessage);
          assert.equal(received[0].text, 'remote');
          sub.unsubscribe();
          resolve();
        }, 20);
      });
    });
  });
});
