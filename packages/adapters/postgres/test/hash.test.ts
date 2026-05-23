/**
 * Tests for hash utility
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  hashStringToBigInt,
  createLockKey,
  hashLockKey,
} from '../src/utils/hash.js';

describe('hashStringToBigInt', () => {
  it('should return a bigint', () => {
    const result = hashStringToBigInt('test');
    assert.strictEqual(typeof result, 'bigint');
  });

  it('should return consistent hash for same input', () => {
    const hash1 = hashStringToBigInt('User:123');
    const hash2 = hashStringToBigInt('User:123');
    assert.strictEqual(hash1, hash2);
  });

  it('should return different hashes for different inputs', () => {
    const hash1 = hashStringToBigInt('User:123');
    const hash2 = hashStringToBigInt('User:456');
    assert.notStrictEqual(hash1, hash2);
  });

  it('should handle empty string', () => {
    const hash = hashStringToBigInt('');
    assert.strictEqual(typeof hash, 'bigint');
  });

  it('should handle long strings', () => {
    const longString = 'x'.repeat(10000);
    const hash = hashStringToBigInt(longString);
    assert.strictEqual(typeof hash, 'bigint');
  });

  it('should return values in PostgreSQL int8 range', () => {
    // PostgreSQL int8 range: -9223372036854775808 to 9223372036854775807
    const minInt8 = -9223372036854775808n;
    const maxInt8 = 9223372036854775807n;

    // Test several strings
    const testStrings = [
      'User:1',
      'Order:12345',
      'Product:abc-def-ghi',
      'a very long lock key with lots of characters',
      '',
      '💀🎉🚀', // Unicode
    ];

    for (const str of testStrings) {
      const hash = hashStringToBigInt(str);
      assert.ok(
        hash >= minInt8 && hash <= maxInt8,
        `Hash ${hash} for "${str}" should be within int8 range`,
      );
    }
  });

  it('should provide good distribution', () => {
    // Generate hashes for 1000 sequential keys
    const hashes = new Set<bigint>();
    for (let i = 0; i < 1000; i++) {
      hashes.add(hashStringToBigInt(`key:${i}`));
    }
    // Should have no collisions for sequential keys
    assert.strictEqual(hashes.size, 1000, 'Should have no collisions for 1000 sequential keys');
  });
});

describe('createLockKey', () => {
  it('should combine model name and string id', () => {
    const key = createLockKey('User', '123');
    assert.strictEqual(key, 'User:123');
  });

  it('should combine model name and number id', () => {
    const key = createLockKey('Order', 456);
    assert.strictEqual(key, 'Order:456');
  });

  it('should handle special characters in model name', () => {
    const key = createLockKey('My_Model', 'abc');
    assert.strictEqual(key, 'My_Model:abc');
  });
});

describe('hashLockKey', () => {
  it('should return same hash as hashStringToBigInt(createLockKey(...))', () => {
    const hash1 = hashLockKey('User', '123');
    const hash2 = hashStringToBigInt(createLockKey('User', '123'));
    assert.strictEqual(hash1, hash2);
  });

  it('should return bigint', () => {
    const hash = hashLockKey('Order', 456);
    assert.strictEqual(typeof hash, 'bigint');
  });
});
