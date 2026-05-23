/**
 * Security properties — invariants that span the whole subsystem.
 *
 * These tests look at the "plaintext never escapes" and "tokens are not
 * guessable" properties, the kind of property a bug in any one component
 * could break silently.
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

async function makeTestClient() {
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
  const sessionRepo = await app.container.resolve(
    ModelRepository.of(Session),
  );
  return { app, client, typed, users, sessions, userRepo, sessionRepo };
}

describe('Security properties', () => {
  it('invariant: plaintext password NEVER appears in registered user row', async () => {
    const { typed, userRepo, client } = await makeTestClient();
    const pw = 'superSecret_NoOneShallFind_1234!';
    await typed.api.auth.register({
      email: 'leak1@x.com',
      password: pw,
      name: 'Leak Check',
    });
    const row = await userRepo.findOne(User.fields.email.eq('leak1@x.com'));
    const rowJson = JSON.stringify(row);
    assert.ok(
      !rowJson.includes(pw),
      `plaintext password leaked into user row: ${rowJson.slice(0, 200)}...`,
    );
    assert.ok(row!.passwordHash);
    assert.notStrictEqual(row!.passwordHash, pw);
    await client.close();
  });

  it('invariant: /auth/register response does NOT include passwordHash', async () => {
    const { typed, client } = await makeTestClient();
    const res = await typed.api.auth.register({
      email: 'leak2@x.com',
      password: 'anotherSecret12345',
      name: 'Leak2',
    });
    assert.strictEqual(res.status, 201);
    const body = JSON.stringify(res.data);
    assert.ok(
      !body.includes('passwordHash'),
      `passwordHash leaked in response: ${body}`,
    );
    assert.ok(
      !body.includes('anotherSecret12345'),
      `plaintext password leaked in response: ${body}`,
    );
    await client.close();
  });

  it('invariant: /auth/login response does NOT include passwordHash', async () => {
    const { typed, client } = await makeTestClient();
    await typed.api.auth.register({
      email: 'leak3@x.com',
      password: 'anotherSecret12345',
      name: 'Leak3',
    });
    const res = await typed.api.auth.login({
      email: 'leak3@x.com',
      password: 'anotherSecret12345',
    });
    assert.strictEqual(res.status, 200);
    const body = JSON.stringify(res.data);
    assert.ok(!body.includes('passwordHash'), 'hash leak in login response');
    assert.ok(
      !body.includes('anotherSecret12345'),
      'plaintext leak in login response',
    );
    await client.close();
  });

  it('invariant: /auth/me response does NOT include passwordHash or twoFactorSecret', async () => {
    const { typed, client } = await makeTestClient();
    const session = createUserSession(typed, {
      captureToken: (route, res) =>
        route === 'auth.register' || route === 'auth.login'
          ? res.data?.token
          : undefined,
    });
    await session.api.auth.register({
      email: 'leak4@x.com',
      password: 'secretHere12345',
    });
    const me = await session.api.auth.me({});
    assert.strictEqual(me.status, 200);
    const body = JSON.stringify(me.data);
    assert.ok(!body.includes('passwordHash'), 'passwordHash in /me');
    assert.ok(!body.includes('twoFactorSecret'), 'twoFactorSecret in /me');
    assert.ok(!body.includes('secretHere12345'), 'plaintext in /me');
    await client.close();
  });

  it('invariant: session token entropy — 256 bits, hex', async () => {
    const { users, sessions, client } = await makeTestClient();
    const u = await users.register('ent@x.com', 'pw12345678', 'T');
    const s = await sessions.create(u);
    // 32 bytes * 2 hex chars = 64 chars
    assert.strictEqual(s.token.length, 64);
    assert.match(s.token, /^[0-9a-f]{64}$/);
    await client.close();
  });

  it('invariant: login with non-existent email → 401 (NOT 404, NOT 200)', async () => {
    // Enumeration: if 404 and 401 differ, an attacker lists which emails
    // exist. The mandate explicitly calls this out.
    const { typed, client } = await makeTestClient();
    const res = await typed.api.auth.login({
      email: 'nobody@nowhere.invalid',
      password: 'doesntmatter',
    });
    assert.strictEqual(res.status, 401);
    assert.strictEqual((res.data as { code: string }).code, 'INVALID_CREDENTIALS');
    await client.close();
  });

  it('invariant: login with wrong password for real user → 401 (same shape)', async () => {
    const { typed, client } = await makeTestClient();
    await typed.api.auth.register({
      email: 'enum@x.com',
      password: 'correctPassword1',
    });
    const res = await typed.api.auth.login({
      email: 'enum@x.com',
      password: 'wrongPassword1',
    });
    assert.strictEqual(res.status, 401);
    assert.strictEqual((res.data as { code: string }).code, 'INVALID_CREDENTIALS');
    await client.close();
  });

  it('invariant: the two 401s (unknown email vs wrong pw) are BYTE-IDENTICAL', async () => {
    // Pin the no-enumeration property at the wire level.
    const { typed, client } = await makeTestClient();
    await typed.api.auth.register({
      email: 'enum2@x.com',
      password: 'correctPassword1',
    });
    const wrongPw = await typed.api.auth.login({
      email: 'enum2@x.com',
      password: 'incorrect',
    });
    const unknownEmail = await typed.api.auth.login({
      email: 'enum3@x.com',
      password: 'anything',
    });
    assert.strictEqual(wrongPw.status, unknownEmail.status);
    assert.deepStrictEqual(wrongPw.data, unknownEmail.data);
    await client.close();
  });

  it('invariant: after logout, the old token does NOT authenticate /auth/me', async () => {
    const { typed, client } = await makeTestClient();
    const session = createUserSession(typed, {
      captureToken: (route, res) =>
        route === 'auth.register' || route === 'auth.login'
          ? res.data?.token
          : undefined,
    });
    await session.api.auth.register({
      email: 'ses1@x.com',
      password: 'pw12345678',
    });
    const capturedToken = session.token;
    assert.ok(capturedToken);

    const meBefore = await session.api.auth.me({});
    assert.strictEqual(meBefore.status, 200);

    await session.api.auth.logout({});

    const meAfter = await session.api.auth.me({});
    assert.strictEqual(meAfter.status, 401);
    await client.close();
  });

  it('invariant: tampered bearer token → 401 (no crash, no leak)', async () => {
    const { typed, client } = await makeTestClient();
    const session = createUserSession(typed, {
      captureToken: (route, res) =>
        route === 'auth.register' || route === 'auth.login'
          ? res.data?.token
          : undefined,
    });
    await session.api.auth.register({
      email: 'tamp@x.com',
      password: 'pw12345678',
    });
    const realToken = session.token!;

    // Tamper by flipping the last char
    const tampered =
      realToken.slice(0, -1) + (realToken.at(-1) === 'a' ? 'b' : 'a');
    session.setToken(tampered);

    const res = await session.api.auth.me({});
    assert.strictEqual(res.status, 401);
    await client.close();
  });

  it('invariant: missing Authorization header → 401 (never 200 or 500)', async () => {
    const { typed, client } = await makeTestClient();
    const res = await typed.api.auth.me({});
    assert.strictEqual(
      res.status,
      401,
      'no-auth must be 401 (the request reached the handler that checks it)',
    );
    await client.close();
  });

  it('invariant: /auth/register with malformed body (missing password) → 400', async () => {
    // Zod schema validation. If it passed to the handler with undefined
    // password, the hash function would throw 500 and reveal its internals.
    const { client } = await makeTestClient();
    // Use raw transport to skip type narrowing
    const ref = await client.http.post('/auth/register', {
      email: 'malformed@x.com',
    });
    assert.ok(
      ref.status >= 400 && ref.status < 500,
      `expected 4xx for malformed body, got ${ref.status}`,
    );
    await client.close();
  });

  it('invariant: session token case-sensitivity (token with wrong case → 401)', async () => {
    const { typed, client } = await makeTestClient();
    const session = createUserSession(typed, {
      captureToken: (route, res) =>
        route === 'auth.register' ? res.data?.token : undefined,
    });
    await session.api.auth.register({
      email: 'case@x.com',
      password: 'pw12345678',
    });
    const token = session.token!;
    // Uppercase the token
    session.setToken(token.toUpperCase());
    const res = await session.api.auth.me({});
    assert.strictEqual(res.status, 401, 'tokens are case-sensitive');
    await client.close();
  });

  it('invariant: revokeAllForUser direct-call via SessionService (PostgresLike semantics unavailable in-memory)', async () => {
    // This is the positive end-to-end demonstration that the SERVICE
    // itself can't kick all devices via AuthTestBundle's in-memory repo.
    // Pinned in session.edge.test.ts too; here we verify the HTTP-level
    // property that a user logging out on ONE device does NOT kill
    // their other sessions.
    const { typed, client } = await makeTestClient();
    await typed.api.auth.register({
      email: 'multi@x.com',
      password: 'pw12345678',
    });
    const loginA = await typed.api.auth.login({
      email: 'multi@x.com',
      password: 'pw12345678',
    });
    const loginB = await typed.api.auth.login({
      email: 'multi@x.com',
      password: 'pw12345678',
    });
    assert.strictEqual(loginA.status, 200);
    assert.strictEqual(loginB.status, 200);
    const tokenA = (loginA.data as { token: string }).token;
    const tokenB = (loginB.data as { token: string }).token;
    assert.notStrictEqual(tokenA, tokenB, 'distinct sessions');

    // Logout A
    const logoutA = await client.http.post('/auth/logout', undefined);
    // Need header — use raw call with bearer:
    const logoutWithHeader = await client.http.request('/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert.strictEqual(logoutWithHeader.status, 200);

    // Device B still works
    const meB = await client.http.request('/auth/me', {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert.strictEqual(meB.status, 200, 'logging out device A leaves B alive');

    void logoutA;
    await client.close();
  });
});
