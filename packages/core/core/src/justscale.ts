/**
 * JustScale() - The main entry point for JustScale applications
 *
 * @module @justscale/core
 */

import { WeakRefSet } from 'weakrefset';
import type {
  AnyToken,
  Builder,
  Component,
  ProvidesOf,
  AddCheck,
  Token,
  RepositoryBinding,
  ServiceBinding,
  FeatureToken,
  BuilderCallback,
  ExtractControllers,
  InstanceBinding,
  CompileResult,
} from './builder/types.js';
import {
  isServiceDef,
  isControllerDef,
  isRepositoryBinding,
  isServiceBinding,
  isInstanceBinding,
  isFeatureToken,
  isBuilderCallback,
  isComponentArray,
  SERVICE_BINDING,
  INSTANCE_BINDING,
} from './builder/types.js';
import { isConfigComponent, type ConfigComponent } from './features/config/types.js';
import { Config } from './features/config/config-of.js';
import { isSecretComponent, type SecretComponent } from './features/secrets/types.js';
import { Secret } from './features/secrets/secret-of.js';
import { isFeatureFlagComponent, type FeatureFlagComponent } from './features/feature-flags/types.js';
import { FeatureFlag } from './features/feature-flags/feature-flag-of.js';
import { isEnvironment, type Environment } from './features/environment/types.js';
import { VAULT_KIND, type VaultKind } from './features/vault/types.js';
import type { ServiceDef } from './core/service.js';
import {
  getContributionDefault,
  getContributionParent,
  isContribution,
} from './core/contribution.js';
import type { ControllerDef, ControllerInstance } from './core/controller.js';
import { getImplicitServices, validateDependencies } from './builder/validation.js';
import { createAppInternal, type App } from './app.js';
import { createScopedBridge } from './core/scope-bridge.js';
import type { ServiceToken } from './core/service.js';
import type { ModelRepositoryToken } from './models/index.js';
import { Logger } from './core/logger.js';
import { Lifecycle } from './core/lifecycle.js';
import { LifecycleImpl } from './core/lifecycle-impl.js';
import { AbstractLockProvider, type Container } from './index.js';
import {
  ClusterServer,
  getRegisteredTransports,
  type ServeOptions,
} from './cluster/cluster.js';
import { createKernel, type Kernel } from './kernel/kernel.js';

// ============================================================================
// Built-in Tokens
// ============================================================================

export type BuiltInTokens = [typeof Logger, typeof Lifecycle];

// ============================================================================
// BuiltApp - Merged result of build()
// ============================================================================

/**
 * A built JustScale application.
 *
 * - `TProvided` - tokens the underlying builder registered via `.add()`.
 * - `TRequires` - tokens the underlying builder declared via `.requires()`.
 *   Empty by default; non-empty marks this as a sub-app that must be
 *   composed into a parent `JustScale()` before it can compile.
 */
export interface IBuiltApp<
  TProvided extends AnyToken[] = AnyToken[],
  TRequires extends AnyToken[] = [],
> {
  /** Access the underlying compiled App (same as compile()) */
  readonly app: CompileResult<TRequires, App<ExtractControllers<TProvided>>>
  /** All resolved controller instances */
  readonly controllers: ControllerInstance[]
  /** The DI container */
  readonly container: Container
  /** The cluster server (available after serve()) */
  readonly server: ClusterServer | null
  /** Socket path (available after serve()) */
  readonly socketPath: string | null
  /** Whether the app is currently serving */
  readonly isServing: boolean

  readonly __requires: TRequires

  compile(): CompileResult<TRequires, App<ExtractControllers<TProvided>>>

  /** Resolve a token from the container */
  resolve<T, C extends Record<string, (...args: any[]) => Promise<any>>>(token: ModelRepositoryToken<T, C>): Promise<import('./models/index.js').ModelRepository<T> & C>
  resolve<T, TDeps extends Record<string, ServiceToken<unknown>>>(token: import('./core/service.js').Service<T, TDeps>): Promise<T>
  resolve<T, TDeps extends Record<string, ServiceToken<unknown>>>(token: import('./core/service.js').ServiceDef<T, TDeps>): Promise<T>
  resolve<T>(token: ServiceToken<T>): Promise<T>
  resolve<T>(token: Token<T>): Promise<T>
  // Fallback for tokens reached via `as any` or other escape hatches — keeps the
  // resolution explicit about "I don't know what this returns" rather than latching
  // onto the first parameterised overload (RepositoryToken) and producing a misleading type.
  resolve(token: any): Promise<any>

  /** Start serving on the specified protocols */
  serve(options?: ServeOptions): Promise<void>

  /** Stop the app gracefully */
  stop(): Promise<void>
}

