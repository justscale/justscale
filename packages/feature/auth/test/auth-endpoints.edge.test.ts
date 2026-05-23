/**
 * AuthEndpointsFeature — HTTP integration edge cases.
 *
 * This validates the wiring between controllers, services, schemas, and
 * the HTTP layer. Bugs here are silent 500s that get logged but still
 * succeed at the attack level.
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import JustScale from '@justscale/core';
import { ModelRepository } from '@justscale/core/models';
import {
  defaultHttpConfig,
  httpTransport,
  createUserSession,
} from '@justscale/http/testing';
import * as t from '@justscale/testing';

import { AuthTestBundle } from '../src/testing.js';
import { User } from '../src/models/user.js';
import {
  SessionService,
  UserService,
} from '../src/services/index.js';
import {
  AuthController,
  PasswordController,
  TwoFactorController,
} from '../src/controllers/index.js';

async function makeClient() {
  const app = JustScale()
    .add(defaultHttpConfig)
    .add(AuthTestBundle())
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
  });
  const users = await app.container.resolve(UserService);
  const sessions = await app.container.resolve(SessionService);
  const userRepo = await app.container.resolve(ModelRepository.of(User));
  return { app, client, typed, users, sessions, userRepo };
}

describe('AuthEndpoints edge cases', () => {
  describe('POST /auth/register', () => {
    it('invariant: missing email → 400 (Zod validation)', async () => {
      const { client } = await makeClient();
      const res = await client.http.post('/auth/register', {
        password: 'pw12345678',
      });
      assert.ok(res.status >= 400 && res.status < 500, `got ${res.status}`);
      await client.close();
    });

    it('invariant: password shorter than 8 → 400', async () => {
      const { client } = await makeClient();
      const res = await client.http.post('/auth/register', {
        email: 'short@x.com',
        password: 'abc',
      });
      assert.ok(res.status >= 400 && res.status < 500, `got ${res.status}`);
      await client.close();
    });

    it('invariant: invalid email format → 400', async () => {
      const { client } = await makeClient();
      const res = await client.http.post('/auth/register', {
        email: 'not-an-email',
        password: 'pw12345678',
      });
      assert.ok(res.status >= 400 && res.status < 500);
      await client.close();
    });

    it('invariant: successful register → 201 + user DTO + token; no passwordHash in response', async () => {
      const { client, typed } = await makeClient();
      const res = await typed.api.auth.register({
        email: 'reg1@x.com',
        password: 'pw12345678',
        name: 'Reg',
      });
      assert.strictEqual(res.status, 201);
      assert.ok('token' in res.data);
      assert.ok('user' in res.data);
      const body = JSON.stringify(res.data);
      assert.ok(!body.includes('passwordHash'));
      assert.ok(!body.includes('pw12345678'));
      await client.close();
    });

    it('invariant: duplicate email → 409 with code USER_EXISTS', async () => {
      const { client, typed } = await makeClient();
      await typed.api.auth.register({
        email: 'dup@x.com',
        password: 'pw12345678',
      });
      const res = await typed.api.auth.register({
        email: 'dup@x.com',
        password: 'pw12345678',
      });
      assert.strictEqual(res.status, 409);
      assert.strictEqual((res.data as { code: string }).code, 'USER_EXISTS');
      await client.close();
    });

    it('invariant: body is NOT a JSON object → 4xx (no crash)', async () => {
      const { client } = await makeClient();
      const res = await client.http.request('/auth/register', {
        method: 'POST',
        body: 'not-json-at-all',
      });
      assert.ok(
        res.status >= 400 && res.status < 500,
        `got ${res.status} for non-JSON body`,
      );
      await client.close();
    });
  });

  describe('POST /auth/login', () => {
    it('invariant: fresh login → 200 + token', async () => {
      const { client, typed } = await makeClient();
      await typed.api.auth.register({
        email: 'log1@x.com',
        password: 'pw12345678',
      });
      const res = await typed.api.auth.login({
        email: 'log1@x.com',
        password: 'pw12345678',
      });
      assert.strictEqual(res.status, 200);
      assert.ok('token' in res.data);
      await client.close();
    });

    it('invariant: wrong password → 401 + code INVALID_CREDENTIALS', async () => {
      const { client, typed } = await makeClient();
      await typed.api.auth.register({
        email: 'log2@x.com',
        password: 'pw12345678',
      });
      const res = await typed.api.auth.login({
        email: 'log2@x.com',
        password: 'wrong',
      });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(
        (res.data as { code: string }).code,
        'INVALID_CREDENTIALS',
      );
      await client.close();
    });

    it('invariant: non-existent email → 401 same response shape (no leak)', async () => {
      const { client, typed } = await makeClient();
      const res = await typed.api.auth.login({
        email: 'nobody@x.com',
        password: 'anything',
      });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(
        (res.data as { code: string }).code,
        'INVALID_CREDENTIALS',
      );
      await client.close();
    });

    it('invariant: 2FA-enabled user → 202 + requires2FA:true + userId; token MUST NOT be issued', async () => {
      // Silent bug: if this returned 200 with a token, the attacker with
      // just email+password bypasses 2FA entirely.
      const { client, typed, userRepo, users } = await makeClient();
      await typed.api.auth.register({
        email: 'tfa1@x.com',
        password: 'pw12345678',
      });
      // Simulate an enabled 2FA state directly via repo update —
      // a valid-looking base32 secret, flag on. Block-scope the lock
      // so it releases before login (which re-locks the user).
      const u = await users.findByEmail('tfa1@x.com');
      {
        using locked = await userRepo.lock(u!);
        await userRepo.update(locked!, {
          twoFactorEnabled: true,
          twoFactorSecret: 'JBSWY3DPEHPK3PXP',
        });
      }

      const res = await typed.api.auth.login({
        email: 'tfa1@x.com',
        password: 'pw12345678',
      });
      assert.strictEqual(res.status, 202);
      const body = res.data as { requires2FA?: boolean; userId?: string };
      assert.strictEqual(body.requires2FA, true);
      assert.ok(body.userId, 'userId in 2FA gate response');
      assert.ok(
        !('token' in (body as Record<string, unknown>)),
        'MUST NOT include token at 2FA gate — pre-2FA login is just a bypass signal otherwise',
      );
      await client.close();
    });
  });

  describe('POST /auth/logout', () => {
    it('invariant: with valid token → 200 + session revoked', async () => {
      const { client, typed } = await makeClient();
      const session = createUserSession(typed, {
        captureToken: (route, res) =>
          route === 'auth.register' ? res.data?.token : undefined,
      });
      await session.api.auth.register({
        email: 'out1@x.com',
        password: 'pw12345678',
      });
      const res = await session.api.auth.logout({});
      assert.strictEqual(res.status, 200);

      // Using the same token again → 401
      const me = await session.api.auth.me({});
      assert.strictEqual(me.status, 401);
      await client.close();
    });

    it('invariant: logout twice with same token → second one is 401', async () => {
      const { client, typed } = await makeClient();
      const session = createUserSession(typed, {
        captureToken: (route, res) =>
          route === 'auth.register' ? res.data?.token : undefined,
      });
      await session.api.auth.register({
        email: 'out2@x.com',
        password: 'pw12345678',
      });
      const first = await session.api.auth.logout({});
      assert.strictEqual(first.status, 200);
      const second = await session.api.auth.logout({});
      assert.strictEqual(second.status, 401);
      await client.close();
    });

    it('invariant: logout with no token → 401 (no crash)', async () => {
      const { client, typed } = await makeClient();
      const res = await typed.api.auth.logout({});
      assert.strictEqual(res.status, 401);
      await client.close();
    });
  });

  describe('POST /auth/login/2fa — negative paths', () => {
    // Coverage gap: auth.controller.ts only tested the happy path of
    // login2FA. The four 4xx branches (unknown user, no 2fa secret, locked,
    // wrong code) shipped at 0% branch coverage on the second-most-sensitive
    // endpoint in the framework. Each is its own response shape and code —
    // a regression that collapsed any of them into a generic 500 would still
    // pass auth-controllers.e2e.test.ts.

    it('unknown userId → 401 INVALID_REQUEST (no leak about user existence)', async () => {
      const { client, typed } = await makeClient();
      const res = await typed.api.auth.login2FA({
        userId: 'nobody-at-all',
        code: '000000',
      });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(
        (res.data as { code: string }).code,
        'INVALID_REQUEST',
      );
      await client.close();
    });

    it('user exists but 2FA never set up → 401 INVALID_REQUEST (no twoFactorSecret)', async () => {
      // Pins the `!user.twoFactorSecret` branch — a registered user who
      // never enabled 2FA must still fail this endpoint cleanly. A bug
      // here would call verifyTOTPForUser(secret=undefined) and crash.
      const { client, typed, users } = await makeClient();
      const u = await users.register('no2fa@x.com', 'pw12345678', 'N');
      const res = await typed.api.auth.login2FA({
        userId: User.ref(u).identifier,
        code: '000000',
      });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(
        (res.data as { code: string }).code,
        'INVALID_REQUEST',
      );
      await client.close();
    });

    it('locked-out user → 429 MFA_LOCKED (does NOT fall through to 401)', async () => {
      // Pins the rate-limit branch — twoFactorLockedUntil in the future
      // short-circuits BEFORE any code comparison. Critical that this
      // surfaces as a distinct status (429) so the client can show the
      // right message; collapsing it into 401 would re-open the brute
      // force window.
      const { client, typed, users, userRepo } = await makeClient();
      const u = await users.register('locked@x.com', 'pw12345678', 'L');
      {
        using locked = await userRepo.lock(u);
        await userRepo.update(locked!, {
          twoFactorEnabled: true,
          twoFactorSecret: 'JBSWY3DPEHPK3PXP',
          twoFactorLockedUntil: new Date(Date.now() + 60_000),
        });
      }
      const res = await typed.api.auth.login2FA({
        userId: User.ref(u).identifier,
        code: '000000',
      });
      assert.strictEqual(res.status, 429);
      assert.strictEqual((res.data as { code: string }).code, 'MFA_LOCKED');
      await client.close();
    });

    it('wrong code → 401 INVALID_2FA_CODE', async () => {
      const { client, typed, users, userRepo } = await makeClient();
      const u = await users.register('wrong2fa@x.com', 'pw12345678', 'W');
      {
        using locked = await userRepo.lock(u);
        await userRepo.update(locked!, {
          twoFactorEnabled: true,
          twoFactorSecret: 'JBSWY3DPEHPK3PXP',
        });
      }
      const res = await typed.api.auth.login2FA({
        userId: User.ref(u).identifier,
        code: '000000', // statistically can't match a 30s TOTP window
      });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(
        (res.data as { code: string }).code,
        'INVALID_2FA_CODE',
      );
      await client.close();
    });

    it('falls back to email lookup when userId is actually an email', async () => {
      // Pins the `?? users.findByEmail(body.userId)` branch — the
      // endpoint accepts either user-id or email in the userId slot,
      // because the 202-from-/login response sometimes hands back the
      // identifier and clients shouldn't have to know which is which.
      const { client, typed, users, userRepo } = await makeClient();
      const u = await users.register('byemail@x.com', 'pw12345678', 'E');
      {
        using locked = await userRepo.lock(u);
        await userRepo.update(locked!, {
          twoFactorEnabled: true,
          twoFactorSecret: 'JBSWY3DPEHPK3PXP',
        });
      }
      const res = await typed.api.auth.login2FA({
        userId: 'byemail@x.com',
        code: '000000',
      });
      // Reaches the verify path → 401 INVALID_2FA_CODE (not 401
      // INVALID_REQUEST, which would mean the lookup failed).
      assert.strictEqual(res.status, 401);
      assert.strictEqual(
        (res.data as { code: string }).code,
        'INVALID_2FA_CODE',
      );
      await client.close();
    });
  });

  describe('inline middleware Bearer parsing (logout/me/change-password)', () => {
    // Coverage gap: each of logout/me/changePassword inlines its own
    // middleware (instead of using `.use(auth)`). Three near-identical
    // copies of the Bearer-parsing branches, all uncovered. A drift here
    // (one accidentally accepting "Basic xxx", say) would be a real
    // auth bypass and shouldn't slip past.

    for (const route of ['/auth/logout', '/auth/me', '/auth/change-password'] as const) {
      const method = route === '/auth/me' ? 'GET' : 'POST';

      it(`${method} ${route}: non-Bearer scheme → 401 (not silently accepted)`, async () => {
        const { client } = await makeClient();
        const res = await client.http.request(route, {
          method,
          headers: { Authorization: 'Basic dXNlcjpwYXNz' },
        });
        assert.strictEqual(res.status, 401);
        await client.close();
      });

      it(`${method} ${route}: empty token after "Bearer " → 401`, async () => {
        const { client } = await makeClient();
        const res = await client.http.request(route, {
          method,
          headers: { Authorization: 'Bearer ' },
        });
        assert.strictEqual(res.status, 401);
        await client.close();
      });
    }
  });

  describe('GET /auth/me + change-password — invalid token / deleted user', () => {
    // Coverage gap: the `!session` and `!user` branches in the inline
    // middleware for /me and /change-password were never hit on the
    // changePassword path (they had `me` coverage via negative-paths,
    // but not changePassword).

    it('change-password with bogus token → 401 (session lookup fails)', async () => {
      const { client } = await makeClient();
      const res = await client.http.request('/auth/change-password', {
        method: 'POST',
        headers: { Authorization: 'Bearer not-a-real-token-at-all' },
        body: JSON.stringify({
          currentPassword: 'x',
          newPassword: 'newpw98765',
        }),
      });
      assert.strictEqual(res.status, 401);
      await client.close();
    });

    it('change-password with deleted user but live session → 401 (user lookup fails)', async () => {
      // The session is real; the user row gets removed underneath.
      // Pins the `!user` branch in the inline middleware.
      const { client, users, sessions, userRepo } = await makeClient();
      const u = await users.register('cpdel@x.com', 'pw12345678', 'D');
      const s = await sessions.create(u);
      using locked = await userRepo.lock(u);
      await userRepo.delete(locked!);

      const res = await client.http.request('/auth/change-password', {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.token}` },
        body: JSON.stringify({
          currentPassword: 'pw12345678',
          newPassword: 'newpw98765',
        }),
      });
      assert.strictEqual(res.status, 401);
      await client.close();
    });
  });

  describe('POST /auth/verify-email', () => {
    it('invariant: unknown userId → 200 (fire-and-forget semantics); verification NOT flipped', async () => {
      // Silent bug: if this returned 4xx, the endpoint leaks whether a
      // userId is registered. By design it's fire-and-forget.
      const { client, typed, userRepo } = await makeClient();
      const res = await typed.api.auth.verifyEmail({
        userId: 'nobody',
        token: 'any-token',
      });
      assert.strictEqual(res.status, 200);

      // Confirm no one's emailVerifiedAt got set
      const all = await userRepo.find();
      for (const u of all) {
        assert.strictEqual(
          u.emailVerifiedAt,
          undefined,
          'no one should be verified from an unknown-userId signal',
        );
      }
      await client.close();
    });

    it('invariant: valid userId + WRONG token → 200 still (process handles, user stays unverified)', async () => {
      // Fire-and-forget at the HTTP layer means any token returns 200;
      // the process inside validates. Pin this so a future rewrite
      // doesn't start leaking success vs failure via status codes.
      const { client, typed, userRepo } = await makeClient();
      await typed.api.auth.register({
        email: 'vem1@x.com',
        password: 'pw12345678',
      });
      const u = await userRepo.findOne(User.fields.email.eq('vem1@x.com'));
      const res = await typed.api.auth.verifyEmail({
        userId: User.ref(u!).identifier,
        token: 'wrong-token-definitely',
      });
      assert.strictEqual(res.status, 200);
      // User stays unverified
      const again = await userRepo.findOne(User.fields.email.eq('vem1@x.com'));
      assert.strictEqual(again!.emailVerifiedAt, undefined);
      await client.close();
    });
  });

  describe('POST /auth/change-password', () => {
    it('invariant: requires auth → 401 without token', async () => {
      const { client, typed } = await makeClient();
      const res = await typed.api.auth.changePassword({
        currentPassword: 'any',
        newPassword: 'newpw12345',
      });
      assert.strictEqual(res.status, 401);
      await client.close();
    });

    it('invariant: wrong currentPassword → 401 + INVALID_PASSWORD', async () => {
      const { client, typed } = await makeClient();
      const session = createUserSession(typed, {
        captureToken: (route, res) =>
          route === 'auth.register' ? res.data?.token : undefined,
      });
      await session.api.auth.register({
        email: 'cp1@x.com',
        password: 'correctpw123',
      });
      const res = await session.api.auth.changePassword({
        currentPassword: 'wrongpw',
        newPassword: 'newpw12345',
      });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(
        (res.data as { code: string }).code,
        'INVALID_PASSWORD',
      );
      await client.close();
    });

    it('invariant: successful change → new password logs in, old one does NOT', async () => {
      const { client, typed } = await makeClient();
      const session = createUserSession(typed, {
        captureToken: (route, res) =>
          route === 'auth.register' ? res.data?.token : undefined,
      });
      await session.api.auth.register({
        email: 'cp2@x.com',
        password: 'oldpw12345',
      });
      await session.api.auth.changePassword({
        currentPassword: 'oldpw12345',
        newPassword: 'newpw98765',
      });
      const loginWithNew = await typed.api.auth.login({
        email: 'cp2@x.com',
        password: 'newpw98765',
      });
      assert.strictEqual(loginWithNew.status, 200);
      const loginWithOld = await typed.api.auth.login({
        email: 'cp2@x.com',
        password: 'oldpw12345',
      });
      assert.strictEqual(loginWithOld.status, 401);
      await client.close();
    });

    it('change-password revokes OTHER sessions but keeps the caller alive', async () => {
      // Changing the password kicks out an attacker who may have stolen
      // a session cookie. The caller's own session stays alive so they
      // don't have to log back in on the current device.
      const { client, typed } = await makeClient();
      await typed.api.auth.register({
        email: 'cp3@x.com',
        password: 'initialpw12',
      });
      const loginA = await typed.api.auth.login({
        email: 'cp3@x.com',
        password: 'initialpw12',
      });
      const loginB = await typed.api.auth.login({
        email: 'cp3@x.com',
        password: 'initialpw12',
      });
      const tokenA = (loginA.data as { token: string }).token;
      const tokenB = (loginB.data as { token: string }).token;

      const change = await client.http.request('/auth/change-password', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tokenA}` },
        body: JSON.stringify({
          currentPassword: 'initialpw12',
          newPassword: 'secondpw98',
        }),
      });
      assert.strictEqual(change.status, 200);

      // Session A (the caller) still works.
      const meA = await client.http.request('/auth/me', {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenA}` },
      });
      assert.strictEqual(meA.status, 200, 'caller session survives');

      // Session B (other device) was revoked.
      const meB = await client.http.request('/auth/me', {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenB}` },
      });
      assert.strictEqual(
        meB.status,
        401,
        'other session revoked on password change',
      );
      await client.close();
    });
  });

  describe('wiring: AuthEndpointsFeature provides all three controllers', () => {
    it('all 3 controllers resolve from the test app', async () => {
      const { app, client } = await makeClient();
      const auth = app.controllers.find(
        (c) => (c as { __def?: unknown }).__def === AuthController,
      );
      const pw = app.controllers.find(
        (c) => (c as { __def?: unknown }).__def === PasswordController,
      );
      const tfa = app.controllers.find(
        (c) => (c as { __def?: unknown }).__def === TwoFactorController,
      );
      assert.ok(auth, 'AuthController registered');
      assert.ok(pw, 'PasswordController registered');
      assert.ok(tfa, 'TwoFactorController registered');
      await client.close();
    });
  });
});
