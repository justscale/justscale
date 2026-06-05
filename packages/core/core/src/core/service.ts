/**
 * Dependency Injection System
 *
 * Uses TypeScript's type system to ensure all dependencies are provided at compile time.
 */

import {
  Logger,
  LoggerFactory,
  isLoggerToken,
} from './logger.js';
import { PinoLoggerFactory, loggerConfigFromEnv } from './pino-logger.js';
import {
  isLifecycleToken,
} from './lifecycle.js';
import type { LifecycleImpl } from './lifecycle-impl.js';
import { pushScope } from './disposable.js';
import { type RepositoryToken } from '../models/repository.js';
import { __wrapHmrStateForSave } from './hmr.js';
import { getModelsWithInject } from '../models/define-model.js';
import { MODEL_INJECT, MODEL_SERVICE } from '../models/symbols.js';

// ============================================================================
// Core Types
// ============================================================================

/** A service class constructor */
export type ServiceClass<T = unknown> = new (...args: never[]) => T;

/** An abstract class constructor (can be used as a DI token) */
export type AbstractClass<T = unknown> = abstract new (...args: never[]) => T;

/** A resolver function for resolving additional dependencies */
export interface Resolver {
  <T>(token: ServiceToken<T>): Promise<T>;
  /** Update an already-resolved instance in the container at runtime (available when resolved via Container) */
  registerInstance?<T>(token: ServiceToken<T>, instance: T): void;
}

/** A service factory function */
export type ServiceFactory<TDeps, TInstance> = (deps: TDeps, resolve: Resolver) => TInstance;

/** Object with deps and factory - duck-typed service definition (used by processes) */
export interface ServiceLike<T = unknown> {
  readonly deps: Record<string, unknown>
  readonly factory: (resolvedDeps: Record<string, unknown>) => T
}

/**
 * A resolvable token - carries its own resolution logic.
 * Used by Config.of / Secret.of / FeatureFlag.of, which look up a value in
 * the container under a partial's symbol key.
 */
export interface ResolvableToken<T = unknown> {
  readonly description: string
  readonly key: symbol
  resolve(container: { get(key: symbol): T }): T
}

/** Token to identify a service - a class, abstract class, ServiceDef, Service, ServiceLike (processes), RepositoryToken, or ResolvableToken */
export type ServiceToken<T = unknown> = ServiceClass<T> | AbstractClass<T> | ServiceDef<T, any> | Service<T, any> | ServiceLike<T> | RepositoryToken<T> | ResolvableToken<T>;

/** Extracts the instance type from a service token */
export type InstanceOf<T> =
  T extends ServiceClass<infer I> ? I :
    T extends AbstractClass<infer I> ? I :
      T extends ServiceDef<infer I, any> ? I :
        T extends Service<infer I, any> ? I :
          T extends ServiceLike<infer I> ? I :
            T extends RepositoryToken<any, infer TInstance> ? TInstance :
              T extends ResolvableToken<infer I> ? I :
                never;

/** Maps a deps record to resolved instance types */
export type ResolvedDeps<T extends Record<string, ServiceToken>> = {
  [K in keyof T]: InstanceOf<T[K]>;
};

// ============================================================================
// Abstract Class Definition
// ============================================================================

/**
 * Define an abstract class for use as a DI token.
 *
 * Use `abstract class MyAbstract extends defineAbstract<MyInterface>() {}`
 * to create a clean abstract class that serves as a DI token.
 *
 * @example
 * ```typescript
 * // Define the interface
 * interface ProcessStorage {
 *   save(state: ProcessState): Promise<void>
 *   load(instanceId: string): Promise<ProcessState | null>
 * }
 *
 * // Create abstract class as DI token
 * export abstract class AbstractProcessStorage extends defineAbstract<ProcessStorage>() {}
 *
 * // Implementation uses defineService with provides
 * export class InMemoryProcessStorage extends defineService({
 *   inject: {},
 *   provides: [AbstractProcessStorage],
 *   factory: () => ({ ... })
 * }) {}
 * ```
 */
export function defineAbstract<T>(name?: string): AbstractClass<T> {
  function AbstractImpl(this: unknown) {
    // Only throw if instantiated directly, not via a subclass extending this
    // new.target is the constructor that was directly invoked with 'new'
    if (new.target === AbstractImpl) {
      throw new Error(`${name ?? 'Abstract class'} cannot be instantiated directly. Use container.resolve() instead.`);
    }
  }
  if (name) {
    Object.defineProperty(AbstractImpl, 'name', { value: name, configurable: true });
  }
  return AbstractImpl as unknown as AbstractClass<T>;
}

// ============================================================================
// Service Definition
// ============================================================================

/** Symbol for provides metadata */
export const SERVICE_PROVIDES = Symbol('justscale:serviceProvides');

/** Symbol for unique ServiceDef ID (legacy counter-based) */
export const SERVICE_ID = Symbol('justscale:serviceId');

/** Symbol for stable service ID (file path + export name, injected by compiler) */
export const SERVICE_STABLE_ID = Symbol('justscale:serviceStableId');

/** @internal Symbol key for dev-time extension surface on Container. */
export const CONTAINER_DEV = Symbol('justscale:containerDev');

