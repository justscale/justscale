import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import JustScale from '../../src/justscale.js';
import { bindInstance, InMemoryProcessStorage } from '../../src/index.js';
import {
  InMemoryScheduledTaskRepository,
  ScheduledTask,
  ScheduledTaskRepository,
} from '../../src/models/index.js';
import {
  ScheduledTaskTimerScheduler,
} from '../../src/runtime/process/scheduled-task-timer.js';
import type { TimerFired } from '../../src/runtime/process/timer-scheduler.js';

// =============================================================================
// Test Repository Instance
// =============================================================================

const taskRepo = new InMemoryScheduledTaskRepository();

// =============================================================================
// Test App
// =============================================================================

const built = JustScale()
  .add(InMemoryProcessStorage as any)  // Required for build()
  .add(bindInstance(ScheduledTaskRepository, taskRepo))
  .add(ScheduledTaskTimerScheduler as any)
  .build();

// =============================================================================
// Tests
// =============================================================================

describe('ScheduledTaskTimerScheduler', () => {
  let app: Awaited<ReturnType<typeof built.compile>>;
  let scheduler: any;

  before(async () => {
    app = built.compile();
    await app.ready;

    scheduler = await app.container.resolve(ScheduledTaskTimerScheduler);
  });

  after(async () => {
    scheduler.stop();
  });

  describe('schedule', () => {
    it('creates a scheduled task', async () => {
      const expiresAt = new Date(Date.now() + 60000);
      const timerId = await scheduler.schedule('instance-1', expiresAt);

      assert.ok(timerId);

      const task = await taskRepo.get(ScheduledTask.ref(timerId));
      assert.ok(task);
      assert.strictEqual(task.namespace, 'process');
      assert.strictEqual(task.type, 'delay');
      assert.strictEqual((task.payload as { instanceId: string }).instanceId, 'instance-1');
    });

    it('includes branchId in payload when provided', async () => {
      const expiresAt = new Date(Date.now() + 60000);
      const timerId = await scheduler.schedule('instance-1', expiresAt, 'branch-a');

      const task = await taskRepo.get(ScheduledTask.ref(timerId));
      assert.ok(task);
      assert.deepStrictEqual(task.payload, {
        instanceId: 'instance-1',
        branchId: 'branch-a',
      });
    });
  });

  describe('cancel', () => {
    it('cancels a scheduled timer', async () => {
      const timerId = await scheduler.schedule(
        'instance-1',
        new Date(Date.now() + 60000)
      );

      await scheduler.cancel(timerId);

      const task = await taskRepo.get(ScheduledTask.ref(timerId));
      assert.ok(task);
      assert.strictEqual(task.status, 'cancelled');
    });
  });

  describe('cancelAll', () => {
    it('cancels all timers for an instance', async () => {
      await scheduler.schedule('instance-1', new Date(Date.now() + 60000));
      await scheduler.schedule('instance-1', new Date(Date.now() + 120000));
      await scheduler.schedule('instance-2', new Date(Date.now() + 60000));

      await scheduler.cancelAll('instance-1');

      const tasks = taskRepo.getAll();
      const instance1Tasks = tasks.filter(
        (t) => (t.payload as { instanceId: string }).instanceId === 'instance-1'
      );
      const instance2Tasks = tasks.filter(
        (t) => (t.payload as { instanceId: string }).instanceId === 'instance-2'
      );

      // instance-1 tasks should be cancelled
      assert.ok(instance1Tasks.every((t) => t.status === 'cancelled'));

      // instance-2 task should still be pending
      assert.strictEqual(instance2Tasks[0].status, 'pending');
    });
  });

  describe('subscription', () => {
    it('fires callback when receiveFire is called', async () => {
      const fired: TimerFired[] = [];
      const unsubscribe = scheduler.onFire((f: TimerFired) => fired.push(f));

      // Schedule a timer
      const timerId = await scheduler.schedule(
        'instance-fire-test',
        new Date(Date.now() + 60000)
      );

      // Simulate transport calling receiveFire when task is due
      scheduler.receiveFire({
        timerId,
        instanceId: 'instance-fire-test',
      });

      assert.strictEqual(fired.length, 1);
      assert.strictEqual(fired[0].timerId, timerId);
      assert.strictEqual(fired[0].instanceId, 'instance-fire-test');

      unsubscribe();
    });

    it('includes branchId in fired event', async () => {
      const fired: TimerFired[] = [];
      const unsubscribe = scheduler.onFire((f: TimerFired) => fired.push(f));

      const timerId = await scheduler.schedule(
        'instance-branch-test',
        new Date(Date.now() + 60000),
        'branch-timeout'
      );

      // Simulate transport calling receiveFire
      scheduler.receiveFire({
        timerId,
        instanceId: 'instance-branch-test',
        branchId: 'branch-timeout',
      });

      assert.strictEqual(fired[0].branchId, 'branch-timeout');

      unsubscribe();
    });

    it('unsubscribe stops receiving events', async () => {
      const fired: TimerFired[] = [];
      const unsubscribe = scheduler.onFire((f: TimerFired) => fired.push(f));

      // Unsubscribe before firing
      unsubscribe();

      // This should not be received
      scheduler.receiveFire({
        timerId: 'timer-1',
        instanceId: 'instance-1',
      });

      assert.strictEqual(fired.length, 0);
    });
  });

  describe('qualifiedName', () => {
    it('returns process.delay', () => {
      assert.strictEqual(scheduler.qualifiedName, 'process.delay');
    });
  });
});
