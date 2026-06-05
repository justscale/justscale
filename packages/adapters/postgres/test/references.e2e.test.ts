/**
 * Reference and Relationship Tests
 *
 * Tests for field.ref() and field.refs() relationships between models.
 * Covers:
 * - Basic reference storage (ID persistence)
 * - Reference resolution via DataLoader
 * - N+1 prevention with batch loading
 * - Nested references
 * - Edge cases (null refs, missing entities)
 *
 * These tests require a running PostgreSQL instance.
 * Set DATABASE_URL environment variable to run.
 */

import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import JustScale from '@justscale/core';
import { defineService, bindService, AbstractChannelBackend, MemoryChannelBackend } from '@justscale/core';
import { InMemoryProcessFeature } from '@justscale/core/process';
import { InMemoryLockFeature } from '@justscale/core/memory';
import { defineModel, field, q } from '@justscale/core/models';
import {
  createPgModel,
  createPgRepository,
  ModelChangeChannels,
  keyOf,
  type AbstractPostgresClient,
  type Persistent,
  type Repository,
} from '../src/index.js';
import { createPostgresClient } from '../src/client/client.js';
import { ModelRegistry } from '../src/model/model-registry.js';
import { requirePostgres, CONNECTION_STRING } from './__mocks__/test-setup.js';

// =============================================================================
// Test Models - Blog System
// =============================================================================

// User model - the author of posts and comments
class User extends defineModel({
  email: field.string().max(255).unique(),
  name: field.string().max(100),
  bio: field.text().optional(),
}) {}

// Tag model - for categorizing posts
class Tag extends defineModel({
  name: field.string().max(50).unique(),
  slug: field.string().max(50),
}) {}

// Post model - has author (User) and tags (Tag[])
class Post extends defineModel({
  title: field.string().max(255),
  content: field.text(),
  published: field.boolean().default(false),
  authorId: field.string(), // Foreign key to User
  tagIds: field.array(field.string()).default([]), // Foreign keys to Tags
}) {}

// Comment model - has author (User) and belongs to post (Post)
class Comment extends defineModel({
  content: field.text(),
  authorId: field.string(), // Foreign key to User
  postId: field.string(), // Foreign key to Post
}) {}

// Category model - self-referencing (tree structure)
class Category extends defineModel({
  name: field.string().max(100),
  parentId: field.string().optional(), // Self-reference
}) {}

// =============================================================================
// PgModels
// =============================================================================

const PgUser = createPgModel(User, { table: 'ref_test_users' });
const PgTag = createPgModel(Tag, { table: 'ref_test_tags' });
const PgPost = createPgModel(Post, { table: 'ref_test_posts' });
const PgComment = createPgModel(Comment, { table: 'ref_test_comments' });
const PgCategory = createPgModel(Category, { table: 'ref_test_categories' });

// =============================================================================
// Repository Services
// =============================================================================

const UserRepository = createPgRepository(PgUser);
const TagRepository = createPgRepository(PgTag);
const PostRepository = createPgRepository(PgPost);
const CommentRepository = createPgRepository(PgComment);
const CategoryRepository = createPgRepository(PgCategory);

// =============================================================================
// PostgresClient Service
// =============================================================================

const PostgresClient = createPostgresClient({ connectionString: CONNECTION_STRING });

// =============================================================================
// Application Services (expose repos for DI resolution)
// =============================================================================

const UserService = defineService({
  inject: { users: UserRepository },
  factory: ({ users }) => users,
});

const TagService = defineService({
  inject: { tags: TagRepository },
  factory: ({ tags }) => tags,
});

const PostService = defineService({
  inject: { posts: PostRepository },
  factory: ({ posts }) => posts,
});

const CommentService = defineService({
  inject: { comments: CommentRepository },
  factory: ({ comments }) => comments,
});

