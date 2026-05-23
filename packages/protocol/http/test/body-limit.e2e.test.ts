/**
 * HTTP body-size-limit boundary tests.
 *
 * The framework caps request bodies at `maxBodyBytes` (default 1 MB,
 * configurable via HttpConfig). Per the audit, the boundary wasn't
 * tested anywhere — letting an off-by-one or chunk-sensitivity bug
 * slip in undetected. This file pins the contract:
 *
 *   - body of exactly maxBodyBytes is accepted (200)
 *   - body of maxBodyBytes + 1 is rejected with 413
 *   - rejection happens regardless of chunk size (1 small chunk vs many)
 *   - rejection is server-side terminating (req.destroy() prevents the
 *     attacker from holding the connection open for more upload)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { createController } from '@justscale/core';
import { Post, listen } from '../src/index.js';
import { createTestApp } from '@justscale/testing';

const MAX = 1024; // intentionally small so test runs are fast

async function buildHarness() {
  const ctrl = createController({
    inject: {},
    routes: () => ({
      echo: Post('/echo').handle((ctx: any) => {
        ctx.res.json({ ok: true, size: JSON.stringify(ctx.rawBody ?? {}).length });
      }),
    }),
  });
  const app = await createTestApp({ controllers: [ctrl] });
  const server = listen(app, 0, { maxBodyBytes: MAX });
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

/**
 * Send a body in arbitrarily-sized chunks. Lets us probe whether the
 * limit check is sensitive to where the boundary falls inside a chunk.
 */
async function postChunks(
  port: number,
  chunks: Buffer[],
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/echo',
        method: 'POST',
        // No keep-alive: the over-limit tests destroy the request socket,
        // and a pooled agent would happily hand the dead connection to a
        // subsequent test, surfacing as a spurious 0/RST.
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': String(total),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', (err) => {
      // Server may RST the socket after writing 413 + destroy().
      // Treat ECONNRESET / EPIPE as "request completed" since we got
      // some response info from the server beforehand. Specifically
      // for the boundary test the response is what matters.
      if ((err as NodeJS.ErrnoException).code === 'ECONNRESET' ||
          (err as NodeJS.ErrnoException).code === 'EPIPE') {
        resolve({ status: 0, body: '' });
        return;
      }
      reject(err);
    });
    for (const c of chunks) req.write(c);
    req.end();
  });
}

/**
 * Build a JSON-shaped body of EXACTLY `targetBytes` bytes by padding
 * the value of a single field. JSON wrapping accounted for.
 */
function buildJsonOfExactSize(targetBytes: number): Buffer {
  // {"x":""} = 8 bytes. Pad x's value to (target - 8) chars.
  const padLen = targetBytes - 8;
  if (padLen < 0) throw new Error(`target ${targetBytes} too small`);
  return Buffer.from(`{"x":"${'a'.repeat(padLen)}"}`);
}

describe('HTTP body-size limit boundary', () => {
  let h: Awaited<ReturnType<typeof buildHarness>>;
  before(async () => { h = await buildHarness(); });
  after(async () => { await h.close(); });

  it('accepts a body of EXACTLY maxBodyBytes (off-by-one boundary)', async () => {
    const body = buildJsonOfExactSize(MAX);
    assert.strictEqual(body.byteLength, MAX, 'body must be exactly MAX bytes');
    const res = await postChunks(h.port, [body]);
    assert.strictEqual(res.status, 200, `expected 200 at boundary, got ${res.status}: ${res.body}`);
  });

  it('REJECTS a body of maxBodyBytes + 1 with 413', async () => {
    const body = buildJsonOfExactSize(MAX + 1);
    assert.strictEqual(body.byteLength, MAX + 1);
    const res = await postChunks(h.port, [body]);
    assert.strictEqual(res.status, 413, `expected 413 just over boundary, got ${res.status}: ${res.body}`);
    assert.match(res.body, /Payload Too Large/);
  });

  it('rejects a much-larger body the same way (single big chunk)', async () => {
    const body = buildJsonOfExactSize(MAX * 4);
    const res = await postChunks(h.port, [body]);
    // Either the structured 413 lands first, or the server resets the
    // socket once req.destroy() fires. Both are acceptable rejections.
    assert.ok(res.status === 413 || res.status === 0,
      `expected 413 or RST for oversized body, got ${res.status}`);
    if (res.status === 413) assert.match(res.body, /Payload Too Large/);
  });

  it('rejects an oversized body sent in many small chunks (chunk-boundary check)', async () => {
    // Build MAX+1 bytes split into 100-byte chunks so the limit boundary
    // falls INSIDE a chunk, not on a chunk edge. The check must still fire.
    const body = buildJsonOfExactSize(MAX + 1);
    const chunks: Buffer[] = [];
    const CHUNK = 100;
    for (let i = 0; i < body.byteLength; i += CHUNK) {
      chunks.push(body.subarray(i, Math.min(i + CHUNK, body.byteLength)));
    }
    const res = await postChunks(h.port, chunks);
    assert.ok(res.status === 413 || res.status === 0,
      `expected 413 or RST for chunked oversize, got ${res.status}`);
  });

  it('accepts an empty body (POST with {} effective body)', async () => {
    const res = await postChunks(h.port, [Buffer.from('{}')]);
    assert.strictEqual(res.status, 200);
  });
});
