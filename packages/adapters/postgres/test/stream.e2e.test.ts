/**
 * Tests for stream() and streamBatches() pagination
 *
 * Tests async generator-based pagination using keyset pagination.
 * Verifies that large result sets can be streamed efficiently without
 * loading everything into memory.
 *
 * Also tests streaming with has() conditions (JOIN support).
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';

import { defineModel, field, q, ADAPTER_KEY } from '@justscale/core/models';
const id = (e: unknown) => (e as Record<symbol, unknown>)[ADAPTER_KEY] as string;
import JustScale from '@justscale/core';
import { bindService, AbstractChannelBackend, MemoryChannelBackend } from '@justscale/core';
import { InMemoryProcessFeature } from '@justscale/core/process';
import { InMemoryLockFeature } from '@justscale/core/memory';
import {
  createPostgresClient,
  createPgModel,
  createPgRepository,
  ModelChangeChannels,
  ModelRegistry,
} from '../src/index.js';
import { PgSchemaIntrospection } from '../src/migration/migration.js';
import { requirePostgres, CONNECTION_STRING } from './__mocks__/test-setup.js';

// ============================================================================
// Test Configuration
// ============================================================================

const TEST_ID = 'stream';
const ITEMS_TABLE = `items_${TEST_ID}`;
const AUTHORS_TABLE = `authors_${TEST_ID}`;
const ARTICLES_TABLE = `articles_${TEST_ID}`;

// ============================================================================
// Domain Models
// ============================================================================

class Item extends defineModel({
  name: field.string().max(255),
  category: field.string().max(50),
  value: field.int(),
}) {}

// For has() join tests
class Author extends defineModel({
  name: field.string().max(255),
  tier: field.string().max(50), // 'premium', 'standard', 'free'
}) {}

class Article extends defineModel({
  title: field.string().max(255),
  status: field.string().max(50),
  author: field.ref(Author),
}) {}

// ============================================================================
// E2E Tests
// ============================================================================

describe('stream() and streamBatches() E2E', { timeout: 60000 }, async () => {
  if (!await requirePostgres()) return;

  // Clear registry before tests
  ModelRegistry.clear();

  // Setup SQL connection for table management
  const sql = postgres(CONNECTION_STRING);

  // Create PgModels and Repositories
  const PgItem = createPgModel(Item, { table: ITEMS_TABLE, storageMode: 'columnar' });
  const PgAuthor = createPgModel(Author, { table: AUTHORS_TABLE, storageMode: 'columnar' });
  const PgArticle = createPgModel(Article, { table: ARTICLES_TABLE, storageMode: 'columnar' });

  const ItemRepository = createPgRepository(PgItem);
  const AuthorRepository = createPgRepository(PgAuthor);
  const ArticleRepository = createPgRepository(PgArticle);

  const PostgresClient = createPostgresClient({ connectionString: CONNECTION_STRING });

  // Build and compile app
  const app = JustScale()
    .add(InMemoryLockFeature)
    .add(InMemoryProcessFeature)
    .add(PostgresClient)
    .add(MemoryChannelBackend)
    .add(bindService(AbstractChannelBackend, MemoryChannelBackend))
    .add(ModelChangeChannels)
    .add(ItemRepository)
    .add(AuthorRepository)
    .add(ArticleRepository)
    .build()
    .compile();

  await app.ready;

  // Resolve services
  const container = app.container;
  const client = await container.resolve(PostgresClient);
  const itemRepo = await container.resolve(ItemRepository);
  const authorRepo = await container.resolve(AuthorRepository);
  const articleRepo = await container.resolve(ArticleRepository);

  // Create test tables via syncSchema
  await new PgSchemaIntrospection(client).sync(PgItem, PgAuthor, PgArticle);

  after(async () => {
    await sql.unsafe(`DROP TABLE IF EXISTS ${ARTICLES_TABLE}`);
    await sql.unsafe(`DROP TABLE IF EXISTS ${AUTHORS_TABLE}`);
    await sql.unsafe(`DROP TABLE IF EXISTS ${ITEMS_TABLE}`);
    await sql.end();
    await client.close();
  });

  beforeEach(async () => {
    await sql.unsafe(`DELETE FROM ${ARTICLES_TABLE}`);
    await sql.unsafe(`DELETE FROM ${AUTHORS_TABLE}`);
    await sql.unsafe(`DELETE FROM ${ITEMS_TABLE}`);
  });

  // -------------------------------------------------------------------------
  // stream() Tests
  // -------------------------------------------------------------------------

  it('should stream all entities one at a time', async () => {
    // Insert test data
    for (let i = 0; i < 25; i++) {
      await itemRepo.insert({ name: `Item ${i}`, category: 'test', value: i });
    }

    const items: any[] = [];
    for await (const item of itemRepo.stream()) {
      items.push(item);
    }

    assert.equal(items.length, 25);
  });

  it('should stream with a WHERE condition', async () => {
    // Insert mixed data
    for (let i = 0; i < 20; i++) {
      await itemRepo.insert({
        name: `Item ${i}`,
        category: i % 2 === 0 ? 'even' : 'odd',
        value: i,
      });
    }

    const evenItems: any[] = [];
    for await (const item of itemRepo.stream({ where: Item.fields.category.eq('even') })) {
      evenItems.push(item);
    }

    assert.equal(evenItems.length, 10);
    assert.ok(evenItems.every((item: any) => item.category === 'even'));
  });

  it('should support early termination with break', async () => {
    // Insert test data
    for (let i = 0; i < 50; i++) {
      await itemRepo.insert({ name: `Item ${i}`, category: 'test', value: i });
    }

    const items: any[] = [];
    for await (const item of itemRepo.stream()) {
      items.push(item);
      if (items.length >= 10) {
        break; // Early termination
      }
    }

    assert.equal(items.length, 10);
  });

  it('should use custom batch size', async () => {
    // Insert test data
    for (let i = 0; i < 15; i++) {
      await itemRepo.insert({ name: `Item ${i}`, category: 'test', value: i });
    }

    const items: any[] = [];
    // Use small batch size to test pagination
    for await (const item of itemRepo.stream({ batchSize: 5 })) {
      items.push(item);
    }

    assert.equal(items.length, 15);
  });

  // -------------------------------------------------------------------------
  // streamBatches() Tests
  // -------------------------------------------------------------------------

  it('should stream batches of entities', async () => {
    // Insert test data
    for (let i = 0; i < 25; i++) {
      await itemRepo.insert({ name: `Item ${i}`, category: 'test', value: i });
    }

    const batches: any[][] = [];
    for await (const batch of itemRepo.streamBatches({ batchSize: 10 })) {
      batches.push(batch);
    }

    // Should have 3 batches: 10, 10, 5
    assert.equal(batches.length, 3);
    assert.equal(batches[0].length, 10);
    assert.equal(batches[1].length, 10);
    assert.equal(batches[2].length, 5);
  });

  it('should handle exact batch size boundaries', async () => {
    // Insert exactly 20 items
    for (let i = 0; i < 20; i++) {
      await itemRepo.insert({ name: `Item ${i}`, category: 'test', value: i });
    }

    const batches: any[][] = [];
    for await (const batch of itemRepo.streamBatches({ batchSize: 10 })) {
      batches.push(batch);
    }

    // Should have exactly 2 batches: 10, 10
    assert.equal(batches.length, 2);
    assert.equal(batches[0].length, 10);
    assert.equal(batches[1].length, 10);
  });

  it('should handle empty result set', async () => {
    const batches: any[][] = [];
    for await (const batch of itemRepo.streamBatches()) {
      batches.push(batch);
    }

    assert.equal(batches.length, 0);
  });

  it('should stream batches with WHERE condition', async () => {
    // Insert mixed data
    for (let i = 0; i < 30; i++) {
      await itemRepo.insert({
        name: `Item ${i}`,
        category: i % 3 === 0 ? 'special' : 'normal',
        value: i,
      });
    }

    const batches: any[][] = [];
    for await (const batch of itemRepo.streamBatches({
      where: Item.fields.category.eq('special'),
      batchSize: 5,
    })) {
      batches.push(batch);
    }

    // 10 special items (0, 3, 6, 9, 12, 15, 18, 21, 24, 27)
    const totalItems = batches.reduce((sum, b) => sum + b.length, 0);
    assert.equal(totalItems, 10);
  });

  // -------------------------------------------------------------------------
  // Keyset Pagination Behavior
  // -------------------------------------------------------------------------

  it('should not duplicate items when iterating (keyset pagination)', async () => {
    // Insert test data
    for (let i = 0; i < 50; i++) {
      await itemRepo.insert({ name: `Item ${i}`, category: 'test', value: i });
    }

    const seenIds = new Set<string>();
    for await (const item of itemRepo.stream({ batchSize: 7 })) {
      // Check no duplicates
      assert.ok(!seenIds.has(id(item)), `Duplicate item found: ${id(item)}`);
      seenIds.add(id(item));
    }

    assert.equal(seenIds.size, 50);
  });

  it('should maintain consistent order across batches', async () => {
    // Insert test data
    for (let i = 0; i < 30; i++) {
      await itemRepo.insert({ name: `Item ${i}`, category: 'test', value: i });
    }

    const ids: string[] = [];
    for await (const item of itemRepo.stream({ batchSize: 7 })) {
      ids.push(id(item));
    }

    // IDs should be in ascending order (keyset pagination uses ORDER BY id ASC)
    for (let i = 1; i < ids.length; i++) {
      assert.ok(ids[i] > ids[i - 1], `IDs should be in ascending order: ${ids[i - 1]} < ${ids[i]}`);
    }
  });

  // -------------------------------------------------------------------------
  // Streaming with has() (JOIN conditions)
  // -------------------------------------------------------------------------

  it('should stream with simple has() condition', async () => {
    // Create authors
    const premiumAuthor = await authorRepo.insert({ name: 'Premium Author', tier: 'premium' });
    const freeAuthor = await authorRepo.insert({ name: 'Free Author', tier: 'free' });

    // Create articles - 15 by premium, 10 by free
    for (let i = 0; i < 15; i++) {
      await articleRepo.insert({
        title: `Premium Article ${i}`,
        status: 'published',
        author: Author.ref`${id(premiumAuthor)}`,
      });
    }
    for (let i = 0; i < 10; i++) {
      await articleRepo.insert({
        title: `Free Article ${i}`,
        status: 'published',
        author: Author.ref`${id(freeAuthor)}`,
      });
    }

    // Stream articles by premium authors
    const premiumArticles: any[] = [];
    for await (const article of articleRepo.stream({
      where: Article.fields.author.has(Author.fields.tier.eq('premium')),
      batchSize: 5,
    })) {
      premiumArticles.push(article);
    }

    assert.equal(premiumArticles.length, 15);
    assert.ok(premiumArticles.every((a) => a.title.startsWith('Premium')));
  });

  it('should stream with nested has() conditions', async () => {
    // Create authors with different tiers
    const premium1 = await authorRepo.insert({ name: 'Premium 1', tier: 'premium' });
    const premium2 = await authorRepo.insert({ name: 'Premium 2', tier: 'premium' });
    const standard = await authorRepo.insert({ name: 'Standard', tier: 'standard' });

    // Create articles - mix of published and draft
    for (let i = 0; i < 10; i++) {
      await articleRepo.insert({
        title: `P1 Published ${i}`,
        status: 'published',
        author: Author.ref`${id(premium1)}`,
      });
    }
    for (let i = 0; i < 5; i++) {
      await articleRepo.insert({
        title: `P1 Draft ${i}`,
        status: 'draft',
        author: Author.ref`${id(premium1)}`,
      });
    }
    for (let i = 0; i < 8; i++) {
      await articleRepo.insert({
        title: `P2 Published ${i}`,
        status: 'published',
        author: Author.ref`${id(premium2)}`,
      });
    }
    for (let i = 0; i < 12; i++) {
      await articleRepo.insert({
        title: `Standard Published ${i}`,
        status: 'published',
        author: Author.ref`${id(standard)}`,
      });
    }

    // Stream published articles by premium authors
    const results: any[] = [];
    for await (const article of articleRepo.stream({
      where: q.and(
        Article.fields.status.eq('published'),
        Article.fields.author.has(Author.fields.tier.eq('premium'))
      ),
      batchSize: 7,
    })) {
      results.push(article);
    }

    // 10 from P1 + 8 from P2 = 18 published premium articles
    assert.equal(results.length, 18);
    assert.ok(results.every((a) => a.status === 'published'));
    assert.ok(results.every((a) => a.title.startsWith('P1') || a.title.startsWith('P2')));
  });

  it('should stream batches with has() conditions', async () => {
    // Create authors
    const premiumAuthor = await authorRepo.insert({ name: 'Premium', tier: 'premium' });
    const freeAuthor = await authorRepo.insert({ name: 'Free', tier: 'free' });

    // Create 25 premium articles
    for (let i = 0; i < 25; i++) {
      await articleRepo.insert({
        title: `Premium ${i}`,
        status: 'published',
        author: Author.ref`${id(premiumAuthor)}`,
      });
    }
    // Create 15 free articles
    for (let i = 0; i < 15; i++) {
      await articleRepo.insert({
        title: `Free ${i}`,
        status: 'published',
        author: Author.ref`${id(freeAuthor)}`,
      });
    }

    // Stream batches of premium articles
    const batches: any[][] = [];
    for await (const batch of articleRepo.streamBatches({
      where: Article.fields.author.has(Author.fields.tier.eq('premium')),
      batchSize: 10,
    })) {
      batches.push(batch);
    }

    // Should have 3 batches: 10, 10, 5
    assert.equal(batches.length, 3);
    assert.equal(batches[0].length, 10);
    assert.equal(batches[1].length, 10);
    assert.equal(batches[2].length, 5);

    // All should be premium
    for (const batch of batches) {
      assert.ok(batch.every((a) => a.title.startsWith('Premium')));
    }
  });

  it('should handle OR with has() in streaming', async () => {
    // Create authors
    const premium = await authorRepo.insert({ name: 'Premium', tier: 'premium' });
    const standard = await authorRepo.insert({ name: 'Standard', tier: 'standard' });
    const free = await authorRepo.insert({ name: 'Free', tier: 'free' });

    // Create articles
    for (let i = 0; i < 8; i++) {
      await articleRepo.insert({ title: `Premium ${i}`, status: 'published', author: Author.ref`${id(premium)}` });
    }
    for (let i = 0; i < 6; i++) {
      await articleRepo.insert({ title: `Standard ${i}`, status: 'published', author: Author.ref`${id(standard)}` });
    }
    for (let i = 0; i < 10; i++) {
      await articleRepo.insert({ title: `Free ${i}`, status: 'published', author: Author.ref`${id(free)}` });
    }

    // Stream articles by premium OR standard authors
    const results: any[] = [];
    for await (const article of articleRepo.stream({
      where: q.or(
        Article.fields.author.has(Author.fields.tier.eq('premium')),
        Article.fields.author.has(Author.fields.tier.eq('standard'))
      ),
      batchSize: 5,
    })) {
      results.push(article);
    }

    // 8 premium + 6 standard = 14
    assert.equal(results.length, 14);
    assert.ok(results.every((a) => a.title.startsWith('Premium') || a.title.startsWith('Standard')));
  });

  it('should stream with has() and early termination', async () => {
    // Create author
    const author = await authorRepo.insert({ name: 'Author', tier: 'premium' });

    // Create 50 articles
    for (let i = 0; i < 50; i++) {
      await articleRepo.insert({
        title: `Article ${i}`,
        status: 'published',
        author: Author.ref`${id(author)}`,
      });
    }

    // Stream with has() but break early
    const results: any[] = [];
    for await (const article of articleRepo.stream({
      where: Article.fields.author.has(Author.fields.tier.eq('premium')),
      batchSize: 10,
    })) {
      results.push(article);
      if (results.length >= 15) {
        break;
      }
    }

    assert.equal(results.length, 15);
  });
});
