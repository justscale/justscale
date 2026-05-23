import { describe, it } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import {
  defineSecretPartial,
  isSecretPartial,
  isSecretComponent,
  createSecretProvider,
  Secret,
  SECRET_PARTIAL,
} from '../index.js';

describe('defineSecretPartial', () => {
  it('returns a branded object', () => {
    const s = defineSecretPartial('s.brand', z.object({ tok: z.string() }));
    assert.strictEqual((s as unknown as Record<symbol, unknown>)[SECRET_PARTIAL], true);
    assert.strictEqual(isSecretPartial(s), true);
    assert.strictEqual(s.name, 's.brand');
  });

  it('uses a plain Symbol (not Symbol.for) described "secret:<name>"', () => {
    const s = defineSecretPartial('pg.key', z.object({ url: z.string() }));
    assert.strictEqual(typeof s.key, 'symbol');
    assert.strictEqual(s.key.description, 'secret:pg.key');
    // Identity-based, not string-interned — avoids silent collisions
    // between two features that happen to share a name.
    assert.notStrictEqual(s.key, Symbol.for('secret:pg.key'));
  });

  it('same-name secret partials get distinct keys', () => {
    const a = defineSecretPartial('dup.name', z.object({ k: z.string() }));
    const b = defineSecretPartial('dup.name', z.object({ k: z.string() }));
    assert.notStrictEqual(a.key, b.key);
  });

  it('stores the zod schema unchanged', () => {
    const schema = z.object({ tok: z.string().min(8) });
    const s = defineSecretPartial('pg.schema', schema);
    assert.strictEqual(s.schema, schema);
  });

  it('isSecretPartial narrows negatively on non-partial values', () => {
    assert.strictEqual(isSecretPartial(null), false);
    assert.strictEqual(isSecretPartial({}), false);
    assert.strictEqual(isSecretPartial('string'), false);
  });

  it('isSecretComponent narrows negatively on non-component values', () => {
    assert.strictEqual(isSecretComponent(null), false);
    assert.strictEqual(isSecretComponent({}), false);
    const c = createSecretProvider({ factory: () => ({}) });
    assert.strictEqual(isSecretComponent(c), true);
  });
});

describe('Secret.of', () => {
  it('returns the same token for the same partial (identity memoized)', () => {
    const p = defineSecretPartial('mem', z.object({ k: z.string() }));
    const t1 = Secret.of(p);
    const t2 = Secret.of(p);
    assert.strictEqual(t1, t2);
  });

  it('token description embeds the partial name', () => {
    const p = defineSecretPartial('descr', z.object({ k: z.string() }));
    const t = Secret.of(p);
    assert.strictEqual(t.description, 'Secret.of(descr)');
  });

  it('token.resolve looks up via partial.key', () => {
    const p = defineSecretPartial('res', z.object({ k: z.string() }));
    const tok = Secret.of(p);
    const value = tok.resolve({
      get: (key: symbol) => {
        assert.strictEqual(key, p.key);
        return { k: 'yes' } as { k: string };
      },
    });
    assert.deepStrictEqual(value, { k: 'yes' });
  });
});
