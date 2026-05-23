import { describe, it } from 'node:test';
import assert from 'node:assert';
import { z } from 'zod';
import { Config, defineConfigPartial, createToken } from '../index.js';

describe('Config.of', () => {
  it('returns the same token for the same partial (identity memoization)', () => {
    const p = defineConfigPartial('memo', z.object({ x: z.string() }));
    const t1 = Config.of(p);
    const t2 = Config.of(p);
    assert.strictEqual(t1, t2);
  });

  it('returns different tokens for different partials', () => {
    const a = defineConfigPartial('memo-a', z.object({}));
    const b = defineConfigPartial('memo-b', z.object({}));
    assert.notStrictEqual(Config.of(a), Config.of(b));
  });

  it('token description embeds the partial name', () => {
    const p = defineConfigPartial('descr', z.object({}));
    const t = Config.of(p);
    assert.strictEqual(t.description, 'Config.of(descr)');
  });

  it('token.resolve delegates to the container with the partial key', () => {
    const p = defineConfigPartial('resolve-delegates', z.object({ v: z.string() }));
    const token = Config.of(p);
    const fakeContainer = {
      get: (key: symbol) => {
        assert.strictEqual(key, p.key);
        return { v: 'hello' } as unknown as { v: string };
      },
    };
    const resolved = token.resolve(fakeContainer);
    assert.deepStrictEqual(resolved, { v: 'hello' });
  });

  it('createToken directly builds a ConfigToken', () => {
    const t = createToken<{ a: number }>('Custom.Token', {
      resolve: () => ({ a: 1 }),
    });
    assert.strictEqual(t.description, 'Custom.Token');
    assert.strictEqual(t.key, Symbol.for('Custom.Token'));
    assert.deepStrictEqual(t.resolve({ get: () => ({} as { a: number }) }), { a: 1 });
  });
});
