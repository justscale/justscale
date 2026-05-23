import { describe, it } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import {
  defineFeatureFlagPartial,
  isFeatureFlagPartial,
  isFeatureFlagComponent,
  createFeatureFlagProvider,
  FeatureFlag,
  FEATURE_FLAG_PARTIAL,
} from '../index.js';

describe('defineFeatureFlagPartial', () => {
  it('returns a branded object', () => {
    const f = defineFeatureFlagPartial('f.brand', z.object({ on: z.boolean() }));
    assert.strictEqual((f as unknown as Record<symbol, unknown>)[FEATURE_FLAG_PARTIAL], true);
    assert.strictEqual(isFeatureFlagPartial(f), true);
    assert.strictEqual(f.name, 'f.brand');
  });

  it('uses a plain Symbol (not Symbol.for) described "featureFlag:<name>"', () => {
    const f = defineFeatureFlagPartial('checkout.newPay', z.object({ on: z.boolean() }));
    assert.strictEqual(typeof f.key, 'symbol');
    assert.strictEqual(f.key.description, 'featureFlag:checkout.newPay');
    // Identity-based, not string-interned -- avoids silent collisions
    // between two features that happen to share a name.
    assert.notStrictEqual(f.key, Symbol.for('featureFlag:checkout.newPay'));
  });

  it('same-name feature-flag partials get distinct keys but identical descriptions', () => {
    const a = defineFeatureFlagPartial('dup.flag', z.object({ on: z.boolean() }));
    const b = defineFeatureFlagPartial('dup.flag', z.object({ on: z.boolean() }));
    assert.notStrictEqual(a.key, b.key);
    assert.strictEqual(a.key.description, 'featureFlag:dup.flag');
    assert.strictEqual(b.key.description, 'featureFlag:dup.flag');
    assert.notStrictEqual(a, b);
  });

  it('stores the zod schema unchanged', () => {
    const schema = z.object({ level: z.number().int() });
    const f = defineFeatureFlagPartial('f.schema', schema);
    assert.strictEqual(f.schema, schema);
  });

  it('isFeatureFlagPartial narrows negatively on non-partial values', () => {
    assert.strictEqual(isFeatureFlagPartial(null), false);
    assert.strictEqual(isFeatureFlagPartial({}), false);
    assert.strictEqual(isFeatureFlagPartial('string'), false);
  });

  it('isFeatureFlagComponent narrows negatively on non-component values', () => {
    assert.strictEqual(isFeatureFlagComponent(null), false);
    assert.strictEqual(isFeatureFlagComponent({}), false);
    const c = createFeatureFlagProvider({ factory: () => ({}) });
    assert.strictEqual(isFeatureFlagComponent(c), true);
  });
});

describe('FeatureFlag.of', () => {
  it('returns the same token for the same partial (identity memoized)', () => {
    const p = defineFeatureFlagPartial('mem', z.object({ on: z.boolean() }));
    const t1 = FeatureFlag.of(p);
    const t2 = FeatureFlag.of(p);
    assert.strictEqual(t1, t2);
  });

  it('token description embeds the partial name', () => {
    const p = defineFeatureFlagPartial('descr', z.object({ on: z.boolean() }));
    const t = FeatureFlag.of(p);
    assert.strictEqual(t.description, 'FeatureFlag.of(descr)');
  });

  it('token.resolve looks up via partial.key', () => {
    const p = defineFeatureFlagPartial('res', z.object({ on: z.boolean() }));
    const tok = FeatureFlag.of(p);
    const value = tok.resolve({
      get: (key: symbol) => {
        assert.strictEqual(key, p.key);
        return { on: true } as { on: boolean };
      },
    });
    assert.deepStrictEqual(value, { on: true });
  });

  it('same-name partials resolve independently through their own tokens', () => {
    // Pinning: two partials that share a human-readable name must not
    // collide through FeatureFlag.of -- each token looks up its own
    // partial.key, not a global string-interned symbol.
    const a = defineFeatureFlagPartial('same.name', z.object({ on: z.boolean() }));
    const b = defineFeatureFlagPartial('same.name', z.object({ on: z.boolean() }));
    const ta = FeatureFlag.of(a);
    const tb = FeatureFlag.of(b);
    assert.notStrictEqual(ta, tb);
    assert.notStrictEqual(ta.key, tb.key);
  });
});
