/**
 * Integration test: Processable protocol through the full process executor.
 *
 * Verifies that Processable types survive the complete lifecycle:
 * signal emit → encode → signal bus → match → decode → state.vars → serialize → deserialize
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  ProcessExecutor,
} from '../../src/runtime/process/executor.js';
import { createInMemoryProcessStorage, type InMemoryProcessStorageInstance } from '../../src/runtime/process/storage.js';
import { InMemorySignalBus } from '../../src/runtime/process/signal-bus.js';
import { InMemoryTimerScheduler } from '../../src/runtime/process/timer-scheduler.js';
import type { CompiledSwitchProcess, ExecutionContext, ExecutionResult } from '../../src/process/types.js';
import { DONE, SUSPEND } from '../../src/process/types.js';
import type { ServiceToken, Resolver } from '../../src/core/index.js';
import { registerProcessType } from '../../src/process/serialization.js';
import { serializeState, deserializeState } from '../../src/runtime/process/state-serializer.js';

// Trigger builtins
import '../../src/process/builtin-serializers.js';

// ============================================================================
// Test Processable types
// ============================================================================

class OrderPayload {
  constructor(public orderId: string, public amount: number, public currency: string) {}

  static [Symbol.process]: ProcessDescriptor<OrderPayload> = {
    name: 'test.integration.OrderPayload',
    serialize: (v: OrderPayload) => ({
      o: v.orderId,
      a: v.amount,
      c: v.currency,
    }),
    deserialize: (d: Uint8Array | object) => {
      const data = d as { o: string; a: number; c: string };
      return new OrderPayload(data.o, data.a, data.c);
    },
  };
}
registerProcessType(OrderPayload[Symbol.process]);

// ============================================================================
// Helpers
// ============================================================================

const createMockResolver = (services: Record<string, unknown> = {}): Resolver =>
  (async (token: unknown) => services[String(token)]) as Resolver;

const createSwitchProcess = (
  overrides: Partial<CompiledSwitchProcess<Record<string, ServiceToken>>> & {
    execute: (ctx: ExecutionContext) => Promise<ExecutionResult>
  }
): CompiledSwitchProcess<Record<string, ServiceToken>> => ({
  id: 'test-processable',
  path: '/test/:testId',
  version: '1.0.0',
  inject: {},
  stepMap: { entry: 0 },
  sourceMap: {},
  signals: {},
  ...overrides,
});

// ============================================================================
// Tests
// ============================================================================

describe('Processable through process executor', () => {
  let executor: ProcessExecutor;
  let storage: InMemoryProcessStorageInstance;
  let signalBus: InMemorySignalBus;
  let timerScheduler: InMemoryTimerScheduler;

  beforeEach(() => {
    storage = createInMemoryProcessStorage();
    signalBus = new InMemorySignalBus();
    timerScheduler = new InMemoryTimerScheduler();

    executor = new ProcessExecutor({
      resolve: createMockResolver(),
      storage,
      signalBus,
      timerScheduler,
    });
  });

  it('encodes Processable signal payloads and decodes on resume', async () => {
    let receivedPayload: unknown = null;

    const process = createSwitchProcess({
      execute: async (ctx) => {
        if (ctx.state.step === 0) {
          ctx.state.step = 1;
          return [SUSPEND, { signal: 'order.completed' }];
        }
        receivedPayload = ctx.state.vars.__signalPayload;
        return [DONE, { payload: receivedPayload }];
      },
    });

    const handle = await executor.start(process, ['test-1']);

    // Verify suspended
    const state = await storage.load('test/test-1');
    assert.ok(state);
    assert.equal(state!.status, 'suspended');

    // Emit with Processable payload
    const orderPayload = new OrderPayload('ord-42', 99.99, 'EUR');
    await executor.emit('order.completed', { testId: 'test-1' }, orderPayload);

    const result = await handle.wait();
    assert.ok(result);
    assert.ok(receivedPayload != null);
  });

  it('non-Processable payloads pass through unchanged', async () => {
    let receivedPayload: unknown = null;

    const process = createSwitchProcess({
      execute: async (ctx) => {
        if (ctx.state.step === 0) {
          ctx.state.step = 1;
          return [SUSPEND, { signal: 'plain.event' }];
        }
        receivedPayload = ctx.state.vars.__signalPayload;
        return [DONE, receivedPayload];
      },
    });

    const handle = await executor.start(process, ['plain-1']);
    await executor.emit('plain.event', { testId: 'plain-1' }, { status: 'ok', count: 42 });
    await handle.wait();

    assert.deepEqual(receivedPayload, { status: 'ok', count: 42 });
  });

  it('Processable payloads work in race signal branches', async () => {
    let receivedPayload: unknown = null;

    const process = createSwitchProcess({
      stepMap: { entry: 0, signal_branch: 1, timer_branch: 2 },
      execute: async (ctx) => {
        if (ctx.state.step === 0) {
          ctx.state.step = 1;
          return [SUSPEND, {
            race: [
              {
                id: 'order-signal',
                signal: 'order.completed',
                resumeStep: 1,
              },
              {
                id: 'timeout',
                timer: { seconds: 60 },
                resumeStep: 2,
              },
            ],
          }];
        }
        if (ctx.state.step === 1) {
          receivedPayload = ctx.state.vars.__raceResult;
          return [DONE, { branch: 'signal', payload: receivedPayload }];
        }
        return [DONE, { branch: 'timeout' }];
      },
    });

    const handle = await executor.start(process, ['race-1']);

    // Emit with Processable payload — should hit the signal branch
    const payload = new OrderPayload('ord-race', 500, 'GBP');
    await executor.emit('order.completed', { testId: 'race-1' }, payload);

    const result = await handle.wait();
    assert.ok(result);
    assert.equal((result as any).branch, 'signal');
    assert.ok(receivedPayload != null);
  });

  describe('state serialization round-trips', () => {
    it('Processable payload survives JSONB round-trip', () => {
      const vars: Record<string, unknown> = {
        __signalPayload: new OrderPayload('ord-99', 250, 'USD'),
        orderId: 'ord-99',
        step: 1,
      };

      const serialized = serializeState(vars);
      assert.ok(serialized.__$processTypes);
      assert.equal(
        (serialized.__$processTypes as Record<string, string>).__signalPayload,
        'test.integration.OrderPayload',
      );

      const jsonRoundTrip = JSON.parse(JSON.stringify(serialized));
      const restored = deserializeState(jsonRoundTrip);

      assert.ok(restored.__signalPayload instanceof OrderPayload);
      const order = restored.__signalPayload as OrderPayload;
      assert.equal(order.orderId, 'ord-99');
      assert.equal(order.amount, 250);
      assert.equal(order.currency, 'USD');
      assert.equal(restored.orderId, 'ord-99');
    });

    it('Date builtin survives state serialization', () => {
      const vars: Record<string, unknown> = {
        created: new Date('2025-06-15T12:00:00Z'),
        name: 'test',
      };

      const serialized = serializeState(vars);
      const jsonRoundTrip = JSON.parse(JSON.stringify(serialized));
      const restored = deserializeState(jsonRoundTrip);

      assert.ok(restored.created instanceof Date);
      assert.equal((restored.created as Date).toISOString(), '2025-06-15T12:00:00.000Z');
    });

    it('mixed Processable and builtin types in state', () => {
      const vars: Record<string, unknown> = {
        order: new OrderPayload('mix-1', 100, 'CHF'),
        created: new Date('2025-01-01'),
        tags: new Set(['urgent', 'vip']),
        meta: new Map([['priority', 'high']]),
        plain: 'hello',
      };

      const serialized = serializeState(vars);
      const jsonRoundTrip = JSON.parse(JSON.stringify(serialized));
      const restored = deserializeState(jsonRoundTrip);

      assert.ok(restored.order instanceof OrderPayload);
      assert.equal((restored.order as OrderPayload).currency, 'CHF');
      assert.ok(restored.created instanceof Date);
      assert.ok(restored.tags instanceof Set);
      assert.ok((restored.tags as Set<string>).has('urgent'));
      assert.ok(restored.meta instanceof Map);
      assert.equal((restored.meta as Map<string, string>).get('priority'), 'high');
      assert.equal(restored.plain, 'hello');
    });
  });
});
