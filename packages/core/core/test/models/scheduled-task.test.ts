import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  ScheduledTask,
  ScheduledTaskStatus,
  InMemoryScheduledTaskRepository,
  ADAPTER_KEY,
} from '../../src/models/index.js';

const id = (e: unknown) => (e as Record<symbol, unknown>)[ADAPTER_KEY] as string;

describe('ScheduledTask', () => {
  describe('model', () => {
    it('has qualifiedName getter', () => {
      const task = new ScheduledTask({
        dueAt: new Date(),
        namespace: 'process',
        type: 'delay',
        payload: { processId: '123' },
        status: 'pending',
      });

      assert.strictEqual(task.qualifiedName, 'process.delay');
    });

    it('isDue returns true when task is due and pending', () => {
      const pastDate = new Date(Date.now() - 1000);
      const task = new ScheduledTask({
        dueAt: pastDate,
        namespace: 'process',
        type: 'delay',
        payload: {},
        status: 'pending',
      });

      assert.strictEqual(task.isDue(), true);
    });

    it('isDue returns false when task is not yet due', () => {
      const futureDate = new Date(Date.now() + 60000);
      const task = new ScheduledTask({
        dueAt: futureDate,
        namespace: 'process',
        type: 'delay',
        payload: {},
        status: 'pending',
      });

      assert.strictEqual(task.isDue(), false);
    });

    it('isDue returns false when task is not pending', () => {
      const pastDate = new Date(Date.now() - 1000);
      const task = new ScheduledTask({
        dueAt: pastDate,
        namespace: 'process',
        type: 'delay',
        payload: {},
        status: 'processing',
      });

      assert.strictEqual(task.isDue(), false);
    });
  });
});

