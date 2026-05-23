/**
 * Nested Object and Array Field E2E Tests
 *
 * Tests type-safe queries on nested object fields and array operations.
 *
 * Start PostgreSQL: docker compose up postgres -d
 * Connection: postgresql://justscale:justscale@localhost:5432/justscale_test
 */

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import postgres from 'postgres';
import JustScale from '@justscale/core';
import { defineService, bindService, AbstractChannelBackend, MemoryChannelBackend } from '@justscale/core';
import { InMemoryProcessFeature } from '@justscale/core/process';
import { InMemoryLockFeature } from '@justscale/core/memory';
import { defineModel, field, q } from '@justscale/core/models';
import { createPostgresClient, type AbstractPostgresClient } from '../src/client/client.js';
import { createPgModel } from '../src/model/pg-model.js';
import { createPgRepository, ModelChangeChannels } from '../src/repository/pg-repository-service.js';
import { keyOf } from '../src/repository/pg-repository.js';
import { ModelRegistry } from '../src/model/model-registry.js';
import { PgSchemaIntrospection } from '../src/migration/migration.js';
import { requirePostgres, CONNECTION_STRING } from './__mocks__/test-setup.js';

// =============================================================================
// Test Configuration
// =============================================================================

const TEST_ID = 'nested';
const USERS_TABLE = `users_${TEST_ID}`;
const USERS_JSONB_TABLE = `users_jsonb_${TEST_ID}`;

// =============================================================================
// Test Models with Nested Objects and Arrays
// =============================================================================

class UserWithSettings extends defineModel({
  email: field.string().max(255),
  name: field.string(),
  settings: field.object({
    theme: field.string(),
    darkMode: field.boolean(),
    notifications: field.object({
      email: field.boolean(),
      push: field.boolean(),
    }),
  }),
  tags: field.array(field.string()),
  scores: field.array(field.int()),
}) {}

const f = UserWithSettings.fields;

// =============================================================================
// PgModels (columnar and JSONB)
// =============================================================================

const PgUserColumnar = createPgModel(UserWithSettings, {
  table: USERS_TABLE,
  storageMode: 'columnar',
});

const PgUserJsonb = createPgModel(UserWithSettings, {
  table: USERS_JSONB_TABLE,
  storageMode: 'jsonb',
  dataColumn: 'data',
});

// =============================================================================
// Repository Services
// =============================================================================

const ColumnarUserRepository = createPgRepository(PgUserColumnar);
const JsonbUserRepository = createPgRepository(PgUserJsonb);

// =============================================================================
// PostgresClient Service
// =============================================================================

const PostgresClient = createPostgresClient({ connectionString: CONNECTION_STRING });

// =============================================================================
// Application Services
// =============================================================================

const ColumnarUserService = defineService({
  inject: { users: ColumnarUserRepository },
  factory: ({ users }) => users,
});

const JsonbUserService = defineService({
  inject: { users: JsonbUserRepository },
  factory: ({ users }) => users,
});

// =============================================================================
// Test App
// =============================================================================

const built = JustScale()
  .add(InMemoryLockFeature)
  .add(InMemoryProcessFeature)
  .add(PostgresClient)
  .add(MemoryChannelBackend)
  .add(bindService(AbstractChannelBackend, MemoryChannelBackend))
  .add(ModelChangeChannels)
  .add(ColumnarUserRepository)
  .add(JsonbUserRepository)
  .add(ColumnarUserService)
  .add(JsonbUserService)
  .build();

// =============================================================================
// Tests
// =============================================================================

