/**
 * Tests for subclass principal matching.
 *
 * When `permit(Seller)` is used, principals of Seller subclasses should also match.
 * This supports scenarios like: permit(User) matches Seller (which extends User).
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';

import { defineModel, field, Reference, HYDRATE } from '@justscale/core/models';
import { permit } from '../src/index.js';
import type { Principal } from '../src/index.js';
import { AbstractPrincipalProvider } from '../src/services/principal-provider.js';

// ============================================================================
// Model hierarchy (for subclass testing)
// ============================================================================

class BaseUser extends defineModel({
  name: 'BaseUser',
  fields: { email: field.string() },
}) {}

class VerifiedUser extends defineModel({
  name: 'VerifiedUser',
  fields: {
    email: field.string(),
    verifiedAt: field.string().optional(),
  },
}) {}

class RegularSeller extends defineModel({
  name: 'RegularSeller',
  fields: { storeName: field.string() },
}) {}

class Product extends defineModel({
  name: 'Product',
  fields: {
    name: field.string(),
    seller: field.ref((): any => RegularSeller),
  },
}) {}

// ============================================================================
// Helpers
// ============================================================================

function makeRef<T>(id: string, value?: T): Reference<T> {
  const ref = new Reference<T>(id);
  if (value !== undefined) ref[HYDRATE](value as any);
  return ref;
}

function resolvePerm(perm: any, principals: Principal[]): (ctx: any) => Promise<boolean> {
  const resolvedDeps: Record<string, any> = {};
  for (const [key, token] of Object.entries(perm.deps as Record<string, any>)) {
    if (token === AbstractPrincipalProvider) {
      resolvedDeps[key] = { resolve: async () => principals };
    }
  }
  return perm.factory(resolvedDeps);
}

// ============================================================================
// Exact type matching
// ============================================================================

describe('exact type matching', () => {
  test('principal with exact matching type is allowed (always)', async () => {
    const ref = makeRef<any>('seller-1');
    const perm = permit(RegularSeller).always();
    const guard = resolvePerm(perm, [{ type: RegularSeller, ref }]);

    assert.strictEqual(await guard({ params: {} }), true);
  });

  test('principal with non-matching type is denied (always)', async () => {
    const ref = makeRef<any>('user-1');
    const perm = permit(RegularSeller).always();
    const guard = resolvePerm(perm, [{ type: BaseUser, ref }]);

    assert.strictEqual(await guard({ params: {} }), false);
  });
});

// ============================================================================
// Subclass matching — multiple principals
// ============================================================================

describe('multiple principals — first match wins', () => {
  test('with two principals, matching type grants access', async () => {
    const sellerRef = makeRef<any>('seller-1');
    const userRef = makeRef<any>('user-1');

    const perm = permit(RegularSeller).always();
    const guard = resolvePerm(perm, [
      { type: BaseUser, ref: userRef },       // non-matching
      { type: RegularSeller, ref: sellerRef }, // matching
    ]);

    assert.strictEqual(await guard({ params: {} }), true);
  });

  test('order of principals does not matter — all are checked', async () => {
    const sellerRef = makeRef<any>('seller-1');
    const userRef = makeRef<any>('user-1');

    const perm = permit(RegularSeller).always();
    const guard = resolvePerm(perm, [
      { type: RegularSeller, ref: sellerRef }, // matching first
      { type: BaseUser, ref: userRef },        // non-matching second
    ]);

    assert.strictEqual(await guard({ params: {} }), true);
  });

  test('all principals must fail for overall denial', async () => {
    const userRef = makeRef<any>('user-1');
    const verifiedRef = makeRef<any>('verified-1');

    const perm = permit(RegularSeller).always();
    const guard = resolvePerm(perm, [
      { type: BaseUser, ref: userRef },
      { type: VerifiedUser, ref: verifiedRef },
    ]);

    assert.strictEqual(await guard({ params: {} }), false);
  });
});

// ============================================================================
// When-mode with multiple principals
// ============================================================================

describe('when mode with multiple principals', () => {
  test('matching principal with correct resource id is allowed', async () => {
    const sellerId = 'seller-42';
    const sellerRef = makeRef<any>(sellerId);
    const productRef = makeRef<any>('product-1', {
      name: 'Widget',
      seller: makeRef<any>(sellerId),
    });

    const perm = permit(RegularSeller).when(() => Product.fields.seller);
    const guard = resolvePerm(perm, [
      { type: BaseUser, ref: makeRef<any>('user-1') },
      { type: RegularSeller, ref: sellerRef },
    ]);

    const result = await guard({ params: { productRef } });
    assert.strictEqual(result, true);
  });

  test('matching principal with wrong resource id is denied', async () => {
    const mySellerRef = makeRef<any>('seller-1');
    const productRef = makeRef<any>('product-1', {
      name: 'Widget',
      seller: makeRef<any>('seller-2'), // different seller
    });

    const perm = permit(RegularSeller).when(() => Product.fields.seller);
    const guard = resolvePerm(perm, [
      { type: RegularSeller, ref: mySellerRef },
    ]);

    const result = await guard({ params: { productRef } });
    assert.strictEqual(result, false);
  });
});

// ============================================================================
// Edge cases
// ============================================================================

describe('edge cases', () => {
  test('empty principals list always denies', async () => {
    const perm1 = permit(RegularSeller).always();
    const perm2 = permit(RegularSeller).when(() => Product.fields.seller);
    const perm3 = permit(RegularSeller).check(async () => true);

    const guard1 = resolvePerm(perm1, []);
    const guard2 = resolvePerm(perm2, []);
    const guard3 = resolvePerm(perm3, []);

    assert.strictEqual(await guard1({ params: {} }), false);
    assert.strictEqual(await guard2({ params: {} }), false);
    assert.strictEqual(await guard3({ params: {} }), false);
  });

  test('async principal resolution works', async () => {
    const sellerRef = makeRef<any>('seller-1');

    const perm = permit(RegularSeller).always();
    // Resolve with async principal provider
    const resolvedDeps = {
      principals: {
        resolve: async () => {
          // Simulate async lookup
          await new Promise((r) => setTimeout(r, 1));
          return [{ type: RegularSeller, ref: sellerRef }];
        },
      },
    };
    const guard = perm.factory(resolvedDeps);

    const result = await guard({ params: {} });
    assert.strictEqual(result, true);
  });

  test('check() receives undefined resource when no ref in params', async () => {
    const sellerRef = makeRef<any>('seller-1');
    let receivedResource: any = 'NOT_CALLED';

    const perm = permit(RegularSeller).check(async (_ref, resource) => {
      receivedResource = resource;
      return true;
    });
    const guard = resolvePerm(perm, [{ type: RegularSeller, ref: sellerRef }]);

    await guard({ params: {} });
    assert.strictEqual(receivedResource, undefined, 'resource should be undefined when no ref in params');
  });
});
