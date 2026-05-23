/**
 * ScheduledTask Route Factory
 *
 * Creates the ScheduledTask route factory for defining scheduled task handlers.
 *
 * @example
 * ```typescript
 * import { createController } from '../../index.js'
 * import { ScheduledTask } from '@justscale/cluster/scheduled-task'
 *
 * const ProcessController = createController({
 *   inject: { executor: ProcessExecutor },
 *   routes: ({ deps }) => ({
 *     processDelay: ScheduledTask('process', 'delay')
 *       .payload(z.object({
 *         instanceId: z.string(),
 *         branchId: z.string().optional(),
 *       }))
 *       .handle(async ({ payload, deps }) => {
 *         await deps.executor.resume(payload.instanceId, payload.branchId)
 *       }),
 *   }),
 * })
 * ```
 */

import { registerRouteFactory } from '../../index.js';
import { createScheduledTaskRouteBuilder } from './builder.js';
import type {
  ScheduledTaskContext,
  ScheduledTaskRouteBuilder,
} from './types.js';

/**
 * ScheduledTask route factory.
 *
 * Creates a route builder for handling scheduled tasks.
 *
 * @param namespace - Task namespace (e.g., 'process', 'email')
 * @param type - Task type within namespace (e.g., 'delay', 'reminder')
 *
 * @example Builder pattern with payload schema
 * ```typescript
 * ScheduledTask('email', 'reminder')
 *   .payload(z.object({ userId: z.string() }))
 *   .use(ctx => ({ logger: createLogger('email') }))
 *   .handle(async ({ payload, logger }) => {
 *     await sendReminderEmail(payload.userId)
 *   })
 * ```
 *
 * @example With guards
 * ```typescript
 * ScheduledTask('order', 'timeout')
 *   .payload(z.object({ orderId: z.string() }))
 *   .guard(async ({ task }) => {
 *     // Skip if task is too old
 *     return Date.now() - task.dueAt.getTime() < 60_000
 *   })
 *   .handle(async ({ payload }) => {
 *     await cancelOrder(payload.orderId)
 *   })
 * ```
 */
export function ScheduledTask(
  namespace: string,
  type: string,
): ScheduledTaskRouteBuilder<
  Record<string, unknown>,
  unknown,
  ScheduledTaskContext<Record<string, unknown>, unknown>
> {
  return createScheduledTaskRouteBuilder<Record<string, unknown>, unknown>(namespace, type);
}

// Register the factory for use in controllers
registerRouteFactory('ScheduledTask', ScheduledTask);

// Module augmentation for SupportedMethods
declare module '@justscale/core' {
  interface SupportedMethods {
    SCHEDULED_TASK: { transport: 'scheduled-task' }
  }
}

declare module '@justscale/core/plugin' {
  interface SupportedMethods {
    SCHEDULED_TASK: { transport: 'scheduled-task' }
  }

  interface RouteFactories<TDeps> {
    ScheduledTask(
      namespace: string,
      type: string,
    ): ScheduledTaskRouteBuilder<TDeps, unknown, ScheduledTaskContext<TDeps, unknown>>
  }
}
