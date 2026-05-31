/**
 * Tests for the permit() builder and permission system.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';

import { defineModel, field, Reference, isReference, HYDRATE } from '@justscale/core/models';
import { isGuardDef } from '@justscale/core';
import { permit, isPermissionDef, isQueryablePermissionDef, PERMISSION_DEF } from '../src/index.js';
import type { QueryablePermissionDef } from '../src/index.js';
import { AbstractPrincipalProvider } from '../src/services/principal-provider.js';

// ============================================================================
// Test models
// ============================================================================

class Seller extends defineModel({
  name: 'Seller',
  fields: {
    name: field.string(),
    email: field.string(),
  },
}) {}

class Admin extends defineModel({
  name: 'Admin',
  fields: {
    name: field.string(),
  },
}) {}

class Product extends defineModel({
  name: 'Product',
  fields: {
    name: field.string(),
    price: field.decimal(10, 2),
    seller: field.ref((): any => Seller),
  },
}) {
  static can = {
    edit: permit(Seller).when(() => Product.fields.seller),
    view: permit(Seller).always(),
    delete: [
      permit(Seller).when(() => Product.fields.seller),
      permit(Admin).always(),
    ],
    create: permit(Seller),
  };
}

// Helper: create a hydrated Reference with a known value
function makeRef<T>(id: string, value?: T): Reference<T> {
  const ref = new Reference<T>(id);
  if (value !== undefined) {
    ref[HYDRATE](value as any);
  }
  return ref;
}

// Helper: create a mock principal provider with preset principals
function makePrincipalDeps(principals: Array<{ type: any; ref: any }>) {
  return {
    principals: {
      resolve: async () => principals,
    },
  };
}

// ============================================================================
// permit() builder shape
// ============================================================================

describe('permit() builder', () => {
  test('permit(X) returns object with PERMISSION_DEF symbol', () => {
    const perm = permit(Seller);
    assert.ok(isPermissionDef(perm), 'should pass isPermissionDef');
    assert.ok(PERMISSION_DEF in perm, 'should have PERMISSION_DEF symbol');
  });

  test('permit(X) has explicit mode by default', () => {
    const perm = permit(Seller);
    assert.strictEqual(perm.mode, 'explicit');
    assert.strictEqual(perm.subjectClass, Seller);
  });

  test('permit(X).when() returns a when-mode permission', () => {
    const perm = permit(Seller).when(() => Product.fields.seller);
    assert.strictEqual(perm.mode, 'when');
    assert.ok(typeof perm.fieldAccessor === 'function', 'should have fieldAccessor');
    assert.strictEqual(perm.subjectClass, Seller);
  });

  test('permit(X).always() returns an always-mode permission', () => {
    const perm = permit(Seller).always();
    assert.strictEqual(perm.mode, 'always');
    assert.strictEqual(perm.subjectClass, Seller);
    assert.ok(!perm.fieldAccessor, 'should have no fieldAccessor');
  });

  test('permit(X).check() returns a check-mode permission', () => {
    const checkFn = (_ref: Reference<any>, _resource: any) => true;
    const perm = permit(Seller).check(checkFn);
    assert.strictEqual(perm.mode, 'check');
    assert.strictEqual(perm.checkFn, checkFn);
  });

  test('permission is a valid GuardDef (has deps and factory)', () => {
    const perm = permit(Seller).when(() => Product.fields.seller);
    assert.ok(isGuardDef(perm as any), 'should pass isGuardDef');
    assert.ok('deps' in perm, 'should have deps');
    assert.ok('factory' in perm, 'should have factory');
    assert.ok((perm as any).deps.principals === AbstractPrincipalProvider, 'should inject AbstractPrincipalProvider');
  });

  test('permit(X) (explicit mode) is also a GuardDef', () => {
    const perm = permit(Seller);
    assert.ok(isGuardDef(perm as any), 'should pass isGuardDef');
  });
});

// ============================================================================
// isPermissionDef
// ============================================================================

describe('isPermissionDef', () => {
  test('returns true for permit() result', () => {
    assert.ok(isPermissionDef(permit(Seller)));
  });

  test('returns true for .when() result', () => {
    assert.ok(isPermissionDef(permit(Seller).when(() => Product.fields.seller)));
  });

  test('returns true for .always() result', () => {
    assert.ok(isPermissionDef(permit(Seller).always()));
  });

  test('returns false for plain objects', () => {
    assert.ok(!isPermissionDef({ mode: 'when' }));
    assert.ok(!isPermissionDef(null));
    assert.ok(!isPermissionDef(42));
  });
});

// ============================================================================
// Model.can pattern
// ============================================================================

describe('Model.can', () => {
  test('Product.can.edit is a permission with when mode', () => {
    assert.ok(isPermissionDef(Product.can.edit));
    assert.strictEqual(Product.can.edit.mode, 'when');
  });

  test('Product.can.view is a permission with always mode', () => {
    assert.ok(isPermissionDef(Product.can.view));
    assert.strictEqual(Product.can.view.mode, 'always');
  });

  test('Product.can.delete is an array of two permissions', () => {
    assert.ok(Array.isArray(Product.can.delete));
    assert.strictEqual(Product.can.delete.length, 2);
    assert.ok(Product.can.delete.every(isPermissionDef));
    assert.strictEqual(Product.can.delete[0].mode, 'when');
    assert.strictEqual(Product.can.delete[1].mode, 'always');
    assert.strictEqual(Product.can.delete[1].subjectClass, Admin);
  });

  test('Product.can.create is explicit mode', () => {
    assert.ok(isPermissionDef(Product.can.create));
    assert.strictEqual(Product.can.create.mode, 'explicit');
  });
});

// ============================================================================
// Guard execution — always mode
// ============================================================================

describe('guard execution — always mode', () => {
  test('.always() allows when matching principal exists', async () => {
    const sellerRef = makeRef<any>('seller-1', { name: 'Alice' });
    const perm = permit(Seller).always();
    const guard = (perm as any).factory(makePrincipalDeps([
      { type: Seller, ref: sellerRef },
    ]));

    const result = await guard({ params: {} });
    assert.strictEqual(result, true);
  });

  test('.always() denies when no matching principal', async () => {
    const perm = permit(Seller).always();
    const guard = (perm as any).factory(makePrincipalDeps([]));

    const result = await guard({ params: {} });
    assert.strictEqual(result, false);
  });

  test('.always() denies when wrong principal type', async () => {
    const adminRef = makeRef<any>('admin-1', { name: 'Bob' });
    const perm = permit(Seller).always();
    const guard = (perm as any).factory(makePrincipalDeps([
      { type: Admin, ref: adminRef },
    ]));

    const result = await guard({ params: {} });
    assert.strictEqual(result, false);
  });
});

// ============================================================================
// Guard execution — when mode
// ============================================================================

describe('guard execution — when mode', () => {
  test('.when() allows when field matches principal', async () => {
    const sellerId = 'seller-42';
    const sellerRef = makeRef<any>(sellerId, { name: 'Alice' });

    // The resource has seller ref pointing to the same seller
    const sellerFieldRef = makeRef<any>(sellerId, { name: 'Alice' });
    const productRef = makeRef<any>('product-1', {
      name: 'Test Product',
      price: '9.99',
      seller: sellerFieldRef,
    });

    const perm = permit(Seller).when(() => Product.fields.seller);
    const guard = (perm as any).factory(makePrincipalDeps([
      { type: Seller, ref: sellerRef },
    ]));

    const result = await guard({ params: { productRef } });
    assert.strictEqual(result, true);
  });

  test('.when() denies when field does not match principal', async () => {
    const sellerRef = makeRef<any>('seller-42', { name: 'Alice' });
    const differentSellerId = 'seller-99';

    const differentSellerRef = makeRef<any>(differentSellerId, { name: 'Bob' });
    const productRef = makeRef<any>('product-1', {
      name: 'Test Product',
      price: '9.99',
      seller: differentSellerRef,
    });

    const perm = permit(Seller).when(() => Product.fields.seller);
    const guard = (perm as any).factory(makePrincipalDeps([
      { type: Seller, ref: sellerRef },
    ]));

    const result = await guard({ params: { productRef } });
    assert.strictEqual(result, false);
  });

  test('.when() denies when no resource in params — fail closed (use .forCreate() for create semantics)', async () => {
    const sellerRef = makeRef<any>('seller-42', { name: 'Alice' });
    const perm = permit(Seller).when(() => Product.fields.seller);
    const guard = (perm as any).factory(makePrincipalDeps([
      { type: Seller, ref: sellerRef },
    ]));

    const result = await guard({ params: {} });
    assert.strictEqual(result, false, '.when() without a resource ref must deny');
  });

  test('.forCreate() allows when principal type matches, ignoring params', async () => {
    const sellerRef = makeRef<any>('seller-42');
    const perm = permit(Seller).forCreate();
    const guard = (perm as any).factory(makePrincipalDeps([
      { type: Seller, ref: sellerRef },
    ]));
    assert.strictEqual(await guard({ params: {} }), true);
  });

  test('.forCreate() denies when no principal of subject type', async () => {
    const perm = permit(Seller).forCreate();
    const guard = (perm as any).factory(makePrincipalDeps([]));
    assert.strictEqual(await guard({ params: {} }), false);
  });

  test('.when() denies when no principal', async () => {
    const productRef = makeRef<any>('product-1', {
      name: 'Test Product',
      seller: makeRef<any>('seller-42', { name: 'Alice' }),
    });

    const perm = permit(Seller).when(() => Product.fields.seller);
    const guard = (perm as any).factory(makePrincipalDeps([]));

    const result = await guard({ params: { productRef } });
    assert.strictEqual(result, false);
  });
});

// ============================================================================
// Guard execution — check mode
// ============================================================================

describe('guard execution — check mode', () => {
  test('.check() runs the custom function with principal ref and resource', async () => {
    const sellerRef = makeRef<any>('seller-1', { name: 'Alice' });
    const productRef = makeRef<any>('product-1', { name: 'Widget' });

    let receivedRef: any;
    let receivedResource: any;

    const perm = permit(Seller).check(async (ref, resource) => {
      receivedRef = ref;
      receivedResource = resource;
      return ref.identifier === 'seller-1';
    });

    const guard = (perm as any).factory(makePrincipalDeps([
      { type: Seller, ref: sellerRef },
    ]));

    const result = await guard({ params: { productRef } });
    assert.strictEqual(result, true);
    assert.ok(receivedRef, 'should have received ref');
    assert.ok(receivedResource, 'should have received resource');
    assert.strictEqual(receivedRef.identifier, 'seller-1');
  });

  test('.check() denies when function returns false', async () => {
    const sellerRef = makeRef<any>('seller-1', { name: 'Alice' });
    const productRef = makeRef<any>('product-1', { name: 'Widget' });

    const perm = permit(Seller).check(async () => false);
    const guard = (perm as any).factory(makePrincipalDeps([
      { type: Seller, ref: sellerRef },
    ]));

    const result = await guard({ params: { productRef } });
    assert.strictEqual(result, false);
  });
});

// ============================================================================
// QueryablePermissionDef and toCondition()
// ============================================================================

describe('QueryablePermissionDef', () => {
  test('.when() produces a QueryablePermissionDef', () => {
    const perm = permit(Seller).when(() => Product.fields.seller);
    assert.ok(isQueryablePermissionDef(perm), 'should pass isQueryablePermissionDef');
    assert.ok('toCondition' in perm, 'should have toCondition method');
    assert.ok(typeof (perm as QueryablePermissionDef).toCondition === 'function');
  });

  test('.always() produces a QueryablePermissionDef', () => {
    const perm = permit(Seller).always();
    assert.ok(isQueryablePermissionDef(perm), 'should pass isQueryablePermissionDef');
    assert.ok('toCondition' in perm, 'should have toCondition method');
  });

  test('.check() does NOT produce a QueryablePermissionDef', () => {
    const perm = permit(Seller).check(async () => true);
    assert.ok(!isQueryablePermissionDef(perm), 'check mode should not be queryable');
    assert.ok(!('toCondition' in perm), 'should not have toCondition method');
  });

  test('permit(X) explicit mode is NOT queryable', () => {
    const perm = permit(Seller);
    assert.ok(!isQueryablePermissionDef(perm), 'explicit mode should not be queryable');
  });

  test('.when() toCondition() returns EqCondition with correct field and value', () => {
    const sellerRef = makeRef<any>('seller-42');
    const principal = { type: Seller, ref: sellerRef };

    const perm = permit(Seller).when(() => Product.fields.seller) as QueryablePermissionDef;
    const condition = perm.toCondition(principal);

    assert.strictEqual(condition.type, 'eq', 'should produce an EqCondition');
    assert.strictEqual((condition as any).field, 'seller', 'field should match the field accessor field name');
    assert.strictEqual((condition as any).value, 'seller-42', 'value should be the principal ref identifier');
  });

  test('.when() toCondition() uses the principal ref identifier as value', () => {
    const sellerRef = makeRef<any>('seller-99');
    const principal = { type: Seller, ref: sellerRef };

    const perm = permit(Seller).when(() => Product.fields.seller) as QueryablePermissionDef;
    const condition = perm.toCondition(principal);

    assert.strictEqual((condition as any).value, 'seller-99');
  });

  test('.always() toCondition() returns an AndCondition with empty conditions (TRUE)', () => {
    const sellerRef = makeRef<any>('seller-1');
    const principal = { type: Seller, ref: sellerRef };

    const perm = permit(Admin).always() as QueryablePermissionDef;
    const condition = perm.toCondition(principal);

    assert.strictEqual(condition.type, 'and', 'should produce an AndCondition');
    assert.deepStrictEqual((condition as any).conditions, [], 'conditions should be empty (compiles to TRUE)');
  });

  test('.always() toCondition() produces same result regardless of principal', () => {
    const perm = permit(Admin).always() as QueryablePermissionDef;

    const cond1 = perm.toCondition({ type: Admin, ref: makeRef<any>('admin-1') });
    const cond2 = perm.toCondition({ type: Seller, ref: makeRef<any>('seller-99') });

    // Both should be empty AND (TRUE)
    assert.strictEqual(cond1.type, 'and');
    assert.strictEqual(cond2.type, 'and');
    assert.deepStrictEqual((cond1 as any).conditions, []);
    assert.deepStrictEqual((cond2 as any).conditions, []);
  });

  test('toCondition() can be called multiple times independently', () => {
    const perm = permit(Seller).when(() => Product.fields.seller) as QueryablePermissionDef;

    const cond1 = perm.toCondition({ type: Seller, ref: makeRef<any>('seller-1') });
    const cond2 = perm.toCondition({ type: Seller, ref: makeRef<any>('seller-2') });

    assert.strictEqual((cond1 as any).value, 'seller-1');
    assert.strictEqual((cond2 as any).value, 'seller-2');
  });

  test('isQueryablePermissionDef returns false for non-permission objects', () => {
    assert.ok(!isQueryablePermissionDef(null));
    assert.ok(!isQueryablePermissionDef(undefined));
    assert.ok(!isQueryablePermissionDef(42));
    assert.ok(!isQueryablePermissionDef({ mode: 'when' }));
    assert.ok(!isQueryablePermissionDef({ [PERMISSION_DEF]: true, mode: 'check' }));
  });
});
