/**
 * extractKey identity invariant.
 *
 * The pg adapter's identity-map keys come from extractKey(). Three
 * shapes feed it:
 *   - string ID (raw)
 *   - Reference<T> (lazy handle)
 *   - Persistent<T> / Locked<T> (loaded entity, has ADAPTER_KEY symbol)
 *
 * If these paths produce DIFFERENT keys for the same logical entity,
 * the identity map silently fragments — `find` then `lock` then
 * `update` could each operate on different cache entries, defeating
 * the whole point of identity caching.
 *
 * These tests pin: all three paths produce the same key.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Reference } from '@justscale/core/models';
import { ADAPTER_KEY } from '@justscale/core/models';
import { extractKey, keyOf } from '../src/repository/pg-repository.js';

const ID = 'order-abc-123';

describe('extractKey identity invariant', () => {
  it('returns the same key for a raw string ID', () => {
    assert.strictEqual(extractKey(ID), ID);
  });

  it('returns the same key for a Reference<T>', () => {
    const ref = new Reference(ID);
    assert.strictEqual(extractKey(ref), ID);
  });

  it('returns the same key for a Persistent<T> (entity with ADAPTER_KEY symbol)', () => {
    // Simulate what the loader produces: a plain object with the ID
    // attached as a non-enumerable symbol.
    const persistent = { name: 'Order #1', total: 99.99 };
    Object.defineProperty(persistent, ADAPTER_KEY, {
      value: ID,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    assert.strictEqual(extractKey(persistent), ID);
  });

  it('returns the same key for a Locked<T> (same shape as Persistent)', () => {
    // Locked is structurally Persistent + a type-only brand. The runtime
    // representation is identical — same ADAPTER_KEY symbol.
    const locked = { name: 'Order #1', __locked__: true };
    Object.defineProperty(locked, ADAPTER_KEY, {
      value: ID,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    assert.strictEqual(extractKey(locked), ID);
  });

  it('all four shapes produce IDENTICAL keys for the same entity', () => {
    const ref = new Reference(ID);
    const persistent: Record<string | symbol, unknown> = { name: 'X' };
    Object.defineProperty(persistent, ADAPTER_KEY, { value: ID, enumerable: false });
    const locked: Record<string | symbol, unknown> = { name: 'X', __locked__: true };
    Object.defineProperty(locked, ADAPTER_KEY, { value: ID, enumerable: false });

    const k1 = extractKey(ID);
    const k2 = extractKey(ref);
    const k3 = extractKey(persistent);
    const k4 = extractKey(locked);

    assert.strictEqual(k1, k2);
    assert.strictEqual(k2, k3);
    assert.strictEqual(k3, k4);
  });

  it('throws on entity with no key (not an error to silently produce undefined)', () => {
    // Without ADAPTER_KEY, extractKey would return undefined and the
    // identity map would store it under "undefined" — a bug magnet.
    // Make sure the failure is loud.
    assert.throws(
      () => extractKey({ name: 'no-key' }),
      /not a persistent PG entity/,
    );
  });

  it('keyOf agrees with extractKey for Persistent entities', () => {
    // keyOf is the infrastructure-only sibling. They must agree on
    // entities that have ADAPTER_KEY (the only shape keyOf accepts).
    const entity: Record<string | symbol, unknown> = { name: 'X' };
    Object.defineProperty(entity, ADAPTER_KEY, { value: ID, enumerable: false });
    assert.strictEqual(keyOf(entity), extractKey(entity));
  });
});
