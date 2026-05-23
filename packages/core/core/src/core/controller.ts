/**
 * Controller Factory
 *
 * A controller is a service that exposes routes.
 * Transport-agnostic - transports (HTTP, gRPC, etc.) augment the types.
 */

import type { z } from 'zod';
import {
  type ServiceToken,
  type ResolvedDeps,
  type ServiceDef,
  type Resolver,
  type Logger,
} from './service.js';
import {
  type RouteMethod,
  type RouteHandler,
  type RouteFactories,
  type RouteContext,
  type Prettify,
  type SupportedMethods,
  createRouteFactories,
} from './plugin.js';
import {
  type Middleware,
  type Guard,
  type MiddlewareDef,
  type GuardDef,
  isMiddlewareDef,
  isGuardDef,
} from './middleware.js';
import type { Step, RouteDef as RouteDefV2 } from '../builder/types.js';

import type { ProcedureDef as ProcedureDefType } from './controller.procedure.js';

type AnyRouteDef = RouteDefV2<any, any, any> | ProcedureDefType<any, any, any>;
import { compilePath, joinPaths } from './internal/routes.js';
import type { TypesConfig } from '../models/apply-types-config.js';

// ============================================================================
// Transport-Extensible Settings (via module augmentation)
// ============================================================================

/**
 * Controller settings - augmented by transports.
 * Each transport adds its own settings via declaration merging:
 *
 * @example
 * ```typescript
 * declare module "@justscale/core" {
 *   interface ControllerSettings {
 *     prefix?: string;  // HTTP adds this
 *   }
 * }
 * ```
 */
export interface ControllerSettings {
  /** CLI command namespace (e.g., 'db' for 'mycli db migrate') */
  command?: string
}

/**
 * Transport context additions - augmented by transports.
 * HTTP adds: { body, query, res, params }
 * gRPC might add: { metadata, call }
 *
 * @example
 * ```typescript
 * declare module "@justscale/core" {
 *   interface TransportContext {
 *     body: unknown;
 *     query: Record<string, string>;
 *     res: JsonResponse;
 *     params: Record<string, string>;
 *   }
 * }
 * ```
 */
export interface TransportContext {
  /** CLI: Parsed command arguments */
  args: Record<string, unknown>
  /** CLI: I/O interface for terminal interaction */
  io: unknown  // CliIO<unknown> - kept as unknown to avoid circular import
}

/**
 * Reserved context keys from transport - used for conflict validation.
 * Automatically derived from TransportContext.
 */
export type ReservedContextKeys = keyof TransportContext;

/**
 * Validate that dependency names don't conflict with transport context keys.
 * Returns `true` if valid, or an error type showing conflicting keys.
 *
 * @example
 * ```typescript
 * // This would error because 'res' conflicts with HTTP's TransportContext
 * inject: { res: SomeService }
 * ```
 */
export type ValidateDepsNoConflict<TDeps extends Record<string, ServiceToken>> =
  keyof ResolvedDeps<TDeps> & ReservedContextKeys extends never
    ? true
    : {
      __deps_conflict__: 'Dependency name conflicts with transport context key';
      conflicting: keyof ResolvedDeps<TDeps> & ReservedContextKeys;
    };

/**
 * Built-in context that's always available to handlers.
 * This includes the logger, which is automatically injected.
 *
 * Other packages can extend this via module augmentation:
 * @example
 * ```typescript
 * declare module "@justscale/core" {
 *   interface BuiltinContext {
 *     requestId: string;
 *   }
 * }
 * ```
 */
export interface BuiltinContext {
  /** Logger instance with controller context */
  logger: Logger;

  /**
   * Register a cleanup function to run after the handler completes.
   * Cleanups run in reverse registration order (LIFO), even if the handler throws.
   *
   * @example
   * ```typescript
   * .use(async (ctx) => {
   *   const lock = await lockService.acquire(entity);
   *   ctx.onCleanup(() => lock[Symbol.dispose]());
   *   return { player: lock };
   * })
   * ```
   */
  onCleanup: (fn: () => void | Promise<void>) => void;
}

