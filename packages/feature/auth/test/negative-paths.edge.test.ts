/**
 * Negative paths — security-critical failure modes.
 *
 * These tests exercise what happens when something OBVIOUS is forgotten:
 *   - a handler that doesn't use auth middleware (then reads ctx.user)
 *   - a route that tries to use `requireAuth` without `auth` first
 *   - a disabled/inactive user pattern (currently unsupported — pin gap)
 *
 * If these behaviours are silently "succeed with undefined", auth is
 * cosmetic.
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import JustScale from '@justscale/core';
import { createController } from '@justscale/core';
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
import { User } from '../src/models/user.js';
import { Session } from '../src/models/session.js';
import {
  SessionService,
  UserService,
} from '../src/services/index.js';
import {
  AuthController,
  PasswordController,
  TwoFactorController,
} from '../src/controllers/index.js';
import {
  auth,
  optionalAuth,
} from '../src/middleware/auth.middleware.js';
import {
  requireAuth,
  requireVerifiedEmail,
  requireSelf,
} from '../src/guards/auth.guards.js';

const OkResponse = z.object({
  ok: z.boolean(),
  hadUser: z.boolean().optional(),
  verified: z.boolean().optional(),
});

/**
 * Controllers that represent "forgetful" integrations — NO auth middleware
 * where one should be. Pins what happens when the developer forgets.
 */
const NoAuthCtx = createController('/neg', {
  inject: {},
  routes: () => ({
    /**
     * Handler assumes ctx.user exists but no middleware sets it.
     * This is the "I forgot .use(auth)" footgun.
     */
    blindRead: Get('/blind-read')
      .returns(200, OkResponse)
      .handle((ctx: Record<string, unknown>) => {
        const res = ctx.res as {
          json: (b: unknown) => void
        };
        // Without `.use(auth)`, ctx.user is NOT there.
        // Pin: accessing it returns undefined, does NOT throw.
        const hadUser = (ctx as { user?: unknown }).user !== undefined;
        res.json({ ok: true, hadUser });
      }),

    /**
     * A guard that would normally follow auth — here it runs WITHOUT
     * auth to confirm the guard still denies (doesn't silently pass).
     */
    guardWithoutAuth: Get('/guard-without-auth')
      .guard(requireAuth)
      .returns(200, OkResponse)
      .handle((ctx) => {
        (ctx.res as { json: (b: unknown) => void }).json({ ok: true });
      }),

    /**
     * Auth middleware + requireVerifiedEmail — unverified user is denied.
     */
    requireVerified: Get('/require-verified')
      .use(auth)
      .guard(requireVerifiedEmail)
      .returns(200, OkResponse)
      .handle((ctx) => {
        (ctx.res as { json: (b: unknown) => void }).json({
          ok: true,
          verified: true,
        });
      }),
  }),
});

async function makeClient() {
  const app = JustScale()
    .add(defaultHttpConfig)
    .add(AuthTestBundle())
    .add(NoAuthCtx)
    .build()
    .compile();
  await app.ready;
  const client = await t.createTestClient(app, {
    transports: { http: httpTransport },
  });
  const typed = client.http.useControllers({
    auth: AuthController,
    twofa: TwoFactorController,
    password: PasswordController,
    neg: NoAuthCtx,
  });
  const sessions = await app.container.resolve(SessionService);
  const users = await app.container.resolve(UserService);
  const userRepo = await app.container.resolve(ModelRepository.of(User));
  const sessionRepo = await app.container.resolve(
    ModelRepository.of(Session),
  );
  return { app, client, typed, sessions, users, userRepo, sessionRepo };
}