/** @internal Dev-time extension surface for HMR and tooling. */
export interface ContainerDevExtensions {
  /** Is `token` a registered service def in this container? */
  hasServiceDef(token: unknown): boolean
  /** Map a `<relPath>#<exportName>` ID to an already-registered token. */
  registerStableId(stableId: string, token: unknown): void
  /**
   * Swap the runtime behaviour backing `token` in-place. Objects get
   * their keys merged; functions get their indirection proxy retargeted.
   * See `Container.replaceInstanceImpl`.
   */
  replaceInstance<T>(
    token: unknown,
    newFactory: (deps: Record<string, unknown>, resolve: unknown) => T | Promise<T>,
  ): Promise<void>
}

const SERVICE_ID_COUNTER = Symbol.for('justscale:serviceIdCounter');
const _global = globalThis as { [SERVICE_ID_COUNTER]?: number };
_global[SERVICE_ID_COUNTER] = _global[SERVICE_ID_COUNTER] ?? 0;

/** Get next unique ID (global) */
function nextServiceId(): number {
  return ++_global[SERVICE_ID_COUNTER]!;
}

/** Read the SERVICE_PROVIDES tokens from a service definition. */
export function getServiceProvides(obj: unknown): ServiceToken[] | undefined {
  return (obj as Record<symbol, unknown>)?.[SERVICE_PROVIDES] as ServiceToken[] | undefined;
}

/** Read the SERVICE_ID counter value from a service definition. */
export function getServiceIdValue(obj: unknown): number | undefined {
  return (obj as Record<symbol, unknown>)?.[SERVICE_ID] as number | undefined;
}

/** Read the SERVICE_STABLE_ID from a service definition. */
export function getServiceStableId(obj: unknown): string | undefined {
  return (obj as Record<symbol, unknown>)?.[SERVICE_STABLE_ID] as string | undefined;
}

/**
 * Get the stable service ID from a token, if available.
 * Returns the compiler-injected ID or falls back to a generated one.
 */
export function getServiceId(token: ServiceToken): string {
  const stableId = getServiceStableId(token);
  if (stableId) {
    return stableId;
  }

  const counterId = getServiceIdValue(token);
  const name = typeof token === 'function' ? token.name : 'Service';
  if (counterId !== undefined) {
    return `${name}#${counterId}`;
  }

  return name || 'Anonymous';
}

/** The definition of a service - carries deps in its type */
export interface ServiceDef<
  TInstance,
  TDeps extends Record<string, ServiceToken> = Record<string, ServiceToken>
> {
  readonly __brand: unique symbol;
  readonly deps: TDeps;
  readonly factory: ServiceFactory<ResolvedDeps<TDeps>, TInstance>;
  /**
   * Optional runtime metadata: what class tokens this ServiceDef provides.
   * Used by runtime validation to check if dependencies are satisfied.
   * E.g., PostgresClient provides AbstractPostgresClient.
   */
  readonly [SERVICE_PROVIDES]?: ServiceToken[];
  /**
   * Unique ID for this ServiceDef instance (legacy counter-based).
   * Used to match ServiceDefs across module instances.
   */
  readonly [SERVICE_ID]?: number;
  /**
   * Stable service ID (file path + export name).
   * Injected by compiler in dev mode for HMR support.
   * E.g., 'src/services/user.ts#UserService'
   */
  readonly [SERVICE_STABLE_ID]?: string;
}

// ============================================================================
// defineService - Class-based service definition (preserves names in .d.ts)
// ============================================================================

/**
 * A service "class" created by defineService.
 * Use `class MyService extends defineService({...}) {}` to preserve
 * type names in .d.ts output instead of inlining the full type.
 */
export interface Service<
  T,
  TDeps extends Record<string, ServiceToken> = Record<string, ServiceToken>
> {
  /** Constructor signature - makes it extendable (never actually called) */
  new (): T;

  /** Runtime properties for DI */
  readonly deps: TDeps;
  readonly factory: ServiceFactory<ResolvedDeps<TDeps>, T>;

  /** Unique ID for cross-module matching (legacy counter-based) */
  readonly [SERVICE_ID]?: number;

  /** Optional runtime metadata: what class tokens this Service provides */
  readonly [SERVICE_PROVIDES]?: ServiceToken[];

  /**
   * Stable service ID (file path + export name).
   * Injected by compiler in dev mode for HMR support.
   */
  readonly [SERVICE_STABLE_ID]?: string;
}

/**
 * Define a service class.
 *
 * Use `class MyService extends defineService({...}) {}` pattern
 * to preserve type names in .d.ts output. This prevents TypeScript
 * from inlining the full service type everywhere it's referenced.
 *
 * @example
 * ```typescript
 * // The class name "UserService" is preserved in .d.ts
 * export class UserService extends defineService({
 *   inject: { users: UserRepository },
 *   factory: ({ users }) => ({
 *     register: async (email, password) => {...},
 *     findById: async (id) => {...},
 *   })
 * }) {}
 *
 * container.register(UserService)
 * const users = container.resolve(UserService)
 *
 * // Auto-bind to abstract class
 * export class InMemoryStorage extends defineService({
 *   inject: {},
 *   provides: [AbstractStorage],  // Auto-binds!
 *   factory: () => ({ ... })
 * }) {}
 * ```
 */
