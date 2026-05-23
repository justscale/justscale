/**
 * Lifecycle Implementation
 *
 * Concrete implementation of the Lifecycle abstract class.
 * Manages handler registration and execution with proper ordering.
 */

import { Lifecycle, type LifecycleHooks } from './lifecycle.js';

// ============================================================================
// Types
// ============================================================================

type HookHandler = () => Promise<void> | void;
type HotReloadHandler = () => Promise<unknown> | unknown;

// ============================================================================
// Lifecycle Implementation
// ============================================================================

/** @internal Concrete Lifecycle implementation used by the kernel. */
export class LifecycleImpl extends Lifecycle {
  private handlers = new Map<keyof LifecycleHooks, HookHandler[]>();
  private currentPhase: keyof LifecycleHooks | null = null;

  private hotReloadHandlers = new Map<string, HotReloadHandler>();
  private currentServiceId: string | null = null;

  /**
   * Register a lifecycle hook handler.
   *
   * @throws Error if attempting to register during the same hook's execution
   */
  register<K extends keyof LifecycleHooks>(
    hook: K,
    handler: LifecycleHooks[K]
  ): void {
    if (this.currentPhase === hook) {
      throw new Error(
        `Cannot register '${hook}' handler while '${hook}' phase is running`
      );
    }

    if (hook === 'hotReload') {
      if (!this.currentServiceId) {
        console.warn('[Lifecycle] hotReload handler registered without service context - will be ignored');
        return;
      }
      this.hotReloadHandlers.set(this.currentServiceId, handler as HotReloadHandler);
      return;
    }

    const handlers = this.handlers.get(hook) ?? [];
    handlers.push(handler as HookHandler);
    this.handlers.set(hook, handlers);
  }

  /**
   * Check if a specific lifecycle phase is currently running.
   */
  isInPhase(hook: keyof LifecycleHooks): boolean {
    return this.currentPhase === hook;
  }

  /**
   * Run all handlers for a hook.
   *
   * Execution order:
   * - 'stop': LIFO (reverse order) for proper dependency cleanup
   * - All others: FIFO (registration order)
   *
   * Error handling:
   * - Errors are caught and logged
   * - Execution continues with remaining handlers
   * - All handlers are guaranteed to be called
   *
   * @param hook - The hook to execute handlers for
   */
  async runHook(hook: keyof LifecycleHooks): Promise<void> {
    this.currentPhase = hook;

    try {
      const handlers = this.handlers.get(hook) ?? [];

      const ordered = hook === 'stop' ? [...handlers].reverse() : handlers;

      for (const handler of ordered) {
        try {
          await handler();
        } catch (error) {
          console.error(`[Lifecycle] ${hook} handler threw:`, error);
        }
      }
    } finally {
      this.currentPhase = null;
    }
  }

  setServiceContext(serviceId: string | null): void {
    this.currentServiceId = serviceId;
  }

  getServiceContext(): string | null {
    return this.currentServiceId;
  }

  async runHotReload(serviceId: string): Promise<unknown> {
    const handler = this.hotReloadHandlers.get(serviceId);
    if (!handler) {
      return undefined;
    }

    try {
      return await handler();
    } catch (error) {
      console.error(`[Lifecycle] hotReload handler for ${serviceId} threw:`, error);
      return undefined;
    }
  }

  hasHotReloadHandler(serviceId: string): boolean {
    return this.hotReloadHandlers.has(serviceId);
  }

  clearHotReloadHandler(serviceId: string): void {
    this.hotReloadHandlers.delete(serviceId);
  }
}