// ============================================================================
// Builtin Provider Registry
// ============================================================================

/**
 * Context passed to builtin providers when creating context values.
 */
export interface BuiltinProviderContext {
  /** The route being executed */
  route: CompiledRoute<any>;
  /** Resolved controller dependencies */
  deps: Record<string, unknown>;
  /** Create a logger with a specific context name */
  createLogger: (context: string) => Logger;
}

/**
 * A function that provides builtin context values.
 * Called for each request to create the builtin context.
 *
 * @example
 * ```typescript
 * registerBuiltinProvider((ctx) => ({
 *   requestId: crypto.randomUUID().slice(0, 8),
 * }));
 * ```
 */
export type BuiltinProvider = (ctx: BuiltinProviderContext) => Partial<BuiltinContext>;

// Registry of builtin providers
const builtinProviders: BuiltinProvider[] = [];

/**
 * Register a provider that adds values to the builtin context.
 * Providers are called in registration order for each request.
 *
 * Use module augmentation to add type declarations for new builtins:
 * @example
 * ```typescript
 * // In your package
 * declare module "@justscale/core" {
 *   interface BuiltinContext {
 *     myService: MyService;
 *   }
 * }
 *
 * registerBuiltinProvider(() => ({
 *   myService: new MyService(),
 * }));
 * ```
 */
export function registerBuiltinProvider(provider: BuiltinProvider): void {
  builtinProviders.push(provider);
}

/**
 * Collect all builtin context values from registered providers.
 * @internal Used by app.execute()
 */
export function collectBuiltins(ctx: BuiltinProviderContext): Partial<BuiltinContext> {
  return builtinProviders.reduce<Partial<BuiltinContext>>((acc, provider) => ({
    ...acc,
    ...provider(ctx),
  }), {});
}

/**
 * Full handler context - transport context plus builtins.
 * Dependencies are accessed via closure capture from the routes function.
 * Logger is always available as a built-in.
 */
export type HandlerContext = Prettify<TransportContext & BuiltinContext>;

// Re-export route types for convenience
export type {
  RouteMethod,
  RouteHandler,
  RouteFactories,
  RouteContext,
  Middleware,
  Guard,
  MiddlewareDef,
  GuardDef,
  Prettify,
  SupportedMethods,
};
export { createRouteFactories };

// ============================================================================
// Controller Definition
// ============================================================================

/**
 * Normalize settings input - handles string shorthand.
 * String becomes { prefix: string } for HTTP compatibility.
 */
export type NormalizeSettings<T> = T extends string
  ? { prefix: T } & ControllerSettings
  : T extends ControllerSettings
    ? T
    : ControllerSettings;

/**
 * A controller definition - a service that has routes.
 *
 * Type parameters:
 * - TDeps: Dependencies injected into the controller
 * - TRoutes: The routes object with full type info (path, body, response per route)
 * - TSettings: Controller settings (augmented by transports)
 */
export interface ControllerDef<
  TDeps extends Record<string, ServiceToken> = Record<string, ServiceToken>,
  TRoutes extends Record<string, AnyRouteDef> | AnyRouteDef[] = Record<string, AnyRouteDef>,
  TSettings extends ControllerSettings = ControllerSettings
> extends ServiceDef<ControllerInstance<TDeps, TSettings>, TDeps> {
  readonly __controllerBrand: unique symbol;
  readonly prefix: TSettings extends { prefix: infer P } ? P : string;
  readonly settings: TSettings;
}

/** The runtime instance of a controller */
export interface ControllerInstance<
  TDeps extends Record<string, ServiceToken> = Record<string, ServiceToken>,
  TSettings extends ControllerSettings = ControllerSettings
