/**
 * Transport plugin for scheduled tasks.
 * Auto-registers on import and starts processing when cluster.serve() is called.
 */

import {
  type TransportPlugin,
  type Cluster,
  type ServeOptions,
  registerTransport,
} from '../cluster.js';
import {
  type Persistent,
  type ScheduledTask,
  ScheduledTaskRepository,
} from '../../models/index.js';
import { ADAPTER_KEY } from '../../models/symbols.js';
import type { ScheduledTaskContext } from './types.js';
import {
  getScheduledTaskQualifiedName,
  getScheduledTaskPayloadSchema,
} from './builder.js';

/** Symbol to store worker state on the cluster */
const WORKER_STATE = Symbol('scheduledTask:workerState');

/** Read the worker state from a cluster instance. */
function getWorkerState(cluster: unknown): WorkerState | undefined {
  return (cluster as Record<symbol, unknown>)?.[WORKER_STATE] as WorkerState | undefined;
}

/** Set the worker state on a cluster instance. */
function setWorkerState(cluster: unknown, state: WorkerState): void {
  (cluster as Record<symbol, unknown>)[WORKER_STATE] = state;
}

interface WorkerState {
  running: boolean
  abortController: AbortController | null
  subscriptionPromises: Promise<void>[]
}

/**
 * Options for scheduled task transport.
 */
export interface ScheduledTaskServeOptions {
  /** Polling interval in ms (default: 1000) */
  pollInterval?: number
}

/** Entry in the route map */
interface RouteEntry {
  route: any // CompiledRoute
  qualifiedName: string
  payloadSchema: any
  deps: Record<string, unknown>
}

/**
 * Process a single task through the route's middleware pipeline.
 */
async function processTask(
  task: Persistent<ScheduledTask>,
  entry: RouteEntry,
): Promise<void> {
  const { route, payloadSchema, deps } = entry;

  // Validate payload if schema is provided
  let payload = task.payload;
  if (payloadSchema) {
    const result = payloadSchema.safeParse(task.payload);
    if (!result.success) {
      console.error(
        `[ScheduledTask] Payload validation failed for task ${(task as unknown as Record<symbol, unknown>)[ADAPTER_KEY] as string}:`,
        result.error.flatten()
      );
      return; // Skip task with invalid payload
    }
    payload = result.data;
  }

  // Build context
  const ctx: ScheduledTaskContext = {
    deps,
    task,
    payload,
    qualifiedName: task.qualifiedName,
  };

  // Execute middlewares (from CompiledRoute)
  let context: Record<string, unknown> = ctx as any;
  for (const middleware of route.middlewares || []) {
    if (typeof middleware === 'function') {
      const added = await middleware(context);
      context = { ...context, ...added };
    }
  }

  // Execute guards (from CompiledRoute)
  for (const guard of route.guards || []) {
    if (typeof guard === 'function') {
      const result = await guard(context);
      if (result === false) {
        return; // Guard rejected, skip handler
      }
    }
  }

  // Execute handler
  await route.handler(context as any);
}

/**
 * Scheduled task transport plugin.
 * Auto-starts processing when cluster.serve() is called.
 */
const scheduledTaskTransport: TransportPlugin = {
  name: 'scheduled-task',

  async onServe(cluster: Cluster<any>, options: ServeOptions): Promise<void> {
    const app = cluster.app;
    const pollInterval = options.scheduledTask?.pollInterval ?? 1000;

    // Try to resolve the repository from the container
    let repository: ScheduledTaskRepository;
    try {
      repository = await app.container.resolve(ScheduledTaskRepository);
    } catch {
      // No repository registered - check if there are any scheduled task routes
      const hasScheduledTaskRoutes = app.controllers.some(controller =>
        controller.routes.some((route: any) => route.method === 'SCHEDULED_TASK')
      );

      if (hasScheduledTaskRoutes) {
        console.warn(
          '[ScheduledTask] Found ScheduledTask routes but no ScheduledTaskRepository registered. ' +
          'Add InMemoryScheduledTaskRepository or PgScheduledTaskRepository to your cluster.'
        );
      }
      return;
    }

    const routesByQualifiedName = new Map<string, {
      route: any
      qualifiedName: string
      payloadSchema: any
      deps: Record<string, unknown>
    }>();

    for (const controller of app.controllers) {
      for (const route of controller.routes) {
        if ((route as any).method === 'SCHEDULED_TASK') {
          const qualifiedName = getScheduledTaskQualifiedName(route);
          const payloadSchema = getScheduledTaskPayloadSchema(route);
          if (qualifiedName) {
            routesByQualifiedName.set(qualifiedName, {
              route,
              qualifiedName,
              payloadSchema,
              deps: controller.deps,
            });
          }
        }
      }
    }

    if (routesByQualifiedName.size === 0) {
      return; // No scheduled task routes
    }

    const state: WorkerState = {
      running: true,
      abortController: new AbortController(),
      subscriptionPromises: [],
    };

    setWorkerState(cluster, state);

    for (const [qualifiedName, entry] of routesByQualifiedName) {
      const promise = (async () => {
        try {
          for await (const task of repository.subscribe(qualifiedName, {
            signal: state.abortController?.signal,
            pollInterval,
          })) {
            try {
              await processTask(task, entry);
            } catch (error) {
              console.error(`[ScheduledTask] Error processing task ${(task as unknown as Record<symbol, unknown>)[ADAPTER_KEY] as string}:`, error);
            }
          }
        } catch (error) {
          if (state.running) {
            console.error(`[ScheduledTask] Subscription error for ${qualifiedName}:`, error);
          }
        }
      })();

      state.subscriptionPromises.push(promise);
    }

    console.log(`[ScheduledTask] Started processing ${routesByQualifiedName.size} task type(s)`);
  },

  async onStop(cluster: Cluster<any>): Promise<void> {
    const state = getWorkerState(cluster);
    if (!state) return;

    state.running = false;
    state.abortController?.abort();

    await Promise.all(state.subscriptionPromises);

    console.log('[ScheduledTask] Stopped processing');
  },
};

registerTransport(scheduledTaskTransport);
