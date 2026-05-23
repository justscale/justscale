/**
 * Auth middleware — edge cases.
 *
 * The `auth` middleware is the check a route consumes via `.use(auth)` to
 * gain a typed `ctx.user` and `ctx.session`. A silent bug here = the
 * downstream handler gets garbage for `ctx.user` and the permission guards
 * make the wrong call.
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import JustScale from '@justscale/core';
import { bindService, createController } from '@justscale/core';
import { ModelRepository } from '@justscale/core/models';
import { Get } from '@justscale/http/builder';
import {
  defaultHttpConfig,
  httpTransport,
  createUserSession,
} from '@justscale/http/testing';
import * as t from '@justscale/testing';
import { z } from 'zod';

import { AuthTestBundle } from '../src/testing.js';
import { AbstractEmailSender } from '../src/services/email.service.js';
import { ConsoleEmailSender } from '../src/services/email.service.js';
import { User } from '../src/models/user.js';
import { Session } from '../src/models/session.js';
import {
  SessionService,
  UserService,
} from '../src/services/index.js';
import { AuthController } from '../src/controllers/auth.controller.js';
import {
  auth,
  optionalAuth,
  AUTH_SCHEME,
  AuthenticationError,
} from '../src/middleware/auth.middleware.js';

/**
 * A minimal controller that uses `auth` so we can drive middleware with
 * real HTTP traffic.
 */
const PingResponse = z.object({
  ok: z.boolean(),
  userEmail: z.string().optional(),
  userId: z.string().optional(),
});

const TestController = createController('/test', {
  inject: {},
  routes: () => ({
    whoami: Get('/whoami')
      .use(auth)
      .returns(200, PingResponse)
      .handle(({ user, res }) => {
        res.json({
          ok: true,
          userEmail: user.email,
          userId: User.ref(user).identifier,
        });
      }),

    whoamiOptional: Get('/whoami-optional')
      .use(optionalAuth)
      .returns(200, PingResponse)
      .handle(({ user, res }) => {
        if (!user) {
          res.json({ ok: false });
          return;
        }
        res.json({
          ok: true,
          userEmail: user.email,
          userId: User.ref(user).identifier,
        });
      }),
  }),
});

async function makeApp() {
  const app = JustScale()
    .add(defaultHttpConfig)
    .add(AuthTestBundle())
    .add(TestController)
    .build()
    .compile();
  await app.ready;
  const client = await t.createTestClient(app, {
    transports: { http: httpTransport },
  });
  const typed = client.http.useControllers({
    auth: AuthController,
    test: TestController,
  });
  const sessions = await app.container.resolve(SessionService);
  const users = await app.container.resolve(UserService);
  const sessionRepo = await app.container.resolve(ModelRepository.of(Session));
  return { app, client, typed, sessions, users, sessionRepo };
}

