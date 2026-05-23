import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import JustScale from '../../../index.js';
import {
  defineConfigPartial,
  createConfig,
  createConfigService,
  ConfigServiceDef,
  type ConfigService,
} from '../index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function wire(provider: unknown, partial: { key: symbol }): Promise<{
  service: ConfigService
  readBack: <T = unknown>() => Promise<T>
  configDir: string
  dispose: () => void
}> {
  const dir = mkdtempSync(join(tmpdir(), 'jst-cfg-'));
  const app = JustScale().add(provider as Parameters<ReturnType<typeof JustScale>['add']>[0]).build();
  await app.compile().ready;
  const resolver = (async (token: unknown) => {
    return app.container.resolve(token as never);
  }) as unknown as Parameters<typeof createConfigService>[0];
  (resolver as unknown as { registerInstance: (k: symbol, v: unknown) => void }).registerInstance =
    (k: symbol, v: unknown) => {
      app.container.registerInstance(k as never, v as never);
    };
  const service = createConfigService(resolver, { configDir: dir });
  return {
    service,
    readBack: <T = unknown>() => resolver(partial.key as unknown as Parameters<typeof resolver>[0]) as Promise<T>,
    configDir: dir,
    dispose: () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch {
        /* best-effort */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConfigService.set', () => {
  let ctx: Awaited<ReturnType<typeof wire>>;

  // Reuse one shape across cases — varies only by what we pass to .set()
  const P = defineConfigPartial('svc.set', z.object({
    port: z.number().int().min(1).max(65535),
    nested: z.object({ host: z.string() }),
  }));

  const initialFactory = () =>
    createConfig({
      provides: [P],
      factory: () => ({ [P.key]: { port: 3000, nested: { host: 'localhost' } } }),
    });

  beforeEach(async () => {
    ctx = await wire(initialFactory(), P);
  });
  afterEach(() => ctx.dispose());

  it('mutates a top-level field and persists it', async () => {
    await ctx.service.set(P, 'port', 4000);
    assert.strictEqual((await ctx.readBack<{ port: number }>()).port, 4000);
  });

  it('mutates a nested path', async () => {
    await ctx.service.set(P, 'nested.host', '1.2.3.4');
    const v = await ctx.readBack<{ nested: { host: string } }>();
    assert.strictEqual(v.nested.host, '1.2.3.4');
  });

  it('rejects values that fail zod validation (port out of range)', async () => {
    await assert.rejects(() => ctx.service.set(P, 'port', 99999));
  });

  it('rejects values that fail zod validation (wrong type)', async () => {
    await assert.rejects(() => ctx.service.set(P, 'port', 'not-a-number'));
  });

  it('persists the whole partial to config.json on disk', async () => {
    await ctx.service.set(P, 'port', 4242);
    const raw = JSON.parse(readFileSync(join(ctx.configDir, 'config.json'), 'utf-8'));
    assert.strictEqual(raw[P.name].port, 4242);
  });
});

describe('ConfigService.watch', () => {
  const P = defineConfigPartial('svc.watch', z.object({ v: z.number() }));

  it('emits [old, new] tuples on set()', async () => {
    const ctx = await wire(
      createConfig({ provides: [P], factory: () => ({ [P.key]: { v: 1 } }) }),
      P,
    );
    try {
      const iter = ctx.service.watch(P)[Symbol.asyncIterator]();
      const p1 = iter.next();
      await ctx.service.set(P, 'v', 2);
      const got = await p1;
      assert.strictEqual(got.done, false);
      assert.deepStrictEqual(got.value, [{ v: 1 }, { v: 2 }]);
      await iter.return!();
    } finally {
      ctx.dispose();
    }
  });

  it('path-filter: only fires when the path actually changed', async () => {
    const P2 = defineConfigPartial('svc.watch.path', z.object({
      a: z.number(),
      b: z.number(),
    }));
    const ctx = await wire(
      createConfig({ provides: [P2], factory: () => ({ [P2.key]: { a: 1, b: 1 } }) }),
      P2,
    );
    try {
      const iter = ctx.service.watch(P2, 'a')[Symbol.asyncIterator]();
      const p1 = iter.next();
      // Change 'b' — watcher on 'a' should stay quiet.
      await ctx.service.set(P2, 'b', 2);
      // Give the microtask queue a tick; nothing should have resolved p1 yet.
      await new Promise((r) => setImmediate(r));
      // Now change 'a' and the watcher fires with the latest (cumulative) state.
      await ctx.service.set(P2, 'a', 5);
      const got = await p1;
      const [, newV] = got.value as [{ a: number; b: number }, { a: number; b: number }];
      assert.strictEqual(newV.a, 5);
      await iter.return!();
    } finally {
      ctx.dispose();
    }
  });

  it('return() removes the watcher and marks iterator done', async () => {
    const P3 = defineConfigPartial('svc.watch.return', z.object({ v: z.number() }));
    const ctx = await wire(
      createConfig({ provides: [P3], factory: () => ({ [P3.key]: { v: 0 } }) }),
      P3,
    );
    try {
      const iter = ctx.service.watch(P3)[Symbol.asyncIterator]();
      const retRes = await iter.return!();
      assert.strictEqual(retRes.done, true);
      // set() after return should notify 0 watchers.
      const notified = await ctx.service.set(P3, 'v', 99);
      assert.strictEqual(notified, 0);
    } finally {
      ctx.dispose();
    }
  });

  it('throwing watcher callback is removed silently', async () => {
    // The public API doesn't let us register raw callbacks, but we can
    // verify the guarantee from set()'s perspective: set() returns 0 after
    // the one-and-only iterator has stopped.
    const P4 = defineConfigPartial('svc.watch.throw', z.object({ v: z.number() }));
    const ctx = await wire(
      createConfig({ provides: [P4], factory: () => ({ [P4.key]: { v: 0 } }) }),
      P4,
    );
    try {
      const iter = ctx.service.watch(P4)[Symbol.asyncIterator]();
      await iter.throw!(new Error('cancel'))
        .catch(() => undefined); // the throw reaches here, test that watcher is gone
      const n = await ctx.service.set(P4, 'v', 1);
      assert.strictEqual(n, 0);
    } finally {
      ctx.dispose();
    }
  });
});

describe('ConfigService via builder (ConfigServiceDef)', () => {
  it('registers a functional ConfigService by default', async () => {
    const app = JustScale().add(ConfigServiceDef).build();
    await app.compile().ready;
    const svc = await app.container.resolve(ConfigServiceDef);
    assert.strictEqual(typeof svc.set, 'function');
    assert.strictEqual(typeof svc.watch, 'function');
  });
});