export function defineService<
  const TDeps extends Record<string, ServiceToken>,
  TInstance
>(config: {
  inject: TDeps;
  factory: ServiceFactory<ResolvedDeps<TDeps>, TInstance>;
  /** Optional: tokens this service provides (auto-binds to abstract classes) */
  provides?: ServiceToken[];
  /**
   * Stable service ID for HMR support.
   * Injected by compiler in dev mode: 'src/services/user.ts#UserService'
   * @internal
   */
  __serviceId?: string;
}): Service<Awaited<TInstance>, TDeps> {
  const id = nextServiceId();

  // Create a class-like object that TypeScript treats as extendable
  // The constructor is never called - it's purely for type-level extends
  function ServiceImpl() {
    throw new Error('Service classes should not be instantiated directly. Use container.resolve() instead.');
  }

  // Attach static properties for DI resolution
  ServiceImpl.deps = config.inject;
  ServiceImpl.factory = config.factory;
  (ServiceImpl as any)[SERVICE_ID] = id;

  // Set SERVICE_PROVIDES if provided
  if (config.provides && config.provides.length > 0) {
    (ServiceImpl as any)[SERVICE_PROVIDES] = config.provides;
  }

  // Set stable service ID if provided (compiler-injected in dev mode)
  if (config.__serviceId) {
    (ServiceImpl as any)[SERVICE_STABLE_ID] = config.__serviceId;
  }

  return ServiceImpl as unknown as Service<Awaited<TInstance>, TDeps>;
}

// ============================================================================
// Dependency Extraction (for type-level validation)
// ============================================================================

/** Extract all dependency tokens from a service definition */
export type ExtractDeps<T> =
  T extends ServiceDef<any, infer D> ? D[keyof D] :
    T extends Service<any, infer D> ? D[keyof D] :
      never;

/** Extract deps from an array of services */
export type ExtractAllDeps<T extends ServiceToken[]> = ExtractDeps<T[number]>;

/** Recursively collect ALL dependencies (transitive) */
export type CollectAllDeps<T extends ServiceToken> =
  T extends ServiceDef<any, infer D>
    ? T | CollectAllDeps<D[keyof D]>
    : T extends Service<any, infer D>
      ? T | CollectAllDeps<D[keyof D]>
      : T;

// ============================================================================
// Container
// ============================================================================

/**
 * Get a human-readable name for a service token.
 */
function getTokenName(token: ServiceToken): string {
  if (typeof token === 'function') {
    return token.name || 'Anonymous';
  }
  // ServiceDef - try to find a meaningful name
  return 'Service';
}

/**
 * Thrown when `Container.resolve` detects a cycle in the dependency graph
 * (e.g. A injects B and B injects A). The message lists the cycle in the
 * order it was walked: `"Circular dependency: A -> B -> A"`.
 *
 * Without this, a direct cycle would recurse into `resolveInternal`
 * synchronously until the engine throws `RangeError: Maximum call stack
 * size exceeded`, which gives no information about *which* services are
 * involved.
 */
export class CircularDependencyError extends Error {
  constructor(public readonly path: string[]) {
    super(`Circular dependency: ${path.join(' -> ')}`);
    this.name = 'CircularDependencyError';
  }
}

export class Container {
  private instances = new Map<ServiceToken, unknown>();
  private factories = new Map<ServiceToken, ServiceDef<unknown, any>>();
  /** Map from SERVICE_ID to the registered ServiceDef */
  private factoriesById = new Map<number, ServiceDef<unknown, any>>();
  /** Map from stable service ID to token (for HMR lookup) */
  private tokensByStableId = new Map<string, ServiceToken>();
  /** Resolved deps for each service (for HMR method patching) */
  private resolvedDeps = new Map<ServiceToken, Record<string, unknown>>();
  /** HMR state registry (keyed by service ID, holds state between reloads) */
  private hmrStateRegistry = new Map<string, unknown>();
  /**
   * Backing boxes for function-type service instances. Values stored
   * here are the MUTABLE `{ current }` cells that the public proxy
   * delegates to via its `apply` / `get` / `set` traps. Key is the
   * proxy reference that we handed to callers; mutating
   * `box.current` transparently re-routes every future call.
   *
   * Present only for function-type instances - object instances don't
   * need indirection because we can mutate them in place via
   * `Object.assign`.
   */
  private indirectionBoxes = new WeakMap<object, { current: (...args: unknown[]) => unknown }>();
  /** Map of in-flight resolution promises to prevent duplicate instantiation during concurrent resolution */
  private pending = new Map<ServiceToken, Promise<unknown>>();

  /**
   * Tokens currently being constructed (between entering resolveInternal
   * and the factory returning). Used to detect A->B->A cycles that the
   * `pending` map alone would not catch, because `pending` is populated
   * *after* the recursive dep walk - a synchronous cycle never hits it.
   * Tracked as an ordered list so we can report the full path on error.
   */
  private resolving: ServiceToken[] = [];

  /**
   * Current resolution context stack.
   * Tracks which service is being resolved for contextual Logger creation.
   */
  private resolutionStack: string[] = [];

