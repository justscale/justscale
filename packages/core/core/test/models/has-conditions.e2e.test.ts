/**
 * Comprehensive has() Condition Tests for In-Memory Repository
 *
 * Mirrors the PostgreSQL has-query.test.ts to ensure feature parity.
 * Tests relationship queries using has() conditions with the in-memory adapter.
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
// Domain Models (same structure as PostgreSQL tests)
// ============================================================================

// Organization -> User -> Post -> Comment (4 levels for deep nesting tests)
class Organization extends defineModel({
  name: field.string().max(255),
  tier: field.string().max(50), // 'enterprise', 'startup', 'free'
}) {}

class User extends defineModel({
  name: field.string().max(255),
  email: field.string().max(255),
  role: field.string().max(50),
  org: field.ref(Organization).optional(),
}) {}

class Post extends defineModel({
  title: field.string().max(255),
  content: field.text(),
  status: field.string().max(50),
  author: field.ref(User),
}) {}

class Comment extends defineModel({
  body: field.text(),
  post: field.ref(Post),
  author: field.ref(User),
}) {}

// Tag and PostTag for many-to-many relationship testing
class Tag extends defineModel({
  name: field.string().max(100),
  category: field.string().max(50),
}) {}

class PostTag extends defineModel({
  post: field.ref(Post),
  tag: field.ref(Tag),
}) {}

// Self-referencing model for manager hierarchy
 
class Employee extends defineModel({
  name: field.string().max(255),
  department: field.string().max(100),
  manager: field.ref((): any => Employee).optional(),
}) {}

// ============================================================================
// Repository Registry (simulates what the DI container does)
// ============================================================================

interface RepositoryRegistry {
  orgs: InMemoryRepository<Organization>
  users: InMemoryRepository<User>
  posts: InMemoryRepository<Post>
  comments: InMemoryRepository<Comment>
  tags: InMemoryRepository<Tag>
  postTags: InMemoryRepository<PostTag>
  employees: InMemoryRepository<Employee>
}

function createRepositories(): RepositoryRegistry {
  // Create all repositories first (without resolvers)
  const orgs = new InMemoryRepository<Organization>();
  const users = new InMemoryRepository<User>({
    fieldDefs: getModelFields(User),
  });
  const tags = new InMemoryRepository<Tag>();

  const repos: Record<string, InMemoryRepository<any>> = {};

  // Create a unified resolver that can resolve any model
  const resolver = (refId: string, fieldDef: FieldDef): Record<string, unknown> | undefined => {
    const targetModel = fieldDef.refTarget?.();
    if (!targetModel) return undefined;

    if (targetModel === Organization) {
      return orgs['store'].get(refId) as Record<string, unknown> | undefined;
    }
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
      return tags['store'].get(refId) as Record<string, unknown> | undefined;
    }
    if (targetModel === PostTag) {
      return repos.postTags?.['store'].get(refId) as Record<string, unknown> | undefined;
    }
    if (targetModel === Employee) {
      return repos.employees?.['store'].get(refId) as Record<string, unknown> | undefined;
    }

    return undefined;
  };

  // Get field definitions for a related model from a ref field
  const getFieldDefsForRef = (fieldDef: FieldDef): Record<string, FieldDef> | undefined => {
    const targetModel = fieldDef.refTarget?.();
    if (!targetModel) return undefined;

    if (targetModel === Organization) return getModelFields(Organization);
    if (targetModel === User) return getModelFields(User);
    if (targetModel === Post) return getModelFields(Post);
    if (targetModel === Comment) return getModelFields(Comment);
    if (targetModel === Tag) return getModelFields(Tag);
    if (targetModel === PostTag) return getModelFields(PostTag);
    if (targetModel === Employee) return getModelFields(Employee);

    return undefined;
  };

  // Create repositories with resolvers
  repos.posts = new InMemoryRepository<Post>({
    fieldDefs: getModelFields(Post),
    relationResolver: resolver,
    getFieldDefsForRef,
  });

  repos.comments = new InMemoryRepository<Comment>({
    fieldDefs: getModelFields(Comment),
    relationResolver: resolver,
    getFieldDefsForRef,
  });

  repos.postTags = new InMemoryRepository<PostTag>({
    fieldDefs: getModelFields(PostTag),
    relationResolver: resolver,
    getFieldDefsForRef,
  });

  repos.employees = new InMemoryRepository<Employee>({
    fieldDefs: getModelFields(Employee),
    relationResolver: resolver,
    getFieldDefsForRef,
  });

  return {
    orgs,
    users,
    posts: repos.posts as InMemoryRepository<Post>,
    comments: repos.comments as InMemoryRepository<Comment>,
    tags,
    postTags: repos.postTags as InMemoryRepository<PostTag>,
    employees: repos.employees as InMemoryRepository<Employee>,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('InMemoryRepository - has() E2E Tests', () => {
  let repos: RepositoryRegistry;

  beforeEach(() => {
    repos = createRepositories();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Basic has() Tests
  // ─────────────────────────────────────────────────────────────────────────

  test('should find posts by author name using has()', async () => {
    const john = await repos.users.insert({ name: 'John', email: 'john@example.com', role: 'admin' } as any);
    const jane = await repos.users.insert({ name: 'Jane', email: 'jane@example.com', role: 'user' } as any);

    await repos.posts.insert({ title: 'John Post 1', content: 'Content', status: 'published', author: john } as any);
    await repos.posts.insert({ title: 'John Post 2', content: 'Content', status: 'draft', author: john } as any);
    await repos.posts.insert({ title: 'Jane Post', content: 'Content', status: 'published', author: jane } as any);

    const johnsPosts = await repos.posts.find({
      where: Post.fields.author.has(User.fields.name.eq('John')),
    });

    assert.strictEqual(johnsPosts.length, 2);
    assert.ok(johnsPosts.every(p => p.title.startsWith('John')));
  });

  test('should find posts by author role using has()', async () => {
    const admin = await repos.users.insert({ name: 'Admin', email: 'admin@example.com', role: 'admin' } as any);
    const user1 = await repos.users.insert({ name: 'User1', email: 'user1@example.com', role: 'user' } as any);
    const user2 = await repos.users.insert({ name: 'User2', email: 'user2@example.com', role: 'user' } as any);

    await repos.posts.insert({ title: 'Admin Post', content: 'Content', status: 'published', author: admin } as any);
    await repos.posts.insert({ title: 'User1 Post', content: 'Content', status: 'published', author: user1 } as any);
    await repos.posts.insert({ title: 'User2 Post', content: 'Content', status: 'published', author: user2 } as any);

    const userPosts = await repos.posts.find({
      where: Post.fields.author.has(User.fields.role.eq('user')),
    });

    assert.strictEqual(userPosts.length, 2);
    assert.ok(userPosts.some(p => p.title === 'User1 Post'));
    assert.ok(userPosts.some(p => p.title === 'User2 Post'));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Combined Conditions
  // ─────────────────────────────────────────────────────────────────────────

  test('should combine has() with local field conditions', async () => {
    const john = await repos.users.insert({ name: 'John', email: 'john@example.com', role: 'admin' } as any);

    await repos.posts.insert({ title: 'Published', content: 'Content', status: 'published', author: john } as any);
    await repos.posts.insert({ title: 'Draft', content: 'Content', status: 'draft', author: john } as any);

    const publishedByJohn = await repos.posts.find({
      where: q.and(
        Post.fields.status.eq('published'),
        Post.fields.author.has(User.fields.name.eq('John')),
      ),
    });

    assert.strictEqual(publishedByJohn.length, 1);
    assert.strictEqual(publishedByJohn[0].title, 'Published');
  });

  test('should use has() with multiple conditions on related model', async () => {
    const adminJohn = await repos.users.insert({ name: 'John', email: 'john@admin.com', role: 'admin' } as any);
    const userJohn = await repos.users.insert({ name: 'John', email: 'john@user.com', role: 'user' } as any);

    await repos.posts.insert({ title: 'Admin John Post', content: 'Content', status: 'published', author: adminJohn } as any);
    await repos.posts.insert({ title: 'User John Post', content: 'Content', status: 'published', author: userJohn } as any);

    const adminJohnPosts = await repos.posts.find({
      where: Post.fields.author.has(q.and(User.fields.name.eq('John'), User.fields.role.eq('admin'))),
    });

    assert.strictEqual(adminJohnPosts.length, 1);
    assert.strictEqual(adminJohnPosts[0].title, 'Admin John Post');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Nested has() (Multi-level relationships)
  // ─────────────────────────────────────────────────────────────────────────

  test('should handle nested has() conditions (Comment -> Post -> Author)', async () => {
    const john = await repos.users.insert({ name: 'John', email: 'john@example.com', role: 'admin' } as any);
    const post = await repos.posts.insert({ title: 'Tech Post', content: 'Content', status: 'published', author: john } as any);

    await repos.comments.insert({ body: 'Great post!', post: post, author: john } as any);
    await repos.comments.insert({ body: 'Nice!', post: post, author: john } as any);

    const adminPostComments = await repos.comments.find({
      where: Comment.fields.post.has(
        Post.fields.author.has(
          User.fields.role.eq('admin'),
        ),
      ),
    });

    assert.strictEqual(adminPostComments.length, 2);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Self-Join Tests
  // ─────────────────────────────────────────────────────────────────────────

  test('should handle self-referencing has() for manager hierarchy', async () => {
    const engineeringManager = await repos.employees.insert({ name: 'Alice', department: 'Engineering' } as any);
    const salesManager = await repos.employees.insert({ name: 'Bob', department: 'Sales' } as any);

    await repos.employees.insert({ name: 'Charlie', department: 'Engineering', manager: engineeringManager } as any);
    await repos.employees.insert({ name: 'Diana', department: 'Engineering', manager: engineeringManager } as any);
    await repos.employees.insert({ name: 'Eve', department: 'Sales', manager: salesManager } as any);

    const engineeringTeam = await repos.employees.find({
      where: Employee.fields.manager.has(Employee.fields.department.eq('Engineering')),
    });

    assert.strictEqual(engineeringTeam.length, 2);
    assert.ok(engineeringTeam.some(e => e.name === 'Charlie'));
    assert.ok(engineeringTeam.some(e => e.name === 'Diana'));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Deep Nesting (4 levels: Comment -> Post -> Author -> Organization)
  // ─────────────────────────────────────────────────────────────────────────

  test('should handle 4-level deep nesting (Comment -> Post -> Author -> Org)', async () => {
    // Setup: Enterprise org with admin user who writes a post that gets comments
    const enterpriseOrg = await repos.orgs.insert({ name: 'Acme Corp', tier: 'enterprise' } as any);
    const startupOrg = await repos.orgs.insert({ name: 'StartupXYZ', tier: 'startup' } as any);

    const enterpriseAdmin = await repos.users.insert({
      name: 'John',
      email: 'john@acme.com',
      role: 'admin',
      org: enterpriseOrg,
    } as any);
    const startupUser = await repos.users.insert({
      name: 'Jane',
      email: 'jane@startup.xyz',
      role: 'user',
      org: startupOrg,
    } as any);

    const enterprisePost = await repos.posts.insert({
      title: 'Enterprise Post',
      content: 'Content',
      status: 'published',
      author: enterpriseAdmin,
    } as any);
    const startupPost = await repos.posts.insert({
      title: 'Startup Post',
      content: 'Content',
      status: 'published',
      author: startupUser,
    } as any);

    // Create comments on both posts
    await repos.comments.insert({ body: 'Comment on enterprise post', post: enterprisePost, author: enterpriseAdmin } as any);
    await repos.comments.insert({ body: 'Second comment on enterprise post', post: enterprisePost, author: startupUser } as any);
    await repos.comments.insert({ body: 'Comment on startup post', post: startupPost, author: startupUser } as any);

    // Find comments on posts by authors from enterprise orgs
    const enterpriseComments = await repos.comments.find({
      where: Comment.fields.post.has(
        Post.fields.author.has(
          User.fields.org.has(
            Organization.fields.tier.eq('enterprise'),
          ),
        ),
      ),
    });

    assert.strictEqual(enterpriseComments.length, 2);
    assert.ok(enterpriseComments.every(c => c.body.includes('enterprise post')));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Multiple has() on Different Refs in Same Query
  // ─────────────────────────────────────────────────────────────────────────

  test('should handle multiple has() conditions on different refs', async () => {
    const admin = await repos.users.insert({ name: 'Admin', email: 'admin@example.com', role: 'admin' } as any);
    const user = await repos.users.insert({ name: 'User', email: 'user@example.com', role: 'user' } as any);
    const moderator = await repos.users.insert({ name: 'Mod', email: 'mod@example.com', role: 'moderator' } as any);

    const adminPost = await repos.posts.insert({ title: 'Admin Post', content: 'Content', status: 'published', author: admin } as any);
    const userPost = await repos.posts.insert({ title: 'User Post', content: 'Content', status: 'published', author: user } as any);

    // Admin comments on admin's post
    await repos.comments.insert({ body: 'Admin commenting on admin post', post: adminPost, author: admin } as any);
    // User comments on admin's post
    await repos.comments.insert({ body: 'User commenting on admin post', post: adminPost, author: user } as any);
    // Admin comments on user's post
    await repos.comments.insert({ body: 'Admin commenting on user post', post: userPost, author: admin } as any);
    // Moderator comments on admin's post
    await repos.comments.insert({ body: 'Mod commenting on admin post', post: adminPost, author: moderator } as any);

    // Find comments where BOTH the post author AND comment author are admins
    const adminOnAdminComments = await repos.comments.find({
      where: q.and(
        Comment.fields.post.has(Post.fields.author.has(User.fields.role.eq('admin'))),
        Comment.fields.author.has(User.fields.role.eq('admin')),
      ),
    });

    assert.strictEqual(adminOnAdminComments.length, 1);
    assert.strictEqual(adminOnAdminComments[0].body, 'Admin commenting on admin post');
  });

  test('should handle OR with multiple has() conditions', async () => {
    const admin = await repos.users.insert({ name: 'Admin', email: 'admin@example.com', role: 'admin' } as any);
    const vip = await repos.users.insert({ name: 'VIP', email: 'vip@premium.com', role: 'user' } as any);
    const regular = await repos.users.insert({ name: 'Regular', email: 'reg@example.com', role: 'user' } as any);

    await repos.posts.insert({ title: 'Admin Post', content: 'Content', status: 'published', author: admin } as any);
    await repos.posts.insert({ title: 'VIP Post', content: 'Content', status: 'published', author: vip } as any);
    await repos.posts.insert({ title: 'Regular Post', content: 'Content', status: 'published', author: regular } as any);

    // Find posts by admins OR by users with @premium.com email
    const priorityPosts = await repos.posts.find({
      where: q.or(
        Post.fields.author.has(User.fields.role.eq('admin')),
        Post.fields.author.has(User.fields.email.endsWith('@premium.com')),
      ),
    });

    assert.strictEqual(priorityPosts.length, 2);
    assert.ok(priorityPosts.some(p => p.title === 'Admin Post'));
    assert.ok(priorityPosts.some(p => p.title === 'VIP Post'));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Multi-level Self-Joins (Manager -> Manager's Manager)
  // ─────────────────────────────────────────────────────────────────────────

  test('should handle 2-level self-referencing has() (employee -> manager -> managers manager)', async () => {
    // Setup hierarchy: CEO -> VP -> Manager -> Employee
    const ceo = await repos.employees.insert({ name: 'CEO', department: 'Executive' } as any);
    const vpEngineering = await repos.employees.insert({ name: 'VP Eng', department: 'Engineering', manager: ceo } as any);
    const vpSales = await repos.employees.insert({ name: 'VP Sales', department: 'Sales', manager: ceo } as any);
    const engManager = await repos.employees.insert({ name: 'Eng Manager', department: 'Engineering', manager: vpEngineering } as any);
    const salesManager = await repos.employees.insert({ name: 'Sales Manager', department: 'Sales', manager: vpSales } as any);

    // Engineers and salespeople
    await repos.employees.insert({ name: 'Dev 1', department: 'Engineering', manager: engManager } as any);
    await repos.employees.insert({ name: 'Dev 2', department: 'Engineering', manager: engManager } as any);
    await repos.employees.insert({ name: 'Sales Rep', department: 'Sales', manager: salesManager } as any);

    // Find employees whose manager's manager is in Executive department
    const reportsToVPs = await repos.employees.find({
      where: Employee.fields.manager.has(
        Employee.fields.manager.has(
          Employee.fields.department.eq('Executive'),
        ),
      ),
    });

    // Should find engManager and salesManager (both report to VPs who report to CEO)
    assert.strictEqual(reportsToVPs.length, 2);
    assert.ok(reportsToVPs.some(e => e.name === 'Eng Manager'));
    assert.ok(reportsToVPs.some(e => e.name === 'Sales Manager'));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Many-to-Many via Junction Table
  // ─────────────────────────────────────────────────────────────────────────

  test('should handle has() across junction tables (many-to-many)', async () => {
    const user = await repos.users.insert({ name: 'Author', email: 'author@example.com', role: 'user' } as any);

    // Create tags
    const techTag = await repos.tags.insert({ name: 'tech', category: 'technology' } as any);
    const newsTag = await repos.tags.insert({ name: 'news', category: 'current-events' } as any);
    const lifestyleTag = await repos.tags.insert({ name: 'lifestyle', category: 'lifestyle' } as any);

    // Create posts
    const techPost = await repos.posts.insert({ title: 'Tech Post', content: 'Tech content', status: 'published', author: user } as any);
    const newsPost = await repos.posts.insert({ title: 'News Post', content: 'News content', status: 'published', author: user } as any);
    const mixedPost = await repos.posts.insert({ title: 'Mixed Post', content: 'Mixed content', status: 'published', author: user } as any);

    // Associate posts with tags
    await repos.postTags.insert({ post: techPost, tag: techTag } as any);
    await repos.postTags.insert({ post: newsPost, tag: newsTag } as any);
    await repos.postTags.insert({ post: mixedPost, tag: techTag } as any);
    await repos.postTags.insert({ post: mixedPost, tag: lifestyleTag } as any);

    // Find post-tags that link to 'technology' category tags
    const techPostTags = await repos.postTags.find({
      where: PostTag.fields.tag.has(Tag.fields.category.eq('technology')),
    });

    assert.strictEqual(techPostTags.length, 2); // tech post and mixed post both have tech tag
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Complex Boolean Logic
  // ─────────────────────────────────────────────────────────────────────────

  test('should handle complex AND/OR combinations with has()', async () => {
    const enterpriseOrg = await repos.orgs.insert({ name: 'Enterprise', tier: 'enterprise' } as any);
    const startupOrg = await repos.orgs.insert({ name: 'Startup', tier: 'startup' } as any);

    const enterpriseAdmin = await repos.users.insert({ name: 'EA', email: 'ea@enterprise.com', role: 'admin', org: enterpriseOrg } as any);
    const enterpriseUser = await repos.users.insert({ name: 'EU', email: 'eu@enterprise.com', role: 'user', org: enterpriseOrg } as any);
    const startupAdmin = await repos.users.insert({ name: 'SA', email: 'sa@startup.com', role: 'admin', org: startupOrg } as any);
    const startupUser = await repos.users.insert({ name: 'SU', email: 'su@startup.com', role: 'user', org: startupOrg } as any);

    await repos.posts.insert({ title: 'EA Post', content: 'Content', status: 'published', author: enterpriseAdmin } as any);
    await repos.posts.insert({ title: 'EU Post', content: 'Content', status: 'draft', author: enterpriseUser } as any);
    await repos.posts.insert({ title: 'SA Post', content: 'Content', status: 'published', author: startupAdmin } as any);
    await repos.posts.insert({ title: 'SU Post', content: 'Content', status: 'published', author: startupUser } as any);

    // Find posts that are: (enterprise AND admin) OR (published AND startup)
    const complexResults = await repos.posts.find({
      where: q.or(
        q.and(
          Post.fields.author.has(User.fields.org.has(Organization.fields.tier.eq('enterprise'))),
          Post.fields.author.has(User.fields.role.eq('admin')),
        ),
        q.and(
          Post.fields.status.eq('published'),
          Post.fields.author.has(User.fields.org.has(Organization.fields.tier.eq('startup'))),
        ),
      ),
    });

    // EA Post: enterprise + admin ✓
    // EU Post: enterprise + user (not admin) + draft (not published startup) ✗
    // SA Post: startup + published ✓
    // SU Post: startup + published ✓
    assert.strictEqual(complexResults.length, 3);
    assert.ok(complexResults.some(p => p.title === 'EA Post'));
    assert.ok(complexResults.some(p => p.title === 'SA Post'));
    assert.ok(complexResults.some(p => p.title === 'SU Post'));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Edge Cases
  // ─────────────────────────────────────────────────────────────────────────

  test('should return empty array when no matches', async () => {
    const john = await repos.users.insert({ name: 'John', email: 'john@example.com', role: 'admin' } as any);
    await repos.posts.insert({ title: 'Post', content: 'Content', status: 'published', author: john } as any);

    const posts = await repos.posts.find({
      where: Post.fields.author.has(User.fields.name.eq('NonExistent')),
    });

    assert.strictEqual(posts.length, 0);
  });

  test('should handle null optional refs gracefully', async () => {
    // User with no org
    const userNoOrg = await repos.users.insert({ name: 'Solo', email: 'solo@example.com', role: 'user' } as any);
    await repos.posts.insert({ title: 'Solo Post', content: 'Content', status: 'published', author: userNoOrg } as any);

    // Find posts where author has enterprise org (should not find solo's post)
    const enterprisePosts = await repos.posts.find({
      where: Post.fields.author.has(
        User.fields.org.has(Organization.fields.tier.eq('enterprise')),
      ),
    });

    assert.strictEqual(enterprisePosts.length, 0);
  });
});
