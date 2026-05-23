/**
 * Query Edge Cases E2E Tests
 *
 * Tests edge cases and complex combinations to find potential issues:
 * - has() with ordering and pagination
 * - has() with aggregations (count)
 * - has() with deleteWhere
 * - has() combined with array conditions
 * - has() combined with nested object conditions
 * - refs (plural) with has()
 * - Circular references
 * - Edge cases (empty stores, null values, etc.)
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  defineModel,
  field,
  q,
  InMemoryRepository,
  getModelFields,
  type FieldDef,
} from '../../src/models/index.js';

// ============================================================================
// Domain Models
// ============================================================================

// User with nested settings object and tags array
class User extends defineModel({
  name: field.string().max(255),
  email: field.string().max(255),
  role: field.string().max(50),
  score: field.int().default(0),
  settings: field.object({
    theme: field.string(),
    notifications: field.object({
      email: field.boolean(),
      push: field.boolean(),
    }),
  }).optional(),
  tags: field.array(field.string()).optional(),
}) {}

// Post with author ref and metadata
class Post extends defineModel({
  title: field.string().max(255),
  content: field.text(),
  status: field.string().max(50),
  priority: field.int().default(0),
  author: field.ref(User),
  metadata: field.object({
    views: field.int(),
    featured: field.boolean(),
  }).optional(),
  categories: field.array(field.string()).optional(),
}) {}

// Comment with refs to both Post and User
class Comment extends defineModel({
  body: field.text(),
  likes: field.int().default(0),
  post: field.ref(Post),
  author: field.ref(User),
}) {}

// Tag with self-reference for parent/child hierarchy
 
class Tag extends defineModel({
  name: field.string().max(100),
  color: field.string().max(20),
  parent: field.ref((): any => Tag).optional(),
}) {}

// Article with multiple refs (refs plural)
class Category extends defineModel({
  name: field.string().max(100),
  slug: field.string().max(100),
}) {}

// ============================================================================
// Repository Registry
// ============================================================================

interface RepositoryRegistry {
  users: InMemoryRepository<User>
  posts: InMemoryRepository<Post>
  comments: InMemoryRepository<Comment>
  tags: InMemoryRepository<Tag>
  categories: InMemoryRepository<Category>
}

function createRepositories(): RepositoryRegistry {
  const users = new InMemoryRepository<User>();
  const categories = new InMemoryRepository<Category>();

  const getFieldDefsForRef = (fieldDef: FieldDef): Record<string, FieldDef> | undefined => {
    const targetModel = fieldDef.refTarget?.();
    if (!targetModel) return undefined;

    if (targetModel === User) return getModelFields(User);
    if (targetModel === Post) return getModelFields(Post);
    if (targetModel === Comment) return getModelFields(Comment);
    if (targetModel === Tag) return getModelFields(Tag);
    if (targetModel === Category) return getModelFields(Category);

    return undefined;
  };

  const repos: Record<string, InMemoryRepository<any>> = {};

  const relationResolver = (refId: string, fieldDef: FieldDef) => {
    const targetModel = fieldDef.refTarget?.();
    if (!targetModel) return undefined;

    if (targetModel === User) {
      return users['store'].get(refId) as Record<string, unknown> | undefined;
    }
    if (targetModel === Post) {
      return repos.posts?.['store'].get(refId) as Record<string, unknown> | undefined;
    }
    if (targetModel === Comment) {
      return repos.comments?.['store'].get(refId) as Record<string, unknown> | undefined;
    }
    if (targetModel === Tag) {
      return repos.tags?.['store'].get(refId) as Record<string, unknown> | undefined;
    }
    if (targetModel === Category) {
      return categories['store'].get(refId) as Record<string, unknown> | undefined;
    }

    return undefined;
  };

  repos.posts = new InMemoryRepository<Post>({
    fieldDefs: getModelFields(Post),
    relationResolver,
    getFieldDefsForRef,
  });

  repos.comments = new InMemoryRepository<Comment>({
    fieldDefs: getModelFields(Comment),
    relationResolver,
    getFieldDefsForRef,
  });

  repos.tags = new InMemoryRepository<Tag>({
    fieldDefs: getModelFields(Tag),
    relationResolver,
    getFieldDefsForRef,
  });

  return {
    users,
    posts: repos.posts as InMemoryRepository<Post>,
    comments: repos.comments as InMemoryRepository<Comment>,
    tags: repos.tags as InMemoryRepository<Tag>,
    categories,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Query Edge Cases E2E', () => {
  let repos: RepositoryRegistry;

  beforeEach(() => {
    repos = createRepositories();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // has() with Ordering
  // ─────────────────────────────────────────────────────────────────────────

  describe('has() with ordering', () => {
    test('should order results by local field after has() filter', async () => {
      const admin = await repos.users.insert({ name: 'Admin', email: 'admin@test.com', role: 'admin', score: 100 } as any);

      await repos.posts.insert({ title: 'C Post', content: 'Content', status: 'published', priority: 3, author: admin } as any);
      await repos.posts.insert({ title: 'A Post', content: 'Content', status: 'published', priority: 1, author: admin } as any);
      await repos.posts.insert({ title: 'B Post', content: 'Content', status: 'published', priority: 2, author: admin } as any);

      const posts = await repos.posts.find({
        where: Post.fields.author.has(User.fields.role.eq('admin')),
        orderBy: { title: 'asc' },
      });

      assert.strictEqual(posts.length, 3);
      assert.strictEqual(posts[0].title, 'A Post');
      assert.strictEqual(posts[1].title, 'B Post');
      assert.strictEqual(posts[2].title, 'C Post');
    });

    test('should order by priority descending after has() filter', async () => {
      const admin = await repos.users.insert({ name: 'Admin', email: 'admin@test.com', role: 'admin', score: 100 } as any);

      await repos.posts.insert({ title: 'Low', content: 'Content', status: 'published', priority: 1, author: admin } as any);
      await repos.posts.insert({ title: 'High', content: 'Content', status: 'published', priority: 10, author: admin } as any);
      await repos.posts.insert({ title: 'Medium', content: 'Content', status: 'published', priority: 5, author: admin } as any);

      const posts = await repos.posts.find({
        where: Post.fields.author.has(User.fields.role.eq('admin')),
        orderBy: { priority: 'desc' },
      });

      assert.strictEqual(posts.length, 3);
      assert.strictEqual(posts[0].title, 'High');
      assert.strictEqual(posts[1].title, 'Medium');
      assert.strictEqual(posts[2].title, 'Low');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // has() with Pagination
  // ─────────────────────────────────────────────────────────────────────────

  describe('has() with pagination', () => {
    test('should apply limit after has() filter', async () => {
      const admin = await repos.users.insert({ name: 'Admin', email: 'admin@test.com', role: 'admin', score: 100 } as any);

      for (let i = 1; i <= 10; i++) {
        await repos.posts.insert({ title: `Post ${i}`, content: 'Content', status: 'published', priority: i, author: admin } as any);
      }

      const posts = await repos.posts.find({
        where: Post.fields.author.has(User.fields.role.eq('admin')),
        limit: 3,
      });

      assert.strictEqual(posts.length, 3);
    });

    test('should apply offset after has() filter', async () => {
      const admin = await repos.users.insert({ name: 'Admin', email: 'admin@test.com', role: 'admin', score: 100 } as any);

      for (let i = 1; i <= 10; i++) {
        await repos.posts.insert({ title: `Post ${i}`, content: 'Content', status: 'published', priority: i, author: admin } as any);
      }

      const posts = await repos.posts.find({
        where: Post.fields.author.has(User.fields.role.eq('admin')),
        orderBy: { priority: 'asc' },
        offset: 5,
      });

      assert.strictEqual(posts.length, 5);
      assert.strictEqual(posts[0].priority, 6);
    });

    test('should combine limit, offset, and orderBy with has()', async () => {
      const admin = await repos.users.insert({ name: 'Admin', email: 'admin@test.com', role: 'admin', score: 100 } as any);
      const user = await repos.users.insert({ name: 'User', email: 'user@test.com', role: 'user', score: 50 } as any);

      // Admin posts with priorities 1-10
      for (let i = 1; i <= 10; i++) {
        await repos.posts.insert({ title: `Admin Post ${i}`, content: 'Content', status: 'published', priority: i, author: admin } as any);
      }
      // User posts (should be excluded)
      for (let i = 1; i <= 5; i++) {
        await repos.posts.insert({ title: `User Post ${i}`, content: 'Content', status: 'published', priority: i * 10, author: user } as any);
      }

      const posts = await repos.posts.find({
        where: Post.fields.author.has(User.fields.role.eq('admin')),
        orderBy: { priority: 'desc' },
        offset: 2,
        limit: 3,
      });

      assert.strictEqual(posts.length, 3);
      // After ordering desc (10,9,8,7,6,5,4,3,2,1) and offset 2, we get 8,7,6
      assert.strictEqual(posts[0].priority, 8);
      assert.strictEqual(posts[1].priority, 7);
      assert.strictEqual(posts[2].priority, 6);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // has() with Count
  // ─────────────────────────────────────────────────────────────────────────

  describe('has() with count', () => {
    test('should count entities matching has() condition', async () => {
      const admin = await repos.users.insert({ name: 'Admin', email: 'admin@test.com', role: 'admin', score: 100 } as any);
      const user = await repos.users.insert({ name: 'User', email: 'user@test.com', role: 'user', score: 50 } as any);

      await repos.posts.insert({ title: 'Admin Post 1', content: 'Content', status: 'published', priority: 1, author: admin } as any);
      await repos.posts.insert({ title: 'Admin Post 2', content: 'Content', status: 'published', priority: 2, author: admin } as any);
      await repos.posts.insert({ title: 'User Post', content: 'Content', status: 'published', priority: 1, author: user } as any);

      const count = await repos.posts.count(
        Post.fields.author.has(User.fields.role.eq('admin'))
      );

      assert.strictEqual(count, 2);
    });

    test('should count with complex has() and local conditions', async () => {
      const admin = await repos.users.insert({ name: 'Admin', email: 'admin@test.com', role: 'admin', score: 100 } as any);

      await repos.posts.insert({ title: 'Draft', content: 'Content', status: 'draft', priority: 1, author: admin } as any);
      await repos.posts.insert({ title: 'Published 1', content: 'Content', status: 'published', priority: 2, author: admin } as any);
      await repos.posts.insert({ title: 'Published 2', content: 'Content', status: 'published', priority: 3, author: admin } as any);

      const count = await repos.posts.count(
        q.and(
          Post.fields.author.has(User.fields.role.eq('admin')),
          Post.fields.status.eq('published')
        )
      );

      assert.strictEqual(count, 2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // has() with deleteWhere
  // ─────────────────────────────────────────────────────────────────────────

  describe('has() with deleteWhere', () => {
    test('should delete entities matching has() condition', async () => {
      const admin = await repos.users.insert({ name: 'Admin', email: 'admin@test.com', role: 'admin', score: 100 } as any);
      const user = await repos.users.insert({ name: 'User', email: 'user@test.com', role: 'user', score: 50 } as any);

      await repos.posts.insert({ title: 'Admin Post 1', content: 'Content', status: 'published', priority: 1, author: admin } as any);
      await repos.posts.insert({ title: 'Admin Post 2', content: 'Content', status: 'published', priority: 2, author: admin } as any);
      await repos.posts.insert({ title: 'User Post', content: 'Content', status: 'published', priority: 1, author: user } as any);

      const deleted = await repos.posts.deleteWhere(
        Post.fields.author.has(User.fields.role.eq('admin'))
      );

      assert.strictEqual(deleted, 2);
      assert.strictEqual(await repos.posts.count(), 1);

      const remaining = await repos.posts.find({});
      assert.strictEqual(remaining[0].title, 'User Post');
    });

    test('should delete with nested has() condition', async () => {
      const admin = await repos.users.insert({ name: 'Admin', email: 'admin@test.com', role: 'admin', score: 100 } as any);
      const user = await repos.users.insert({ name: 'User', email: 'user@test.com', role: 'user', score: 50 } as any);

      const adminPost = await repos.posts.insert({ title: 'Admin Post', content: 'Content', status: 'published', priority: 1, author: admin } as any);
      const userPost = await repos.posts.insert({ title: 'User Post', content: 'Content', status: 'published', priority: 1, author: user } as any);

      await repos.comments.insert({ body: 'Comment 1 on admin post', likes: 0, post: adminPost, author: user } as any);
      await repos.comments.insert({ body: 'Comment 2 on admin post', likes: 0, post: adminPost, author: admin } as any);
      await repos.comments.insert({ body: 'Comment on user post', likes: 0, post: userPost, author: admin } as any);

      // Delete comments on posts by admins
      const deleted = await repos.comments.deleteWhere(
        Comment.fields.post.has(
          Post.fields.author.has(User.fields.role.eq('admin'))
        )
      );

      assert.strictEqual(deleted, 2);
      assert.strictEqual(await repos.comments.count(), 1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // has() with Nested Object Conditions
  // ─────────────────────────────────────────────────────────────────────────

  describe('has() with nested object conditions', () => {
    test('should filter by nested object field on related entity', async () => {
      const darkUser = await repos.users.insert({
        name: 'Dark User',
        email: 'dark@test.com',
        role: 'user',
        score: 100,
        settings: { theme: 'dark', notifications: { email: true, push: false } },
      } as any);
      const lightUser = await repos.users.insert({
        name: 'Light User',
        email: 'light@test.com',
        role: 'user',
        score: 100,
        settings: { theme: 'light', notifications: { email: false, push: true } },
      } as any);

      await repos.posts.insert({ title: 'Dark Post', content: 'Content', status: 'published', priority: 1, author: darkUser } as any);
      await repos.posts.insert({ title: 'Light Post', content: 'Content', status: 'published', priority: 1, author: lightUser } as any);

      const posts = await repos.posts.find({
        where: Post.fields.author.has(User.fields.settings.theme.eq('dark')),
      });

      assert.strictEqual(posts.length, 1);
      assert.strictEqual(posts[0].title, 'Dark Post');
    });

    test('should filter by deeply nested object field on related entity', async () => {
      const emailUser = await repos.users.insert({
        name: 'Email User',
        email: 'email@test.com',
        role: 'user',
        score: 100,
        settings: { theme: 'dark', notifications: { email: true, push: false } },
      } as any);
      const pushUser = await repos.users.insert({
        name: 'Push User',
        email: 'push@test.com',
        role: 'user',
        score: 100,
        settings: { theme: 'dark', notifications: { email: false, push: true } },
      } as any);

      await repos.posts.insert({ title: 'Email Post', content: 'Content', status: 'published', priority: 1, author: emailUser } as any);
      await repos.posts.insert({ title: 'Push Post', content: 'Content', status: 'published', priority: 1, author: pushUser } as any);

      const posts = await repos.posts.find({
        where: Post.fields.author.has(User.fields.settings.notifications.email.eq(true)),
      });

      assert.strictEqual(posts.length, 1);
      assert.strictEqual(posts[0].title, 'Email Post');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // has() with Array Conditions
  // ─────────────────────────────────────────────────────────────────────────

  describe('has() with array conditions', () => {
    test('should filter by array contains on related entity', async () => {
      const devUser = await repos.users.insert({
        name: 'Dev User',
        email: 'dev@test.com',
        role: 'user',
        score: 100,
        tags: ['developer', 'javascript'],
      } as any);
      const designUser = await repos.users.insert({
        name: 'Design User',
        email: 'design@test.com',
        role: 'user',
        score: 100,
        tags: ['designer', 'ui'],
      } as any);

      await repos.posts.insert({ title: 'Dev Post', content: 'Content', status: 'published', priority: 1, author: devUser } as any);
      await repos.posts.insert({ title: 'Design Post', content: 'Content', status: 'published', priority: 1, author: designUser } as any);

      const posts = await repos.posts.find({
        where: Post.fields.author.has(User.fields.tags.contains('developer')),
      });

      assert.strictEqual(posts.length, 1);
      assert.strictEqual(posts[0].title, 'Dev Post');
    });

    test('should filter by array hasAny on related entity', async () => {
      const fullstackUser = await repos.users.insert({
        name: 'Fullstack User',
        email: 'fullstack@test.com',
        role: 'user',
        score: 100,
        tags: ['developer', 'designer'],
      } as any);
      const managerUser = await repos.users.insert({
        name: 'Manager User',
        email: 'manager@test.com',
        role: 'user',
        score: 100,
        tags: ['manager', 'lead'],
      } as any);

      await repos.posts.insert({ title: 'Fullstack Post', content: 'Content', status: 'published', priority: 1, author: fullstackUser } as any);
      await repos.posts.insert({ title: 'Manager Post', content: 'Content', status: 'published', priority: 1, author: managerUser } as any);

      const posts = await repos.posts.find({
        where: Post.fields.author.has(User.fields.tags.hasAny(['developer', 'designer'])),
      });

      assert.strictEqual(posts.length, 1);
      assert.strictEqual(posts[0].title, 'Fullstack Post');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Self-referencing with Deep Traversal
  // ─────────────────────────────────────────────────────────────────────────

  describe('Self-referencing deep traversal', () => {
    test('should handle 3-level deep self-referencing has()', async () => {
      // Create tag hierarchy: Root -> Parent -> Child -> Grandchild
      const root = await repos.tags.insert({ name: 'Root', color: 'red' } as any);
      const parent = await repos.tags.insert({ name: 'Parent', color: 'blue', parent: root } as any);
      const child = await repos.tags.insert({ name: 'Child', color: 'green', parent: parent } as any);
      const grandchild = await repos.tags.insert({ name: 'Grandchild', color: 'yellow', parent: child } as any);

      // Find tags whose parent's parent's color is red
      const tags = await repos.tags.find({
        where: Tag.fields.parent.has(
          Tag.fields.parent.has(
            Tag.fields.color.eq('red')
          )
        ),
      });

      assert.strictEqual(tags.length, 1);
      assert.strictEqual(tags[0].name, 'Child');
    });

    test('should handle self-referencing with combined conditions at each level', async () => {
      // Create hierarchy with colors
      const redRoot = await repos.tags.insert({ name: 'Red Root', color: 'red' } as any);
      const blueChild = await repos.tags.insert({ name: 'Blue Child', color: 'blue', parent: redRoot } as any);
      const greenGrandchild = await repos.tags.insert({ name: 'Green Grandchild', color: 'green', parent: blueChild } as any);

      const blueRoot = await repos.tags.insert({ name: 'Blue Root', color: 'blue' } as any);
      const redChild = await repos.tags.insert({ name: 'Red Child', color: 'red', parent: blueRoot } as any);

      // Find tags whose parent is blue AND parent's parent is red
      const tags = await repos.tags.find({
        where: Tag.fields.parent.has(
          q.and(
            Tag.fields.color.eq('blue'),
            Tag.fields.parent.has(Tag.fields.color.eq('red'))
          )
        ),
      });

      assert.strictEqual(tags.length, 1);
      assert.strictEqual(tags[0].name, 'Green Grandchild');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Edge Cases
  // ─────────────────────────────────────────────────────────────────────────

  describe('Edge cases', () => {
    test('should handle empty repository with has()', async () => {
      const posts = await repos.posts.find({
        where: Post.fields.author.has(User.fields.role.eq('admin')),
      });

      assert.strictEqual(posts.length, 0);
    });

    test('should handle has() when all refs are null', async () => {
      // Posts without authors would fail to insert due to required ref
      // But we can test with optional refs via self-ref tags
      await repos.tags.insert({ name: 'Orphan 1', color: 'red' } as any);
      await repos.tags.insert({ name: 'Orphan 2', color: 'blue' } as any);

      const tags = await repos.tags.find({
        where: Tag.fields.parent.has(Tag.fields.color.eq('red')),
      });

      assert.strictEqual(tags.length, 0);
    });

    test('should handle has() with in() operator on related entity', async () => {
      const admin = await repos.users.insert({ name: 'Admin', email: 'admin@test.com', role: 'admin', score: 100 } as any);
      const moderator = await repos.users.insert({ name: 'Mod', email: 'mod@test.com', role: 'moderator', score: 80 } as any);
      const user = await repos.users.insert({ name: 'User', email: 'user@test.com', role: 'user', score: 50 } as any);

      await repos.posts.insert({ title: 'Admin Post', content: 'Content', status: 'published', priority: 1, author: admin } as any);
      await repos.posts.insert({ title: 'Mod Post', content: 'Content', status: 'published', priority: 1, author: moderator } as any);
      await repos.posts.insert({ title: 'User Post', content: 'Content', status: 'published', priority: 1, author: user } as any);

      const posts = await repos.posts.find({
        where: Post.fields.author.has(User.fields.role.in(['admin', 'moderator'])),
      });

      assert.strictEqual(posts.length, 2);
      assert.ok(posts.some(p => p.title === 'Admin Post'));
      assert.ok(posts.some(p => p.title === 'Mod Post'));
    });

    test('should handle has() with comparison operators on related entity', async () => {
      const highScore = await repos.users.insert({ name: 'High', email: 'high@test.com', role: 'user', score: 100 } as any);
      const midScore = await repos.users.insert({ name: 'Mid', email: 'mid@test.com', role: 'user', score: 50 } as any);
      const lowScore = await repos.users.insert({ name: 'Low', email: 'low@test.com', role: 'user', score: 10 } as any);

      await repos.posts.insert({ title: 'High Post', content: 'Content', status: 'published', priority: 1, author: highScore } as any);
      await repos.posts.insert({ title: 'Mid Post', content: 'Content', status: 'published', priority: 1, author: midScore } as any);
      await repos.posts.insert({ title: 'Low Post', content: 'Content', status: 'published', priority: 1, author: lowScore } as any);

      const posts = await repos.posts.find({
        where: Post.fields.author.has(User.fields.score.gte(50)),
      });

      assert.strictEqual(posts.length, 2);
      assert.ok(posts.some(p => p.title === 'High Post'));
      assert.ok(posts.some(p => p.title === 'Mid Post'));
    });

    test('should handle has() with between on related entity', async () => {
      const score100 = await repos.users.insert({ name: 'Score100', email: 's100@test.com', role: 'user', score: 100 } as any);
      const score50 = await repos.users.insert({ name: 'Score50', email: 's50@test.com', role: 'user', score: 50 } as any);
      const score25 = await repos.users.insert({ name: 'Score25', email: 's25@test.com', role: 'user', score: 25 } as any);

      await repos.posts.insert({ title: 'Post100', content: 'Content', status: 'published', priority: 1, author: score100 } as any);
      await repos.posts.insert({ title: 'Post50', content: 'Content', status: 'published', priority: 1, author: score50 } as any);
      await repos.posts.insert({ title: 'Post25', content: 'Content', status: 'published', priority: 1, author: score25 } as any);

      const posts = await repos.posts.find({
        where: Post.fields.author.has(User.fields.score.between(40, 60)),
      });

      assert.strictEqual(posts.length, 1);
      assert.strictEqual(posts[0].title, 'Post50');
    });

    test('should handle has() with string operations on related entity', async () => {
      const johnDoe = await repos.users.insert({ name: 'John Doe', email: 'john@test.com', role: 'user', score: 100 } as any);
      const janeDoe = await repos.users.insert({ name: 'Jane Doe', email: 'jane@test.com', role: 'user', score: 100 } as any);
      const bobSmith = await repos.users.insert({ name: 'Bob Smith', email: 'bob@test.com', role: 'user', score: 100 } as any);

      await repos.posts.insert({ title: 'John Post', content: 'Content', status: 'published', priority: 1, author: johnDoe } as any);
      await repos.posts.insert({ title: 'Jane Post', content: 'Content', status: 'published', priority: 1, author: janeDoe } as any);
      await repos.posts.insert({ title: 'Bob Post', content: 'Content', status: 'published', priority: 1, author: bobSmith } as any);

      const posts = await repos.posts.find({
        where: Post.fields.author.has(User.fields.name.endsWith('Doe')),
      });

      assert.strictEqual(posts.length, 2);
      assert.ok(posts.some(p => p.title === 'John Post'));
      assert.ok(posts.some(p => p.title === 'Jane Post'));
    });

    test('should handle NOT with has() condition', async () => {
      const admin = await repos.users.insert({ name: 'Admin', email: 'admin@test.com', role: 'admin', score: 100 } as any);
      const user = await repos.users.insert({ name: 'User', email: 'user@test.com', role: 'user', score: 50 } as any);

      await repos.posts.insert({ title: 'Admin Post', content: 'Content', status: 'published', priority: 1, author: admin } as any);
      await repos.posts.insert({ title: 'User Post', content: 'Content', status: 'published', priority: 1, author: user } as any);

      const posts = await repos.posts.find({
        where: q.not(Post.fields.author.has(User.fields.role.eq('admin'))),
      });

      assert.strictEqual(posts.length, 1);
      assert.strictEqual(posts[0].title, 'User Post');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // findOne with has()
  // ─────────────────────────────────────────────────────────────────────────

  describe('findOne with has()', () => {
    test('should find one entity matching has() condition', async () => {
      const admin = await repos.users.insert({ name: 'Admin', email: 'admin@test.com', role: 'admin', score: 100 } as any);

      await repos.posts.insert({ title: 'Admin Post', content: 'Content', status: 'published', priority: 1, author: admin } as any);

      const post = await repos.posts.findOne(
        Post.fields.author.has(User.fields.role.eq('admin'))
      );

      assert.ok(post);
      assert.strictEqual(post.title, 'Admin Post');
    });

    test('should return undefined when no match for has() in findOne', async () => {
      const user = await repos.users.insert({ name: 'User', email: 'user@test.com', role: 'user', score: 50 } as any);

      await repos.posts.insert({ title: 'User Post', content: 'Content', status: 'published', priority: 1, author: user } as any);

      const post = await repos.posts.findOne(
        Post.fields.author.has(User.fields.role.eq('admin'))
      );

      assert.strictEqual(post, undefined);
    });
  });
});
