/**
 * Webshop scenario — end-to-end test of the permission system.
 *
 * This models the full webshop use case from the plan:
 *  - Seller can create/edit/delete their own products
 *  - Admin can always delete any product
 *  - Customer can view their own cart, checkout
 *  - Seller can view orders for their products
 *  - Admin can always refund
 *
 * Tests cover:
 *  1. Guard execution (allow/deny)
 *  2. toCondition() for collection queries
 *  3. byPermissions() combining multiple permissions
 *  4. PermissionService for explicit grants
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';

import { defineModel, field, Reference, HYDRATE, InMemoryRepository, getModelFields, q } from '@justscale/core/models';
import type { Condition } from '@justscale/core/models';
import { permit, byPermissions, isQueryablePermissionDef } from '../src/index.js';
import type { Principal, QueryablePermissionDef } from '../src/index.js';
import { AbstractPrincipalProvider } from '../src/services/principal-provider.js';
import { PermissionGrant } from '../src/models/permission-grant.js';
import { PermissionService } from '../src/services/permission.service.js';

// ============================================================================
// Domain models
// ============================================================================

class AppUser extends defineModel({
  name: 'AppUser',
  fields: { email: field.string() },
}) {}

class Seller extends defineModel({
  name: 'Seller',
  fields: { storeName: field.string() },
}) {}

class Admin extends defineModel({
  name: 'Admin',
  fields: { name: field.string() },
}) {}

class Customer extends defineModel({
  name: 'Customer',
  fields: { name: field.string() },
}) {}

class Product extends defineModel({
  name: 'Product',
  fields: {
    name: field.string(),
    price: field.string(),
    seller: field.ref((): any => Seller),
  },
}) {
  static can = {
    create: permit(Seller),
    edit: permit(Seller).when(() => Product.fields.seller),
    view: permit(AppUser).always(),
    delete: [
      permit(Seller).when(() => Product.fields.seller),
      permit(Admin).always(),
    ],
  };
}

class Cart extends defineModel({
  name: 'Cart',
  fields: {
    customer: field.ref((): any => Customer),
    total: field.string(),
  },
}) {
  static can = {
    view: permit(Customer).when(() => Cart.fields.customer),
    checkout: permit(Customer).when(() => Cart.fields.customer),
  };
}

class Order extends defineModel({
  name: 'Order',
  fields: {
    buyer: field.ref((): any => Customer),
    product: field.ref((): any => Product),
    status: field.string(),
  },
}) {
  static can = {
    view: [
      permit(Customer).when(() => Order.fields.buyer),
      permit(Seller).always(), // Seller can view all orders (simplified)
    ],
    cancel: permit(Customer).when(() => Order.fields.buyer),
    refund: [permit(Seller), permit(Admin).always()],
    ship: permit(Seller),
  };
}

// ============================================================================
// Helpers
// ============================================================================

function makeRef<T>(id: string, value?: T): Reference<T> {
  const ref = new Reference<T>(id);
  if (value !== undefined) ref[HYDRATE](value as any);
  return ref;
}

function resolveGuard(perm: any, principals: Principal[]): (ctx: any) => Promise<boolean> {
  const resolvedDeps: Record<string, any> = {};
  for (const [key, token] of Object.entries(perm.deps as Record<string, any>)) {
    if (token === AbstractPrincipalProvider) {
      resolvedDeps[key] = { resolve: async () => principals };
    }
  }
  return perm.factory(resolvedDeps);
}

function resolveGuardArray(perms: any[], principals: Principal[]): (ctx: any) => Promise<boolean> {
  const fns = perms.map((p) => resolveGuard(p, principals));
  return async (ctx: any) => {
    for (const fn of fns) {
      if (await fn(ctx)) return true;
    }
    return false;
  };
}

function makeService() {
  const repo = new InMemoryRepository<PermissionGrant>({
    modelClass: PermissionGrant as any,
    fieldDefs: getModelFields(PermissionGrant),
  });
  return { service: (PermissionService as any).factory({ grants: repo }), repo };
}

// ============================================================================
// Webshop — Product permissions
// ============================================================================

describe('webshop — Product.can', () => {
  test('seller can create products (explicit mode — guard logic)', async () => {
    // 'create' is explicit mode — the guard still runs against principals
    // but doesn't check any resource field (create doesn't have a resource yet)
    const sellerRef = makeRef<any>('seller-1');
    const guard = resolveGuard(Product.can.create, [{ type: Seller, ref: sellerRef }]);
    // Explicit mode returns false (no explicit grant implemented)
    // but this shows the intent — you'd use PermissionService.grant() for explicit
    const result = await guard({ params: {} });
    assert.strictEqual(result, false, 'explicit mode requires DB grant — not auto-allowed');
  });

  test('seller can edit their own product', async () => {
    const sellerId = 'seller-1';
    const sellerRef = makeRef<any>(sellerId);
    const productRef = makeRef<any>('product-1', {
      name: 'Widget',
      price: '9.99',
      seller: makeRef<any>(sellerId),
    });

    const guard = resolveGuard(Product.can.edit, [{ type: Seller, ref: sellerRef }]);
    assert.strictEqual(await guard({ params: { productRef } }), true);
  });

  test('seller cannot edit another seller\'s product', async () => {
    const mySellerRef = makeRef<any>('seller-1');
    const productRef = makeRef<any>('product-1', {
      name: 'Widget',
      seller: makeRef<any>('seller-2'),
    });

    const guard = resolveGuard(Product.can.edit, [{ type: Seller, ref: mySellerRef }]);
    assert.strictEqual(await guard({ params: { productRef } }), false);
  });

  test('any AppUser can view products (always)', async () => {
    const userRef = makeRef<any>('user-1');
    const productRef = makeRef<any>('product-1', { name: 'Widget', seller: makeRef<any>('seller-1') });

    const guard = resolveGuard(Product.can.view, [{ type: AppUser, ref: userRef }]);
    assert.strictEqual(await guard({ params: { productRef } }), true);
  });

  test('seller can delete their own product', async () => {
    const sellerId = 'seller-1';
    const sellerRef = makeRef<any>(sellerId);
    const productRef = makeRef<any>('product-1', {
      seller: makeRef<any>(sellerId),
    });

    const guard = resolveGuardArray(Product.can.delete as any[], [{ type: Seller, ref: sellerRef }]);
    assert.strictEqual(await guard({ params: { productRef } }), true);
  });

  test('admin can delete any product (always)', async () => {
    const adminRef = makeRef<any>('admin-1');
    const productRef = makeRef<any>('product-1', {
      seller: makeRef<any>('seller-99'),
    });

    const guard = resolveGuardArray(Product.can.delete as any[], [{ type: Admin, ref: adminRef }]);
    assert.strictEqual(await guard({ params: { productRef } }), true);
  });

  test('seller cannot delete another seller\'s product (and is not admin)', async () => {
    const sellerRef = makeRef<any>('seller-1');
    const productRef = makeRef<any>('product-1', {
      seller: makeRef<any>('seller-2'),
    });

    const guard = resolveGuardArray(Product.can.delete as any[], [{ type: Seller, ref: sellerRef }]);
    assert.strictEqual(await guard({ params: { productRef } }), false);
  });
});

// ============================================================================
// Webshop — Cart permissions
// ============================================================================

describe('webshop — Cart.can', () => {
  test('customer can view their own cart', async () => {
    const customerId = 'customer-1';
    const customerRef = makeRef<any>(customerId);
    const cartRef = makeRef<any>('cart-1', {
      customer: makeRef<any>(customerId),
      total: '50.00',
    });

    const guard = resolveGuard(Cart.can.view, [{ type: Customer, ref: customerRef }]);
    assert.strictEqual(await guard({ params: { cartRef } }), true);
  });

  test('customer cannot view another customer\'s cart', async () => {
    const customerRef = makeRef<any>('customer-1');
    const cartRef = makeRef<any>('cart-1', {
      customer: makeRef<any>('customer-2'),
    });

    const guard = resolveGuard(Cart.can.view, [{ type: Customer, ref: customerRef }]);
    assert.strictEqual(await guard({ params: { cartRef } }), false);
  });

  test('customer can checkout their own cart', async () => {
    const customerId = 'customer-1';
    const customerRef = makeRef<any>(customerId);
    const cartRef = makeRef<any>('cart-1', {
      customer: makeRef<any>(customerId),
      total: '99.99',
    });

    const guard = resolveGuard(Cart.can.checkout, [{ type: Customer, ref: customerRef }]);
    assert.strictEqual(await guard({ params: { cartRef } }), true);
  });
});

// ============================================================================
// Webshop — Order permissions
// ============================================================================

describe('webshop — Order.can', () => {
  test('customer can view their own orders', async () => {
    const customerId = 'customer-1';
    const customerRef = makeRef<any>(customerId);
    const orderRef = makeRef<any>('order-1', {
      buyer: makeRef<any>(customerId),
      status: 'pending',
    });

    const guard = resolveGuardArray(Order.can.view as any[], [{ type: Customer, ref: customerRef }]);
    assert.strictEqual(await guard({ params: { orderRef } }), true);
  });

  test('seller can view all orders (always)', async () => {
    const sellerRef = makeRef<any>('seller-1');
    const orderRef = makeRef<any>('order-1', {
      buyer: makeRef<any>('customer-99'),
      status: 'pending',
    });

    const guard = resolveGuardArray(Order.can.view as any[], [{ type: Seller, ref: sellerRef }]);
    assert.strictEqual(await guard({ params: { orderRef } }), true);
  });

  test('admin can always refund (from always rule in compound permissions)', async () => {
    const adminRef = makeRef<any>('admin-1');
    const guard = resolveGuardArray(Order.can.refund as any[], [{ type: Admin, ref: adminRef }]);
    assert.strictEqual(await guard({ params: {} }), true);
  });
});

// ============================================================================
// Webshop — toCondition() for collection queries
// ============================================================================

describe('webshop — toCondition() for queries', () => {
  test('Product.can.edit toCondition returns WHERE seller = principalId', () => {
    const sellerRef = makeRef<any>('seller-42');
    const principal: Principal = { type: Seller, ref: sellerRef };

    const cond = (Product.can.edit as QueryablePermissionDef).toCondition(principal);
    assert.strictEqual(cond.type, 'eq');
    assert.strictEqual((cond as any).field, 'seller');
    assert.strictEqual((cond as any).value, 'seller-42');
  });

  test('Product.can.view toCondition returns TRUE (no restriction)', () => {
    const userRef = makeRef<any>('user-1');
    const principal: Principal = { type: AppUser, ref: userRef };

    const cond = (Product.can.view as QueryablePermissionDef).toCondition(principal);
    assert.strictEqual(cond.type, 'and');
    assert.deepStrictEqual((cond as any).conditions, []);
  });

  test('Cart.can.view toCondition returns WHERE customer = principalId', () => {
    const customerRef = makeRef<any>('customer-1');
    const principal: Principal = { type: Customer, ref: customerRef };

    const cond = (Cart.can.view as QueryablePermissionDef).toCondition(principal);
    assert.strictEqual(cond.type, 'eq');
    assert.strictEqual((cond as any).field, 'customer');
    assert.strictEqual((cond as any).value, 'customer-1');
  });

  test('Order.can.view has at least one queryable permission (customer when)', () => {
    const viewPerms = Order.can.view as any[];
    const queryable = viewPerms.filter(isQueryablePermissionDef);
    assert.ok(queryable.length >= 1, 'at least one queryable permission for view');
  });
});

// ============================================================================
// Webshop — byPermissions() for filtered collection queries
// ============================================================================

describe('webshop — byPermissions() for filtered queries', () => {
  test('seller gets WHERE condition for their editable products', () => {
    const sellerRef = makeRef<any>('seller-42');
    const principal: Principal = { type: Seller, ref: sellerRef };

    // Filter: products the seller can edit
    const cond = byPermissions(Product.can, principal, 'edit');
    assert.strictEqual(cond.type, 'eq');
    assert.strictEqual((cond as any).field, 'seller');
    assert.strictEqual((cond as any).value, 'seller-42');
  });

  test('admin gets TRUE (no restriction) for deletable products', () => {
    const adminRef = makeRef<any>('admin-1');
    const principal: Principal = { type: Admin, ref: adminRef };

    // Admin has 'always' on delete → no WHERE restriction
    const cond = byPermissions(Product.can, principal, 'delete');
    assert.strictEqual(cond.type, 'and');
    assert.deepStrictEqual((cond as any).conditions, []);
  });

  test('customer has no access to Product.can → FALSE', () => {
    const customerRef = makeRef<any>('customer-1');
    const principal: Principal = { type: Customer, ref: customerRef };

    const cond = byPermissions(Product.can, principal);
    // Customer has no permissions → empty OR = FALSE
    assert.strictEqual(cond.type, 'or');
    assert.deepStrictEqual((cond as any).conditions, []);
  });

  test('combining byPermissions with other conditions (and)', () => {
    const sellerRef = makeRef<any>('seller-42');
    const principal: Principal = { type: Seller, ref: sellerRef };

    const permCond = byPermissions(Product.can, principal, 'edit');
    // Combine with a name filter
    const combined = q.and(permCond, Product.fields.name.eq('Widget'));

    assert.strictEqual(combined.type, 'and');
    const subconds = (combined as any).conditions;
    assert.strictEqual(subconds.length, 2, 'should have permission condition + name condition');
    assert.strictEqual(subconds[0].type, 'eq');   // seller = 'seller-42'
    assert.strictEqual(subconds[1].type, 'eq');   // name = 'Widget'
  });
});

// ============================================================================
// Webshop — PermissionService for explicit grants
// ============================================================================

describe('webshop — explicit grants via PermissionService', () => {
  test('seller can explicitly share edit access with another seller', async () => {
    const { service } = makeService();
    const ownerSeller = makeRef<any>('seller-owner');
    const guestSeller = makeRef<any>('seller-guest');
    const productRef = makeRef<any>('product-1');

    // Grant guest seller access to edit this specific product
    await service.grant(Product.can.edit, {
      subject: guestSeller,
      resource: productRef,
      action: 'edit',
    });

    const canEdit = await service.check(Product.can.edit, {
      subject: guestSeller,
      resource: productRef,
      action: 'edit',
    });
    assert.strictEqual(canEdit, true, 'guest seller should have explicit access');

    // Owner seller is not affected
    const ownerCanEdit = await service.check(Product.can.edit, {
      subject: ownerSeller,
      resource: productRef,
      action: 'edit',
    });
    assert.strictEqual(ownerCanEdit, false, 'owner has no explicit grant (would need rule-based check)');
  });

  test('revoking explicit grant removes access', async () => {
    const { service } = makeService();
    const guestSeller = makeRef<any>('seller-guest');
    const productRef = makeRef<any>('product-1');

    await service.grant(Product.can.edit, {
      subject: guestSeller,
      resource: productRef,
      action: 'edit',
    });

    await service.revoke(Product.can.edit, {
      subject: guestSeller,
      resource: productRef,
      action: 'edit',
    });

    const canEdit = await service.check(Product.can.edit, {
      subject: guestSeller,
      resource: productRef,
      action: 'edit',
    });
    assert.strictEqual(canEdit, false, 'access should be revoked');
  });

  test('type-level create grant gives seller explicit create access', async () => {
    const { service } = makeService();
    const sellerRef = makeRef<any>('seller-1');

    await service.grant(Product.can.create, {
      subject: sellerRef,
      action: 'create',
    });

    const canCreate = await service.check(Product.can.create, {
      subject: sellerRef,
      action: 'create',
    });
    assert.strictEqual(canCreate, true, 'type-level create grant should work');
  });
});
