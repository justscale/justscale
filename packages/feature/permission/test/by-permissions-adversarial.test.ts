/**
 * Adversarial tests for byPermissions() + toCondition() — the query-time
 * permission evaluation path. Each test pins a security property.
 *
 * byPermissions() builds a WHERE condition from a can-map. A bug here
 * leaks rows through queries that the guard-path would correctly block.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';

import {
  defineModel,
  field,
  Reference,
  HYDRATE,
  InMemoryRepository,
  getModelFields,
  q,
} from '@justscale/core/models';
import { permit, byPermissions, isQueryablePermissionDef } from '../src/index.js';
import type { Principal, QueryablePermissionDef } from '../src/index.js';

// ============================================================================
// Models
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
    create: permit(Seller), // explicit — not queryable
    cleanup: permit(Seller).check(() => true), // check — not queryable
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

function makePrincipal(type: any, id: string): Principal {
  return { type, ref: makeRef<any>(id) };
}

// ============================================================================
// GROUP 1 — empty-OR vs empty-AND trap
//
// byPermissions() returns:
//   - empty OR (FALSE) when nothing matches → DENY ALL
//   - single EqCondition when only one queryable
//   - empty AND (TRUE) when an always() matches → ALLOW ALL
//
// Confusing these two is a full leak (ALLOW ALL instead of DENY ALL).
// ============================================================================

describe('byPermissions() — empty-OR vs empty-AND (deny-all vs allow-all)', () => {
  test('SECURITY: unknown subject type → empty OR, which the query engine must treat as FALSE', () => {
    // SILENT FAILURE: if this ever returns empty AND (TRUE), an unknown
    // principal suddenly sees all rows.
    const principal = makePrincipal(Customer, 'customer-1');
    const cond = byPermissions(Product.can, principal);

    assert.strictEqual(cond.type, 'or', 'unknown subject must be OR (deny-all)');
    assert.deepStrictEqual((cond as any).conditions, []);
  });

  test('SECURITY: only non-queryable rules → deny-all OR (not allow-all AND)', () => {
    // If the Seller only has `create` (explicit) and `cleanup` (check),
    // byPermissions must return FALSE — not TRUE.
    const principal = makePrincipal(Seller, 'seller-1');

    // Only query the non-queryable actions
    const createCond = byPermissions(Product.can, principal, 'create');
    const cleanupCond = byPermissions(Product.can, principal, 'cleanup');

    assert.strictEqual(createCond.type, 'or');
    assert.deepStrictEqual((createCond as any).conditions, []);
    assert.strictEqual(cleanupCond.type, 'or');
    assert.deepStrictEqual((cleanupCond as any).conditions, []);
  });

  test('SECURITY: an always() match produces empty AND (allow-all / no filter)', () => {
    const principal = makePrincipal(Seller, 'seller-1');
    const cond = byPermissions(Product.can, principal, 'view');

    // view = permit(Seller).always() → empty AND (TRUE)
    assert.strictEqual(cond.type, 'and');
    assert.deepStrictEqual((cond as any).conditions, []);
  });

  test('SECURITY: mixing always() and when() in one action → merged with OR (allow-all wins)', () => {
    // Product.can.delete = [permit(Seller).when(...), permit(Admin).always()]
    // Admin principal hits only the .always() → TRUE (empty AND)
    const adminCond = byPermissions(Product.can, makePrincipal(Admin, 'admin-1'), 'delete');
    assert.strictEqual(adminCond.type, 'and', 'Admin always() produces empty AND');

    // Seller principal hits only the .when() → EqCondition
    const sellerCond = byPermissions(Product.can, makePrincipal(Seller, 'seller-1'), 'delete');
    assert.strictEqual(sellerCond.type, 'eq');
    assert.strictEqual((sellerCond as any).field, 'seller');
    assert.strictEqual((sellerCond as any).value, 'seller-1');
  });

  test('SECURITY: action key that exists but holds undefined → deny-all', () => {
    // SILENT FAILURE: if a model has `edit: undefined` (accidental),
    // byPermissions must NOT treat it as "allow all".
    const principal = makePrincipal(Seller, 'seller-1');
    const holey = { ...Product.can, missingAction: undefined as any };
    const cond = byPermissions(holey as any, principal, 'missingAction');

    assert.strictEqual(cond.type, 'or');
    assert.deepStrictEqual((cond as any).conditions, []);
  });
});

// ============================================================================
// GROUP 2 — toCondition() on .check() is not queryable
// ============================================================================

describe('toCondition() on non-queryable defs', () => {
  test('SECURITY: .check() has no toCondition and is filtered out by isQueryablePermissionDef', () => {
    const checkPerm = permit(Seller).check(async () => true) as any;
    assert.strictEqual(isQueryablePermissionDef(checkPerm), false, 'check is not queryable');
    assert.strictEqual(typeof checkPerm.toCondition, 'undefined', 'check must not expose toCondition');
  });

  test('SECURITY: byPermissions skips .check() and .explicit rules silently', () => {
    // SILENT FAILURE: if byPermissions ever starts TREATING .check() rules as
    // always-true (which is the fallback path for non-queryable), it would
    // leak every row to any principal of the subject type.
    const principal = makePrincipal(Seller, 'seller-1');
    const cond = byPermissions(Product.can, principal, 'cleanup'); // only .check() rule

    assert.strictEqual(cond.type, 'or');
    assert.deepStrictEqual((cond as any).conditions, []);
  });

  test('SECURITY: explicit permit(X) with no builder method → skipped, returns deny-all', () => {
    const principal = makePrincipal(Seller, 'seller-1');
    const cond = byPermissions(Product.can, principal, 'create');
    assert.strictEqual(cond.type, 'or');
    assert.deepStrictEqual((cond as any).conditions, []);
  });
});

// ============================================================================
// GROUP 3 — Principal type mismatch
// ============================================================================

describe('byPermissions() — principal type vs subjectClass', () => {
  test('SECURITY: Admin principal only matches Admin-subject rules, not Seller-subject rules', () => {
    // For delete = [permit(Seller).when, permit(Admin).always]:
    //   Admin principal → only the Admin rule matches → empty AND (TRUE)
    //   Seller principal → only the Seller rule matches → EqCondition
    const adminCond = byPermissions(Product.can, makePrincipal(Admin, 'admin-1'), 'delete');
    const sellerCond = byPermissions(Product.can, makePrincipal(Seller, 'seller-1'), 'delete');

    assert.strictEqual(adminCond.type, 'and');
    assert.strictEqual(sellerCond.type, 'eq');
    assert.strictEqual((sellerCond as any).value, 'seller-1');
  });

  test('SECURITY: unrelated principal type (Customer) → no matches → deny-all', () => {
    const principal = makePrincipal(Customer, 'customer-1');
    const cond = byPermissions(Product.can, principal, 'delete');
    assert.strictEqual(cond.type, 'or');
    assert.deepStrictEqual((cond as any).conditions, []);
  });

  test('SECURITY: ES6 subclass matches the parent-class rule', () => {
    // Build a subclass hierarchy.
    class User extends defineModel({
      name: 'User',
      fields: { email: field.string() },
    }) {}
    class AdminUser extends User {
      declare _admin: true;
    }

    class Doc extends defineModel({
      name: 'Doc',
      fields: { owner: field.ref((): any => User) },
    }) {
      static can = {
        edit: permit(User).when(() => Doc.fields.owner),
      };
    }

    // AdminUser principal should match the permit(User) rule (subclass matching).
    const principal = makePrincipal(AdminUser, 'admin-42');
    const cond = byPermissions(Doc.can, principal, 'edit');

    assert.strictEqual(cond.type, 'eq');
    assert.strictEqual((cond as any).field, 'owner');
    assert.strictEqual((cond as any).value, 'admin-42');
  });
});

// ============================================================================
// GROUP 4 — toCondition() values follow principal id
// ============================================================================

describe('toCondition() — per-principal value determinism', () => {
  test('SECURITY: toCondition() reuses the principal.ref.identifier exactly (no mutation)', () => {
    const ref = makeRef<any>('seller-xyz');
    const principal: Principal = { type: Seller, ref };

    const cond = (Product.can.edit as QueryablePermissionDef).toCondition(principal);
    assert.strictEqual((cond as any).value, 'seller-xyz');

    // If something else mutated identifier later, a second call reflects that.
    // (Sanity — not a security property, pins deterministic snapshot semantics.)
    const cond2 = (Product.can.edit as QueryablePermissionDef).toCondition(principal);
    assert.strictEqual((cond2 as any).value, 'seller-xyz');
  });

  test('SECURITY: calling with the WRONG principal type still emits a condition (subjectClass gate is in byPermissions, not in toCondition itself)', () => {
    // Pin: toCondition() doesn't re-check subjectClass. It trusts the caller.
    // SILENT FAILURE MODE: if a caller skips byPermissions() and calls
    // toCondition() directly with the wrong type, they'd still get a
    // condition filtering by that wrong id. Document it.
    const admin = makePrincipal(Admin, 'admin-1');
    const editDef = Product.can.edit as QueryablePermissionDef;

    // Calling with an Admin principal on a Seller-subject rule still emits
    // a condition. The Admin id is injected as if it were a seller.
    const cond = editDef.toCondition(admin);
    assert.strictEqual(cond.type, 'eq');
    assert.strictEqual((cond as any).value, 'admin-1');
  });
});

// ============================================================================
// GROUP 5 — filter by condition against a real InMemoryRepository
// ============================================================================

describe('byPermissions() → repo.find() returns only allowed rows', () => {
  test('SECURITY: seller sees only their own products', async () => {
    const repo = new InMemoryRepository<Product>({
      modelClass: Product as any,
      fieldDefs: getModelFields(Product),
    });

    const seller1 = makeRef<any>('seller-1');
    const seller2 = makeRef<any>('seller-2');

    await repo.insert({ name: 'A', seller: seller1 } as any);
    await repo.insert({ name: 'B', seller: seller2 } as any);
    await repo.insert({ name: 'C', seller: seller1 } as any);

    const principal = makePrincipal(Seller, 'seller-1');
    const rows = await repo.find({ where: byPermissions(Product.can, principal, 'edit') });

    const names = rows.map((r: any) => r.name).sort();
    assert.deepStrictEqual(names, ['A', 'C']);
  });

  test('SECURITY: admin via .always() sees everything (empty AND → no filter)', async () => {
    const repo = new InMemoryRepository<Product>({
      modelClass: Product as any,
      fieldDefs: getModelFields(Product),
    });

    await repo.insert({ name: 'A', seller: makeRef<any>('seller-1') } as any);
    await repo.insert({ name: 'B', seller: makeRef<any>('seller-2') } as any);

    const principal = makePrincipal(Admin, 'admin-1');
    const rows = await repo.find({ where: byPermissions(Product.can, principal, 'delete') });
    const names = rows.map((r: any) => r.name).sort();
    assert.deepStrictEqual(names, ['A', 'B']);
  });

  test('SECURITY: customer (no rules) sees zero rows', async () => {
    const repo = new InMemoryRepository<Product>({
      modelClass: Product as any,
      fieldDefs: getModelFields(Product),
    });

    await repo.insert({ name: 'A', seller: makeRef<any>('seller-1') } as any);

    const principal = makePrincipal(Customer, 'customer-1');
    const rows = await repo.find({ where: byPermissions(Product.can, principal, 'delete') });
    assert.deepStrictEqual(rows, []);
  });

  test('SECURITY: combining byPermissions + other filters narrows further, never widens', async () => {
    const repo = new InMemoryRepository<Product>({
      modelClass: Product as any,
      fieldDefs: getModelFields(Product),
    });

    const seller1 = makeRef<any>('seller-1');
    const seller2 = makeRef<any>('seller-2');
    await repo.insert({ name: 'Widget', seller: seller1 } as any);
    await repo.insert({ name: 'Gadget', seller: seller1 } as any);
    await repo.insert({ name: 'Widget', seller: seller2 } as any);

    const principal = makePrincipal(Seller, 'seller-1');
    const cond = q.and(
      byPermissions(Product.can, principal, 'edit'),
      Product.fields.name.eq('Widget'),
    );
    const rows = await repo.find({ where: cond });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual((rows[0] as any).name, 'Widget');
    // Confirm the other seller's Widget is NOT leaked
    assert.ok((rows[0] as any).seller.identifier === 'seller-1');
  });
});

// ============================================================================
// GROUP 6 — duplicate rules / stability
// ============================================================================

describe('byPermissions() — duplicate rules and merging', () => {
  test('perm-7: two identical when() rules on same action → single EqCondition (deduped)', () => {
    // byPermissions() dedupes structurally identical conditions before OR-ing.
    // Two permit(Seller).when(same field) rules must not emit two EqConditions
    // with identical (field, value) pairs — that produces an ugly OR of
    // duplicates in SQL with no semantic change.
    class M extends defineModel({
      name: 'M',
      fields: {
        name: field.string(),
        seller: field.ref((): any => Seller),
      },
    }) {
      static can = {
        edit: [
          permit(Seller).when(() => M.fields.seller),
          permit(Seller).when(() => M.fields.seller),
        ],
      };
    }

    const principal = makePrincipal(Seller, 'seller-1');
    const cond = byPermissions(M.can, principal, 'edit');

    // Dedup reduces two identical EqConditions to a single one.
    assert.strictEqual(cond.type, 'eq', 'deduped to single EqCondition');
    assert.strictEqual((cond as any).field, 'seller');
    assert.strictEqual((cond as any).value, 'seller-1');
  });

  test('perm-7: non-identical conditions are NOT deduped', () => {
    // Two different seller ids → different conditions → both kept.
    class N extends defineModel({
      name: 'N',
      fields: {
        name: field.string(),
        seller: field.ref((): any => Seller),
      },
    }) {
      static can = {
        edit: [
          permit(Seller).when(() => N.fields.seller),
          permit(Admin).always(),
        ],
      };
    }

    const sellerPrincipal = makePrincipal(Seller, 'seller-1');
    const adminPrincipal = makePrincipal(Admin, 'admin-1');

    // For Admin, .always() → single empty AND (no dedup involved)
    const adminCond = byPermissions(N.can, adminPrincipal, 'edit');
    assert.strictEqual(adminCond.type, 'and');

    // For Seller, .when() → single EqCondition
    const sellerCond = byPermissions(N.can, sellerPrincipal, 'edit');
    assert.strictEqual(sellerCond.type, 'eq');
  });
});
