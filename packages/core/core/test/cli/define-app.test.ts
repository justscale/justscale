/**
 * Tests for `defineApp` — the unified app entrypoint that replaces
 * `defineMain` + `cli.mode.ts`. Covers the non-argv[1] paths (callable
 * invocation, env injection, error propagation). The argv[1] auto-run
 * is covered by the same `isEntrypoint` guard logic used by `defineMain`
 * (existing tests at test/cli/define-main.test.ts).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { defineApp } from '../../src/cli/define-app.js';
import type { Environment } from '../../src/features/environment/types.js';

function makeEnv(name: string): Environment {
  return {
    name,
    type: 'test',
    services: [],
    providers: [],
  } as unknown as Environment;
}

describe('defineApp', () => {
  it('returns a callable that passes the given env to the factory', async () => {
    let seen: Environment | null = null;
    const callable = defineApp({ url: 'file:///not-the-entrypoint.ts' }, (env) => {
      seen = env;
      return { kind: 'builder' };
    });

    const env = makeEnv('explicit');
    const result = await callable(env);

    assert.strictEqual(seen, env);
    assert.deepStrictEqual(result, { kind: 'builder' });
  });

  it('does not auto-run when the module is not argv[1]', async () => {
    let invoked = 0;
    defineApp({ url: 'file:///not-the-entrypoint.ts' }, () => {
      invoked++;
      return { kind: 'builder' };
    });

    // Let any scheduled microtask settle.
    await new Promise((r) => setImmediate(r));

    assert.strictEqual(invoked, 0, 'factory should not be called without an explicit invocation');
  });

  it('supports async factories', async () => {
    const callable = defineApp({ url: 'file:///nope.ts' }, async (env) => {
      await Promise.resolve();
      return { envName: (env as unknown as { name: string }).name };
    });

    const result = await callable(makeEnv('async-env'));
    assert.deepStrictEqual(result, { envName: 'async-env' });
  });

  it('propagates factory errors back to the caller', async () => {
    const callable = defineApp({ url: 'file:///nope.ts' }, () => {
      throw new Error('factory boom');
    });

    await assert.rejects(callable(makeEnv('x')), /factory boom/);
  });

  it('returns the factory output unchanged — works with any builder shape', async () => {
    const sentinel = { addControllers: () => sentinel, build: () => ({}) };
    const callable = defineApp({ url: 'file:///nope.ts' }, () => sentinel);

    const result = await callable(makeEnv('shape'));
    assert.strictEqual(result, sentinel);
    assert.ok(typeof (result as { addControllers: unknown }).addControllers === 'function');
  });
});
