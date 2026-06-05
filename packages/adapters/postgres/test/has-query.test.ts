/**
 * Tests for has() query conditions (JOIN support)
 *
 * Tests the ability to query across model relationships using has() conditions,
 * which generate EXISTS subqueries.
 *
 * Uses proper app setup with JustScale() for realistic E2E testing.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';

import { defineModel, field, q, getModelFields, ADAPTER_KEY } from '@justscale/core/models';
const id = (e: unknown) => (e as Record<symbol, unknown>)[ADAPTER_KEY] as string;
import JustScale from '@justscale/core';
import { defineService, bindService, AbstractChannelBackend, MemoryChannelBackend } from '@justscale/core';
import { InMemoryProcessFeature } from '@justscale/core/process';
import { InMemoryLockFeature } from '@justscale/core/memory';
import {
  createPgModel,
  createPgRepository,
  ModelChangeChannels,
  PgQueryCompiler,
  ModelRegistry,
} from '../src/index.js';
import { createPostgresClient } from '../src/client/client.js';
import { PgSchemaIntrospection } from '../src/migration/migration.js';
import { requirePostgres, CONNECTION_STRING } from './__mocks__/test-setup.js';

// ============================================================================
// Test Configuration
// ============================================================================

const TEST_ID = 'has';
const ORGS_TABLE = `organizations_${TEST_ID}`;
const USERS_TABLE = `users_${TEST_ID}`;
const POSTS_TABLE = `posts_${TEST_ID}`;
const COMMENTS_TABLE = `comments_${TEST_ID}`;
const TAGS_TABLE = `tags_${TEST_ID}`;
const POST_TAGS_TABLE = `post_tags_${TEST_ID}`;
const EMPLOYEES_TABLE = `employees_${TEST_ID}`;

// ============================================================================
// Domain Models
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
  category: field.string().max(50), // 'tech', 'lifestyle', etc.
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
// E2E Tests
// ============================================================================

describe('has() Query Conditions E2E', { timeout: 30000 }, async () => {
  if (!await requirePostgres()) return;

  // Clear registry before tests
  ModelRegistry.clear();

  // Setup SQL connection for table management
  const sql = postgres(CONNECTION_STRING);

  // Create PgModels and Repositories
  const PgOrganization = createPgModel(Organization, { table: ORGS_TABLE, storageMode: 'columnar' });
  const PgUser = createPgModel(User, { table: USERS_TABLE, storageMode: 'columnar' });
  const PgPost = createPgModel(Post, { table: POSTS_TABLE, storageMode: 'columnar' });
  const PgComment = createPgModel(Comment, { table: COMMENTS_TABLE, storageMode: 'columnar' });
  const PgTag = createPgModel(Tag, { table: TAGS_TABLE, storageMode: 'columnar' });
  const PgPostTag = createPgModel(PostTag, { table: POST_TAGS_TABLE, storageMode: 'columnar' });
  const PgEmployee = createPgModel(Employee, { table: EMPLOYEES_TABLE, storageMode: 'columnar' });

  const OrgRepository = createPgRepository(PgOrganization);
  const UserRepository = createPgRepository(PgUser);
  const PostRepository = createPgRepository(PgPost);
  const CommentRepository = createPgRepository(PgComment);
  const TagRepository = createPgRepository(PgTag);
  const PostTagRepository = createPgRepository(PgPostTag);
  const EmployeeRepository = createPgRepository(PgEmployee);

  const PostgresClient = createPostgresClient({ connectionString: CONNECTION_STRING });

  // Application Services
  const PostService = defineService({
    inject: { posts: PostRepository, users: UserRepository },
    factory: ({ posts }) => ({
      async createPost(authorId: string, data: { title: string; content: string; status: string }) {
        return posts.insert({ ...data, author: User.ref`${authorId}` });
      },
      async findByAuthorName(name: string) {
        return posts.find({
          where: Post.fields.author.has(User.fields.name.eq(name)),
        });
      },
      async findByAuthorRole(role: string) {
        return posts.find({
          where: Post.fields.author.has(User.fields.role.eq(role)),
        });
      },
      async findPublishedByAuthorName(name: string) {
        return posts.find({
          where: q.and(Post.fields.status.eq('published'), Post.fields.author.has(User.fields.name.eq(name))),
        });
      },
    }),
  });

  const CommentService = defineService({
    inject: { comments: CommentRepository },
    factory: ({ comments }) => ({
      async findOnPostsByAdmins() {
        return comments.find({
          where: Comment.fields.post.has(
            Post.fields.author.has(
              User.fields.role.eq('admin')
            )
          ),
        });
      },
    }),
  });

  const EmployeeService = defineService({
    inject: { employees: EmployeeRepository },
    factory: ({ employees }) => ({
      async findByManagerDepartment(department: string) {
        return employees.find({
          where: Employee.fields.manager.has(Employee.fields.department.eq(department)),
        });
      },
    }),
  });

  // Build and compile app
  const app = JustScale()
    .add(InMemoryLockFeature)
    .add(InMemoryProcessFeature)
    .add(PostgresClient)
    .add(MemoryChannelBackend)
    .add(bindService(AbstractChannelBackend, MemoryChannelBackend))
    .add(ModelChangeChannels)
    .add(OrgRepository)
    .add(UserRepository)
    .add(PostRepository)
    .add(CommentRepository)
    .add(TagRepository)
    .add(PostTagRepository)
    .add(EmployeeRepository)
    .add(PostService)
    .add(CommentService)
    .add(EmployeeService)
    .build()
    .compile();

  await app.ready;

  // Resolve services - types are inferred!
  const container = app.container;
  const client = await container.resolve(PostgresClient);
  const orgRepo = await container.resolve(OrgRepository);
  const userRepo = await container.resolve(UserRepository);
  const postRepo = await container.resolve(PostRepository);
  const commentRepo = await container.resolve(CommentRepository);
  const tagRepo = await container.resolve(TagRepository);
  const postTagRepo = await container.resolve(PostTagRepository);
  const employeeRepo = await container.resolve(EmployeeRepository);
  const postService = await container.resolve(PostService);
  const commentService = await container.resolve(CommentService);
  const employeeService = await container.resolve(EmployeeService);

  // Create tables via syncSchema
  await new PgSchemaIntrospection(client).sync(PgOrganization, PgUser, PgPost, PgComment, PgTag, PgPostTag, PgEmployee);

  after(async () => {
    // Drop in reverse order of creation (respect foreign keys)
    await sql.unsafe(`DROP TABLE IF EXISTS ${POST_TAGS_TABLE}`);
    await sql.unsafe(`DROP TABLE IF EXISTS ${TAGS_TABLE}`);
    await sql.unsafe(`DROP TABLE IF EXISTS ${COMMENTS_TABLE}`);
    await sql.unsafe(`DROP TABLE IF EXISTS ${POSTS_TABLE}`);
    await sql.unsafe(`DROP TABLE IF EXISTS ${EMPLOYEES_TABLE}`);
    await sql.unsafe(`DROP TABLE IF EXISTS ${USERS_TABLE}`);
    await sql.unsafe(`DROP TABLE IF EXISTS ${ORGS_TABLE}`);
    await sql.end();
    await client.close();
  });

  beforeEach(async () => {
    // Delete in reverse order of creation (respect foreign keys)
    await sql.unsafe(`DELETE FROM ${POST_TAGS_TABLE}`);
    await sql.unsafe(`DELETE FROM ${TAGS_TABLE}`);
    await sql.unsafe(`DELETE FROM ${COMMENTS_TABLE}`);
    await sql.unsafe(`DELETE FROM ${POSTS_TABLE}`);
    await sql.unsafe(`DELETE FROM ${EMPLOYEES_TABLE}`);
    await sql.unsafe(`DELETE FROM ${USERS_TABLE}`);
    await sql.unsafe(`DELETE FROM ${ORGS_TABLE}`);
  });

  // -------------------------------------------------------------------------
  // Basic has() Tests
  // -------------------------------------------------------------------------

  it('should find posts by author name using has()', async () => {
    const john = await userRepo.insert({ name: 'John', email: 'john@example.com', role: 'admin', org: null as any });
    const jane = await userRepo.insert({ name: 'Jane', email: 'jane@example.com', role: 'user', org: null as any });

    await postRepo.insert({ title: 'John Post 1', content: 'Content', status: 'published', author: User.ref`${id(john)}` });
    await postRepo.insert({ title: 'John Post 2', content: 'Content', status: 'draft', author: User.ref`${id(john)}` });
    await postRepo.insert({ title: 'Jane Post', content: 'Content', status: 'published', author: User.ref`${id(jane)}` });

    const johnsPosts = await postService.findByAuthorName('John');

    assert.equal(johnsPosts.length, 2);
    assert.ok(johnsPosts.every((p) => p.title.startsWith('John')));
  });

  it('should find posts by author role using has()', async () => {
    const admin = await userRepo.insert({ name: 'Admin', email: 'admin@example.com', role: 'admin', org: null as any });
    const user1 = await userRepo.insert({ name: 'User1', email: 'user1@example.com', role: 'user', org: null as any });
    const user2 = await userRepo.insert({ name: 'User2', email: 'user2@example.com', role: 'user', org: null as any });

    await postRepo.insert({ title: 'Admin Post', content: 'Content', status: 'published', author: User.ref`${id(admin)}` });
    await postRepo.insert({ title: 'User1 Post', content: 'Content', status: 'published', author: User.ref`${id(user1)}` });
    await postRepo.insert({ title: 'User2 Post', content: 'Content', status: 'published', author: User.ref`${id(user2)}` });

    const userPosts = await postService.findByAuthorRole('user');

    assert.equal(userPosts.length, 2);
    assert.ok(userPosts.some((p) => p.title === 'User1 Post'));
    assert.ok(userPosts.some((p) => p.title === 'User2 Post'));
  });

  // -------------------------------------------------------------------------
  // Combined Conditions
  // -------------------------------------------------------------------------

  it('should combine has() with local field conditions', async () => {
    const john = await userRepo.insert({ name: 'John', email: 'john@example.com', role: 'admin', org: null as any });

    await postRepo.insert({ title: 'Published', content: 'Content', status: 'published', author: User.ref`${id(john)}` });
    await postRepo.insert({ title: 'Draft', content: 'Content', status: 'draft', author: User.ref`${id(john)}` });

    const publishedByJohn = await postService.findPublishedByAuthorName('John');

    assert.equal(publishedByJohn.length, 1);
    assert.equal(publishedByJohn[0].title, 'Published');
  });

  it('should use has() with multiple conditions on related model', async () => {
    const adminJohn = await userRepo.insert({ name: 'John', email: 'john@admin.com', role: 'admin', org: null as any });
    const userJohn = await userRepo.insert({ name: 'John', email: 'john@user.com', role: 'user', org: null as any });

    await postRepo.insert({ title: 'Admin John Post', content: 'Content', status: 'published', author: User.ref`${id(adminJohn)}` });
    await postRepo.insert({ title: 'User John Post', content: 'Content', status: 'published', author: User.ref`${id(userJohn)}` });

    const adminJohnPosts = await postRepo.find({
      where: Post.fields.author.has(q.and(User.fields.name.eq('John'), User.fields.role.eq('admin'))),
    });

    assert.equal(adminJohnPosts.length, 1);
    assert.equal(adminJohnPosts[0].title, 'Admin John Post');
  });

  // -------------------------------------------------------------------------
  // Nested has() (Multi-level relationships)
  // -------------------------------------------------------------------------

  it('should handle nested has() conditions', async () => {
    const john = await userRepo.insert({ name: 'John', email: 'john@example.com', role: 'admin', org: null as any });
    const post = await postRepo.insert({ title: 'Tech Post', content: 'Content', status: 'published', author: User.ref`${id(john)}` });

    await commentRepo.insert({ body: 'Great post!', post: Post.ref`${id(post)}`, author: User.ref`${id(john)}` });
    await commentRepo.insert({ body: 'Nice!', post: Post.ref`${id(post)}`, author: User.ref`${id(john)}` });

    const adminPostComments = await commentService.findOnPostsByAdmins();

    assert.equal(adminPostComments.length, 2);
  });

  // -------------------------------------------------------------------------
  // Self-Join Tests
  // -------------------------------------------------------------------------

  it('should handle self-referencing has() for manager hierarchy', async () => {
    const engineeringManager = await employeeRepo.insert({ name: 'Alice', department: 'Engineering' });
    const salesManager = await employeeRepo.insert({ name: 'Bob', department: 'Sales' });

    await employeeRepo.insert({ name: 'Charlie', department: 'Engineering', manager: Employee.ref`${id(engineeringManager)}` });
    await employeeRepo.insert({ name: 'Diana', department: 'Engineering', manager: Employee.ref`${id(engineeringManager)}` });
    await employeeRepo.insert({ name: 'Eve', department: 'Sales', manager: Employee.ref`${id(salesManager)}` });

    const engineeringTeam = await employeeService.findByManagerDepartment('Engineering');

    assert.equal(engineeringTeam.length, 2);
    assert.ok(engineeringTeam.some((e: any) => e.name === 'Charlie'));
    assert.ok(engineeringTeam.some((e: any) => e.name === 'Diana'));
  });

  // -------------------------------------------------------------------------
  // Deep Nesting (4 levels: Comment -> Post -> Author -> Organization)
  // -------------------------------------------------------------------------

  it('should handle 4-level deep nesting (Comment -> Post -> Author -> Org)', async () => {
    // Setup: Enterprise org with admin user who writes a post that gets comments
    const enterpriseOrg = await orgRepo.insert({ name: 'Acme Corp', tier: 'enterprise' });
    const startupOrg = await orgRepo.insert({ name: 'StartupXYZ', tier: 'startup' });

    const enterpriseAdmin = await userRepo.insert({
      name: 'John',
      email: 'john@acme.com',
      role: 'admin',
      org: Organization.ref`${id(enterpriseOrg)}`,
    });
    const startupUser = await userRepo.insert({
      name: 'Jane',
      email: 'jane@startup.xyz',
      role: 'user',
      org: Organization.ref`${id(startupOrg)}`,
    });

    const enterprisePost = await postRepo.insert({
      title: 'Enterprise Post',
      content: 'Content',
      status: 'published',
      author: User.ref`${id(enterpriseAdmin)}`,
    });
    const startupPost = await postRepo.insert({
      title: 'Startup Post',
      content: 'Content',
      status: 'published',
      author: User.ref`${id(startupUser)}`,
    });

    // Create comments on both posts
    await commentRepo.insert({ body: 'Comment on enterprise post', post: Post.ref`${id(enterprisePost)}`, author: User.ref`${id(enterpriseAdmin)}` });
    await commentRepo.insert({ body: 'Second comment on enterprise post', post: Post.ref`${id(enterprisePost)}`, author: User.ref`${id(startupUser)}` });
    await commentRepo.insert({ body: 'Comment on startup post', post: Post.ref`${id(startupPost)}`, author: User.ref`${id(startupUser)}` });

    // Find comments on posts by authors from enterprise orgs
    // Note: cast needed because org is optional, creating a union type
    const enterpriseComments = await commentRepo.find({
      where: Comment.fields.post.has(
        Post.fields.author.has(
          (User.fields.org as any).has(
            Organization.fields.tier.eq('enterprise')
          )
        )
      ),
    });

    assert.equal(enterpriseComments.length, 2);
    assert.ok(enterpriseComments.every((c: any) => c.body.includes('enterprise post')));
  });

  // -------------------------------------------------------------------------
  // Multiple has() on Different Refs in Same Query
  // -------------------------------------------------------------------------

  it('should handle multiple has() conditions on different refs', async () => {
    // Setup: Different authors for posts vs comments
    const admin = await userRepo.insert({ name: 'Admin', email: 'admin@example.com', role: 'admin', org: null as any });
    const user = await userRepo.insert({ name: 'User', email: 'user@example.com', role: 'user', org: null as any });
    const moderator = await userRepo.insert({ name: 'Mod', email: 'mod@example.com', role: 'moderator', org: null as any });

    const adminPost = await postRepo.insert({ title: 'Admin Post', content: 'Content', status: 'published', author: User.ref`${id(admin)}` });
    const userPost = await postRepo.insert({ title: 'User Post', content: 'Content', status: 'published', author: User.ref`${id(user)}` });

    // Admin comments on admin's post (admin writes both post and comment)
    await commentRepo.insert({ body: 'Admin commenting on admin post', post: Post.ref`${id(adminPost)}`, author: User.ref`${id(admin)}` });
    // User comments on admin's post
    await commentRepo.insert({ body: 'User commenting on admin post', post: Post.ref`${id(adminPost)}`, author: User.ref`${id(user)}` });
    // Admin comments on user's post
    await commentRepo.insert({ body: 'Admin commenting on user post', post: Post.ref`${id(userPost)}`, author: User.ref`${id(admin)}` });
    // Moderator comments on admin's post
    await commentRepo.insert({ body: 'Mod commenting on admin post', post: Post.ref`${id(adminPost)}`, author: User.ref`${id(moderator)}` });

    // Find comments where BOTH the post author AND comment author are admins
    const adminOnAdminComments = await commentRepo.find({
      where: q.and(
        Comment.fields.post.has(Post.fields.author.has(User.fields.role.eq('admin'))),
        Comment.fields.author.has(User.fields.role.eq('admin'))
      ),
    });

    assert.equal(adminOnAdminComments.length, 1);
    assert.equal(adminOnAdminComments[0].body, 'Admin commenting on admin post');
  });

  it('should handle OR with multiple has() conditions', async () => {
    const admin = await userRepo.insert({ name: 'Admin', email: 'admin@example.com', role: 'admin', org: null as any });
    const vip = await userRepo.insert({ name: 'VIP', email: 'vip@premium.com', role: 'user', org: null as any });
    const regular = await userRepo.insert({ name: 'Regular', email: 'reg@example.com', role: 'user', org: null as any });

    await postRepo.insert({ title: 'Admin Post', content: 'Content', status: 'published', author: User.ref`${id(admin)}` });
    await postRepo.insert({ title: 'VIP Post', content: 'Content', status: 'published', author: User.ref`${id(vip)}` });
    await postRepo.insert({ title: 'Regular Post', content: 'Content', status: 'published', author: User.ref`${id(regular)}` });

    // Find posts by admins OR by users with @premium.com email
    const priorityPosts = await postRepo.find({
      where: q.or(
        Post.fields.author.has(User.fields.role.eq('admin')),
        Post.fields.author.has(User.fields.email.like('%@premium.com'))
      ),
    });

    assert.equal(priorityPosts.length, 2);
    assert.ok(priorityPosts.some((p: any) => p.title === 'Admin Post'));
    assert.ok(priorityPosts.some((p: any) => p.title === 'VIP Post'));
  });

  // -------------------------------------------------------------------------
  // Multi-level Self-Joins (Manager -> Manager's Manager)
  // -------------------------------------------------------------------------

  it('should handle 2-level self-referencing has() (employee -> manager -> managers manager)', async () => {
    // Setup hierarchy: CEO -> VP -> Manager -> Employee
    const ceo = await employeeRepo.insert({ name: 'CEO', department: 'Executive' });
    const vpEngineering = await employeeRepo.insert({ name: 'VP Eng', department: 'Engineering', manager: Employee.ref`${id(ceo)}` });
    const vpSales = await employeeRepo.insert({ name: 'VP Sales', department: 'Sales', manager: Employee.ref`${id(ceo)}` });
    const engManager = await employeeRepo.insert({ name: 'Eng Manager', department: 'Engineering', manager: Employee.ref`${id(vpEngineering)}` });
    const salesManager = await employeeRepo.insert({ name: 'Sales Manager', department: 'Sales', manager: Employee.ref`${id(vpSales)}` });

    // Engineers and salespeople
    await employeeRepo.insert({ name: 'Dev 1', department: 'Engineering', manager: Employee.ref`${id(engManager)}` });
    await employeeRepo.insert({ name: 'Dev 2', department: 'Engineering', manager: Employee.ref`${id(engManager)}` });
    await employeeRepo.insert({ name: 'Sales Rep', department: 'Sales', manager: Employee.ref`${id(salesManager)}` });

    // Find employees whose manager's manager is in Executive department (i.e., reports to someone who reports to CEO)
    const reportsToVPs = await employeeRepo.find({
      where: Employee.fields.manager.has(
        Employee.fields.manager.has(
          Employee.fields.department.eq('Executive')
        )
      ),
    });

    // Should find engManager and salesManager (both report to VPs who report to CEO)
    assert.equal(reportsToVPs.length, 2);
    assert.ok(reportsToVPs.some((e: any) => e.name === 'Eng Manager'));
    assert.ok(reportsToVPs.some((e: any) => e.name === 'Sales Manager'));
  });

  // -------------------------------------------------------------------------
  // Many-to-Many via Junction Table
  // -------------------------------------------------------------------------

  it('should handle has() across junction tables (many-to-many)', async () => {
    const user = await userRepo.insert({ name: 'Author', email: 'author@example.com', role: 'user', org: null as any });

    // Create tags
    const techTag = await tagRepo.insert({ name: 'tech', category: 'technology' });
    const newsTag = await tagRepo.insert({ name: 'news', category: 'current-events' });
    const lifestyleTag = await tagRepo.insert({ name: 'lifestyle', category: 'lifestyle' });

    // Create posts
    const techPost = await postRepo.insert({ title: 'Tech Post', content: 'Tech content', status: 'published', author: User.ref`${id(user)}` });
    const newsPost = await postRepo.insert({ title: 'News Post', content: 'News content', status: 'published', author: User.ref`${id(user)}` });
    const mixedPost = await postRepo.insert({ title: 'Mixed Post', content: 'Mixed content', status: 'published', author: User.ref`${id(user)}` });

    // Associate posts with tags
    await postTagRepo.insert({ post: Post.ref`${id(techPost)}`, tag: Tag.ref`${id(techTag)}` });
    await postTagRepo.insert({ post: Post.ref`${id(newsPost)}`, tag: Tag.ref`${id(newsTag)}` });
    await postTagRepo.insert({ post: Post.ref`${id(mixedPost)}`, tag: Tag.ref`${id(techTag)}` });
    await postTagRepo.insert({ post: Post.ref`${id(mixedPost)}`, tag: Tag.ref`${id(lifestyleTag)}` });

    // Find post-tags that link to 'technology' category tags
    const techPostTags = await postTagRepo.find({
      where: PostTag.fields.tag.has(Tag.fields.category.eq('technology')),
    });

    assert.equal(techPostTags.length, 2); // tech post and mixed post both have tech tag
  });

  it('should combine has() on junction table with nested has()', async () => {
    // Find post-tags where the post is by an admin AND the tag is technology
    const admin = await userRepo.insert({ name: 'Admin', email: 'admin@example.com', role: 'admin', org: null as any });
    const user = await userRepo.insert({ name: 'User', email: 'user@example.com', role: 'user', org: null as any });

    const techTag = await tagRepo.insert({ name: 'tech', category: 'technology' });
    const newsTag = await tagRepo.insert({ name: 'news', category: 'current-events' });

    const adminTechPost = await postRepo.insert({ title: 'Admin Tech', content: 'Content', status: 'published', author: User.ref`${id(admin)}` });
    const adminNewsPost = await postRepo.insert({ title: 'Admin News', content: 'Content', status: 'published', author: User.ref`${id(admin)}` });
    const userTechPost = await postRepo.insert({ title: 'User Tech', content: 'Content', status: 'published', author: User.ref`${id(user)}` });

    await postTagRepo.insert({ post: Post.ref`${id(adminTechPost)}`, tag: Tag.ref`${id(techTag)}` });
    await postTagRepo.insert({ post: Post.ref`${id(adminNewsPost)}`, tag: Tag.ref`${id(newsTag)}` });
    await postTagRepo.insert({ post: Post.ref`${id(userTechPost)}`, tag: Tag.ref`${id(techTag)}` });

    // Find post-tags where post is by admin AND tag is technology
    const adminTechPostTags = await postTagRepo.find({
      where: q.and(
        PostTag.fields.post.has(Post.fields.author.has(User.fields.role.eq('admin'))),
        PostTag.fields.tag.has(Tag.fields.category.eq('technology'))
      ),
    });

    assert.equal(adminTechPostTags.length, 1);
  });

  // -------------------------------------------------------------------------
  // Complex Boolean Logic
  // -------------------------------------------------------------------------

  it('should handle complex AND/OR combinations with has()', async () => {
    const enterpriseOrg = await orgRepo.insert({ name: 'Enterprise', tier: 'enterprise' });
    const startupOrg = await orgRepo.insert({ name: 'Startup', tier: 'startup' });

    const enterpriseAdmin = await userRepo.insert({ name: 'EA', email: 'ea@enterprise.com', role: 'admin', org: Organization.ref`${id(enterpriseOrg)}` });
    const enterpriseUser = await userRepo.insert({ name: 'EU', email: 'eu@enterprise.com', role: 'user', org: Organization.ref`${id(enterpriseOrg)}` });
    const startupAdmin = await userRepo.insert({ name: 'SA', email: 'sa@startup.com', role: 'admin', org: Organization.ref`${id(startupOrg)}` });
    const startupUser = await userRepo.insert({ name: 'SU', email: 'su@startup.com', role: 'user', org: Organization.ref`${id(startupOrg)}` });

    await postRepo.insert({ title: 'EA Post', content: 'Content', status: 'published', author: User.ref`${id(enterpriseAdmin)}` });
    await postRepo.insert({ title: 'EU Post', content: 'Content', status: 'draft', author: User.ref`${id(enterpriseUser)}` });
    await postRepo.insert({ title: 'SA Post', content: 'Content', status: 'published', author: User.ref`${id(startupAdmin)}` });
    await postRepo.insert({ title: 'SU Post', content: 'Content', status: 'published', author: User.ref`${id(startupUser)}` });

    // Find posts that are: (enterprise AND admin) OR (published AND startup)
    // Note: cast needed because org is optional, creating a union type
    const complexResults = await postRepo.find({
      where: q.or(
        q.and(
          Post.fields.author.has((User.fields.org as any).has(Organization.fields.tier.eq('enterprise'))),
          Post.fields.author.has(User.fields.role.eq('admin'))
        ),
        q.and(
          Post.fields.status.eq('published'),
          Post.fields.author.has((User.fields.org as any).has(Organization.fields.tier.eq('startup')))
        )
      ),
    });

    // EA Post: enterprise + admin ✓
    // EU Post: enterprise + user (not admin) + draft (not published startup) ✗
    // SA Post: startup + published ✓
    // SU Post: startup + published ✓
    assert.equal(complexResults.length, 3);
    assert.ok(complexResults.some((p: any) => p.title === 'EA Post'));
    assert.ok(complexResults.some((p: any) => p.title === 'SA Post'));
    assert.ok(complexResults.some((p: any) => p.title === 'SU Post'));
  });

  // -------------------------------------------------------------------------
  // Edge Cases
  // -------------------------------------------------------------------------

  it('should return empty array when no matches', async () => {
    const john = await userRepo.insert({ name: 'John', email: 'john@example.com', role: 'admin', org: null as any });
    await postRepo.insert({ title: 'Post', content: 'Content', status: 'published', author: User.ref`${id(john)}` });

    const posts = await postService.findByAuthorName('NonExistent');

    assert.equal(posts.length, 0);
  });

  // -------------------------------------------------------------------------
  // SQL Generation Tests (Unit tests, no DB needed)
  // -------------------------------------------------------------------------

  it('should generate correct SQL with unique aliases', async () => {
    const compiler = new PgQueryCompiler({
      storageMode: 'columnar',
      tableName: POSTS_TABLE,
      fieldMap: { title: 'title', content: 'content', status: 'status', author: 'author_id' },
      modelContext: { modelName: 'Post', fieldDefs: getModelFields(Post) },
    });

    const condition = Post.fields.author.has(User.fields.name.eq('John'));
    const { text, values } = compiler.compileWhere(condition);

    assert.ok(text.includes('EXISTS'), 'SQL should contain EXISTS');
    assert.ok(text.includes(`${USERS_TABLE} AS`), 'SQL should use table alias');
    assert.ok(text.includes(`${POSTS_TABLE}.author_id`), 'SQL should reference source FK');
    assert.equal(values.length, 1);
    assert.equal(values[0], 'John');
  });

  it('should generate unique aliases for nested has() conditions', async () => {
    const compiler = new PgQueryCompiler({
      storageMode: 'columnar',
      tableName: COMMENTS_TABLE,
      fieldMap: { body: 'body', post: 'post_id', author: 'author_id' },
      modelContext: { modelName: 'Comment', fieldDefs: getModelFields(Comment) },
    });

    const condition = Comment.fields.post.has(Post.fields.author.has(User.fields.role.eq('admin')));
    const { text, values } = compiler.compileWhere(condition);

    assert.ok(text.includes(`${POSTS_TABLE}_1`), 'SQL should have posts alias');
    assert.ok(text.includes(`${USERS_TABLE}_2`), 'SQL should have users alias');
    assert.equal(values.length, 1);
    assert.equal(values[0], 'admin');
  });

  // Note: Self-join SQL generation is verified via E2E tests above:
  // - 'should handle self-referencing has() for manager hierarchy'
  // - 'should handle 2-level self-referencing has() (employee -> manager -> managers manager)'
  // The unit test is skipped because the lazy model reference used for self-referencing
  // doesn't register itself in the ModelRegistry in the same way as class-based models.
});
