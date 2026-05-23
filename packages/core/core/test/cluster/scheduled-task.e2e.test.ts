/**
 * E2E Tests for ScheduledTask Protocol
 *
 * Tests the complete scheduled task flow using in-memory repository
 * and JustScale(), following the auth e2e test patterns.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import JustScale, { createController, bindInstance, bindService } from '../../src/index.js';
import { InMemoryProcessFeature } from '../../src/process/index.js';
import { InMemoryLockFeature } from '../../src/features/memory/index.js';
import {
  InMemoryScheduledTaskRepository,
  ScheduledTaskRepository,
} from '../../src/models/index.js';
import { z } from 'zod';

import { ScheduledTask } from '../../src/cluster/scheduled-task/index.js';

describe('ScheduledTask E2E', async () => {
  // Track processed tasks for assertions
  const processedTasks: Array<{ namespace: string; type: string; payload: unknown }> = [];

  // Create repository instance (shared for scheduling tasks in tests)
  const taskRepo = new InMemoryScheduledTaskRepository();

  // Create a controller with scheduled task routes
  const TaskController = createController({
    inject: {},
    routes: () => ({
      reportGeneration: ScheduledTask('report', 'generate')
        .payload(z.object({
          reportId: z.string(),
          format: z.string().optional(),
        }))
        .handle(async ({ payload }) => {
          processedTasks.push({
            namespace: 'report',
            type: 'generate',
            payload,
          });
        }),

      emailReminder: ScheduledTask('email', 'reminder')
        .payload(z.object({
          userId: z.string(),
          message: z.string(),
        }))
        .handle(async ({ payload }) => {
          processedTasks.push({
            namespace: 'email',
            type: 'reminder',
            payload,
          });
        }),
    }),
  });

  // Build the app using JustScale() and bindInstance for the repository
  const builtCluster = JustScale()
    .add(InMemoryLockFeature)
    .add(InMemoryProcessFeature)  // Required for build()
    .add(bindInstance(ScheduledTaskRepository, taskRepo))
    .add(TaskController)
    .build();

  const app = builtCluster.compile();
  await app.ready;

  // Start serving with transport plugins
  await builtCluster.serve({
    noSocket: true,
    scheduledTask: { pollInterval: 50 }, // Fast polling for tests
  });

  // Cleanup after all tests
  after(async () => {
    await builtCluster.stop();
  });

  // Clear state before each test
  beforeEach(() => {
    processedTasks.length = 0;
  });

  // ==========================================================================
  // Task Processing Tests
  // ==========================================================================

  describe('task processing', () => {
    it('should process scheduled task when due', async () => {
      // Schedule a task that's immediately due
      await taskRepo.schedule({
        dueAt: new Date(),
        namespace: 'report',
        type: 'generate',
        payload: { reportId: 'test-123', format: 'pdf' },
      });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 200));

      // Verify task was processed
      assert.strictEqual(processedTasks.length, 1);
      assert.deepStrictEqual(processedTasks[0], {
        namespace: 'report',
        type: 'generate',
        payload: { reportId: 'test-123', format: 'pdf' },
      });
    });

    it('should process multiple task types', async () => {
      // Schedule both types
      await taskRepo.schedule({
        dueAt: new Date(),
        namespace: 'report',
        type: 'generate',
        payload: { reportId: 'multi-1' },
      });

      await taskRepo.schedule({
        dueAt: new Date(),
        namespace: 'email',
        type: 'reminder',
        payload: { userId: 'user-1', message: 'Hello!' },
      });

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 200));

      // Verify both tasks processed
      assert.strictEqual(processedTasks.length, 2);

      const reportTask = processedTasks.find(t => t.namespace === 'report');
      const emailTask = processedTasks.find(t => t.namespace === 'email');

      assert.ok(reportTask);
      assert.deepStrictEqual(reportTask.payload, { reportId: 'multi-1' });

      assert.ok(emailTask);
      assert.deepStrictEqual(emailTask.payload, { userId: 'user-1', message: 'Hello!' });
    });
  });

  // ==========================================================================
  // Payload Validation Tests
  // ==========================================================================

  describe('payload validation', () => {
    it('should validate payload against schema', async () => {
      // Schedule a task with invalid payload (missing required field)
      await taskRepo.schedule({
        dueAt: new Date(),
        namespace: 'email',
        type: 'reminder',
        payload: { userId: 'user-1' }, // Missing 'message' field
      });

      // Wait for processing attempt
      await new Promise(resolve => setTimeout(resolve, 200));

      // Task should NOT be processed due to validation failure
      assert.strictEqual(processedTasks.length, 0);
    });

    it('should accept valid payload', async () => {
      await taskRepo.schedule({
        dueAt: new Date(),
        namespace: 'email',
        type: 'reminder',
        payload: { userId: 'user-2', message: 'Valid message!' },
      });

      await new Promise(resolve => setTimeout(resolve, 200));

      assert.strictEqual(processedTasks.length, 1);
      assert.deepStrictEqual(processedTasks[0].payload, {
        userId: 'user-2',
        message: 'Valid message!',
      });
    });
  });

  // ==========================================================================
  // Unregistered Task Types
  // ==========================================================================

  describe('unregistered task types', () => {
    it('should not process tasks for unregistered types', async () => {
      // Schedule a task for a type that has no handler
      await taskRepo.schedule({
        dueAt: new Date(),
        namespace: 'unknown',
        type: 'task',
        payload: { data: 'test' },
      });

      // Wait
      await new Promise(resolve => setTimeout(resolve, 200));

      // Should not be processed (no handler registered)
      assert.strictEqual(processedTasks.length, 0);
    });
  });
});