  /**
   * Logger factory for creating contextual loggers.
   * Can be replaced to use a custom logger implementation.
   */
  // Default backend: env-seeded pino (structured JSON to stdout, no worker
  // thread). Always works during bootstrap before any binding is resolved.
  // Swapped for an app-bound LoggerFactory in resolveBoundLoggerFactory().
  private loggerFactory: LoggerFactory = new PinoLoggerFactory(loggerConfigFromEnv());

  /**
   * Lifecycle instance for hook registration.
   * Set by the cluster builder during compile.
   */
  private lifecycle: LifecycleImpl | null = null;

  /**
   * Set the lifecycle instance (called by cluster builder during compile).
   * This wires up the Lifecycle built-in token.
   */
  setLifecycle(lifecycle: LifecycleImpl): void {
    this.lifecycle = lifecycle;
  }

  /** Register a service class (no deps, instantiated with new) */
  registerClass<T>(token: ServiceClass<T>): this {
    this.instances.set(token, new token());
    return this;
  }

  /** Register a service definition (ServiceDef or Service class) */
  register<T, D extends Record<string, ServiceToken>>(def: ServiceDef<T, D> | Service<T, D>): this {
    this.factories.set(def, def as ServiceDef<unknown, any>);
    // Also register by ID for cross-module lookup
    const id = getServiceIdValue(def);
    if (id !== undefined) {
      this.factoriesById.set(id, def as ServiceDef<unknown, any>);
    }
    return this;
  }

  /** Register a service definition under a specific token (e.g., abstract class) */
  registerFor<T, D extends Record<string, ServiceToken>>(
    token: ServiceToken<T>,
    def: ServiceDef<T, D> | Service<T, D>
  ): this {
    this.factories.set(token, def as ServiceDef<unknown, any>);
    return this;
  }

  /** Register an already-created instance */
  registerInstance<T>(token: ServiceToken<T>, instance: T): this {
    this.instances.set(token, instance);
    return this;
  }

  /**
   * Symbol-keyed "dev extensions" - bundles all the extension-point
   * methods dev tooling needs into one non-polluting surface.
   * Consumers (e.g. `@justscale/hmr`) do:
   *
   *   import { CONTAINER_DEV } from '@justscale/core';
   *   const dev = container[CONTAINER_DEV];
   *   dev.replaceInstance(token, newFactory);
   *
   * Nothing on the public `Container` shape mentions HMR or replace
   * semantics - those live behind the symbol so they don't show up in
   * normal autocomplete.
   */
  get [CONTAINER_DEV](): ContainerDevExtensions {
    return {
      hasServiceDef: (token: unknown) => this.factories.has(token as ServiceToken),
      registerStableId: (stableId: string, token: unknown) => {
        this.tokensByStableId.set(stableId, token as ServiceToken);
      },
      replaceInstance: <T>(
        token: ServiceToken<T>,
        newFactory: ServiceFactory<Record<string, unknown>, T>,
      ) => this.replaceInstanceImpl(token, newFactory),
    };
  }

  /**
   * If a factory returned a function (rather than an object with
   * methods), wrap it in a Proxy that delegates through a mutable box.
   * `replaceInstance` can then re-point the box at a new function, and
   * every consumer holding the proxy invokes the new behaviour.
   *
   * For object instances this is a no-op - they get mutated in place
   * via `Object.assign` instead, so no indirection is needed.
   *
   * Cost at call time is one `Proxy.apply` trap per invocation, which
   * is noise for typical service workloads. In the hypothetical case
   * where a hot inner loop invokes a function-type service millions of
   * times, the overhead would matter; we accept it for the benefit of
   * uniform replace-in-place semantics.
   */
  private wrapIfFunction<T>(instance: T): T {
    if (typeof instance !== 'function') return instance;
    const box = { current: instance as unknown as (...args: unknown[]) => unknown };
    const proxy = new Proxy(instance as unknown as (...args: unknown[]) => unknown, {
      apply(_t, thisArg, args) {
        return box.current.apply(thisArg, args);
      },
      get(_t, prop, receiver) {
        return Reflect.get(box.current, prop, receiver);
      },
      set(_t, prop, value, receiver) {
        return Reflect.set(box.current, prop, value, receiver);
      },
      has(_t, prop) {
        return Reflect.has(box.current, prop);
      },
    }) as unknown as T;
    this.indirectionBoxes.set(proxy as unknown as object, box);
    return proxy;
  }

