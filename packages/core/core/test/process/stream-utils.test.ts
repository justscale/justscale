/**
 * Tests for Stream-Process Utilities
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  modelNameToIdentityKey,
  pascalToCamelCase,
  parseStreamSignal,
  buildStreamSignal,
  isWildcardStreamSignal,
  resolveEntityId,
  resolveStreamWildcard,
} from '../../src/process/stream-utils.js';

describe('Stream Utils', () => {
  describe('pascalToCamelCase', () => {
    describe('standard cases', () => {
      it('converts Order to order', () => {
        assert.strictEqual(pascalToCamelCase('Order'), 'order');
      });

      it('converts User to user', () => {
        assert.strictEqual(pascalToCamelCase('User'), 'user');
      });

      it('converts OrderItem to orderItem', () => {
        assert.strictEqual(pascalToCamelCase('OrderItem'), 'orderItem');
      });

      it('converts UserProfile to userProfile', () => {
        assert.strictEqual(pascalToCamelCase('UserProfile'), 'userProfile');
      });
    });

    describe('acronyms', () => {
      it('converts ABC to abc (all caps)', () => {
        assert.strictEqual(pascalToCamelCase('ABC'), 'abc');
      });

      it('converts HTTP to http', () => {
        assert.strictEqual(pascalToCamelCase('HTTP'), 'http');
      });

      it('converts HTTPServer to httpServer', () => {
        assert.strictEqual(pascalToCamelCase('HTTPServer'), 'httpServer');
      });

      it('converts ABCOrder to abcOrder', () => {
        assert.strictEqual(pascalToCamelCase('ABCOrder'), 'abcOrder');
      });

      it('converts XMLParser to xmlParser', () => {
        assert.strictEqual(pascalToCamelCase('XMLParser'), 'xmlParser');
      });

      it('converts IOStream to ioStream', () => {
        assert.strictEqual(pascalToCamelCase('IOStream'), 'ioStream');
      });
    });

    describe('numbers', () => {
      it('converts V2Order to v2Order', () => {
        assert.strictEqual(pascalToCamelCase('V2Order'), 'v2Order');
      });

      it('converts Order2 to order2', () => {
        assert.strictEqual(pascalToCamelCase('Order2'), 'order2');
      });

      it('converts HTTP2Server to http2Server', () => {
        assert.strictEqual(pascalToCamelCase('HTTP2Server'), 'http2Server');
      });
    });

    describe('single characters', () => {
      it('converts A to a', () => {
        assert.strictEqual(pascalToCamelCase('A'), 'a');
      });

      it('converts X to x', () => {
        assert.strictEqual(pascalToCamelCase('X'), 'x');
      });
    });

    describe('edge cases', () => {
      it('handles empty string', () => {
        assert.strictEqual(pascalToCamelCase(''), '');
      });

      it('handles already camelCase', () => {
        assert.strictEqual(pascalToCamelCase('order'), 'order');
      });

      it('handles mixed case in middle', () => {
        assert.strictEqual(pascalToCamelCase('OrderItemV2'), 'orderItemV2');
      });
    });
  });

  describe('modelNameToIdentityKey', () => {
    describe('standard models', () => {
      it('Order -> orderRef', () => {
        assert.strictEqual(modelNameToIdentityKey('Order'), 'orderRef');
      });

      it('User -> userRef', () => {
        assert.strictEqual(modelNameToIdentityKey('User'), 'userRef');
      });

      it('OrderItem -> orderItemRef', () => {
        assert.strictEqual(modelNameToIdentityKey('OrderItem'), 'orderItemRef');
      });
    });

    describe('acronym models', () => {
      it('ABC -> abcRef', () => {
        assert.strictEqual(modelNameToIdentityKey('ABC'), 'abcRef');
      });

      it('HTTPServer -> httpServerRef', () => {
        assert.strictEqual(modelNameToIdentityKey('HTTPServer'), 'httpServerRef');
      });

      it('XMLParser -> xmlParserRef', () => {
        assert.strictEqual(modelNameToIdentityKey('XMLParser'), 'xmlParserRef');
      });
    });

    describe('models with numbers', () => {
      it('V2Order -> v2OrderRef', () => {
        assert.strictEqual(modelNameToIdentityKey('V2Order'), 'v2OrderRef');
      });
    });

    describe('edge cases', () => {
      it('empty string -> ref', () => {
        assert.strictEqual(modelNameToIdentityKey(''), 'ref');
      });

      it('single letter A -> aRef', () => {
        assert.strictEqual(modelNameToIdentityKey('A'), 'aRef');
      });
    });
  });

  describe('parseStreamSignal', () => {
    it('parses valid stream signal', () => {
      const result = parseStreamSignal('stream:Order:order-123:statusUpdates');
      assert.deepStrictEqual(result, {
        prefix: 'stream',
        modelName: 'Order',
        entityId: 'order-123',
        fieldName: 'statusUpdates',
      });
    });

    it('parses wildcard stream signal', () => {
      const result = parseStreamSignal('stream:Order:*:statusUpdates');
      assert.deepStrictEqual(result, {
        prefix: 'stream',
        modelName: 'Order',
        entityId: '*',
        fieldName: 'statusUpdates',
      });
    });

    it('returns null for non-stream signal', () => {
      assert.strictEqual(parseStreamSignal('orders.completed'), null);
    });

    it('returns null for wrong number of parts', () => {
      assert.strictEqual(parseStreamSignal('stream:Order:statusUpdates'), null);
    });

    it('returns null for wrong prefix', () => {
      assert.strictEqual(parseStreamSignal('signal:Order:123:statusUpdates'), null);
    });
  });

  describe('buildStreamSignal', () => {
    it('builds signal with entity ID', () => {
      assert.strictEqual(
        buildStreamSignal('Order', 'order-123', 'statusUpdates'),
        'stream:Order:order-123:statusUpdates'
      );
    });

    it('builds signal with wildcard', () => {
      assert.strictEqual(
        buildStreamSignal('Order', '*', 'statusUpdates'),
        'stream:Order:*:statusUpdates'
      );
    });
  });

  describe('isWildcardStreamSignal', () => {
    it('returns true for wildcard signal', () => {
      assert.strictEqual(
        isWildcardStreamSignal('stream:Order:*:statusUpdates'),
        true
      );
    });

    it('returns false for resolved signal', () => {
      assert.strictEqual(
        isWildcardStreamSignal('stream:Order:order-123:statusUpdates'),
        false
      );
    });

    it('returns false for non-stream signal', () => {
      assert.strictEqual(
        isWildcardStreamSignal('orders.completed'),
        false
      );
    });
  });

  describe('resolveEntityId', () => {
    describe('conventional key resolution', () => {
      it('resolves Order with orderRef', () => {
        const result = resolveEntityId('Order', { orderRef: 'order-123' });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.entityId, 'order-123');
        assert.strictEqual(result.usedKey, 'orderRef');
        assert.strictEqual(result.usedFallback, false);
      });

      it('resolves HTTPServer with httpServerRef', () => {
        const result = resolveEntityId('HTTPServer', { httpServerRef: 'srv-456' });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.entityId, 'srv-456');
        assert.strictEqual(result.usedKey, 'httpServerRef');
      });

      it('resolves ABC with abcRef', () => {
        const result = resolveEntityId('ABC', { abcRef: 'abc-789' });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.entityId, 'abc-789');
        assert.strictEqual(result.usedKey, 'abcRef');
      });
    });

    describe('fallback resolution', () => {
      it('falls back to any *Ref key', () => {
        const result = resolveEntityId('Order', { customerRef: 'cust-123' });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.entityId, 'cust-123');
        assert.strictEqual(result.usedKey, 'customerRef');
        assert.strictEqual(result.usedFallback, true);
      });

      it('falls back to any *Id key', () => {
        const result = resolveEntityId('Order', { customerId: 'cust-123' });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.entityId, 'cust-123');
        assert.strictEqual(result.usedKey, 'customerId');
        assert.strictEqual(result.usedFallback, true);
      });

      it('falls back to ref key', () => {
        const result = resolveEntityId('Order', { ref: 'generic-ref' });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.entityId, 'generic-ref');
        assert.strictEqual(result.usedKey, 'ref');
        assert.strictEqual(result.usedFallback, true);
      });

      it('falls back to id key', () => {
        const result = resolveEntityId('Order', { id: 'generic-id' });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.entityId, 'generic-id');
        assert.strictEqual(result.usedKey, 'id');
        assert.strictEqual(result.usedFallback, true);
      });

      it('prefers *Ref over id', () => {
        const result = resolveEntityId('Order', {
          id: 'generic-id',
          entityRef: 'entity-ref'
        });
        assert.strictEqual(result.entityId, 'entity-ref');
        assert.strictEqual(result.usedKey, 'entityRef');
      });
    });

    describe('fallback disabled', () => {
      it('fails when conventional key not found and fallback disabled', () => {
        const result = resolveEntityId(
          'Order',
          { customerId: 'cust-123' },
          { useFallback: false }
        );
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('orderRef'));
      });
    });

    describe('custom identity key', () => {
      it('uses custom key when provided', () => {
        const result = resolveEntityId(
          'Order',
          { myCustomKey: 'custom-value' },
          { customIdentityKey: 'myCustomKey' }
        );
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.entityId, 'custom-value');
        assert.strictEqual(result.usedKey, 'myCustomKey');
      });
    });

    describe('failure cases', () => {
      it('fails with empty identity', () => {
        const result = resolveEntityId('Order', {});
        assert.strictEqual(result.success, false);
        assert.ok(result.error);
      });

      it('fails when no matching keys', () => {
        const result = resolveEntityId('Order', { name: 'test', value: '123' });
        assert.strictEqual(result.success, false);
        assert.ok(result.error?.includes('orderRef'));
      });
    });
  });

  describe('resolveStreamWildcard', () => {
    describe('wildcard resolution', () => {
      it('resolves wildcard with matching identity', () => {
        const { resolved, result } = resolveStreamWildcard(
          'stream:Order:*:statusUpdates',
          { orderRef: 'order-123' }
        );
        assert.strictEqual(resolved, 'stream:Order:order-123:statusUpdates');
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.usedFallback, false);
      });

      it('resolves with acronym model name', () => {
        const { resolved, result } = resolveStreamWildcard(
          'stream:HTTPServer:*:logs',
          { httpServerRef: 'srv-456' }
        );
        assert.strictEqual(resolved, 'stream:HTTPServer:srv-456:logs');
        assert.strictEqual(result.success, true);
      });

      it('uses fallback when conventional key missing', () => {
        const { resolved, result } = resolveStreamWildcard(
          'stream:Order:*:events',
          { entityId: 'fallback-id' }
        );
        assert.strictEqual(resolved, 'stream:Order:fallback-id:events');
        assert.strictEqual(result.usedFallback, true);
      });
    });

    describe('non-wildcard signals', () => {
      it('returns already-resolved signal unchanged', () => {
        const { resolved } = resolveStreamWildcard(
          'stream:Order:order-123:statusUpdates',
          { orderRef: 'different-id' }
        );
        assert.strictEqual(resolved, 'stream:Order:order-123:statusUpdates');
      });

      it('returns non-stream signal unchanged', () => {
        const { resolved } = resolveStreamWildcard(
          'orders.completed',
          { orderRef: 'order-123' }
        );
        assert.strictEqual(resolved, 'orders.completed');
      });
    });

    describe('resolution failure', () => {
      it('returns original signal when resolution fails', () => {
        const { resolved, result } = resolveStreamWildcard(
          'stream:Order:*:events',
          { name: 'test' } // No *Ref or *Id keys
        );
        assert.strictEqual(resolved, 'stream:Order:*:events');
        assert.strictEqual(result.success, false);
        assert.ok(result.error);
      });
    });
  });
});
