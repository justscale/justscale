import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import JustScale, { defineService } from '../../../index.js';
import { EnvServiceDef, type EnvService } from '../index.js';

// ---------------------------------------------------------------------------
// Helper — build a fresh EnvService via DI so implementation details stay
// opaque. Each test gets a cleaned-up env scope.
// ---------------------------------------------------------------------------
async function makeEnv(): Promise<EnvService> {
  const app = JustScale().add(EnvServiceDef).build();
  await app.compile().ready;
  return app.container.resolve(EnvServiceDef);
}

const OWNED = new Set<string>();
function setEnv(key: string, value: string | undefined): void {
  OWNED.add(key);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('EnvService', () => {
  beforeEach(() => {
    for (const k of OWNED) delete process.env[k];
    OWNED.clear();
  });
  after(() => {
    for (const k of OWNED) delete process.env[k];
    OWNED.clear();
  });

  describe('string()', () => {
    it('returns the env value when set', async () => {
      setEnv('JST_TEST_STR', 'hello');
      const env = await makeEnv();
      assert.strictEqual(env.string('JST_TEST_STR'), 'hello');
    });

    it('returns the default when unset', async () => {
      const env = await makeEnv();
      assert.strictEqual(env.string('JST_NO_SUCH', 'fallback'), 'fallback');
    });

    it('throws when unset and no default', async () => {
      const env = await makeEnv();
      assert.throws(() => env.string('JST_NO_SUCH_2'), /not set/);
    });

    it('returns empty string when env value is literally empty', async () => {
      setEnv('JST_EMPTY', '');
      const env = await makeEnv();
      // process.env[""] is '' — ENV is set, so raw returns ''; default is ignored.
      assert.strictEqual(env.string('JST_EMPTY', 'fallback'), '');
    });
  });

  describe('number()', () => {
    it('parses integers', async () => {
      setEnv('JST_PORT', '8080');
      const env = await makeEnv();
      assert.strictEqual(env.number('JST_PORT'), 8080);
    });

    it('returns default when unset', async () => {
      const env = await makeEnv();
      assert.strictEqual(env.number('JST_MISSING_INT', 9999), 9999);
    });

    it('throws when value is not a number', async () => {
      setEnv('JST_BAD_NUM', 'nope');
      const env = await makeEnv();
      assert.throws(
        () => env.number('JST_BAD_NUM'),
        /value 'nope' is not a valid number/,
      );
    });

    it('parses floats verbatim (no silent truncation)', async () => {
      // Number('3.7') === 3.7 — unlike parseInt which would drop the fraction
      // and return 3. Callers that want an integer can coerce downstream.
      setEnv('JST_FLOAT', '3.7');
      const env = await makeEnv();
      assert.strictEqual(env.number('JST_FLOAT'), 3.7);
    });

    it('throws on trailing non-numeric characters (e.g. "100px")', async () => {
      // Number('100px') === NaN — partial parses are a footgun, reject them.
      setEnv('JST_WEIRD', '100px');
      const env = await makeEnv();
      assert.throws(
        () => env.number('JST_WEIRD'),
        /value '100px' is not a valid number/,
      );
    });

    it('throws when unset and no default', async () => {
      const env = await makeEnv();
      assert.throws(() => env.number('JST_NO_INT'), /not set/);
    });
  });

  describe('boolean()', () => {
    for (const v of ['true', 'TRUE', '1', 'yes', 'YES', 'on', 'ON']) {
      it(`"${v}" → true`, async () => {
        setEnv('JST_BOOL', v);
        const env = await makeEnv();
        assert.strictEqual(env.boolean('JST_BOOL'), true);
      });
    }

    for (const v of ['false', 'FALSE', '0', 'no', 'NO', 'off', 'OFF']) {
      it(`"${v}" → false`, async () => {
        setEnv('JST_BOOL', v);
        const env = await makeEnv();
        assert.strictEqual(env.boolean('JST_BOOL'), false);
      });
    }

    it('returns false by default when unset and no default given', async () => {
      const env = await makeEnv();
      assert.strictEqual(env.boolean('JST_UNSET_BOOL'), false);
    });

    it('returns the default when unset', async () => {
      const env = await makeEnv();
      assert.strictEqual(env.boolean('JST_UNSET_BOOL', true), true);
    });

    it('throws on a value that is neither truthy nor falsy', async () => {
      setEnv('JST_BAD_BOOL', 'maybe');
      const env = await makeEnv();
      assert.throws(() => env.boolean('JST_BAD_BOOL'), /invalid boolean/);
    });
  });

  describe('json()', () => {
    it('parses valid JSON objects', async () => {
      setEnv('JST_JSON', '{"a":1,"b":[2,3]}');
      const env = await makeEnv();
      assert.deepStrictEqual(env.json('JST_JSON'), { a: 1, b: [2, 3] });
    });

    it('throws on malformed JSON', async () => {
      setEnv('JST_BAD_JSON', '{ not json');
      const env = await makeEnv();
      assert.throws(() => env.json('JST_BAD_JSON'), /invalid JSON/);
    });

    it('returns default on missing', async () => {
      const env = await makeEnv();
      assert.deepStrictEqual(env.json('JST_NO_JSON', { fallback: true }), { fallback: true });
    });

    it('throws on missing without default', async () => {
      const env = await makeEnv();
      assert.throws(() => env.json('JST_NO_JSON_2'), /not set/);
    });
  });

  describe('raw() & has()', () => {
    it('raw returns undefined on missing', async () => {
      const env = await makeEnv();
      assert.strictEqual(env.raw('JST_ABSENT'), undefined);
    });

    it('has is true only when key is in process.env', async () => {
      setEnv('JST_PRESENT', '1');
      const env = await makeEnv();
      assert.strictEqual(env.has('JST_PRESENT'), true);
      assert.strictEqual(env.has('JST_ABSENT'), false);
    });

    it('has() treats empty string as absent', async () => {
      // `has` answers "is there a usable value here". An empty env var is
      // typically an oversight (`FOO=` with nothing after), so has returns
      // false and callers can rely on `has(k)` implying something to read.
      setEnv('JST_BLANK', '');
      const env = await makeEnv();
      assert.strictEqual(env.has('JST_BLANK'), false);
    });
  });

  it('can be injected into a service', async () => {
    setEnv('PORT', '3001');
    class Srv extends defineService({
      inject: { env: EnvServiceDef },
      factory: ({ env }) => ({ p: env.number('PORT', 3000) }),
    }) {}
    const app = JustScale().add(EnvServiceDef).add(Srv).build();
    await app.compile().ready;
    const s = await app.container.resolve(Srv);
    assert.strictEqual(s.p, 3001);
  });
});