> {
  prefix: string;
  settings: TSettings;
  routes: CompiledRoute<ResolvedDeps<TDeps>>[];
  deps: ResolvedDeps<TDeps>;
}

/** A compiled route ready for matching */
export interface CompiledRoute<_TDeps = Record<string, unknown>> {
  /** Route name from the controller's routes object (e.g., 'list', 'getOne') */
  name: string;
  /** Route method - extended by transports via SupportedMethods */
  method: keyof SupportedMethods extends never ? string : keyof SupportedMethods;
  /** Full path as string */
  path: string;
  /** Path segments as array (e.g., ['auth', 'create-user']) */
  segments: string[];
  pattern: RegExp;
  paramNames: string[];
  schema?: z.ZodType | undefined;
  middlewares: Middleware<any, any>[];
  guards: Guard<any>[];
  steps: Step[];
  responseSchemas?: Map<number, z.ZodType | null>;
  /** Permission-scoped returns - used by the permissions middleware at runtime */
  permissionReturns?: ReadonlyArray<{
    status: number;
    schema: z.ZodType | null;
    permission: { readonly name: string };
  }>;
  handler: (ctx: any) => void | Promise<void> | AsyncGenerator<unknown>;
  /** Types config from controller - maps model classes to path params */
  types?: TypesConfig;
}

// ============================================================================
// Controller Factory
// ============================================================================

/** Config object for createController */
interface ControllerConfig<
  TDeps extends Record<string, ServiceToken>,
  TRoutes extends Record<string, AnyRouteDef> | AnyRouteDef[]
> {
  inject: TDeps;
  routes: (services: ResolvedDeps<TDeps>) => TRoutes;
}

/**
 * Create a controller with typed dependencies.
 *
 * The routes function receives a `services` object containing resolved dependencies
 * for use via closure capture in handlers. Route factories (Get, Post, etc.) should
 * be imported directly from their respective packages (@justscale/http, @justscale/cli, etc.).
 *
 * Supports two forms:
 * - `createController('/prefix', { inject, routes })` - string shorthand for HTTP
 * - `createController({ prefix: '/prefix', inject, routes })` - full object form
 *
 * @example
 * ```typescript
 * import { Get, Post } from '@justscale/http';
 *
 * // String shorthand (HTTP)
 * const UsersController = createController('/users', {
 *   inject: { users: UserRepository },
 *   routes: (services) => ({
 *     list: Get('/').handle(async ({ res }) => {
 *       const all = await services.users.find();
 *       res.json({ users: all });
 *     }),
 *   }),
 * });
 *
 * // Object form
 * const UsersController = createController({
 *   prefix: '/users',
 *   inject: { users: UserRepository },
 *   routes: (services) => ({ ... }),
 * });
 * ```
 */

/**
 * Symbol attached to a resolved guard function carrying its source
 * GuardDef. Introspection tools (OpenAPI generator, debug UIs, etc.)
 * read this to recover the original permission/action name that was
 * lost when the def was resolved into a plain function.
 */
export const GUARD_DEF_SOURCE = Symbol('justscale:guardDefSource');

async function resolveGuard(g: unknown, resolve: Resolver): Promise<Guard<any>> {
  if (isGuardDef(g)) {
    const gDeps: Record<string, unknown> = {};
    for (const [key, depToken] of Object.entries(g.deps)) {
      gDeps[key] = await resolve(depToken as ServiceToken);
    }
    const fn = g.factory(gDeps);
    (fn as unknown as Record<symbol, unknown>)[GUARD_DEF_SOURCE] = g;
    return fn;
  }
  return g as Guard<any>;
}

/**
 * Resolve unresolved steps (MiddlewareDef, GuardDef, or arrays) to callable Step[] using DI.
 * Called by createController and createContextualController factories.
 */
