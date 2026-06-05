/**
 * Observability System
 *
 * Provides logging, context propagation, and extensibility hooks for
 * OpenTelemetry, Datadog, or other observability platforms.
 *
 * Features:
 * - Async context propagation via AsyncLocalStorage
 * - Instrumentation hooks for traces, metrics, custom integrations
 * - Structured logging with attributes
 * - Automatic request context (requestId, route, etc.)
 */

import { AsyncLocalStorage } from 'node:async_hooks';

// ============================================================================
// Observability Context
// ============================================================================

/**
 * Context data that propagates through the async tree.
 * Used by loggers, traces, and metrics.
 *
 * Standard fields (set automatically by the framework):
 * - requestId: Unique ID for the current request
 * - route: Route name being handled
 * - method: HTTP method
 * - path: Request path
 *
 * Observability vendors (OpenTelemetry, Datadog, etc.) typically add their
 * own fields like traceId, spanId via the string or symbol index signatures.
 *
 * You can add custom fields via runWithContext or logger.withContext.
 */
export interface ObservabilityContext {
  /** Unique request identifier */
  requestId?: string;
  /** Custom string-keyed data */
  [key: string]: unknown;
  /** Private data (symbol keys avoid naming conflicts between vendors) */
  [key: symbol]: unknown;
}


/**
 * Global async local storage for observability context.
 * All loggers, traces, and metrics read from this.
 */
const asyncContext = new AsyncLocalStorage<ObservabilityContext>();

/**
 * Get the current observability context.
 * Returns an empty object if no context is set.
 */
export function getContext(): ObservabilityContext {
  return asyncContext.getStore() ?? {};
}

/**
 * Capture the current context for later use in span linking.
 * Use this when you need to link a new async tree back to the current one.
 *
 * @example Event publishing with trace linking
 * ```typescript
 * // In HTTP handler - capture context before publishing event
 * const sourceContext = captureContext("caused_by");
 *
 * // Publish event with the captured context
 * await eventBus.publish("order.created", {
 *   orderId: "123",
 *   _traceContext: sourceContext, // Pass along for linking
 * });
 *
 * // In event handler - use captured context to link spans
 * await runInScopeAsync(
 *   {
 *     type: "handler",
 *     name: "order.created",
 *     links: [event._traceContext], // Links back to HTTP request span
 *   },
 *   {},
 *   async () => { ... }
 * );
 * ```
 */
export function captureContext(
  relationship: LinkedContext['relationship'] = 'caused_by'
): LinkedContext {
  return {
    context: { ...getContext() }, // Clone to avoid mutations
    relationship,
  };
}

/**
 * Run a function with additional context.
 * The context is merged with any existing context and propagates
 * through the entire async tree.
 *
 * @example
 * ```typescript
 * // Add user context after authentication
 * runWithContext({ userId: user.id, tenantId: user.tenantId }, async () => {
 *   // All logs, traces, metrics in this tree include userId + tenantId
 *   await processRequest();
 * });
 * ```
 */
export function runWithContext<T>(context: ObservabilityContext, fn: () => T): T {
  const currentContext = getContext();
  const mergedContext = { ...currentContext, ...context };

  // Notify instrumentations of scope start
  const scopeInfo: ScopeInfo = { type: 'custom', name: 'context' };
  for (const inst of instrumentations) {
    inst.onScopeStart?.(mergedContext, scopeInfo);
  }

  try {
    return asyncContext.run(mergedContext, fn);
  } finally {
    // Notify instrumentations of scope end
    for (const inst of instrumentations) {
      inst.onScopeEnd?.(mergedContext, scopeInfo);
    }
  }
}

/**
 * Enter a context scope using the `using` keyword.
 * The context is merged with existing context and automatically
 * restored when the scope exits.
 *
 * @example
 * ```typescript
 * // Add user context after authentication
 * using _ = withContext({ userId: user.id, tenantId: user.tenantId });
 * // All logs, traces, metrics include userId + tenantId
 * await processRequest();
 * // Context automatically restored when scope exits
 * ```
 *
 * @example Nested contexts
 * ```typescript
 * using _ = withContext({ requestId: "req-123" });
 * logger.info("Starting"); // has requestId
 *
 * {
 *   using _ = withContext({ userId: "user-456" });
 *   logger.info("Processing"); // has requestId AND userId
 * }
 *
 * logger.info("Done"); // only has requestId
 * ```
 */
