/**
 * @justscale/postgres
 *
 * PostgreSQL adapter package for JustScale.
 *
 * Provides:
 * - PostgresClient - Connection pool with implicit transaction support
 * - PostgresLockProvider - Distributed locking (advisory + table strategies)
 * - PostgresPubSub - Real-time messaging via LISTEN/NOTIFY
 */

// Client
export {
  AbstractPostgresClient,
  type PostgresClientOptions,
  type PostgresClientDef,
  type TransactionOptions,
  type IsolationLevel,
  createPostgresClient,
  createRawPostgresClient,
  getCurrentTransactionContext,
} from './client/client.js';

// Lock Provider - raw PostgresLockProvider class is intentionally not
// re-exported; consumers wire the service (PostgresLockService or
// PostgresLockFeature). Internal tests that need the bare class can
// deep-import from './lock/lock-provider.js'.
export {
  PostgresLockService,
  PostgresLockFeature,
  createPostgresLockProvider,
  type PostgresLockProviderOptions,
  type LockStrategy,
  LockAcquisitionTimeoutError,
  DISTRIBUTED_LOCKS_MIGRATION,
  // Lock context (AsyncLocalStorage)
  withLockContext,
  isLockHeld,
  getLockMetadata,
  getCurrentLocks,
} from './lock/lock-provider.js';

// Pub/Sub - PostgresPubSub class is intentionally not re-exported; use
// createPostgresPubSub() factory or wire via PostgresChannelFeature.
export {
  createPostgresPubSub,
  type PostgresPubSubOptions,
  type MessageHandler,
  type Subscription,
} from './channel/pubsub.js';

// Channel Backend - raw PostgresChannelBackend class is intentionally not
// re-exported; consumers use the service via PostgresChannelFeature or
// createPostgresChannelBackend().
export {
  createPostgresChannelBackend,
  type PostgresChannelBackendOptions,
} from './channel/channel-backend.js';

// Canonical secret partial + infrastructure features
export { PostgresSecrets } from './secrets.js';
export {
  PostgresClientService,
  PostgresChannelBackendService,
  PostgresFeature,
  PostgresChannelFeature,
} from './feature.js';

// Config partials
export {
  PostgresProcessConfig,
  PostgresMigrationConfig,
  PostgresMigrationDevConfig,
} from './config.js';

// Env contributions
export {
  postgresProcessEnv,
  postgresMigrationEnv,
  postgresMigrationDevEnv,
  postgresSecret,
} from './env.js';

// Migration feature (prod subset - run/status/pending/rollback)
// Dev-only commands (make/fresh/verify) live under `@justscale/postgres/dev`.
export { MigrationController, MigrationService } from './migration/migration-controller.js';
export { PostgresMigrationFeature } from './migration/migration-feature.js';

// Utils
export { hashStringToBigInt, createLockKey, hashLockKey } from './utils/hash.js';

// Query Iterator (Durable iteration for process for-of loops)
export {
  PgQueryIterator,
  ProcessIntegrityError,
  generateKeysetWhereClause,
  createQueryHash,
  type KeysetCursor,
  type QueryBuilderLike,
} from './query/query-iterator.js';

// Query Builder (for durable iteration)
export { PgQueryBuilder } from './query/pg-query-builder.js';

// Query Compiler
export {
  PgQueryCompiler,
  type PgQueryCompilerOptions,
  type CompiledSql,
  type StorageMode,
  type ModelContext,
  type AliasContext,
} from './query/query-compiler.js';

// Model Registry (for has() condition support)
export {
  ModelRegistry,
  registerModel,
  type ModelRegistryEntry,
  type RefContext,
} from './model/model-registry.js';

// Repository
export {
  PgRepository,
  type PgRepositoryOptions,
  type Persistent,
  type CountResult,
  PG_CREATED_AT,
  PG_UPDATED_AT,
  PG_VERSION,
  type PgSystemFields,
  keyOf,
  versionOf,
} from './repository/pg-repository.js';

// Repository Service (DI-compatible)
export {
  createPgRepository,
  ModelChangeChannels,
  type Repository,
  type RepositoryServiceDef,
  type ModelChangeEvent,
} from './repository/pg-repository-service.js';

// DataLoader
export {
  DataLoader,
  type BatchLoadFn,
} from './query/dataloader.js';

// Model Factory
export {
  createPgModel,
  getRegisteredPgModels,
  type PgModelOptions,
  type PgModel,
  type AnyPgModel,
  type ColumnMeta,
  type ColumnOverride,
  type RelationConfig,
  type IndexConfig,
  type StorageConfig,
} from './model/pg-model.js';

// Migration (model-based schema sync)
//
// Note: `PgSchemaIntrospection.sync` / `.apply` are intentionally NOT re-exported
// from the top-level barrel. They bypass the file-based migration tracking in
// MigrationRunner and apply model->DB DDL directly, which is a footgun for
// production code (silent column drops on rename, no PR diff, no rollback
// record). They remain available from `@justscale/postgres/testing`.
export {
  printMigration,
  diffSchema,
  // Schema tracking (for PgModel-based sync)
  SchemaRunner,
  SchemaRunnerService,
  MIGRATIONS_TABLE_SQL,
  // SQL generators
  generateForeignKeySQL,
  generateJunctionTableSQL,
  generateEnumSQL,
  generateAddEnumValueSQL,
  // Types
  type Migration,
  type SchemaRecord,
  type SchemaChange,
  type ChangeType,
  type DbColumn,
  type DbIndex,
  type DbTableSchema,
  type DbForeignKey,
  type DbEnum,
} from './migration/migration.js';