async function resolveSteps(steps: { type: 'use' | 'guard'; fn: unknown }[], resolve: Resolver): Promise<Step[]> {
  const resolved: Step[] = [];
  for (const step of steps) {
    if (step.type === 'use') {
      const mw = step.fn;
      if (isMiddlewareDef(mw)) {
        const mwDeps: Record<string, unknown> = {};
        for (const [key, depToken] of Object.entries(mw.deps)) {
          mwDeps[key] = await resolve(depToken as ServiceToken);
        }
        resolved.push({ type: 'use' as const, fn: mw.factory(mwDeps) });
      } else {
        resolved.push(step as Step);
      }
    } else {
      // Guard step
      const g = step.fn;
      if (Array.isArray(g)) {
        const guardFns = await Promise.all(g.map((gd) => resolveGuard(gd, resolve)));
        resolved.push({
          type: 'guard' as const,
          fn: async (ctx: any) => {
            for (const fn of guardFns) {
              if (await fn(ctx)) return true;
            }
            return false;
          },
        });
      } else {
        resolved.push({ type: 'guard' as const, fn: await resolveGuard(g, resolve) });
      }
    }
  }
  return resolved;
}

function _createControllerImpl<
  const TDeps extends Record<string, ServiceToken>,
  const TRoutes extends Record<string, AnyRouteDef> | AnyRouteDef[],
  const TPrefix extends string
>(
  prefix: TPrefix,
  config: ControllerConfig<TDeps, TRoutes>
): ValidateDepsNoConflict<TDeps> extends true
  ? ControllerDef<TDeps, TRoutes extends any[] ? Record<string, AnyRouteDef> : TRoutes, NormalizeSettings<TPrefix>>
  : ValidateDepsNoConflict<TDeps>;

function _createControllerImpl<
  const TDeps extends Record<string, ServiceToken>,
  const TRoutes extends Record<string, AnyRouteDef> | AnyRouteDef[],
  const TSettings extends ControllerSettings
>(
  config: TSettings & ControllerConfig<TDeps, TRoutes>
): ValidateDepsNoConflict<TDeps> extends true
  ? ControllerDef<TDeps, TRoutes extends any[] ? Record<string, AnyRouteDef> : TRoutes, TSettings>
  : ValidateDepsNoConflict<TDeps>;

function _createControllerImpl(
  settingsOrPrefix: any,
  maybeConfig?: any
): any {
  // Normalize to settings + config
  const isStringForm = typeof settingsOrPrefix === 'string';
  const settings: ControllerSettings = isStringForm
    ? { prefix: settingsOrPrefix }
    : settingsOrPrefix;
  const config = isStringForm
    ? maybeConfig!
    : { inject: (settingsOrPrefix as any).inject, routes: (settingsOrPrefix as any).routes };

  const prefix = (settings as { prefix?: string }).prefix ?? '';

  const factory = async (deps: Record<string, unknown>, resolve: Resolver): Promise<ControllerInstance<any, any>> => {
    // Pass deps as services to the routes function
    const routeDefs = config.routes(deps as any);
    const routes: CompiledRoute<any>[] = [];

    const entries: [string, AnyRouteDef][] = Array.isArray(routeDefs)
      ? routeDefs.map((r: any) => [`${r.method} ${r.path}`, r])
      : Object.entries(routeDefs) as [string, AnyRouteDef][];

    for (const [name, routeDef] of entries) {
      const { path: fullPath, segments } = joinPaths(prefix, routeDef.path);
      const { pattern, paramNames } = compilePath(fullPath);

      const rd = routeDef as any;
      const compiledRoute: CompiledRoute<any> = {
        name,
        method: rd.method,
        path: fullPath,
        segments,
        pattern,
        paramNames,
        schema: undefined,
        middlewares: [],
        guards: [],
        steps: await resolveSteps(rd.steps ?? [], resolve),
        responseSchemas: rd.responseSchemas ?? new Map(),
        handler: rd.handler,
        types: rd.types,
        permissionReturns: rd.permissionReturns,
      };

      // Preserve symbol properties from routeDef (e.g., RESPONSE_SCHEMA for OpenAPI)
      for (const sym of Object.getOwnPropertySymbols(routeDef)) {
        (compiledRoute as any)[sym] = (routeDef as any)[sym];
      }

      routes.push(compiledRoute);
    }

    return { prefix, settings, routes, deps };
  };

  return {
    deps: config.inject,
    factory,
    prefix,
    settings,
  } as any;
}