  /**
   * Replace the runtime behavior backing an already-resolved token
   * without changing the outward reference that consumers hold.
   *
   * Runs `newFactory(cachedDeps, resolver)` → new instance. Then:
   *
   * - **Object instances:** delete keys that disappeared, `Object.assign`
   *   remaining keys on top. Handler closures over the old instance see
   *   the new methods on their next call.
   *
   * - **Function instances:** look up the indirection box stored at
   *   resolve time, update its `current` pointer. The proxy exposed to
   *   callers delegates `apply`/get/set through the box, so existing
   *   references keep working and invoke the new code.
   *
   * Accessible via `container[CONTAINER_DEV].replaceInstance(...)` -
   * not on the public shape, to keep tooling-only capabilities out of
   * everyday autocomplete.
   *
   * Singletons the factory created at construction time (Maps, sockets)
   * are NOT preserved - register `lifecycle.register('hotReload')` to
   * capture and re-inject such state across replacements.
   */
  private async replaceInstanceImpl<T>(
    token: ServiceToken<T>,
    newFactory: ServiceFactory<Record<string, unknown>, T>,
  ): Promise<void> {
    const oldInstance = this.instances.get(token);
    const deps = this.resolvedDeps.get(token);
    if (oldInstance === undefined || !deps) {
      // Either never instantiated or never resolved. A future resolve
      // will pick up whatever factory is current on the class.
      return;
    }

    const resolver: Resolver = Object.assign(
      <R>(t: ServiceToken<R>) => this.resolve(t),
      {
        registerInstance: <R>(t: ServiceToken<R>, instance: R) => {
          this.registerInstance(t, instance);
        },
      },
    );

    const newInstance = await newFactory(deps as Record<string, unknown>, resolver);

    // Function-type: update the indirection box behind the proxy.
    const box = typeof oldInstance === 'object' && oldInstance !== null
      ? this.indirectionBoxes.get(oldInstance)
      : typeof oldInstance === 'function'
        ? this.indirectionBoxes.get(oldInstance as unknown as object)
        : undefined;
    if (box !== undefined) {
      if (typeof newInstance !== 'function') {
        // Shape flipped from function → non-function. Can't swap in
        // place - reset would break callers that hold the proxy.
        return;
      }
      box.current = newInstance as unknown as (...args: unknown[]) => unknown;
      return;
    }

    // Object-type: key-level merge.
    if (
      newInstance === null ||
      typeof newInstance !== 'object' ||
      typeof oldInstance !== 'object' ||
      oldInstance === null
    ) {
      return;
    }

    for (const key of Object.keys(oldInstance)) {
      if (!(key in (newInstance as Record<string, unknown>))) {
        delete (oldInstance as Record<string, unknown>)[key];
      }
    }
    Object.assign(oldInstance as Record<string, unknown>, newInstance as Record<string, unknown>);
  }

  /**
   * Set a custom logger factory.
   * Use this to replace ConsoleLogger with your own implementation.
   *
   * @example
   * ```typescript
   * container.setLoggerFactory({
   *   create: (context) => new PinoLogger(context),
   * });
   * ```
   */
  setLoggerFactory(factory: LoggerFactory): this {
    this.loggerFactory = factory;
    return this;
  }

  /**
   * If the app bound a custom LoggerFactory - via `.add(pinoLoggerFactory())`,
   * `.add(consoleLoggerFactory())`, a `provides: [LoggerFactory]` service, or
   * `.override(LoggerFactory, ...)` - resolve it once and use it for every
   * logger created afterwards. Called during bootstrap before controllers and
   * other services resolve, so they all share the chosen backend.
   *
   * No re-entrancy hazard: any logging triggered while the factory resolves
   * uses the existing `loggerFactory` field (the env-seeded pino default),
   * never `resolve(LoggerFactory)`, so it cannot recurse.
   */
  async resolveBoundLoggerFactory(): Promise<void> {
    const token = LoggerFactory as unknown as ServiceToken<LoggerFactory>;
    if (!this.factories.has(token)) return;
    const factory = await this.resolve(token);
    if (factory) this.loggerFactory = factory;
  }

  /**
   * Create a logger with the current resolution context.
   * Called internally when Logger is requested as a dependency.
   */
  createLogger(context?: string): Logger {
    const ctx = context ?? this.resolutionStack[this.resolutionStack.length - 1] ?? 'app';
    return this.loggerFactory.create(ctx);
  }

  /** Find a ServiceDef for a token (handles various lookup strategies) */
  private findServiceDef<T>(token: ServiceToken<T>): ServiceDef<T, Record<string, ServiceToken>> | undefined {
    // Try direct lookup
    let def = this.factories.get(token) as ServiceDef<T, Record<string, ServiceToken>> | undefined;

    // If not found by object identity, try by SERVICE_ID
    if (!def) {
      const tokenId = getServiceIdValue(token);
      if (tokenId !== undefined) {
        def = this.factoriesById.get(tokenId) as ServiceDef<T, Record<string, ServiceToken>> | undefined;
      }
    }

    // If still not found and token is a ServiceDef, try to match by deps structure
    if (!def && typeof token === 'object' && token !== null && 'deps' in token && 'factory' in token) {
      const tokenDeps = (token as any).deps as Record<string, ServiceToken>;
      const tokenKeys = Object.keys(tokenDeps).sort().join(',');

      for (const [key, value] of this.factories.entries()) {
        if (key === token) continue; // Already checked
        if (typeof key !== 'object' || key === null || !('deps' in key)) continue;

        const keyDeps = (key as any).deps as Record<string, ServiceToken>;
        const keyKeys = Object.keys(keyDeps).sort().join(',');

        // Match if same dep keys and dep values match by name (handles different module instances)
        if (tokenKeys === keyKeys) {
          const depsMatch = Object.keys(tokenDeps).every(k => {
            const a = tokenDeps[k];
            const b = keyDeps[k];
            // Compare by identity first
            if (a === b) return true;
            // If both are functions (classes), compare by name
            if (typeof a === 'function' && typeof b === 'function') {
              return (a as any).name === (b as any).name;
            }
            return false;
          });
          if (depsMatch) {
            def = value as ServiceDef<T, Record<string, ServiceToken>>;
            break;
          }
        }
      }
    }

    return def;
  }

