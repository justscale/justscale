/**
 * @justscale/cluster/scheduled-task
 *
 * Route factory for handling scheduled tasks in controllers.
 * Auto-registers as a transport plugin - tasks are processed when cluster.serve() is called.
 *
 * @example
 * ```typescript
 * import { createController } from '../../index.js'
 * import { createClusterBuilder } from '@justscale/cluster'
 * import { ScheduledTask } from '@justscale/cluster/scheduled-task'
 * import { InMemoryScheduledTaskRepository } from '../../models/index.js'
 * import { z } from 'zod'
 *
 * const TaskController = createController({
 *   routes: () => ({
 *     processDelay: ScheduledTask('process', 'delay')
 *       .payload(z.object({
 *         instanceId: z.string(),
 *         branchId: z.string().optional(),
 *       }))
 *       .handle(async ({ payload }) => {
 *         await resumeProcess(payload.instanceId, payload.branchId)
 *       }),
 *   }),
 * })
 *
 * const cluster = createClusterBuilder()
 *   .add(InMemoryScheduledTaskRepository)
 *   .add(TaskController)
 *   .build()
 *
 * // Scheduled task processing starts automatically
 * await cluster.serve({ http: 3000 })
 * ```
 */

// Factory function (registers route factory as side effect)
export { ScheduledTask } from './factory.js';

// Builder (for advanced use)
export { createScheduledTaskRouteBuilder } from './builder.js';

// Builder symbols (for route detection)
export {
  SCHEDULED_TASK_NAMESPACE,
  SCHEDULED_TASK_TYPE,
  SCHEDULED_TASK_QUALIFIED_NAME,
  SCHEDULED_TASK_PAYLOAD_SCHEMA,
  getScheduledTaskQualifiedName,
  getScheduledTaskPayloadSchema,
} from './builder.js';

// Types
export type {
  ScheduledTaskContext,
  ScheduledTaskRouteDef,
  ScheduledTaskRouteBuilder,
} from './types.js';

// Cluster serve options
export type { ScheduledTaskServeOptions } from './transport.js';

// Auto-register transport plugin (side effect import)
import './transport.js';
