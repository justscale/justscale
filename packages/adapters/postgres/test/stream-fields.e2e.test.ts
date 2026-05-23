/**
 * PostgreSQL Stream Fields E2E Tests
 *
 * Tests stream fields with the PostgreSQL channel backend to verify:
 * - Stream pub/sub works across multiple repository instances
 * - Protected streams enforce Lock<T> requirement
 * - Multi-instance scenarios (simulating separate processes)
 *
 * Requires a running PostgreSQL database.
 * Start it with: docker compose up postgres -d
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import JustScale, { bindService, defineService } from '@justscale/core';
import { InMemoryProcessFeature } from '@justscale/core/process';
import { InMemoryLockFeature, InMemoryLockProvider } from '@justscale/core/memory';
import {
  createChannels,
  AbstractChannelBackend,
  type ChannelSubscription,
} from '@justscale/core';
import {
  defineModel,
  field,
  StreamImpl,
  SET_STREAM_CHANNEL,
  isStream,
  isLocked,
  type Stream,
} from '@justscale/core/models';
import { LockProvider } from '@justscale/core';
import { createPostgresChannelBackend } from '../src/channel/channel-backend.js';
import { requirePostgres, CONNECTION_STRING } from './__mocks__/test-setup.js';

// =============================================================================
// Test Models
// =============================================================================

class ChatMessage extends defineModel({
  text: field.string(),
  sender: field.string(),
}) {}

class StatusEvent extends defineModel({
  status: field.string(),
  reason: field.string().optional(),
}) {}

class Room extends defineModel({
  name: field.string(),
  messages: field.stream(ChatMessage),
}) {}

class Order extends defineModel({
  orderId: field.string(),
  status: field.string(),
  statusChanges: field.stream(StatusEvent).protected(),
}) {}

// =============================================================================
// Stream Field Tests with PostgreSQL Backend
// =============================================================================

describe('PostgreSQL Stream Fields E2E', async () => {
  if (!await requirePostgres()) return;

  // Create channels service for streams
  const StreamChannels = createChannels<unknown>({ prefix: 'stream:' });

  // Build app with PostgreSQL channel backend
  const PgChannelBackendService = createPostgresChannelBackend({
    connectionString: CONNECTION_STRING,
    channelPrefix: 'stream_test',
  });

  const built = JustScale()
    .add(InMemoryLockFeature)
    .add(InMemoryProcessFeature)
    .add(PgChannelBackendService)
    .add(bindService(AbstractChannelBackend, PgChannelBackendService))
    .add(StreamChannels)
    .build();

  const app = built.compile();
  await app.ready;

  const channels = await built.resolve(StreamChannels as any) as any;
  const lockProvider = await built.resolve(InMemoryLockProvider as any) as any;
  const pgBackend = await built.resolve(PgChannelBackendService as any) as any;

  after(async () => {
    if (pgBackend?.close) await pgBackend.close();
  });

  // ===========================================================================
  // Basic Stream Pub/Sub
  // ===========================================================================

  describe('Basic Stream Pub/Sub', () => {
    it('should subscribe and receive messages via Postgres LISTEN/NOTIFY', async () => {
      const entityId = 'room-pg-1';
      const channelKey = `rooms:${entityId}:messages`;

      const sub = channels.subscribe(channelKey);
      const msgs: unknown[] = [];

      const collector = collectMessages(sub, msgs, 2);

      channels.publish(channelKey, { text: 'Hello', sender: 'alice' });
      channels.publish(channelKey, { text: 'World', sender: 'bob' });

      await collector;

      assert.strictEqual(msgs.length, 2);
      assert.strictEqual((msgs[0] as any).text, 'Hello');
      assert.strictEqual((msgs[1] as any).text, 'World');

      sub.unsubscribe();
    });

    it('should isolate streams by channel key (entity:field)', async () => {
      const room1Key = 'rooms:room-1:messages';
      const room2Key = 'rooms:room-2:messages';

      const sub1 = channels.subscribe(room1Key);
      const sub2 = channels.subscribe(room2Key);

      const msgs1: unknown[] = [];
      const msgs2: unknown[] = [];

      // Wait for subscriptions to establish
      await delay(100);

      const collect1 = collectWithTimeout(sub1, msgs1, 1, 200);
      const collect2 = collectWithTimeout(sub2, msgs2, 1, 200);

      // Publish only to room 1
      channels.publish(room1Key, { text: 'Secret', sender: 'spy' });

      await Promise.all([collect1, collect2]);

      assert.strictEqual(msgs1.length, 1);
      assert.strictEqual((msgs1[0] as any).text, 'Secret');
      assert.strictEqual(msgs2.length, 0, 'Room 2 should NOT receive Room 1 messages');

      sub1.unsubscribe();
      sub2.unsubscribe();
    });

    it('should broadcast to multiple subscribers on same stream', async () => {
      const channelKey = 'rooms:broadcast-pg:messages';

      const sub1 = channels.subscribe(channelKey);
      const sub2 = channels.subscribe(channelKey);

      const msgs1: unknown[] = [];
      const msgs2: unknown[] = [];

      await delay(100);

      const collect1 = collectMessages(sub1, msgs1, 1);
      const collect2 = collectMessages(sub2, msgs2, 1);

      channels.publish(channelKey, { text: 'Broadcast' });

      await Promise.all([collect1, collect2]);

      assert.strictEqual(msgs1.length, 1);
      assert.strictEqual(msgs2.length, 1);

      sub1.unsubscribe();
      sub2.unsubscribe();
    });
  });

  // ===========================================================================
  // Multi-Instance Simulation
  // ===========================================================================

  describe('Multi-Instance Communication', () => {
    it('should receive messages from different backend instances', async () => {
      // Create second backend instance (simulating different process)
      const PgChannelBackend2 = createPostgresChannelBackend({
        connectionString: CONNECTION_STRING,
        channelPrefix: 'stream_test',
      });

      const built2 = JustScale()
        .add(InMemoryLockFeature)
        .add(InMemoryProcessFeature)
        .add(PgChannelBackend2)
        .add(bindService(AbstractChannelBackend, PgChannelBackend2))
        .add(StreamChannels)
        .build();

      const app2 = built2.compile();
      await app2.ready;

      const channels2 = await built2.resolve(StreamChannels as any) as any;
      const pgBackend2 = await built2.resolve(PgChannelBackend2 as any) as any;

      try {
        const channelKey = 'rooms:cross-instance:messages';

        // Instance 1 subscribes
        const sub1 = channels.subscribe(channelKey);
        const msgs1: unknown[] = [];

        // Wait for subscription to establish
        await delay(150);

        const collector1 = collectMessages(sub1, msgs1, 1);

        // Instance 2 publishes
        channels2.publish(channelKey, { text: 'From instance 2', sender: 'remote' });

        await collector1;

        assert.strictEqual(msgs1.length, 1);
        assert.strictEqual((msgs1[0] as any).text, 'From instance 2');

        sub1.unsubscribe();
      } finally {
        if (pgBackend2?.close) await pgBackend2.close();
      }
    });

    it('should support bidirectional communication between instances', async () => {
      const PgChannelBackend2 = createPostgresChannelBackend({
        connectionString: CONNECTION_STRING,
        channelPrefix: 'stream_test',
      });

      const built2 = JustScale()
        .add(InMemoryLockFeature)
        .add(InMemoryProcessFeature)
        .add(PgChannelBackend2)
        .add(bindService(AbstractChannelBackend, PgChannelBackend2))
        .add(StreamChannels)
        .build();

      await built2.compile().ready;
      const channels2 = await built2.resolve(StreamChannels as any) as any;
      const pgBackend2 = await built2.resolve(PgChannelBackend2 as any) as any;

      try {
        const channelKey = 'rooms:bidirectional-pg:messages';

        // Both subscribe
        const sub1 = channels.subscribe(channelKey);
        const sub2 = channels2.subscribe(channelKey);

        const msgs1: unknown[] = [];
        const msgs2: unknown[] = [];

        await delay(150);

        const collect1 = collectMessages(sub1, msgs1, 2);
        const collect2 = collectMessages(sub2, msgs2, 2);

        // Both publish
        channels.publish(channelKey, { from: 'instance1' });
        channels2.publish(channelKey, { from: 'instance2' });

        await Promise.all([collect1, collect2]);

        // Both should receive both messages
        assert.strictEqual(msgs1.length, 2);
        assert.strictEqual(msgs2.length, 2);

        sub1.unsubscribe();
        sub2.unsubscribe();
      } finally {
        if (pgBackend2?.close) await pgBackend2.close();
      }
    });
  });

  // ===========================================================================
  // StreamImpl Integration
  // ===========================================================================

  describe('StreamImpl with Postgres Backend', () => {
    it('should work with StreamImpl connected to channel', async () => {
      const channelKey = 'rooms:streamimpl-pg:messages';

      // Create stream and connect to channel
      const stream = new StreamImpl<{ text: string }>(false);

      const subscription = channels.subscribe(channelKey);
      const publishFn = (msg: unknown) => channels.publish(channelKey, msg);

      stream[SET_STREAM_CHANNEL](subscription, publishFn);

      assert.strictEqual(stream.isConnected, true);
      assert.strictEqual(isStream(stream), true);

      const msgs: { text: string }[] = [];
      const collector = (async () => {
        for await (const msg of stream) {
          msgs.push(msg);
          if (msgs.length >= 2) break;
        }
      })();

      // Publish via stream
      stream.publish({ text: 'Hello via StreamImpl' });
      stream.publish({ text: 'Second message' });

      await collector;

      assert.strictEqual(msgs.length, 2);
      assert.strictEqual(msgs[0].text, 'Hello via StreamImpl');
      assert.strictEqual(msgs[1].text, 'Second message');

      subscription.unsubscribe();
    });
  });

  // ===========================================================================
  // Protected Stream with Locks
  // ===========================================================================

  describe('Protected Streams with Locks', () => {
    it('should prevent publishing without lock', async () => {
      const channelKey = 'orders:order-1:statusChanges';

      // Create protected stream
      const stream = new StreamImpl<{ status: string }>(true);

      const subscription = channels.subscribe(channelKey);
      const publishFn = (msg: unknown) => channels.publish(channelKey, msg);

      // Entity is not locked
      const mockEntity = { id: 'order-1', status: 'pending' };
      const lockChecker = () => isLocked(mockEntity);

      stream[SET_STREAM_CHANNEL](subscription, publishFn, lockChecker);

      assert.throws(
        () => stream.publish({ status: 'shipped' }),
        /Protected stream requires Lock<T> to publish/
      );

      subscription.unsubscribe();
    });

    it('should allow publishing when entity is locked', async () => {
      const channelKey = 'orders:order-locked:statusChanges';

      // Create protected stream
      const stream = new StreamImpl<{ status: string }>(true);

      const subscription = channels.subscribe(channelKey);
      const publishFn = (msg: unknown) => channels.publish(channelKey, msg);

      // Simulate locked entity
      const lockChecker = () => true; // Pretend it's locked

      stream[SET_STREAM_CHANNEL](subscription, publishFn, lockChecker);

      const msgs: { status: string }[] = [];
      const collector = (async () => {
        for await (const msg of stream) {
          msgs.push(msg);
          if (msgs.length >= 1) break;
        }
      })();

      // Should not throw
      stream.publish({ status: 'shipped' });

      await collector;

      assert.strictEqual(msgs.length, 1);
      assert.strictEqual(msgs[0].status, 'shipped');

      subscription.unsubscribe();
    });

    it('should enforce lock check dynamically', async () => {
      const channelKey = 'orders:order-dynamic:statusChanges';

      const stream = new StreamImpl<{ status: string }>(true);

      const subscription = channels.subscribe(channelKey);
      const publishFn = (msg: unknown) => channels.publish(channelKey, msg);

      // Dynamic lock state
      let isEntityLocked = false;
      const lockChecker = () => isEntityLocked;

      stream[SET_STREAM_CHANNEL](subscription, publishFn, lockChecker);

      // Should fail when not locked
      assert.throws(
        () => stream.publish({ status: 'pending' }),
        /Protected stream requires Lock<T>/
      );

      // Acquire lock
      isEntityLocked = true;

      // Now should work
      stream.publish({ status: 'processing' });

      // Release lock
      isEntityLocked = false;

      // Should fail again
      assert.throws(
        () => stream.publish({ status: 'completed' }),
        /Protected stream requires Lock<T>/
      );

      subscription.unsubscribe();
    });
  });

  // ===========================================================================
  // Multiple Streams per Entity
  // ===========================================================================

  describe('Multiple Streams per Entity', () => {
    it('should handle multiple independent streams on same entity', async () => {
      const entityId = 'multi-stream-entity';
      const eventsKey = `entities:${entityId}:events`;
      const messagesKey = `entities:${entityId}:messages`;

      const eventsSub = channels.subscribe(eventsKey);
      const messagesSub = channels.subscribe(messagesKey);

      const events: unknown[] = [];
      const messages: unknown[] = [];

      await delay(100);

      const collectEvents = collectMessages(eventsSub, events, 2);
      const collectMessages_ = collectMessages(messagesSub, messages, 2);

      // Publish to both streams
      channels.publish(eventsKey, { status: 'started' });
      channels.publish(messagesKey, { text: 'Hello' });
      channels.publish(eventsKey, { status: 'completed' });
      channels.publish(messagesKey, { text: 'Goodbye' });

      await Promise.all([collectEvents, collectMessages_]);

      assert.strictEqual(events.length, 2);
      assert.strictEqual((events[0] as any).status, 'started');
      assert.strictEqual((events[1] as any).status, 'completed');

      assert.strictEqual(messages.length, 2);
      assert.strictEqual((messages[0] as any).text, 'Hello');
      assert.strictEqual((messages[1] as any).text, 'Goodbye');

      eventsSub.unsubscribe();
      messagesSub.unsubscribe();
    });
  });

  // ===========================================================================
  // Concurrent Iteration
  // ===========================================================================

  describe('Concurrent Iteration', () => {
    it('should support multiple concurrent iterators on same channel', async () => {
      const channelKey = 'rooms:concurrent-iter:messages';

      // Two subscriptions to the same channel
      const sub1 = channels.subscribe(channelKey);
      const sub2 = channels.subscribe(channelKey);

      const msgs1: unknown[] = [];
      const msgs2: unknown[] = [];

      await delay(100);

      // Start both collectors
      const collect1 = collectMessages(sub1, msgs1, 3);
      const collect2 = collectMessages(sub2, msgs2, 3);

      // Publish 3 messages
      channels.publish(channelKey, { id: 1 });
      channels.publish(channelKey, { id: 2 });
      channels.publish(channelKey, { id: 3 });

      await Promise.all([collect1, collect2]);

      // Both should receive all 3
      assert.strictEqual(msgs1.length, 3);
      assert.strictEqual(msgs2.length, 3);

      sub1.unsubscribe();
      sub2.unsubscribe();
    });

    it('should handle subscriber joining mid-stream', async () => {
      const channelKey = 'rooms:mid-join:messages';

      // First subscriber
      const sub1 = channels.subscribe(channelKey);
      const msgs1: unknown[] = [];

      await delay(100);

      // Publish first message
      channels.publish(channelKey, { id: 1 });

      // Collect first message
      await collectMessages(sub1, msgs1, 1);

      // Second subscriber joins after first message
      const sub2 = channels.subscribe(channelKey);
      const msgs2: unknown[] = [];

      await delay(50);

      // Start collectors for remaining messages
      const collect1 = collectMessages(sub1, msgs1, 2);
      const collect2 = collectMessages(sub2, msgs2, 2);

      // Publish more messages
      channels.publish(channelKey, { id: 2 });
      channels.publish(channelKey, { id: 3 });

      await Promise.all([collect1, collect2]);

      // First subscriber has all 3
      assert.strictEqual(msgs1.length, 3);

      // Second subscriber only has messages after joining
      assert.strictEqual(msgs2.length, 2);
      assert.strictEqual((msgs2[0] as any).id, 2);
      assert.strictEqual((msgs2[1] as any).id, 3);

      sub1.unsubscribe();
      sub2.unsubscribe();
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle rapid subscribe/unsubscribe', async () => {
      const channelKey = 'rooms:rapid-lifecycle:messages';

      const subs: ChannelSubscription<unknown>[] = [];

      // Rapidly create subscriptions
      for (let i = 0; i < 10; i++) {
        subs.push(channels.subscribe(channelKey));
      }

      assert.strictEqual(channels.hasSubscribers(channelKey), true);

      // Rapidly unsubscribe
      for (const sub of subs) {
        sub.unsubscribe();
      }

      await delay(50);
      assert.strictEqual(channels.hasSubscribers(channelKey), false);
    });

    it('should handle JSON-serializable complex objects', async () => {
      const channelKey = 'rooms:complex-json:messages';

      const sub = channels.subscribe(channelKey);
      const msgs: unknown[] = [];

      await delay(100);

      const collector = collectMessages(sub, msgs, 1);

      const complexObj = {
        nested: { deep: { value: 42 } },
        array: [1, 2, 3],
        nullValue: null,
        booleans: { t: true, f: false },
      };

      channels.publish(channelKey, complexObj);

      await collector;

      assert.deepStrictEqual(msgs[0], complexObj);

      sub.unsubscribe();
    });

    it('should handle concurrent publishes', async () => {
      const channelKey = 'rooms:concurrent-pg:messages';

      const sub = channels.subscribe(channelKey);
      const msgs: unknown[] = [];

      await delay(100);

      // Send 20 messages concurrently
      const promises = [];
      for (let i = 0; i < 20; i++) {
        promises.push(Promise.resolve(channels.publish(channelKey, { index: i })));
      }
      await Promise.all(promises);

      // Collect all messages
      await collectMessages(sub, msgs, 20);

      assert.strictEqual(msgs.length, 20);

      // Verify all received (order may vary)
      const indices = new Set(msgs.map((m: any) => m.index));
      for (let i = 0; i < 20; i++) {
        assert.ok(indices.has(i), `Message ${i} should be received`);
      }

      sub.unsubscribe();
    });
  });
});

// =============================================================================
// Helper Functions
// =============================================================================

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function collectMessages<T>(
  sub: ChannelSubscription<T>,
  msgs: T[],
  count: number,
): Promise<void> {
  const iter = sub[Symbol.asyncIterator]();
  for (let i = 0; i < count; i++) {
    const result = await iter.next();
    if (result.done) break;
    msgs.push(result.value!);
  }
}

function collectWithTimeout<T>(
  sub: ChannelSubscription<T>,
  msgs: T[],
  count: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    const iter = sub[Symbol.asyncIterator]()

    ;(async () => {
      for (let i = 0; i < count; i++) {
        const result = await Promise.race([
          iter.next(),
          delay(timeoutMs).then(() => ({ done: true, value: undefined })),
        ]);
        if (result.done) break;
        msgs.push(result.value as T);
      }
      clearTimeout(timeout);
      resolve();
    })();
  });
}
