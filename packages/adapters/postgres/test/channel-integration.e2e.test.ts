/**
 * PostgreSQL Channel Integration E2E Tests
 *
 * Tests the full channel integration using PostgresChannelBackend with
 * realistic scenarios (chat room pattern).
 *
 * Requires a running PostgreSQL database.
 * Start it with: docker compose up postgres -d
 *
 * Connection: postgresql://justscale:justscale@localhost:5432/justscale_test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import JustScale, { bindService, defineService } from '@justscale/core';
import { InMemoryProcessFeature } from '@justscale/core/process';
import { InMemoryLockFeature } from '@justscale/core/memory';
import {
  createChannels,
  AbstractChannelBackend,
  type ChannelSubscription,
} from '@justscale/core';
import { createPostgresChannelBackend } from '../src/channel/channel-backend.js';
import { requirePostgres, CONNECTION_STRING } from './__mocks__/test-setup.js';

// =============================================================================
// Chat Room Scenario
// =============================================================================

describe('PostgreSQL Channel Integration E2E', async () => {
  if (!await requirePostgres()) return;

  // Define message types
  interface ChatMessage {
    type: 'join' | 'leave' | 'message'
    userId: string
    content?: string
    timestamp: number
  }

  // Create typed channels
  const RoomChannels = createChannels<ChatMessage>({ prefix: 'pg-room:' });

  // Create chat service that uses channels
  const ChatService = defineService({
    inject: { channels: RoomChannels },
    factory: ({ channels }) => ({
      join(roomId: string, userId: string): ChannelSubscription<ChatMessage> {
        const subscription = channels.subscribe(roomId);
        channels.publish(roomId, {
          type: 'join',
          userId,
          timestamp: Date.now(),
        });
        return subscription;
      },

      leave(roomId: string, userId: string): void {
        channels.publish(roomId, {
          type: 'leave',
          userId,
          timestamp: Date.now(),
        });
      },

      sendMessage(roomId: string, userId: string, content: string): void {
        channels.publish(roomId, {
          type: 'message',
          userId,
          content,
          timestamp: Date.now(),
        });
      },

      hasUsers(roomId: string): boolean {
        return channels.hasSubscribers(roomId);
      },

      getActiveRooms(): string[] {
        return channels.getActiveChannels();
      },
    }),
  });

  // Build app with PostgreSQL channel backend
  const PgChannelBackendService = createPostgresChannelBackend({
    connectionString: CONNECTION_STRING,
    channelPrefix: 'justscale_test',
  });

  const built = JustScale()
    .add(InMemoryLockFeature)
    .add(InMemoryProcessFeature)
    .add(PgChannelBackendService)
    .add(bindService(AbstractChannelBackend, PgChannelBackendService))
    .add(RoomChannels)
    .add(ChatService)
    .build();

  const app = built.compile();
  await app.ready;

  // Type assertions needed due to module resolution differences between
  // @justscale/channel and @justscale/core in the monorepo
  const chat = await built.resolve(ChatService as any) as ReturnType<typeof ChatService.factory>;
  const pgBackend = await built.resolve(PgChannelBackendService as any) as ReturnType<
    typeof createPostgresChannelBackend
  > & { close(): Promise<void> };

  // ===========================================================================
  // Single User Tests
  // ===========================================================================

  describe('Single User', () => {
    it('should receive own join message via Postgres LISTEN/NOTIFY', async () => {
      const subscription = chat.join('pg-room-single', 'user1');
      const iter = subscription[Symbol.asyncIterator]();

      const msg = await iter.next();
      assert.strictEqual(msg.done, false);
      assert.strictEqual(msg.value?.type, 'join');
      assert.strictEqual(msg.value?.userId, 'user1');
      assert.ok(msg.value?.timestamp > 0);

      subscription.unsubscribe();
    });

    it('should receive sent messages', async () => {
      const subscription = chat.join('pg-room-echo', 'user1');
      const iter = subscription[Symbol.asyncIterator]();

      // Consume join message
      await iter.next();

      // Send a message
      chat.sendMessage('pg-room-echo', 'user1', 'Hello via Postgres!');

      const msg = await iter.next();
      assert.strictEqual(msg.value?.type, 'message');
      assert.strictEqual(msg.value?.userId, 'user1');
      assert.strictEqual(msg.value?.content, 'Hello via Postgres!');

      subscription.unsubscribe();
    });

    it('should track active rooms correctly', async () => {
      assert.strictEqual(chat.hasUsers('pg-room-track'), false);

      const sub = chat.join('pg-room-track', 'user1');
      await consumeOne(sub);

      assert.strictEqual(chat.hasUsers('pg-room-track'), true);
      assert.ok(chat.getActiveRooms().includes('pg-room-track'));

      sub.unsubscribe();

      // Give time for cleanup
      await delay(10);

      assert.strictEqual(chat.hasUsers('pg-room-track'), false);
    });
  });

  // ===========================================================================
  // Multi-User Tests
  // ===========================================================================

  describe('Multi-User Room', () => {
    it('should broadcast messages to all users in room', async () => {
      // User 1 joins
      const sub1 = chat.join('pg-room-multi', 'alice');
      const msgs1: ChatMessage[] = [];

      // User 2 joins
      const sub2 = chat.join('pg-room-multi', 'bob');
      const msgs2: ChatMessage[] = [];

      // Collect messages from both subscriptions
      const collector1 = collectMessages(sub1, msgs1, 3);
      const collector2 = collectMessages(sub2, msgs2, 2);

      // Alice sends a message
      chat.sendMessage('pg-room-multi', 'alice', 'Hello Bob!');

      // Wait for messages to be collected
      await Promise.all([collector1, collector2]);

      // User 1 (alice) should have: join(alice), join(bob), message(alice)
      assert.strictEqual(msgs1.length, 3);
      assert.strictEqual(msgs1[0].type, 'join');
      assert.strictEqual(msgs1[0].userId, 'alice');
      assert.strictEqual(msgs1[1].type, 'join');
      assert.strictEqual(msgs1[1].userId, 'bob');
      assert.strictEqual(msgs1[2].type, 'message');
      assert.strictEqual(msgs1[2].content, 'Hello Bob!');

      // User 2 (bob) should have: join(bob), message(alice)
      assert.strictEqual(msgs2.length, 2);
      assert.strictEqual(msgs2[0].type, 'join');
      assert.strictEqual(msgs2[0].userId, 'bob');
      assert.strictEqual(msgs2[1].type, 'message');

      sub1.unsubscribe();
      sub2.unsubscribe();
    });

    it('should notify when users leave', async () => {
      const sub1 = chat.join('pg-room-leave', 'stayer');
      const msgs: ChatMessage[] = [];

      const sub2 = chat.join('pg-room-leave', 'leaver');

      // Collect messages
      const collector = collectMessages(sub1, msgs, 3);

      // Leaver leaves
      chat.leave('pg-room-leave', 'leaver');
      sub2.unsubscribe();

      await collector;

      // Should have: join(stayer), join(leaver), leave(leaver)
      assert.strictEqual(msgs.length, 3);
      assert.strictEqual(msgs[0].type, 'join');
      assert.strictEqual(msgs[0].userId, 'stayer');
      assert.strictEqual(msgs[1].type, 'join');
      assert.strictEqual(msgs[1].userId, 'leaver');
      assert.strictEqual(msgs[2].type, 'leave');
      assert.strictEqual(msgs[2].userId, 'leaver');

      sub1.unsubscribe();
    });
  });

  // ===========================================================================
  // Room Isolation Tests
  // ===========================================================================

  describe('Room Isolation', () => {
    it('should isolate messages between different rooms', async () => {
      const subA = chat.join('pg-room-a', 'user-a');
      const subB = chat.join('pg-room-b', 'user-b');

      const msgsA: ChatMessage[] = [];
      const msgsB: ChatMessage[] = [];

      // Collect join messages using iterators we'll keep
      const iterA = subA[Symbol.asyncIterator]();
      const iterB = subB[Symbol.asyncIterator]();

      msgsA.push((await iterA.next()).value!);
      msgsB.push((await iterB.next()).value!);

      // Note: With real backends (Postgres), messages are delivered both locally
      // AND via the backend, causing duplicates on a single node.
      // We need to drain any duplicate join messages before testing isolation.
      await delay(50); // Let backend messages arrive

      // Send message to pg-room-a only
      chat.sendMessage('pg-room-a', 'user-a', 'Secret A message');

      // Room A should receive it - keep reading until we get the secret message
      let foundSecret = false;
      for (let i = 0; i < 5; i++) {
        const result = await Promise.race([
          iterA.next(),
          delay(200).then(() => ({ done: true, value: undefined })),
        ]);
        if (result.done || !result.value) break;
        msgsA.push(result.value);
        if (result.value.content === 'Secret A message') {
          foundSecret = true;
          break;
        }
      }

      assert.ok(foundSecret, 'Room A should receive the secret message');

      // Room B should NOT receive it - collect any pending messages
      for (let i = 0; i < 5; i++) {
        const result = await Promise.race([
          iterB.next(),
          delay(100).then(() => ({ done: true, value: undefined })),
        ]);
        if (result.done || !result.value) break;
        msgsB.push(result.value);
      }

      // Room B should only have join messages (possibly duplicated), not the secret
      const secretInB = msgsB.find((m) => m.content === 'Secret A message');
      assert.ok(!secretInB, 'Room B should NOT receive Room A\'s secret message');

      subA.unsubscribe();
      subB.unsubscribe();
    });
  });

  // ===========================================================================
  // Subscription Lifecycle Tests
  // ===========================================================================

  describe('Subscription Lifecycle', () => {
    it('should support using statement for auto-cleanup', async () => {
      {
        using sub = chat.join('pg-room-using', 'temp-user');
        assert.strictEqual(sub.active, true);
        await consumeOne(sub);
      }

      // After using block, subscription should be disposed
      await delay(10);
      assert.strictEqual(chat.hasUsers('pg-room-using'), false);
    });

    it('should stop receiving after unsubscribe', async () => {
      const sub = chat.join('pg-room-unsub', 'user1');
      const msgs: ChatMessage[] = [];

      // Get join message
      msgs.push((await sub[Symbol.asyncIterator]().next()).value!);

      // Unsubscribe
      sub.unsubscribe();
      assert.strictEqual(sub.active, false);

      // Try to send message
      chat.sendMessage('pg-room-unsub', 'user1', 'This should not arrive');

      // Try to read - should not get the message
      await collectMessagesWithTimeout(sub, msgs, 1, 100);

      // Should still only have the join message
      assert.strictEqual(msgs.length, 1);
    });
  });

  // ===========================================================================
  // Concurrent Operations Tests
  // ===========================================================================

  describe('Concurrent Operations', () => {
    it('should handle concurrent publishes', async () => {
      const sub = chat.join('pg-room-concurrent', 'listener');
      const msgs: ChatMessage[] = [];

      // Skip join message
      await consumeOne(sub);

      // Send 10 messages concurrently
      const sendPromises = [];
      for (let i = 0; i < 10; i++) {
        sendPromises.push(
          Promise.resolve(
            chat.sendMessage('pg-room-concurrent', `sender-${i}`, `Message ${i}`),
          ),
        );
      }
      await Promise.all(sendPromises);

      // Collect all messages
      await collectMessages(sub, msgs, 10);

      assert.strictEqual(msgs.length, 10);
      // All messages should be received (order may vary due to concurrency)
      const contents = msgs.map((m) => m.content).sort();
      for (let i = 0; i < 10; i++) {
        assert.ok(contents.includes(`Message ${i}`));
      }

      sub.unsubscribe();
    });
  });

  // Cleanup
  after(async () => {
    if (pgBackend && typeof pgBackend.close === 'function') {
      await pgBackend.close();
    }
  });
});

// =============================================================================
// Helper Functions
// =============================================================================

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function consumeOne<T>(
  sub: ChannelSubscription<T>,
): Promise<T | undefined> {
  const iter = sub[Symbol.asyncIterator]();
  const result = await iter.next();
  return result.value;
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

function collectMessagesWithTimeout<T>(
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
        msgs.push(result.value!);
      }
      clearTimeout(timeout);
      resolve();
    })();
  });
}