// ============================================================================
// Contextual Controller Builder (withContext)
// ============================================================================

import {
  type Session,
  type SessionOptions,
  type CompiledProcedure,
  type ContextualControllerInstance,
  type ResolvedStep,
  createContextualControllerInstance,
} from './controller.contextual.js';
import {
  PROCEDURE_TIMEOUT,
  createProcedureFactory,
} from './controller.procedure.js';
import type { ProcedureBuilder, ProcedureContext, ProcedureDef } from './controller.procedure.js';
import type { ExtractParams } from './plugin.js';
import { ConsoleLoggerFactory } from './service.js';

/**
 * Contextual controller definition - a controller that requires session context.
 * Cannot be mounted on HTTP transport directly - must use createSession().
 */
export interface ContextualControllerDef<
  TSessionContext,
  TDeps extends Record<string, ServiceToken> = Record<string, ServiceToken>,
  TRoutes extends Record<string, AnyRouteDef> | AnyRouteDef[] = Record<string, AnyRouteDef>
> extends ServiceDef<ContextualControllerInstance<TSessionContext>, TDeps> {
  readonly __contextualBrand: unique symbol;
  readonly __contextType: TSessionContext;
}

/**
 * Bound Procedure factory type - knows about the session type.
 */
type BoundProcedure<TSession> = <TPath extends string>(
  path: TPath
) => ProcedureBuilder<TSession, ExtractParams<TPath>, ProcedureContext<TSession, ExtractParams<TPath>>, unknown, unknown, TPath>;

/**
 * Route factories provided to contextual controller routes function.
 * Extensible via module augmentation:
 *
 * @example
 * ```typescript
 * declare module '@justscale/core' {
 *   interface ContextualRouteFactories<TSession> {
 *     Saga: BoundSaga<TSession>;
 *   }
 * }
 * ```
 */
export interface ContextualRouteFactories<TSession> {
  /** Procedure factory bound to the session type */
  Procedure: BoundProcedure<TSession>;
}

// ============================================================================
// Route Factory Registry (for extensibility)
// ============================================================================

/**
 * A factory provider creates a session-bound route factory.
 * Used by packages like @justscale/process to register their builders.
 */
export type RouteFactoryProvider = () => unknown;

// Registry of additional route factory providers
const routeFactoryProviders = new Map<string, () => unknown>();

/**
 * Register a route factory provider for contextual controllers.
 * Call this as a side-effect when your package is imported.
 *
 * @example
 * ```typescript
 * // In @justscale/process
 * import { registerContextualFactory } from '@justscale/core';
 * import { createProcessFactory } from './builder.js';
 *
 * registerContextualFactory('Process', createProcessFactory);
 * ```
 */
export function registerContextualFactory<K extends string>(
  name: K,
  provider: () => unknown
): void {
  routeFactoryProviders.set(name, provider);
}

/**
 * Collect all registered route factories for a session type.
 * @internal
 */
function collectRouteFactories(): Record<string, unknown> {
  const factories: Record<string, unknown> = {};
  for (const [name, provider] of routeFactoryProviders) {
    factories[name] = provider();
  }
  return factories;
}

/**
 * Config for contextual controllers.
 */
interface ContextualControllerConfig<
  TSessionContext,
  TDeps extends Record<string, ServiceToken>,
  TRoutes extends Record<string, AnyRouteDef> | AnyRouteDef[]
> {
  inject: TDeps;
  routes: (services: ResolvedDeps<TDeps>, factories: ContextualRouteFactories<TSessionContext>) => TRoutes;
}

