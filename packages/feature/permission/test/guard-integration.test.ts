/**
 * Integration tests — permissions as guards, resolved through DI-like injection.
 *
 * These tests simulate what happens when a permission GuardDef is resolved
 * by a controller's dependency injection (the `resolve` function that maps
 * tokens to instances). They test the full pipeline:
 *
 *   permit(Seller).when(...) → GuardDef → resolved guard fn → guard(ctx) → bool
 *
 * This covers how the permission system integrates with the route execution flow.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';

import { defineModel, field, Reference, HYDRATE } from '@justscale/core/models';
import { isGuardDef } from '@justscale/core';
import { permit } from '../src/index.js';
import type { Principal } from '../src/index.js';
import { AbstractPrincipalProvider } from '../src/services/principal-provider.js';

// ============================================================================
// Test models
// ============================================================================

class Seller extends defineModel({
  name: 'Seller',
  fields: { name: field.string() },
}) {}

class Admin extends defineModel({
  name: 'Admin',
  fields: { name: field.string() },
}) {}

class Product extends defineModel({
  name: 'Product',
  fields: {
    name: field.string(),
    price: field.string(),
    seller: field.ref((): any => Seller),
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

/**
 * Simulate DI resolution of a GuardDef:
 * - Look up AbstractPrincipalProvider from deps
 * - Return a resolved guard function
 */
function resolveGuard(permissionDef: any, principals: Principal[]): (ctx: any) => boolean | Promise<boolean> {
  assert.ok(isGuardDef(permissionDef), 'permission must be a GuardDef');

  // Simulate DI: resolve AbstractPrincipalProvider token
  const resolvedDeps: Record<string, any> = {};
  for (const [key, token] of Object.entries(permissionDef.deps as Record<string, any>)) {
    if (token === AbstractPrincipalProvider) {
      resolvedDeps[key] = {
        resolve: async () => principals,
      };
    }
  }

  return permissionDef.factory(resolvedDeps);
}

/**
 * Resolve an array of GuardDefs with OR semantics (any match = allow).
 */
function resolveGuardArray(defs: any[], principals: Principal[]): (ctx: any) => Promise<boolean> {
  const fns = defs.map((d) => resolveGuard(d, principals));
  return async (ctx: any) => {
    for (const fn of fns) {
      if (await Promise.resolve(fn(ctx))) return true;
    }
    return false;
  };
}

// ============================================================================
// Guard resolution — basic
// ============================================================================

describe('guard integration — DI resolution', () => {
  test('resolved guard from when-permission is a callable function', () => {
    const perm = permit(Seller).when(() => Product.fields.seller);
    const sellerRef = makeRef<any>('seller-1');
    const guard = resolveGuard(perm, [{ type: Seller, ref: sellerRef }]);
    assert.ok(typeof guard === 'function', 'resolved guard should be a function');
  });

  test('resolved guard from always-permission is callable', () => {
    const perm = permit(Admin).always();
    const adminRef = makeRef<any>('admin-1');
    const guard = resolveGuard(perm, [{ type: Admin, ref: adminRef }]);
    assert.ok(typeof guard === 'function');
  });

  test('factory creates independent guard instances per call', async () => {
    const perm = permit(Seller).always();
    const seller1 = makeRef<any>('seller-1');
    const seller2 = makeRef<any>('seller-2');

    const guard1 = resolveGuard(perm, [{ type: Seller, ref: seller1 }]);
    const guard2 = resolveGuard(perm, []);  // no principals

    assert.strictEqual(await guard1({ params: {} }), true);
    assert.strictEqual(await guard2({ params: {} }), false);
  });
});

// ============================================================================
// when-mode guard integration
// ============================================================================