export function withContext(context: ObservabilityContext): Disposable {
  const previousContext = asyncContext.getStore() ?? {};
  const mergedContext = { ...previousContext, ...context };

  // Notify instrumentations of scope start
  const scopeInfo: ScopeInfo = { type: 'custom', name: 'context' };
  for (const inst of instrumentations) {
    inst.onScopeStart?.(mergedContext, scopeInfo);
  }

  // Enter the new context
  asyncContext.enterWith(mergedContext);

  return {
    [Symbol.dispose]() {
      // Notify instrumentations of scope end
      for (const inst of instrumentations) {
        inst.onScopeEnd?.(mergedContext, scopeInfo);
      }
      // Restore previous context
      asyncContext.enterWith(previousContext);
    },
  };
}


// ============================================================================
// Instrumentation System
// ============================================================================

/** Log levels (trace is most verbose, error is least) */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/**
 * Numeric order used to compare levels. `trace` is lowest (most
 * verbose) - a log at level X is emitted when `LEVEL_ORDER[X]` is
 * `>= LEVEL_ORDER[minLevel]`.
 */
const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0, debug: 1, info: 2, warn: 3, error: 4,
};

/**
 * Process-wide minimum log level. Seeded from `JUSTSCALE_LOG_LEVEL`
 * (`trace|debug|info|warn|error`) or `JUSTSCALE_TRACE=1` for trace.
 */
let minLogLevel: LogLevel = resolveInitialLogLevel();

function resolveInitialLogLevel(): LogLevel {
  const explicit = (process.env.JUSTSCALE_LOG_LEVEL ?? '').toLowerCase();
  if (explicit === 'trace' || explicit === 'debug' || explicit === 'info' || explicit === 'warn' || explicit === 'error') {
    return explicit;
  }
  if (process.env.JUSTSCALE_TRACE === '1' || process.env.JUSTSCALE_TRACE === 'true') {
    return 'trace';
  }
  return 'info';
}

/** Current minimum log level. Read cheap, no allocation. */
export function getMinLogLevel(): LogLevel {
  return minLogLevel;
}

/**
 * Whether a log at `level` would be emitted given the current minimum.
 * Backends gate on this before doing any serialization work.
 */
export function isLevelEnabled(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLogLevel];
}

/** Listeners notified when the minimum log level changes. */
const levelListeners = new Set<(level: LogLevel) => void>();

/**
 * Subscribe to minimum-log-level changes. Backends that keep their own
 * level gate (e.g. pino) use this to stay in sync. Returns an unsubscribe.
 */
export function onMinLogLevelChange(listener: (level: LogLevel) => void): () => void {
  levelListeners.add(listener);
  return () => levelListeners.delete(listener);
}

/** Override the minimum log level at runtime. Takes effect on the next log call. */
export function setMinLogLevel(level: LogLevel): void {
  if (level === minLogLevel) return;
  minLogLevel = level;
  for (const listener of levelListeners) {
    listener(level);
  }
}

/**
 * A captured trace context that can be used to link spans across async boundaries.
 * Used when a new scope is spawned from another (e.g., event handler triggered by HTTP request).
 */
export interface LinkedContext {
  /** The observability context from the originating scope */
  context: ObservabilityContext;
  /** Relationship type for the link */
  relationship?: 'caused_by' | 'follows_from' | 'related';
}

/**
 * Information about the current scope (request, handler, etc.)
 */
export interface ScopeInfo {
  /** Type of scope */
  type: 'request' | 'middleware' | 'guard' | 'handler' | 'custom';
  /** Name of the scope (route name, middleware name, etc.) */
  name: string;
  /** Additional attributes */
  attributes?: Record<string, unknown>;
  /**
   * Links to related contexts from other async trees.
   * Used for distributed tracing when a scope is spawned from another
   * (e.g., event handler triggered by an HTTP request).
   */
  links?: LinkedContext[];
}

