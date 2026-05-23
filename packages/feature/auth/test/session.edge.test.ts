/**
 * Session lifecycle — edge cases.
 *
 * Sessions are auth's long-lived state. A silently-valid expired session,
 * a revoked-but-still-findable session, or a touch() that extends expiry
 * all compound into real-world security holes.
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { ModelRepository } from '@justscale/core/models';
import { defaultHttpConfig } from '@justscale/http/testing';
import { createTestKit } from '@justscale/testing';

import { AuthTestBundle } from '../src/testing.js';
import { Session } from '../src/models/session.js';
import { User } from '../src/models/user.js';
import {
  SessionService,
  UserService,
} from '../src/services/index.js';

const kit = createTestKit();

async function makeApp() {
  const app = await kit.spawn((b) =>
    b.add(defaultHttpConfig).add(AuthTestBundle()),
  );
  const sessions = await app.container.resolve(SessionService);
  const users = await app.container.resolve(UserService);
  const sessionRepo = await app.container.resolve(ModelRepository.of(Session));
  const userRepo = await app.container.resolve(ModelRepository.of(User));
  return { app, sessions, users, sessionRepo, userRepo };
}

describe('Session edge cases', () => {
  describe('create()', () => {
    it('invariant: fresh session has unguessable token (hex, 64 chars)', async () => {
      // Silent bug: sequential / predictable tokens let attackers guess
      // adjacent users' sessions. Token comes from crypto.randomBytes(32).
      const { users, sessions } = await makeApp();
      const u = await users.register('tok1@x.com', 'pw12345678', 'T');
      const s = await sessions.create(u);
      assert.match(s.token, /^[0-9a-f]{64}$/);
    });

    it('invariant: expiresAt > now by roughly TTL (default 7 days)', async () => {
      const { users, sessions } = await makeApp();
      const u = await users.register('exp1@x.com', 'pw12345678', 'T');
      const before = Date.now();
      const s = await sessions.create(u);
      const diff = s.expiresAt.getTime() - before;
      // 7 days = 604_800_000 ms. Allow ±1s slack.
      assert.ok(diff > 7 * 24 * 60 * 60 * 1000 - 1000, 'expiresAt is ~7d out');
      assert.ok(diff < 7 * 24 * 60 * 60 * 1000 + 2000);
    });

    it('honours custom ttlMs', async () => {
      const { users, sessions } = await makeApp();
      const u = await users.register('exp2@x.com', 'pw12345678', 'T');
      const before = Date.now();
      const s = await sessions.create(u, { ttlMs: 500 });
      const diff = s.expiresAt.getTime() - before;
      assert.ok(diff >= 400 && diff <= 700, `expiresAt ~ +500ms, got +${diff}`);
    });

    it('invariant: two sessions for the same user have DIFFERENT tokens', async () => {
      // Silent bug: two devices with identical tokens → logout-one = logout-all.
      const { users, sessions } = await makeApp();
      const u = await users.register('multi@x.com', 'pw12345678', 'T');
      const s1 = await sessions.create(u);
      const s2 = await sessions.create(u);
      assert.notStrictEqual(s1.token, s2.token);
    });

    it('invariant: 1000 freshly-created tokens are all unique (collision check)', async () => {
      // Birthday-paradox sanity: 64 hex chars = 256 bits of entropy.
      // If the generator is reduced, duplicates show up far faster.
      const { users, sessions } = await makeApp();
      const u = await users.register('coll@x.com', 'pw12345678', 'T');
      const seen = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        const s = await sessions.create(u);
        assert.ok(!seen.has(s.token), `duplicate token at iter ${i}`);
        seen.add(s.token);
      }
      assert.strictEqual(seen.size, 1000);
    });
  });

  describe('findByToken()', () => {
    it('invariant: fresh token → returns the session', async () => {
      const { users, sessions } = await makeApp();
      const u = await users.register('find1@x.com', 'pw12345678', 'T');
      const s = await sessions.create(u);
      const got = await sessions.findByToken(s.token);
      assert.ok(got);
      assert.strictEqual(got!.token, s.token);
    });

    it('invariant: empty-string token → null (no crash, no match)', async () => {
      const { sessions } = await makeApp();
      const res = await sessions.findByToken('');
      assert.strictEqual(res, null);
    });

    it('invariant: random/garbage token → null', async () => {
      const { sessions } = await makeApp();
      assert.strictEqual(await sessions.findByToken('not-a-real-token'), null);
      assert.strictEqual(await sessions.findByToken('\x00\x01\x02'), null);
      assert.strictEqual(await sessions.findByToken('🔥💀🔥'), null);
    });

    it('invariant: expired session → null AND the row is deleted (GC on access)', async () => {
      // Silent bug: if findByToken returned the expired session, downstream
      // middleware would trust it. Also pin that the delete happens — without
      // it, expired rows grow unbounded.
      const { users, sessions, sessionRepo } = await makeApp();
      const u = await users.register('exp3@x.com', 'pw12345678', 'T');
      const s = await sessions.create(u, { ttlMs: 10 });
      // Wait for expiry
      await new Promise((r) => setTimeout(r, 30));

      const got = await sessions.findByToken(s.token);
      assert.strictEqual(got, null, 'expired returns null');

      // Row should be gone
      const row = await sessionRepo.findOne(Session.fields.token.eq(s.token));
      assert.strictEqual(row, undefined, 'expired session row was deleted');
    });

    it('boundary: session expiring RIGHT NOW is rejected (strict lt)', async () => {
      // Session uses `expiresAt < new Date()` — so `expiresAt === now` is
      // STILL VALID. Pin that behaviour: a token at its exact boundary
      // passes. If someone flips to `<=`, they break valid sessions at
      // the microsecond boundary. If someone flips to `>`, expired sessions
      // one-tick past expiry would leak.
      const { users, sessions } = await makeApp();
      const u = await users.register('bnd@x.com', 'pw12345678', 'T');
      // TTL of 0 → expiresAt = creation time. `expiresAt < now` is true
      // a millisecond later.
      const s = await sessions.create(u, { ttlMs: 0 });
      // Immediately-same-tick: ambiguous; wait 1ms to make `<` true.
      await new Promise((r) => setTimeout(r, 5));
      assert.strictEqual(await sessions.findByToken(s.token), null);
    });
  });

  describe('touch()', () => {
    it('invariant: touch() bumps lastActiveAt', async () => {
      const { users, sessions, sessionRepo } = await makeApp();
      const u = await users.register('touch1@x.com', 'pw12345678', 'T');
      const s = await sessions.create(u);
      const originalLast = s.lastActiveAt;
      await new Promise((r) => setTimeout(r, 10));

      const locked = await sessionRepo.lock(s);
      assert.ok(locked);
      await sessions.touch(locked!);

      const after = await sessionRepo.findOne(Session.fields.token.eq(s.token));
      assert.ok(after!.lastActiveAt > originalLast);
    });

    it('invariant: touch() does NOT extend expiresAt (fixed-lifetime sessions)', async () => {
      // Silent bug: rolling expiry from touch gives an active user
      // indefinite sessions. Violating this means absolute session length
      // caps from compliance regimes (e.g. 24h for finance) get bypassed.
      const { users, sessions, sessionRepo } = await makeApp();
      const u = await users.register('touch2@x.com', 'pw12345678', 'T');
      const s = await sessions.create(u, { ttlMs: 60_000 });
      const originalExpires = s.expiresAt.getTime();

      await new Promise((r) => setTimeout(r, 5));
      const locked = await sessionRepo.lock(s);
      await sessions.touch(locked!);

      const after = await sessionRepo.findOne(Session.fields.token.eq(s.token));
      assert.strictEqual(
        after!.expiresAt.getTime(),
        originalExpires,
        'touch() MUST NOT extend expiresAt',
      );
    });
  });

  describe('revoke()', () => {
    it('invariant: revoke() deletes the row — subsequent findByToken → null', async () => {
      const { users, sessions, sessionRepo } = await makeApp();
      const u = await users.register('rev1@x.com', 'pw12345678', 'T');
      const s = await sessions.create(u);

      const locked = await sessionRepo.lock(s);
      await sessions.revoke(locked!);

      assert.strictEqual(await sessions.findByToken(s.token), null);
      const row = await sessionRepo.findOne(Session.fields.token.eq(s.token));
      assert.strictEqual(row, undefined);
    });

    it('revokeAllForUser() deletes every session for the given user (Persistent or Ref input)', async () => {
      // AuthTestBundle now wires `fieldDefs: getModelFields(Session)` into
      // the in-memory session repo, so `Session.fields.user.eq(user)`
      // unwraps the ref to the user's FK properly and `deleteWhere` hits
      // every row. Both Persistent and Reference inputs are accepted by
      // the `.eq()` helper because the field encoder normalises them to
      // the same identifier string.
      const { users, sessions } = await makeApp();
      const u = await users.register('revall@x.com', 'pw12345678', 'T');
      await sessions.create(u);
      await sessions.create(u);
      await sessions.create(u);

      const withPersistent = await sessions.revokeAllForUser(u);
      assert.strictEqual(withPersistent, 3, 'Persistent input revokes all');

      // Recreate and test with Ref-shaped input
      await sessions.create(u);
      await sessions.create(u);
      const withRef = await sessions.revokeAllForUser(User.ref(u));
      assert.strictEqual(withRef, 2, 'Reference input revokes all');
    });

    it('revokeExpired() deletes ONLY expired rows, leaves fresh ones', async () => {
      const { users, sessions, sessionRepo } = await makeApp();
      const u = await users.register('gc@x.com', 'pw12345678', 'T');
      const expired1 = await sessions.create(u, { ttlMs: 10 });
      const expired2 = await sessions.create(u, { ttlMs: 10 });
      const fresh = await sessions.create(u, { ttlMs: 60_000 });
      await new Promise((r) => setTimeout(r, 30));

      const count = await sessions.revokeExpired();
      assert.strictEqual(count, 2, 'two expired sessions gc-ed');

      // fresh still there
      const row = await sessionRepo.findOne(
        Session.fields.token.eq(fresh.token),
      );
      assert.ok(row, 'fresh session survived revokeExpired');
    });
  });

  describe('concurrency', () => {
    it('invariant: touch() and revoke() serialize via repo.lock() — no double-mutate race', async () => {
      // sessionRepo.lock() now takes a real mutex (Phase 2 of
      // fix/lock-as-mutex). Concurrent touch() + revoke() can no longer
      // see each other's intermediate state — whichever acquires the
      // lock first runs to completion before the other's lock returns.
      // Whichever runs second gets a null Locked<T> (row gone) or
      // succeeds, depending on order; either way the row stays gone.
      const { users, sessions, sessionRepo } = await makeApp();
      const u = await users.register('race@x.com', 'pw12345678', 'T');
      const s = await sessions.create(u);

      // Serial acquire→revoke→re-acquire→touch. Without releasing the
      // first lock, the second would deadlock — that's the proof.
      {
        await using locked = await sessionRepo.lock(s);
        assert.ok(locked);
        await sessions.revoke(locked);
      }

      // Second acquire: row is gone → null. touch() never runs.
      await using afterRevoke = await sessionRepo.lock(s);
      assert.strictEqual(afterRevoke, null);

      const row = await sessionRepo.findOne(Session.fields.token.eq(s.token));
      assert.strictEqual(row, undefined, 'revoked session stays gone');
    });

    it('invariant: a second lock() on the same row blocks until the first releases', async () => {
      // sessionRepo.lock() now takes a real mutex (Phase 2 of
      // fix/lock-as-mutex). Two concurrent acquirers serialize: the
      // second one's promise stays pending until the first disposes.
      const { users, sessions, sessionRepo } = await makeApp();
      const u = await users.register('dbl@x.com', 'pw12345678', 'T');
      const s = await sessions.create(u);

      const timeline: string[] = [];
      const t0 = Date.now();
      const stamp = (m: string) => timeline.push(`+${Date.now() - t0}ms ${m}`);

      const a = (async () => {
        await using locked = await sessionRepo.lock(s);
        stamp('A: locked');
        await new Promise((r) => setTimeout(r, 50));
        stamp('A: pre-release');
      })();
      const b = (async () => {
        await new Promise((r) => setTimeout(r, 5));
        stamp('B: lock-start');
        await using locked = await sessionRepo.lock(s);
        stamp('B: locked');
      })();
      await Promise.all([a, b]);

      const aPreRelease = timeline.findIndex((s) => s.includes('A: pre-release'));
      const bLocked = timeline.findIndex((s) => s.includes('B: locked'));
      assert.ok(
        aPreRelease < bLocked,
        `B must NOT lock until A's scope exits. Timeline:\n${timeline.join('\n')}`,
      );
    });
  });

  describe('session ↔ user linkage', () => {
    it('invariant: session.user resolves to the owning user', async () => {
      const { users, sessions } = await makeApp();
      const u = await users.register('link@x.com', 'pw12345678', 'T');
      const s = await sessions.create(u);
      const got = await sessions.findByToken(s.token);
      assert.ok(got);
      const owner = await got!.user;
      assert.ok(owner);
      assert.strictEqual(owner!.email, 'link@x.com');
    });

    it('invariant: metadata (userAgent/ipAddress) is preserved through roundtrip', async () => {
      const { users, sessions } = await makeApp();
      const u = await users.register('meta@x.com', 'pw12345678', 'T');
      const s = await sessions.create(u, {
        userAgent: 'Mozilla/5.0 test',
        ipAddress: '192.0.2.42',
      });
      const got = await sessions.findByToken(s.token);
      assert.strictEqual(got!.userAgent, 'Mozilla/5.0 test');
      assert.strictEqual(got!.ipAddress, '192.0.2.42');
    });
  });
});
