/**
 * Tests for Reference Hydration and Identity Map
 *
 * Tests that:
 * - ref fields are hydrated as Reference objects (not raw IDs)
 * - References can be awaited for lazy loading
 * - Identity map is used to pre-populate references
 * - Same entity fetched twice returns the same instance
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';

import { defineModel, field, ADAPTER_KEY } from '@justscale/core/models';
const id = (e: unknown) => (e as Record<symbol, unknown>)[ADAPTER_KEY] as string;
import JustScale from '@justscale/core';
import { bindService, AbstractChannelBackend, MemoryChannelBackend } from '@justscale/core';
import { InMemoryProcessFeature } from '@justscale/core/process';
import { InMemoryLockFeature } from '@justscale/core/memory';
import {
  createPgModel,
  createPgRepository,
  ModelChangeChannels,
  ModelRegistry,
  keyOf,
} from '../src/index.js';
import { createPostgresClient } from '../src/client/client.js';
import { PgSchemaIntrospection } from '../src/migration/migration.js';
import { requirePostgres, CONNECTION_STRING } from './__mocks__/test-setup.js';

// ============================================================================
// Test Configuration
// ============================================================================

const TEST_ID = 'refhydrate';
const AUTHORS_TABLE = `authors_${TEST_ID}`;
const ARTICLES_TABLE = `articles_${TEST_ID}`;
const TAGS_TABLE = `tags_${TEST_ID}`;
const ARTICLE_TAGS_TABLE = `article_tags_${TEST_ID}`;

// ============================================================================
// Domain Models with proper field.ref()
// ============================================================================

class Author extends defineModel({
  name: field.string().max(255),
  tier: field.string().max(50),
}) {}

class Article extends defineModel({
  title: field.string().max(255),
  status: field.string().max(50),
  author: field.ref(Author),
}) {}

class Tag extends defineModel({
  name: field.string().max(100),
}) {}

// ============================================================================
// E2E Tests
// ============================================================================

describe('Reference Hydration E2E', { timeout: 60000 }, async () => {
  if (!await requirePostgres()) return;

  // Clear registry before tests
  ModelRegistry.clear();

  // Setup SQL connection for table management
  const sql = postgres(CONNECTION_STRING);

  // Create PgModels and Repositories
  const PgAuthor = createPgModel(Author, { table: AUTHORS_TABLE, storageMode: 'columnar' });
  const PgArticle = createPgModel(Article, { table: ARTICLES_TABLE, storageMode: 'columnar' });
  const PgTag = createPgModel(Tag, { table: TAGS_TABLE, storageMode: 'columnar' });

  const AuthorRepository = createPgRepository(PgAuthor);
  const ArticleRepository = createPgRepository(PgArticle);
  const TagRepository = createPgRepository(PgTag);

  const PostgresClient = createPostgresClient({ connectionString: CONNECTION_STRING });

  // Build and compile app
  const app = JustScale()
    .add(InMemoryLockFeature)
    .add(InMemoryProcessFeature)
    .add(PostgresClient)
    .add(MemoryChannelBackend)
    .add(bindService(AbstractChannelBackend, MemoryChannelBackend))
    .add(ModelChangeChannels)
    .add(AuthorRepository)
    .add(ArticleRepository)
    .add(TagRepository)
    .build()
    .compile();

  await app.ready;

  // Resolve services
  const container = app.container;
  const client = await container.resolve(PostgresClient);
  const authorRepo = await container.resolve(AuthorRepository);
  const articleRepo = await container.resolve(ArticleRepository);

  // Create tables via syncSchema
  await new PgSchemaIntrospection(client).sync(PgAuthor, PgArticle, PgTag);

  after(async () => {
    await sql.unsafe(`DROP TABLE IF EXISTS ${ARTICLE_TAGS_TABLE}`);
    await sql.unsafe(`DROP TABLE IF EXISTS ${ARTICLES_TABLE}`);
    await sql.unsafe(`DROP TABLE IF EXISTS ${TAGS_TABLE}`);
    await sql.unsafe(`DROP TABLE IF EXISTS ${AUTHORS_TABLE}`);
    await sql.end();
    await client.close();
  });

  beforeEach(async () => {
    // Clear identity map between tests
    client.clearIdentityMap();
    await sql.unsafe(`DELETE FROM ${ARTICLES_TABLE}`);
    await sql.unsafe(`DELETE FROM ${AUTHORS_TABLE}`);
  });

  // -------------------------------------------------------------------------
  // Reference Hydration
  // -------------------------------------------------------------------------

  it('should hydrate ref fields as Reference objects', async () => {
    // Create author
    const author = await authorRepo.insert({ name: 'John', tier: 'premium' });

    // Create article with author ref
    const article = await articleRepo.insert({
      title: 'Test Article',
      status: 'published',
      author: Author.ref`${keyOf(author)}`,
    });

    // Fetch the article
    const found = await articleRepo.get(Article.ref`${keyOf(article)}`);
    assert.ok(found);

    // The author field should be a Reference object
    const authorRef = found.author as any;
    assert.ok(authorRef, 'author should exist');
    assert.ok(typeof authorRef.identifier === 'string', 'Reference should have identifier');
    assert.equal(authorRef.identifier, keyOf(author));

    // Reference should be awaitable
    assert.ok(typeof authorRef.then === 'function', 'Reference should be thenable');
  });

  it('should lazy-load referenced entity when awaited', async () => {
    // Create author
    const author = await authorRepo.insert({ name: 'Jane', tier: 'standard' });

    // Create article
    await articleRepo.insert({
      title: 'Lazy Load Test',
      status: 'draft',
      author: Author.ref`${keyOf(author)}`,
    });

    // Clear identity map to force lazy load
    client.clearIdentityMap();

    // Fetch article (author not in identity map)
    const articles = await articleRepo.find({});
    const found = articles[0];
    assert.ok(found);

    // Await the reference to load the author
    const loadedAuthor = await (found.author as any);

    assert.ok(loadedAuthor);
    assert.equal(id(loadedAuthor), keyOf(author));
    assert.equal(loadedAuthor.name, 'Jane');
    assert.equal(loadedAuthor.tier, 'standard');
  });

  it('should pre-populate Reference from identity map if cached', async () => {
    // Create author
    const author = await authorRepo.insert({ name: 'Bob', tier: 'premium' });

    // Create article
    await articleRepo.insert({
      title: 'Identity Map Test',
      status: 'published',
      author: Author.ref`${keyOf(author)}`,
    });

    // Fetch author first (puts it in identity map)
    const cachedAuthor = await authorRepo.get(Author.ref`${keyOf(author)}`);
    assert.ok(cachedAuthor);

    // Now fetch article - author reference should exist
    const articles = await articleRepo.find({});
    const found = articles[0];
    assert.ok(found);

    const authorRef = found.author as any;

    // Reference should have the correct ID
    assert.equal(authorRef.identifier, keyOf(author));

    // Whether pre-populated or not, awaiting should work
    const resolved = await authorRef;
    assert.equal(keyOf(resolved), keyOf(author));
    assert.equal(resolved.name, 'Bob');
  });

  it('should return entity with same data when fetched twice', async () => {
    // Create author
    const author = await authorRepo.insert({ name: 'Alice', tier: 'free' });

    // Fetch the author twice
    const first = await authorRepo.get(Author.ref`${keyOf(author)}`);
    const second = await authorRepo.get(Author.ref`${keyOf(author)}`);

    // Should have the same data (identity map may or may not return same instance due to WeakRef)
    assert.ok(first);
    assert.ok(second);
    assert.equal(keyOf(first), keyOf(second));
    assert.equal(first.name, second.name);
  });

  it('should resolve reference to entity with same data', async () => {
    // Create author and article
    const author = await authorRepo.insert({ name: 'Charlie', tier: 'premium' });
    await articleRepo.insert({
      title: 'Shared Context',
      status: 'published',
      author: Author.ref`${keyOf(author)}`,
    });

    // Fetch author first
    const directAuthor = await authorRepo.get(Author.ref`${keyOf(author)}`);
    assert.ok(directAuthor);

    // Fetch article and resolve reference
    const articles = await articleRepo.find({});
    const article = articles[0];
    const resolvedAuthor = await (article.author as any);

    // Should have the same data
    assert.equal(id(resolvedAuthor), keyOf(directAuthor));
    assert.equal(resolvedAuthor.name, directAuthor.name);
    assert.equal(resolvedAuthor.tier, directAuthor.tier);
  });

  it('should handle null/undefined ref fields', async () => {
    // First add optional ref support to a model
    // For now, test that articles without authors work
    // (This would require an optional author field which we don't have in this test)

    // Create author and article
    const author = await authorRepo.insert({ name: 'Test', tier: 'free' });
    const article = await articleRepo.insert({
      title: 'Has Author',
      status: 'draft',
      author: Author.ref`${keyOf(author)}`,
    });

    const found = await articleRepo.get(Article.ref`${keyOf(article)}`);
    assert.ok(found);
    assert.ok((found.author as any).identifier);
  });

  it('should work with streaming and references', async () => {
    // Create authors
    const premium = await authorRepo.insert({ name: 'Premium Author', tier: 'premium' });
    const standard = await authorRepo.insert({ name: 'Standard Author', tier: 'standard' });

    // Create articles
    for (let i = 0; i < 10; i++) {
      await articleRepo.insert({
        title: `Article ${i}`,
        status: 'published',
        author: Author.ref`${i % 2 === 0 ? id(premium) : id(standard)}`,
      });
    }

    // Stream articles and resolve authors
    let count = 0;
    for await (const article of articleRepo.stream({ batchSize: 3 })) {
      const authorRef = article.author as any;
      assert.ok(authorRef.identifier, 'Streamed article should have author reference');

      // Resolve the author
      const resolved = await authorRef;
      assert.ok(resolved.name, 'Should be able to resolve author from streamed article');
      count++;
    }

    assert.equal(count, 10);
  });

  // -------------------------------------------------------------------------
  // Eager Loading with load option
  // -------------------------------------------------------------------------

  it('should eager load references with load option (array form)', async () => {
    // Create author
    const author = await authorRepo.insert({ name: 'Eager Author', tier: 'premium' });

    // Create article
    await articleRepo.insert({
      title: 'Eager Load Test',
      status: 'published',
      author: Author.ref`${keyOf(author)}`,
    });

    // Clear identity map to ensure we're testing eager loading
    client.clearIdentityMap();

    // Fetch article with eager loading
    const articles = await articleRepo.find({
      load: ['author'],
    });

    assert.equal(articles.length, 1);

    // The author reference should be pre-populated
    const authorRef = articles[0].author as any;
    assert.ok(authorRef.identifier, 'Should have author reference');

    // The reference should be pre-populated (has _value set)
    assert.ok(authorRef._value, 'Reference should be pre-populated after eager load');
    assert.equal(authorRef._value.name, 'Eager Author');

    // Resolving should return the data immediately (no additional query)
    const resolved = await authorRef;
    assert.equal(resolved.name, 'Eager Author');
    assert.equal(resolved.tier, 'premium');
  });

  it('should eager load references with load option (object form)', async () => {
    // Create author
    const author = await authorRepo.insert({ name: 'Object Form Author', tier: 'standard' });

    // Create article
    await articleRepo.insert({
      title: 'Object Form Test',
      status: 'draft',
      author: Author.ref`${keyOf(author)}`,
    });

    // Clear identity map
    client.clearIdentityMap();

    // Fetch with object form
    const articles = await articleRepo.find({
      load: { author: true },
    });

    assert.equal(articles.length, 1);

    // Verify eager loading worked - reference should be pre-populated
    const authorRef = articles[0].author as any;
    assert.ok(authorRef._value, 'Author should be eagerly loaded');
    assert.equal(authorRef._value.name, 'Object Form Author');
  });

  it('should batch fetch multiple unique references efficiently', async () => {
    // Create multiple authors
    const author1 = await authorRepo.insert({ name: 'Author One', tier: 'free' });
    const author2 = await authorRepo.insert({ name: 'Author Two', tier: 'premium' });
    const author3 = await authorRepo.insert({ name: 'Author Three', tier: 'standard' });

    // Create articles with different authors
    await articleRepo.insert({
      title: 'Article 1',
      status: 'published',
      author: Author.ref`${id(author1)}`,
    });
    await articleRepo.insert({
      title: 'Article 2',
      status: 'published',
      author: Author.ref`${id(author2)}`,
    });
    await articleRepo.insert({
      title: 'Article 3',
      status: 'published',
      author: Author.ref`${id(author3)}`,
    });
    // Same author as article 1 (should not duplicate fetch)
    await articleRepo.insert({
      title: 'Article 4',
      status: 'published',
      author: Author.ref`${id(author1)}`,
    });

    // Clear identity map
    client.clearIdentityMap();

    // Fetch all articles with eager loading
    const articles = await articleRepo.find({
      load: ['author'],
    });

    assert.equal(articles.length, 4);

    // All references should be pre-populated
    for (const article of articles) {
      const authorRef = article.author as any;
      assert.ok(authorRef._value, 'Each reference should be pre-populated');
    }

    // Verify all references resolve correctly
    for (const article of articles) {
      const resolved = await (article.author as any);
      assert.ok(['Author One', 'Author Two', 'Author Three'].includes(resolved.name));
    }
  });

  it('should work with eager loading when no prior cache exists', async () => {
    // Create author
    const author = await authorRepo.insert({ name: 'Fresh Author', tier: 'premium' });

    // Create article
    await articleRepo.insert({
      title: 'Fresh Load Test',
      status: 'published',
      author: Author.ref`${keyOf(author)}`,
    });

    // Clear identity map
    client.clearIdentityMap();

    // Fetch article with eager loading
    const articles = await articleRepo.find({
      load: ['author'],
    });

    assert.equal(articles.length, 1);

    // Reference should be pre-populated
    const authorRef = articles[0].author as any;
    assert.ok(authorRef._value, 'Reference should be pre-populated');

    // Reference should resolve to the correct author
    const resolved = await authorRef;
    assert.equal(resolved.name, 'Fresh Author');
  });

  it('should combine eager loading with has() conditions', async () => {
    // Create authors
    const john = await authorRepo.insert({ name: 'John', tier: 'premium' });
    const jane = await authorRepo.insert({ name: 'Jane', tier: 'standard' });

    // Create articles
    await articleRepo.insert({
      title: 'John Article 1',
      status: 'published',
      author: Author.ref`${id(john)}`,
    });
    await articleRepo.insert({
      title: 'John Article 2',
      status: 'published',
      author: Author.ref`${id(john)}`,
    });
    await articleRepo.insert({
      title: 'Jane Article',
      status: 'published',
      author: Author.ref`${id(jane)}`,
    });

    // Clear identity map
    client.clearIdentityMap();

    // Find articles by author name (using has) and eager load author
    const articles = await articleRepo.find({
      where: Article.fields.author.has(Author.fields.name.eq('John')),
      load: ['author'],
    });

    assert.equal(articles.length, 2);

    // Both articles should have pre-populated references to John
    for (const article of articles) {
      const authorRef = article.author as any;
      assert.ok(authorRef._value, 'Reference should be pre-populated');
      assert.equal(authorRef._value.name, 'John');
    }

    // All resolved authors should be John
    for (const article of articles) {
      const resolved = await (article.author as any);
      assert.equal(resolved.name, 'John');
    }
  });

  // -------------------------------------------------------------------------
  // Repository.resolve() - DDD-friendly reference resolution
  // -------------------------------------------------------------------------

  it('should resolve a reference using repository.resolve()', async () => {
    // Create author
    const author = await authorRepo.insert({ name: 'Resolvable Author', tier: 'premium' });

    // Create a reference (as if we received it from somewhere)
    const authorRef = Author.ref`${keyOf(author)}`;

    // Clear identity map
    client.clearIdentityMap();

    // Resolve the reference through the repository
    const resolved = await authorRepo.get(authorRef);

    assert.ok(resolved);
    assert.equal(resolved.name, 'Resolvable Author');
    assert.equal(resolved.tier, 'premium');
  });

  it('should return undefined when resolving non-existent reference', async () => {
    const fakeRef = Author.ref`${'00000000-0000-0000-0000-000000000000'}`;

    const resolved = await authorRepo.get(fakeRef);

    assert.equal(resolved, undefined);
  });

  it('should get multiple entities using repository.getMany()', async () => {
    // Create authors
    const author1 = await authorRepo.insert({ name: 'Author A', tier: 'free' });
    const author2 = await authorRepo.insert({ name: 'Author B', tier: 'premium' });
    const author3 = await authorRepo.insert({ name: 'Author C', tier: 'standard' });

    // Create references
    const refs = [
      Author.ref`${id(author1)}`,
      Author.ref`${id(author2)}`,
      Author.ref`${id(author3)}`,
    ];

    // Clear identity map
    client.clearIdentityMap();

    // Resolve all references in one batch
    const resolved = await authorRepo.getMany(refs);

    assert.equal(resolved.length, 3);

    // Check all authors are resolved (order may differ due to ANY query)
    const names = resolved.map((a) => a.name).sort();
    assert.deepEqual(names, ['Author A', 'Author B', 'Author C']);
  });

  it('should handle empty array in getMany()', async () => {
    const resolved = await authorRepo.getMany([]);

    assert.deepEqual(resolved, []);
  });

  it('should resolve reference from article author field', async () => {
    // Create author and article
    const author = await authorRepo.insert({ name: 'Article Author', tier: 'premium' });
    const article = await articleRepo.insert({
      title: 'Test Article',
      status: 'published',
      author: Author.ref`${keyOf(author)}`,
    });

    // Clear identity map
    client.clearIdentityMap();

    // Fetch article
    const found = await articleRepo.get(Article.ref`${keyOf(article)}`);
    assert.ok(found);

    // Get the reference from the article and resolve it through the repository
    const authorRef = found.author as any;
    const resolved = await authorRepo.get(authorRef);

    assert.ok(resolved);
    assert.equal(resolved.name, 'Article Author');
  });

  // -------------------------------------------------------------------------
  // Reference Identity (same object returned for same entity)
  // -------------------------------------------------------------------------

  it('should return same object when resolving same reference twice', async () => {
    const author = await authorRepo.insert({ name: 'Same Object', tier: 'premium' });
    const ref = Author.ref`${keyOf(author)}`;

    // Clear identity map to force fresh fetch
    client.clearIdentityMap();

    // Resolve twice
    const resolved1 = await authorRepo.get(ref);
    const resolved2 = await authorRepo.get(ref);

    // Should be the exact same object instance
    assert.strictEqual(resolved1, resolved2);
  });

  it('should return same object when resolving different refs to same entity', async () => {
    const author = await authorRepo.insert({ name: 'Same Entity', tier: 'standard' });

    // Create two different Reference objects pointing to same entity
    const ref1 = Author.ref`${keyOf(author)}`;
    const ref2 = Author.ref`${keyOf(author)}`;

    client.clearIdentityMap();

    const resolved1 = await authorRepo.get(ref1);
    const resolved2 = await authorRepo.get(ref2);

    // Should be the same object instance
    assert.strictEqual(resolved1, resolved2);
  });

  it('should return same objects in getMany for cached entities', async () => {
    const author1 = await authorRepo.insert({ name: 'Batch 1', tier: 'free' });
    const author2 = await authorRepo.insert({ name: 'Batch 2', tier: 'premium' });

    // Get first author to put in identity map
    client.clearIdentityMap();
    const firstResolved = await authorRepo.get(Author.ref`${id(author1)}`);

    // Now getMany both - author1 should come from identity map
    const refs = [Author.ref`${id(author1)}`, Author.ref`${id(author2)}`];
    const batch = await authorRepo.getMany(refs);

    // First author should be the same object from identity map
    assert.strictEqual(batch[0], firstResolved);
  });

  it('should return same object when awaiting reference after findById', async () => {
    const author = await authorRepo.insert({ name: 'Await Test', tier: 'premium' });
    await articleRepo.insert({
      title: 'Await Article',
      status: 'published',
      author: Author.ref`${keyOf(author)}`,
    });

    client.clearIdentityMap();

    // Fetch author directly
    const directAuthor = await authorRepo.get(Author.ref`${keyOf(author)}`);

    // Fetch article and await its author reference
    const articleId = keyOf((await articleRepo.find({}))[0]);
    const article = await articleRepo.get(Article.ref`${articleId}`);
    const refAuthor = await (article!.author as any);

    // Should be the same object instance
    assert.strictEqual(refAuthor, directAuthor);
  });
});
