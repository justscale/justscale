/**
 * Unit tests for build-context.ts — the AsyncLocalStorage that scopes
 * adapter-install calls to the compile phase.
 *
 * These tests cover the ALS primitive in isolation (no App, no kernel), so
 * regressions surface cleanly without false positives from downstream
 * consumers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  _buildContext,
  currentBuilder,
  type BuildContext,
} from '../../src/builder/build-context.js';
import type { Adapter } from '../../src/kernel/adapter.js';

function makeAdapter(name: string): Adapter {
  return Object.freeze({
    name,
    requires: [],
    start: () => {},
  });
}

function makeCtx(): { ctx: BuildContext; installed: Set<Adapter> } {
  const installed = new Set<Adapter>();
  return {
    installed,
    ctx: { installAdapter: (a) => installed.add(a) },
  };
}

describe('build-context', () => {
  it('currentBuilder() returns undefined outside any scope', () => {
    assert.strictEqual(currentBuilder(), undefined);
  });

  it('currentBuilder() returns the store inside _buildContext.run()', () => {
    const { ctx } = makeCtx();
    let observed: BuildContext | undefined;
    _buildContext.run(ctx, () => {
      observed = currentBuilder();
    });
    assert.strictEqual(observed, ctx);
  });

  it('clears the store after the sync callback returns', () => {
    const { ctx } = makeCtx();
    _buildContext.run(ctx, () => {
      // no-op
    });
    assert.strictEqual(currentBuilder(), undefined);
  });

  it('preserves context across await boundaries', async () => {
    const { ctx, installed } = makeCtx();
    const a = makeAdapter('a');
    const b = makeAdapter('b');

    await _buildContext.run(ctx, async () => {
      currentBuilder()?.installAdapter(a);
      await new Promise((r) => setTimeout(r, 1));
      currentBuilder()?.installAdapter(b);
      await Promise.resolve();
      currentBuilder()?.installAdapter(a); // dedup via Set
    });

    assert.strictEqual(installed.size, 2);
    assert.ok(installed.has(a));
    assert.ok(installed.has(b));
  });

  it('preserves context across setImmediate', async () => {
    const { ctx, installed } = makeCtx();
    const a = makeAdapter('a');

    await _buildContext.run(ctx, async () => {
      await new Promise<void>((resolve) => {
        setImmediate(() => {
          currentBuilder()?.installAdapter(a);
          resolve();
        });
      });
    });

    assert.strictEqual(installed.size, 1);
  });

  it('preserves context across queueMicrotask', async () => {
    const { ctx, installed } = makeCtx();
    const a = makeAdapter('a');

    await _buildContext.run(ctx, async () => {
      await new Promise<void>((resolve) => {
        queueMicrotask(() => {
          currentBuilder()?.installAdapter(a);
          resolve();
        });
      });
    });

    assert.strictEqual(installed.size, 1);
  });

  it('isolates concurrent scopes — one scope cannot see another scope\'s store', async () => {
    const ctxA = makeCtx();
    const ctxB = makeCtx();
    const a = makeAdapter('a');
    const b = makeAdapter('b');

    await Promise.all([
      _buildContext.run(ctxA.ctx, async () => {
        await new Promise((r) => setTimeout(r, 5));
        currentBuilder()?.installAdapter(a);
      }),
      _buildContext.run(ctxB.ctx, async () => {
        await new Promise((r) => setTimeout(r, 2));
        currentBuilder()?.installAdapter(b);
      }),
    ]);

    assert.strictEqual(ctxA.installed.size, 1);
    assert.ok(ctxA.installed.has(a));
    assert.strictEqual(ctxB.installed.size, 1);
    assert.ok(ctxB.installed.has(b));
  });

  it('nested run() inner store shadows outer, reverts on return', () => {
    const outer = makeCtx();
    const inner = makeCtx();

    _buildContext.run(outer.ctx, () => {
      assert.strictEqual(currentBuilder(), outer.ctx);
      _buildContext.run(inner.ctx, () => {
        assert.strictEqual(currentBuilder(), inner.ctx);
      });
      assert.strictEqual(currentBuilder(), outer.ctx);
    });
  });

  it('rejection inside run() propagates and clears the scope', async () => {
    const { ctx } = makeCtx();
    await assert.rejects(
      _buildContext.run(ctx, async () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.strictEqual(currentBuilder(), undefined);
  });
});
