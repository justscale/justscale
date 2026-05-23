/**
 * @justscale/core
 */

// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="./process/serialization.global.d.ts" />

import './process/serialization.js';
import './process/builtin-serializers.js';

export { default } from './justscale.js';
export { default as JustScale } from './justscale.js';
export type { JustScaleFunction, BuiltApp } from './justscale.js';

export {
  Container,
  defineService,
  defineAbstract,
  defineContribution,
  createContribution,
  isContribution,
  isContributionToken,
  getContributionDefault,
  getContributionParent,
  CONTRIBUTION_MARKER,
  CONTRIBUTION_DEFAULT,
  CONTRIBUTES_TO,
  Logger,
  ConsoleLogger,
  ConsoleLoggerFactory,
  getMinLogLevel,
  setMinLogLevel,
  getContext,
  captureContext,
  runWithContext,
  withContext,
  registerInstrumentation,
  unregisterInstrumentation,
  getInstrumentations,
  runInScope,
  runInScopeAsync,
  getContainer,
  requireContainer,
  runWithContainer,
  getRequestContext,
  getRequestChain,
  runWithRequestContext,
  runInFullRequestScope,
  runInFullRequestScopeSync,
  pushScope,
  addToSet,
  setInMap,
  disposable,
  asyncDisposable,
  combineDisposables,
  SERVICE_PROVIDES,
  SERVICE_ID,
  AbstractContainer,
} from './core/index.js';
export type {
  ContainerReflection,
  ControllerWhere,
} from './core/container-reflection.js';
export type {
  ServiceToken,
  ServiceClass,
  AbstractClass,
  ServiceDef,
  Service,
  ServiceFactory,
  Resolver,
  InstanceOf,
  ResolvedDeps,
  ExtractDeps,
  ExtractAllDeps,
  CollectAllDeps,
  ValidateDeps,
  // Logger types
  LoggerFactory,
  LogAttributes,
  LogLevel,
  // Observability types
  ObservabilityContext,
  LinkedContext,
  Instrumentation,
  ScopeInfo,
  // Request context types
  RequestType,
  RequestContext,
  RequestScopeOptions,
  AccessPrincipal,
} from './core/index.js';

export {
  getAccessPrincipals,
  runWithPrincipals,
  enterWithPrincipals,
} from './core/index.js';

export {
  Lifecycle,
  isLifecycleToken,
  LIFECYCLE_TOKEN,
} from './core/index.js';
export type { LifecycleHooks } from './core/index.js';

export { createController, createContextualController, registerBuiltinProvider, registerContextualFactory, Procedure, CONTRACT_CONTROLLER } from './core/index.js';
export type {
  ContextualRouteFactories,
  ControllerDef,
  ControllerInstance,
  CompiledRoute,
  ControllerSettings,
  TransportContext,
  ReservedContextKeys,
  ValidateDepsNoConflict,
  HandlerContext,
  NormalizeSettings,
  BuiltinContext,
  BuiltinProvider,
  BuiltinProviderContext,
  ContextualControllerDef,
  ContextualControllerBuilder,
  ContextualControllerInstance,
  Session,
  SessionOptions,
  ProcedureRequest,
  ProcedureHandlerContext,
  ProcedureBuilder,
  ProcedureDef,
  ProcedureContext,
  RunOptions,
  RequestStatus,
  RawMessageSource,
  CompiledProcedure,
  ContractControllerDef,
  ContractControllerInstance,
  CompiledRpcMethod,
} from './core/index.js';

export {
  ProcedureNotFoundError,
  GuardDeniedError,
  TimeoutError,
} from './core/index.js';

export {
  registerRouteFactory,
  createRouteFactories,
} from './core/index.js';
export type {
  SupportedMethods,
  RouteMethod,
  MethodMetadata,
  GetMethodMetadata,
  MethodHasBody,
  MethodsForTransport,
  RouteHandler,
  RouteFactories,
  RouteContext,
  BaseContext,
  RouteBuilder,
  ExtractParams,
  Prettify,
} from './core/index.js';