/**
 * Curried builder returned by createContextualController<T>().
 */
interface ContextualControllerBuilder<TSessionContext> {
  /**
   * Create the contextual controller with dependencies and routes.
   */
  create<
    const TDeps extends Record<string, ServiceToken>,
    const TRoutes extends Record<string, AnyRouteDef> | AnyRouteDef[]
  >(
    config: ContextualControllerConfig<TSessionContext, TDeps, TRoutes>
  ): ContextualControllerDef<TSessionContext, TDeps, TRoutes extends any[] ? Record<string, AnyRouteDef> : TRoutes>;
}

/**
 * Create a contextual controller builder bound to a session type.
 * Use this for WebSocket and similar scenarios where controllers are
 * invoked programmatically with caller-provided context.
 *
 * @example
 * ```typescript
 * interface GameSession {
 *   user: User;
 *   ws: WebSocket;
 * }
 *
 * const RoomProcedures = createController
 *   .withContext<GameSession>()
 *   .create({
 *     inject: { rooms: RoomService },
 *     routes: (services, { Procedure }) => ({
 *       //               ^^^^^^^^^^^ bound to GameSession
 *       join: Procedure('room/:roomId/join')
 *         .handle(({ session, params }) => {
 *           // session is typed as GameSession!
 *           services.rooms.addPlayer(params.roomId, session.user);
 *           return { joined: params.roomId };
 *         }),
 *     })
 *   });
 *
 * // In WebSocket handler
 * const ctrl = container.resolve(RoomProcedures);
 * using session = ctrl.createSession({ user, ws });
 * await session.run();
 * ```
 */
function withContext<TSessionContext>(): ContextualControllerBuilder<TSessionContext> {
  return {
    create<
      const TDeps extends Record<string, ServiceToken>,
      const TRoutes extends Record<string, AnyRouteDef> | AnyRouteDef[]
    >(
      config: ContextualControllerConfig<TSessionContext, TDeps, TRoutes>
    ): ContextualControllerDef<TSessionContext, TDeps, TRoutes extends any[] ? Record<string, AnyRouteDef> : TRoutes> {
      // Create bound Procedure factory for this session type
      const BoundProcedure = createProcedureFactory<TSessionContext>();

      // Collect all registered factories (from saga, etc.)
      const additionalFactories = collectRouteFactories();

      const factory = async (
        deps: Record<string, unknown>,
        resolve: Resolver
      ): Promise<ContextualControllerInstance<TSessionContext>> => {
        // Build factories object with Procedure and any registered factories
        const factories = {
          Procedure: BoundProcedure,
          ...additionalFactories,
        } as ContextualRouteFactories<TSessionContext>;

        // Get routes from config, passing all factories
        const routeDefs = config.routes(deps as any, factories);
        const procedures: CompiledProcedure[] = [];

        const entries: [string, AnyRouteDef][] = Array.isArray(routeDefs)
          ? routeDefs.map((r: any) => [`${r.method ?? 'procedure'} ${r.path}`, r])
          : Object.entries(routeDefs) as [string, AnyRouteDef][];

        for (const [name, routeDef] of entries) {
          // Contextual controllers use new steps-based ProcedureDef format
          const procedureDef = routeDef as ProcedureDef<any, any, any>;

          // For contextual controllers, we don't join with a prefix
          const { pattern, paramNames } = compilePath(procedureDef.path);

          // Resolve unresolved steps (MiddlewareDef, GuardDef, arrays) to callable functions
          const resolvedSteps: ResolvedStep[] = await resolveSteps(procedureDef.steps, resolve);

          const procedure: CompiledProcedure = {
            name,
            path: procedureDef.path,
            segments: procedureDef.path.split('/').filter(Boolean),
            pattern,
            paramNames,
            schema: procedureDef.schema,
            steps: resolvedSteps,
            handler: procedureDef.handler,
            timeout: (procedureDef as any)[PROCEDURE_TIMEOUT],
          };

          procedures.push(procedure);
        }

        const routesProxy = (Array.isArray(routeDefs) ? Object.fromEntries(entries) : routeDefs) as Record<string, unknown>;

        for (const procedure of procedures) {
          (procedure as any).__routesProxy = routesProxy;
        }

        const loggerFactory = new ConsoleLoggerFactory();
        const createLogger = (context: string) => loggerFactory.create(context);

        return createContextualControllerInstance<TSessionContext>(procedures, createLogger, routesProxy);
      };

      return {
        deps: config.inject,
        factory,
      } as unknown as ContextualControllerDef<TSessionContext, TDeps, TRoutes>;
    },
  };
}

