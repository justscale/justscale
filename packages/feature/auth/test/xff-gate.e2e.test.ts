/**
 * AuthController X-Forwarded-For gate (end-to-end).
 *
 * Pre-fix the controller wrote whatever the client sent in
 * `req.headers['x-forwarded-for']` directly into session.ipAddress —
 * any client could spoof their source IP, lying to audit logs from
 * day one.
 *
 * The fix routes through `getClientIp(req, http.trustedProxies)`:
 *
 *   - With trustedProxies=[] (default): always returns req.socket.remoteAddress.
 *     XFF is ignored even when present.
 *   - With trustedProxies including the immediate peer: walks the XFF
 *     chain and returns the leftmost non-trusted hop.
 *
 * These tests pin both behaviors with real fetch() against a real
 * `listen()` server, so the gate is observable end-to-end (not just
 * via the unit tests for getClientIp itself).
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import JustScale, { createConfig } from '@justscale/core';
import { ModelRepository } from '@justscale/core/models';
import { HttpConfig, listen } from '@justscale/http';
import { Session } from '../src/models/session.js';
import { AuthTestBundle } from '../src/testing.js';

interface RegisterResp {
  token: string
  user: { id: string }
}

async function buildHarness(trustedProxies: string[]) {
  const portCfg = createConfig({
    provides: [HttpConfig],
    factory: () => ({
      [HttpConfig.key]: {
        port: 0,
        host: '127.0.0.1',
        trustedProxies,
      },
    }),
  });
  const built = JustScale().add(portCfg).add(AuthTestBundle()).build();
  const app = built.compile();
  await app.ready;
  const server = listen(app, 0);
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const sessionRepo = await app.container.resolve(ModelRepository.of(Session));
  return {
    port,
    async sessionForToken(token: string): Promise<{ ipAddress?: string } | null> {
      // Sessions are looked up by token. Find the row directly.
      const all = await sessionRepo.find({});
      return all.find((s: any) => s.token === token) as any ?? null;
    },
    async stop() {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await built.stop();
    },
  };
}

describe('AuthController XFF gate', () => {
  let harness: Awaited<ReturnType<typeof buildHarness>> | null = null;

  after(async () => {
    if (harness) await harness.stop();
  });

  it('IGNORES X-Forwarded-For when trustedProxies is empty (default)', async () => {
    harness = await buildHarness(/* trustedProxies */ []);

    const res = await fetch(`http://127.0.0.1:${harness.port}/auth/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Spoofed source IP. Without the gate, this would land in the
        // session record verbatim.
        'x-forwarded-for': '1.2.3.4',
      },
      body: JSON.stringify({
        email: 'xff-default@example.com',
        password: 'password123',
        name: 'XFF Default',
      }),
    });
    const text = await res.text();
    assert.strictEqual(res.status, 201, text);
    const body = JSON.parse(text) as RegisterResp;

    const session = await harness.sessionForToken(body.token);
    assert.ok(session, 'session should exist for the new user');

    // Real TCP peer is 127.0.0.1 (or ::ffff:127.0.0.1 on dual-stack).
    // Critically, NOT the spoofed 1.2.3.4.
    assert.notStrictEqual(session!.ipAddress, '1.2.3.4');
    assert.match(session!.ipAddress ?? '', /127\.0\.0\.1|::1|::ffff:127/);

    await harness.stop();
    harness = null;
  });

  it('HONORS X-Forwarded-For when the immediate peer is in trustedProxies', async () => {
    // Trust the peer that fetch will connect from. fetch() to
    // 127.0.0.1 produces a peer of 127.0.0.1 (or ::ffff:127.0.0.1 on
    // dual-stack). Allow both.
    harness = await buildHarness(['127.0.0.1', '::ffff:127.0.0.1', '::1']);

    const res = await fetch(`http://127.0.0.1:${harness.port}/auth/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The "real client" the trusted proxy is forwarding for.
        'x-forwarded-for': '5.5.5.5',
      },
      body: JSON.stringify({
        email: 'xff-trusted@example.com',
        password: 'password123',
        name: 'XFF Trusted',
      }),
    });
    const text = await res.text();
    assert.strictEqual(res.status, 201, text);
    const body = JSON.parse(text) as RegisterResp;

    const session = await harness.sessionForToken(body.token);
    assert.ok(session, 'session should exist');
    assert.strictEqual(session!.ipAddress, '5.5.5.5', 'XFF should be honored when peer is trusted');

    await harness.stop();
    harness = null;
  });
});