  /**
   * Resolve a service (always async to support async factories).
   *
   * RepositoryToken overload: `ModelRepository.of(User)` returns the
   * repository instance type, not the entity type. TypeScript picks
   * overloads in order, so this runs for any RepositoryToken first;
   * everything else falls through to the generic signature.
   */
  /**
   * Synchronously return an already-instantiated service, or undefined if
   * it hasn't been resolved yet. Does NOT trigger instantiation.
   *
   * Use sparingly — meant for hot paths that need to check current state
   * (e.g. process executor lookup) without paying the cost of an async
   * resolve. Most code should use `resolve(token)` and await it.
   */
  tryGetInstance<T>(token: ServiceToken<T>): T | undefined {
    return this.instances.get(token as unknown as ServiceToken) as T | undefined;
  }

  async resolve<T, TInstance>(token: RepositoryToken<T, TInstance>): Promise<TInstance>;
  async resolve<T>(token: ServiceToken<T>): Promise<T>;
  async resolve<T>(token: ServiceToken<T>): Promise<T> {
    // Special case: Logger is NOT a singleton - each injection gets its own instance
    if (isLoggerToken(token)) {
      return this.createLogger() as T;
    }

    // Special case: Lifecycle is a built-in singleton
    if (isLifecycleToken(token)) {
      if (!this.lifecycle) {
        throw new Error(
          'Lifecycle not initialized - are you using createClusterBuilder()? ' +
          'Make sure to call .build() and use the cluster, not raw Container.'
        );
      }
      return this.lifecycle as T;
    }

    // Explicit `registerInstance(token, value)` wins over every other
    // resolution path. Needed for sub-app bridges: when a sub-app
    // `.requires(Config.of(X))`, the compose path registers a
    // scope-switched value against the token object itself; without
    // this check, the resolvable-token branch below would run its own
    // `resolve(container)` and look up a partial symbol the sub-app
    // scope doesn't have, returning undefined.
    if (this.instances.has(token)) {
      return this.instances.get(token) as T;
    }

    // Resolvable tokens: ConfigToken / SecretToken / FeatureFlagToken.
    // These carry their own resolve(container) function and read from
    // instances keyed by a partial symbol.
    const tokenAny = token as any;
    if (
      tokenAny &&
      typeof tokenAny === 'object' &&
      typeof tokenAny.resolve === 'function' &&
      typeof tokenAny.key === 'symbol' &&
      !('factory' in tokenAny)
    ) {
      return tokenAny.resolve({
        get: <R>(key: symbol) => this.instances.get(key as any) as R,
      }) as T;
    }

    // Check if resolution is already in progress (prevents duplicate instantiation during concurrent resolution)
    if (this.pending.has(token)) {
      return this.pending.get(token) as Promise<T>;
    }

    // Also check if the underlying def is being resolved under a different token
    const def = this.findServiceDef(token);
    if (def && def !== token && this.pending.has(def)) {
      return this.pending.get(def) as Promise<T>;
    }

    // Create and track the resolution promise
    const resolutionPromise = this.resolveInternal(token);
    this.pending.set(token, resolutionPromise);
    // Also track under the def if different from token
    if (def && def !== token) {
      this.pending.set(def, resolutionPromise);
    }

    try {
      const instance = await resolutionPromise;
      return instance;
    } finally {
      this.pending.delete(token);
      if (def && def !== token) {
        this.pending.delete(def);
      }
    }
  }

