/**
 * @justscale/core/models
 *
 * Model definition and observable tracking for justscale.
 *
 * Provides:
 * - defineModel() - Define typed models with field schemas
 * - field - Field builders for model definitions
 * - Reference/References - Promise-like references to other models
 * - Persistent - Type helper for persisted models with storage fields
 * - createObservable() - Creates standalone observable with dirty tracking
 * - watch() - Watch for changes with callback or async iterator
 */

// Symbols
export {
  // Legacy observable symbols (kept for compatibility)
  MODEL_INTERNALS,
  OBSERVABLE_META,
  // Reference symbols (SET_RESOLVER exported from reference/reference.js)
  REFERENCE,
  REFERENCES,
  REF_ID,
  REF_IDS,
  REF_VALUE,
  REF_VALUES,
  REF_RESOLVER,
  // Transient reference symbols
  TRANSIENT_REF,
  TRANSIENT_TARGET,
  // Instance state symbols (runtime type safety)
  PERSISTENT,
  ADAPTER_KEY,
  LOCK,
  // Internal storage symbols
  FIELD_STORAGE,
  MODEL_CONTEXT,
  // ModelRepository token symbols
  MODEL_REPO_MODEL,
  MODEL_REPO_BASE_TOKEN,
  CREATE_MODEL_REPO,
  MODEL_REPO_CONTRACT,
  ACCESS_RULES,
} from './symbols.js';

export { filterByAccess, getAccessRules } from './access.js';

// Re-export REPO_TOKEN from repository for convenience
export { REPO_TOKEN } from './repository.js';

// Model definition symbols
export { MODEL_DEF, MODEL_FIELDS, MODEL_NAME, MODEL_DATA, MODEL_METHODS, MODEL_INJECT, MODEL_SERVICE } from './define-model.js';

// Types
export type {
  // Model types (legacy observable system)
  ModelInternals,
  Observable,
  ObservableInternals,
  ProxyMeta,
  ParentRef,
  // Entity types
  Entity,
  // System fields (SystemFields re-exported from model.repository.js below)
  SystemFieldKeys,
  // Domain/Mutable helpers
  DomainFields,
  Mutable,
  // Persistent/Lock types
  StorageMeta,
  Persistent,
  Locked,
  Ref,
  Lock,
  LockMetadata,
  Disposable,
  Transient,
} from './types.js';

// Type guards for runtime checks
export { isPersistent, isLocked, isTransient } from './types.js';

// ============================================================================
// Model Definition (defineModel)
// ============================================================================

// Define models with typed fields
export {
  BaseModel,
  defineModel,
  isModelClass,
  getModelFields,
  getModelName,
  registerModelForInjection,
  getModelsWithInject,
} from './define-model.js';

export type { FieldAccessRule, AccessRulesRecord, AccessFactory, StampPermissionNames } from './define-model.js';

export {
  registerModelByName,
  getModelByName,
  getModelNameRegistry,
} from './model-name-registry.js';

export { applyTypesConfig, registerModelRefResolver } from './apply-types-config.js';
export type { TypesConfig, TypedParams, ExtractParamNames, ExtractParams, ResolveParamType, Prettify } from './apply-types-config.js';

// Model definition types
export type {
  Model,
  ModelClass,
  ModelConstructor,
  ModelInstance,
  FieldDefs,
  InferModelType,
  MethodDefs,
  InferMethods,
  RepositoryContract,
  // Type extraction helpers (for cleaner .d.ts output)
  ModelData,
  ModelName,
  AnyModel,
} from './define-model.js';


// Field builders
export {
  field,
  isFieldDef,
  FIELD_DEF,
} from './field.js';

export type {
  FieldType,
  FieldDef,
  FieldBuilder,
  StringFieldBuilder,
  DecimalFieldBuilder,
  Decimal,
  ArrayFieldBuilder,
  ObjectFieldBuilder,
  RefFieldBuilder,
  RefsFieldBuilder,
  StreamFieldBuilder,
  InferField,
  InferFieldDef,
} from './field.js';

// Stream fields
export { STREAM, SET_STREAM_CHANNEL, SET_STREAM_SIGNAL_EMITTER, StreamImpl, isStream } from './stream.js';
export type { Stream } from './stream.js';

