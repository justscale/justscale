/**
 * Adversarial edge-case tests for the permission system.
 *
 * Each test pins a security property. The header states:
 *   PROPERTY: what must hold
 *   SILENT FAILURE: what bug would look like if the invariant silently broke
 *
 * Ground rules:
 *  - A permission bug is a security bug. Guards must fail closed.
 *  - Tests prefixed FIX: previously revealed live bugs that are now resolved;
 *    they remain to lock in the fix.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';

import { defineModel, field, Reference, HYDRATE, isReference } from '@justscale/core/models';
import { permit, Everyone } from '../src/index.js';
import type { Principal } from '../src/index.js';
import { AbstractPrincipalProvider } from '../src/services/principal-provider.js';

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

class Product extends defineModel({
  name: 'Product',
  fields: {
    name: field.string(),
    seller: field.ref((): any => Seller),
  },
}) {}

class Customer extends defineModel({
  name: 'Customer',
  fields: { name: field.string() },
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
    filename: field.string(),
    ticket: field.ref((): any => Ticket),
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

function resolveGuard(perm: any, principals: Principal[]): (ctx: any) => Promise<boolean> {
  const resolvedDeps: Record<string, any> = {};
  for (const [key, token] of Object.entries(perm.deps as Record<string, any>)) {
    if (token === AbstractPrincipalProvider) {
      resolvedDeps[key] = { resolve: async () => principals };
    }
  }
  return perm.factory(resolvedDeps);
}

// ============================================================================
// GROUP 1 — .when() silent-allow footguns
//
// Core security concern: .when() has an early return `true` when there is
// no Reference in params. If a route resource is exposed through some other
// channel (query/body/non-ref param), the guard will silently allow.
// ============================================================================

describe('.when() silent-allow footguns — fixed: fail closed', () => {
  test('PROPERTY: .when() with no Reference param DENIES (fail closed) — use .forCreate() for create semantics', async () => {
    // FIX: `.when()` without a resource ref used to silently allow, so routes
    // that forgot `.types({Model})` (string params) bypassed ownership checks.
    // New behaviour: deny. Create routes must declare intent via `.forCreate()`.
    const sellerRef = makeRef<any>('seller-1');
    const perm = permit(Seller).when(() => Product.fields.seller);
    const guard = resolveGuard(perm, [{ type: Seller, ref: sellerRef }]);

    assert.strictEqual(
      await guard({ params: {} }),
      false,
      '.when() with no resource ref must deny — migrate create routes to .forCreate()',
    );
  });

  test('PROPERTY: .forCreate() is the explicit create marker — allows when principal matches', async () => {
    const sellerRef = makeRef<any>('seller-1');
    const perm = permit(Seller).forCreate();
    const guard = resolveGuard(perm, [{ type: Seller, ref: sellerRef }]);
    assert.strictEqual(await guard({ params: {} }), true);
  });

  test('PROPERTY: .forCreate() denies when no principal of subject type', async () => {
    const adminRef = makeRef<any>('admin-1');
    const perm = permit(Seller).forCreate();
    const guard = resolveGuard(perm, [{ type: Admin, ref: adminRef }]);
    assert.strictEqual(await guard({ params: {} }), false);
  });

  test('PROPERTY: .forCreate() ignores params entirely — stray refs do not matter', async () => {
    const sellerRef = makeRef<any>('seller-1');
    const strayRef = makeRef<any>('seller-99');
    const perm = permit(Seller).forCreate();
    const guard = resolveGuard(perm, [{ type: Seller, ref: sellerRef }]);
    assert.strictEqual(await guard({ params: { strayRef } }), true);
  });

  test('SECURITY: .when() with a string id in params now DENIES (fail closed)', async () => {
    // FIX: strings in params are not references. Without a typed ref, there
    // is no resource to verify ownership against — deny. Route authors must
    // add `.types({Model})` to get typed params.
    const mySellerRef = makeRef<any>('seller-1');
    const guard = resolveGuard(
      permit(Seller).when(() => Product.fields.seller),
      [{ type: Seller, ref: mySellerRef }],
    );

    const allowed = await guard({ params: { productId: 'product-owned-by-seller-99' } });
    assert.strictEqual(
      allowed,
      false,
      'string params do not count as resources — route must use .types({Model}) or .forCreate()',
    );
  });

  test('SECURITY: .when() with hydrated resource whose seller field is null → deny', async () => {
    // SILENT FAILURE: if null/undefined comparison ever leaks to "equal", any
    // principal would match resources with a null seller field.
    const sellerRef = makeRef<any>('seller-1');
    const productRef = makeRef<any>('product-1', {
      name: 'Widget',
      seller: null, // orphaned product (shouldn't happen but must not be exploitable)
    });

    const guard = resolveGuard(
      permit(Seller).when(() => Product.fields.seller),
      [{ type: Seller, ref: sellerRef }],
    );

    assert.strictEqual(
      await guard({ params: { productRef } }),
      false,
      'null seller field must never match a real principal (would let anyone edit orphan products)',
    );
  });

  test('SECURITY: .when() with hydrated resource whose seller field is undefined → deny', async () => {
    const sellerRef = makeRef<any>('seller-1');
    const productRef = makeRef<any>('product-1', {
      name: 'Widget',
      // seller field absent entirely
    });

    const guard = resolveGuard(
      permit(Seller).when(() => Product.fields.seller),
      [{ type: Seller, ref: sellerRef }],
    );

    assert.strictEqual(
      await guard({ params: { productRef } }),
      false,
      'missing field must deny (undefined !== identifier)',
    );
  });

  test('SECURITY: .when() deny when resource ref resolves to undefined (row deleted)', async () => {
    // A real Reference whose resolver returns undefined simulates a deleted row.
    const sellerRef = makeRef<any>('seller-1');
    const { SET_RESOLVER } = await import('@justscale/core/models');
    const deadRef = new Reference<any>('product-gone');
    (deadRef as any)[SET_RESOLVER](async () => null); // row deleted between check and guard

    const guard = resolveGuard(
      permit(Seller).when(() => Product.fields.seller),
      [{ type: Seller, ref: sellerRef }],
    );

    assert.strictEqual(
      await guard({ params: { productRef: deadRef } }),
      false,
      'deleted resource must not fall through as allowed',
    );
  });

  test('SECURITY: .when() field value that is a plain object without identifier → deny', async () => {
    // SILENT FAILURE: if the fallback "object with identifier" path ever
    // accepted any object as a match (e.g. treating missing prop as undefined
    // equal to principal's undefined id), attackers could craft responses.
    const sellerRef = makeRef<any>('seller-1');
    const productRef = makeRef<any>('product-1', {
      name: 'Widget',
      seller: { name: 'not-a-ref-just-a-bag' } as any, // hostile object shape
    });

    const guard = resolveGuard(
      permit(Seller).when(() => Product.fields.seller),
      [{ type: Seller, ref: sellerRef }],
    );

    assert.strictEqual(
      await guard({ params: { productRef } }),
      false,
      'non-Reference, non-identifier object in field must deny',
    );
  });

  test('SECURITY: .when() field value object with matching-identifier string passes (intentional persistent-entity path)', async () => {
    // This pins the "persistent entity path" — if the field holds a loaded
    // entity (not a Reference), its .identifier is used. Pin it so we notice
    // if this path silently disappears or gets weakened.
    const sellerRef = makeRef<any>('seller-42');
    const productRef = makeRef<any>('product-1', {
      name: 'Widget',
      seller: { identifier: 'seller-42', name: 'Alice' } as any,
    });

    const guard = resolveGuard(
      permit(Seller).when(() => Product.fields.seller),
      [{ type: Seller, ref: sellerRef }],
    );

    assert.strictEqual(await guard({ params: { productRef } }), true);
  });

  test('SECURITY: .when() resource-entity-with-wrong-identifier denies', async () => {
    const sellerRef = makeRef<any>('seller-42');
    const productRef = makeRef<any>('product-1', {
      name: 'Widget',
      seller: { identifier: 'seller-99', name: 'Bob' } as any,
    });

    const guard = resolveGuard(
      permit(Seller).when(() => Product.fields.seller),
      [{ type: Seller, ref: sellerRef }],
    );

    assert.strictEqual(await guard({ params: { productRef } }), false);
  });
});

// ============================================================================
// GROUP 2 — findResourceRef picks-first ambiguity — fixed: check ALL refs
// ============================================================================

describe('guard checks every resource ref — no picks-first ambiguity', () => {
  test('SECURITY: adversarial param ordering cannot bypass ownership — ALL relevant refs checked', async () => {
    // FIX: the guard used to return after the first Reference it found in
    // insertion order. An attacker could plant a "friendly" ref earlier in
    // params to bypass checks on the real target. Now the guard checks every
    // resource ref that carries the permission's field — if any fail, deny.
    const sellerRef = makeRef<any>('seller-1');

    // "friendly" ref that the guard would allow — owned by this seller
    const friendlyRef = makeRef<any>('product-friendly', {
      name: 'Mine',
      seller: makeRef<any>('seller-1'),
    });

    // the "real" resource the route intends to protect — not owned
    const targetRef = makeRef<any>('product-target', {
      name: 'Stolen',
      seller: makeRef<any>('seller-99'),
    });

    const guard = resolveGuard(
      permit(Seller).when(() => Product.fields.seller),
      [{ type: Seller, ref: sellerRef }],
    );

    // Insertion order: friendly first, target second — must NOT bypass.
    const result = await guard({ params: { friendlyRef, targetRef } });
    assert.strictEqual(
      result,
      false,
      'adversarial param ordering must NOT bypass ownership check — every relevant ref is verified',
    );
  });

  test('SECURITY: with only the target ref, the same guard correctly denies', async () => {
    // Confirms that the vulnerability in the previous test is about ORDER,
    // not the guard itself being broken.
    const sellerRef = makeRef<any>('seller-1');
    const targetRef = makeRef<any>('product-target', {
      name: 'Stolen',
      seller: makeRef<any>('seller-99'),
    });

    const guard = resolveGuard(
      permit(Seller).when(() => Product.fields.seller),
      [{ type: Seller, ref: sellerRef }],
    );

    assert.strictEqual(await guard({ params: { targetRef } }), false);
  });
});

// ============================================================================
// GROUP 3 — .check() predicate adversarial behaviour
// ============================================================================

describe('.check() predicate adversarial cases', () => {
  test('SECURITY: sync .check() returning true allows', async () => {
    const sellerRef = makeRef<any>('seller-1');
    const perm = permit(Seller).check(() => true);
    const guard = resolveGuard(perm, [{ type: Seller, ref: sellerRef }]);
    assert.strictEqual(await guard({ params: {} }), true);
  });

  test('SECURITY: async .check() is properly awaited', async () => {
    const sellerRef = makeRef<any>('seller-1');
    let completed = false;
    const perm = permit(Seller).check(async () => {
      await new Promise((r) => setTimeout(r, 5));
      completed = true;
      return true;
    });
    const guard = resolveGuard(perm, [{ type: Seller, ref: sellerRef }]);
    const result = await guard({ params: {} });
    assert.strictEqual(completed, true, 'async predicate must be awaited');
    assert.strictEqual(result, true);
  });

  test('SECURITY: .check() predicate that throws synchronously → deny (fail closed at guard layer)', async () => {
    // FIX: predicate throws must not escape the guard — the guard catches and
    // returns false. A misbehaving predicate can never cause a 500 or leak
    // error text to the client, and it can never accidentally grant access.
    const sellerRef = makeRef<any>('seller-1');
    const perm = permit(Seller).check(() => {
      throw new Error('boom');
    });
    const guard = resolveGuard(perm, [{ type: Seller, ref: sellerRef }]);

    assert.strictEqual(
      await guard({ params: {} }),
      false,
      'predicate throw must be caught by the guard layer and return false (fail closed)',
    );
  });

  test('SECURITY: rejected-promise .check() → deny (fail closed, not a propagated rejection)', async () => {
    // FIX: async predicate rejections are also caught — no unhandled rejection,
    // no 500 leak, just a denial.
    const sellerRef = makeRef<any>('seller-1');
    const perm = permit(Seller).check(async () => {
      throw new Error('async-boom');
    });
    const guard = resolveGuard(perm, [{ type: Seller, ref: sellerRef }]);

    assert.strictEqual(await guard({ params: {} }), false, 'async predicate rejection must deny, not propagate');
  });

  test('SECURITY: predicate sees principal.ref identity — no impersonation via mutation', async () => {
    const realSellerRef = makeRef<any>('seller-real');
    let capturedId: string | undefined;
    const perm = permit(Seller).check((ref) => {
      capturedId = ref.identifier;
      // Mutating `ref.identifier` must not affect the principal-identity check
      // (there is no follow-up check; just prove the value arrives intact).
      return false;
    });
    const guard = resolveGuard(perm, [{ type: Seller, ref: realSellerRef }]);
    await guard({ params: {} });
    assert.strictEqual(capturedId, 'seller-real');
  });

  test('SECURITY: .check() denies when no principal of subject type resolved (predicate not called)', async () => {
    let called = false;
    const perm = permit(Seller).check(() => {
      called = true;
      return true;
    });
    const guard = resolveGuard(perm, []); // no principals
    const result = await guard({ params: {} });
    assert.strictEqual(result, false);
    assert.strictEqual(called, false, 'predicate must NOT run when no principal — prevents predicate side effects from leaking resource info');
  });
});

// ============================================================================
// GROUP 4 — RefTraversal adversarial cases
// ============================================================================

describe('RefTraversal — multi-hop adversarial cases', () => {
  test('SECURITY: intermediate hop is undefined → deny', async () => {
    const customerRef = makeRef<any>('customer-1');
    const attachmentRef = makeRef<any>('attachment-1', {
      filename: 'x.pdf',
      // ticket intentionally missing
    });

    const perm = permit(Customer).when(Attachment.fields.ticket.has(Ticket.fields.customer));
    const guard = resolveGuard(perm, [{ type: Customer, ref: customerRef }]);
    assert.strictEqual(await guard({ params: { attachmentRef } }), false);
  });

  test('SECURITY: intermediate hop is null → deny', async () => {
    const customerRef = makeRef<any>('customer-1');
    const attachmentRef = makeRef<any>('attachment-1', {
      filename: 'x.pdf',
      ticket: null as any,
    });

    const perm = permit(Customer).when(Attachment.fields.ticket.has(Ticket.fields.customer));
    const guard = resolveGuard(perm, [{ type: Customer, ref: customerRef }]);
    assert.strictEqual(await guard({ params: { attachmentRef } }), false);
  });

  test('SECURITY: leaf customer ref does not match principal → deny', async () => {
    const myCustomerRef = makeRef<any>('customer-1');
    const otherCustomerRef = makeRef<any>('customer-2');
    const ticketRef = makeRef<any>('ticket-1', {
      subject: 'Help',
      customer: otherCustomerRef,
    });
    const attachmentRef = makeRef<any>('attachment-1', {
      filename: 'x.pdf',
      ticket: ticketRef,
    });

    const perm = permit(Customer).when(Attachment.fields.ticket.has(Ticket.fields.customer));
    const guard = resolveGuard(perm, [{ type: Customer, ref: myCustomerRef }]);
    assert.strictEqual(await guard({ params: { attachmentRef } }), false);
  });

  test('SECURITY: leaf customer value is a plain non-ref/non-identifier object → deny', async () => {
    const customerRef = makeRef<any>('customer-1');
    const ticketRef = makeRef<any>('ticket-1', {
      subject: 'Help',
      customer: { foo: 'bar' } as any, // hostile bag
    });
    const attachmentRef = makeRef<any>('attachment-1', {
      filename: 'x.pdf',
      ticket: ticketRef,
    });

    const perm = permit(Customer).when(Attachment.fields.ticket.has(Ticket.fields.customer));
    const guard = resolveGuard(perm, [{ type: Customer, ref: customerRef }]);
    assert.strictEqual(await guard({ params: { attachmentRef } }), false);
  });

  test('SECURITY: leaf ref identifier equality holds — owner allowed', async () => {
    const customerId = 'customer-owner';
    const customerRef = makeRef<any>(customerId);
    const ticketRef = makeRef<any>('ticket-1', {
      subject: 'Help',
      customer: makeRef<any>(customerId),
    });
    const attachmentRef = makeRef<any>('attachment-1', {
      filename: 'x.pdf',
      ticket: ticketRef,
    });

    const perm = permit(Customer).when(Attachment.fields.ticket.has(Ticket.fields.customer));
    const guard = resolveGuard(perm, [{ type: Customer, ref: customerRef }]);
    assert.strictEqual(await guard({ params: { attachmentRef } }), true);
  });

  test('SECURITY: toCondition() nests HasCondition+EqCondition shape for 2-hop traversal', () => {
    const customerRef = makeRef<any>('customer-42');
    const perm = permit(Customer).when(Attachment.fields.ticket.has(Ticket.fields.customer)) as any;
    const cond = perm.toCondition({ type: Customer, ref: customerRef });

    // Shape: { type: 'has', field: 'ticket', condition: { type: 'eq', field: 'customer', value: 'customer-42' } }
    assert.strictEqual(cond.type, 'has', 'outer must be HasCondition');
    assert.strictEqual(cond.field, 'ticket');
    assert.strictEqual(cond.condition.type, 'eq', 'inner must be EqCondition');
    assert.strictEqual(cond.condition.field, 'customer');
    assert.strictEqual(cond.condition.value, 'customer-42');
  });
});

// ============================================================================
// GROUP 5 — .always() + .check() polymorphism & Everyone
// ============================================================================

describe('subclass / polymorphism edge cases', () => {
  // ES6 subclass — Admin extends base User model
  class User extends defineModel({
    name: 'User',
    fields: { email: field.string() },
  }) {}

  // Admin is a real ES6 subclass of User
  class AdminUser extends User {
    declare _admin: true;
  }

  test('SECURITY: permit(User) matches a principal of an ES6 subclass', async () => {
    // This is the "polymorphism test" from the plan. An Admin principal
    // should satisfy a permit(User) guard because AdminUser extends User.
    const adminRef = makeRef<any>('admin-1');
    const perm = permit(User).always();
    const guard = resolveGuard(perm, [{ type: AdminUser, ref: adminRef }]);
    assert.strictEqual(
      await guard({ params: {} }),
      true,
      'subclass principal must satisfy superclass permit()',
    );
  });

  test('SECURITY: permit(AdminUser) does NOT match a base User principal', async () => {
    const userRef = makeRef<any>('user-1');
    const perm = permit(AdminUser).always();
    const guard = resolveGuard(perm, [{ type: User, ref: userRef }]);
    assert.strictEqual(
      await guard({ params: {} }),
      false,
      'base-class principal must not satisfy subclass permit()',
    );
  });

  test('SECURITY: permit(Everyone).always() allows even with no app-level principals — Everyone is always injected', async () => {
    // FIX: the guard layer unconditionally injects an Everyone principal before
    // matching, so `permit(Everyone).always()` works for public routes without
    // any provider wiring. The spec promise ("always available as a candidate
    // principal") is now fulfilled at the guard layer.
    const perm = permit(Everyone).always();
    const guard = resolveGuard(perm, []);
    assert.strictEqual(
      await guard({ params: {} }),
      true,
      'permit(Everyone).always() must allow — Everyone is always contributed by the guard layer',
    );
  });
});

// ============================================================================
// GROUP 6 — Guard ordering / fail-closed integration
// ============================================================================

describe('guard fail-closed invariants', () => {
  test('SECURITY: guard denial does not invoke handler-adjacent side effects', async () => {
    // Pin: when a guard returns false it should never have triggered a
    // handler callback. We simulate with a spy passed through the guard flow.
    // The guard itself can't call the handler, but it can be wrapped —
    // this test demonstrates the expected interaction pattern and catches
    // future refactors that invert it.
    const sellerRef = makeRef<any>('seller-1');
    let handlerCalled = false;
    const handler = () => { handlerCalled = true; };

    const perm = permit(Seller).when(() => Product.fields.seller);
    const guard = resolveGuard(perm, [{ type: Seller, ref: sellerRef }]);

    // Non-matching product
    const productRef = makeRef<any>('product-1', {
      name: 'Widget',
      seller: makeRef<any>('seller-99'),
    });

    // This is the manual contract a router must obey: only call handler if guard allows.
    if (await guard({ params: { productRef } })) {
      handler();
    }
    assert.strictEqual(handlerCalled, false, 'guard denial must precede and prevent handler invocation');
  });

  test('SECURITY: array of guards — denial by all means overall denial', async () => {
    const sellerRef = makeRef<any>('seller-1');
    const productRef = makeRef<any>('product-1', {
      name: 'Widget',
      seller: makeRef<any>('other-seller'),
    });

    const guards = [
      permit(Seller).when(() => Product.fields.seller),
      permit(Admin).always(),
    ];
    const resolved = guards.map((p) => resolveGuard(p, [{ type: Seller, ref: sellerRef }]));

    let allowed = false;
    for (const g of resolved) {
      if (await g({ params: { productRef } })) {
        allowed = true;
        break;
      }
    }
    assert.strictEqual(allowed, false, 'neither rule should match → overall deny');
  });

  test('SECURITY: array of guards — second rule matches → allow (OR semantics)', async () => {
    const adminRef = makeRef<any>('admin-1');
    const productRef = makeRef<any>('product-1', {
      name: 'Widget',
      seller: makeRef<any>('other-seller'),
    });

    const guards = [
      permit(Seller).when(() => Product.fields.seller),
      permit(Admin).always(),
    ];
    const resolved = guards.map((p) => resolveGuard(p, [{ type: Admin, ref: adminRef }]));

    let allowed = false;
    for (const g of resolved) {
      if (await g({ params: { productRef } })) {
        allowed = true;
        break;
      }
    }
    assert.strictEqual(allowed, true, 'Admin always() must allow even if Seller.when() check fails');
  });

  test('SECURITY: no principal, no param → array of guards denies', async () => {
    const guards = [
      permit(Seller).always(),
      permit(Admin).always(),
    ];
    const resolved = guards.map((p) => resolveGuard(p, [])); // empty principal list

    let allowed = false;
    for (const g of resolved) {
      if (await g({ params: {} })) {
        allowed = true;
        break;
      }
    }
    assert.strictEqual(allowed, false, 'no principals → all guards deny → overall deny');
  });
});

// ============================================================================
// GROUP 7 — Reference identifier equality is the trust boundary
// ============================================================================

describe('Reference identifier equality — the trust boundary', () => {
  test('SECURITY: two Reference instances with same id are treated as equal', async () => {
    // Identifier equality — not object identity — is the trust boundary.
    // SILENT FAILURE: if a future refactor switches to object-identity
    // comparison, guards would deny legitimate requests.
    const sellerRefA = makeRef<any>('seller-1'); // principal
    const sellerRefB = makeRef<any>('seller-1'); // field value (same id, different object)

    const productRef = makeRef<any>('product-1', {
      name: 'Widget',
      seller: sellerRefB,
    });

    const guard = resolveGuard(
      permit(Seller).when(() => Product.fields.seller),
      [{ type: Seller, ref: sellerRefA }],
    );

    assert.strictEqual(
      await guard({ params: { productRef } }),
      true,
      'id equality across Reference instances is the trust boundary — object identity must NOT be used',
    );
    // Sanity: prove they aren't the same object.
    assert.notStrictEqual(sellerRefA, sellerRefB);
    assert.ok(isReference(sellerRefA) && isReference(sellerRefB));
  });

  test('SECURITY: identifier comparison is strict (===) — "seller-1" !== "SELLER-1"', async () => {
    const principalRef = makeRef<any>('seller-1');
    const fieldRef = makeRef<any>('SELLER-1'); // case-different id
    const productRef = makeRef<any>('product-1', {
      name: 'Widget',
      seller: fieldRef,
    });

    const guard = resolveGuard(
      permit(Seller).when(() => Product.fields.seller),
      [{ type: Seller, ref: principalRef }],
    );

    assert.strictEqual(
      await guard({ params: { productRef } }),
      false,
      'id comparison is strict — no case folding, no normalization',
    );
  });

  test('SECURITY: identifier compared as string via persistent-entity path ("1" !== 1)', async () => {
    // Type coercion on identifiers would be a disaster.
    // The persistent-entity path checks `fieldValue.identifier === principal.ref.identifier`
    // — a strict compare. This test pins that even a numeric identifier on a
    // persistent-shaped object does NOT match a string principal id.
    const principalRef = makeRef<any>('1');
    const productRef = makeRef<any>('product-1', {
      name: 'Widget',
      // Persistent-entity-shaped object with numeric identifier
      seller: { identifier: 1 as any, name: 'Impostor' } as any,
    });

    const guard = resolveGuard(
      permit(Seller).when(() => Product.fields.seller),
      [{ type: Seller, ref: principalRef }],
    );

    assert.strictEqual(
      await guard({ params: { productRef } }),
      false,
      'strict === prevents numeric-vs-string identifier coercion',
    );
  });
});