export {
  createMiddleware,
  createGuard,
  isMiddlewareDef,
  isGuardDef,
  MIDDLEWARE_DEF_MARKER,
  GUARD_DEF_MARKER,
  GUARD_DEF_SOURCE,
} from './core/index.js';
export type {
  Middleware,
  Guard,
  MiddlewareDef,
  GuardDef,
  UnresolvedMiddleware,
  UnresolvedGuard,
  MiddlewareAdded,
  MiddlewareInput,
  GuardInput,
} from './core/index.js';

export type { App, MatchedRoute, ExecuteOptions } from './app.js';

export type { Adapter } from './kernel/adapter.js';
export type { BuildContext } from './builder/build-context.js';
export { currentBuilder } from './builder/build-context.js';

export {
  LockServiceDef,
  AbstractLockProvider,
  LockAcquisitionError,
  DoubleLockError,
  LockReleasedError,
  InvalidLockKeyError,
  runWithLockTracking,
  getHeldLocks,
  isLocked,
  _registerHeldLock,
  _unregisterHeldLock,
} from './features/lock/index.js';
export type {
  Lock,
  LockMetadata,
  LockOptions,
  LockProvider,
  LockService,
} from './features/lock/index.js';

export { Repository, REPO_TOKEN, REPO_BRAND, isRepositoryToken } from './models/repository.js';
export type { RepositoryToken } from './models/repository.js';

export {
  bindRepository,
  bindService,
  bindInstance,
  createFeatureBuilder,
  getFeatureMetadata,
  getFeatureRequirements,
  getFeatureName,
} from './builder/index.js';

export type {
  Token,
  AnyToken,
  Component,
  Builder,
  BuiltCluster,
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
  FeatureBuilder,
} from './builder/index.js';

export type { ServeOptions } from './cluster/cluster.js';

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
} from './builder/index.js';

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
} from './builder/index.js';
export {
  registerOpenApiMethod,
  getOpenApiMethodMapping,
  getRegisteredOpenApiMethods,
  type OpenApiMethodMapping,
} from './core/openapi-methods.js';
export type {
  MissingDependency,
  DependencyGraph,
} from './builder/index.js';

export {
  topologicalSort,
  CycleError,
} from './builder/index.js';

export type { Stop } from './builder/index.js';
export { isStop, createStopFn } from './builder/index.js';

export type {
  ExtractMiddlewareAdded,
  ExtractAddedFromMiddleware,
  ExtractStepDeps,
  ResponseEntry,
  ExtractStatuses,
  ExtractBodyForStatus,
  Step,
  RouteDef as RouteDefV2,
  RouteBuilder as RouteBuilderV2,
  BuilderPlugin,
  PermissionDefLike,
  PermOf,
  BodyOf,
  NameOf,
  PermEntries,
  ToPermissionVariant,
  PermissionVariants,
} from './builder/index.js';

export { PLUGIN_SYMBOL, isPlugin, createPlugin } from './builder/index.js';

export type { BuilderState } from './builder/index.js';
export { createBuilderState, createBaseBuilder } from './builder/index.js';

export { executeRoute, executeSteps } from './builder/index.js';

export { query, ValidationErrorSchema } from './builder/index.js';

export {
  ChannelFeature,
  createChannels,
  AbstractChannelBackend,
  MemoryChannelBackend,
  createChannel,
} from './features/channel/index.js';

export type {
  ChannelsDef,
  ChannelBackend,
  ChannelBackendInstance,
  BackendSubscription,
  Channel,
  ChannelSubscription,
  ChannelsInstance,
  ChannelsOptions,
  ChannelHooks,
  ChannelInternal,
} from './features/channel/index.js';

export {
  defineContract,
  rpc,
  getContractMetadata,
  defineMessage,
  simpleMessage,
  CONTRACT_METADATA,
  CONTRACT_ID,
  ContractBase,
} from './features/contract/index.js';