describe('InMemoryScheduledTaskRepository', () => {
  let scheduler: InMemoryScheduledTaskRepository;

  beforeEach(() => {
    scheduler = new InMemoryScheduledTaskRepository();
  });

  describe('schedule', () => {
    it('creates a task with pending status', async () => {
      const dueAt = new Date(Date.now() + 60000);
      const task = await scheduler.schedule({
        dueAt,
        namespace: 'process',
        type: 'delay',
        payload: { processId: '123' },
      });

      assert.ok(id(task));
      assert.strictEqual(task.namespace, 'process');
      assert.strictEqual(task.type, 'delay');
      assert.strictEqual(task.status, ScheduledTaskStatus.Pending);
      assert.deepStrictEqual(task.payload, { processId: '123' });
      assert.strictEqual(task.dueAt.getTime(), dueAt.getTime());
    });

    it('stores the task in the repository', async () => {
      const task = await scheduler.schedule({
        dueAt: new Date(),
        namespace: 'test',
        type: 'job',
        payload: {},
      });

      const found = await scheduler.get(ScheduledTask.ref(id(task)));
      assert.ok(found);
      assert.strictEqual(id(found), id(task));
    });
  });

  describe('cancel', () => {
    it('cancels a pending task', async () => {
      const task = await scheduler.schedule({
        dueAt: new Date(Date.now() + 60000),
        namespace: 'test',
        type: 'job',
        payload: {},
      });

      const cancelled = await scheduler.cancel(id(task));
      assert.strictEqual(cancelled, true);

      const found = await scheduler.get(ScheduledTask.ref(id(task)));
      assert.ok(found);
      assert.strictEqual(found.status, ScheduledTaskStatus.Cancelled);
    });

    it('returns false for non-existent task', async () => {
      const cancelled = await scheduler.cancel('non-existent-id');
      assert.strictEqual(cancelled, false);
    });

    it('returns false for already processing task', async () => {
      const task = await scheduler.schedule({
        dueAt: new Date(Date.now() - 1000), // due immediately
        namespace: 'test',
        type: 'job',
        payload: {},
      });

      // Manually update to processing to simulate picked up
      const locked = await scheduler.lock(task);
      await scheduler.update(locked!, { status: ScheduledTaskStatus.Processing });

      const cancelled = await scheduler.cancel(id(task));
      assert.strictEqual(cancelled, false);
    });
  });

  describe('subscribe', () => {
    it('yields tasks when they become due', async () => {
      // Schedule a task that's already due
      const task = await scheduler.schedule({
        dueAt: new Date(Date.now() - 1000),
        namespace: 'test',
        type: 'job',
        payload: { message: 'hello' },
      });

      // Subscribe and get the first task
      const controller = new AbortController();
      const iterator = scheduler.subscribe('test.job', {
        signal: controller.signal,
        pollInterval: 10,
      });

      const result = await iterator[Symbol.asyncIterator]().next();
      controller.abort();

      assert.strictEqual(result.done, false);
      assert.strictEqual(id(result.value), id(task));
      assert.deepStrictEqual(result.value.payload, { message: 'hello' });
      assert.strictEqual(result.value.status, ScheduledTaskStatus.Processing);
    });

    it('marks task as completed after yielding', async () => {
      const task = await scheduler.schedule({
        dueAt: new Date(Date.now() - 1000),
        namespace: 'test',
        type: 'job',
        payload: {},
      });

      const controller = new AbortController();
      const iterator = scheduler.subscribe('test.job', {
        signal: controller.signal,
        pollInterval: 10,
      });

      const asyncIterator = iterator[Symbol.asyncIterator]();

      // Consume one task
      const result = await asyncIterator.next();
      assert.strictEqual(result.done, false);

      // Resume the generator (this triggers completion logic)
      // Then abort so it returns
      controller.abort();
      await asyncIterator.next();

      const found = await scheduler.get(ScheduledTask.ref(id(task)));
      assert.ok(found);
      assert.strictEqual(found.status, ScheduledTaskStatus.Completed);
    });

    it('only yields tasks for the subscribed namespace.type', async () => {
      await scheduler.schedule({
        dueAt: new Date(Date.now() - 1000),
        namespace: 'other',
        type: 'job',
        payload: {},
      });

      const task = await scheduler.schedule({
        dueAt: new Date(Date.now() - 1000),
        namespace: 'test',
        type: 'job',
        payload: { correct: true },
      });

      const controller = new AbortController();
      const iterator = scheduler.subscribe('test.job', {
        signal: controller.signal,
        pollInterval: 10,
      });

      const result = await iterator[Symbol.asyncIterator]().next();
      controller.abort();

      assert.strictEqual(id(result.value), id(task));
      assert.deepStrictEqual(result.value.payload, { correct: true });
    });

    it('respects abort signal', async () => {
      const controller = new AbortController();

      // Abort immediately
      controller.abort();

      const iterator = scheduler.subscribe('test.job', {
        signal: controller.signal,
      });

      const result = await iterator[Symbol.asyncIterator]().next();
      assert.strictEqual(result.done, true);
    });

    it('throws on invalid qualified name', async () => {
      await assert.rejects(
        async () => {
          const iterator = scheduler.subscribe('invalid');
          await iterator[Symbol.asyncIterator]().next();
        },
        /Invalid qualified name/
      );
    });
  });

  describe('repository methods', () => {
    it('find returns all tasks', async () => {
      await scheduler.schedule({ dueAt: new Date(), namespace: 'a', type: 'b', payload: {} });
      await scheduler.schedule({ dueAt: new Date(), namespace: 'c', type: 'd', payload: {} });

      const all = await scheduler.find();
      assert.strictEqual(all.length, 2);
    });

    it('count returns task count', async () => {
      await scheduler.schedule({ dueAt: new Date(), namespace: 'a', type: 'b', payload: {} });
      await scheduler.schedule({ dueAt: new Date(), namespace: 'c', type: 'd', payload: {} });

      const count = await scheduler.count();
      assert.strictEqual(count, 2);
    });

    it('delete removes a task', async () => {
      const task = await scheduler.schedule({
        dueAt: new Date(),
        namespace: 'test',
        type: 'job',
        payload: {},
      });

      const locked = await scheduler.lock(task);
      const deleted = await scheduler.delete(locked!);
      assert.strictEqual(deleted, true);

      const found = await scheduler.get(ScheduledTask.ref(id(task)));
      assert.strictEqual(found, undefined);
    });
  });
});