  /** Internal resolution logic */
  private async resolveInternal<T>(token: ServiceToken<T>): Promise<T> {
    const def = this.findServiceDef(token);

    if (def) {
      // Check if this def was already instantiated under a different token
      // This happens when bindService maps multiple tokens to the same service
      if (def !== token && this.instances.has(def)) {
        const instance = this.instances.get(def) as T;
        // Cache under this token too for faster future lookups
        this.instances.set(token, instance);
        return instance;
      }

      // Cycle detection: if the def (or the token) is already being
      // resolved further up the stack, we have a circular dependency.
      // Throw a readable error listing the path instead of recursing
      // until the engine throws a generic RangeError.
      const cycleHit = this.resolving.indexOf(def) !== -1
        ? def
        : this.resolving.indexOf(token) !== -1
          ? token
          : undefined;
      if (cycleHit !== undefined) {
        const startIdx = this.resolving.indexOf(cycleHit);
        const path = this.resolving
          .slice(startIdx)
          .map((t) => getTokenName(t as ServiceToken));
        path.push(getTokenName(cycleHit as ServiceToken));
        throw new CircularDependencyError(path);
      }

      // Push context for Logger injection (auto-pops when block exits)
      using _ = pushScope(this.resolutionStack, getTokenName(token));

      this.resolving.push(def);
      try {
        const resolvedDeps: Record<string, unknown> = {};
        if (def.deps == null) {
          const stack = this.resolutionStack.length ? this.resolutionStack.join(' -> ') : '(empty)';
          throw new TypeError(
            `Service '${getTokenName(token)}' has no deps defined. ` +
            `Resolution stack: ${stack}. ` +
            'Ensure the service was created with defineService and has an \'inject\' field.'
          );
        }
        for (const [key, depToken] of Object.entries(def.deps)) {
          resolvedDeps[key] = await this.resolve(depToken);
        }

        // Set lifecycle service context for hotReload handler registration
        const serviceId = getServiceId(token);
        if (this.lifecycle) {
          this.lifecycle.setServiceContext(serviceId);
        }

        // Pass a resolver function so factories can resolve additional dependencies
        const resolver: Resolver = Object.assign(
          <R>(t: ServiceToken<R>) => this.resolve(t),
          { registerInstance: <R>(t: ServiceToken<R>, instance: R) => { this.registerInstance(t, instance); } },
        );

        try {
          const rawInstance = await def.factory(resolvedDeps as any, resolver);
          const instance = this.wrapIfFunction(rawInstance);

          // Cache under both the lookup token and the def itself
          this.instances.set(token, instance);
          if (def !== token) {
            this.instances.set(def, instance);
          }

          // Store resolved deps for HMR method patching
          this.resolvedDeps.set(token, resolvedDeps);

          // Register token by stable ID for HMR lookup
          this.tokensByStableId.set(serviceId, token);

          return instance;
        } finally {
          // Clear service context after factory completes
          if (this.lifecycle) {
            this.lifecycle.setServiceContext(null);
          }
        }
      } finally {
        // Pop the resolving stack regardless of success or failure.
        const idx = this.resolving.lastIndexOf(def);
        if (idx !== -1) this.resolving.splice(idx, 1);
      }
    }

    // Is it a ServiceLike (e.g., ProcessDefinition)? Check for deps+factory
    // Note: ProcessDefinition is callable (typeof === 'function') but has deps/factory
    const tokenAny = token as any;
    if (tokenAny && 'deps' in tokenAny && 'factory' in tokenAny) {
      const serviceLike = token as ServiceLike<T>;
      // Resolve dependencies
      const resolvedDeps: Record<string, unknown> = {};
      for (const [key, depToken] of Object.entries(serviceLike.deps)) {
        resolvedDeps[key] = await this.resolve(depToken as ServiceToken);
      }
      // Call factory (may not use deps for compiled processes)
      const instance = serviceLike.factory(resolvedDeps) as T;
      this.instances.set(token, instance);
      return instance;
    }

    // Is it a class? Try to instantiate it
    if (typeof token === 'function') {
      const instance = new (token as ServiceClass<T>)();
      this.instances.set(token, instance);
      return instance;
    }

    // Better error message for debugging
    const t = token as unknown;
    let tokenDesc: string;
    if (typeof t === 'function') {
      tokenDesc = (t as { name?: string }).name || 'Anonymous';
    } else if (typeof t === 'symbol') {
      tokenDesc = (t as symbol).description ?? String(t);
    } else if (typeof t === 'object' && t !== null && 'deps' in t) {
      const deps = (t as { deps: Record<string, unknown> }).deps;
      const depList = Object.entries(deps)
        .map(([k, v]) => `${k}: ${getTokenName(v as ServiceToken)}`)
        .join(', ');
      tokenDesc = `ServiceDef { deps: ${depList} }`;
    } else {
      tokenDesc = String(t);
    }
    throw new Error(`Unable to resolve service: ${tokenDesc}`);
  }

  /**
   * Resolve all registered services.
   * Ensures services that provide side effects (hooks, listeners, seeders, etc.)
   * are instantiated even if they aren't dependencies of any controller.
   */
  async resolveAll(): Promise<void> {
    for (const token of this.factories.keys()) {
      await this.resolve(token);
    }
  }

  // ==========================================================================
  // Model Prototype Wiring (model DI injection)
  // ==========================================================================

