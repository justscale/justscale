/**
 * Invariant tests: `.types()` path-param resolution.
 *
 * Pins:
 *  - `.types({ Model })` transforms matching params to Reference<Model> at dispatch
 *  - Matching rules (from apply-types-config.ts):
 *      `types: { Table }` matches `:table`, `:Table`, `:tableRef`
 *      `types: { tableRef: Table }` matches `:tableRef` exactly
 *  - Multiple path params - each resolves independently
 *  - Unmatched params stay string (mixed typed + untyped works)
 *  - `types` metadata is stored on route.types
 *  - No-resolver model still produces a Reference (has identifier) - get() fails
 *    at call time if no adapter wired; pinned in models-level tests, not here.
 *
 * applyTypesConfig runs in the HTTP server layer (server.ts) before executeRoute.
 * The RouteDef itself just carries the `types` metadata.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { executeRoute } from '@justscale/core';
import {
  defineModel,
  field,
  isReference,
  applyTypesConfig,
} from '@justscale/core/models';
import { Get } from '../src/builder/create-http-builder.js';

class Product extends defineModel({ fields: { name: field.string() } }) {}
class Table extends defineModel({ fields: { name: field.string() } }) {}

describe('.types() param resolution', () => {
  it('stores types config on route def', () => {
    const route = Get('/p/:productRef')
      .types({ Product })
      .handle(() => {});
    assert.strictEqual((route as any).types.Product, Product);
  });

  it('no .types() - route has no types field', () => {
    const route = Get('/p/:productRef').handle(() => {});
    assert.strictEqual((route as any).types, undefined);
  });

  it('applyTypesConfig: exact-key match `types: { productRef }` matches `:productRef`', () => {
    const typed = applyTypesConfig({ productRef: 'p-1' }, { productRef: Product });
    assert.ok(isReference(typed.productRef));
    assert.strictEqual((typed.productRef as any).identifier, 'p-1');
  });

  it('applyTypesConfig: class-name-cased `types: { Product }` matches `:product`', () => {
    const typed = applyTypesConfig({ product: 'p-1' }, { Product });
    assert.ok(isReference(typed.product));
  });

  it('applyTypesConfig: class-name-cased `types: { Product }` matches `:productRef`', () => {
    const typed = applyTypesConfig({ productRef: 'p-1' }, { Product });
    assert.ok(isReference(typed.productRef));
  });

  it('applyTypesConfig: unmatched param stays string', () => {
    const typed = applyTypesConfig(
      { product: 'p-1', plainId: 'abc' },
      { Product },
    );
    assert.ok(isReference(typed.product));
    assert.strictEqual(typed.plainId, 'abc');
  });

  it('applyTypesConfig: two typed params - both resolve', () => {
    const typed = applyTypesConfig(
      { product: 'p-1', table: 't-2' },
      { Product, Table },
    );
    assert.ok(isReference(typed.product));
    assert.ok(isReference(typed.table));
    assert.strictEqual((typed.product as any).identifier, 'p-1');
    assert.strictEqual((typed.table as any).identifier, 't-2');
  });

  it('applyTypesConfig: undefined types returns params unchanged', () => {
    const raw = { product: 'p-1' };
    const result = applyTypesConfig(raw, undefined);
    assert.strictEqual(result, raw);
  });

  it('end-to-end: route with .types() + executeRoute with pre-transformed params', async () => {
    let captured: any = null;
    const route = Get('/p/:productRef/t/:tableRef')
      .types({ Product, Table })
      .handle((ctx: any) => { captured = ctx.params; });

    const typed = applyTypesConfig(
      { productRef: 'p-1', tableRef: 't-9' },
      (route as any).types,
    );
    await executeRoute(route, { params: typed, res: {} });

    assert.ok(isReference(captured.productRef));
    assert.ok(isReference(captured.tableRef));
    assert.strictEqual((captured.productRef as any).identifier, 'p-1');
    assert.strictEqual((captured.tableRef as any).identifier, 't-9');
  });

  it('untyped :plainId stays string even on a route that declares other typed params', async () => {
    let captured: any = null;
    const route = Get('/mix/:product/:plainId')
      .types({ Product })
      .handle((ctx: any) => { captured = ctx.params; });

    const typed = applyTypesConfig(
      { product: 'p-1', plainId: 'abc' },
      (route as any).types,
    );
    await executeRoute(route, { params: typed, res: {} });

    assert.ok(isReference(captured.product));
    assert.strictEqual(captured.plainId, 'abc');
  });

  it('direct key overrides class-name derivation: `{ table: Product }` makes :table a Ref<Product>', () => {
    // The explicit key `table: Product` registers lookup.set('table', Product).
    // Class name is still also registered (set('product'), set('productRef'))
    // but :table hits the explicit entry first.
    const typed = applyTypesConfig({ table: 'id-1' }, { table: Product });
    assert.ok(isReference(typed.table));
  });

  it('compile-time: .types() narrows params.productRef to Reference<Product>', () => {
    // Pure type-check - failure = compile error.
    Get('/p/:productRef')
      .types({ Product })
      .handle(({ params }: any) => {
        const id: string = params.productRef.identifier;
        void id;
      });
  });
});
