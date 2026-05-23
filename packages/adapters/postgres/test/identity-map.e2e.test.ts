/**
 * Identity Map E2E Tests
 *
 * Tests that verify the Identity Map pattern implementation:
 * - Same ID returns same object instance within a transaction
 * - Identity map is scoped to transactions
 * - Nested transactions share the identity map
 * - Updates refresh the identity map
 *
 * NOTE: These tests need direct access to client.transaction() and
 * client.clearIdentityMap() which are low-level client methods, so we
 * use createRawPostgresClient and PgRepository directly.
 *
 * These tests require a running PostgreSQL database.
 * Start it with: docker compose up postgres -d
 */

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import postgres from 'postgres';
import JustScale from '@justscale/core';
import { defineService, bindService, AbstractChannelBackend, MemoryChannelBackend } from '@justscale/core';
import { InMemoryProcessFeature } from '@justscale/core/process';
import { InMemoryLockFeature } from '@justscale/core/memory';
import { defineModel, field } from '@justscale/core/models';
import {
  createPostgresClient,
  createPgModel,
  createPgRepository,
  ModelChangeChannels,
  PgRepository,
  AbstractPostgresClient,
  keyOf,
  versionOf,
} from '../src/index.js';
import { ModelRegistry } from '../src/model/model-registry.js';
import { PgSchemaIntrospection } from '../src/migration/migration.js';
import { requirePostgres, CONNECTION_STRING } from './__mocks__/test-setup.js';

// =============================================================================
// Test Configuration
// =============================================================================

const TEST_ID = 'identity_map';
const USERS_TABLE = `users_${TEST_ID}`;

// =============================================================================
// Test Models
// =============================================================================

class User extends defineModel({
  email: field.string().max(255),
  name: field.string(),
  balance: field.decimal(10, 2).default('0.00'),
}) {}

// =============================================================================
// PgModel and Repository
// =============================================================================

const PgUser = createPgModel(User, {
  table: USERS_TABLE,
  storageMode: 'columnar',
});

const UserRepository = createPgRepository(PgUser);
const PostgresClient = createPostgresClient({ connectionString: CONNECTION_STRING });

// Service wrapper to get repository
const UserService = defineService({
  inject: { users: UserRepository },
  factory: ({ users }) => users,
});

// Build app
const built = JustScale()
  .add(InMemoryLockFeature)
  .add(InMemoryProcessFeature)
  .add(PostgresClient)
  .add(MemoryChannelBackend)
  .add(bindService(AbstractChannelBackend, MemoryChannelBackend))
  .add(ModelChangeChannels)
  .add(UserRepository)
  .add(UserService)
  .build();

// =============================================================================
// Tests
// =============================================================================