  /**
   * Wire model prototypes for models with `inject`.
   *
   * For each registered model that has inject deps, resolves those deps
   * from the container and creates a "model service" - an object that sits
   * in the prototype chain between instances and ModelClass.prototype.
   *
   * Prototype chain after wiring:
   *   instance (own props: field data)
   *     → modelService (inject deps, non-enumerable)
   *       → ModelClass.prototype (class methods)
   *         → BaseModel.prototype
   *
   * Call this AFTER resolveAll() - all inject deps must be resolved first.
   */
  async wireModelPrototypes(): Promise<void> {
    for (const model of getModelsWithInject()) {
      const injectConfig = (model as unknown as Record<symbol, unknown>)[MODEL_INJECT] as Record<string, ServiceToken> | undefined;
      if (!injectConfig) continue;

      // Create the model service: sits between instances and class prototype
      const service = Object.create((model as { prototype: object }).prototype);

      // Resolve inject deps and attach as non-enumerable properties
      for (const [key, depToken] of Object.entries(injectConfig)) {
        const resolved = await this.resolve(depToken);
        Object.defineProperty(service, key, {
          value: resolved,
          enumerable: false,
          configurable: true,
        });
      }

      // Store the model service on the model class
      Object.defineProperty(model, MODEL_SERVICE, {
        value: service,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
  }

  // ==========================================================================
  // Hot Reload Support (dev mode only)
  // ==========================================================================

  /**
   * Get a token by its stable service ID.
   * Used by HMR runtime to find the service to reload.
   */
  getTokenByStableId(serviceId: string): ServiceToken | undefined {
    return this.tokensByStableId.get(serviceId);
  }

  /**
   * Hot reload a service. Two modes:
   *
   * 1. Method patch: Only method bodies changed
   *    - Re-run factory with same deps
   *    - Extract changed methods, patch in-place
   *    - Instance object stays the same, state preserved
   *
   * 2. Full reload: Structure changed
   *    - Run hotReload hook to collect state
   *    - Store state in registry for factory wrapper to inject
   *    - Create new instance (module will be re-imported)
   *
   * @param serviceId - The stable service ID
   * @param mode - 'method-patch' or 'full-reload'
   * @param changedMethods - List of changed method names (for method-patch mode)
   */
  async hotReload(
    serviceId: string,
    mode: 'method-patch' | 'full-reload',
    changedMethods?: string[]
  ): Promise<void> {
    const token = this.tokensByStableId.get(serviceId);
    if (!token) {
      console.warn(`[HotReload] Service not found: ${serviceId}`);
      return;
    }

    const oldInstance = this.instances.get(token);
    if (!oldInstance) {
      console.log(`[HotReload] Service not instantiated yet: ${serviceId}`);
      return;
    }

    if (mode === 'method-patch' && changedMethods && changedMethods.length > 0) {
      // Method patch: re-run factory with same deps, extract changed methods
      const deps = this.resolvedDeps.get(token);
      const def = this.findServiceDef(token);
      if (!def || !deps) {
        console.warn(`[HotReload] Cannot method-patch ${serviceId}: missing deps or def`);
        return;
      }

      try {
        // Re-run factory with same deps to get new methods
        const resolver: Resolver = Object.assign(
          <R>(t: ServiceToken<R>) => this.resolve(t),
          { registerInstance: <R>(t: ServiceToken<R>, instance: R) => { this.registerInstance(t, instance); } },
        );
        const newMethods = await def.factory(deps as any, resolver);

        // Patch only changed methods
        for (const method of changedMethods) {
          if (method in (newMethods as object)) {
            (oldInstance as any)[method] = (newMethods as any)[method];
          }
        }
        console.log(`[HotReload] ${serviceId} patched: ${changedMethods.join(', ')}`);
      } catch (err) {
        console.error(`[HotReload] ${serviceId} patch failed:`, err);
      }
    } else {
      // Full reload: collect state, store for factory wrapper to inject
      if (this.lifecycle) {
        const rawState = await this.lifecycle.runHotReload(serviceId);
        if (rawState !== undefined) {
          const state = __wrapHmrStateForSave(serviceId, rawState);
          this.hmrStateRegistry.set(serviceId, state);
          console.log(`[HotReload] ${serviceId} state saved for reload`);
        }
      }

      // Clear cached instance - new one will be created when module re-imports
      this.instances.delete(token);
      this.resolvedDeps.delete(token);

      console.log(`[HotReload] ${serviceId} cleared for full reload`);
    }
  }

  /**
   * Get HMR state for a service during factory execution.
   * Called by compiler-generated code: __getHmrState(serviceId)
   *
   * @param serviceId - The stable service ID
   * @returns The saved state, or undefined if none
   */
  getHmrState(serviceId: string): unknown {
    const state = this.hmrStateRegistry.get(serviceId);
    // Clear after retrieval - state is consumed
    this.hmrStateRegistry.delete(serviceId);
    return state;
  }

  /**
   * Check if a service has HMR state waiting to be injected.
   */
  hasHmrState(serviceId: string): boolean {
    return this.hmrStateRegistry.has(serviceId);
  }
}

// ============================================================================
// Type-Level Validation Helpers
// ============================================================================

/** Check if all required services are provided */
export type ValidateDeps<
  TRequired extends ServiceToken[],
  TProvided extends ServiceToken[]
> = Exclude<
  CollectAllDeps<TRequired[number]>,
  TProvided[number] | TRequired[number]
> extends never
  ? true
  : {
    error: 'Missing dependencies';
    missing: Exclude<
      CollectAllDeps<TRequired[number]>,
        TProvided[number] | TRequired[number]
    >;
  };

// Re-export Logger and observability utilities
export {
  Logger,
  ConsoleLogger,
  ConsoleLoggerFactory,
  // LoggerFactory is an abstract class -> usable as a DI token
  LoggerFactory,
  // Context utilities
  getContext,
  captureContext,
  runWithContext,
  withContext,
  // Scope management (for request lifecycle)
  runInScope,
  runInScopeAsync,
  // Instrumentation registration
  registerInstrumentation,
  unregisterInstrumentation,
  getInstrumentations,
  emitLog,
  isLevelEnabled,
  onMinLogLevelChange,
} from './logger.js';

export type {
  LogAttributes,
  LogLevel,
  // Context types
  ObservabilityContext,
  LinkedContext,
  // Instrumentation types
  Instrumentation,
  ScopeInfo,
} from './logger.js';
