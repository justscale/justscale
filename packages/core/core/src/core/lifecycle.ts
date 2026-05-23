/**
 * Lifecycle hook registration for graceful shutdown and extensible events.
 */

// ============================================================================
// Lifecycle Token
// ============================================================================

/**
 * Symbol to identify Lifecycle as a built-in service.
 * Used by Container to detect and special-case Lifecycle resolution.
 */
export const LIFECYCLE_TOKEN = Symbol('justscale:Lifecycle');

// ============================================================================
// Lifecycle Hooks Interface
// ============================================================================

/**
 * Extensible lifecycle hooks interface.
 * Transports and features extend this via module augmentation.
 *
 * @example Adding HTTP serving hook (in @justscale/http)
 * ```typescript
 * declare module '@justscale/core' {
 *   interface LifecycleHooks {
 *     httpServing(): Promise<void> | void
 *   }
 * }
 * ```
 *
 * @example Adding WebSocket ready hook (in @justscale/websocket)
 * ```typescript
 * declare module '@justscale/core' {
 *   interface LifecycleHooks {
 *     wsReady(): Promise<void> | void
 *   }
 * }
 * ```
 */
export interface LifecycleHooks {
  /** Called when cluster.stop() is invoked. LIFO order. */
  stop(): Promise<void> | void

  /**
   * Called when this service is about to be hot-reloaded (dev mode only).
   * Return state to preserve across the reload.
   *
   * The compiler automatically injects the returned state into variable
   * initializers, so you don't need manual restoration logic.
   *
   * @example
   * ```typescript
   * class CacheService extends defineService({
   *   inject: { lifecycle: Lifecycle },
   *   factory: ({ lifecycle }) => {
   *     const cache = new Map<string, User>()
   *
   *     // Declare what to preserve - compiler handles the rest
   *     lifecycle.register('hotReload', () => ({ cache }))
   *
   *     return { get: (id) => cache.get(id) }
   *   }
   * }) {}
   * ```
   */
  hotReload(): Promise<unknown> | unknown
}

// ============================================================================
// Lifecycle Abstract Class
// ============================================================================

/**
 * Lifecycle service for registering hooks.
 *
 * @example
 * ```typescript
 * class DatabaseService extends defineService({
 *   inject: { lifecycle: Lifecycle },
 *   factory: async ({ lifecycle }) => {
 *     const pool = await createPool()
 *     lifecycle.register('stop', async () => { await pool.end() })
 *     return { pool }
 *   }
 * }) {}
 * ```
 */
export abstract class Lifecycle {
  /**
   * Register a lifecycle hook handler.
   * 'stop' runs LIFO; all other hooks run FIFO.
   *
   * @throws Error if registering during the same hook's execution.
   */
  abstract register<K extends keyof LifecycleHooks>(
    hook: K,
    handler: LifecycleHooks[K]
  ): void;

  /** Returns true if the given hook phase is currently executing. */
  abstract isInPhase(hook: keyof LifecycleHooks): boolean;
}

;(Lifecycle as any)[LIFECYCLE_TOKEN] = true;

/** @internal */
export function isLifecycleToken(token: unknown): token is typeof Lifecycle {
  return token === Lifecycle || (token as any)?.[LIFECYCLE_TOKEN] === true;
}
