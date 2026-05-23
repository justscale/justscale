import { describe, it } from 'node:test';
import assert from 'node:assert';
import { __validateHmrState, __wrapHmrStateForSave } from '../src/core/hmr.js';

describe('__validateHmrState', () => {
  describe('legacy string[] format', () => {
    it('should accept matching keys', () => {
      const state = { cache: new Map(), counter: 0 };
      const result = __validateHmrState(state, ['cache', 'counter'], 'test#Svc');
      assert.strictEqual(result, state);
    });

    it('should reject missing keys', () => {
      const state = { cache: new Map() };
      const result = __validateHmrState(state, ['cache', 'counter'], 'test#Svc');
      assert.strictEqual(result, undefined);
    });

    it('should reject extra keys', () => {
      const state = { cache: new Map(), counter: 0, extra: true };
      const result = __validateHmrState(state, ['cache', 'counter'], 'test#Svc');
      assert.strictEqual(result, undefined);
    });
  });

  describe('type-aware Record<string, string> format', () => {
    it('should preserve all values when type hashes match', () => {
      // First register the schema by calling validate (even with null state)
      __validateHmrState(null, { cache: 'abc123', counter: 'def456' }, 'test#TypeSvc');

      // Now save state using __wrapHmrStateForSave
      const rawState = { cache: new Map([['a', 1]]), counter: 42 };
      const wrapped = __wrapHmrStateForSave('test#TypeSvc', rawState) as any;

      assert.ok(wrapped.__values, 'Should have __values');
      assert.ok(wrapped.__typeHashes, 'Should have __typeHashes');
      assert.strictEqual(wrapped.__typeHashes.cache, 'abc123');
      assert.strictEqual(wrapped.__typeHashes.counter, 'def456');

      // Validate with same hashes — should preserve all
      const result = __validateHmrState(wrapped, { cache: 'abc123', counter: 'def456' }, 'test#TypeSvc') as any;
      assert.ok(result, 'Should return validated state');
      assert.strictEqual(result.cache, rawState.cache, 'Should preserve cache');
      assert.strictEqual(result.counter, 42, 'Should preserve counter');
    });

    it('should discard variable with changed type hash but preserve others', () => {
      // Register schema
      __validateHmrState(null, { cache: 'abc123', counter: 'def456' }, 'test#Mixed');

      const rawState = { cache: new Map(), counter: 42 };
      const wrapped = __wrapHmrStateForSave('test#Mixed', rawState) as any;

      // Validate with changed hash for cache, same for counter
      const result = __validateHmrState(wrapped, { cache: 'CHANGED', counter: 'def456' }, 'test#Mixed') as any;
      assert.ok(result, 'Should return partial state');
      assert.strictEqual(result.cache, undefined, 'Should discard cache (type changed)');
      assert.strictEqual(result.counter, 42, 'Should preserve counter (type unchanged)');
    });

    it('should return undefined when all types changed', () => {
      __validateHmrState(null, { cache: 'abc', counter: 'def' }, 'test#AllChanged');

      const rawState = { cache: new Map(), counter: 42 };
      const wrapped = __wrapHmrStateForSave('test#AllChanged', rawState);

      const result = __validateHmrState(wrapped, { cache: 'XXX', counter: 'YYY' }, 'test#AllChanged');
      assert.strictEqual(result, undefined, 'Should return undefined when all types changed');
    });

    it('should accept values with empty hash (no type checker)', () => {
      __validateHmrState(null, { cache: '', counter: '' }, 'test#NoChecker');

      const rawState = { cache: new Map(), counter: 42 };
      const wrapped = __wrapHmrStateForSave('test#NoChecker', rawState);

      const result = __validateHmrState(wrapped, { cache: 'anything', counter: 'anything' }, 'test#NoChecker') as any;
      assert.ok(result, 'Should accept all when stored hashes are empty');
      assert.strictEqual(result.counter, 42);
    });

    it('should handle legacy state format (no __values wrapper) with new schema', () => {
      const legacyState = { cache: new Map(), counter: 0 };
      const result = __validateHmrState(legacyState, { cache: 'abc', counter: 'def' }, 'test#Legacy');
      // Legacy state has matching keys, should be accepted
      assert.strictEqual(result, legacyState);
    });

    it('should reject legacy state with mismatched keys', () => {
      const legacyState = { cache: new Map() };
      const result = __validateHmrState(legacyState, { cache: 'abc', counter: 'def' }, 'test#LegacyMismatch');
      assert.strictEqual(result, undefined);
    });
  });

  describe('edge cases', () => {
    it('should return undefined for null state', () => {
      assert.strictEqual(__validateHmrState(null, { x: 'a' }, 'test'), undefined);
    });

    it('should return undefined for non-object state', () => {
      assert.strictEqual(__validateHmrState(42, { x: 'a' }, 'test'), undefined);
    });
  });
});