describe('guard integration — when mode', () => {
  test('allows when seller param matches the principal', async () => {
    const sellerId = 'seller-42';
    const sellerRef = makeRef<any>(sellerId, { name: 'Alice' });

    const productRef = makeRef<any>('product-1', {
      name: 'Widget',
      price: '9.99',
      seller: makeRef<any>(sellerId, { name: 'Alice' }),
    });

    const perm = permit(Seller).when(() => Product.fields.seller);
    const guard = resolveGuard(perm, [{ type: Seller, ref: sellerRef }]);

    const result = await guard({ params: { productRef } });
    assert.strictEqual(result, true);
  });

  test('denies when seller param is a different seller', async () => {
    const mySellerRef = makeRef<any>('seller-1', { name: 'Alice' });
    const otherSellerRef = makeRef<any>('seller-2', { name: 'Bob' });

    const productRef = makeRef<any>('product-1', {
      name: 'Widget',
      seller: otherSellerRef,
    });

    const perm = permit(Seller).when(() => Product.fields.seller);
    const guard = resolveGuard(perm, [{ type: Seller, ref: mySellerRef }]);

    const result = await guard({ params: { productRef } });
    assert.strictEqual(result, false);
  });

  test('denies when no resource ref in params — route must use .forCreate() for create semantics', async () => {
    const sellerRef = makeRef<any>('seller-1', { name: 'Alice' });
    const perm = permit(Seller).when(() => Product.fields.seller);
    const guard = resolveGuard(perm, [{ type: Seller, ref: sellerRef }]);

    // No productRef in params — .when() fails closed.
    const result = await guard({ params: {} });
    assert.strictEqual(result, false, '.when() must deny when no resource ref — fail closed');
  });

  test('forCreate() allows when principal type matches, independent of params', async () => {
    const sellerRef = makeRef<any>('seller-1');
    const perm = permit(Seller).forCreate();
    const guard = resolveGuard(perm, [{ type: Seller, ref: sellerRef }]);
    assert.strictEqual(await guard({ params: {} }), true);
  });

  test('forCreate() denies when no matching principal', async () => {
    const perm = permit(Seller).forCreate();
    const guard = resolveGuard(perm, []);
    assert.strictEqual(await guard({ params: {} }), false);
  });

  test('denies when no principal at all', async () => {
    const productRef = makeRef<any>('product-1', {
      name: 'Widget',
      seller: makeRef<any>('seller-1'),
    });

    const perm = permit(Seller).when(() => Product.fields.seller);
    const guard = resolveGuard(perm, []); // no principals

    const result = await guard({ params: { productRef } });
    assert.strictEqual(result, false);
  });

  test('denies when principal is wrong type', async () => {
    const adminRef = makeRef<any>('admin-1', { name: 'Admin' });
    const productRef = makeRef<any>('product-1', {
      name: 'Widget',
      seller: makeRef<any>('seller-1'),
    });

    const perm = permit(Seller).when(() => Product.fields.seller);
    const guard = resolveGuard(perm, [{ type: Admin, ref: adminRef }]); // Admin, not Seller

    const result = await guard({ params: { productRef } });
    assert.strictEqual(result, false);
  });
});

// ============================================================================
// always-mode guard integration
// ============================================================================

describe('guard integration — always mode', () => {
  test('allows when principal type matches', async () => {
    const adminRef = makeRef<any>('admin-1');
    const perm = permit(Admin).always();
    const guard = resolveGuard(perm, [{ type: Admin, ref: adminRef }]);

    const result = await guard({ params: {} });
    assert.strictEqual(result, true);
  });

  test('denies when principal type does not match', async () => {
    const sellerRef = makeRef<any>('seller-1');
    const perm = permit(Admin).always();
    const guard = resolveGuard(perm, [{ type: Seller, ref: sellerRef }]); // Seller, not Admin

    const result = await guard({ params: {} });
    assert.strictEqual(result, false);
  });

  test('always() ignores the resource entirely', async () => {
    const adminRef = makeRef<any>('admin-1');
    const perm = permit(Admin).always();
    const guard = resolveGuard(perm, [{ type: Admin, ref: adminRef }]);

    const productRef = makeRef<any>('product-1', { name: 'Widget', seller: makeRef<any>('other-seller') });
    const result = await guard({ params: { productRef } });
    assert.strictEqual(result, true); // Always true for Admin regardless of resource
  });
});

// ============================================================================
// Array of GuardDefs (OR semantics — simulating compound permissions)
// ============================================================================

