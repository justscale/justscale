/**
 * Multi-Instance Observe E2E Tests
 *
 * Tests that observe() works across multiple repository instances,
 * simulating multiple application nodes connected to the same database.
 *
 * This test uses PostgreSQL LISTEN/NOTIFY via PostgresChannelBackend,
 * but the observe() pattern works with any channel backend (Redis, etc).
 *
 * Note: Channel backends should handle channel name length limits internally.
 * PostgreSQL has a 63-character limit for LISTEN/NOTIFY channel names.
 * Redis and other backends may have different limits.
 *
 * Requires a running PostgreSQL database.
 * Start it with: docker compose up postgres -d
 * Run with: tsx --test --test-force-exit <file>
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import postgres from 'postgres';
import JustScale, { bindService } from '@justscale/core';
import { InMemoryProcessFeature } from '@justscale/core/process';
import { InMemoryLockFeature } from '@justscale/core/memory';
import { defineModel, field } from '@justscale/core/models';
import { AbstractChannelBackend } from '@justscale/core';
import {
  createPgModel,
  createPgRepository,
  type AbstractPostgresClient,
  ModelChangeChannels,
  keyOf,
} from '../src/index.js';
import { createPostgresClient } from '../src/client/client.js';
import { createPostgresChannelBackend } from '../src/channel/channel-backend.js';
import { PgSchemaIntrospection } from '../src/migration/migration.js';
import { requirePostgres, CONNECTION_STRING } from './__mocks__/test-setup.js';

// =============================================================================
// Test Models
// =============================================================================

class Counter extends defineModel({
  name: field.string(),
  value: field.int().default(0),
}) {}

const PgCounter = createPgModel(Counter, { table: 'test_counters' });
const CounterRepository = createPgRepository(PgCounter);

// =============================================================================
// Tests
// =============================================================================

describe('Multi-Instance Observe E2E', { timeout: 30000 }, async () => {
  if (!await requirePostgres()) return;

  let sql: ReturnType<typeof postgres>;
  let instance1: {
    client: AbstractPostgresClient
    repo: Awaited<ReturnType<typeof CounterRepository['factory']>>
    backend: AbstractChannelBackend
    channels: Awaited<ReturnType<typeof ModelChangeChannels['factory']>>
  };
  let instance2: {
    client: AbstractPostgresClient
    repo: Awaited<ReturnType<typeof CounterRepository['factory']>>
    backend: AbstractChannelBackend
    channels: Awaited<ReturnType<typeof ModelChangeChannels['factory']>>
  };

  before(async () => {
    // Create raw SQL connection for setup
    sql = postgres(CONNECTION_STRING);

    // Create two independent "instances" (simulating two app nodes)
    instance1 = await createInstance('instance1');
    instance2 = await createInstance('instance2');

    // Create test table via syncSchema
    await new PgSchemaIntrospection(instance1.client).sync(PgCounter);
    await sql`TRUNCATE test_counters`;
  });

  after(async () => {
    // Cleanup - order matters: channels first, then backends, then clients
    if (instance1?.channels) instance1.channels.close();
    if (instance2?.channels) instance2.channels.close();

    // Wait a tick for disposal to complete
    await delay(50);

    if (instance1?.backend) await instance1.backend.close();
    if (instance2?.backend) await instance2.backend.close();

    if (instance1?.client) await instance1.client.close();
    if (instance2?.client) await instance2.client.close();

    if (sql) {
      await sql`DROP TABLE IF EXISTS test_counters`;
      await sql.end();
    }
  });

  async function createInstance(_name: string) {
    const PgClient = createPostgresClient({ connectionString: CONNECTION_STRING });
    // All instances must share the same channel prefix for cross-instance communication!
    // Long channel names are automatically hashed by PostgresChannelBackend
    const PgChannelBackendService = createPostgresChannelBackend({
      connectionString: CONNECTION_STRING,
      channelPrefix: 'justscale_observe_test',
    });

    const app = JustScale()
      .add(InMemoryLockFeature)
      .add(InMemoryProcessFeature)
      .add(PgClient)
      .add(PgChannelBackendService)
      .add(bindService(AbstractChannelBackend, PgChannelBackendService))
      .add(ModelChangeChannels)
      .add(CounterRepository)
      .build()
      .compile();

    await app.ready;

    const container = app.container;
    return {
      client: await container.resolve(PgClient),
      repo: await container.resolve(CounterRepository),
      backend: await container.resolve(PgChannelBackendService),
      channels: await container.resolve(ModelChangeChannels),
    };
  }

  it('should receive updates when another instance modifies an entity', async () => {
    // Instance 1 creates a counter
    const counter = await instance1.repo.insert({ name: 'shared-counter', value: 0 });
    const counterId = keyOf(counter);

    // First verify the channels work at the low level
    const channelKey = `test_counters:${counterId}`;

    // Instance 2 subscribes to the channel directly
    const receivedMessages: unknown[] = [];
    const subscription = instance2.channels.subscribe(channelKey);
    const subscriptionPromise = (async () => {
      for await (const msg of subscription) {
        receivedMessages.push(msg);
        if (receivedMessages.length >= 1) break;
      }
    })();

    // Give subscription time to set up
    await delay(200);

    // Instance 1 publishes
    instance1.channels.publish(channelKey, {
      type: 'update',
      table: 'test_counters',
      id: counterId,
    });

    // Wait for message
    await Promise.race([
      subscriptionPromise,
      delay(3000).then(() => {
        throw new Error('Channel message timeout');
      }),
    ]);

    subscription.unsubscribe();

    assert.strictEqual(receivedMessages.length, 1, 'Should receive 1 channel message');

    // Now test the full observe() flow
    const observeIterable = instance2.repo.observe(counter);
    const observedUpdates: { value: number; name: string }[] = [];
    const observer = observeIterable[Symbol.asyncIterator]();
    const observerPromise = (async () => {
      for await (const updated of observeIterable) {
        observedUpdates.push(updated);
        if (observedUpdates.length >= 1) break;
      }
    })();

    // Give observer time to subscribe
    await delay(200);

    // Instance 1 locks and updates the counter (broadcasts automatically)
    const locked = await instance1.repo.lock(Counter.ref`${counterId}`);
    await instance1.repo.update(locked!, { value: 1 });

    // Wait for observer to receive update (with timeout)
    await Promise.race([
      observerPromise,
      delay(5000).then(() => {
        throw new Error('Observer timeout - did not receive expected updates');
      }),
    ]);

    // Explicitly close the async generator to clean up subscriptions
    await observer.return?.(undefined);

    // Verify instance 2 received the update
    assert.strictEqual(observedUpdates.length, 1, 'Should receive 1 update');
    assert.strictEqual(observedUpdates[0].value, 1, 'Update should have value 1');
  });

  it('should stop observing when entity is deleted', async () => {
    // Create a counter
    const counter = await instance1.repo.insert({ name: 'to-delete', value: 100 });
    const counterId = keyOf(counter);

    // Instance 2 observes
    let observerEnded = false;
    const observer = instance2.repo.observe(counter);
    const observerPromise = (async () => {
      for await (const _ of observer) {
        // Should not receive any updates if delete comes first
      }
      observerEnded = true;
    })();

    await delay(100);

    // Instance 1 locks and deletes (broadcasts automatically)
    const locked = await instance1.repo.lock(Counter.ref`${counterId}`);
    await instance1.repo.delete(locked!);

    // Wait for observer to end
    await Promise.race([
      observerPromise,
      delay(2000).then(() => {
        throw new Error('Observer should have ended after delete');
      }),
    ]);

    assert.strictEqual(observerEnded, true, 'Observer should end when entity is deleted');
  });

  it('observer misses an update written between get() and subscribe() (known race window)', async () => {
    // Scenario:
    //   1. A reads entity (snapshot S, value=0).
    //   2. B updates entity to value=1 (NOTIFY fires).
    //   3. A calls observe(S).
    // If the LISTEN registers AFTER the NOTIFY, A's observer stays silent
    // until the NEXT write - missing B's update entirely. This is a latent
    // gap in the observe() contract; the current impl doesn't re-fetch on
    // subscribe to catch up with the interim.
    //
    // This probe pins the CURRENT behaviour so we notice if it changes.
    // Expected today: observer does NOT receive the missed update.
    // If observe() ever re-fetches on subscribe, flip this assertion.
    const counter = await instance1.repo.insert({ name: 'race', value: 0 });
    const counterId = keyOf(counter);
    const snapshot = await instance2.repo.get(Counter.ref`${counterId}`);
    assert.ok(snapshot);

    // Force instance2's identity map to hold this entity so observe sees
    // the same instance. Also flush any cached per-channel LISTEN.
    await delay(100);

    // Step 2: B updates to value=1 BEFORE A subscribes.
    const locked = await instance1.repo.lock(Counter.ref`${counterId}`);
    await instance1.repo.update(locked!, { value: 1 });

    // Step 3: A subscribes. LISTEN had no reason to be active yet.
    const observeIterable = instance2.repo.observe(snapshot);
    const observedUpdates: { value: number; name: string }[] = [];
    const observer = observeIterable[Symbol.asyncIterator]();
    const observerPromise = (async () => {
      for await (const u of observeIterable) {
        observedUpdates.push(u);
        if (observedUpdates.length >= 1) break;
      }
    })();

    // Give observe time to subscribe (LISTEN round-trip).
    await delay(400);

    // No further writes for 600ms - if observer already yielded the
    // missed update, it's caught up. If not, it's stuck waiting.
    const got = await Promise.race([
      observerPromise.then(() => 'yielded' as const),
      delay(600).then(() => 'silent' as const),
    ]);

    // Drain no matter what.
    await observer.return?.(undefined);

    assert.strictEqual(
      got,
      'yielded',
      'observe() must re-fetch on subscribe to catch the interim update (was a race window)',
    );
    assert.strictEqual(observedUpdates[0].value, 1, 'the yielded value must reflect the interim update');
  });

  it('should observe using a Reference', async () => {
    // Create a counter
    const counter = await instance1.repo.insert({ name: 'ref-observe', value: 50 });
    const counterId = keyOf(counter);

    // Create a reference to it
    const ref = Counter.ref`${counterId}`;

    // Instance 2 observes via reference
    const observeIterable = instance2.repo.observe(ref);
    const observedUpdates: { value: number; name: string }[] = [];
    const observer = observeIterable[Symbol.asyncIterator]();
    const observerPromise = (async () => {
      for await (const updated of observeIterable) {
        observedUpdates.push(updated);
        if (observedUpdates.length >= 1) break;
      }
    })();

    await delay(100);

    // Instance 1 locks and updates (broadcasts automatically)
    const locked = await instance1.repo.lock(Counter.ref`${counterId}`);
    await instance1.repo.update(locked!, { value: 51 });

    await Promise.race([
      observerPromise,
      delay(3000).then(() => {
        throw new Error('Observer timeout');
      }),
    ]);

    // Explicitly close the async generator to clean up subscriptions
    await observer.return?.(undefined);

    assert.strictEqual(observedUpdates.length, 1);
    assert.strictEqual(observedUpdates[0].value, 51);
    assert.strictEqual(observedUpdates[0].name, 'ref-observe');
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