/**
 * Instrumentation interface for observability extensions.
 *
 * Implement this to integrate with any observability system:
 * metrics, tracing (OpenTelemetry, Datadog), custom logging, etc.
 *
 * @example Simple metrics instrumentation
 * ```typescript
 * const metricsInstrumentation: Instrumentation = {
 *   name: "metrics",
 *
 *   onScopeEnd(context, info, error) {
 *     if (info.type === "request") {
 *       metrics.increment("http.requests.total", {
 *         route: info.name,
 *         status: error ? "error" : "success",
 *       });
 *     }
 *   },
 * };
 *
 * registerInstrumentation(metricsInstrumentation);
 * ```
 *
 * @example OpenTelemetry integration (see @justscale/feature-otel)
 * ```typescript
 * import { otelFeature } from "@justscale/feature-otel";
 *
 * // Add to your app features for automatic tracing
 * const app = createStandaloneApp({
 *   features: [otelFeature({ serviceName: "my-api" })],
 * });
 * ```
 */
export interface Instrumentation {
  /** Unique name for this instrumentation */
  name: string;

  /**
   * Called when a new scope starts (request, middleware, etc.)
   * Can return modified context to add trace IDs, span references, etc.
   */
  onScopeStart?(context: ObservabilityContext, info: ScopeInfo): ObservabilityContext | void;

  /**
   * Called when a scope ends.
   * Use this to end spans, record metrics, etc.
   */
  onScopeEnd?(context: ObservabilityContext, info: ScopeInfo, error?: Error): void;

  /**
   * Called on each log statement.
   * Use this to forward logs to external systems or add to trace spans.
   */
  onLog?(
    level: LogLevel,
    message: string,
    attributes: Record<string, unknown>,
    context: ObservabilityContext
  ): void;
}

/** Registered instrumentations */
const instrumentations: Instrumentation[] = [];

/**
 * Register an instrumentation for observability hooks.
 *
 * @example
 * ```typescript
 * registerInstrumentation({
 *   name: "custom-metrics",
 *   onScopeEnd(context, info) {
 *     if (info.type === "request") {
 *       metrics.recordRequestDuration(info.name, Date.now() - context.startTime);
 *     }
 *   },
 * });
 * ```
 */
export function registerInstrumentation(instrumentation: Instrumentation): void {
  // Prevent duplicates
  const existing = instrumentations.findIndex((i) => i.name === instrumentation.name);
  if (existing >= 0) {
    instrumentations[existing] = instrumentation;
  } else {
    instrumentations.push(instrumentation);
  }
}

/**
 * Remove a registered instrumentation by name.
 */
export function unregisterInstrumentation(name: string): boolean {
  const index = instrumentations.findIndex((i) => i.name === name);
  if (index >= 0) {
    instrumentations.splice(index, 1);
    return true;
  }
  return false;
}

/**
 * Get all registered instrumentations (for testing).
 */
export function getInstrumentations(): readonly Instrumentation[] {
  return instrumentations;
}

/**
 * Forward a log line to every registered instrumentation's `onLog` hook.
 *
 * Backend-agnostic: any Logger implementation (ConsoleLogger, PinoLogger, ...)
 * calls this after it has decided the line passes the level gate, so OTel /
 * Datadog span-correlation keeps working regardless of the chosen backend.
 */
export function emitLog(
  level: LogLevel,
  message: string,
  attributes: Record<string, unknown>,
  context: ObservabilityContext
): void {
  for (const inst of instrumentations) {
    inst.onLog?.(level, message, attributes, context);
  }
}

// ============================================================================
// Scope Management (used internally by app.ts)
// ============================================================================

/**
 * Run a function within a named scope.
 * Notifies all instrumentations and handles errors properly.
 *
 * @internal Used by app.ts for request/middleware/handler scopes
 */
export function runInScope<T>(
  info: ScopeInfo,
  baseContext: ObservabilityContext,
  fn: () => T
): T {
  let context = { ...getContext(), ...baseContext };

  // Let instrumentations modify context (e.g., add span IDs)
  for (const inst of instrumentations) {
    const modified = inst.onScopeStart?.(context, info);
    if (modified) context = modified;
  }

  let error: Error | undefined;

  try {
    return asyncContext.run(context, fn);
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
    throw e;
  } finally {
    for (const inst of instrumentations) {
      inst.onScopeEnd?.(context, info, error);
    }
  }
}

/**
 * Async version of runInScope.
 * @internal
 */
export async function runInScopeAsync<T>(
  info: ScopeInfo,
  baseContext: ObservabilityContext,
  fn: () => Promise<T>
): Promise<T> {
  let context = { ...getContext(), ...baseContext };

  // Let instrumentations modify context (e.g., add span IDs)
  for (const inst of instrumentations) {
    const modified = inst.onScopeStart?.(context, info);
    if (modified) context = modified;
  }

  let error: Error | undefined;

  try {
    return await asyncContext.run(context, fn);
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
    throw e;
  } finally {
    for (const inst of instrumentations) {
      inst.onScopeEnd?.(context, info, error);
    }
  }
}

