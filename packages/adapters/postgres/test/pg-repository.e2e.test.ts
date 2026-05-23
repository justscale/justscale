/**
 * PgRepository E2E Tests
 *
 * These tests require a running PostgreSQL database.
 * Start it with: docker compose up postgres -d
 *
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
import { keyOf, versionOf, PG_CREATED_AT, PG_UPDATED_AT } from '../src/repository/pg-repository.js';
import { ModelRegistry } from '../src/model/model-registry.js';
import { PgSchemaIntrospection } from '../src/migration/migration.js';
import { requirePostgres, CONNECTION_STRING } from './__mocks__/test-setup.js';

// =============================================================================
// Test Configuration
// =============================================================================

const TEST_ID = 'repo';
const POSTS_TABLE = `posts_${TEST_ID}`;
const POSTS_JSONB_TABLE = `posts_jsonb_${TEST_ID}`;

// =============================================================================
// Test Models
// =============================================================================

class Post extends defineModel({
  title: field.string().max(255),
  content: field.text(),
  status: field.enum('PostStatus', ['draft', 'published', 'archived'] as const),
  views: field.int().default(0),
  rating: field.decimal(3, 2).optional(),
  published: field.boolean().default(false),
  authorEmail: field.string().max(255).optional(),
}) {}
const f = Post.fields;

// =============================================================================
// PgModels (columnar and JSONB)
// =============================================================================

const PgPostColumnar = createPgModel(Post, {
  table: POSTS_TABLE,
  storageMode: 'columnar',
});

const PgPostJsonb = createPgModel(Post, {
  table: POSTS_JSONB_TABLE,
  storageMode: 'jsonb',
  dataColumn: 'data',
});

// =============================================================================
// Repository Services
// =============================================================================

const ColumnarPostRepository = createPgRepository(PgPostColumnar);
const JsonbPostRepository = createPgRepository(PgPostJsonb);

// =============================================================================
// PostgresClient Service
// =============================================================================

const PostgresClient = createPostgresClient({ connectionString: CONNECTION_STRING });

// =============================================================================
// Application Services (thin wrappers for DI)
// =============================================================================

const ColumnarPostService = defineService({
  inject: { posts: ColumnarPostRepository },
  factory: ({ posts }) => posts,
});

const JsonbPostService = defineService({
  inject: { posts: JsonbPostRepository },
  factory: ({ posts }) => posts,
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
  .add(ColumnarPostRepository)
  .add(JsonbPostRepository)
  .add(ColumnarPostService)
  .add(JsonbPostService)
  .build();

// =============================================================================
// Tests
// =============================================================================

describe('PgRepository E2E', async () => {
  if (!await requirePostgres()) return;

  let sql: postgres.Sql;
  let client: AbstractPostgresClient;
   
  let columnarRepo: any;
   
  let jsonbRepo: any;

  before(async () => {
    // Clear model registry
    ModelRegistry.clear();

    sql = postgres(CONNECTION_STRING);

    // Compile and wait for ready
    const app = built.compile();
    await app.ready;

    // Resolve services via async container
    const container = app.container;
    client = await container.resolve(PostgresClient);
    columnarRepo = await container.resolve(ColumnarPostService);
    jsonbRepo = await container.resolve(JsonbPostService);

    // Create tables via syncSchema
    await new PgSchemaIntrospection(client).sync(PgPostColumnar, PgPostJsonb);
  });

  after(async () => {
    // Clean up test tables
    await sql`DROP TABLE IF EXISTS ${sql(POSTS_TABLE)}`;
    await sql`DROP TABLE IF EXISTS ${sql(POSTS_JSONB_TABLE)}`;
    await sql.end();
    await client.close();
  });

  beforeEach(async () => {
    // Clear all data between tests
    await sql`TRUNCATE ${sql(POSTS_TABLE)}`;
    await sql`TRUNCATE ${sql(POSTS_JSONB_TABLE)}`;
  });

  // ===========================================================================
  // Columnar Mode Tests
  // ===========================================================================

  describe('Columnar Mode', () => {
    test('should insert and find by id', async () => {
      const post = await columnarRepo.insert({
        title: 'Hello World',
        content: 'First post',
        status: 'draft',
        views: 0,
        published: false,
      });

      assert.ok(keyOf(post));
      assert.strictEqual(post.title, 'Hello World');
      assert.strictEqual(post.status, 'draft');
      assert.strictEqual(versionOf(post), 1);
      assert.ok((post as any)[PG_CREATED_AT] instanceof Date);

      const found = await columnarRepo.get(Post.ref`${keyOf(post)}`);
      assert.ok(found);
      assert.strictEqual(found.title, 'Hello World');
    });

    test('should find with simple equality condition', async () => {
      await columnarRepo.insert({ title: 'Draft 1', content: 'x', status: 'draft', views: 0, published: false });
      await columnarRepo.insert({ title: 'Published 1', content: 'x', status: 'published', views: 10, published: true });
      await columnarRepo.insert({ title: 'Published 2', content: 'x', status: 'published', views: 20, published: true });

      const published = await columnarRepo.find({
        where: f.status.eq('published'),
      });

      assert.strictEqual(published.length, 2);
      assert.ok(published.every((p: any) => p.status === 'published'));
    });

    test('should find with numeric comparison', async () => {
      await columnarRepo.insert({ title: 'Low', content: 'x', status: 'published', views: 5, published: true });
      await columnarRepo.insert({ title: 'Medium', content: 'x', status: 'published', views: 50, published: true });
      await columnarRepo.insert({ title: 'High', content: 'x', status: 'published', views: 500, published: true });

      const highViews = await columnarRepo.find({
        where: f.views.gt(20),
      });

      assert.strictEqual(highViews.length, 2);
      assert.ok(highViews.every((p: any) => p.views > 20));
    });

    test('should find with LIKE pattern', async () => {
      await columnarRepo.insert({ title: 'TypeScript Guide', content: 'x', status: 'published', views: 0, published: true });
      await columnarRepo.insert({ title: 'JavaScript Intro', content: 'x', status: 'published', views: 0, published: true });
      await columnarRepo.insert({ title: 'Python Basics', content: 'x', status: 'published', views: 0, published: true });

      const scriptPosts = await columnarRepo.find({
        where: f.title.contains('Script'),
      });

      assert.strictEqual(scriptPosts.length, 2);
    });

    test('should find with AND conditions', async () => {
      await columnarRepo.insert({ title: 'Draft Low', content: 'x', status: 'draft', views: 5, published: false });
      await columnarRepo.insert({ title: 'Published Low', content: 'x', status: 'published', views: 5, published: true });
      await columnarRepo.insert({ title: 'Published High', content: 'x', status: 'published', views: 100, published: true });

      const publishedHighViews = await columnarRepo.find({
        where: q.and(
          f.status.eq('published'),
          f.views.gte(50),
        ),
      });

      assert.strictEqual(publishedHighViews.length, 1);
      assert.strictEqual(publishedHighViews[0].title, 'Published High');
    });

    test('should find with OR conditions', async () => {
      await columnarRepo.insert({ title: 'Draft', content: 'x', status: 'draft', views: 0, published: false });
      await columnarRepo.insert({ title: 'Published', content: 'x', status: 'published', views: 0, published: true });
      await columnarRepo.insert({ title: 'Archived', content: 'x', status: 'archived', views: 0, published: false });

      const draftOrArchived = await columnarRepo.find({
        where: q.or(
          f.status.eq('draft'),
          f.status.eq('archived'),
        ),
      });

      assert.strictEqual(draftOrArchived.length, 2);
    });

    test('should find with IN list', async () => {
      await columnarRepo.insert({ title: 'Draft', content: 'x', status: 'draft', views: 0, published: false });
      await columnarRepo.insert({ title: 'Published', content: 'x', status: 'published', views: 0, published: true });
      await columnarRepo.insert({ title: 'Archived', content: 'x', status: 'archived', views: 0, published: false });

      const notPublished = await columnarRepo.find({
        where: f.status.in(['draft', 'archived']),
      });

      assert.strictEqual(notPublished.length, 2);
    });

    test('should find with BETWEEN', async () => {
      await columnarRepo.insert({ title: 'A', content: 'x', status: 'published', views: 10, published: true });
      await columnarRepo.insert({ title: 'B', content: 'x', status: 'published', views: 50, published: true });
      await columnarRepo.insert({ title: 'C', content: 'x', status: 'published', views: 100, published: true });

      const midRange = await columnarRepo.find({
        where: f.views.between(20, 80),
      });

      assert.strictEqual(midRange.length, 1);
      assert.strictEqual(midRange[0].title, 'B');
    });

    test('should find with IS NULL', async () => {
      await columnarRepo.insert({ title: 'With Rating', content: 'x', status: 'published', views: 0, published: true, rating: '4.50' });
      await columnarRepo.insert({ title: 'No Rating', content: 'x', status: 'published', views: 0, published: true });

      const noRating = await columnarRepo.find({
        where: f.rating.isNull(),
      });

      assert.strictEqual(noRating.length, 1);
      assert.strictEqual(noRating[0].title, 'No Rating');
    });

    test('should order by single field using field expressions', async () => {
      await columnarRepo.insert({ title: 'B', content: 'x', status: 'published', views: 20, published: true });
      await columnarRepo.insert({ title: 'A', content: 'x', status: 'published', views: 10, published: true });
      await columnarRepo.insert({ title: 'C', content: 'x', status: 'published', views: 30, published: true });

      const ascending = await columnarRepo.find({
        orderBy: [f.title.asc()],
      });

      assert.strictEqual(ascending[0].title, 'A');
      assert.strictEqual(ascending[1].title, 'B');
      assert.strictEqual(ascending[2].title, 'C');

      const descending = await columnarRepo.find({
        orderBy: [f.views.desc()],
      });

      assert.strictEqual(descending[0].views, 30);
      assert.strictEqual(descending[2].views, 10);
    });

    test('should order by multiple fields', async () => {
      await columnarRepo.insert({ title: 'A', content: 'x', status: 'published', views: 10, published: true });
      await columnarRepo.insert({ title: 'A', content: 'x', status: 'draft', views: 20, published: false });
      await columnarRepo.insert({ title: 'B', content: 'x', status: 'published', views: 5, published: true });

      const result = await columnarRepo.find({
        orderBy: [f.title.asc(), f.views.desc()],
      });

      assert.strictEqual(result[0].title, 'A');
      assert.strictEqual(result[0].views, 20); // A with higher views first
      assert.strictEqual(result[1].title, 'A');
      assert.strictEqual(result[1].views, 10);
      assert.strictEqual(result[2].title, 'B');
    });

    test('should order with NULLS FIRST/LAST', async () => {
      await columnarRepo.insert({ title: 'With Rating', content: 'x', status: 'published', views: 0, published: true, rating: '4.50' });
      await columnarRepo.insert({ title: 'No Rating 1', content: 'x', status: 'published', views: 0, published: true });
      await columnarRepo.insert({ title: 'No Rating 2', content: 'x', status: 'published', views: 0, published: true });

      // NULLS FIRST - null ratings should come first
      const nullsFirst = await columnarRepo.find({
        orderBy: [f.rating.asc('first')],
      });
      assert.strictEqual(nullsFirst[0].rating, undefined);

      // NULLS LAST - null ratings should come last
      const nullsLast = await columnarRepo.find({
        orderBy: [f.rating.asc('last')],
      });
      assert.strictEqual(nullsLast[0].rating, '4.50');
    });

    test('should limit and offset results', async () => {
      for (let i = 1; i <= 10; i++) {
        await columnarRepo.insert({ title: `Post ${i}`, content: 'x', status: 'published', views: i, published: true });
      }

      const page1 = await columnarRepo.find({
        orderBy: [f.views.asc()],
        limit: 3,
      });

      assert.strictEqual(page1.length, 3);
      assert.strictEqual(page1[0].views, 1);

      const page2 = await columnarRepo.find({
        orderBy: [f.views.asc()],
        limit: 3,
        offset: 3,
      });

      assert.strictEqual(page2.length, 3);
      assert.strictEqual(page2[0].views, 4);
    });

    test('should count with condition', async () => {
      await columnarRepo.insert({ title: 'A', content: 'x', status: 'published', views: 0, published: true });
      await columnarRepo.insert({ title: 'B', content: 'x', status: 'published', views: 0, published: true });
      await columnarRepo.insert({ title: 'C', content: 'x', status: 'draft', views: 0, published: false });

      const totalCount = await columnarRepo.count();
      assert.strictEqual(totalCount, 3);

      const publishedCount = await columnarRepo.count(f.status.eq('published'));
      assert.strictEqual(publishedCount, 2);
    });

    test('should update entity', async () => {
      const post = await columnarRepo.insert({
        title: 'Original',
        content: 'x',
        status: 'draft',
        views: 0,
        published: false,
      });

      const locked = await columnarRepo.lock(post);
      assert.ok(locked);
      const updated = await columnarRepo.update(locked!, { title: 'Updated', status: 'published' });

      assert.strictEqual(updated.title, 'Updated');
      assert.strictEqual(updated.status, 'published');
      assert.strictEqual(versionOf(updated), 2);
    });

    test('should allow empty partial updates in columnar mode', async () => {
      const post = await columnarRepo.insert({
        title: 'Original',
        content: 'x',
        status: 'draft',
        views: 0,
        published: false,
      });

      const beforeUpdatedAt = (post as any)[PG_UPDATED_AT];
      const updated = await columnarRepo.update(post, {});

      assert.strictEqual(updated.title, 'Original');
      assert.strictEqual(updated.status, 'draft');
      assert.strictEqual(versionOf(updated), 2);
      assert.ok((updated as any)[PG_CREATED_AT] instanceof Date);
      assert.ok((updated as any)[PG_UPDATED_AT] instanceof Date);
      assert.ok((updated as any)[PG_UPDATED_AT].getTime() >= beforeUpdatedAt.getTime());
    });

    test('should delete entity', async () => {
      const post = await columnarRepo.insert({
        title: 'To Delete',
        content: 'x',
        status: 'draft',
        views: 0,
        published: false,
      });

      const locked = await columnarRepo.lock(post);
      assert.ok(locked);
      const deleted = await columnarRepo.delete(locked!);
      assert.strictEqual(deleted, true);

      const found = await columnarRepo.get(Post.ref`${keyOf(post)}`);
      assert.strictEqual(found, undefined);
    });

    test('should delete with condition', async () => {
      await columnarRepo.insert({ title: 'A', content: 'x', status: 'archived', views: 0, published: false });
      await columnarRepo.insert({ title: 'B', content: 'x', status: 'archived', views: 0, published: false });
      await columnarRepo.insert({ title: 'C', content: 'x', status: 'published', views: 0, published: true });

      const deleted = await columnarRepo.deleteWhere(f.status.eq('archived'));
      assert.strictEqual(deleted, 2);

      const remaining = await columnarRepo.count();
      assert.strictEqual(remaining, 1);
    });

    test('should aggregate SUM', async () => {
      await columnarRepo.insert({ title: 'A', content: 'x', status: 'published', views: 10, published: true });
      await columnarRepo.insert({ title: 'B', content: 'x', status: 'published', views: 20, published: true });
      await columnarRepo.insert({ title: 'C', content: 'x', status: 'draft', views: 5, published: false });

      const totalViews = await columnarRepo.aggregate(q.sum(f.views));
      assert.strictEqual(totalViews, 35);

      const publishedViews = await columnarRepo.aggregate(
        q.sum(f.views),
        f.status.eq('published'),
      );
      assert.strictEqual(publishedViews, 30);
    });

    test('should handle complex nested conditions', async () => {
      await columnarRepo.insert({ title: 'TS Guide', content: 'x', status: 'published', views: 100, published: true });
      await columnarRepo.insert({ title: 'JS Guide', content: 'x', status: 'published', views: 50, published: true });
      await columnarRepo.insert({ title: 'Python Guide', content: 'x', status: 'published', views: 200, published: true });
      await columnarRepo.insert({ title: 'Draft TS', content: 'x', status: 'draft', views: 0, published: false });

      // Find published posts that either contain "TS" or have > 150 views
      const results = await columnarRepo.find({
        where: q.and(
          f.status.eq('published'),
          q.or(
            f.title.contains('TS'),
            f.views.gt(150),
          ),
        ),
      });

      assert.strictEqual(results.length, 2);
      const titles = results.map((r: any) => r.title);
      assert.ok(titles.includes('TS Guide'));
      assert.ok(titles.includes('Python Guide'));
    });
  });

  // ===========================================================================
  // JSONB Mode Tests
  // ===========================================================================

  describe('JSONB Mode', () => {
    test('should insert and find by id', async () => {
      const post = await jsonbRepo.insert({
        title: 'JSONB Post',
        content: 'Stored in JSONB',
        status: 'published',
        views: 42,
        published: true,
      });

      assert.ok(keyOf(post));
      assert.strictEqual(post.title, 'JSONB Post');

      const found = await jsonbRepo.get(Post.ref`${keyOf(post)}`);
      assert.ok(found);
      assert.strictEqual(found.title, 'JSONB Post');
      assert.strictEqual(found.views, 42);
    });

    test('should find with JSONB path conditions', async () => {
      await jsonbRepo.insert({ title: 'Draft', content: 'x', status: 'draft', views: 0, published: false });
      await jsonbRepo.insert({ title: 'Published', content: 'x', status: 'published', views: 10, published: true });

      const published = await jsonbRepo.find({
        where: f.status.eq('published'),
      });

      assert.strictEqual(published.length, 1);
      assert.strictEqual(published[0].title, 'Published');
    });

    test('should count with JSONB conditions', async () => {
      await jsonbRepo.insert({ title: 'A', content: 'x', status: 'published', views: 0, published: true });
      await jsonbRepo.insert({ title: 'B', content: 'x', status: 'published', views: 0, published: true });
      await jsonbRepo.insert({ title: 'C', content: 'x', status: 'draft', views: 0, published: false });

      const publishedCount = await jsonbRepo.count(f.status.eq('published'));
      assert.strictEqual(publishedCount, 2);
    });

    test('should update JSONB data', async () => {
      const post = await jsonbRepo.insert({
        title: 'Original',
        content: 'x',
        status: 'draft',
        views: 0,
        published: false,
      });

      const locked = await jsonbRepo.lock(post);
      assert.ok(locked);
      const updated = await jsonbRepo.update(locked!, { title: 'Updated', views: 100 });

      assert.strictEqual(updated.title, 'Updated');
      assert.strictEqual(updated.views, 100);
      // Original fields should be preserved
      assert.strictEqual(updated.status, 'draft');
    });

    test('should allow empty partial updates in JSONB mode', async () => {
      const post = await jsonbRepo.insert({
        title: 'Original',
        content: 'x',
        status: 'draft',
        views: 0,
        published: false,
      });

      const updated = await jsonbRepo.update(post, {});

      assert.strictEqual(updated.title, 'Original');
      assert.strictEqual(updated.status, 'draft');
      assert.strictEqual(versionOf(updated), 2);
    });
  });

  // ===========================================================================
  // Lock-Based Concurrency Tests
  // ===========================================================================

  describe('Lock-Based Concurrency', () => {
    test('should update via lock and increment version', async () => {
      const post = await columnarRepo.insert({
        title: 'Versioned',
        content: 'x',
        status: 'draft',
        views: 0,
        published: false,
      });

      // Lock, then update — `await using` releases the lock at block exit.
      // Post lock-as-mutex epic (PR #110, Phases 0-7), locks are persistent
      // until disposed; trying to re-lock the same row without disposing the
      // first lock deadlocks against the mutex.
      let updated: Awaited<ReturnType<typeof columnarRepo.update>>;
      {
        await using locked = await columnarRepo.lock(post);
        assert.ok(locked);
        updated = await columnarRepo.update(locked!, { title: 'Update 1' });
        assert.strictEqual(updated.title, 'Update 1');
        assert.strictEqual(versionOf(updated), 2);
      }

      // Lock again, update again — now safe because the first lock was released.
      {
        await using locked2 = await columnarRepo.lock(updated);
        assert.ok(locked2);
        const updated2 = await columnarRepo.update(locked2!, { title: 'Update 2' });
        assert.strictEqual(updated2.title, 'Update 2');
        assert.strictEqual(versionOf(updated2), 3);
      }
    });

    test('should delete via lock', async () => {
      const post = await columnarRepo.insert({
        title: 'To Delete',
        content: 'x',
        status: 'draft',
        views: 0,
        published: false,
      });

      // Lock, then delete
      const locked = await columnarRepo.lock(post);
      assert.ok(locked);
      const deleted = await columnarRepo.delete(locked!);
      assert.strictEqual(deleted, true);

      const found = await columnarRepo.get(Post.ref`${keyOf(post)}`);
      assert.strictEqual(found, undefined);
    });
  });
});
