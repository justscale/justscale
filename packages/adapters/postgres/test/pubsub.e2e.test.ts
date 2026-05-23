/**
 * PostgreSQL Pub/Sub E2E Tests
 *
 * Tests for real-time messaging using PostgreSQL LISTEN/NOTIFY.
 */

import { describe, it, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createPostgresPubSub, PostgresPubSub } from '../src/channel/pubsub.js';
import { requirePostgres, CONNECTION_STRING } from './__mocks__/test-setup.js';

describe('PostgreSQL Pub/Sub E2E', async () => {
  if (!await requirePostgres()) return;

  let pubsub: PostgresPubSub;
  const subscriptionsToCleanup: Array<{ unsubscribe: () => Promise<void> }> = [];

  before(async () => {
    pubsub = await createPostgresPubSub({ connectionString: CONNECTION_STRING });
  });

  after(async () => {
    // Cleanup subscriptions
    for (const sub of subscriptionsToCleanup) {
      try {
        await sub.unsubscribe();
      } catch {
        // Ignore cleanup errors
      }
    }
    await pubsub.close();
  });

  afterEach(() => {
    // Clear cleanup list (subscriptions unsubscribed in tests)
    subscriptionsToCleanup.length = 0;
  });

  // ============================================================================
  // Basic Pub/Sub
  // ============================================================================

  describe('Basic Pub/Sub', () => {
    it('should subscribe and receive messages', async () => {
      const channel = `test-channel-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await pubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });
      subscriptionsToCleanup.push(sub);

      await pubsub.publish(channel, { hello: 'world' });

      // Wait for message
      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received.length, 1);
      assert.deepStrictEqual(received[0], { hello: 'world' });

      await sub.unsubscribe();
    });

    it('should receive multiple messages', async () => {
      const channel = `multi-msg-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await pubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      await pubsub.publish(channel, { count: 1 });
      await pubsub.publish(channel, { count: 2 });
      await pubsub.publish(channel, { count: 3 });

      await new Promise(resolve => setTimeout(resolve, 150));

      assert.strictEqual(received.length, 3);
      assert.deepStrictEqual(received[0], { count: 1 });
      assert.deepStrictEqual(received[1], { count: 2 });
      assert.deepStrictEqual(received[2], { count: 3 });

      await sub.unsubscribe();
    });

    it('should not receive after unsubscribe', async () => {
      const channel = `unsub-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await pubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      await pubsub.publish(channel, { before: true });
      await new Promise(resolve => setTimeout(resolve, 50));

      await sub.unsubscribe();

      await pubsub.publish(channel, { after: true });
      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received.length, 1);
      assert.deepStrictEqual(received[0], { before: true });
    });

    it('should support string messages', async () => {
      const channel = `string-msg-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await pubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      await pubsub.publish(channel, 'plain text message');

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0], 'plain text message');

      await sub.unsubscribe();
    });
  });

  // ============================================================================
  // Multiple Subscribers
  // ============================================================================

  describe('Multiple Subscribers', () => {
    it('should deliver to all subscribers on same channel', async () => {
      const channel = `multi-sub-${randomUUID().slice(0, 8)}`;
      const received1: unknown[] = [];
      const received2: unknown[] = [];

      const sub1 = await pubsub.subscribe(channel, (msg) => {
        received1.push(msg);
      });
      const sub2 = await pubsub.subscribe(channel, (msg) => {
        received2.push(msg);
      });

      await pubsub.publish(channel, { value: 42 });

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received1.length, 1);
      assert.strictEqual(received2.length, 1);
      assert.deepStrictEqual(received1[0], { value: 42 });
      assert.deepStrictEqual(received2[0], { value: 42 });

      await sub1.unsubscribe();
      await sub2.unsubscribe();
    });

    it('should continue delivering after one unsubscribes', async () => {
      const channel = `partial-unsub-${randomUUID().slice(0, 8)}`;
      const received1: unknown[] = [];
      const received2: unknown[] = [];

      const sub1 = await pubsub.subscribe(channel, (msg) => {
        received1.push(msg);
      });
      const sub2 = await pubsub.subscribe(channel, (msg) => {
        received2.push(msg);
      });

      await pubsub.publish(channel, { msg: 1 });
      await new Promise(resolve => setTimeout(resolve, 50));

      await sub1.unsubscribe();

      await pubsub.publish(channel, { msg: 2 });
      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received1.length, 1);
      assert.strictEqual(received2.length, 2);

      await sub2.unsubscribe();
    });

    it('should handle different channels independently', async () => {
      const channel1 = `ch1-${randomUUID().slice(0, 8)}`;
      const channel2 = `ch2-${randomUUID().slice(0, 8)}`;
      const received1: unknown[] = [];
      const received2: unknown[] = [];

      const sub1 = await pubsub.subscribe(channel1, (msg) => {
        received1.push(msg);
      });
      const sub2 = await pubsub.subscribe(channel2, (msg) => {
        received2.push(msg);
      });

      await pubsub.publish(channel1, { ch: 1 });
      await pubsub.publish(channel2, { ch: 2 });

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received1.length, 1);
      assert.strictEqual(received2.length, 1);
      assert.deepStrictEqual(received1[0], { ch: 1 });
      assert.deepStrictEqual(received2[0], { ch: 2 });

      await sub1.unsubscribe();
      await sub2.unsubscribe();
    });
  });

  // ============================================================================
  // Channel Prefix
  // ============================================================================

  describe('Channel Prefix', () => {
    it('should apply channel prefix', async () => {
      const connectionString = CONNECTION_STRING;
      const prefixedPubsub = await createPostgresPubSub({
        connectionString,
        channelPrefix: 'myapp',
      });

      const channel = `prefixed-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await prefixedPubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      await prefixedPubsub.publish(channel, { test: true });

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received.length, 1);

      await sub.unsubscribe();
      await prefixedPubsub.close();
    });

    it('should list channels without prefix', async () => {
      const connectionString = CONNECTION_STRING;
      const prefixedPubsub = await createPostgresPubSub({
        connectionString,
        channelPrefix: 'test',
      });

      const channel = `list-${randomUUID().slice(0, 8)}`;

      const sub = await prefixedPubsub.subscribe(channel, () => {});

      const channels = prefixedPubsub.channels;
      assert.ok(channels.includes(channel));
      assert.ok(!channels.some(c => c.includes('test:')));

      await sub.unsubscribe();
      await prefixedPubsub.close();
    });
  });

  // ============================================================================
  // JSON Parsing
  // ============================================================================

  describe('JSON Parsing', () => {
    it('should parse JSON messages by default', async () => {
      const channel = `json-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await pubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      await pubsub.publish(channel, { nested: { value: [1, 2, 3] } });

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received.length, 1);
      assert.deepStrictEqual(received[0], { nested: { value: [1, 2, 3] } });

      await sub.unsubscribe();
    });

    it('should handle non-JSON string messages', async () => {
      const channel = `nonjson-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await pubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      // Send raw string that's not valid JSON
      await pubsub.publish(channel, 'not json {{{');

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0], 'not json {{{');

      await sub.unsubscribe();
    });

    it('should skip JSON parsing when disabled', async () => {
      const connectionString = CONNECTION_STRING;
      const rawPubsub = await createPostgresPubSub({
        connectionString,
        parseJson: false,
      });

      const channel = `raw-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await rawPubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      await rawPubsub.publish(channel, { key: 'value' });

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0], '{"key":"value"}'); // Raw JSON string

      await sub.unsubscribe();
      await rawPubsub.close();
    });
  });

  // ============================================================================
  // Message Size Limit
  // ============================================================================

  describe('Message Size Limit', () => {
    it('should throw for messages larger than 8KB', async () => {
      const channel = `large-msg-${randomUUID().slice(0, 8)}`;

      // Create message larger than 8000 bytes
      const largeMessage = { data: 'x'.repeat(9000) };

      try {
        await pubsub.publish(channel, largeMessage);
        assert.fail('Should have thrown for large message');
      } catch (err) {
        assert.ok((err as Error).message.includes('too large'));
        assert.ok((err as Error).message.includes('8000'));
      }
    });

    it('should accept messages under 8KB', async () => {
      const channel = `small-msg-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await pubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      // Create message close to but under 8000 bytes
      const message = { data: 'x'.repeat(7000) };
      await pubsub.publish(channel, message);

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received.length, 1);

      await sub.unsubscribe();
    });
  });

  // ============================================================================
  // Subscription Handle
  // ============================================================================

  describe('Subscription Handle', () => {
    it('should have channel property', async () => {
      const channel = `handle-${randomUUID().slice(0, 8)}`;

      const sub = await pubsub.subscribe(channel, () => {});

      assert.strictEqual(sub.channel, channel);

      await sub.unsubscribe();
    });

    it('should be safe to unsubscribe multiple times', async () => {
      const channel = `multi-unsub-${randomUUID().slice(0, 8)}`;

      const sub = await pubsub.subscribe(channel, () => {});

      await sub.unsubscribe();
      await sub.unsubscribe(); // Should not throw
      await sub.unsubscribe();
    });
  });

  // ============================================================================
  // Channels List
  // ============================================================================

  describe('Channels List', () => {
    it('should list subscribed channels', async () => {
      const ch1 = `list1-${randomUUID().slice(0, 8)}`;
      const ch2 = `list2-${randomUUID().slice(0, 8)}`;

      const sub1 = await pubsub.subscribe(ch1, () => {});
      const sub2 = await pubsub.subscribe(ch2, () => {});

      const channels = pubsub.channels;
      assert.ok(channels.includes(ch1));
      assert.ok(channels.includes(ch2));

      await sub1.unsubscribe();
      await sub2.unsubscribe();
    });

    it('should remove channel after all unsubscribe', async () => {
      const channel = `remove-${randomUUID().slice(0, 8)}`;

      const sub1 = await pubsub.subscribe(channel, () => {});
      const sub2 = await pubsub.subscribe(channel, () => {});

      assert.ok(pubsub.channels.includes(channel));

      await sub1.unsubscribe();
      assert.ok(pubsub.channels.includes(channel)); // Still subscribed

      await sub2.unsubscribe();
      assert.ok(!pubsub.channels.includes(channel)); // Now removed
    });
  });

  // ============================================================================
  // Async Handlers
  // ============================================================================

  describe('Async Handlers', () => {
    it('should support async message handlers', async () => {
      const channel = `async-${randomUUID().slice(0, 8)}`;
      let processed = false;

      const sub = await pubsub.subscribe(channel, async (msg) => {
        await new Promise(resolve => setTimeout(resolve, 50));
        processed = true;
      });

      await pubsub.publish(channel, { test: true });

      await new Promise(resolve => setTimeout(resolve, 200));

      assert.strictEqual(processed, true);

      await sub.unsubscribe();
    });

    it('should continue on handler error', async () => {
      const channel = `error-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await pubsub.subscribe(channel, (msg) => {
        received.push(msg);
        if (received.length === 1) {
          throw new Error('Handler error');
        }
      });

      await pubsub.publish(channel, { n: 1 });
      await pubsub.publish(channel, { n: 2 });

      await new Promise(resolve => setTimeout(resolve, 150));

      assert.strictEqual(received.length, 2);

      await sub.unsubscribe();
    });
  });

  // ============================================================================
  // Edge Cases - Messages
  // ============================================================================

  describe('Edge Cases - Messages', () => {
    it('should handle null message', async () => {
      const channel = `null-msg-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await pubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      await pubsub.publish(channel, null);

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0], null);

      await sub.unsubscribe();
    });

    it('should handle empty object message', async () => {
      const channel = `empty-obj-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await pubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      await pubsub.publish(channel, {});

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received.length, 1);
      assert.deepStrictEqual(received[0], {});

      await sub.unsubscribe();
    });

    it('should handle empty array message', async () => {
      const channel = `empty-arr-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await pubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      await pubsub.publish(channel, []);

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received.length, 1);
      assert.deepStrictEqual(received[0], []);

      await sub.unsubscribe();
    });

    it('should handle empty string message', async () => {
      const channel = `empty-str-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await pubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      await pubsub.publish(channel, '');

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received.length, 1);
      assert.strictEqual(received[0], '');

      await sub.unsubscribe();
    });

    it('should handle boolean messages', async () => {
      const channel = `bool-msg-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await pubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      await pubsub.publish(channel, true);
      await pubsub.publish(channel, false);

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received.length, 2);
      assert.strictEqual(received[0], true);
      assert.strictEqual(received[1], false);

      await sub.unsubscribe();
    });

    it('should handle numeric messages', async () => {
      const channel = `num-msg-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await pubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      await pubsub.publish(channel, 0);
      await pubsub.publish(channel, -1);
      await pubsub.publish(channel, 3.14159);
      await pubsub.publish(channel, Number.MAX_SAFE_INTEGER);

      await new Promise(resolve => setTimeout(resolve, 150));

      assert.strictEqual(received.length, 4);
      assert.strictEqual(received[0], 0);
      assert.strictEqual(received[1], -1);
      assert.strictEqual(received[2], 3.14159);
      assert.strictEqual(received[3], Number.MAX_SAFE_INTEGER);

      await sub.unsubscribe();
    });

    it('should handle unicode in messages', async () => {
      const channel = `unicode-msg-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await pubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      await pubsub.publish(channel, {
        emoji: '🚀🎉👍',
        chinese: '你好世界',
        arabic: 'مرحبا',
        special: '™®©',
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received.length, 1);
      assert.deepStrictEqual(received[0], {
        emoji: '🚀🎉👍',
        chinese: '你好世界',
        arabic: 'مرحبا',
        special: '™®©',
      });

      await sub.unsubscribe();
    });

    it('should handle special characters in messages', async () => {
      const channel = `special-chars-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await pubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      await pubsub.publish(channel, {
        quotes: 'He said "hello"',
        backslash: 'path\\to\\file',
        newlines: 'line1\nline2\r\nline3',
        tabs: 'col1\tcol2',
        null_char: 'before\x00after',
      });

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received.length, 1);
      const msg = received[0] as Record<string, string>;
      assert.strictEqual(msg.quotes, 'He said "hello"');
      assert.strictEqual(msg.backslash, 'path\\to\\file');
      assert.strictEqual(msg.newlines, 'line1\nline2\r\nline3');
      assert.strictEqual(msg.tabs, 'col1\tcol2');

      await sub.unsubscribe();
    });

    it('should handle deeply nested objects', async () => {
      const channel = `deep-nest-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await pubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      const deepObj = {
        level1: {
          level2: {
            level3: {
              level4: {
                level5: { value: 'deep' },
              },
            },
          },
        },
      };

      await pubsub.publish(channel, deepObj);

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received.length, 1);
      assert.deepStrictEqual(received[0], deepObj);

      await sub.unsubscribe();
    });

    it('should handle message at boundary of 8KB limit', async () => {
      const channel = `boundary-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await pubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      // Create message just under 8000 bytes (accounting for JSON overhead)
      const message = { data: 'x'.repeat(7980) };
      await pubsub.publish(channel, message);

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received.length, 1);

      await sub.unsubscribe();
    });

    it('should handle mixed type array', async () => {
      const channel = `mixed-arr-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await pubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      await pubsub.publish(channel, [1, 'two', { three: 3 }, null, true, [4, 5]]);

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received.length, 1);
      assert.deepStrictEqual(received[0], [1, 'two', { three: 3 }, null, true, [4, 5]]);

      await sub.unsubscribe();
    });
  });

  // ============================================================================
  // Edge Cases - Channel Names
  // ============================================================================

  describe('Edge Cases - Channel Names', () => {
    it('should handle channel with underscores', async () => {
      const channel = `test_channel_name_${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await pubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      await pubsub.publish(channel, { test: true });

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received.length, 1);
      await sub.unsubscribe();
    });

    it('should handle channel with numbers', async () => {
      const channel = `channel123_${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await pubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      await pubsub.publish(channel, { test: true });

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received.length, 1);
      await sub.unsubscribe();
    });

    it('should handle long channel name', async () => {
      // PostgreSQL LISTEN channel names can be up to 63 bytes
      const channel = 'a'.repeat(50) + randomUUID().slice(0, 8);
      const received: unknown[] = [];

      const sub = await pubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      await pubsub.publish(channel, { test: true });

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received.length, 1);
      await sub.unsubscribe();
    });

    it('should handle similar channel prefixes independently', async () => {
      const base = randomUUID().slice(0, 8);
      const channel1 = `prefix_${base}`;
      const channel2 = `prefix_${base}_suffix`;
      const received1: unknown[] = [];
      const received2: unknown[] = [];

      const sub1 = await pubsub.subscribe(channel1, (msg) => {
        received1.push(msg);
      });
      const sub2 = await pubsub.subscribe(channel2, (msg) => {
        received2.push(msg);
      });

      await pubsub.publish(channel1, { ch: 1 });
      await pubsub.publish(channel2, { ch: 2 });

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received1.length, 1);
      assert.strictEqual(received2.length, 1);
      assert.deepStrictEqual(received1[0], { ch: 1 });
      assert.deepStrictEqual(received2[0], { ch: 2 });

      await sub1.unsubscribe();
      await sub2.unsubscribe();
    });
  });

  // ============================================================================
  // Edge Cases - Rapid Messages
  // ============================================================================

  describe('Edge Cases - Rapid Messages', () => {
    it('should handle rapid fire messages', async () => {
      const channel = `rapid-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];
      const messageCount = 50;

      const sub = await pubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      // Send many messages rapidly
      for (let i = 0; i < messageCount; i++) {
        await pubsub.publish(channel, { index: i });
      }

      // Wait longer for all messages
      await new Promise(resolve => setTimeout(resolve, 500));

      assert.strictEqual(received.length, messageCount);

      await sub.unsubscribe();
    });

    it('should handle concurrent publishes', async () => {
      const channel = `concurrent-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];
      const messageCount = 20;

      const sub = await pubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      // Send messages concurrently
      await Promise.all(
        Array.from({ length: messageCount }, (_, i) =>
          pubsub.publish(channel, { index: i })
        )
      );

      await new Promise(resolve => setTimeout(resolve, 300));

      assert.strictEqual(received.length, messageCount);

      await sub.unsubscribe();
    });
  });

  // ============================================================================
  // Edge Cases - Many Subscribers
  // ============================================================================

  describe('Edge Cases - Many Subscribers', () => {
    it('should handle many subscribers on same channel', async () => {
      const channel = `many-subs-${randomUUID().slice(0, 8)}`;
      const subscriberCount = 10;
      const receivedArrays: unknown[][] = Array.from({ length: subscriberCount }, () => []);
      const subscriptions: Array<{ unsubscribe: () => Promise<void> }> = [];

      // Create many subscribers
      for (let i = 0; i < subscriberCount; i++) {
        const received = receivedArrays[i];
        const sub = await pubsub.subscribe(channel, (msg) => {
          received.push(msg);
        });
        subscriptions.push(sub);
      }

      await pubsub.publish(channel, { broadcast: true });

      await new Promise(resolve => setTimeout(resolve, 200));

      // All subscribers should receive the message
      for (let i = 0; i < subscriberCount; i++) {
        assert.strictEqual(receivedArrays[i].length, 1);
        assert.deepStrictEqual(receivedArrays[i][0], { broadcast: true });
      }

      // Cleanup
      for (const sub of subscriptions) {
        await sub.unsubscribe();
      }
    });

    it('should handle subscribe and unsubscribe churn', async () => {
      const channel = `churn-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      // Subscribe, receive, unsubscribe multiple times
      for (let i = 0; i < 5; i++) {
        const sub = await pubsub.subscribe(channel, (msg) => {
          received.push(msg);
        });

        await pubsub.publish(channel, { iteration: i });

        await new Promise(resolve => setTimeout(resolve, 50));

        await sub.unsubscribe();
      }

      // Should have received one message per iteration
      assert.strictEqual(received.length, 5);
    });
  });

  // ============================================================================
  // Edge Cases - Handler Behavior
  // ============================================================================

  describe('Edge Cases - Handler Behavior', () => {
    it('should handle async handler that throws', async () => {
      const channel = `async-throw-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await pubsub.subscribe(channel, async (msg) => {
        received.push(msg);
        if (received.length === 1) {
          await new Promise(resolve => setTimeout(resolve, 10));
          throw new Error('Async handler error');
        }
      });

      await pubsub.publish(channel, { n: 1 });
      await pubsub.publish(channel, { n: 2 });

      await new Promise(resolve => setTimeout(resolve, 200));

      assert.strictEqual(received.length, 2);

      await sub.unsubscribe();
    });

    it('should handle slow handler not blocking others', async () => {
      const channel = `slow-${randomUUID().slice(0, 8)}`;
      const received1: unknown[] = [];
      const received2: unknown[] = [];

      const sub1 = await pubsub.subscribe(channel, async (msg) => {
        await new Promise(resolve => setTimeout(resolve, 200));
        received1.push(msg);
      });

      const sub2 = await pubsub.subscribe(channel, (msg) => {
        received2.push(msg);
      });

      await pubsub.publish(channel, { test: true });

      // Second handler should receive quickly
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.strictEqual(received2.length, 1);

      // First handler should receive after delay
      await new Promise(resolve => setTimeout(resolve, 200));
      assert.strictEqual(received1.length, 1);

      await sub1.unsubscribe();
      await sub2.unsubscribe();
    });

    it('should handle handler that modifies external state', async () => {
      const channel = `state-${randomUUID().slice(0, 8)}`;
      let counter = 0;
      const state: Record<string, number> = {};

      const sub = await pubsub.subscribe(channel, (msg: unknown) => {
        counter++;
        state[(msg as { key: string }).key] = counter;
      });

      await pubsub.publish(channel, { key: 'a' });
      await pubsub.publish(channel, { key: 'b' });
      await pubsub.publish(channel, { key: 'a' });

      await new Promise(resolve => setTimeout(resolve, 150));

      assert.strictEqual(counter, 3);
      assert.strictEqual(state['a'], 3);
      assert.strictEqual(state['b'], 2);

      await sub.unsubscribe();
    });
  });

  // ============================================================================
  // Edge Cases - Close/Cleanup
  // ============================================================================

  describe('Edge Cases - Close/Cleanup', () => {
    it('should handle publish after unsubscribe gracefully', async () => {
      const channel = `post-unsub-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await pubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      await sub.unsubscribe();

      // Publishing to channel with no subscribers should not throw
      await pubsub.publish(channel, { after: true });

      await new Promise(resolve => setTimeout(resolve, 50));
      assert.strictEqual(received.length, 0);
    });

    it('should handle creating new instance after close', async () => {
      const connectionString = CONNECTION_STRING;
      const tempPubsub = await createPostgresPubSub({ connectionString });

      const channel = `temp-${randomUUID().slice(0, 8)}`;
      const received: unknown[] = [];

      const sub = await tempPubsub.subscribe(channel, (msg) => {
        received.push(msg);
      });

      await tempPubsub.publish(channel, { test: true });

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received.length, 1);

      await sub.unsubscribe();
      await tempPubsub.close();

      // Create a new instance - should work fine
      const newPubsub = await createPostgresPubSub({ connectionString });

      const received2: unknown[] = [];
      const sub2 = await newPubsub.subscribe(channel, (msg) => {
        received2.push(msg);
      });

      await newPubsub.publish(channel, { new: true });

      await new Promise(resolve => setTimeout(resolve, 100));

      assert.strictEqual(received2.length, 1);

      await sub2.unsubscribe();
      await newPubsub.close();
    });
  });
});