// ============================================================================
// Logger Interface
// ============================================================================

/**
 * Log attributes for structured logging.
 */
export type LogAttributes = Record<string, unknown>;

/**
 * Abstract Logger - use as DI token. Built-in service automatically
 * available to all services and handlers.
 */
export abstract class Logger {
  abstract trace(message: string, attributes?: LogAttributes): void;
  abstract debug(message: string, attributes?: LogAttributes): void;
  abstract info(message: string, attributes?: LogAttributes): void;
  abstract warn(message: string, attributes?: LogAttributes): void;
  abstract error(message: string, attributes?: LogAttributes): void;
  abstract child(name: string): Logger;

  withContext<T>(context: ObservabilityContext, fn: () => T): T {
    return runWithContext(context, fn);
  }
}

// ============================================================================
// Logger Factory
// ============================================================================

/**
 * Factory for creating Logger instances with context.
 *
 * An abstract class (not an interface) so it doubles as a DI token: a backend
 * binds itself with `defineService({ provides: [LoggerFactory], factory })`
 * and apps swap it with `.add(pinoLoggerFactory(...))` /
 * `.add(consoleLoggerFactory())` — the same `.add()` path as any other
 * service. The container resolves the bound factory once at bootstrap.
 */
export abstract class LoggerFactory {
  abstract create(name: string): Logger;
}

// ============================================================================
// Default Console Logger
// ============================================================================

export class ConsoleLogger extends Logger {
  constructor(private readonly name: string) {
    super();
  }

  private log(level: LogLevel, message: string, attributes?: LogAttributes): void {
    if (!isLevelEnabled(level)) {
      return;
    }

    const ctx = getContext();
    const timestamp = new Date().toISOString();

    // Build context string from observability context
    const ctxEntries = Object.entries(ctx)
      .filter(([k]) => !k.startsWith('_')) // Skip internal fields
      .map(([k, v]) => `${k}=${String(v)}`);
    const ctxStr = ctxEntries.length > 0 ? ` [${ctxEntries.join(' ')}]` : '';

    // Build attributes string
    const attrStr = attributes
      ? ' ' + JSON.stringify(attributes)
      : '';

    const formatted = `[${timestamp}] [${level.toUpperCase()}] [${this.name}]${ctxStr} ${message}${attrStr}`;

    // Output to console
    switch (level) {
      case 'trace':
        console.debug(formatted); // trace goes to debug channel
        break;
      case 'debug':
        console.debug(formatted);
        break;
      case 'info':
        console.info(formatted);
        break;
      case 'warn':
        console.warn(formatted);
        break;
      case 'error':
        console.error(formatted);
        break;
    }

    // Notify instrumentations
    emitLog(level, message, attributes ?? {}, ctx);
  }

  trace(message: string, attributes?: LogAttributes): void {
    this.log('trace', message, attributes);
  }

  debug(message: string, attributes?: LogAttributes): void {
    this.log('debug', message, attributes);
  }

  info(message: string, attributes?: LogAttributes): void {
    this.log('info', message, attributes);
  }

  warn(message: string, attributes?: LogAttributes): void {
    this.log('warn', message, attributes);
  }

  error(message: string, attributes?: LogAttributes): void {
    this.log('error', message, attributes);
  }

  child(childName: string): Logger {
    return new ConsoleLogger(`${this.name}:${childName}`);
  }
}

/**
 * Logger factory using the zero-dependency ConsoleLogger.
 * Opt in with `.add(consoleLoggerFactory())` when you don't want pino.
 */
export class ConsoleLoggerFactory extends LoggerFactory {
  create(name: string): Logger {
    return new ConsoleLogger(name);
  }
}

// ============================================================================
// Built-in Token Marker
// ============================================================================

/**
 * Symbol to identify Logger as a built-in service.
 * Used by Container to detect and special-case Logger resolution.
 */
export const LOGGER_TOKEN = Symbol('justscale:Logger');
(Logger as any)[LOGGER_TOKEN] = true;

/** @internal */
export function isLoggerToken(token: unknown): token is typeof Logger {
  return token === Logger || (token as any)?.[LOGGER_TOKEN] === true;
}
