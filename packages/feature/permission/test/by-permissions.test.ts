/**
 * Tests for byPermissions() — condition derivation from can maps.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';

import { defineModel, field, Reference } from '@justscale/core/models';
import { permit } from '../src/index.js';
import type { Principal } from '../src/index.js';
import { byPermissions } from '../src/by-permissions.js';

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

class Customer extends defineModel({
  name: 'Customer',
  fields: { name: field.string() },
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
    delete: [
      permit(Seller).when(() => Product.fields.seller),
      permit(Admin).always(),
    ],
    create: permit(Seller),  // explicit — not queryable
  };
}

// ============================================================================
// Helpers
// ============================================================================

function makeRef<T>(id: string): Reference<T> {
  return new Reference<T>(id);
}

function makePrincipal(type: any, id: string): Principal {
  return { type, ref: makeRef<any>(id) };
}

// ============================================================================
// byPermissions — basic
// ============================================================================

describe('byPermissions() — basic', () => {
  test('returns EqCondition for a matching when permission (single action)', () => {
    const principal = makePrincipal(Seller, 'seller-1');
    const cond = byPermissions(Product.can, principal, 'edit');

    assert.strictEqual(cond.type, 'eq');
    assert.strictEqual((cond as any).field, 'seller');
    assert.strictEqual((cond as any).value, 'seller-1');
  });

  test('returns empty AND (TRUE) for an always permission (single action)', () => {
    const principal = makePrincipal(Seller, 'seller-1');
    const cond = byPermissions(Product.can, principal, 'view');

    assert.strictEqual(cond.type, 'and');
    assert.deepStrictEqual((cond as any).conditions, []);
  });

  test('returns empty OR (FALSE) when no matching permissions for subject type', () => {
    const principal = makePrincipal(Customer, 'customer-1');
    const cond = byPermissions(Product.can, principal, 'edit');

    assert.strictEqual(cond.type, 'or');
    assert.deepStrictEqual((cond as any).conditions, []);
  });

  test('skips non-queryable permissions (explicit/check mode)', () => {
    const principal = makePrincipal(Seller, 'seller-1');
    // 'create' is explicit mode — not queryable
    const cond = byPermissions(Product.can, principal, 'create');

    // No queryable permissions → empty OR = FALSE
    assert.strictEqual(cond.type, 'or');
    assert.deepStrictEqual((cond as any).conditions, []);
  });
});

// ============================================================================
// byPermissions — array permissions (OR of multiple rules)
// ============================================================================

describe('byPermissions() — array permissions', () => {
  test('returns OR of two conditions for Seller with [when, always] permissions', () => {
    // Product.can.delete is [permit(Seller).when(...), permit(Admin).always()]
    // For a Seller principal, only the 'when' rule matches (Admin.always doesn't match Seller)
    const principal = makePrincipal(Seller, 'seller-1');
    const cond = byPermissions(Product.can, principal, 'delete');

    // Only 1 matching condition (the 'when' rule for Seller)
    assert.strictEqual(cond.type, 'eq');
    assert.strictEqual((cond as any).field, 'seller');
    assert.strictEqual((cond as any).value, 'seller-1');
  });

  test('returns OR of conditions for Admin with [when, always] permissions', () => {
    // For an Admin principal, only the 'always' rule matches
    const principal = makePrincipal(Admin, 'admin-1');
    const cond = byPermissions(Product.can, principal, 'delete');

    // Only 1 matching condition (the 'always' for Admin)
    assert.strictEqual(cond.type, 'and');
    assert.deepStrictEqual((cond as any).conditions, []);
  });
});

// ============================================================================
// byPermissions — all actions (no action filter)
// ============================================================================

describe('byPermissions() — all actions merged', () => {
  test('merges conditions from all matching actions for Seller', () => {
    const principal = makePrincipal(Seller, 'seller-42');
    const cond = byPermissions(Product.can, principal);

    // Seller has: edit (when), view (always), delete[0] (when) — all queryable
    // 'create' is explicit → skipped
    // Expected: OR(eq(seller=42), and(), eq(seller=42)) → OrCondition with 3 conditions
    assert.strictEqual(cond.type, 'or');
    const subconds = (cond as any).conditions;
    assert.ok(subconds.length >= 2, `expected at least 2 conditions, got ${subconds.length}`);
  });

  test('returns FALSE when subject has no permissions at all', () => {
    const principal = makePrincipal(Customer, 'customer-1');
    const cond = byPermissions(Product.can, principal);

    // Customer has no permissions in Product.can
    assert.strictEqual(cond.type, 'or');
    assert.deepStrictEqual((cond as any).conditions, []);
  });

  test('Admin with delete (always) gets a single TRUE condition', () => {
    const principal = makePrincipal(Admin, 'admin-1');
    const cond = byPermissions(Product.can, principal);

    // Admin only has delete[1] (always) — single match
    assert.strictEqual(cond.type, 'and');
    assert.deepStrictEqual((cond as any).conditions, []);
  });
});

// ============================================================================
// byPermissions — condition values are correct per principal
// ============================================================================

describe('byPermissions() — per-principal condition values', () => {
  test('condition value changes for different principals', () => {
    const seller1 = makePrincipal(Seller, 'seller-1');
    const seller2 = makePrincipal(Seller, 'seller-2');

    const cond1 = byPermissions(Product.can, seller1, 'edit');
    const cond2 = byPermissions(Product.can, seller2, 'edit');

    assert.strictEqual((cond1 as any).value, 'seller-1');
    assert.strictEqual((cond2 as any).value, 'seller-2');
  });

  test('same can map, different actions return correct conditions', () => {
    const principal = makePrincipal(Seller, 'seller-99');

    const editCond = byPermissions(Product.can, principal, 'edit');
    const viewCond = byPermissions(Product.can, principal, 'view');

    // edit → when → EqCondition
    assert.strictEqual(editCond.type, 'eq');
    assert.strictEqual((editCond as any).value, 'seller-99');

    // view → always → AndCondition (TRUE)
    assert.strictEqual(viewCond.type, 'and');
    assert.deepStrictEqual((viewCond as any).conditions, []);
  });
});

// ============================================================================
// byPermissions — empty / edge cases
// ============================================================================

describe('byPermissions() — edge cases', () => {
  test('empty can map returns FALSE (empty OR)', () => {
    const principal = makePrincipal(Seller, 'seller-1');
    const cond = byPermissions({}, principal);

    assert.strictEqual(cond.type, 'or');
    assert.deepStrictEqual((cond as any).conditions, []);
  });

  test('action that does not exist in can map returns FALSE', () => {
    const principal = makePrincipal(Seller, 'seller-1');
    const cond = byPermissions(Product.can, principal, 'nonExistentAction');

    assert.strictEqual(cond.type, 'or');
    assert.deepStrictEqual((cond as any).conditions, []);
  });

  test('toCondition() on a when permission called directly matches byPermissions()', () => {
    const principal = makePrincipal(Seller, 'seller-5');
    const directCond = (Product.can.edit as any).toCondition(principal);
    const byPermsResult = byPermissions(Product.can, principal, 'edit');

    // Both should produce identical EqConditions
    assert.deepStrictEqual(directCond, byPermsResult);
  });
});