describe('Auth middleware edge cases', () => {
  describe('auth (required)', () => {
    it('invariant: no Authorization header → 401', async () => {
      const { client, typed } = await makeApp();
      const res = await typed.api.test.whoami({});
      assert.strictEqual(res.status, 401);
      await client.close();
    });

    it('invariant: empty Authorization header string → 401 (no crash)', async () => {
      const { client } = await makeApp();
      const res = await client.http.request('/test/whoami', {
        method: 'GET',
        headers: { Authorization: '' },
      });
      // Empty string means `authHeader` is truthy-empty, falsy — handled by
      // the `!authHeader` check → 401.
      assert.strictEqual(res.status, 401);
      await client.close();
    });

    it('invariant: "Bearer" (no token) → 401', async () => {
      const { client } = await makeApp();
      const res = await client.http.request('/test/whoami', {
        method: 'GET',
        headers: { Authorization: 'Bearer ' },
      });
      assert.strictEqual(res.status, 401);
      await client.close();
    });

    it('invariant: garbage token → 401', async () => {
      const { client } = await makeApp();
      const res = await client.http.request('/test/whoami', {
        method: 'GET',
        headers: { Authorization: 'Bearer totally-not-a-real-token-abc123' },
      });
      assert.strictEqual(res.status, 401);
      await client.close();
    });

    it('invariant: Bearer + valid token → 200 and ctx.user populated', async () => {
      const { client, typed, users, sessions } = await makeApp();
      const u = await users.register('mid1@x.com', 'pw12345678', 'M');
      const s = await sessions.create(u);
      const res = await client.http.request<{
        ok: boolean
        userEmail: string
      }>('/test/whoami', {
        method: 'GET',
        headers: { Authorization: `Bearer ${s.token}` },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.ok, true);
      assert.strictEqual(res.data.userEmail, 'mid1@x.com');
      await client.close();
    });

    it('invariant: bare token without "Bearer " prefix → 401 (OAuth2-strict)', async () => {
      // Strict `Bearer <token>` matches OAuth2 tooling conventions; a
      // raw token in the Authorization header is rejected.
      const { client, users, sessions } = await makeApp();
      const u = await users.register('mid2@x.com', 'pw12345678', 'M');
      const s = await sessions.create(u);
      const res = await client.http.request(
        '/test/whoami',
        {
          method: 'GET',
          headers: { Authorization: s.token },
        },
      );
      assert.strictEqual(res.status, 401);
      await client.close();
    });

    it('invariant: expired session → 401 AND row is GC-ed', async () => {
      const { client, users, sessions, sessionRepo } = await makeApp();
      const u = await users.register('mid3@x.com', 'pw12345678', 'M');
      const s = await sessions.create(u, { ttlMs: 10 });
      await new Promise((r) => setTimeout(r, 30));
      const res = await client.http.request('/test/whoami', {
        method: 'GET',
        headers: { Authorization: `Bearer ${s.token}` },
      });
      assert.strictEqual(res.status, 401);
      // GC happens during findByToken
      const row = await sessionRepo.findOne(
        Session.fields.token.eq(s.token),
      );
      assert.strictEqual(row, undefined, 'expired session row was deleted');
      await client.close();
    });

    it('invariant: middleware bumps lastActiveAt on a valid request', async () => {
      const { client, users, sessions, sessionRepo } = await makeApp();
      const u = await users.register('mid4@x.com', 'pw12345678', 'M');
      const s = await sessions.create(u);
      const initial = s.lastActiveAt.getTime();
      await new Promise((r) => setTimeout(r, 10));

      const res = await client.http.request('/test/whoami', {
        method: 'GET',
        headers: { Authorization: `Bearer ${s.token}` },
      });
      assert.strictEqual(res.status, 200);

      const row = await sessionRepo.findOne(Session.fields.token.eq(s.token));
      assert.ok(
        row!.lastActiveAt.getTime() > initial,
        'middleware touched lastActiveAt',
      );
      await client.close();
    });

    it('disabled user → 401 even with a valid session token', async () => {
      // The middleware re-fetches the user every request. Once disabledAt
      // is set, an in-flight session token must not authenticate.
      const { app, client, users, sessions } = await makeApp();
      const u = await users.register('mw-disabled@x.com', 'pw12345678', 'D');
      const s = await sessions.create(u);
      const userRepo = await app.container.resolve(ModelRepository.of(User));

      const before = await client.http.request('/test/whoami', {
        method: 'GET',
        headers: { Authorization: `Bearer ${s.token}` },
      });
      assert.strictEqual(before.status, 200, 'sanity: pre-disable works');

      using locked = await userRepo.lock(u);
      await users.disable(locked!);

      const after = await client.http.request('/test/whoami', {
        method: 'GET',
        headers: { Authorization: `Bearer ${s.token}` },
      });
      assert.strictEqual(
        after.status,
        401,
        'disabled user must lose access immediately',
      );
      await client.close();
    });

    // The 'touch() throw → middleware swallows' test was deleted. It pinned
    // a band-aid (try/catch around touch()) that defended against a
    // logout-vs-authenticated-request race. After fix/lock-as-mutex,
    // sessionRepo.lock() takes a real mutex and the race can't happen:
    // logout's lock blocks until this middleware's lock releases. With the
    // race gone, a stub-injected throw is no longer modelling a real
    // failure mode — the test's assertion (middleware must NOT 500) was
    // pinning the band-aid, not a property of the system.

    it('invariant: case-insensitive header name — `authorization` AND `Authorization` both work', async () => {
      // HTTP header names are case-insensitive; the middleware handles both.
      const { client, users, sessions } = await makeApp();
      const u = await users.register('mid5@x.com', 'pw12345678', 'M');
      const s = await sessions.create(u);
      // fetch normalises to lowercase; the HTTP server also normalises.
      const res = await client.http.request('/test/whoami', {
        method: 'GET',
        headers: { authorization: `Bearer ${s.token}` },
      });
      assert.strictEqual(res.status, 200);
      await client.close();
    });
  });

  describe('optionalAuth', () => {
    it('invariant: no header → ctx.user === null (handler sees absent user, doesn\'t 401)', async () => {
      const { client, typed } = await makeApp();
      const res = await typed.api.test.whoamiOptional({});
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.ok, false);
      await client.close();
    });

    it('invariant: garbage token → ctx.user === null (no error, no 401)', async () => {
      const { client } = await makeApp();
      const res = await client.http.request<{ ok: boolean }>(
        '/test/whoami-optional',
        {
          method: 'GET',
          headers: { Authorization: 'Bearer totally-bogus' },
        },
      );
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.ok, false);
      await client.close();
    });

    it('invariant: valid token → ctx.user populated', async () => {
      const { client, users, sessions } = await makeApp();
      const u = await users.register('opt1@x.com', 'pw12345678', 'M');
      const s = await sessions.create(u);
      const res = await client.http.request<{
        ok: boolean
        userEmail: string
      }>('/test/whoami-optional', {
        method: 'GET',
        headers: { Authorization: `Bearer ${s.token}` },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.data.userEmail, 'opt1@x.com');
      await client.close();
    });

    it('disabled user in optionalAuth → ctx.user === null (no 401, route succeeds anonymously)', async () => {
      const { app, client, users, sessions } = await makeApp();
      const u = await users.register('opt-disabled@x.com', 'pw12345678', 'D');
      const s = await sessions.create(u);
      const userRepo = await app.container.resolve(ModelRepository.of(User));
      using locked = await userRepo.lock(u);
      await users.disable(locked!);

      const res = await client.http.request<{ ok: boolean }>(
        '/test/whoami-optional',
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${s.token}` },
        },
      );
      assert.strictEqual(res.status, 200);
      assert.strictEqual(
        res.data.ok,
        false,
        'optionalAuth treats disabled the same as no-user, not as a 401',
      );
      await client.close();
    });

    // optionalAuth's 'touch() throw → no 500' test was deleted for the
    // same reason as the `auth` one above — the race the band-aid
    // defended against is now serialized by sessionRepo.lock().

    it('invariant: expired token in optionalAuth → ctx.user === null', async () => {
      const { client, users, sessions } = await makeApp();
      const u = await users.register('opt2@x.com', 'pw12345678', 'M');
      const s = await sessions.create(u, { ttlMs: 10 });
      await new Promise((r) => setTimeout(r, 30));

      const res = await client.http.request<{ ok: boolean }>(
        '/test/whoami-optional',
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${s.token}` },
        },
      );
      assert.strictEqual(res.status, 200);
      assert.strictEqual(
        res.data.ok,
        false,
        'optionalAuth treats expired as "no user", not 401',
      );
      await client.close();
    });
  });

  describe('AUTH_SCHEME metadata', () => {
    it('auth middleware has AUTH_SCHEME with required: true', () => {
      const meta = (auth as unknown as Record<symbol, { required: boolean }>)[
        AUTH_SCHEME
      ];
      assert.ok(meta, 'auth carries AUTH_SCHEME metadata');
      assert.strictEqual(meta.required, true);
    });

    it('optionalAuth has AUTH_SCHEME with required: false', () => {
      const meta = (
        optionalAuth as unknown as Record<symbol, { required: boolean }>
      )[AUTH_SCHEME];
      assert.ok(meta);
      assert.strictEqual(meta.required, false);
    });
  });

  describe('AuthenticationError', () => {
    it('has statusCode 401 and name "AuthenticationError"', () => {
      const err = new AuthenticationError('nope');
      assert.strictEqual(err.statusCode, 401);
      assert.strictEqual(err.name, 'AuthenticationError');
      assert.strictEqual(err.message, 'nope');
      assert.ok(err instanceof Error);
    });
  });
});