export type {
  Contract,
  AnyContract,
  ExtractContract,
  ContractMetadata,
  StreamingMode,
  MessageSchema,
  ProtoSchema,
  MessageType,
  MessageConfig,
  FieldDescriptor,
  RpcMethodDef,
  RpcMethodBuilder,
  RpcContext,
  StreamingRpcContext,
  UnaryHandler,
  ServerStreamHandler,
  ClientStreamHandler,
  BidiStreamHandler,
  MethodHandler,
  ContractMethods,
  MethodInput,
  MethodOutput,
  MethodStreaming,
  ContractImplementation,
} from './features/contract/index.js';

export {
  CONFIG_PARTIAL,
  isConfigPartial,
  isConfigComponent,
  defineConfigPartial,
  Config,
  createConfig,
  ConfigServiceDef,
} from './features/config/index.js';

export type {
  ConfigPartial,
  ConfigComponent,
  ConfigToken,
  ConfigService,
} from './features/config/index.js';

export {
  SECRET_PARTIAL,
  isSecretPartial,
  isSecretComponent,
  defineSecretPartial,
  Secret,
  createSecretProvider,
  SecretServiceDef,
} from './features/secrets/index.js';

export type {
  SecretPartial,
  SecretComponent,
  SecretToken,
  SecretService,
} from './features/secrets/index.js';

export {
  FEATURE_FLAG_PARTIAL,
  isFeatureFlagPartial,
  isFeatureFlagComponent,
  defineFeatureFlagPartial,
  FeatureFlag,
  createFeatureFlagProvider,
  FeatureFlagServiceDef,
} from './features/feature-flags/index.js';

export type {
  FeatureFlagPartial,
  FeatureFlagComponent,
  FeatureFlagToken,
  FeatureFlagService,
} from './features/feature-flags/index.js';

export {
  config,
  secret,
  flag,
  fromVault,
  buildProviders,
} from './features/env/contribute.js';

export type {
  EnvContribution,
  ConfigContribution,
  ConfigSource,
  SecretContribution,
  FlagContribution,
} from './features/env/contribute.js';

export {
  AbstractVaultClient,
  VAULT_KIND,
  HardcodedVault,
  EnvVarVault,
  KubernetesVault,
  HashiCorpVault,
} from './features/vault/index.js';

export type {
  VaultClient,
  VaultKind,
} from './features/vault/index.js';

export {
  ENVIRONMENT,
  ENVIRONMENT_TYPES,
  DEFAULT_VAULT_POLICY,
  isEnvironment,
  createEnvironment,
  loadEnvironment,
  detectEnvironmentName,
  isEnvironmentType,
  __registerStaticEnvironment,
} from './features/environment/index.js';

export type {
  Environment,
  EnvironmentType,
  EnvContract,
  Env,
  RegisteredConfigPartials,
  RegisteredSecretPartials,
  RegisteredFlagPartials,
  VaultPolicy,
  VaultPolicyRules,
  VaultAllowedIn,
  ServiceCompatibleWithEnv,
  LoadEnvironmentOptions,
} from './features/environment/index.js';

export {
  InMemoryProcessStorage,
  AbstractProcessStorage,
} from './runtime/process/storage.js';
export type { ProcessStorage } from './runtime/process/storage.js';

export {
  setHmrContainer,
  __getHmrState,
  __validateHmrState,
  __wrapHmrStateForSave,
  __hmrPatchMethods,
  __hmrFullReload,
  __hmrAvailable,
} from './core/hmr.js';

export { getServiceId, getServiceProvides, getServiceIdValue, getServiceStableId, SERVICE_STABLE_ID } from './core/service.js';
export { CONTAINER_DEV } from './core/service.js';
export type { ContainerDevExtensions } from './core/service.js';

export { onContainerReady, runContainerReadyHooks } from './core/container-hooks.js';
export type { ContainerReadyHook } from './core/container-hooks.js';

export { getCurrentApp } from './cli/current-app.js';
export type { CurrentApp } from './cli/current-app.js';

export { defineProject, isProjectConfig } from './cli/define-project.js';
export type { ProjectConfig, BuildConfig, EnvironmentConfig } from './cli/define-project.js';
export { defineMain } from './cli/define-main.js';
export { defineApp } from './cli/define-app.js';
export type { DefinedApp, AppFactory } from './cli/define-app.js';

export { Queue, createQueue } from './queue/index.js';
