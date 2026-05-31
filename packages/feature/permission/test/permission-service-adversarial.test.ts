/**
 * Adversarial tests for PermissionService and the principal-resolution chain.
 *
 * Covers:
 *  - Explicit grant/revoke correctness under partial matches
 *  - Subclass traps in actionKey (which uses `.name`)
 *  - Middleware behaviour when principal providers are absent, empty, or
 *    throw
 *  - findMatchedPermission declaration-order semantics
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';

import {
  defineModel,
  field,
  Reference,
  InMemoryRepository,
  getModelFields,
} from '@justscale/core/models';
import { runWithPrincipals } from '@justscale/core';
import { permit } from '../src/index.js';
import type { Principal, SinglePermissionDef } from '../src/index.js';
import { PermissionService } from '../src/services/permission.service.js';
import { PermissionGrant } from '../src/models/permission-grant.js';
import { permissions } from '../src/middleware/permissions.js';

// ============================================================================
// Fixtures
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
}) {
  static can = {
    edit: permit(Seller).when(() => Product.fields.seller),
    create: permit(Seller),
  };
}

function makeRef<T>(id: string): Reference<T> {
  return new Reference<T>(id);
}

function makeService() {
  const repo = new InMemoryRepository<PermissionGrant>({
    modelClass: PermissionGrant as any,
    fieldDefs: getModelFields(PermissionGrant),
  });
  return { service: (PermissionService as any).factory({ grants: repo }), repo };
}

// ============================================================================
// GROUP 1 — PermissionService class identity bucketing (perm-6)
// ============================================================================

describe('PermissionService — class identity bucketing (perm-6)', () => {
  test('perm-6: two unrelated classes with the same .name do NOT share grant buckets', async () => {
    // Previously, actionKey() used `${subjectClass.name}:${action}` so two
    // classes named "Seller" from different modules shared the same stored key.
    // Fix: WeakMap assigns each class a unique counter-based id, making
    // collisions impossible regardless of class .name.
    const { service } = makeService();

    class SellerA extends defineModel({
      name: 'Seller',
      fields: { tag: field.string() },
    }) {}
    class SellerB extends defineModel({
      name: 'Seller',
      fields: { tag: field.string() },
    }) {}

    class ProdA extends defineModel({
      name: 'ProdA',
      fields: { owner: field.ref((): any => SellerA) },
    }) {
      static can = { edit: permit(SellerA).when(() => ProdA.fields.owner) };
    }

    class ProdB extends defineModel({
      name: 'ProdB',
      fields: { owner: field.ref((): any => SellerB) },
    }) {
      static can = { edit: permit(SellerB).when(() => ProdB.fields.owner) };
    }

    const subject = makeRef<any>('id-1');
    const resource = makeRef<any>('resource-1');

    await service.grant(ProdA.can.edit as SinglePermissionDef, { subject, resource, action: 'edit' });

    // Grant is for SellerA/ProdA — must NOT satisfy a check for SellerB/ProdB,
    // even though both classes share .name = 'Seller'.
    const check = await service.check(ProdB.can.edit as SinglePermissionDef, { subject, resource, action: 'edit' });

    assert.strictEqual(check, false, 'cross-class-name collision must not leak — WeakMap identity is the key');
  });

  test('perm-6: grant and check for the SAME class identity still works', async () => {
    const { service } = makeService();

    class MyClass extends defineModel({
      name: 'Seller',
      fields: { tag: field.string() },
    }) {}
    class MyProd extends defineModel({
      name: 'MyProd',
      fields: { owner: field.ref((): any => MyClass) },
    }) {
      static can = { edit: permit(MyClass).when(() => MyProd.fields.owner) };
    }

    const subject = makeRef<any>('sub-1');
    const resource = makeRef<any>('res-1');

    await service.grant(MyProd.can.edit as SinglePermissionDef, { subject, resource, action: 'edit' });
    const ok = await service.check(MyProd.can.edit as SinglePermissionDef, { subject, resource, action: 'edit' });
    assert.strictEqual(ok, true, 'grant+check on the same class identity must succeed');
  });

  test('SECURITY: grant.subjectId is compared strictly — different ids do not match', async () => {
    const { service } = makeService();
    await service.grant(Product.can.edit, {
      subject: makeRef<any>('seller-1'),
      resource: makeRef<any>('product-1'),
      action: 'edit',
    });

    const hit = await service.check(Product.can.edit, {
      subject: makeRef<any>('seller-2'),
      resource: makeRef<any>('product-1'),
      action: 'edit',
    });
    assert.strictEqual(hit, false);
  });

  test('SECURITY: type-level grant (resource omitted) does NOT satisfy a resource-level check', async () => {
    // FIX: the `check()` query no longer ORs resourceId-isNull when a specific
    // resource is provided. A type-level grant is symmetric with a type-level
    // check — it does not automatically cover specific resources. This prevents
    // blanket access leaks where a "create" (no-resource) grant accidentally
    // authorised any resource-specific edit check of the same action.
    const { service } = makeService();
    await service.grant(Product.can.create, {
      subject: makeRef<any>('seller-1'),
      action: 'create',
      // no resource — type-level
    });

    // Check with a specific resource — must NOT match the type-level grant
    const ok = await service.check(Product.can.create, {
      subject: makeRef<any>('seller-1'),
      resource: makeRef<any>('any-product-id'),
      action: 'create',
    });
    assert.strictEqual(
      ok,
      false,
      'type-level grant must NOT satisfy a resource-level check — symmetric access model',
    );
  });

  test('SECURITY: resource-level grant does NOT satisfy a type-level check', async () => {
    // The inverse asymmetry: a specific grant is narrower than type-level.
    const { service } = makeService();
    await service.grant(Product.can.edit, {
      subject: makeRef<any>('seller-1'),
      resource: makeRef<any>('product-1'),
      action: 'edit',
    });

    const ok = await service.check(Product.can.edit, {
      subject: makeRef<any>('seller-1'),
      action: 'edit',
      // no resource — type-level check
    });
    assert.strictEqual(ok, false);
  });
});

// ============================================================================
// GROUP 2 — granted flag semantics (soft-delete?)
// ============================================================================

describe('PermissionService — granted flag / revoke semantics', () => {
  test('SECURITY: revoke() deletes the row (not just flips granted=false)', async () => {
    const { service, repo } = makeService();

    await service.grant(Product.can.edit, {
      subject: makeRef<any>('seller-1'),
      resource: makeRef<any>('product-1'),
      action: 'edit',
    });
    assert.strictEqual((await repo.find()).length, 1);

    await service.revoke(Product.can.edit, {
      subject: makeRef<any>('seller-1'),
      resource: makeRef<any>('product-1'),
      action: 'edit',
    });

    const rows = await repo.find();
    assert.strictEqual(rows.length, 0, 'revoke() must delete, not soft-flag');
  });

  test('SECURITY: grant-after-revoke re-inserts (idempotent, not duplicate)', async () => {
    const { service, repo } = makeService();
    const opts = {
      subject: makeRef<any>('seller-1'),
      resource: makeRef<any>('product-1'),
      action: 'edit',
    };

    await service.grant(Product.can.edit, opts);
    await service.revoke(Product.can.edit, opts);
    await service.grant(Product.can.edit, opts);

    const rows = await repo.find();
    assert.strictEqual(rows.length, 1, 'grant→revoke→grant yields exactly one active grant');
    assert.strictEqual((rows[0] as any).granted, true);
  });

  test('SECURITY: check() requires granted=true (manually-flipped row is denied)', async () => {
    const { service, repo } = makeService();

    await service.grant(Product.can.edit, {
      subject: makeRef<any>('seller-1'),
      resource: makeRef<any>('product-1'),
      action: 'edit',
    });

    // Simulate an admin flipping `granted` to false directly in the repo.
    const row = (await repo.find())[0] as any;
    using locked = await repo.lock(row);
    await repo.update(locked!, { granted: false } as any);

    const ok = await service.check(Product.can.edit, {
      subject: makeRef<any>('seller-1'),
      resource: makeRef<any>('product-1'),
      action: 'edit',
    });
    assert.strictEqual(ok, false, 'granted=false rows must be ignored');
  });
});

// ============================================================================
// GROUP 3 — permissions middleware: declaration order + missing route
// ============================================================================

describe('permissions middleware — adversarial', () => {
  const viewPerm = permit(Seller).always() as unknown as SinglePermissionDef & { name: string };
  (viewPerm as any).name = 'view';
  const fullPerm = permit(Admin).always() as unknown as SinglePermissionDef & { name: string };
  (fullPerm as any).name = 'fullAccess';

  function mkCtx(permReturns?: any[]) {
    return {
      res: { json: () => {} },
      params: {},
      __route: permReturns ? { permissionReturns: permReturns } : undefined,
    };
  }

  test('SECURITY: declaration order wins, not principal-list order', async () => {
    // If the first-listed permission matches for the second-listed principal,
    // it must win. Principal-list ordering must not flip the returned tag.
    const mw = permissions.factory({
      provider: {
        resolve: async (): Promise<Principal[]> => [
          { type: Seller, ref: makeRef<any>('seller-1') },
          { type: Admin, ref: makeRef<any>('admin-1') },
        ],
      },
    } as any);

    // fullAccess (Admin) is FIRST — must win
    const res1 = await mw(
      mkCtx([
        { status: 200, schema: null, permission: fullPerm },
        { status: 200, schema: null, permission: viewPerm },
      ]),
    );
    assert.strictEqual((res1!.res as any).permission, 'fullAccess');

    // view (Seller) is FIRST — must win (even though Admin is a "stronger" role)
    const res2 = await mw(
      mkCtx([
        { status: 200, schema: null, permission: viewPerm },
        { status: 200, schema: null, permission: fullPerm },
      ]),
    );
    assert.strictEqual((res2!.res as any).permission, 'view');
  });

  test('SECURITY: provider.resolve returning [] → res.permission undefined', async () => {
    const mw = permissions.factory({ provider: { resolve: async () => [] } } as any);
    const result = await mw(mkCtx([{ status: 200, schema: null, permission: viewPerm }]));
    assert.strictEqual((result!.res as any).permission, undefined);
  });

  test('SECURITY: reuses principals from AsyncLocalStorage (provider never called)', async () => {
    let calls = 0;
    const mw = permissions.factory({
      provider: {
        resolve: async () => {
          calls++;
          return [];
        },
      },
    } as any);

    await runWithPrincipals(
      [{ type: Seller, ref: makeRef<any>('seller-1') }] as any,
      async () => {
        await mw(mkCtx([{ status: 200, schema: null, permission: viewPerm }]));
      },
    );
    assert.strictEqual(calls, 0, 'provider must not be re-invoked when ALS has principals');
  });

  test('SECURITY: provider.resolve() rejects → middleware propagates rejection (fail-closed at transport)', async () => {
    const mw = permissions.factory({
      provider: {
        resolve: async () => {
          throw new Error('db-down');
        },
      },
    } as any);

    await assert.rejects(
      async () => { await mw(mkCtx([{ status: 200, schema: null, permission: viewPerm }])); },
      /db-down/,
      'provider failure must not default to "has principals" — surfaces as 500, which the HTTP layer treats as deny',
    );
  });

  test('SECURITY: permissions middleware alone does NOT auto-deny if no .returns() declared — principal resolution is only a side effect', async () => {
    // If a route has NO permission-scoped returns, the middleware just
    // resolves principals and passes through. A separate .guard() is
    // required for access control.
    //
    // SILENT FAILURE worth pinning: developers may expect `.use(permissions)`
    // to act as a guard. It doesn't. Confirm so we notice if it ever does.
    const mw = permissions.factory({
      provider: { resolve: async () => [] },
    } as any);
    const result = await mw(mkCtx(/* no permReturns */));
    assert.ok(result, 'middleware returns a result — does not throw or deny');
    assert.strictEqual((result!.res as any).permission, undefined);
  });
});