// ============================================================================
// Builder State
// ============================================================================

interface TokenOverride {
  token: AnyToken
  implementation: AnyToken
}

interface BuilderState {
  components: Component[]
  services: ServiceDef<any, any>[]
  controllers: ControllerDef<any>[]
  repoBindings: RepositoryBinding<any>[]
  serviceBindings: ServiceBinding<any>[]
  instanceBindings: InstanceBinding<any>[]
  features: FeatureToken<any, any>[]
  callbacks: BuilderCallback<any, any>[]
  overrides: TokenOverride[]
  configComponents: ConfigComponent[]
  secretComponents: SecretComponent[]
  featureFlagComponents: FeatureFlagComponent[]
  environment: Environment | null
  requires: AnyToken[]
  subApps: IBuiltApp<any, any>[]
}

function createState(): BuilderState {
  return {
    components: [],
    services: [],
    controllers: [],
    repoBindings: [],
    serviceBindings: [],
    instanceBindings: [],
    features: [],
    callbacks: [],
    overrides: [],
    configComponents: [],
    secretComponents: [],
    featureFlagComponents: [],
    environment: null,
    requires: [],
    subApps: [],
  };
}

function cloneState(state: BuilderState): BuilderState {
  return {
    components: [...state.components],
    services: [...state.services],
    controllers: [...state.controllers],
    repoBindings: [...state.repoBindings],
    serviceBindings: [...state.serviceBindings],
    instanceBindings: [...state.instanceBindings],
    features: [...state.features],
    callbacks: [...state.callbacks],
    overrides: [...state.overrides],
    configComponents: [...state.configComponents],
    secretComponents: [...state.secretComponents],
    featureFlagComponents: [...state.featureFlagComponents],
    environment: state.environment,
    requires: [...state.requires],
    subApps: [...state.subApps],
  };
}

/** Collects feature components during feature expansion. */
class FeatureBuilderCollector {
  constructor(private state: BuilderState) {}

  add(component: Component): FeatureBuilderCollector {
    if (component == null) {
      throw new TypeError(
        `Builder.add() received ${component === null ? 'null' : 'undefined'}. ` +
        'Check that the imported module exists and exports the expected component.'
      );
    }
    processComponent(this.state, component);
    return this;
  }
}

/**
 * If the service is a `createContribution()` result, ensure its parent
 * token's default aggregating service is registered in the state (once).
 */
function ensureContributionDefault(state: BuilderState, service: unknown): void {
  if (!isContribution(service)) return;
  const parent = getContributionParent(service as ServiceDef<unknown, any>);
  if (!parent) return;

  // Already bound? Skip - could be a custom monolithic provider via bindService.
  if (state.serviceBindings.some((b) => b.token === parent)) return;

  const defaultDef = getContributionDefault(parent);
  if (state.services.includes(defaultDef as unknown as ServiceDef<unknown, any>)) return;

  // Register the default service AND bind it to the user's subclass
  // (parent = the subclass the user wrote via `abstract class X extends defineContribution(...)`).
  state.services.push(defaultDef as unknown as ServiceDef<unknown, any>);
  state.components.push(defaultDef as unknown as Component);
  state.serviceBindings.push({
    [SERVICE_BINDING]: true,
    token: parent as unknown as never,
    implementation: defaultDef as unknown as never,
  });
}

/**
 * Resolves inject deps, runs the factory, validates each returned value
 * against its partial's schema, and registers the result under the partial's symbol key.
 */
