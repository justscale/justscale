/**
 * PostgresChannelBackend E2E Tests
 *
 * These tests require a running PostgreSQL database.
 * Start it with: docker compose up postgres -d
 *
 * Connection: postgresql://justscale:justscale@localhost:5432/justscale_test
 */

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert';
import { PostgresChannelBackend } from '../src/channel/channel-backend.js';
import { requirePostgres, CONNECTION_STRING } from './__mocks__/test-setup.js';

// =============================================================================
// Tests
// =============================================================================

describe('PostgresChannelBackend E2E', async () => {
  if (!await requirePostgres()) return;

  // ===========================================================================
  // Basic Pub/Sub
  // ===========================================================================

  describe('Pub/Sub', () => {
    test('should subscribe and receive messages', async () => {
      const backend = new PostgresChannelBackend({
        connectionString: CONNECTION_STRING,
      });

      const messages: unknown[] = [];
      let resolveReceived!: () => void;
      const received = new Promise<void>((r) => {
        resolveReceived = r;
      });

      const sub = backend.subscribe('test-channel', (msg) => {
        messages.push(msg);
        if (messages.length >= 1) resolveReceived();
      });

      await sub.ready;
      backend.publish('test-channel', { type: 'test', value: 42 });

      await received;

      assert.strictEqual(messages.length, 1);
      assert.deepStrictEqual(messages[0], { type: 'test', value: 42 });

      await backend.close();
    });

    test('should support multiple subscribers on same channel', async () => {
      const backend = new PostgresChannelBackend({
        connectionString: CONNECTION_STRING,
      });

      const messages1: unknown[] = [];
      const messages2: unknown[] = [];

      let resolve1: () => void;
      let resolve2: () => void;
      const received1 = new Promise<void>((r) => {
        resolve1 = r;
      });
      const received2 = new Promise<void>((r) => {
        resolve2 = r;
      });

      const sub1 = backend.subscribe('shared-channel', (msg) => {
        messages1.push(msg);
        resolve1();
      });
      const sub2 = backend.subscribe('shared-channel', (msg) => {
        messages2.push(msg);
        resolve2();
      });

      // Wait for subscriptions to establish
      await Promise.all([sub1.ready, sub2.ready]);

      backend.publish('shared-channel', { data: 'shared' });

      await Promise.all([received1, received2]);

      assert.strictEqual(messages1.length, 1);
      assert.strictEqual(messages2.length, 1);
      assert.deepStrictEqual(messages1[0], { data: 'shared' });
      assert.deepStrictEqual(messages2[0], { data: 'shared' });

      await backend.close();
    });

    test('should isolate messages between channels', async () => {
      const backend = new PostgresChannelBackend({
        connectionString: CONNECTION_STRING,
      });

      const messagesA: unknown[] = [];
      const messagesB: unknown[] = [];

      let resolveA: () => void;
      const receivedA = new Promise<void>((r) => {
        resolveA = r;
      });

      const subA = backend.subscribe('channel-a', (msg) => {
        messagesA.push(msg);
        resolveA();
      });
      const subB = backend.subscribe('channel-b', (msg) => {
        messagesB.push(msg);
      });

      await Promise.all([subA.ready, subB.ready]);

      backend.publish('channel-a', { channel: 'a' });

      await receivedA;
      // Give some time for potential wrong delivery
      await new Promise((r) => setTimeout(r, 100));

      assert.strictEqual(messagesA.length, 1);
      assert.strictEqual(messagesB.length, 0);

      await backend.close();
    });

    test('should support unsubscribe via dispose', async () => {
      const backend = new PostgresChannelBackend({
        connectionString: CONNECTION_STRING,
      });

      const messages: unknown[] = [];
      let resolveFirst: () => void;
      const firstReceived = new Promise<void>((r) => {
        resolveFirst = r;
      });

      const sub = backend.subscribe('disposable-channel', (msg) => {
        messages.push(msg);
        resolveFirst();
      });

      await sub.ready;

      backend.publish('disposable-channel', { n: 1 });
      await firstReceived;

      // Dispose the subscription
      sub[Symbol.dispose]();

      // Wait for unsubscribe to complete
      await new Promise((r) => setTimeout(r, 200));

      // Publish again - should not be received
      backend.publish('disposable-channel', { n: 2 });

      // Wait for potential message
      await new Promise((r) => setTimeout(r, 100));

      assert.strictEqual(messages.length, 1);

      await backend.close();
    });
  });

  // ===========================================================================
  // Cross-Backend Communication
  // ===========================================================================

  describe('Cross-Backend Communication', () => {
    test('should communicate between two backend instances', async () => {
      const backend1 = new PostgresChannelBackend({
        connectionString: CONNECTION_STRING,
        channelPrefix: 'test',
      });
      const backend2 = new PostgresChannelBackend({
        connectionString: CONNECTION_STRING,
        channelPrefix: 'test',
      });

      const messagesFromBackend1: unknown[] = [];
      let resolve1: () => void;
      const received1 = new Promise<void>((r) => {
        resolve1 = r;
      });

      // Backend 1 subscribes
      const sub1 = backend1.subscribe('cross-test', (msg) => {
        messagesFromBackend1.push(msg);
        resolve1();
      });

      await sub1.ready;

      // Backend 2 publishes
      backend2.publish('cross-test', { from: 'backend2' });

      await received1;

      assert.strictEqual(messagesFromBackend1.length, 1);
      assert.deepStrictEqual(messagesFromBackend1[0], { from: 'backend2' });

      await backend1.close();
      await backend2.close();
    });
  });
});