describe('Negative paths (security-critical)', () => {
  describe('forgot-to-use-auth footgun', () => {
    it('invariant: handler that reads ctx.user WITHOUT `.use(auth)` sees undefined', async () => {
      // Silent bug: if middleware auto-runs somehow, `.use(auth)` becomes
      // cosmetic and removing it still gives a user. Pin that the
      // absence matters.
      const { client, typed } = await makeClient();
      const res = await typed.api.neg.blindRead({});
      assert.strictEqual(res.status, 200);
      assert.strictEqual(
        res.data.hadUser,
        false,
        'no middleware → no ctx.user; handler must see undefined',
      );
      await client.close();
    });

    it('invariant: WITH valid bearer, but route has NO `.use(auth)` → still no ctx.user', async () => {
      // Extra scary footgun: sending a token doesn't magically authenticate
      // a route that didn't declare auth. Confirm.
      const { client, typed, users, sessions } = await makeClient();
      const u = await users.register('neg1@x.com', 'pw12345678', 'N');
      const s = await sessions.create(u);
      const res = await client.http.request<{
        ok: boolean
        hadUser?: boolean
      }>('/neg/blind-read', {
        method: 'GET',
        headers: { Authorization: `Bearer ${s.token}` },
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(
        res.data.hadUser,
        false,
        'bearer token does not auto-populate ctx.user without middleware',
      );
      await client.close();
    });
  });

  describe('guard without upstream auth', () => {
    it('invariant: `requireAuth` guard with no `.use(auth)` — guard must DENY (pin shape)', async () => {
      // Why this matters: `requireAuth` checks `ctx.user != null`. If a
      // middleware-absent route somehow had a partially-set context, the
      // guard could silently pass. Pin that request is denied/errored.
      const { client } = await makeClient();
      // Use raw HTTP so we don't hit the typed response narrowing.
      const res = await client.http.get('/neg/guard-without-auth');
      // With no middleware, ctx.user is undefined; requireAuth returns
      // false → framework returns 403 (guard-deny).
      const status: number = res.status;
      assert.ok(
        status === 403 || status === 401 || status === 500,
        `expected denied request (401/403/500), got ${status}`,
      );
      assert.notStrictEqual(
        status,
        200,
        'a missing-auth route MUST NOT return 200 from a guarded handler',
      );
      await client.close();
    });
  });

  describe('requireVerifiedEmail', () => {
    it('invariant: unverified user cannot reach a .guard(requireVerifiedEmail) handler', async () => {
      const { client, typed, users, sessions } = await makeClient();
      const u = await users.register('verif-gate@x.com', 'pw12345678', 'V');
      const s = await sessions.create(u);
      const res = await client.http.request('/neg/require-verified', {
        method: 'GET',
        headers: { Authorization: `Bearer ${s.token}` },
      });
      // Unverified → guard denies (403). Pin that the handler never ran.
      assert.ok(
        res.status === 403 || res.status === 401,
        `unverified user must be rejected (401/403), got ${res.status}`,
      );
      await client.close();
    });

    it('invariant: verified user passes the guard', async () => {
      // Auth middleware re-fetches the user every request, so the guard
      // sees `emailVerifiedAt` on the fresh row — no stale session
      // snapshot causing a false 403.
      const { client, users, userRepo, sessions } = await makeClient();
      const u = await users.register('verif-ok@x.com', 'pw12345678', 'V');
      using locked = await userRepo.lock(u);
      await users.verifyEmail(locked!);
      const verified = await userRepo.findOne(
        User.fields.email.eq('verif-ok@x.com'),
      );
      assert.ok(verified!.emailVerifiedAt, 'sanity: user row is verified');
      const s = await sessions.create(verified!);

      const res = await client.http.request<{ ok: boolean }>(
        '/neg/require-verified',
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${s.token}` },
        },
      );

      assert.strictEqual(
        res.status,
        200,
        'verified user reaches the handler',
      );
      await client.close();
    });
  });

  describe('disabled/deleted user accessing their old session token', () => {
    it('deleting the user invalidates their active session on /auth/me', async () => {
      // The /auth/me inline middleware re-fetches the user from userRepo
      // on every request (rather than trusting the snapshot stored on
      // session.user), so a deleted user's session reports 401.
      const { client, typed, users, userRepo } = await makeClient();
      const session = createUserSession(typed, {
        captureToken: (route, res) =>
          route === 'auth.register' ? res.data?.token : undefined,
      });
      await session.api.auth.register({
        email: 'del@x.com',
        password: 'pw12345678',
      });
      const u = await users.findByEmail('del@x.com');
      using locked = await userRepo.lock(u!);
      await userRepo.delete(locked!);

      const res = await session.api.auth.me({});
      assert.strictEqual(
        res.status,
        401,
        'deleted user → session no longer authenticates',
      );
      await client.close();
    });
  });

  describe('soft-disable via disabledAt timestamp', () => {
    // Resolved: User now has `disabledAt: timestamp.optional()`.
    // Setting it short-circuits authenticate() and rejects existing
    // sessions in the auth middleware on next request.

    it('User model has the disabledAt field', () => {
      assert.ok(
        'disabledAt' in User.fields,
        'User has a disabledAt field for soft-disable',
      );
    });

    it('disabled user cannot login (looks identical to wrong credentials)', async () => {
      const { client, typed, users, userRepo } = await makeClient();
      const u = await users.register('disabled@x.com', 'pw12345678', 'D');
      using locked = await userRepo.lock(u);
      await users.disable(locked!);

      const res = await typed.api.auth.login({
        email: 'disabled@x.com',
        password: 'pw12345678',
      });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(
        (res.data as { code: string }).code,
        'INVALID_CREDENTIALS',
        'disabled looks identical to wrong-password — no enumeration leak',
      );
      await client.close();
    });

    it('existing session is rejected on next request after disable', async () => {
      const { client, typed, users, sessions, userRepo } = await makeClient();
      const u = await users.register('disable-live@x.com', 'pw12345678', 'D');
      const s = await sessions.create(u);

      // Sanity: session works before disable.
      const before = await client.http.request('/auth/me', {
        method: 'GET',
        headers: { Authorization: `Bearer ${s.token}` },
      });
      assert.strictEqual(before.status, 200);

      using locked = await userRepo.lock(u);
      await users.disable(locked!);

      // Same session token, same request — now 401.
      const after = await client.http.request('/auth/me', {
        method: 'GET',
        headers: { Authorization: `Bearer ${s.token}` },
      });
      assert.strictEqual(
        after.status,
        401,
        'disabled user must lose access immediately, not on session expiry',
      );
      await client.close();
    });

    it('enable() restores access', async () => {
      const { client, typed, users, sessions, userRepo } = await makeClient();
      const u = await users.register('reenable@x.com', 'pw12345678', 'R');
      // Block-scope the lock so it releases before login() — login
      // re-locks the user internally to update lastLoginAt and would
      // deadlock against an outer test lock.
      {
        using locked = await userRepo.lock(u);
        await users.disable(locked!);
      }

      // Can't login while disabled.
      const denied = await typed.api.auth.login({
        email: 'reenable@x.com',
        password: 'pw12345678',
      });
      assert.strictEqual(denied.status, 401);

      // Re-enable — same block-scope discipline.
      {
        using lockedAgain = await userRepo.lock(u);
        await users.enable(lockedAgain!);
      }

      const allowed = await typed.api.auth.login({
        email: 'reenable@x.com',
        password: 'pw12345678',
      });
      assert.strictEqual(allowed.status, 200);
      await client.close();
    });
  });

  describe('requireSelf guard', () => {
    it('invariant: requireSelf(paramName) check passes when param matches ctx.user id', async () => {
      const { client, app } = await makeClient();
      const users = await app.container.resolve(UserService);
      const u = await users.register('self@x.com', 'pw12345678', 'S');

      // createGuard returns a GuardDef with `factory` (no deps in our case).
      const g = requireSelf('userId') as unknown as {
        factory: (deps: Record<string, never>) => (ctx: unknown) => boolean
      };
      const check = g.factory({});
      assert.strictEqual(typeof check, 'function');

      assert.strictEqual(
        check({
          params: { userId: User.ref(u).identifier },
          user: u,
          session: {} as unknown,
        }),
        true,
        'matching id passes',
      );

      assert.strictEqual(
        check({
          params: { userId: 'someone-else-entirely' },
          user: u,
          session: {} as unknown,
        }),
        false,
        'non-matching id denied',
      );
      await client.close();
    });
  });

  describe('AuthTestBundle scope sanity', () => {
    it('PINNED: AuthTestBundle does NOT pull in permission feature by default', async () => {
      // todo LOW: sanity-check that AuthTestBundle is scoped to auth only.
      // If a future change silently pulls in PermissionsFeature, auth
      // tests suddenly start hitting guard-deny at 403 for no reason.
      // Pin the scope.
      const { app, client } = await makeClient();
      // Walk the app's controllers — none should be permission-related.
      for (const ctrl of app.controllers) {
        const def = (ctrl as unknown as { __def?: { name?: string } }).__def;
        const name = def?.name ?? '';
        assert.ok(
          !name.toLowerCase().includes('permission'),
          `AuthTestBundle leaked a permission controller: ${name}`,
        );
      }
      await client.close();
    });
  });
});