describe('guard integration — array permissions (OR semantics)', () => {
  const deletePerms = [
    permit(Seller).when(() => Product.fields.seller),
    permit(Admin).always(),
  ];

  test('seller who owns the product is allowed (matching when rule)', async () => {
    const sellerId = 'seller-1';
    const sellerRef = makeRef<any>(sellerId);
    const productRef = makeRef<any>('product-1', {
      name: 'Widget',
      seller: makeRef<any>(sellerId),
    });

    const guard = resolveGuardArray(deletePerms, [{ type: Seller, ref: sellerRef }]);
    const result = await guard({ params: { productRef } });
    assert.strictEqual(result, true, 'owner seller should be allowed');
  });

  test('admin is always allowed regardless of product seller', async () => {
    const adminRef = makeRef<any>('admin-1');
    const productRef = makeRef<any>('product-1', {
      name: 'Widget',
      seller: makeRef<any>('some-other-seller'),
    });

    const guard = resolveGuardArray(deletePerms, [{ type: Admin, ref: adminRef }]);
    const result = await guard({ params: { productRef } });
    assert.strictEqual(result, true, 'admin should always be allowed');
  });

  test('seller who does NOT own the product is denied', async () => {
    const sellerRef = makeRef<any>('seller-1');
    const productRef = makeRef<any>('product-1', {
      name: 'Widget',
      seller: makeRef<any>('seller-2'), // different seller
    });

    const guard = resolveGuardArray(deletePerms, [{ type: Seller, ref: sellerRef }]);
    const result = await guard({ params: { productRef } });
    assert.strictEqual(result, false, 'non-owner seller should be denied');
  });

  test('unauthenticated user (no principals) is denied', async () => {
    const productRef = makeRef<any>('product-1', {
      name: 'Widget',
      seller: makeRef<any>('seller-1'),
    });

    const guard = resolveGuardArray(deletePerms, []); // no principals
    const result = await guard({ params: { productRef } });
    assert.strictEqual(result, false, 'unauthenticated should be denied');
  });

  test('principal with both Seller and Admin roles is allowed via Admin rule', async () => {
    // Unlikely but valid: principal has both roles
    const sellerRef = makeRef<any>('seller-1');
    const adminRef = makeRef<any>('admin-1');
    const productRef = makeRef<any>('product-1', {
      seller: makeRef<any>('seller-99'), // seller-1 does NOT own this product
    });

    const guard = resolveGuardArray(deletePerms, [
      { type: Seller, ref: sellerRef },
      { type: Admin, ref: adminRef },
    ]);
    // Seller check fails (wrong product), but Admin always() passes
    const result = await guard({ params: { productRef } });
    assert.strictEqual(result, true, 'admin role should grant access even if seller check fails');
  });
});

// ============================================================================
// check-mode guard integration
// ============================================================================

describe('guard integration — check mode', () => {
  test('check() receives principal ref and resource', async () => {
    const sellerRef = makeRef<any>('seller-1', { name: 'Alice' });
    const productRef = makeRef<any>('product-1', { name: 'Widget' });

    let capturedRef: any;
    let capturedResource: any;

    const perm = permit(Seller).check(async (ref, resource) => {
      capturedRef = ref;
      capturedResource = resource;
      return true;
    });

    const guard = resolveGuard(perm, [{ type: Seller, ref: sellerRef }]);
    await guard({ params: { productRef } });

    assert.ok(capturedRef, 'should have received principal ref');
    assert.strictEqual(capturedRef.identifier, 'seller-1');
    assert.ok(capturedResource, 'should have received resource');
  });

  test('check() returning true allows access', async () => {
    const sellerRef = makeRef<any>('seller-1');
    const perm = permit(Seller).check(async () => true);
    const guard = resolveGuard(perm, [{ type: Seller, ref: sellerRef }]);

    const result = await guard({ params: {} });
    assert.strictEqual(result, true);
  });

  test('check() returning false denies access', async () => {
    const sellerRef = makeRef<any>('seller-1');
    const perm = permit(Seller).check(async () => false);
    const guard = resolveGuard(perm, [{ type: Seller, ref: sellerRef }]);

    const result = await guard({ params: {} });
    assert.strictEqual(result, false);
  });

  test('check() with custom identifier-based logic', async () => {
    const allowedSellerRef = makeRef<any>('seller-vip');
    const regularSellerRef = makeRef<any>('seller-regular');

    const perm = permit(Seller).check(async (ref) => ref.identifier === 'seller-vip');

    const allowedGuard = resolveGuard(perm, [{ type: Seller, ref: allowedSellerRef }]);
    const deniedGuard = resolveGuard(perm, [{ type: Seller, ref: regularSellerRef }]);

    assert.strictEqual(await allowedGuard({ params: {} }), true);
    assert.strictEqual(await deniedGuard({ params: {} }), false);
  });
});

// ============================================================================
// Multi-hop traversal — permit(Customer).when(ticket.has(Ticket.fields.customer))
// ============================================================================

class Customer extends defineModel({
  name: 'Customer',
  fields: { email: field.string() },
}) {}

class Ticket extends defineModel({
  name: 'Ticket',
  fields: {
    subject: field.string(),
    customer: field.ref((): any => Customer),
  },
}) {}