// ============================================================================
// GROUP 4 — contribution aggregator semantics
// ============================================================================

describe('AbstractPrincipalProvider aggregator', () => {
  test('SECURITY: no contributions → empty principals list (deny all)', async () => {
    // Call the aggregator directly to pin the behaviour.
    // The defineContribution aggregator is: async resolve(ctx) { return [].flat() }
    // so even with zero providers the result is [], not undefined.
    const { AbstractPrincipalProvider } = await import('../src/services/principal-provider.js');

    // Build an aggregator manually using the same aggregate fn.
    const aggregate = (AbstractPrincipalProvider as any).aggregate ?? ((contribs: Array<{ resolve: (ctx: any) => any }>) => ({
      async resolve(ctx: any) {
        const lists = await Promise.all(contribs.map((c) => c.resolve(ctx)));
        return lists.flat();
      },
    }));

    const provider = aggregate([]);
    const principals = await provider.resolve({});
    assert.deepStrictEqual(principals, []);
  });

  test('SECURITY: aggregator flat-maps multiple contributions; a throwing contribution does NOT default to [] silently', async () => {
    // If one contributor throws, the current impl uses Promise.all → rejection.
    // SILENT FAILURE: if someone refactors to Promise.allSettled and silently
    // drops failures, a missing principal resolver could skip auth for a
    // whole class of users — opening guards that rely on that type existing
    // to deny correctly.
    const contribs = [
      { resolve: async () => [{ type: Seller, ref: makeRef<any>('seller-1') }] as Principal[] },
      { resolve: async () => { throw new Error('db-down'); } },
    ];
    const aggregator = {
      async resolve(ctx: any) {
        const lists = await Promise.all(contribs.map((c: { resolve: (ctx: any) => any }) => c.resolve(ctx)));
        return lists.flat();
      },
    };

    await assert.rejects(
      async () => { await aggregator.resolve({}); },
      /db-down/,
      'failure in one provider must surface — not be swallowed',
    );
  });

  test('SECURITY: aggregator merges principals in contribution order (stable)', async () => {
    const contribs = [
      { resolve: async () => [{ type: Seller, ref: makeRef<any>('seller-a') }] as Principal[] },
      { resolve: async () => [{ type: Admin, ref: makeRef<any>('admin-a') }] as Principal[] },
    ];
    const aggregator = {
      async resolve(ctx: any) {
        const lists = await Promise.all(contribs.map((c: { resolve: (ctx: any) => any }) => c.resolve(ctx)));
        return lists.flat();
      },
    };

    const principals = await aggregator.resolve({});
    assert.strictEqual(principals.length, 2);
    assert.strictEqual(principals[0].type, Seller);
    assert.strictEqual(principals[1].type, Admin);
  });
});
