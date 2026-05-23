/**
 * Integration-style tests for ClusterServer <-> ClusterClient over a
 * real unix socket. Covers method routing, handler errors, streaming,
 * prompts, connection teardown, builtin handlers, and disconnect
 * cleanup.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { ClusterServer, createClusterServer } from '../server.js';
import { ClusterClient, createClusterClient } from '../client.js';
import { ErrorCodes, Methods } from '../protocol.js';

function makeSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jsclust-'));
  return { dir, sock: join(dir, 'c.sock') } as unknown as string;
}

async function startPair(): Promise<{
  server: ClusterServer;
  client: ClusterClient;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), 'jsclust-'));
  const sock = join(dir, 'c.sock');
  const server = createClusterServer({ socketPath: sock });
  await server.listen();
  const client = createClusterClient({ socketPath: sock });
  await client.connect();
  return {
    server,
    client,
    cleanup: async () => {
      await client.disconnect().catch(() => {});
      await server.close().catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('ClusterServer + ClusterClient', () => {
  describe('lifecycle', () => {
    it('server refuses double-listen', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'jsclust-'));
      const sock = join(dir, 'c.sock');
      const s = createClusterServer({ socketPath: sock });
      await s.listen();
      await assert.rejects(() => s.listen(), /already listening/);
      await s.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('server.listening is accurate across lifecycle', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'jsclust-'));
      const sock = join(dir, 'c.sock');
      const s = createClusterServer({ socketPath: sock });
      assert.equal(s.listening, false);
      await s.listen();
      assert.equal(s.listening, true);
      await s.close();
      assert.equal(s.listening, false);
      rmSync(dir, { recursive: true, force: true });
    });

    it('client.connected reflects state', async () => {
      const p = await startPair();
      assert.equal(p.client.connected, true);
      await p.client.disconnect();
      assert.equal(p.client.connected, false);
      await p.cleanup();
    });

    it('client connecting to missing socket rejects', async () => {
      const c = createClusterClient({ socketPath: '/tmp/nonexistent-justscale.sock' });
      await assert.rejects(() => c.connect(), /Socket not found|ENOENT/);
    });
  });

  describe('method routing', () => {
    it('dispatches to the correct handler and returns the result', async () => {
      const p = await startPair();
      p.server.handle('math.add', async (params) => {
        const { a, b } = params as { a: number; b: number };
        return a + b;
      });
      const result = await p.client.call<number>('math.add', { a: 2, b: 3 });
      assert.equal(result, 5);
      await p.cleanup();
    });

    it('unknown method yields METHOD_NOT_FOUND error', async () => {
      const p = await startPair();
      await assert.rejects(
        () => p.client.call('does.not.exist'),
        /METHOD_NOT_FOUND/,
      );
      await p.cleanup();
    });

    it('handler throwing surfaces as INTERNAL_ERROR at the client', async () => {
      const p = await startPair();
      p.server.handle('boom', async () => {
        throw new Error('oops');
      });
      await assert.rejects(() => p.client.call('boom'), /INTERNAL_ERROR.*oops/);
      await p.cleanup();
    });

    it('multiple concurrent requests resolve independently', async () => {
      const p = await startPair();
      p.server.handle('echo', async (params) => params?.v);
      const results = await Promise.all([
        p.client.call('echo', { v: 1 }),
        p.client.call('echo', { v: 2 }),
        p.client.call('echo', { v: 3 }),
        p.client.call('echo', { v: 4 }),
      ]);
      assert.deepEqual(results, [1, 2, 3, 4]);
      await p.cleanup();
    });
  });

  describe('builtin handlers', () => {
    it('system.health returns healthy status', async () => {
      const p = await startPair();
      const h = await p.client.call<{ status: string; uptime: number }>(Methods.SYSTEM_HEALTH);
      assert.equal(h.status, 'healthy');
      assert.ok(typeof h.uptime === 'number');
      await p.cleanup();
    });

    it('system.info returns process metadata', async () => {
      const p = await startPair();
      const info = await p.client.call<{ node: string; platform: string; pid: number }>(Methods.SYSTEM_INFO);
      assert.ok(info.node.startsWith('v'));
      assert.equal(info.pid, process.pid);
      await p.cleanup();
    });

    it('client.health() convenience wraps the builtin', async () => {
      const p = await startPair();
      const h = await p.client.health();
      assert.equal(h.status, 'healthy');
      await p.cleanup();
    });
  });

  describe('streaming', () => {
    it('stream channel messages arrive via onStream callback', async () => {
      const p = await startPair();
      p.server.handle('stream.data', async (_params, ctx) => {
        await ctx.stream('stdout', 'line-1');
        await ctx.stream('stdout', 'line-2');
        await ctx.stream('stderr', 'warn!');
        return { lines: 2 };
      });
      const streams: Array<{ c: string; d: unknown }> = [];
      const result = await p.client.call<{ lines: number }>('stream.data', undefined, {
        onStream: (c, d) => streams.push({ c, d }),
      });
      assert.deepEqual(result, { lines: 2 });
      assert.equal(streams.length, 3);
      assert.deepEqual(
        streams.map((s) => s.c),
        ['stdout', 'stdout', 'stderr'],
      );
      await p.cleanup();
    });
  });

  describe('prompts (interactive round-trip)', () => {
    it('server.prompt suspends until client answers', async () => {
      const p = await startPair();
      p.server.handle('who.are.you', async (_p, ctx) => {
        const name = await ctx.prompt('text', 'Your name?');
        return `hello ${name}`;
      });
      const result = await p.client.call<string>('who.are.you', undefined, {
        onPrompt: async (_type, _msg) => 'alice',
      });
      assert.equal(result, 'hello alice');
      await p.cleanup();
    });

    it('prompt cancelled (handler returns null) yields null at the server', async () => {
      const p = await startPair();
      let seen: unknown = 'sentinel';
      p.server.handle('maybe', async (_p, ctx) => {
        seen = await ctx.prompt('text', 'Go?');
        return 'done';
      });
      await p.client.call('maybe', undefined, {
        onPrompt: async () => null,
      });
      assert.equal(seen, null);
      await p.cleanup();
    });
  });

  describe('timeouts', () => {
    it('client-side timeout rejects with "Request timeout"', async () => {
      const p = await startPair();
      // Handler never finishes
      p.server.handle('never', async () => new Promise(() => {}));
      await assert.rejects(
        () => p.client.call('never', undefined, { timeout: 50 }),
        /Request timeout/,
      );
      await p.cleanup();
    });
  });

  describe('disconnect cleanup', () => {
    it('client.disconnect rejects all pending calls', async () => {
      const p = await startPair();
      p.server.handle('slow', async () => new Promise((r) => setTimeout(r, 500)));
      const pending = p.client.call('slow').catch((e) => e);
      // Give the request a chance to send
      await new Promise((r) => setTimeout(r, 20));
      await p.client.disconnect();
      const err = await pending;
      assert.ok(err instanceof Error);
      assert.match(err.message, /Disconnected|closed/i);
      await p.cleanup();
    });

    it('server.close disconnects client; client emits disconnect', async () => {
      const p = await startPair();
      let disconnected = false;
      p.client.on('disconnect', () => {
        disconnected = true;
      });
      await p.server.close();
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(disconnected, true);
      await p.cleanup();
    });
  });

  describe('multi-client fan-out to one server', () => {
    it('server handles two clients concurrently', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'jsclust-'));
      const sock = join(dir, 'c.sock');
      const server = createClusterServer({ socketPath: sock });
      await server.listen();
      server.handle('double', async (params) => (params?.n as number) * 2);

      const c1 = createClusterClient({ socketPath: sock });
      const c2 = createClusterClient({ socketPath: sock });
      await c1.connect();
      await c2.connect();

      const [a, b] = await Promise.all([
        c1.call<number>('double', { n: 7 }),
        c2.call<number>('double', { n: 9 }),
      ]);
      assert.equal(a, 14);
      assert.equal(b, 18);

      await c1.disconnect();
      await c2.disconnect();
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    });
  });
});
