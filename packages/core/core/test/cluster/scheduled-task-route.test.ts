/**
 * ScheduledTask Route Factory Tests
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  ScheduledTask,
  createScheduledTaskRouteBuilder,
  type ScheduledTaskRouteDef,
} from '../../src/cluster/scheduled-task/index.js';

describe('ScheduledTask', () => {
  test('creates a route with namespace and type', () => {
    const route = ScheduledTask('email', 'reminder')
      .handle(async ({ payload }) => {
        // Handler
      });

    assert.equal(route.method, 'SCHEDULED_TASK');
    assert.equal(route.namespace, 'email');
    assert.equal(route.type, 'reminder');
    assert.equal(route.qualifiedName, 'email.reminder');
    assert.equal(typeof route.handler, 'function');
  });

  test('builder supports payload schema', () => {
    const PayloadSchema = z.object({
      instanceId: z.string(),
      branchId: z.string().optional(),
    });

    const route = ScheduledTask('process', 'delay')
      .payload(PayloadSchema)
      .handle(async ({ payload }) => {
        // payload is typed as { instanceId: string; branchId?: string }
      });

    assert.equal(route.payloadSchema, PayloadSchema);
  });

  test('builder supports middleware', () => {
    const route = ScheduledTask('order', 'timeout')
      .use(ctx => ({ logger: console }))
      .handle(async ({ payload, logger }) => {
        // Handler with logger from middleware
      });

    assert.equal(route.steps.filter((s: any) => s.type === 'use').length, 1);
  });

  test('builder supports guards', () => {
    const route = ScheduledTask('order', 'timeout')
      .guard(ctx => true)
      .handle(async ({ payload }) => {
        // Handler
      });

    assert.equal(route.steps.filter((s: any) => s.type === 'guard').length, 1);
  });

  test('builder supports chaining payload, middleware and guards', () => {
    const route = ScheduledTask('order', 'timeout')
      .payload(z.object({ orderId: z.string() }))
      .use(ctx => ({ extra: 'data' }))
      .guard(ctx => true)
      .use(ctx => ({ more: 'stuff' }))
      .guard(ctx => false)
      .handle(async ({ payload }) => {
        // Handler
      });

    assert.ok(route.payloadSchema);
    assert.equal(route.steps.filter((s: any) => s.type === 'use').length, 2);
    assert.equal(route.steps.filter((s: any) => s.type === 'guard').length, 2);
  });
});

describe('createScheduledTaskRouteBuilder', () => {
  test('creates a builder that can be used directly', () => {
    interface TaskPayload {
      instanceId: string
      branchId?: string
    }

    const route = createScheduledTaskRouteBuilder<{}, TaskPayload>('process', 'delay')
      .handle(async ({ payload }) => {
        const { instanceId, branchId } = payload;
        // Process
      });

    assert.equal(route.namespace, 'process');
    assert.equal(route.type, 'delay');
    assert.equal(route.qualifiedName, 'process.delay');
  });
});