const CategoryService = defineService({
  inject: { categories: CategoryRepository },
  factory: ({ categories }) => categories,
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
  .add(UserRepository)
  .add(TagRepository)
  .add(PostRepository)
  .add(CommentRepository)
  .add(CategoryRepository)
  .add(UserService)
  .add(TagService)
  .add(PostService)
  .add(CommentService)
  .add(CategoryService)
  .build();

// =============================================================================
// Tests
// =============================================================================

describe('Reference System E2E', async () => {
  if (!await requirePostgres()) return;

  let client: AbstractPostgresClient;
   
  let userRepo: any;
   
  let tagRepo: any;
   
  let postRepo: any;
   
  let commentRepo: any;
   
  let categoryRepo: any;

  before(async () => {
    // Clear model registry
    ModelRegistry.clear();

    // Compile and wait for ready
    const app = built.compile();
    await app.ready;

    // Resolve services via async container
    const container = app.container;
    client = await container.resolve(PostgresClient);
    userRepo = await container.resolve(UserService);
    tagRepo = await container.resolve(TagService);
    postRepo = await container.resolve(PostService);
    commentRepo = await container.resolve(CommentService);
    categoryRepo = await container.resolve(CategoryService);

    // Create tables
    await client.sql.unsafe(`
      DROP TABLE IF EXISTS ref_test_comments CASCADE;
      DROP TABLE IF EXISTS ref_test_posts CASCADE;
      DROP TABLE IF EXISTS ref_test_tags CASCADE;
      DROP TABLE IF EXISTS ref_test_users CASCADE;
      DROP TABLE IF EXISTS ref_test_categories CASCADE;

      CREATE TABLE ref_test_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        bio TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        version INTEGER DEFAULT 1
      );

      CREATE TABLE ref_test_tags (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(50) UNIQUE NOT NULL,
        slug VARCHAR(50) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        version INTEGER DEFAULT 1
      );

      CREATE TABLE ref_test_posts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        published BOOLEAN DEFAULT FALSE,
        author_id UUID NOT NULL REFERENCES ref_test_users(id),
        tag_ids UUID[] DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        version INTEGER DEFAULT 1
      );

      CREATE TABLE ref_test_comments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        content TEXT NOT NULL,
        author_id UUID NOT NULL REFERENCES ref_test_users(id),
        post_id UUID NOT NULL REFERENCES ref_test_posts(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        version INTEGER DEFAULT 1
      );

      CREATE TABLE ref_test_categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL,
        parent_id UUID REFERENCES ref_test_categories(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        version INTEGER DEFAULT 1
      );
    `);
  });

  after(async () => {
    await client.sql.unsafe(`
      DROP TABLE IF EXISTS ref_test_comments CASCADE;
      DROP TABLE IF EXISTS ref_test_posts CASCADE;
      DROP TABLE IF EXISTS ref_test_tags CASCADE;
      DROP TABLE IF EXISTS ref_test_users CASCADE;
      DROP TABLE IF EXISTS ref_test_categories CASCADE;
    `);
    await client.close();
  });

  beforeEach(async () => {
    // Clean data between tests
    await client.sql.unsafe(`
      DELETE FROM ref_test_comments;
      DELETE FROM ref_test_posts;
      DELETE FROM ref_test_tags;
      DELETE FROM ref_test_users;
      DELETE FROM ref_test_categories;
    `);
  });

  // ===========================================================================
  // Basic Reference Storage
  // ===========================================================================

  describe('Basic Reference Storage', () => {
    test('should store and retrieve foreign key ID', async () => {
      // Create a user
      const user = await userRepo.insert({
        email: 'author@example.com',
        name: 'Author',
        bio: null,
      });

      // Create a post with author reference
      const post = await postRepo.insert({
        title: 'My First Post',
        content: 'Hello World',
        published: true,
        authorId: keyOf(user),
        tagIds: [],
      });

      // Retrieve and verify
      const found = await postRepo.get(Post.ref`${keyOf(post)}`);
      assert.ok(found);
      assert.strictEqual(found.authorId, keyOf(user));
    });

    test('should store array of foreign key IDs', async () => {
      // Create tags
      const tag1 = await tagRepo.insert({ name: 'JavaScript', slug: 'javascript' });
      const tag2 = await tagRepo.insert({ name: 'TypeScript', slug: 'typescript' });
      const tag3 = await tagRepo.insert({ name: 'Node.js', slug: 'nodejs' });

      // Create a user
      const user = await userRepo.insert({
        email: 'author@example.com',
        name: 'Author',
        bio: null,
      });

      // Create post with multiple tags
      const post = await postRepo.insert({
        title: 'My Tagged Post',
        content: 'Content with tags',
        published: true,
        authorId: keyOf(user),
        tagIds: [keyOf(tag1), keyOf(tag2), keyOf(tag3)],
      });

      // Retrieve and verify
      const found = await postRepo.get(Post.ref`${keyOf(post)}`);
      assert.ok(found);
      assert.deepStrictEqual(found.tagIds, [keyOf(tag1), keyOf(tag2), keyOf(tag3)]);
    });

    test('should handle optional/null foreign key', async () => {
      // Create root category (no parent)
      const rootCategory = await categoryRepo.insert({
        name: 'Root Category',
        parentId: null,
      });

      // Create child category with parent
      const childCategory = await categoryRepo.insert({
        name: 'Child Category',
        parentId: keyOf(rootCategory),
      });

      // Verify
      const foundRoot = await categoryRepo.get(Category.ref`${keyOf(rootCategory)}`);
      const foundChild = await categoryRepo.get(Category.ref`${keyOf(childCategory)}`);

      assert.ok(foundRoot);
      assert.ok(foundChild);
      assert.strictEqual(foundRoot.parentId, undefined);
      assert.strictEqual(foundChild.parentId, keyOf(rootCategory));
    });
  });

  // ===========================================================================
  // DataLoader Reference Resolution
  // ===========================================================================

  describe('DataLoader Reference Resolution', () => {
    test('should resolve single reference via DataLoader', async () => {
      // Create user and post
      const user = await userRepo.insert({
        email: 'loader@example.com',
        name: 'Loader Test',
        bio: 'Testing DataLoader',
      });

      const post = await postRepo.insert({
        title: 'DataLoader Post',
        content: 'Testing reference resolution',
        published: true,
        authorId: keyOf(user),
        tagIds: [],
      });

      // Create DataLoader for users
      const userLoader = (userRepo as any).createLoader();

      // Resolve the author
      const author = await userLoader.load(post.authorId);

      assert.ok(author);
      assert.strictEqual(keyOf(author), keyOf(user));
      assert.strictEqual(author.name, 'Loader Test');
    });

    test('should batch multiple reference resolutions', async () => {
      // Create multiple users
      const user1 = await userRepo.insert({ email: 'user1@example.com', name: 'User 1', bio: null });
      const user2 = await userRepo.insert({ email: 'user2@example.com', name: 'User 2', bio: null });
      const user3 = await userRepo.insert({ email: 'user3@example.com', name: 'User 3', bio: null });

      // Create posts by different authors
      await postRepo.insert({ title: 'Post 1', content: 'C1', published: true, authorId: keyOf(user1), tagIds: [] });
      await postRepo.insert({ title: 'Post 2', content: 'C2', published: true, authorId: keyOf(user2), tagIds: [] });
      await postRepo.insert({ title: 'Post 3', content: 'C3', published: true, authorId: keyOf(user3), tagIds: [] });

      // Get all posts
      const posts = await postRepo.find({});

      // Create DataLoader and batch load all authors
      const userLoader = (userRepo as any).createLoader();

      // This should result in a single batched query
      const authors = await Promise.all(
        posts.map((post: any) => userLoader.load(post.authorId))
      );

      assert.strictEqual(authors.length, 3);
      assert.ok(authors.every((a) => a !== null && a !== undefined));

      // Verify each author
      const authorNames = authors.map((a) => a!.name).sort();
      assert.deepStrictEqual(authorNames, ['User 1', 'User 2', 'User 3']);
    });

    test('should cache resolved references', async () => {
      const user = await userRepo.insert({ email: 'cached@example.com', name: 'Cached User', bio: null });

      // Create two posts by the same author
      await postRepo.insert({ title: 'Post A', content: 'CA', published: true, authorId: keyOf(user), tagIds: [] });
      await postRepo.insert({ title: 'Post B', content: 'CB', published: true, authorId: keyOf(user), tagIds: [] });

      const posts = await postRepo.find({});
      const userLoader = (userRepo as any).createLoader();

      // Load author for first post
      const author1 = await userLoader.load(posts[0].authorId);

      // Load author for second post (same user - should be cached)
      const author2 = await userLoader.load(posts[1].authorId);

      assert.strictEqual(author1, author2); // Same object reference (cached)
    });

    test('should return undefined for non-existent ID', async () => {
      const userLoader = (userRepo as any).createLoader();
      const result = await userLoader.load('00000000-0000-0000-0000-000000000000');
      assert.strictEqual(result, undefined);
    });
  });

  // ===========================================================================
  // Array References (One-to-Many)
  // ===========================================================================

  describe('Array References Resolution', () => {
    test('should resolve array of references', async () => {
      // Create tags
      const tag1 = await tagRepo.insert({ name: 'Tag A', slug: 'tag-a' });
      const tag2 = await tagRepo.insert({ name: 'Tag B', slug: 'tag-b' });
      const tag3 = await tagRepo.insert({ name: 'Tag C', slug: 'tag-c' });

      // Create user and post with tags
      const user = await userRepo.insert({ email: 'tagger@example.com', name: 'Tagger', bio: null });
      const post = await postRepo.insert({
        title: 'Tagged Post',
        content: 'Post with multiple tags',
        published: true,
        authorId: keyOf(user),
        tagIds: [keyOf(tag1), keyOf(tag2), keyOf(tag3)],
      });

      // Create DataLoader for tags
      const tagLoader = (tagRepo as any).createLoader();

      // Resolve all tags
      const foundPost = await postRepo.get(Post.ref`${keyOf(post)}`);
      assert.ok(foundPost);

      const tags = await Promise.all(
        foundPost.tagIds.map((id: any) => tagLoader.load(id))
      );

      assert.strictEqual(tags.length, 3);
      const tagNames = tags.filter(Boolean).map((t) => t!.name).sort();
      assert.deepStrictEqual(tagNames, ['Tag A', 'Tag B', 'Tag C']);
    });

    test('should handle empty array of references', async () => {
      const user = await userRepo.insert({ email: 'notags@example.com', name: 'No Tags', bio: null });
      const post = await postRepo.insert({
        title: 'No Tags Post',
        content: 'Post without tags',
        published: true,
        authorId: keyOf(user),
        tagIds: [],
      });

      const found = await postRepo.get(Post.ref`${keyOf(post)}`);
      assert.ok(found);
      assert.deepStrictEqual(found.tagIds, []);
    });

    test('should handle partial missing references in array', async () => {
      const tag1 = await tagRepo.insert({ name: 'Existing Tag', slug: 'existing' });

      const user = await userRepo.insert({ email: 'partial@example.com', name: 'Partial', bio: null });
      const post = await postRepo.insert({
        title: 'Partial Tags Post',
        content: 'Some tags might not exist',
        published: true,
        authorId: keyOf(user),
        tagIds: [keyOf(tag1), '00000000-0000-0000-0000-000000000000'], // One valid, one invalid
      });

      const tagLoader = (tagRepo as any).createLoader();
      const foundPost = await postRepo.get(Post.ref`${keyOf(post)}`);
      assert.ok(foundPost);

      const tags = await Promise.all(
        foundPost.tagIds.map((id: any) => tagLoader.load(id))
      );

      // Filter out undefined (non-existent)
      const validTags = tags.filter(Boolean);
      assert.strictEqual(validTags.length, 1);
      assert.strictEqual(validTags[0]!.name, 'Existing Tag');
    });
  });

  // ===========================================================================
  // Nested References
  // ===========================================================================

  describe('Nested References', () => {
    test('should resolve nested references (Post -> Author -> ...)', async () => {
      // Create user
      const user = await userRepo.insert({
        email: 'nested@example.com',
        name: 'Nested User',
        bio: 'Bio text',
      });

      // Create post
      const post = await postRepo.insert({
        title: 'Nested Post',
        content: 'Testing nested resolution',
        published: true,
        authorId: keyOf(user),
        tagIds: [],
      });

      // Create comments on the post
      await commentRepo.insert({
        content: 'First comment',
        authorId: keyOf(user), // Same user commenting
        postId: keyOf(post),
      });

      await commentRepo.insert({
        content: 'Second comment',
        authorId: keyOf(user),
        postId: keyOf(post),
      });

      // Create loaders
      const userLoader = (userRepo as any).createLoader();
      const postLoader = (postRepo as any).createLoader();

      // Start from comments and resolve up
      const comments = await commentRepo.find({ where: Comment.fields.postId.eq(keyOf(post)) });
      assert.strictEqual(comments.length, 2);

      // Resolve post for each comment
      const posts = await Promise.all(
        comments.map((c: any) => postLoader.load(c.postId))
      );
      assert.ok(posts[0]);
      assert.strictEqual(posts[0]!.title, 'Nested Post');

      // Resolve author for each comment
      const authors = await Promise.all(
        comments.map((c: any) => userLoader.load(c.authorId))
      );
      assert.ok(authors[0]);
      assert.strictEqual(authors[0]!.name, 'Nested User');
    });

    test('should handle self-referencing (tree structure)', async () => {
      // Create category tree:
      // Root
      // --- Child 1
      // -   --- Grandchild 1
      // --- Child 2

      const root = await categoryRepo.insert({ name: 'Root', parentId: null });
      const child1 = await categoryRepo.insert({ name: 'Child 1', parentId: keyOf(root) });
      await categoryRepo.insert({ name: 'Child 2', parentId: keyOf(root) });
      const grandchild1 = await categoryRepo.insert({ name: 'Grandchild 1', parentId: keyOf(child1) });

      const categoryLoader = (categoryRepo as any).createLoader();

      // Navigate up from grandchild
      const gc = await categoryRepo.get(Category.ref`${keyOf(grandchild1)}`);
      assert.ok(gc);
      assert.ok(gc.parentId);

      const parent = await categoryLoader.load(gc.parentId);
      assert.ok(parent);
      assert.strictEqual(parent.name, 'Child 1');

      const grandparent = await categoryLoader.load(parent.parentId!);
      assert.ok(grandparent);
      assert.strictEqual(grandparent.name, 'Root');
      assert.strictEqual(grandparent.parentId, undefined);
    });
  });

  // ===========================================================================
  // N+1 Prevention
  // ===========================================================================

  describe('N+1 Prevention', () => {
    test('should batch load authors for many posts (N+1 prevention)', async () => {
      // Create multiple users
      const users = await Promise.all([
        userRepo.insert({ email: 'author1@example.com', name: 'Author 1', bio: null }),
        userRepo.insert({ email: 'author2@example.com', name: 'Author 2', bio: null }),
        userRepo.insert({ email: 'author3@example.com', name: 'Author 3', bio: null }),
      ]);

      // Create many posts
      const posts: Persistent<Post>[] = [];
      for (let i = 0; i < 10; i++) {
        const author = users[i % users.length];
        const post = await postRepo.insert({
          title: `Post ${i}`,
          content: `Content ${i}`,
          published: true,
          authorId: keyOf(author),
          tagIds: [],
        });
        posts.push(post);
      }

      // Create a single DataLoader
      const userLoader = (userRepo as any).createLoader();

      // Load all authors - this should be 1 batch query, not 10 individual queries
      const authors = await Promise.all(
        posts.map((post: any) => userLoader.load(post.authorId))
      );

      // Verify all authors loaded
      assert.strictEqual(authors.length, 10);
      assert.ok(authors.every((a) => a !== null && a !== undefined));

      // Verify unique authors (should only be 3)
      const uniqueAuthorIds = new Set(authors.map((a) => keyOf(a!)));
      assert.strictEqual(uniqueAuthorIds.size, 3);
    });

    test('should handle mixed existing and cached in batch', async () => {
      const user1 = await userRepo.insert({ email: 'mixed1@example.com', name: 'Mixed 1', bio: null });
      const user2 = await userRepo.insert({ email: 'mixed2@example.com', name: 'Mixed 2', bio: null });

      const userLoader = (userRepo as any).createLoader();

      // Pre-load user1 (will be cached)
      await userLoader.load(keyOf(user1));

      // Now load both - user1 from cache, user2 from DB
      const [loaded1, loaded2] = await Promise.all([
        userLoader.load(keyOf(user1)),
        userLoader.load(keyOf(user2)),
      ]);

      assert.ok(loaded1);
      assert.ok(loaded2);
      assert.strictEqual(loaded1.name, 'Mixed 1');
      assert.strictEqual(loaded2.name, 'Mixed 2');
    });
  });

  // ===========================================================================
  // Query with References
  // ===========================================================================

  describe('Query with References', () => {
    test('should query by foreign key', async () => {
      const user1 = await userRepo.insert({ email: 'query1@example.com', name: 'Query User 1', bio: null });
      const user2 = await userRepo.insert({ email: 'query2@example.com', name: 'Query User 2', bio: null });

      // Create posts for different users
      await postRepo.insert({ title: 'User1 Post 1', content: 'C', published: true, authorId: keyOf(user1), tagIds: [] });
      await postRepo.insert({ title: 'User1 Post 2', content: 'C', published: true, authorId: keyOf(user1), tagIds: [] });
      await postRepo.insert({ title: 'User2 Post 1', content: 'C', published: true, authorId: keyOf(user2), tagIds: [] });

      // Query posts by author
      const user1Posts = await postRepo.find({
        where: Post.fields.authorId.eq(keyOf(user1)),
      });

      assert.strictEqual(user1Posts.length, 2);
      assert.ok(user1Posts.every((p: any) => p.authorId === keyOf(user1)));
    });

    test('should query by multiple foreign keys with IN', async () => {
      const user1 = await userRepo.insert({ email: 'in1@example.com', name: 'In User 1', bio: null });
      const user2 = await userRepo.insert({ email: 'in2@example.com', name: 'In User 2', bio: null });
      const user3 = await userRepo.insert({ email: 'in3@example.com', name: 'In User 3', bio: null });

      await postRepo.insert({ title: 'P1', content: 'C', published: true, authorId: keyOf(user1), tagIds: [] });
      await postRepo.insert({ title: 'P2', content: 'C', published: true, authorId: keyOf(user2), tagIds: [] });
      await postRepo.insert({ title: 'P3', content: 'C', published: true, authorId: keyOf(user3), tagIds: [] });

      // Query posts by multiple authors
      const posts = await postRepo.find({
        where: Post.fields.authorId.in([keyOf(user1), keyOf(user2)]),
      });

      assert.strictEqual(posts.length, 2);
    });

    test('should count by foreign key', async () => {
      const user = await userRepo.insert({ email: 'count@example.com', name: 'Count User', bio: null });

      await postRepo.insert({ title: 'P1', content: 'C', published: true, authorId: keyOf(user), tagIds: [] });
      await postRepo.insert({ title: 'P2', content: 'C', published: true, authorId: keyOf(user), tagIds: [] });
      await postRepo.insert({ title: 'P3', content: 'C', published: false, authorId: keyOf(user), tagIds: [] });

      const totalCount = await postRepo.count(Post.fields.authorId.eq(keyOf(user)));
      const publishedCount = await postRepo.count(
        q.and(Post.fields.authorId.eq(keyOf(user)), Post.fields.published.eq(true))
      );

      assert.strictEqual(totalCount, 3);
      assert.strictEqual(publishedCount, 2);
    });
  });

  // ===========================================================================
  // Cascade Delete Behavior
  // ===========================================================================

  describe('Cascade Delete', () => {
    test('should cascade delete comments when post is deleted', async () => {
      const user = await userRepo.insert({ email: 'cascade@example.com', name: 'Cascade', bio: null });
      const post = await postRepo.insert({
        title: 'Post to Delete',
        content: 'This will be deleted',
        published: true,
        authorId: keyOf(user),
        tagIds: [],
      });

      // Add comments
      await commentRepo.insert({ content: 'Comment 1', authorId: keyOf(user), postId: keyOf(post) });
      await commentRepo.insert({ content: 'Comment 2', authorId: keyOf(user), postId: keyOf(post) });

      // Verify comments exist
      let comments = await commentRepo.find({ where: Comment.fields.postId.eq(keyOf(post)) });
      assert.strictEqual(comments.length, 2);

      // Delete post (should cascade to comments due to ON DELETE CASCADE)
      await postRepo.delete(post);

      // Verify comments are gone
      comments = await commentRepo.find({ where: Comment.fields.postId.eq(keyOf(post)) });
      assert.strictEqual(comments.length, 0);
    });
  });

  // ===========================================================================
  // Update References
  // ===========================================================================

  describe('Update References', () => {
    test('should update foreign key reference', async () => {
      const user1 = await userRepo.insert({ email: 'update1@example.com', name: 'User 1', bio: null });
      const user2 = await userRepo.insert({ email: 'update2@example.com', name: 'User 2', bio: null });

      const post = await postRepo.insert({
        title: 'Reassign Post',
        content: 'Will change author',
        published: true,
        authorId: keyOf(user1),
        tagIds: [],
      });

      // Update author
      const updated = await postRepo.update(post, { authorId: keyOf(user2) });

      assert.strictEqual(updated.authorId, keyOf(user2));

      // Verify with fresh load
      const found = await postRepo.get(Post.ref`${keyOf(post)}`);
      assert.ok(found);
      assert.strictEqual(found.authorId, keyOf(user2));
    });

    test('should update array of references', async () => {
      const user = await userRepo.insert({ email: 'tagupdate@example.com', name: 'Tagger', bio: null });
      const tag1 = await tagRepo.insert({ name: 'Old Tag', slug: 'old' });
      const tag2 = await tagRepo.insert({ name: 'New Tag', slug: 'new' });

      const post = await postRepo.insert({
        title: 'Tag Update Post',
        content: 'Tags will change',
        published: true,
        authorId: keyOf(user),
        tagIds: [keyOf(tag1)],
      });

      // Update tags
      const updated = await postRepo.update(post, { tagIds: [keyOf(tag2)] });

      assert.deepStrictEqual(updated.tagIds, [keyOf(tag2)]);
    });
  });
});
