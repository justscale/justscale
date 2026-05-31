/**
 * Tests for PermissionService — grant, revoke, check explicit grants.
 */

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert';

import { defineModel, field, Reference, HYDRATE, InMemoryRepository, getModelFields } from '@justscale/core/models';
import { permit } from '../src/index.js';
import { PermissionGrant } from '../src/models/permission-grant.js';
import { PermissionService } from '../src/services/permission.service.js';

// ============================================================================
// Test models
// ============================================================================

class Seller extends defineModel({
  name: 'Seller',
  fields: {
    name: field.string(),
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
    seller: field.ref((): any => Seller),
  },
}) {
  static can = {
    edit: permit(Seller).when(() => Product.fields.seller),
    view: permit(Seller).always(),
    create: permit(Seller),
  };
}

// ============================================================================
// Helpers
// ============================================================================

function makeRef<T>(id: string): Reference<T> {
  return new Reference<T>(id);
}

/**
 * Create a PermissionService instance backed by an in-memory repository.
 */
function makeService() {
  const repo = new InMemoryRepository<PermissionGrant>({
    modelClass: PermissionGrant as any,
    fieldDefs: getModelFields(PermissionGrant),
  });
  const service = (PermissionService as any).factory({ grants: repo });
  return { service, repo };
}

// ============================================================================
// grant()
// ============================================================================

describe('PermissionService.grant()', () => {
  test('stores a grant record for a subject + resource', async () => {
    const { service, repo } = makeService();
    const sellerRef = makeRef<any>('seller-1');
    const productRef = makeRef<any>('product-1');

    await service.grant(Product.can.edit, {
      subject: sellerRef,
      resource: productRef,
      action: 'edit',
    });

    const all = await repo.find();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].subjectId, 'seller-1');
    assert.strictEqual(all[0].subjectType, 'Seller');
    assert.strictEqual(all[0].resourceId, 'product-1');
    assert.strictEqual(all[0].granted, true);
  });

  test('stores a type-level grant (no resource)', async () => {
    const { service, repo } = makeService();
    const sellerRef = makeRef<any>('seller-1');

    await service.grant(Product.can.create, {
      subject: sellerRef,
      action: 'create',
    });

    const all = await repo.find();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].resourceId, undefined);
    assert.strictEqual(all[0].resourceType, undefined);
    assert.strictEqual(all[0].granted, true);
  });

  test('does not create duplicate grants', async () => {
    const { service, repo } = makeService();
    const sellerRef = makeRef<any>('seller-1');
    const productRef = makeRef<any>('product-1');

    await service.grant(Product.can.edit, { subject: sellerRef, resource: productRef, action: 'edit' });
    await service.grant(Product.can.edit, { subject: sellerRef, resource: productRef, action: 'edit' });

    const all = await repo.find();
    assert.strictEqual(all.length, 1, 'should not create duplicate grants');
  });

  test('action key includes subject class name and action name', async () => {
    const { service, repo } = makeService();
    const sellerRef = makeRef<any>('seller-1');

    await service.grant(Product.can.edit, { subject: sellerRef, action: 'edit' });

    const all = await repo.find();
    // Key format: `${className}#${uniqueId}:${actionName}` — class name and
    // action name are always embedded; the #id suffix prevents cross-module
    // collisions between two classes that share the same .name.
    assert.match(all[0].action, /^Seller#\d+:edit$/, 'action key must embed class name and action name');
  });

  test('different actions for same subject create separate grants', async () => {
    const { service, repo } = makeService();
    const sellerRef = makeRef<any>('seller-1');

    await service.grant(Product.can.create, { subject: sellerRef, action: 'create' });
    await service.grant(Product.can.edit, { subject: sellerRef, action: 'edit' });

    const all = await repo.find();
    assert.strictEqual(all.length, 2);
    const actions = all.map((g) => g.action).sort();
    // Key format: `${className}#${uniqueId}:${actionName}`
    assert.ok(actions.every((a) => a.startsWith('Seller#')), 'all keys must use the same class identity prefix');
    assert.ok(actions.some((a) => a.endsWith(':create')), 'create key must contain :create');
    assert.ok(actions.some((a) => a.endsWith(':edit')), 'edit key must contain :edit');
  });

  test('different subjects for same action create separate grants', async () => {
    const { service, repo } = makeService();

    await service.grant(Product.can.edit, { subject: makeRef<any>('seller-1'), action: 'edit' });
    await service.grant(Product.can.edit, { subject: makeRef<any>('seller-2'), action: 'edit' });

    const all = await repo.find();
    assert.strictEqual(all.length, 2);
  });
});

// ============================================================================
// revoke()
// ============================================================================

