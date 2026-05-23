/**
 * ScheduledTask Route Builder
 *
 * Provides the builder pattern for scheduled task routes.
 */

import type { z } from 'zod';
import type {
  ScheduledTaskContext,
  ScheduledTaskRouteDef,
  ScheduledTaskRouteBuilder,
} from './types.js';

/** Symbols for scheduled task metadata (preserved through controller compilation) */
export const SCHEDULED_TASK_NAMESPACE = Symbol('scheduledTask:namespace');
export const SCHEDULED_TASK_TYPE = Symbol('scheduledTask:type');
export const SCHEDULED_TASK_QUALIFIED_NAME = Symbol('scheduledTask:qualifiedName');
export const SCHEDULED_TASK_PAYLOAD_SCHEMA = Symbol('scheduledTask:payloadSchema');

/** Read the qualified name from a scheduled task route. */
export function getScheduledTaskQualifiedName(route: unknown): string | undefined {
  return (route as Record<symbol, unknown>)?.[SCHEDULED_TASK_QUALIFIED_NAME] as string | undefined;
}

/** Read the payload schema from a scheduled task route. */
export function getScheduledTaskPayloadSchema(route: unknown): z.ZodType | undefined {
  return (route as Record<symbol, unknown>)?.[SCHEDULED_TASK_PAYLOAD_SCHEMA] as z.ZodType | undefined;
}

/**
 * Create a scheduled task route builder.
 *
 * @param namespace - Task namespace (e.g., 'process', 'email')
 * @param type - Task type within namespace (e.g., 'delay', 'reminder')
 */
export function createScheduledTaskRouteBuilder<
  TDeps,
  TPayload = unknown,
>(
  namespace: string,
  type: string,
): ScheduledTaskRouteBuilder<TDeps, TPayload, ScheduledTaskContext<TDeps, TPayload>> {
  const steps: { type: 'use' | 'guard'; fn: any }[] = [];
  let payloadSchema: z.ZodType | undefined;

  const builder: ScheduledTaskRouteBuilder<TDeps, TPayload, ScheduledTaskContext<TDeps, TPayload>> = {
    payload(schema) {
      payloadSchema = schema;
      return builder as any;
    },

    use(middleware) {
      steps.push({ type: 'use', fn: middleware });
      return builder as any;
    },

    guard(check) {
      steps.push({ type: 'guard', fn: check });
      return builder;
    },

    handle(handler) {
      const qualifiedName = `${namespace}.${type}`;
      const route = {
        method: 'SCHEDULED_TASK',
        path: qualifiedName,
        namespace,
        type,
        qualifiedName,
        payloadSchema,
        steps: [...steps],
        responseSchemas: new Map(),
        handler,
        [SCHEDULED_TASK_NAMESPACE]: namespace,
        [SCHEDULED_TASK_TYPE]: type,
        [SCHEDULED_TASK_QUALIFIED_NAME]: qualifiedName,
        [SCHEDULED_TASK_PAYLOAD_SCHEMA]: payloadSchema,
      } as ScheduledTaskRouteDef<TDeps, TPayload>;
      return route;
    },
  };

  return builder;
}