// Migration Schema
export {
  defineMigration,
  migrationName,
  parseMigrationName,
  type Database,
  type MigrationDef,
  type MigrationContext,
  type TableColumns,
  type TableAlterationBuilder,
  type IndexOptions,
  type ForeignKeyOptions,
  type ReferentialAction,
} from './migration/migration-schema.js';

// Migration Snapshots (for type-safe seeders)
export {
  defineSnapshot,
  isSnapshot,
  SNAPSHOT_DEF,
  SNAPSHOT_TABLE,
  SNAPSHOT_FIELDS,
  type Snapshot,
  type SnapshotRepository,
} from './migration/migration-snapshot.js';

// Migration Database Implementation
export {
  PgDatabase,
  PgDatabaseService,
  PgDatabaseOps,
  PgDatabaseOpsService,
  createMigrationDatabase,
  createMigrationContext,
} from './pg-database.js';

// Migration Runner
export {
  MigrationRunner,
  MigrationRunnerService,
  createMigrationRunner,
  type MigrationRunnerOptions,
  type MigrationRecord,
  type MigrationStatus,
} from './migration/migration-runner.js';

// Migration registry (populated as a side effect of `defineMigration`)
export {
  getRegisteredMigrations,
  clearRegisteredMigrations,
} from './migration/migration-schema.js';

// Migration Generator
export {
  // Scaffold generation
  generateMigrationScaffold,
  generateMigrationCode,
  writeMigration,
  createMigration,
  createEmptyMigration,
  // Diff-based generation (class + DI service)
  PgMigrationGenerator,
  PgMigrationGeneratorService,
  // Seeder generation
  generateSeederScaffold,
  createSeederMigration,
  // Types
  type GenerateMigrationOptions,
  type WriteMigrationOptions,
  type DiffMigrationOptions,
  type DiffMigrationResult,
  type SeederScaffoldOptions,
} from './migration/migration-generator.js';

// Schema Introspection (class + DI service)
export {
  PgSchemaIntrospection,
  PgSchemaIntrospectionService,
  DestructiveMigrationError,
  type SyncOptions,
} from './migration/migration.js';

// Migration CLI Controller is re-exported above alongside the feature;
// `createMigrationController` factory removed - use PostgresMigrationFeature.

// SQL DDL AST
export {
  // Base
  DdlNode,
  // Nodes
  ColumnDef,
  CreateTable,
  DropTable,
  AlterTable,
  RenameTable,
  CreateIndex,
  DropIndex,
  CreateEnum,
  AlterEnumAddValue,
  DropType,
  AddForeignKey,
  DropConstraint,
  // Factory functions
  createTable,
  dropTable,
  createIndex,
  createEnum,
  addForeignKey,
  // Types
  type ColumnConstraint,
  type TableAlteration,
  type CreateIndexOptions,
  type ForeignKeyDef,
} from './sql/sql-ddl.js';

// Process Storage (PostgreSQL persistence for @justscale/process)
export {
  ProcessExecution,
  PgProcessExecution,
  ProcessExecutionRepository,
  createProcessStorage,
  PgProcessStorageService,
  PgSignalBusService,
  PostgresProcessFeature,
} from './process/process-storage.js';

// Process Signal Bus (PostgreSQL-backed signal routing) - raw PgSignalBus
// class is intentionally not re-exported; consumers wire PgSignalBusService
// (or more commonly, just add PostgresProcessFeature).
export {
  SignalSubscription,
  PgSignalSubscription,
  SignalSubscriptionRepository,
  createPgSignalBus,
  type PgSignalBusOptions,
} from './process/process-signal-bus.js';

// Scheduled Task Repository (PostgreSQL persistence for scheduled tasks)
export {
  PgScheduledTaskRepository,
  PgScheduledTaskRepositoryService,
  createPgScheduledTaskRepository,
  SCHEDULED_TASKS_MIGRATION,
  type PgScheduledTaskRepositoryOptions,
} from './repository/pg-scheduled-task.repository.js';

// SQL AST
export {
  // Namespace with enums
  Sql,
  // Base classes
  SqlNode,
  ExprNode,
  ConditionNode,
  StatementNode,
  // Expression nodes
  ColumnRef,
  JsonPath,
  Param,
  RawSql,
  NullLiteral,
  Aggregate,
  // Condition nodes
  Compare,
  IsNull,
  Between,
  InList,
  AnyArray,
  And,
  Or,
  Not,
  RawCondition,
  Exists,
  // Statement components
  SelectColumn,
  From,
  Join,
  OrderBy,
  Select,
  // Visitor
  type SqlVisitor,
  BaseSqlVisitor,
  // Factory functions
  col,
  json,
  param,
  raw,
  cmp,
  isNull,
  between,
  inList,
  and,
  or,
  not,
  exists,
  agg,
} from './sql/sql-ast.js';