// ============================================================================
// Contract-Based Controller Builder (.implements)
// ============================================================================

import type {
  AnyContract,
  ContractImplementation,
  ContractMetadata,
  RpcMethodDef,
  MessageSchema,
} from '../features/contract/contract.js';

import {
  getContractMetadata,
} from '../features/contract/contract.js';

/** Symbol to mark contract controllers. Cross-realm: tests forge via Symbol.for(). */
export const CONTRACT_CONTROLLER = Symbol.for('justscale:contractController');

/**
 * Contract controller definition - a controller that implements a contract.
 */
export interface ContractControllerDef<
  TContract extends AnyContract,
  TDeps extends Record<string, ServiceToken> = Record<string, ServiceToken>,
> extends ServiceDef<ContractControllerInstance<TContract>, TDeps> {
  readonly __contractControllerBrand: unique symbol;
  readonly [CONTRACT_CONTROLLER]: true;
  readonly contract: TContract;
}

/**
 * Runtime instance of a contract controller.
 * Contains compiled RPC methods ready for protocol adapters.
 */
export interface ContractControllerInstance<TContract extends AnyContract> {
  /** The contract this controller implements */
  contract: TContract;
  /** Contract metadata (protocol, serviceName, methods) */
  metadata: ContractMetadata;
  /** Compiled method handlers */
  methods: Map<string, CompiledRpcMethod>;
  /** Resolved dependencies */
  deps: Record<string, unknown>;
}

/**
 * A compiled RPC method ready for execution.
 */
export interface CompiledRpcMethod {
  /** Method name */
  name: string;
  /** Input message schema */
  inputSchema: MessageSchema;
  /** Output message schema */
  outputSchema: MessageSchema;
  /** Streaming mode */
  streaming: 'unary' | 'server' | 'client' | 'bidi';
  /** The handler function */
  handler: (ctx: any) => unknown;
  /**
   * Ordered middleware/guard steps - the canonical execution chain.
   * Protocol adapters should run these via executeSteps() before calling
   * handler, identical to how HTTP/CLI/EVENT dispatch works.
   */
  steps: Array<{ type: 'use' | 'guard'; fn: unknown }>;
  /** @deprecated Use steps. Always empty - kept for interface compatibility. */
  middlewares: Middleware<any, any>[];
  /** @deprecated Use steps. Always empty - kept for interface compatibility. */
  guards: Guard<any>[];
}

/**
 * Config for contract-based controllers.
 * Uses `methods` instead of `routes` for clarity.
 */
interface ContractControllerConfig<
  TContract extends AnyContract,
  TDeps extends Record<string, ServiceToken>,
  TSession = unknown,
> {
  inject: TDeps;
  methods: (
    services: ResolvedDeps<TDeps>
  ) => ContractImplementation<TContract, TSession>;
}

/**
 * Builder returned by createController.implements(Contract).
 */
