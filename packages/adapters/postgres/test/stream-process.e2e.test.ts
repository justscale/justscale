/**
 * Stream-Process Integration E2E Tests
 *
 * Tests the full integration of stream() primitive with processes:
 * - Signal bus matching for stream signals
 * - Cross-entity isolation
 * - Error scenarios and edge cases
 * - "Mistake" tests - verifying correct behavior when things go wrong
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { InMemorySignalBus } from '@justscale/core/process';

// =============================================================================
// Test Suite
// =============================================================================

describe('Stream-Process Integration E2E', async () => {
  // ===========================================================================
  // In-Memory Signal Bus Stream Tests
  // ===========================================================================

  describe('In-Memory Signal Bus Stream Tests', () => {
    it('should match stream signal by exact name', async () => {
      const signalBus = new InMemorySignalBus();
      let matchedPayload: unknown = null;

      await signalBus.subscribe(
        'order/order-123/monitor',
        'stream:Order:order-123:statusUpdates',
        { orderId: 'order-123' }
      );

      signalBus.onMatch((match) => {
        matchedPayload = match.payload;
      });

      await signalBus.emit(
        'stream:Order:order-123:statusUpdates',
        { orderId: 'order-123' },
        { status: 'shipped', timestamp: new Date().toISOString() }
      );

      assert.deepStrictEqual((matchedPayload as any)?.status, 'shipped');
    });

    it('MISTAKE: emitting to wrong entity ID should NOT wake process', async () => {
      const signalBus = new InMemorySignalBus();
      let wasMatched = false;

      await signalBus.subscribe(
        'order/order-123/monitor',
        'stream:Order:order-123:statusUpdates',
        { orderId: 'order-123' }
      );

      signalBus.onMatch(() => {
        wasMatched = true;
      });

      // MISTAKE: Using wrong entity ID
      await signalBus.emit(
        'stream:Order:order-WRONG:statusUpdates',
        { orderId: 'order-WRONG' },
        { status: 'shipped' }
      );

      assert.strictEqual(wasMatched, false, 'Should NOT match with wrong entity ID');
    });

    it('MISTAKE: emitting to wrong field name should NOT wake process', async () => {
      const signalBus = new InMemorySignalBus();
      let wasMatched = false;

      await signalBus.subscribe(
        'order/order-123/monitor',
        'stream:Order:order-123:statusUpdates',
        { orderId: 'order-123' }
      );

      signalBus.onMatch(() => {
        wasMatched = true;
      });

      // MISTAKE: Using wrong field name
      await signalBus.emit(
        'stream:Order:order-123:wrongFieldName',
        { orderId: 'order-123' },
        { status: 'shipped' }
      );

      assert.strictEqual(wasMatched, false, 'Should NOT match with wrong field name');
    });

    it('MISTAKE: emitting to wrong model name should NOT wake process', async () => {
      const signalBus = new InMemorySignalBus();
      let wasMatched = false;

      await signalBus.subscribe(
        'order/order-123/monitor',
        'stream:Order:order-123:statusUpdates',
        { orderId: 'order-123' }
      );

      signalBus.onMatch(() => {
        wasMatched = true;
      });

      // MISTAKE: Using wrong model name
      await signalBus.emit(
        'stream:WrongModel:order-123:statusUpdates',
        { orderId: 'order-123' },
        { status: 'shipped' }
      );

      assert.strictEqual(wasMatched, false, 'Should NOT match with wrong model name');
    });

    it('should handle race between stream and signal', async () => {
      const signalBus = new InMemorySignalBus();
      let winningBranch: string | undefined;

      await signalBus.subscribeRace('order/order-123/monitor', [
        {
          branchId: 'stream-update',
          signal: 'stream:Order:order-123:statusUpdates',
          identity: { orderId: 'order-123' },
        },
        {
          branchId: 'cancelled-signal',
          signal: 'orders.cancelled',
          identity: { orderId: 'order-123' },
        },
      ]);

      signalBus.onMatch((match) => {
        winningBranch = match.branchId;
      });

      // Stream wins
      await signalBus.emit(
        'stream:Order:order-123:statusUpdates',
        { orderId: 'order-123' },
        { status: 'shipped' }
      );

      assert.strictEqual(winningBranch, 'stream-update');
    });

    it('should handle race between stream and delay (stream wins)', async () => {
      const signalBus = new InMemorySignalBus();
      let winningBranch: string | undefined;

      await signalBus.subscribeRace('order/order-123/monitor', [
        {
          branchId: 'stream-update',
          signal: 'stream:Order:order-123:statusUpdates',
          identity: { orderId: 'order-123' },
        },
        {
          branchId: 'timeout',
          expiresAt: new Date(Date.now() + 10000), // 10 seconds in future
        },
      ]);

      signalBus.onMatch((match) => {
        winningBranch = match.branchId;
      });

      // Stream fires before delay expires
      await signalBus.emit(
        'stream:Order:order-123:statusUpdates',
        { orderId: 'order-123' },
        { status: 'shipped' }
      );

      assert.strictEqual(winningBranch, 'stream-update');
    });

    it('should only wake first emit in race (subsequent ignored)', async () => {
      const signalBus = new InMemorySignalBus();
      const matches: unknown[] = [];

      await signalBus.subscribe(
        'order/order-123/monitor',
        'stream:Order:order-123:statusUpdates',
        { orderId: 'order-123' }
      );

      signalBus.onMatch((match) => {
        matches.push(match.payload);
      });

      // First emit - should match
      await signalBus.emit(
        'stream:Order:order-123:statusUpdates',
        { orderId: 'order-123' },
        { status: 'first' }
      );

      // Second emit - subscription already consumed
      await signalBus.emit(
        'stream:Order:order-123:statusUpdates',
        { orderId: 'order-123' },
        { status: 'second' }
      );

      assert.strictEqual(matches.length, 1);
      assert.strictEqual((matches[0] as any).status, 'first');
    });
  });

  // ===========================================================================
  // Concurrent Scenarios
  // ===========================================================================

  describe('Concurrent Scenarios', () => {
    it('should handle multiple processes on different entities', async () => {
      const signalBus = new InMemorySignalBus();
      const matches: { instanceId: string; payload: unknown }[] = [];

      // Two processes watching different orders
      await signalBus.subscribe(
        'order/order-A/monitor',
        'stream:Order:order-A:statusUpdates',
        { orderId: 'order-A' }
      );

      await signalBus.subscribe(
        'order/order-B/monitor',
        'stream:Order:order-B:statusUpdates',
        { orderId: 'order-B' }
      );

      signalBus.onMatch((match) => {
        matches.push({ instanceId: match.instanceId, payload: match.payload });
      });

      // Emit to order A
      await signalBus.emit(
        'stream:Order:order-A:statusUpdates',
        { orderId: 'order-A' },
        { status: 'shipped-A' }
      );

      // Emit to order B
      await signalBus.emit(
        'stream:Order:order-B:statusUpdates',
        { orderId: 'order-B' },
        { status: 'shipped-B' }
      );

      assert.strictEqual(matches.length, 2);

      const matchA = matches.find(m => m.instanceId === 'order/order-A/monitor');
      const matchB = matches.find(m => m.instanceId === 'order/order-B/monitor');

      assert.ok(matchA);
      assert.ok(matchB);
      assert.strictEqual((matchA?.payload as any).status, 'shipped-A');
      assert.strictEqual((matchB?.payload as any).status, 'shipped-B');
    });

    it('MISTAKE: should NOT cross-pollinate between entities', async () => {
      const signalBus = new InMemorySignalBus();
      const matchedInstances: string[] = [];

      // Process watching order A
      await signalBus.subscribe(
        'order/order-A/monitor',
        'stream:Order:order-A:statusUpdates',
        { orderId: 'order-A' }
      );

      signalBus.onMatch((match) => {
        matchedInstances.push(match.instanceId);
      });

      // MISTAKE: Emitting to order B - should NOT wake order A's process
      await signalBus.emit(
        'stream:Order:order-B:statusUpdates',
        { orderId: 'order-B' },
        { status: 'shipped' }
      );

      assert.strictEqual(matchedInstances.length, 0, 'Order A process should NOT wake for Order B event');
    });

    it('should handle concurrent emits to same subscription', async () => {
      const signalBus = new InMemorySignalBus();
      const matches: unknown[] = [];

      await signalBus.subscribe(
        'order/order-123/monitor',
        'stream:Order:order-123:statusUpdates',
        { orderId: 'order-123' }
      );

      signalBus.onMatch((match) => {
        matches.push(match.payload);
      });

      // Concurrent emits
      await Promise.all([
        signalBus.emit('stream:Order:order-123:statusUpdates', { orderId: 'order-123' }, { status: 'a' }),
        signalBus.emit('stream:Order:order-123:statusUpdates', { orderId: 'order-123' }, { status: 'b' }),
        signalBus.emit('stream:Order:order-123:statusUpdates', { orderId: 'order-123' }, { status: 'c' }),
      ]);

      // Only first should win
      assert.strictEqual(matches.length, 1);
    });
  });

  // ===========================================================================
  // Edge Cases
  // ===========================================================================

  describe('Edge Cases', () => {
    it('should handle emit before subscribe (no match)', async () => {
      const signalBus = new InMemorySignalBus();
      let wasMatched = false;

      // Emit first
      await signalBus.emit(
        'stream:Order:order-123:statusUpdates',
        { orderId: 'order-123' },
        { status: 'shipped' }
      );

      // Then subscribe
      await signalBus.subscribe(
        'order/order-123/monitor',
        'stream:Order:order-123:statusUpdates',
        { orderId: 'order-123' }
      );

      signalBus.onMatch(() => {
        wasMatched = true;
      });

      // Signal was already emitted before subscription - no match
      assert.strictEqual(wasMatched, false);
    });

    it('should handle empty payload', async () => {
      const signalBus = new InMemorySignalBus();
      let matchedPayload: unknown = 'not-set';

      await signalBus.subscribe(
        'order/order-123/monitor',
        'stream:Order:order-123:statusUpdates',
        { orderId: 'order-123' }
      );

      signalBus.onMatch((match) => {
        matchedPayload = match.payload;
      });

      await signalBus.emit(
        'stream:Order:order-123:statusUpdates',
        { orderId: 'order-123' },
        undefined
      );

      assert.strictEqual(matchedPayload, undefined);
    });

    it('should handle complex payload objects', async () => {
      const signalBus = new InMemorySignalBus();
      let matchedPayload: unknown = null;

      await signalBus.subscribe(
        'order/order-123/monitor',
        'stream:Order:order-123:statusUpdates',
        { orderId: 'order-123' }
      );

      signalBus.onMatch((match) => {
        matchedPayload = match.payload;
      });

      const complexPayload = {
        status: 'shipped',
        items: [{ id: 1, name: 'Widget' }, { id: 2, name: 'Gadget' }],
        metadata: { carrier: 'FedEx', tracking: '123456' },
        nested: { deep: { value: true } },
      };

      await signalBus.emit(
        'stream:Order:order-123:statusUpdates',
        { orderId: 'order-123' },
        complexPayload
      );

      assert.deepStrictEqual(matchedPayload, complexPayload);
    });
  });

  // ===========================================================================
  // Error Handling
  // ===========================================================================

  describe('Error Handling', () => {
    it('should handle unsubscribe gracefully', async () => {
      const signalBus = new InMemorySignalBus();
      let wasMatched = false;

      const subId = await signalBus.subscribe(
        'order/order-123/monitor',
        'stream:Order:order-123:statusUpdates',
        { orderId: 'order-123' }
      );

      signalBus.onMatch(() => {
        wasMatched = true;
      });

      // Unsubscribe before emit
      await signalBus.unsubscribe(subId);

      await signalBus.emit(
        'stream:Order:order-123:statusUpdates',
        { orderId: 'order-123' },
        { status: 'shipped' }
      );

      assert.strictEqual(wasMatched, false, 'Should not match after unsubscribe');
    });

    it('should handle double unsubscribe gracefully', async () => {
      const signalBus = new InMemorySignalBus();

      const subId = await signalBus.subscribe(
        'order/order-123/monitor',
        'stream:Order:order-123:statusUpdates',
        { orderId: 'order-123' }
      );

      // Double unsubscribe should not throw
      await signalBus.unsubscribe(subId);
      await signalBus.unsubscribe(subId); // Should not throw

      assert.ok(true, 'Double unsubscribe should not throw');
    });

    it('should handle emit to non-existent signal gracefully', async () => {
      const signalBus = new InMemorySignalBus();

      // Emit to signal with no subscribers
      const count = await signalBus.emit(
        'stream:Order:nonexistent:statusUpdates',
        { orderId: 'nonexistent' },
        { status: 'shipped' }
      );

      assert.strictEqual(count, 0, 'Should return 0 matches for non-existent signal');
    });
  });
});
