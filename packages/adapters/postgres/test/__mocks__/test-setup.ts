/**
 * Shared test setup utilities for postgres adapter E2E tests
 *
 * Requires postgres running via docker compose.
 * Each test suite uses unique table prefixes for isolation.
 */

import postgres from 'postgres';
import JustScale, { bindService, AbstractChannelBackend, MemoryChannelBackend } from '@justscale/core';
import { defineModel, field } from '@justscale/core/models';
import { InMemoryProcessFeature } from '@justscale/core/process';
import { InMemoryLockFeature } from '@justscale/core/memory';
import { createPostgresClient, type AbstractPostgresClient } from '../../src/client/client.js';
import { createPgModel } from '../../src/model/pg-model.js';
import { createPgRepository, ModelChangeChannels, type RepositoryServiceDef } from '../../src/repository/pg-repository-service.js';
import { ModelRegistry } from '../../src/model/model-registry.js';
import { PgSchemaIntrospection } from '../../src/migration/migration.js';

// =============================================================================
// Configuration
// =============================================================================

const BASE_CONNECTION_STRING =
  process.env.DATABASE_URL ?? `postgresql://justscale:justscale@localhost:${process.env.PGPORT ?? 5433}/justscale_test`;

export const CONNECTION_STRING = BASE_CONNECTION_STRING;

// =============================================================================
// PostgreSQL Availability Check
// =============================================================================

export async function checkPostgres(): Promise<boolean> {
  try {
    const sql = postgres(CONNECTION_STRING, { max: 1, connect_timeout: 3 });
    await sql`SELECT 1`;
    await sql.end();
    return true;
  } catch {
    return false;
  }
}

export async function requirePostgres(): Promise<boolean> {
  const available = await checkPostgres();
  if (!available) {
    const { test } = await import('node:test');
    test.skip(`PostgreSQL not available at ${CONNECTION_STRING}`, () => {});
    return false;
  }
  return true;
}

// =============================================================================
// Per-suite database isolation
// =============================================================================

/**
 * Create a fresh database for a test suite. Returns the connection string
 * and a cleanup function that drops the database.
 *
 * Usage:
 * ```ts
 * let db: TestDatabase;
 * before(async () => { db = await createTestDatabase('my_suite'); });
 * after(async () => { await db.drop(); });
 * // use db.connectionString everywhere
 * ```
 */
export interface TestDatabase {
  name: string
  connectionString: string
  drop: () => Promise<void>
}

export async function createTestDatabase(suiteName: string): Promise<TestDatabase> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const dbName = `test_${suiteName}_${suffix}`;

  const admin = postgres(CONNECTION_STRING, { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const connectionString = CONNECTION_STRING.replace(/\/[^/]+$/, `/${dbName}`);

  return {
    name: dbName,
    connectionString,
    async drop() {
      const adm = postgres(CONNECTION_STRING, { max: 1 });
      // Terminate other connections first
      await adm.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`,
      );
      await adm.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
      await adm.end();
    },
  };
}

// =============================================================================
// Common Test Models
// =============================================================================

export class User extends defineModel({
  email: field.string().max(255),
  name: field.string(),
  role: field.string().default('user'),
  balance: field.decimal(10, 2).default('0.00'),
}) {}

export class Post extends defineModel({
  title: field.string().max(255),
  content: field.text(),
  status: field.enum('PostStatus', ['draft', 'published', 'archived'] as const).default('draft'),
  author: field.ref(User),
}) {}

export class Comment extends defineModel({
  content: field.text(),
  post: field.ref(Post),
  author: field.ref(User),
}) {}

export class Employee extends defineModel({
  name: field.string().max(255),
  department: field.string(),
  manager: field.ref((): any => Employee).optional(),
}) {}

// =============================================================================
// PgModels
// =============================================================================

export function createTestModels(tablePrefix: string) {
  const PgUser = createPgModel(User, { table: `${tablePrefix}_users`, storageMode: 'columnar' });
  const PgPost = createPgModel(Post, { table: `${tablePrefix}_posts`, storageMode: 'columnar' });
  const PgComment = createPgModel(Comment, { table: `${tablePrefix}_comments`, storageMode: 'columnar' });
  const PgEmployee = createPgModel(Employee, { table: `${tablePrefix}_employees`, storageMode: 'columnar' });
  return { PgUser, PgPost, PgComment, PgEmployee };
}

export function createTestRepositories(models: ReturnType<typeof createTestModels>) {
  const { PgUser, PgPost, PgComment, PgEmployee } = models;
  return {
    UserRepository: createPgRepository(PgUser),
    PostRepository: createPgRepository(PgPost),
    CommentRepository: createPgRepository(PgComment),
    EmployeeRepository: createPgRepository(PgEmployee),
  };
}

// =============================================================================
// PostgresClient Service
// =============================================================================

export const PostgresClient = createPostgresClient({
  connectionString: CONNECTION_STRING,
});

// =============================================================================
// Test App Builder
// =============================================================================

export interface TestAppConfig {
  tablePrefix: string
}

export function createTestApp(config: TestAppConfig) {
  const models = createTestModels(config.tablePrefix);
  const repos = createTestRepositories(models);

  const built = JustScale()
    .add(InMemoryLockFeature)
    .add(InMemoryProcessFeature)
    .add(PostgresClient)
    .add(MemoryChannelBackend)
    .add(bindService(AbstractChannelBackend, MemoryChannelBackend))
    .add(ModelChangeChannels)
    .add(repos.UserRepository)
    .add(repos.PostRepository)
    .add(repos.CommentRepository)
    .add(repos.EmployeeRepository)
    .build();

  return { built, models, repos };
}

// =============================================================================
// Test Lifecycle Helpers
// =============================================================================

export interface TestContext {
  client: AbstractPostgresClient
  sql: ReturnType<typeof postgres>
  cleanup: () => Promise<void>
}

export async function setupTestContext(tablePrefix: string): Promise<TestContext> {
  ModelRegistry.clear();

  const sql = postgres(CONNECTION_STRING);
  const { built, models } = createTestApp({ tablePrefix });
  const app = built.compile();
  await app.ready;

  const client = await app.container.resolve(PostgresClient);
  await new PgSchemaIntrospection(client).sync(models.PgUser, models.PgPost, models.PgComment, models.PgEmployee);

  const cleanup = async () => {
    await sql.unsafe(`DROP TABLE IF EXISTS ${models.PgComment.table} CASCADE`);
    await sql.unsafe(`DROP TABLE IF EXISTS ${models.PgPost.table} CASCADE`);
    await sql.unsafe(`DROP TABLE IF EXISTS ${models.PgUser.table} CASCADE`);
    await sql.unsafe(`DROP TABLE IF EXISTS ${models.PgEmployee.table} CASCADE`);
    await sql.end();
    await client.close();
  };

  return { client, sql, cleanup };
}

export async function truncateTables(sql: ReturnType<typeof postgres>, tablePrefix: string) {
  await sql.unsafe(`TRUNCATE ${tablePrefix}_comments CASCADE`);
  await sql.unsafe(`TRUNCATE ${tablePrefix}_posts CASCADE`);
  await sql.unsafe(`TRUNCATE ${tablePrefix}_users CASCADE`);
  await sql.unsafe(`TRUNCATE ${tablePrefix}_employees CASCADE`);
}