interface ContractControllerBuilder<TContract extends AnyContract> {
  /**
   * Create the contract controller with dependencies and method implementations.
   *
   * @example
   * ```typescript
   * createController
   *   .implements(GreeterService)
   *   .create({
   *     inject: { db: Database },
   *     methods: ({ db }) => ({
   *       sayHello: async ({ body }) => ({
   *         message: `Hello, ${body.name}!`,
   *       }),
   *       sayHelloStream: async function* ({ body }) {
   *         for (let i = 0; i < 5; i++) {
   *           yield { message: `Hello ${body.name} #${i}` }
   *         }
   *       },
   *     }),
   *   })
   * ```
   */
  create<const TDeps extends Record<string, ServiceToken>, TSession = unknown>(
    config: ContractControllerConfig<TContract, TDeps, TSession>
  ): ContractControllerDef<TContract, TDeps>;
}

/**
 * Create a controller that implements a contract (RPC service).
 * The contract defines the methods, inputs, and outputs.
 * The controller provides the implementations.
 *
 * @example
 * ```typescript
 * // Given a contract generated from .proto or defined manually:
 * abstract class GreeterService extends defineContract({
 *   protocol: 'grpc',
 *   serviceName: 'helloworld.Greeter',
 *   methods: {
 *     sayHello: rpc(HelloRequestSchema, HelloReplySchema),
 *   },
 * }) {}
 *
 * // Implement it:
 * const GreeterController = createController
 *   .implements(GreeterService)
 *   .create({
 *     inject: { db: Database },
 *     methods: ({ db }) => ({
 *       sayHello: async ({ body }) => ({
 *         message: `Hello, ${body.name}!`,
 *       }),
 *     }),
 *   })
 * ```
 */
function implementsContract<TContract extends AnyContract>(
  contract: TContract
): ContractControllerBuilder<TContract> {
  return {
    create<const TDeps extends Record<string, ServiceToken>, TSession = unknown>(
      config: ContractControllerConfig<TContract, TDeps, TSession>
    ): ContractControllerDef<TContract, TDeps> {
      // Get contract metadata (throws if missing)
      const metadata = getContractMetadata(contract);

      const factory = (
        deps: Record<string, unknown>,
        _resolve: Resolver
      ): ContractControllerInstance<TContract> => {
        // Get method implementations from config
        const implementations = config.methods(deps as any);

        // Compile methods
        const methods = new Map<string, CompiledRpcMethod>();

        for (const [methodName, methodDef] of Object.entries(metadata.methods) as [string, RpcMethodDef][]) {
          const handler = (implementations as any)[methodName];
          if (!handler) {
            throw new Error(
              `Contract method '${methodName}' not implemented in controller for '${metadata.serviceName}'`
            );
          }

          const compiled: CompiledRpcMethod = {
            name: methodName,
            inputSchema: methodDef.input,
            outputSchema: methodDef.output,
            streaming: methodDef.streaming,
            handler,
            steps: [],
            middlewares: [],
            guards: [],
          };

          methods.set(methodName, compiled);
        }

        return {
          contract,
          metadata,
          methods,
          deps,
        };
      };

      return {
        deps: config.inject,
        factory,
        contract,
        [CONTRACT_CONTROLLER]: true,
      } as unknown as ContractControllerDef<TContract, TDeps>;
    },
  };
}

/**
 * Create a controller with dependency injection and route definitions.
 *
 * Supports multiple patterns:
 * - `createController('/prefix', { inject, routes })` - HTTP route controller
 * - `createController.withContext<T>().create({ ... })` - contextual controller
 * - `createController.implements(Contract).create({ ... })` - contract controller
 */
const createController = Object.assign(_createControllerImpl, {
  /** Create a contextual controller bound to a session type */
  withContext,
  /** Create a controller that implements a contract (RPC service) */
  implements: implementsContract,
});

/**
 * Create a contextual controller bound to a session type.
 * Use this for WebSocket and similar scenarios where controllers
 * are invoked programmatically with caller-provided context.
 */
const createContextualController = withContext;

export { createController, createContextualController };

// Export additional types
export type { ContextualControllerBuilder, Session, SessionOptions };