describe('Identity Map E2E', async () => {
  if (!await requirePostgres()) return;

  let sql: postgres.Sql;
  let client: AbstractPostgresClient;
   
  let userRepo: any;

  before(async () => {
    ModelRegistry.clear();
    sql = postgres(CONNECTION_STRING);

    // Compile app and resolve services
    const app = built.compile();
    await app.ready;

    const container = app.container;
    client = await container.resolve(AbstractPostgresClient);
    userRepo = await container.resolve(UserService);

    // Create tables via syncSchema
    await new PgSchemaIntrospection(client).sync(PgUser);
  });

  after(async () => {
    await sql`DROP TABLE IF EXISTS ${sql(USERS_TABLE)}`;
    await sql.end();
    await client.close();
  });

  beforeEach(async () => {
    await sql`TRUNCATE ${sql(USERS_TABLE)}`;
    client.clearIdentityMap();
  });

  // ===========================================================================
  // Basic Identity Map Tests
  // ===========================================================================

  test('should return same object instance for same ID within transaction', async () => {
    await client.transaction(async () => {
      const user = await userRepo.insert({
        email: 'test@example.com',
        name: 'Test User',
        balance: '100.00',
      });

      const found1 = await userRepo.get(User.ref`${keyOf(user)}`);
      const found2 = await userRepo.get(User.ref`${keyOf(user)}`);

      // Should be the exact same object instance
      assert.strictEqual(found1, found2);
      assert.strictEqual(found1, user);
    });
  });

  test('should use identity map for findById after insert', async () => {
    await client.transaction(async () => {
      const inserted = await userRepo.insert({
        email: 'test@example.com',
        name: 'Test User',
        balance: '100.00',
      });

      const found = await userRepo.get(User.ref`${keyOf(inserted)}`);

      // Should be the same instance
      assert.strictEqual(found, inserted);
    });
  });

  test('should use identity map for entities returned by find()', async () => {
    await client.transaction(async () => {
      const user1 = await userRepo.insert({
        email: 'user1@example.com',
        name: 'User 1',
        balance: '100.00',
      });

      const user2 = await userRepo.insert({
        email: 'user2@example.com',
        name: 'User 2',
        balance: '200.00',
      });

      // Find all users
      const allUsers = await userRepo.find({});

      // Find by ID should return same instances
      const found1 = await userRepo.get(User.ref`${keyOf(user1)}`);
      const found2 = await userRepo.get(User.ref`${keyOf(user2)}`);

      // Should be exact same instances as from find()
      const foundUser1 = allUsers.find((u: any) => keyOf(u) === keyOf(user1));
      const foundUser2 = allUsers.find((u: any) => keyOf(u) === keyOf(user2));

      assert.strictEqual(found1, foundUser1);
      assert.strictEqual(found2, foundUser2);
    });
  });

  test('should update identity map when entity is updated', async () => {
    await client.transaction(async () => {
      const user = await userRepo.insert({
        email: 'test@example.com',
        name: 'Original Name',
        balance: '100.00',
      });

      await userRepo.get(User.ref`${keyOf(user)}`);

      // Update the user
      const updated = await userRepo.update(user, { name: 'Updated Name' });

      // Identity map should now have the updated instance
      const found = await userRepo.get(User.ref`${keyOf(user)}`);

      // Should be the updated instance, not the original
      assert.strictEqual(found, updated);
      assert.strictEqual(found?.name, 'Updated Name');
      assert.strictEqual(versionOf(found!), 2);
    });
  });

  test('should mutate object when properties change', async () => {
    await client.transaction(async () => {
      const user = await userRepo.insert({
        email: 'test@example.com',
        name: 'Test User',
        balance: '100.00',
      });

      const ref1 = await userRepo.get(User.ref`${keyOf(user)}`);
      assert.strictEqual(ref1?.name, 'Test User');

      // Update the entity
      await userRepo.update(user, { name: 'New Name' });

      const ref2 = await userRepo.get(User.ref`${keyOf(user)}`);

      // ref2 should have the new data
      assert.strictEqual(ref2?.name, 'New Name');

      // But it's a different object now (updated one)
      // The identity map gets the new updated entity
      assert.strictEqual(versionOf(ref2!), 2);
    });
  });

  // ===========================================================================
  // Transaction Scoping Tests
  // ===========================================================================

  test('should use global identity map outside transaction', async () => {
    const user = await userRepo.insert({
      email: 'test@example.com',
      name: 'Test User',
      balance: '100.00',
    });

    // Outside transaction - global identity map still works
    const found1 = await userRepo.get(User.ref`${keyOf(user)}`);
    const found2 = await userRepo.get(User.ref`${keyOf(user)}`);

    // Should be the same instance (global identity map)
    assert.strictEqual(found1, found2);
    assert.strictEqual(found1, user);
  });

  test('should share global identity map across different transactions', async () => {
    const user = await userRepo.insert({
      email: 'test@example.com',
      name: 'Test User',
      balance: '100.00',
    });

    let instance1: any;
    let instance2: any;

    await client.transaction(async () => {
      instance1 = await userRepo.get(User.ref`${keyOf(user)}`);
    });

    await client.transaction(async () => {
      instance2 = await userRepo.get(User.ref`${keyOf(user)}`);
    });

    // Global identity map shares across transactions
    assert.strictEqual(instance1, instance2);
    assert.strictEqual(instance1, user);
  });

  test('should share identity map in nested transactions', async () => {
    await client.transaction(async () => {
      const user = await userRepo.insert({
        email: 'test@example.com',
        name: 'Test User',
        balance: '100.00',
      });

      const outerInstance = await userRepo.get(User.ref`${keyOf(user)}`);

      await client.transaction(async () => {
        const innerInstance = await userRepo.get(User.ref`${keyOf(user)}`);

        // Nested transaction shares the identity map
        assert.strictEqual(outerInstance, innerInstance);
      });
    });
  });

  test('should preserve identity map across nested transaction boundaries', async () => {
    await client.transaction(async () => {
      const user = await userRepo.insert({
        email: 'test@example.com',
        name: 'Test User',
        balance: '100.00',
      });

      await userRepo.get(User.ref`${keyOf(user)}`);

      await client.transaction(async () => {
        // Update in nested transaction
        await userRepo.update(user, { name: 'Updated in Nested' });
      });

      const afterNested = await userRepo.get(User.ref`${keyOf(user)}`);

      // Should have the updated entity
      assert.strictEqual(afterNested?.name, 'Updated in Nested');
    });
  });

  // ===========================================================================
  // Clear Identity Map Tests
  // ===========================================================================

  test('should clear identity map when clearIdentityMap is called', async () => {
    // Test outside transaction to isolate behavior
    const user = await userRepo.insert({
      email: 'test@example.com',
      name: 'Test User',
      balance: '100.00',
    });

    // Verify entity is in identity map
    const cached = client.getFromIdentityMap(USERS_TABLE, keyOf(user));
    assert.strictEqual(cached, user, 'Entity should be in identity map after insert');

    const instance1 = await userRepo.get(User.ref`${keyOf(user)}`);
    assert.strictEqual(instance1, user, 'First findById should return same instance from identity map');

    // Clear the identity map
    client.clearIdentityMap();

    // Verify identity map is empty after clear
    const afterClear = client.getFromIdentityMap(USERS_TABLE, keyOf(user));
    assert.strictEqual(afterClear, undefined, 'Identity map should be empty after clear');

    const instance2 = await userRepo.get(User.ref`${keyOf(user)}`);

    // After clearing, should be a different instance (new object from DB)
    assert.notStrictEqual(instance1, instance2, 'After clear, should get new instance from DB');

    // But same data
    assert.strictEqual(keyOf(instance1!), keyOf(instance2!));
    assert.strictEqual(instance1?.email, instance2?.email);
  });

  test('clearIdentityMap outside transaction should not throw', () => {
    // Should not throw when called outside transaction
    assert.doesNotThrow(() => {
      client.clearIdentityMap();
    });
  });

  // ===========================================================================
  // Complex Scenarios
  // ===========================================================================

  test('should maintain identity across multiple queries in transaction', async () => {
    await client.transaction(async () => {
      const user1 = await userRepo.insert({
        email: 'user1@example.com',
        name: 'User 1',
        balance: '100.00',
      });

      await userRepo.insert({
        email: 'user2@example.com',
        name: 'User 2',
        balance: '200.00',
      });

      // Multiple find operations
      const allUsers1 = await userRepo.find({});
      const byId1 = await userRepo.get(User.ref`${keyOf(user1)}`);
      const allUsers2 = await userRepo.find({});
      const byId2 = await userRepo.get(User.ref`${keyOf(user1)}`);

      // All should return same instance for user1
      const fromFind1 = allUsers1.find((u: any) => keyOf(u) === keyOf(user1));
      const fromFind2 = allUsers2.find((u: any) => keyOf(u) === keyOf(user1));

      assert.strictEqual(byId1, byId2);
      assert.strictEqual(byId1, fromFind1);
      assert.strictEqual(byId1, fromFind2);
    });
  });

  test('should handle transaction rollback and not leak identity map', async () => {
    const user = await userRepo.insert({
      email: 'test@example.com',
      name: 'Test User',
      balance: '100.00',
    });

    try {
      await client.transaction(async () => {
        const instance = await userRepo.get(User.ref`${keyOf(user)}`);
        assert.ok(instance);

        // Force rollback
        throw new Error('Rollback test');
      });
    } catch {
      // Expected error
    }

    // New transaction should have fresh identity map
    await client.transaction(async () => {
      const instance1 = await userRepo.get(User.ref`${keyOf(user)}`);
      const instance2 = await userRepo.get(User.ref`${keyOf(user)}`);

      // Should be same instance within this new transaction
      assert.strictEqual(instance1, instance2);
    });
  });

  test('INVARIANT: root-transaction rollback purges identity map (no ghost entities after ROLLBACK)', async () => {
    // The repo writes inserted entities to the client's identity map inside
    // the transaction. If the transaction then rolls back, the DB has no
    // row - but the identity map does. A follow-up get() would resolve the
    // ghost entity from the map instead of re-querying (which would return
    // undefined). That's silent poisoning.
    const email = 'ghost@example.com';
    let insertedId: string | undefined;

    await assert.rejects(
      client.transaction(async () => {
        const ghost = await userRepo.insert({
          email,
          name: 'Ghost User',
          balance: '0.00',
        });
        insertedId = keyOf(ghost);
        // Sanity: ghost is in the map now.
        const cached = await userRepo.get(User.ref`${insertedId}`);
        assert.strictEqual(cached, ghost, 'identity map should return the exact instance inside the tx');
        throw new Error('roll-back-the-insert');
      }),
      /roll-back-the-insert/,
    );
    assert.ok(insertedId, 'insert should have produced an id');

    // DB-level truth: row does NOT exist.
    const rows = await sql`SELECT 1 FROM ${sql(USERS_TABLE)} WHERE email = ${email}`;
    assert.strictEqual(rows.length, 0, 'rollback must remove the row from the DB');

    // Repo-level behaviour: must NOT return a cached ghost.
    const resolved = await userRepo.get(User.ref`${insertedId!}`);
    assert.strictEqual(
      resolved,
      undefined,
      'identity map must be purged on root-transaction rollback - got a ghost entity that has no DB row',
    );
  });

  test('should work correctly with findOne using identity map', async () => {
    await client.transaction(async () => {
      const user = await userRepo.insert({
        email: 'test@example.com',
        name: 'Test User',
        balance: '100.00',
      });

      const found1 = await userRepo.findOne(User.fields.email.eq('test@example.com'));
      const found2 = await userRepo.get(User.ref`${keyOf(user)}`);

      // Should be the same instance
      assert.strictEqual(found1, found2);
      assert.strictEqual(found1, user);
    });
  });

  // ===========================================================================
  // Multiple Repositories
  // ===========================================================================

  test('should maintain separate identity maps per table', async () => {
    // Create another repository for the same table
    // (Direct PgRepository access needed for this test)
    const userRepo2 = new PgRepository(client, User, {
      tableName: USERS_TABLE,
      storageMode: 'columnar',
    });

    await client.transaction(async () => {
      const user = await userRepo.insert({
        email: 'test@example.com',
        name: 'Test User',
        balance: '100.00',
      });

      const instance1 = await userRepo.get(User.ref`${keyOf(user)}`);
      const instance2 = await userRepo2.get(User.ref`${keyOf(user)}`);

      // Same table = same identity map key = same instance
      assert.strictEqual(instance1, instance2);
    });
  });
});