// Reference system
export { Reference, References, isReference, isReferences, SET_RESOLVER, HYDRATE } from './reference/reference.js';
export type { ReferenceResolver } from './reference/reference.js';

// Transient references (for unsaved entities)
export { TransientRef, isTransientRef } from './reference/transient-ref.js';

// Zod with z.ref() for Ref<T> validation
export { z, zRef } from './zod-ref.js';

// ============================================================================
// Observable & Model Instance (legacy)
// ============================================================================

// Model instance creation (internal - for defining models, use @justscale/live-model)
export { getModelInternals, isModel } from './model.js';

// Observable creation (from @justscale/observable)
export { createObservable, getObservableInternals, isObservable } from './observable.js';

// Proxy utilities (for advanced use/testing)
export { createTrackedProxy, getProxyMeta, isTrackedProxy } from './proxy.js';

// Watch functionality (from @justscale/observable)
export {
  type WatchAsyncIteratorOptions,
  type Watcher,
  type WatchHandle,
  watch,
} from './watch.js';

// ============================================================================
// Query System
// ============================================================================

// Query helpers namespace
export { q, CONDITION, AGGREGATION, isCondition, isAggregation, createFieldExpr, refId } from './query.js';

// Field expression classes
export {
  StringFieldExpr,
  NumberFieldExpr,
  BigIntFieldExpr,
  DecimalFieldExpr,
  BooleanFieldExpr,
  TimestampFieldExpr,
  UuidFieldExpr,
  EnumFieldExpr,
  RefFieldExpr,
  RefsFieldExpr,
  ArrayFieldExpr,
  JsonFieldExpr,
  ObjectFieldExpr,
} from './query.js';

// Condition types
export type {
  Condition,
  EqCondition,
  NeqCondition,
  GtCondition,
  GteCondition,
  LtCondition,
  LteCondition,
  LikeCondition,
  ILikeCondition,
  InCondition,
  NotInCondition,
  BetweenCondition,
  IsNullCondition,
  IsNotNullCondition,
  StartsWithCondition,
  EndsWithCondition,
  ContainsCondition,
  BeforeCondition,
  AfterCondition,
  AndCondition,
  OrCondition,
  NotCondition,
  HasCondition,
  RawCondition,
  ArrayContainsCondition,
  ArrayHasAnyCondition,
  ArrayHasAllCondition,
  ArrayOverlapsCondition,
} from './query.js';

// Aggregation types
export type {
  Aggregation,
  CountAggregation,
  SumAggregation,
  AvgAggregation,
  MinAggregation,
  MaxAggregation,
} from './query.js';

// Query option types
export type {
  OrderDirection,
  OrderBy,
  OrderByObject,
  OrderByItem,
  FindOptions,
  PageOptions,
  BatchOptions,
  Page,
  AggregateOptions,
  FieldExprForType,
} from './query.js';

// Order by helpers
export { ORDER_BY, isOrderByItem } from './query.js';

// Ref traversal (permission multi-hop)
export { isRefTraversal } from './query.js';
export type { RefTraversal } from './query.js';

// ============================================================================
// ModelRepository
// ============================================================================

export { ModelRepository, isModelRepositoryToken } from './model.repository.js';
export type { ModelRepositoryToken, SystemFields, InsertData, UpdateData, ExtractContract } from './model.repository.js';

// ============================================================================
// In-Memory Adapter
// ============================================================================

export {
  InMemoryRepository,
  InMemoryScheduledTaskRepository,
  createInMemoryModel,
  createInMemoryRepository,
} from './in-memory/index.js';

export type {
  InMemoryRepositoryOptions,
  InMemoryModel,
  InMemoryModelOptions,
  CreateRepositoryOptions,
} from './in-memory/index.js';

// ============================================================================
// Scheduled Tasks
// ============================================================================

export {
  ScheduledTask,
  ScheduledTaskStatus,
  ScheduledTaskRepository,
} from './scheduled-task/index.js';

export type {
  ScheduleOptions,
  SubscribeOptions,
} from './scheduled-task/index.js';