class Attachment extends defineModel({
  name: 'Attachment',
  fields: {
    ticket: field.ref((): any => Ticket),
    filename: field.string(),
  },
}) {}

class AttachmentAgent extends defineModel({
  name: 'AttachmentAgent',
  fields: { name: field.string() },
}) {}

describe('guard integration — multi-hop traversal', () => {
  test('customer can view their own attachment (traversal resolves correctly)', async () => {
    const customerId = 'customer-1';
    const customerRef = makeRef<any>(customerId);
    const ticketRef = makeRef<any>('ticket-1', {
      subject: 'Help',
      customer: makeRef<any>(customerId),
    });
    const attachmentRef = makeRef<any>('attachment-1', {
      filename: 'file.pdf',
      ticket: ticketRef,
    });

    const perms = [
      permit(Customer).when(Attachment.fields.ticket.has(Ticket.fields.customer)),
      permit(AttachmentAgent).always(),
    ];
    const guard = resolveGuardArray(perms, [{ type: Customer, ref: customerRef }]);

    const result = await guard({ params: { attachmentRef } });
    assert.strictEqual(result, true, 'customer should be able to view their own attachment');
  });

  test('customer cannot view another customers attachment', async () => {
    const myCustomerRef = makeRef<any>('customer-1');
    const otherCustomerRef = makeRef<any>('customer-2');
    const ticketRef = makeRef<any>('ticket-1', {
      subject: 'Help',
      customer: otherCustomerRef,
    });
    const attachmentRef = makeRef<any>('attachment-1', {
      filename: 'file.pdf',
      ticket: ticketRef,
    });

    const perms = [
      permit(Customer).when(Attachment.fields.ticket.has(Ticket.fields.customer)),
      permit(AttachmentAgent).always(),
    ];
    const guard = resolveGuardArray(perms, [{ type: Customer, ref: myCustomerRef }]);

    const result = await guard({ params: { attachmentRef } });
    assert.strictEqual(result, false, 'customer should not see another customers attachment');
  });

  test('agent always has access regardless of ownership', async () => {
    const agentRef = makeRef<any>('agent-1');
    const ticketRef = makeRef<any>('ticket-1', {
      subject: 'Help',
      customer: makeRef<any>('customer-99'),
    });
    const attachmentRef = makeRef<any>('attachment-1', {
      filename: 'file.pdf',
      ticket: ticketRef,
    });

    const perms = [
      permit(Customer).when(Attachment.fields.ticket.has(Ticket.fields.customer)),
      permit(AttachmentAgent).always(),
    ];
    const guard = resolveGuardArray(perms, [{ type: AttachmentAgent, ref: agentRef }]);

    const result = await guard({ params: { attachmentRef } });
    assert.strictEqual(result, true, 'agent should always have access');
  });

  test('missing ticket hop returns false', async () => {
    const customerRef = makeRef<any>('customer-1');
    // Attachment with no ticket (null)
    const attachmentRef = makeRef<any>('attachment-1', {
      filename: 'file.pdf',
      ticket: null,
    });

    const perms = [
      permit(Customer).when(Attachment.fields.ticket.has(Ticket.fields.customer)),
    ];
    const guard = resolveGuardArray(perms, [{ type: Customer, ref: customerRef }]);

    const result = await guard({ params: { attachmentRef } });
    assert.strictEqual(result, false, 'missing hop should deny access');
  });
});

// ============================================================================
// Multiple params — guard picks the first Reference
// ============================================================================

describe('guard integration — params with multiple refs', () => {
  test('guard checks every ref that carries the permission field — unrelated refs are ignored', async () => {
    const sellerId = 'seller-42';
    const sellerRef = makeRef<any>(sellerId);
    const productRef = makeRef<any>('product-1', {
      name: 'Widget',
      seller: makeRef<any>(sellerId),
    });

    const perm = permit(Seller).when(() => Product.fields.seller);
    const guard = resolveGuard(perm, [{ type: Seller, ref: sellerRef }]);

    // someOtherRef has no resolver — resolves to undefined and is filtered
    // out as "not relevant". productRef carries the `seller` field so it is
    // the sole resource checked.
    const someOtherRef = makeRef<any>('other-thing-1');
    const result = await guard({ params: { productRef, someOtherRef } });
    assert.strictEqual(result, true, 'productRef owned by the principal allows; unrelated refs ignored');
  });
});