async function runPartialComponents(
  components: ReadonlyArray<{
    readonly provides: ReadonlyArray<{ key: symbol; name: string; schema: { parse: (v: unknown) => unknown } }>
    readonly inject: Record<string, unknown>
    readonly factory: (deps: Record<string, unknown>) => Record<symbol, any> | Promise<Record<symbol, any>>
  }>,
  container: { resolve: (token: any) => Promise<unknown>; registerInstance: (token: any, value: unknown) => void },
): Promise<void> {
  for (const component of components) {
    const entries = await Promise.all(
      Object.entries(component.inject).map(async ([key, token]) =>
        [key, await container.resolve(token)] as const,
      ),
    );
    const deps = Object.fromEntries(entries);
    const values = await component.factory(deps);

    const schemaByKey = new Map<symbol, { parse: (v: unknown) => unknown }>();
    for (const partial of component.provides) {
      schemaByKey.set(partial.key, partial.schema);
    }

    for (const key of Object.getOwnPropertySymbols(values)) {
      const raw = (values as Record<symbol, unknown>)[key];
      const schema = schemaByKey.get(key);
      const validated = schema ? schema.parse(raw) : raw;
      container.registerInstance(key, validated);
    }
  }
}

function processComponent(state: BuilderState, component: Component): void {
  state.components.push(component);

  if (component instanceof BuiltApp) {
    state.subApps.push(component as IBuiltApp<any, any>);
    return;
  }

  if (isControllerDef(component)) {
    state.controllers.push(component);
  } else if (isServiceDef(component)) {
    state.services.push(component);
    // If this service contributes to a multi-impl token, ensure the default
    // aggregator for that token is registered too (once). Without this, the
    // contribution would have nowhere to call `.register()` on.
    ensureContributionDefault(state, component);
  } else if (isRepositoryBinding(component)) {
    state.repoBindings.push(component);
  } else if (isServiceBinding(component)) {
    state.serviceBindings.push(component);
  } else if (isInstanceBinding(component)) {
    state.instanceBindings.push(component);
  } else if (isFeatureToken(component)) {
    state.features.push(component);
    const featureBuilder = new FeatureBuilderCollector(state);
    component(featureBuilder as any);
  } else if (isBuilderCallback(component)) {
    state.callbacks.push(component);
  } else if (isComponentArray(component)) {
    for (const item of component) {
      processComponent(state, item);
    }
  } else if (isConfigComponent(component)) {
    state.configComponents.push(component);
  } else if (isSecretComponent(component)) {
    state.secretComponents.push(component);
  } else if (isFeatureFlagComponent(component)) {
    state.featureFlagComponents.push(component);
  } else if (isEnvironment(component)) {
    applyEnvironment(state, component);
  }
}

/**
 * Enforce vault policy, then push env services and providers through processComponent.
 */
function applyEnvironment(state: BuilderState, env: Environment): void {
  const disallow = new Set<VaultKind>(env.vaultPolicy.disallow ?? []);
  const warn = new Set<VaultKind>(env.vaultPolicy.warn ?? []);

  for (const svc of env.services) {
    const kind = (svc as unknown as { [VAULT_KIND]?: VaultKind })[VAULT_KIND];
    if (kind && disallow.has(kind)) {
      throw new Error(
        `Environment '${env.name}' (type '${env.type}') disallows vault kind '${kind}'. ` +
        'Swap for a production-safe vault (EnvVarVault, KubernetesVault, HashiCorpVault) ' +
        'or explicitly opt in via vaultPolicy.',
      );
    }
    if (kind && warn.has(kind)) {
       
      console.warn(
        `[justscale] Environment '${env.name}' wires vault kind '${kind}' under a warn policy. ` +
        'This should not be used in production.',
      );
    }
  }

  if (state.environment && state.environment.name !== env.name) {
    throw new Error(
      'Only one environment may be registered per app. Already registered: ' +
      `'${state.environment.name}' (type '${state.environment.type}'). ` +
      `Attempted to register: '${env.name}' (type '${env.type}').`,
    );
  }
  state.environment = env;

  for (const svc of env.services) processComponent(state, svc);
  for (const provider of env.providers) processComponent(state, provider);
}

