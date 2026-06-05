/**
 * DataLoader Integration E2E Tests
 *
 * Tests for DataLoader integration with PgRepository and References.
 *
 * NOTE: These tests need createLoader() which is a PgRepository-specific method,
 * not available on the Repository<T> interface. We access it via casting.
 *
 * These tests require a running PostgreSQL database.
 * Start it with: docker compose up postgres -d
 */

import { describe, test, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import postgres from 'postgres';
import JustScale from '@justscale/core';
import { defineService, bindService, AbstractChannelBackend, MemoryChannelBackend } from '@justscale/core';
import { InMemoryProcessFeature } from '@justscale/core/process';
import { InMemoryLockFeature } from '@justscale/core/memory';
import { defineModel, field, SET_RESOLVER } from '@justscale/core/models';
import { createPgModel, createPgRepository, ModelChangeChannels, keyOf } from '../src/index.js';
import { createPostgresClient } from '../src/advanced/index.js';
import { ModelRegistry } from '../src/model/model-registry.js';
import { PgSchemaIntrospection } from '../src/migration/migration.js';
import { requirePostgres, CONNECTION_STRING } from './__mocks__/test-setup.js';

// =============================================================================
// Test Configuration
// =============================================================================

const TEST_ID = 'dataloader';
const USERS_TABLE = `users_${TEST_ID}`;
const POSTS_TABLE = `posts_${TEST_ID}`;

// =============================================================================
// Test Models
// =============================================================================

class User extends defineModel({
  name: field.string().max(255),
  email: field.string().max(255),
}) {}

class Post extends defineModel({
  title: field.string().max(255),
  content: field.text(),
  authorId: field.string(),
  tags: field.array(field.string()).default([]),
}) {}

// =============================================================================
// E2E Tests
// =============================================================================

describe('DataLoader Integration E2E', async () => {
  if (!await requirePostgres()) return;

  // Clear model registry before setup
  ModelRegistry.clear();

  // Setup SQL connection for table management
  const sql = postgres(CONNECTION_STRING);

  // Create PgModels and Repositories
  const PgUser = createPgModel(User, { table: USERS_TABLE, storageMode: 'columnar' });
  const PgPost = createPgModel(Post, { table: POSTS_TABLE, storageMode: 'columnar' });

  const UserRepository = createPgRepository(PgUser);
  const PostRepository = createPgRepository(PgPost);

  const PostgresClient = createPostgresClient({ connectionString: CONNECTION_STRING });

  // Service wrappers
  const UserService = defineService({
    inject: { users: UserRepository },
    factory: ({ users }) => users,
  });

  const PostService = defineService({
    inject: { posts: PostRepository },
    factory: ({ posts }) => posts,
  });

  // Build and compile app
  const app = JustScale()
    .add(InMemoryLockFeature)
    .add(InMemoryProcessFeature)
    .add(PostgresClient)
    .add(MemoryChannelBackend)
    .add(bindService(AbstractChannelBackend, MemoryChannelBackend))
    .add(ModelChangeChannels)
    .add(UserRepository)
    .add(PostRepository)
    .add(UserService)
    .add(PostService)
    .build()
    .compile();

  await app.ready;

  // Resolve services - types are inferred!
  const container = app.container;
  const client = await container.resolve(PostgresClient);
  const userRepo = await container.resolve(UserService);
  const postRepo = await container.resolve(PostService);

  // Create test tables via syncSchema
  await new PgSchemaIntrospection(client).sync(PgUser, PgPost);

  after(async () => {
    await sql`DROP TABLE IF EXISTS ${sql(POSTS_TABLE)}`;
    await sql`DROP TABLE IF EXISTS ${sql(USERS_TABLE)}`;
    await sql.end();
    await client.close();
  });

  beforeEach(async () => {
    await sql`TRUNCATE TABLE ${sql(POSTS_TABLE)}`;
    await sql`TRUNCATE TABLE ${sql(USERS_TABLE)}`;
  });

  test('should create DataLoader from repository', () => {
    const loader = (userRepo as any).createLoader();
    assert.ok(loader);
    assert.strictEqual(typeof loader.load, 'function');
    assert.strictEqual(typeof loader.loadMany, 'function');
  });

  test('should batch load entities by ID', async () => {
    const user1 = await userRepo.insert({ name: 'Alice', email: 'alice@example.com' });
    const user2 = await userRepo.insert({ name: 'Bob', email: 'bob@example.com' });
    const user3 = await userRepo.insert({ name: 'Charlie', email: 'charlie@example.com' });

    const loader = (userRepo as any).createLoader();

    const [loaded1, loaded2, loaded3] = await Promise.all([
      loader.load(keyOf(user1)),
      loader.load(keyOf(user2)),
      loader.load(keyOf(user3)),
    ]);

    assert.ok(loaded1);
    assert.ok(loaded2);
    assert.ok(loaded3);
    assert.strictEqual(loaded1.name, 'Alice');
    assert.strictEqual(loaded2.name, 'Bob');
    assert.strictEqual(loaded3.name, 'Charlie');
  });

  test('should cache loaded entities', async () => {
    const user = await userRepo.insert({ name: 'Alice', email: 'alice@example.com' });
    const loader = (userRepo as any).createLoader();

    const loaded1 = await loader.load(keyOf(user));
    const loaded2 = await loader.load(keyOf(user));
    const loaded3 = await loader.load(keyOf(user));

    assert.ok(loaded1);
    assert.strictEqual(loaded1, loaded2);
    assert.strictEqual(loaded2, loaded3);
  });

  test('should return undefined for non-existent IDs', async () => {
    const loader = (userRepo as any).createLoader();
    const result = await loader.load('00000000-0000-0000-0000-000000000000');
    assert.strictEqual(result, undefined);
  });

  test('should handle mix of existing and non-existing IDs', async () => {
    const user1 = await userRepo.insert({ name: 'Alice', email: 'alice@example.com' });
    const user2 = await userRepo.insert({ name: 'Bob', email: 'bob@example.com' });

    const loader = (userRepo as any).createLoader();

    const results = await loader.loadMany([
      keyOf(user1),
      '00000000-0000-0000-0000-000000000001',
      keyOf(user2),
      '00000000-0000-0000-0000-000000000002',
    ]);

    assert.strictEqual(results.length, 4);
    assert.ok(results[0]);
    assert.strictEqual(results[0].name, 'Alice');
    assert.strictEqual(results[1], undefined);
    assert.ok(results[2]);
    assert.strictEqual(results[2].name, 'Bob');
    assert.strictEqual(results[3], undefined);
  });

  test('should prime cache with inserted entities', async () => {
    const loader = (userRepo as any).createLoader();

    const user = await userRepo.insert({ name: 'Alice', email: 'alice@example.com' });

    loader.prime(keyOf(user), user);

    const loaded = await loader.load(keyOf(user));
    assert.strictEqual(loaded, user);
  });

  test('should use DataLoader with References.setBatchResolver', async () => {
    const user1 = await userRepo.insert({ name: 'Alice', email: 'alice@example.com' });
    const user2 = await userRepo.insert({ name: 'Bob', email: 'bob@example.com' });
    const user3 = await userRepo.insert({ name: 'Charlie', email: 'charlie@example.com' });

    const loader = (userRepo as any).createLoader();

    const refs = User.refs(keyOf(user1), keyOf(user2), keyOf(user3));
    refs.setBatchResolver((ids: string[]) =>
      loader.loadMany(ids).then((results: any[]) => {
        const map = new Map<string, typeof user1 | null>();
        for (let i = 0; i < ids.length; i++) {
          map.set(ids[i], results[i]);
        }
        return map;
      }),
    );

    refs[SET_RESOLVER]((id: string) => loader.load(id));

    const users = await refs.resolveAll();

    assert.strictEqual(users.length, 3);
    assert.strictEqual(users[0].name, 'Alice');
    assert.strictEqual(users[1].name, 'Bob');
    assert.strictEqual(users[2].name, 'Charlie');
  });

  test('should demonstrate N+1 prevention', async () => {
    const user1 = await userRepo.insert({ name: 'Alice', email: 'alice@example.com' });
    const user2 = await userRepo.insert({ name: 'Bob', email: 'bob@example.com' });

    await postRepo.insert({
      title: 'Post 1',
      content: 'Content 1',
      authorId: keyOf(user1),
      tags: ['tag1'],
    });
    await postRepo.insert({
      title: 'Post 2',
      content: 'Content 2',
      authorId: keyOf(user2),
      tags: ['tag2'],
    });
    await postRepo.insert({
      title: 'Post 3',
      content: 'Content 3',
      authorId: keyOf(user1),
      tags: ['tag3'],
    });

    const posts = await postRepo.find({});
    assert.strictEqual(posts.length, 3);

    const userLoader = (userRepo as any).createLoader();

    const authors = await Promise.all(posts.map((post) => userLoader.load(post.authorId)));

    assert.strictEqual(authors.length, 3);
    assert.ok(authors[0]);
    assert.ok(authors[1]);
    assert.ok(authors[2]);
  });

  test('should work across multiple batches', async () => {
    const users = await Promise.all([
      userRepo.insert({ name: 'User 1', email: 'user1@example.com' }),
      userRepo.insert({ name: 'User 2', email: 'user2@example.com' }),
      userRepo.insert({ name: 'User 3', email: 'user3@example.com' }),
      userRepo.insert({ name: 'User 4', email: 'user4@example.com' }),
      userRepo.insert({ name: 'User 5', email: 'user5@example.com' }),
    ]);

    const loader = (userRepo as any).createLoader();

    const batch1 = await Promise.all([loader.load(keyOf(users[0])), loader.load(keyOf(users[1]))]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const batch2 = await Promise.all([
      loader.load(keyOf(users[2])),
      loader.load(keyOf(users[3])),
      loader.load(keyOf(users[4])),
    ]);

    assert.strictEqual(batch1.length, 2);
    assert.strictEqual(batch2.length, 3);
    assert.ok(batch1[0]);
    assert.ok(batch2[2]);
    assert.strictEqual(batch1[0].name, 'User 1');
    assert.strictEqual(batch2[2].name, 'User 5');
  });
});
