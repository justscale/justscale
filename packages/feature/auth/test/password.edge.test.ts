/**
 * Password hashing + verification — edge cases.
 *
 * Every test pins a security property against a "silent failure" mode.
 * If any of these regress the wrong way, auth becomes either unusable or
 * bypassable without a crash — the worst class of bug.
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { ModelRepository } from '@justscale/core/models';
import { defaultHttpConfig } from '@justscale/http/testing';
import { createTestKit } from '@justscale/testing';

import { AuthTestBundle } from '../src/testing.js';
import { User } from '../src/models/user.js';
import {
  PasswordService,
  UserService,
  UserExistsError,
} from '../src/services/index.js';

const kit = createTestKit();

const noopResolver = () => {
  throw new Error('Resolver not available in unit tests');
};

describe('Password edge cases', () => {
  const passwords = PasswordService.factory({}, noopResolver);

  describe('hash format invariants', () => {
    it('invariant: hash MUST NOT contain the plaintext password (silent bug: passthrough "hash")', async () => {
      // If someone accidentally wires a no-op hash, `verify` still returns
      // true for the matching plaintext — this test catches the leak itself.
      const password = 'correctHorseBatteryStaple';
      const hash = await passwords.hash(password);
      assert.ok(
        !hash.includes(password),
        `Hash must not leak plaintext. Got: ${hash}`,
      );
    });

    it('invariant: hash format is `salt:key` (16+ bytes each hex)', async () => {
      const hash = await passwords.hash('anything');
      const parts = hash.split(':');
      assert.strictEqual(parts.length, 2, 'hash has exactly one colon');
      // salt 32 bytes => 64 hex chars; key 64 bytes => 128 hex chars
      assert.ok(parts[0].length >= 32, 'salt hex is at least 32 chars');
      assert.ok(parts[1].length >= 64, 'key hex is at least 64 chars');
      assert.ok(/^[0-9a-f]+$/.test(parts[0]), 'salt is pure hex');
      assert.ok(/^[0-9a-f]+$/.test(parts[1]), 'key is pure hex');
    });

    it('invariant: same password produces DIFFERENT hashes across calls (salt entropy)', async () => {
      // Silent bug: deterministic salt → rainbow tables viable.
      const pw = 'theSamePassword';
      const h1 = await passwords.hash(pw);
      const h2 = await passwords.hash(pw);
      const h3 = await passwords.hash(pw);
      assert.notStrictEqual(h1, h2);
      assert.notStrictEqual(h2, h3);
      assert.notStrictEqual(h1, h3);
      // Salts must differ specifically (not just keys)
      const [s1] = h1.split(':');
      const [s2] = h2.split(':');
      assert.notStrictEqual(s1, s2, 'salts must be unique per hash');
    });
  });

  describe('verify()', () => {
    it('returns true only for the exact password', async () => {
      const hash = await passwords.hash('P@ssw0rd!');
      assert.strictEqual(await passwords.verify('P@ssw0rd!', hash), true);
      assert.strictEqual(await passwords.verify('p@ssw0rd!', hash), false); // case
      assert.strictEqual(await passwords.verify('P@ssw0rd', hash), false); // truncated
      assert.strictEqual(await passwords.verify('P@ssw0rd!!', hash), false); // extra
    });

    it('invariant: structurally-malformed hash (empty / no-colon) → false', async () => {
      // Silent bug: throwing uncaught lets middleware crash; returning true
      // lets attacker login with an empty password if hash is malformed.
      // These three hit the `if (!saltHex || !keyHex) return false` guard.
      assert.strictEqual(await passwords.verify('anything', ''), false);
      assert.strictEqual(await passwords.verify('anything', 'nocolon'), false);
      assert.strictEqual(await passwords.verify('anything', ':'), false);
    });

    it('invariant: empty string password against valid hash → false', async () => {
      const hash = await passwords.hash('real-password');
      assert.strictEqual(await passwords.verify('', hash), false);
    });

    it('short-but-parseable hash "a:b" → returns false (no crash)', async () => {
      // A corrupted/truncated hash row must NOT crash verify(). Prior to
      // the fix, timingSafeEqual threw RangeError on length-mismatched
      // buffers, turning login into a 500 for that user.
      assert.strictEqual(await passwords.verify('x', 'a:b'), false);
    });

    it('non-hex garbage "zzz:yyy" → returns false (no crash)', async () => {
      // Buffer.from('zzz','hex') is a zero-length buffer, which historically
      // crashed timingSafeEqual. Now length-checked; returns false.
      assert.strictEqual(await passwords.verify('x', 'zzz:yyy'), false);
    });

    it('uses timing-safe comparison — truncated hash returns false without throwing', async () => {
      const hash = await passwords.hash('pw');
      const [salt] = hash.split(':');
      // Short key hex — derived key is 64 bytes; length-mismatch path
      // returns false instead of letting timingSafeEqual throw.
      const truncated = `${salt}:deadbeef`;
      assert.strictEqual(
        await passwords.verify('pw', truncated),
        false,
        'truncated hash compares as false, no RangeError',
      );
    });
  });

  describe('UserService.register', () => {
    /** Build a fresh unit-test UserService with an InMemory user repo. */
    async function makeUserService() {
      const app = await kit.spawn((b) =>
        b.add(defaultHttpConfig).add(AuthTestBundle()),
      );
      const users = await app.container.resolve(UserService);
      const repo = await app.container.resolve(ModelRepository.of(User));
      return { users, repo, app };
    }

    it('invariant: registered user has hashed passwordHash, NOT plaintext', async () => {
      const { users, repo } = await makeUserService();
      await users.register('hash-check@x.com', 'plaintext-password', 'N');
      const u = await repo.findOne(User.fields.email.eq('hash-check@x.com'));
      assert.ok(u);
      assert.notStrictEqual(
        u!.passwordHash,
        'plaintext-password',
        'passwordHash stored plaintext — catastrophic bug',
      );
      assert.ok(
        u!.passwordHash.includes(':'),
        'passwordHash has salt:key format',
      );
    });

    it('invariant: duplicate email → UserExistsError (NOT overwrite)', async () => {
      // Silent bug: overwrite would let an attacker who knows a victim's
      // email reset their password via register.
      const { users } = await makeUserService();
      await users.register('dup@x.com', 'first-pw', 'First');
      await assert.rejects(
        () => users.register('dup@x.com', 'second-pw', 'Second'),
        UserExistsError,
      );
    });

    it('authenticate() for unknown email returns undefined (NOT throw)', async () => {
      // If this throws, the login controller's `if (!user)` check fails
      // open — never reached — and 500 leaks.
      const { users } = await makeUserService();
      const res = await users.authenticate('ghost@x.com', 'any');
      assert.strictEqual(res, undefined);
    });

    it('authenticate() with wrong password for existing user → undefined', async () => {
      const { users } = await makeUserService();
      await users.register('real@x.com', 'correct', 'R');
      const res = await users.authenticate('real@x.com', 'wrong');
      assert.strictEqual(res, undefined);
    });

    it('authenticate() with correct password → returns user AND updates lastLoginAt', async () => {
      const { users, repo } = await makeUserService();
      const before = new Date(Date.now() - 1000);
      await users.register('ok@x.com', 'good', 'O');

      const authed = await users.authenticate('ok@x.com', 'good');
      assert.ok(authed);
      assert.strictEqual(authed!.email, 'ok@x.com');

      const fresh = await repo.findOne(User.fields.email.eq('ok@x.com'));
      assert.ok(fresh!.lastLoginAt);
      assert.ok(
        fresh!.lastLoginAt! > before,
        'lastLoginAt should update on successful auth',
      );
    });

    it('register() rejects empty-string passwords (service-level defence in depth)', async () => {
      // Schemas enforce min(8) at the HTTP layer; the service also
      // rejects empty passwords so a direct call can't bypass it.
      const { users } = await makeUserService();
      await assert.rejects(
        () => users.register('empty@x.com', '', 'Empty'),
        /password required/i,
      );
    });

    it('register() rejects passwords > 1024 bytes (DoS guard at the service layer)', async () => {
      // scrypt on a 10 MB password burns serious CPU; the HTTP body limit
      // mitigates upstream, but a direct caller (CLI, process, internal RPC)
      // could bypass it. PasswordService caps at 1024 UTF-8 bytes.
      const { users } = await makeUserService();
      const tooLong = 'A'.repeat(2000);
      await assert.rejects(
        () => users.register('long@x.com', tooLong, 'L'),
        /password exceeds/i,
      );
    });

    it('hash()/verify() honour the 1024-byte cap', async () => {
      // hash() throws PasswordTooLongError; verify() returns false (so
      // /auth/login can't be used as a CPU oracle by a probing attacker).
      const ok = 'A'.repeat(1024);
      const tooLong = 'A'.repeat(1025);
      const goodHash = await passwords.hash(ok);
      await assert.rejects(
        () => passwords.hash(tooLong),
        /password exceeds/i,
      );
      assert.strictEqual(
        await passwords.verify(tooLong, goodHash),
        false,
        'verify() returns false for over-cap password — no error leak, no scrypt burn',
      );
    });

    it('email matching is case-insensitive — Mixed@X.com and mixed@x.com are the same user', async () => {
      // register / login / findByEmail all normalise to lowercase, so a
      // human-visible duplicate cannot be created.
      const { users } = await makeUserService();
      await users.register('Mixed@X.com', 'pw1pw1pw1');
      await assert.rejects(
        () => users.register('mixed@x.com', 'pw2pw2pw2'),
        UserExistsError,
      );
      const a = await users.findByEmail('Mixed@X.com');
      const b = await users.findByEmail('mixed@x.com');
      assert.ok(a);
      assert.ok(b);
      assert.strictEqual(
        User.ref(a!).identifier,
        User.ref(b!).identifier,
        'same user resolved via either-case email',
      );
    });
  });
});