describe('Nested Object and Array Fields E2E', async () => {
  if (!await requirePostgres()) return;

  let sql: postgres.Sql;
  let client: AbstractPostgresClient;
   
  let columnarRepo: any;
   
  let jsonbRepo: any;

  before(async () => {
    ModelRegistry.clear();

    sql = postgres(CONNECTION_STRING);

    // Compile and wait for ready
    const app = built.compile();
    await app.ready;

    // Resolve services
    const container = app.container;
    client = await container.resolve(PostgresClient);
    columnarRepo = await container.resolve(ColumnarUserService);
    jsonbRepo = await container.resolve(JsonbUserService);

    // Create test tables via syncSchema
    await new PgSchemaIntrospection(client).sync(PgUserColumnar, PgUserJsonb);
  });

  after(async () => {
    await sql`DROP TABLE IF EXISTS ${sql(USERS_TABLE)}`;
    await sql`DROP TABLE IF EXISTS ${sql(USERS_JSONB_TABLE)}`;
    await sql.end();
    await client.close();
  });

  beforeEach(async () => {
    await sql`TRUNCATE ${sql(USERS_TABLE)}`;
    await sql`TRUNCATE ${sql(USERS_JSONB_TABLE)}`;
  });

  // ===========================================================================
  // Columnar Mode Tests - Nested Objects
  // ===========================================================================

  describe('Columnar Mode - Nested Objects', () => {
    test('should insert and retrieve nested object fields', async () => {
      const user = await columnarRepo.insert({
        email: 'test@example.com',
        name: 'Test User',
        settings: {
          theme: 'dark',
          darkMode: true,
          notifications: {
            email: true,
            push: false,
          },
        },
        tags: ['developer', 'typescript'],
        scores: [100, 95, 88],
      });

      const found = await columnarRepo.get(UserWithSettings.ref`${keyOf(user)}`);
      assert.ok(found);
      assert.strictEqual(found.settings.theme, 'dark');
      assert.strictEqual(found.settings.darkMode, true);
      assert.strictEqual(found.settings.notifications.email, true);
      assert.strictEqual(found.settings.notifications.push, false);
    });

    test('should query by nested object field - single level', async () => {
      await columnarRepo.insert({
        email: 'dark@example.com',
        name: 'Dark User',
        settings: { theme: 'dark', darkMode: true, notifications: { email: true, push: true } },
        tags: [],
        scores: [],
      });
      await columnarRepo.insert({
        email: 'light@example.com',
        name: 'Light User',
        settings: { theme: 'light', darkMode: false, notifications: { email: false, push: false } },
        tags: [],
        scores: [],
      });

      const darkUsers = await columnarRepo.find({
        where: f.settings.theme.eq('dark'),
      });

      assert.strictEqual(darkUsers.length, 1);
      assert.strictEqual(darkUsers[0].email, 'dark@example.com');
    });

    test('should query by deeply nested object field', async () => {
      await columnarRepo.insert({
        email: 'push@example.com',
        name: 'Push User',
        settings: { theme: 'dark', darkMode: true, notifications: { email: true, push: true } },
        tags: [],
        scores: [],
      });
      await columnarRepo.insert({
        email: 'nopush@example.com',
        name: 'No Push User',
        settings: { theme: 'dark', darkMode: true, notifications: { email: true, push: false } },
        tags: [],
        scores: [],
      });

      const pushUsers = await columnarRepo.find({
        where: f.settings.notifications.push.eq(true),
      });

      assert.strictEqual(pushUsers.length, 1);
      assert.strictEqual(pushUsers[0].email, 'push@example.com');
    });

    test('should combine nested object conditions with AND', async () => {
      await columnarRepo.insert({
        email: 'dark-push@example.com',
        name: 'Dark Push User',
        settings: { theme: 'dark', darkMode: true, notifications: { email: true, push: true } },
        tags: [],
        scores: [],
      });
      await columnarRepo.insert({
        email: 'dark-nopush@example.com',
        name: 'Dark No Push',
        settings: { theme: 'dark', darkMode: true, notifications: { email: true, push: false } },
        tags: [],
        scores: [],
      });
      await columnarRepo.insert({
        email: 'light-push@example.com',
        name: 'Light Push',
        settings: { theme: 'light', darkMode: false, notifications: { email: true, push: true } },
        tags: [],
        scores: [],
      });

      const darkPushUsers = await columnarRepo.find({
        where: q.and(
          f.settings.theme.eq('dark'),
          f.settings.notifications.push.eq(true),
        ),
      });

      assert.strictEqual(darkPushUsers.length, 1);
      assert.strictEqual(darkPushUsers[0].email, 'dark-push@example.com');
    });
  });

  // ===========================================================================
  // Columnar Mode Tests - Arrays
  // ===========================================================================

  describe('Columnar Mode - Arrays', () => {
    test('should insert and retrieve array fields', async () => {
      const user = await columnarRepo.insert({
        email: 'tagged@example.com',
        name: 'Tagged User',
        settings: { theme: 'dark', darkMode: false, notifications: { email: true, push: true } },
        tags: ['typescript', 'javascript', 'nodejs'],
        scores: [100, 95, 88],
      });

      const found = await columnarRepo.get(UserWithSettings.ref`${keyOf(user)}`);
      assert.ok(found);
      assert.deepStrictEqual(found.tags, ['typescript', 'javascript', 'nodejs']);
      assert.deepStrictEqual(found.scores, [100, 95, 88]);
    });

    test('should query by array contains single value', async () => {
      await columnarRepo.insert({
        email: 'ts@example.com',
        name: 'TS Dev',
        settings: { theme: 'dark', darkMode: false, notifications: { email: true, push: true } },
        tags: ['typescript', 'nodejs'],
        scores: [],
      });
      await columnarRepo.insert({
        email: 'py@example.com',
        name: 'Python Dev',
        settings: { theme: 'light', darkMode: false, notifications: { email: true, push: true } },
        tags: ['python', 'django'],
        scores: [],
      });

      const tsDevs = await columnarRepo.find({
        where: f.tags.contains('typescript'),
      });

      assert.strictEqual(tsDevs.length, 1);
      assert.strictEqual(tsDevs[0].email, 'ts@example.com');
    });

    test('should query by array hasAny (overlap)', async () => {
      await columnarRepo.insert({
        email: 'frontend@example.com',
        name: 'Frontend Dev',
        settings: { theme: 'dark', darkMode: false, notifications: { email: true, push: true } },
        tags: ['react', 'vue', 'angular'],
        scores: [],
      });
      await columnarRepo.insert({
        email: 'backend@example.com',
        name: 'Backend Dev',
        settings: { theme: 'light', darkMode: false, notifications: { email: true, push: true } },
        tags: ['nodejs', 'express', 'fastify'],
        scores: [],
      });
      await columnarRepo.insert({
        email: 'fullstack@example.com',
        name: 'Fullstack Dev',
        settings: { theme: 'dark', darkMode: true, notifications: { email: false, push: true } },
        tags: ['react', 'nodejs'],
        scores: [],
      });

      const reactOrNodeDevs = await columnarRepo.find({
        where: f.tags.hasAny(['react', 'nodejs']),
      });

      assert.strictEqual(reactOrNodeDevs.length, 3);
    });

    test('should query by array hasAll (contains all)', async () => {
      await columnarRepo.insert({
        email: 'mern@example.com',
        name: 'MERN Dev',
        settings: { theme: 'dark', darkMode: false, notifications: { email: true, push: true } },
        tags: ['mongodb', 'express', 'react', 'nodejs'],
        scores: [],
      });
      await columnarRepo.insert({
        email: 'mean@example.com',
        name: 'MEAN Dev',
        settings: { theme: 'light', darkMode: false, notifications: { email: true, push: true } },
        tags: ['mongodb', 'express', 'angular', 'nodejs'],
        scores: [],
      });
      await columnarRepo.insert({
        email: 'partial@example.com',
        name: 'Partial Stack',
        settings: { theme: 'dark', darkMode: true, notifications: { email: false, push: true } },
        tags: ['react', 'nodejs'],
        scores: [],
      });

      const fullStackWithExpress = await columnarRepo.find({
        where: f.tags.hasAll(['express', 'nodejs', 'mongodb']),
      });

      assert.strictEqual(fullStackWithExpress.length, 2);
    });

    test('should combine array conditions with nested object conditions', async () => {
      await columnarRepo.insert({
        email: 'dark-ts@example.com',
        name: 'Dark TS Dev',
        settings: { theme: 'dark', darkMode: true, notifications: { email: true, push: true } },
        tags: ['typescript', 'nodejs'],
        scores: [],
      });
      await columnarRepo.insert({
        email: 'light-ts@example.com',
        name: 'Light TS Dev',
        settings: { theme: 'light', darkMode: false, notifications: { email: true, push: true } },
        tags: ['typescript', 'react'],
        scores: [],
      });
      await columnarRepo.insert({
        email: 'dark-py@example.com',
        name: 'Dark Python Dev',
        settings: { theme: 'dark', darkMode: true, notifications: { email: true, push: true } },
        tags: ['python', 'django'],
        scores: [],
      });

      const darkTsDevs = await columnarRepo.find({
        where: q.and(
          f.settings.theme.eq('dark'),
          f.tags.contains('typescript'),
        ),
      });

      assert.strictEqual(darkTsDevs.length, 1);
      assert.strictEqual(darkTsDevs[0].email, 'dark-ts@example.com');
    });
  });

  // ===========================================================================
  // JSONB Mode Tests
  // ===========================================================================

  describe('JSONB Mode - Nested Objects and Arrays', () => {
    test('should insert and retrieve nested object and array fields', async () => {
      const user = await jsonbRepo.insert({
        email: 'jsonb@example.com',
        name: 'JSONB User',
        settings: {
          theme: 'dark',
          darkMode: true,
          notifications: { email: true, push: false },
        },
        tags: ['typescript', 'postgres'],
        scores: [100, 90],
      });

      const found = await jsonbRepo.get(UserWithSettings.ref`${keyOf(user)}`);
      assert.ok(found);
      assert.strictEqual(found.settings.theme, 'dark');
      assert.strictEqual(found.settings.notifications.push, false);
      assert.deepStrictEqual(found.tags, ['typescript', 'postgres']);
    });

    test('should query by nested object field in JSONB mode', async () => {
      await jsonbRepo.insert({
        email: 'dark@example.com',
        name: 'Dark User',
        settings: { theme: 'dark', darkMode: true, notifications: { email: true, push: true } },
        tags: [],
        scores: [],
      });
      await jsonbRepo.insert({
        email: 'light@example.com',
        name: 'Light User',
        settings: { theme: 'light', darkMode: false, notifications: { email: false, push: false } },
        tags: [],
        scores: [],
      });

      const darkUsers = await jsonbRepo.find({
        where: f.settings.theme.eq('dark'),
      });

      assert.strictEqual(darkUsers.length, 1);
      assert.strictEqual(darkUsers[0].email, 'dark@example.com');
    });

    test('should query by deeply nested object field in JSONB mode', async () => {
      await jsonbRepo.insert({
        email: 'push@example.com',
        name: 'Push User',
        settings: { theme: 'dark', darkMode: true, notifications: { email: true, push: true } },
        tags: [],
        scores: [],
      });
      await jsonbRepo.insert({
        email: 'nopush@example.com',
        name: 'No Push User',
        settings: { theme: 'dark', darkMode: true, notifications: { email: true, push: false } },
        tags: [],
        scores: [],
      });

      const pushUsers = await jsonbRepo.find({
        where: f.settings.notifications.push.eq(true),
      });

      assert.strictEqual(pushUsers.length, 1);
      assert.strictEqual(pushUsers[0].email, 'push@example.com');
    });

    test('should query by array contains in JSONB mode', async () => {
      await jsonbRepo.insert({
        email: 'ts@example.com',
        name: 'TS Dev',
        settings: { theme: 'dark', darkMode: false, notifications: { email: true, push: true } },
        tags: ['typescript', 'nodejs'],
        scores: [],
      });
      await jsonbRepo.insert({
        email: 'py@example.com',
        name: 'Python Dev',
        settings: { theme: 'light', darkMode: false, notifications: { email: true, push: true } },
        tags: ['python', 'django'],
        scores: [],
      });

      const tsDevs = await jsonbRepo.find({
        where: f.tags.contains('typescript'),
      });

      assert.strictEqual(tsDevs.length, 1);
      assert.strictEqual(tsDevs[0].email, 'ts@example.com');
    });
  });
});