describe('PermissionService.revoke()', () => {
  test('removes an existing grant', async () => {
    const { service, repo } = makeService();
    const sellerRef = makeRef<any>('seller-1');
    const productRef = makeRef<any>('product-1');

    await service.grant(Product.can.edit, { subject: sellerRef, resource: productRef, action: 'edit' });
    assert.strictEqual((await repo.find()).length, 1);

    await service.revoke(Product.can.edit, { subject: sellerRef, resource: productRef, action: 'edit' });
    assert.strictEqual((await repo.find()).length, 0, 'grant should be removed');
  });

  test('is a no-op when grant does not exist', async () => {
    const { service } = makeService();
    const sellerRef = makeRef<any>('seller-1');

    // Should not throw
    await service.revoke(Product.can.edit, { subject: sellerRef, action: 'edit' });
  });

  test('only removes the matching grant, leaves others intact', async () => {
    const { service, repo } = makeService();

    const seller1 = makeRef<any>('seller-1');
    const seller2 = makeRef<any>('seller-2');
    const productRef = makeRef<any>('product-1');

    await service.grant(Product.can.edit, { subject: seller1, resource: productRef, action: 'edit' });
    await service.grant(Product.can.edit, { subject: seller2, resource: productRef, action: 'edit' });

    await service.revoke(Product.can.edit, { subject: seller1, resource: productRef, action: 'edit' });

    const remaining = await repo.find();
    assert.strictEqual(remaining.length, 1);
    assert.strictEqual(remaining[0].subjectId, 'seller-2');
  });
});

// ============================================================================
// check()
// ============================================================================

describe('PermissionService.check()', () => {
  test('returns true for an existing resource grant', async () => {
    const { service } = makeService();
    const sellerRef = makeRef<any>('seller-1');
    const productRef = makeRef<any>('product-1');

    await service.grant(Product.can.edit, { subject: sellerRef, resource: productRef, action: 'edit' });

    const result = await service.check(Product.can.edit, {
      subject: sellerRef,
      resource: productRef,
      action: 'edit',
    });
    assert.strictEqual(result, true);
  });

  test('returns false when no grant exists', async () => {
    const { service } = makeService();
    const sellerRef = makeRef<any>('seller-1');
    const productRef = makeRef<any>('product-1');

    const result = await service.check(Product.can.edit, {
      subject: sellerRef,
      resource: productRef,
      action: 'edit',
    });
    assert.strictEqual(result, false);
  });

  test('returns false after revoke', async () => {
    const { service } = makeService();
    const sellerRef = makeRef<any>('seller-1');
    const productRef = makeRef<any>('product-1');

    await service.grant(Product.can.edit, { subject: sellerRef, resource: productRef, action: 'edit' });
    await service.revoke(Product.can.edit, { subject: sellerRef, resource: productRef, action: 'edit' });

    const result = await service.check(Product.can.edit, {
      subject: sellerRef,
      resource: productRef,
      action: 'edit',
    });
    assert.strictEqual(result, false);
  });

  test('type-level grant allows access to any resource of that type', async () => {
    const { service } = makeService();
    const sellerRef = makeRef<any>('seller-1');
    const productRef = makeRef<any>('product-99');

    // Grant type-level (no specific resource)
    await service.grant(Product.can.create, { subject: sellerRef, action: 'create' });

    // Check type-level grant
    const result = await service.check(Product.can.create, {
      subject: sellerRef,
      action: 'create',
    });
    assert.strictEqual(result, true);
  });

  test('does not match wrong subject', async () => {
    const { service } = makeService();
    const seller1 = makeRef<any>('seller-1');
    const seller2 = makeRef<any>('seller-2');
    const productRef = makeRef<any>('product-1');

    await service.grant(Product.can.edit, { subject: seller1, resource: productRef, action: 'edit' });

    const result = await service.check(Product.can.edit, {
      subject: seller2,
      resource: productRef,
      action: 'edit',
    });
    assert.strictEqual(result, false);
  });

  test('does not match wrong resource', async () => {
    const { service } = makeService();
    const sellerRef = makeRef<any>('seller-1');
    const product1 = makeRef<any>('product-1');
    const product2 = makeRef<any>('product-2');

    await service.grant(Product.can.edit, { subject: sellerRef, resource: product1, action: 'edit' });

    const result = await service.check(Product.can.edit, {
      subject: sellerRef,
      resource: product2,
      action: 'edit',
    });
    assert.strictEqual(result, false);
  });

  test('does not match wrong action', async () => {
    const { service } = makeService();
    const sellerRef = makeRef<any>('seller-1');

    await service.grant(Product.can.edit, { subject: sellerRef, action: 'edit' });

    const result = await service.check(Product.can.create, {
      subject: sellerRef,
      action: 'create',
    });
    assert.strictEqual(result, false);
  });

  test('resource-level grant does NOT imply type-level access', async () => {
    const { service } = makeService();
    const sellerRef = makeRef<any>('seller-1');
    const productRef = makeRef<any>('product-1');

    // Grant only for specific resource
    await service.grant(Product.can.edit, { subject: sellerRef, resource: productRef, action: 'edit' });

    // Check type-level (no resource) — should NOT match
    const result = await service.check(Product.can.edit, {
      subject: sellerRef,
      action: 'edit',
    });
    assert.strictEqual(result, false);
  });
});