// ============================================================================
// Builder Implementation
// ============================================================================

class BuilderImpl<
  TProvided extends AnyToken[] = [],
  TRequires extends AnyToken[] = [],
> implements Builder<TProvided, TRequires> {
  constructor(private state: BuilderState = createState()) {}

  add<C extends Component>(
    component: AddCheck<C, TProvided>,
  ): Builder<[...TProvided, ...ProvidesOf<C>], TRequires> {
    if (component == null) {
      throw new TypeError(
        `Builder.add() received ${component === null ? 'null' : 'undefined'}. ` +
        'Check that the imported module exists and exports the expected component.'
      );
    }
    const newState = cloneState(this.state);
    processComponent(newState, component as C);
    return new BuilderImpl(newState) as any;
  }

  addControllers(
    controllers: ReadonlyArray<ControllerDef<any>>,
  ): Builder<TProvided, TRequires> {
    const newState = cloneState(this.state);
    for (const controller of controllers) {
      if (controller == null) {
        throw new TypeError(
          'Builder.addControllers() received a null/undefined entry. ' +
          'Check that all CLI controllers discovered from packages are defined.',
        );
      }
      processComponent(newState, controller as Component);
    }
    return new BuilderImpl(newState) as any;
  }

  override<TToken extends TProvided[number], TImpl extends AnyToken>(
    token: TToken,
    implementation: TImpl,
  ): Builder<any, TRequires> {
    const newState = cloneState(this.state);
    newState.overrides.push({ token, implementation });
    return new BuilderImpl(newState) as any;
  }

  requires<T extends AnyToken>(
    token: T,
  ): Builder<[...TProvided, T], [...TRequires, T]> {
    const newState = cloneState(this.state);
    newState.requires.push(token as AnyToken);
    return new BuilderImpl(newState) as any;
  }

  build(): IBuiltApp<TProvided, TRequires> {
    const additionalProvides: AnyToken[] = [];
    for (const component of this.state.configComponents) {
      for (const partial of component.provides) {
        additionalProvides.push(Config.of(partial) as any);
      }
    }
    for (const component of this.state.secretComponents) {
      for (const partial of component.provides) {
        additionalProvides.push(Secret.of(partial) as any);
      }
    }
    for (const component of this.state.featureFlagComponents) {
      for (const partial of component.provides) {
        additionalProvides.push(FeatureFlag.of(partial) as any);
      }
    }
    for (const token of this.state.requires) {
      additionalProvides.push(token);
    }

    const subAppRequires: AnyToken[] = [];
    for (const sub of this.state.subApps) {
      const subRequires = (sub as unknown as { __requires?: AnyToken[] }).__requires;
      if (subRequires) subAppRequires.push(...subRequires);
    }

    const alreadyBound = new Set<AnyToken>(
      this.state.services as unknown as AnyToken[],
    );
    for (const binding of this.state.serviceBindings) {
      alreadyBound.add(binding.token as AnyToken);
    }
    for (const binding of this.state.instanceBindings) {
      alreadyBound.add(binding.token as AnyToken);
    }
    for (const [abstractToken, implicitService] of getImplicitServices()) {
      if (alreadyBound.has(implicitService as unknown as AnyToken)) continue;
      if (alreadyBound.has(abstractToken)) continue;
      this.state.services.push(implicitService);
      this.state.components.push(implicitService as unknown as Component);
    }

    validateDependencies(
      this.state.services,
      this.state.repoBindings,
      this.state.serviceBindings,
      this.state.instanceBindings,
      this.state.features,
      {
        additionalProvides,
        additionalRequires: subAppRequires,
      }
    );

    const builtApp = new BuiltApp<TProvided, TRequires>(this.state);
    apps.add(builtApp);
    return builtApp;
  }
}

// ============================================================================
// BuiltApp Implementation
// ============================================================================

class BuiltApp<
  TProvided extends AnyToken[] = AnyToken[],
  TRequires extends AnyToken[] = [],
