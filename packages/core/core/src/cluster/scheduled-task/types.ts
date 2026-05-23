/**
 * ScheduledTask Route Types
 *
 * Type definitions for scheduled task routes in controllers.
 */

import type { Prettify } from '../../index.js';
import type { z } from 'zod';
import type { Persistent, ScheduledTask } from '../../models/index.js';

/**
 * Context passed to scheduled task handlers.
 */
export interface ScheduledTaskContext<
  TDeps = Record<string, unknown>,
  TPayload = unknown,
> {
  /** Controller dependencies */
  deps: TDeps
  /** The task being processed */
  task: Persistent<ScheduledTask>
  /** Typed and validated payload from the task */
  payload: TPayload
  /** The qualified name (namespace.type) */
  qualifiedName: string
}

/**
 * Scheduled task route definition.
 */
export interface ScheduledTaskRouteDef<
  TDeps = Record<string, unknown>,
  TPayload = unknown,
> {
  /** Route method - always 'SCHEDULED_TASK' */
  method: 'SCHEDULED_TASK'
  /** Path (same as qualifiedName for routing compatibility) */
  path: string
  /** Task namespace (e.g., 'process', 'email') */
  namespace: string
  /** Task type within namespace (e.g., 'delay', 'reminder') */
  type: string
  /** Qualified name (namespace.type) */
  qualifiedName: string
  /** Zod schema for payload validation (optional but recommended) */
  payloadSchema?: z.ZodType<TPayload>
  /** Middleware and guards pipeline */
  steps: { type: 'use' | 'guard'; fn: any }[]
  /** Response schemas */
  responseSchemas: Map<number, any>
  /** The handler function */
  handler: (ctx: ScheduledTaskContext<TDeps, TPayload>) => void | Promise<void>
}

/**
 * Builder interface for scheduled task routes.
 *
 * @typeParam TDeps - Controller dependencies
 * @typeParam TPayload - Task payload type
 * @typeParam TContext - Current context after middleware
 */
export interface ScheduledTaskRouteBuilder<
  TDeps,
  TPayload,
  TContext extends ScheduledTaskContext<TDeps, TPayload>,
> {
  /**
   * Specify the payload schema for validation.
   * The worker will validate the task payload against this schema
   * before calling the handler.
   *
   * @example
   * ```typescript
   * ScheduledTask('process', 'delay')
   *   .payload(z.object({
   *     instanceId: z.string(),
   *     branchId: z.string().optional(),
   *   }))
   *   .handle(async ({ payload }) => {
   *     // payload is typed as { instanceId: string; branchId?: string }
   *   })
   * ```
   */
  payload<TSchema extends z.ZodType>(
    schema: TSchema
  ): ScheduledTaskRouteBuilder<
    TDeps,
    z.infer<TSchema>,
    Prettify<Omit<TContext, 'payload'> & { payload: z.infer<TSchema> }>
  >

  /**
   * Add middleware that extends the context.
   */
  use<TAdded extends object>(
    middleware: ((ctx: TContext) => TAdded | Promise<TAdded>)
  ): ScheduledTaskRouteBuilder<TDeps, TPayload, Prettify<TContext & TAdded>>

  /**
   * Add a guard that gates access to the handler.
   */
  guard(
    check: (ctx: TContext) => void | boolean | Promise<void | boolean>
  ): ScheduledTaskRouteBuilder<TDeps, TPayload, TContext>

  /**
   * Set the final handler for the task.
   */
  handle(
    handler: (ctx: TContext) => void | Promise<void>
  ): ScheduledTaskRouteDef<TDeps, TPayload>
}
