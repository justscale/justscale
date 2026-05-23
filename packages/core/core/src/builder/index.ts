/**
 * Builder V2 Module
 *
 * Fluent builder API for creating apps with type-safe dependency tracking.
 *
 * @example
 * ```typescript
 * import JustScale, { bindRepository } from '@justscale/core'
 * import { ModelRepository } from '@justscale/core/models'
 *
 * const app = JustScale()
 *   .add(PgClient)
 *   .add(bindRepository(ModelRepository.of(User), PgUser))
 *   .add(UserService)
 *   .build()
 * ```
 */

// Types
export type {
  Token,
  AnyToken,
  Component,
  Builder,
  BuiltCluster,
  ServeOptions,
  RepositoryBinding,
  ServiceBinding,
  InstanceBinding,
  FeatureToken,
  FeatureMetadata,
  BuilderCallback,
  StartHook,
  StopHook,
  ProvidesOf,
  RequiresOf,
  RemoveFromTuple,
} from './types.js';

// Type guards
export {
  isServiceDef,
  isControllerDef,
  isRepositoryBinding,
  isServiceBinding,
  isInstanceBinding,
  isFeatureToken,
  isBuilderCallback,
  isComponentArray,
  FEATURE_TOKEN,
  FEATURE_META,
  REPO_BINDING,
  SERVICE_BINDING,
  INSTANCE_BINDING,
} from './types.js';

// Builder utilities
export { bindRepository, bindService, bindInstance } from './builder.js';

// Feature Builder
export {
  createFeatureBuilder,
  getFeatureMetadata,
  getFeatureRequirements,
  getFeatureName,
} from './feature-builder.js';
export type { FeatureBuilder } from './feature-builder.js';

// Validation
export {
  DependencyError,
  validateDependencies,
  buildDependencyGraph,
  findMissingDependencies,
  getTokenDescription,
  registerPluginProvides,
  getPluginProvides,
  registerImplicitService,
  getImplicitServices,
} from './validation.js';
export type {
  MissingDependency,
  DependencyGraph,
} from './validation.js';

// Topological Sort
export {
  topologicalSort,
  CycleError,
} from './sort.js';

// Stop Mechanism
export type { Stop } from './stop.js';
export { isStop, createStopFn } from './stop.js';

// Route Builder Types
export type {
  ExtractMiddlewareAdded,
  ExtractAddedFromMiddleware,
  ExtractStepDeps,
  ResponseEntry,
  ExtractStatuses,
  ExtractBodyForStatus,
  Step,
  UnresolvedStep,
  RouteDef,
  RouteBuilder,
  BuilderPlugin,
  // Permission-scoped returns
  PermissionDefLike,
  PermOf,
  BodyOf,
  NameOf,
  PermEntries,
  ToPermissionVariant,
  PermissionVariants,
} from './types.js';

// Plugin System
export { PLUGIN_SYMBOL, isPlugin, createPlugin } from './plugin.js';

// Route Builder Factory
export type { BuilderState } from './create-builder.js';
export { createBuilderState, createBaseBuilder } from './create-builder.js';

// Route Execution
export { executeRoute, executeSteps } from './execute.js';

// Plugins
export { query } from './plugins/query.js';
export { ValidationErrorSchema } from './plugins/validation.js';