> implements IBuiltApp<TProvided, TRequires> {
  private _app: App<ExtractControllers<TProvided>> | null = null;
  private _server: ClusterServer | null = null;
  private _socketPath: string | null = null;
  private _isServing = false;
  private _kernel: Kernel | null = null;
  private lifecycle: LifecycleImpl | null = null;
  private _parentBuildContext: import('./builder/build-context.js').BuildContext | null = null;

  constructor(private state: BuilderState) {}

  /** @internal */
  _inheritBuildContext(ctx: import('./builder/build-context.js').BuildContext): void {
    if (this._app) {
      throw new Error(
        'Sub-app already compiled - cannot inherit build context. ' +
        '_inheritBuildContext must be called before compile.',
      );
    }
    this._parentBuildContext = ctx;
  }

  get __requires(): TRequires {
    return this.state.requires as unknown as TRequires;
  }

  /** @internal */
  async __attachBridgesFrom(parentContainer: Container): Promise<void> {
    if (this._app) {
      throw new Error(
        'Sub-app already compiled - cannot attach bridges. ' +
        '__attachBridgesFrom must be called before compile.',
      );
    }
    for (const token of this.state.requires) {
      const bridge = await createScopedBridge(
        parentContainer,
        token as ServiceToken<object>,
      );
      this.state.instanceBindings.push({
        [INSTANCE_BINDING]: true,
        token: token as any,
        instance: bridge,
      });
    }
  }

  /** @internal */
  _maybeCompiledApp(): App<ExtractControllers<TProvided>> | null {
    return this._app;
  }

  private compileInternal(): App<ExtractControllers<TProvided>> {
    if (this._app) {
      return this._app;
    }

    this.lifecycle = new LifecycleImpl();

    const configComponents = this.state.configComponents;
    const secretComponents = this.state.secretComponents;
    const featureFlagComponents = this.state.featureFlagComponents;

    const subApps = this.state.subApps;

    this._app = createAppInternal({
      services: this.state.services,
      controllers: this.state.controllers,
      _beforeControllerResolution: (container) => {
        container.setLifecycle(this.lifecycle!);

        for (const binding of this.state.repoBindings) {
          if (isServiceDef(binding.implementation)) {
            container.registerFor(binding.token as any, binding.implementation as any);
          } else {
            container.registerInstance(binding.token as any, binding.implementation);
          }
        }
        for (const binding of this.state.serviceBindings) {
          container.registerFor(binding.token as any, binding.implementation as any);
        }
        for (const binding of this.state.instanceBindings) {
          container.registerInstance(binding.token as any, binding.instance);
        }
        for (const override of this.state.overrides) {
          container.registerFor(override.token as any, override.implementation as any);
        }
      },
      _asyncBeforeControllerResolution: async (container) => {
        await runPartialComponents(configComponents, container);
        await runPartialComponents(secretComponents, container);
        await runPartialComponents(featureFlagComponents, container);
      },
      _getMatchDelegates: () =>
        subApps
          .map((sub) => (sub as unknown as BuiltApp<any, any>)._maybeCompiledApp())
          .filter((a): a is App<any> => a !== null),
      _parentBuildContext: this._parentBuildContext ?? undefined,
    }) as App<ExtractControllers<TProvided>>;

    if (this.state.subApps.length > 0) {
      const parentReady = this._app.ready;
      const parentApp = this._app;
      const subAppsLocal = this.state.subApps;
      const chained = parentReady.then(async () => {
        for (const sub of subAppsLocal) {
          const subImpl = sub as unknown as BuiltApp<any, any>;
          if (subImpl._maybeCompiledApp()) continue;
          if (parentApp.__buildContext) {
            subImpl._inheritBuildContext(parentApp.__buildContext);
          }
          await subImpl.__attachBridgesFrom(parentApp.container);
          await subImpl.compileInternal().ready;
        }
      });
      (this._app as { ready: Promise<void> }).ready = chained;
    }

    return this._app;
  }

  compile(): CompileResult<TRequires, App<ExtractControllers<TProvided>>> {
    return this.compileInternal() as CompileResult<
      TRequires,
      App<ExtractControllers<TProvided>>
    >;
  }

  get app(): CompileResult<TRequires, App<ExtractControllers<TProvided>>> {
    return this.compileInternal() as CompileResult<
      TRequires,
      App<ExtractControllers<TProvided>>
    >;
  }

  get controllers(): ControllerInstance[] {
    return this.compileInternal().controllers;
  }

  get container(): Container {
    return this.compileInternal().container;
  }

  get match() {
    return this.compileInternal().match;
  }

  get execute() {
    return this.compileInternal().execute;
  }

  resolve<T, C extends Record<string, (...args: any[]) => Promise<any>>>(token: ModelRepositoryToken<T, C>): Promise<import('./models/index.js').ModelRepository<T> & C>;
  resolve<T, TDeps extends Record<string, ServiceToken<unknown>>>(token: import('./core/service.js').Service<T, TDeps>): Promise<T>;
  resolve<T, TDeps extends Record<string, ServiceToken<unknown>>>(token: import('./core/service.js').ServiceDef<T, TDeps>): Promise<T>;
  resolve<T>(token: ServiceToken<T>): Promise<T>;
  resolve<T>(token: Token<T>): Promise<T>;
  resolve(token: any): Promise<any>;
  resolve(token: unknown): Promise<unknown> {
    return this.compileInternal().container.resolve(token as ServiceToken);
  }

  get server(): ClusterServer | null {
    return this._server;
  }

  get socketPath(): string | null {
    return this._socketPath;
  }

  get isServing(): boolean {
    return this._isServing;
  }

  async serve(options: ServeOptions = {}): Promise<void> {
    if (this._isServing) {
      throw new Error('App is already serving');
    }

    const app = this.compileInternal();
    await app.ready;

    if (!options.noSocket) {
      this._server = new ClusterServer({
        socketPath: options.socketPath,
      });
      this._server.attachApp(app);

      for (const transport of getRegisteredTransports()) {
        if (transport.registerHandlers) {
          transport.registerHandlers(this._server, app);
        }
      }

      this._socketPath = await this._server.listen();
    }

    // Start remaining legacy transports (scheduled-task, cli cluster).
    for (const transport of getRegisteredTransports()) {
      if (transport.onServe) {
        await transport.onServe(this as any, options);
      }
    }

    // Start adapters (HTTP, and future protocols) via the kernel.
    // Kernel owns adapter dedup, requires resolution, and stop ordering.
    // Signal handling is left to `defineApp` so library consumers
    // that call serve() directly don't get unexpected process-level handlers.
    this._kernel = createKernel({ app, signals: false });
    await this._kernel.start();

    this._isServing = true;
  }

  async stop(): Promise<void> {
    if (this._kernel) {
      await this._kernel.stop();
      this._kernel = null;
    } else if (this.lifecycle) {
      await this.lifecycle.runHook('stop');
    }

    for (const transport of getRegisteredTransports()) {
      if (transport.onStop) {
        await transport.onStop(this as any);
      }
    }

    if (this._server) {
      await this._server.close();
      this._server = null;
      this._socketPath = null;
    }

    this._isServing = false;
  }
}

// ============================================================================
// JustScale Namespace
// ============================================================================

const apps = new WeakRefSet<IBuiltApp<any, any>>();

async function shutdown(): Promise<void> {
  const stopPromises: Promise<void>[] = [];
  for (const app of apps) {
    if (app.isServing) {
      stopPromises.push(app.stop());
    }
  }
  await Promise.all(stopPromises);
}

export interface JustScaleFunction {
  /** Create a new app builder */
  (): Builder<BuiltInTokens>
  /** All apps created in this Node process */
  readonly apps: WeakRefSet<IBuiltApp<any, any>>
  /** Graceful shutdown of all apps */
  shutdown(): Promise<void>
}

const JustScale: JustScaleFunction = Object.assign(
  function JustScale(): Builder<BuiltInTokens> {
    return new BuilderImpl() as unknown as Builder<BuiltInTokens>;
  },
  {
    apps,
    shutdown,
  }
);

export default JustScale;

export type { IBuiltApp as BuiltApp };
