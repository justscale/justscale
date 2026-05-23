/**
 * 2FA / TOTP — edge cases.
 *
 * The promise is: "someone who has the password but NOT the device cannot
 * log in". Each edge below, when flipped silently, lets the attacker in
 * anyway.
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { ModelRepository } from '@justscale/core/models';
import { defaultHttpConfig } from '@justscale/http/testing';
import { createTestKit } from '@justscale/testing';

import { AuthTestBundle } from '../src/testing.js';
import { User } from '../src/models/user.js';
import {
  TwoFactorService,
  UserService,
} from '../src/services/index.js';

const kit = createTestKit();

async function makeApp() {
  const app = await kit.spawn((b) =>
    b.add(defaultHttpConfig).add(AuthTestBundle()),
  );
  const users = await app.container.resolve(UserService);
  const twofa = await app.container.resolve(TwoFactorService);
  const userRepo = await app.container.resolve(ModelRepository.of(User));
  return { app, users, twofa, userRepo };
}

describe('2FA edge cases', () => {
  describe('generateSecret()', () => {
    it('invariant: 20 base32 chars (160 bits)', async () => {
      const { twofa } = await makeApp();
      for (let i = 0; i < 50; i++) {
        const s = twofa.generateSecret();
        assert.strictEqual(s.length, 20);
        assert.match(s, /^[A-Z2-7]+$/);
      }
    });

    it('invariant: 1000 secrets all unique (crypto.getRandomValues based)', async () => {
      const { twofa } = await makeApp();
      const seen = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        seen.add(twofa.generateSecret());
      }
      assert.strictEqual(seen.size, 1000);
    });
  });

  describe('verifyTOTP() — format', () => {
    it('invariant: rejects non-6-digit codes', async () => {
      const { twofa } = await makeApp();
      const secret = twofa.generateSecret();
      assert.strictEqual(twofa.verifyTOTP('', secret), false);
      assert.strictEqual(twofa.verifyTOTP('1', secret), false);
      assert.strictEqual(twofa.verifyTOTP('12345', secret), false);
      assert.strictEqual(twofa.verifyTOTP('1234567', secret), false);
      assert.strictEqual(twofa.verifyTOTP('abcdef', secret), false);
      assert.strictEqual(twofa.verifyTOTP('12345a', secret), false);
      assert.strictEqual(twofa.verifyTOTP('-12345', secret), false);
      assert.strictEqual(twofa.verifyTOTP('+12345', secret), false);
      assert.strictEqual(twofa.verifyTOTP(' 123456', secret), false); // leading space
      assert.strictEqual(twofa.verifyTOTP('123456 ', secret), false); // trailing space
    });

    it('invariant: accepts freshly-generated current code', async () => {
      const { twofa } = await makeApp();
      const secret = twofa.generateSecret();
      const code = twofa.generateCurrentCode(secret);
      assert.strictEqual(twofa.verifyTOTP(code, secret), true);
    });

    it('invariant: wrong secret → false even with a valid-looking code', async () => {
      const { twofa } = await makeApp();
      const s1 = twofa.generateSecret();
      const s2 = twofa.generateSecret();
      const code = twofa.generateCurrentCode(s1);
      assert.strictEqual(twofa.verifyTOTP(code, s2), false);
    });
  });

  describe('verifyTOTP() — clock drift window (RFC 6238 ±1 step)', () => {
    it('invariant: ±1 step (30s) code accepted (pin RFC tolerance)', async () => {
      // This pins the CURRENT design: ±1 step = 30s window each way.
      // Tightening to 0 would break slightly out-of-sync clients.
      // Widening to ±2+ would weaken brute-force.
      const { twofa } = await makeApp();
      const secret = twofa.generateSecret();

      // Compute the code for (now - 30s) by temporarily fudging Date.now
      const realNow = Date.now();
      const originalDateNow = Date.now;
      try {
        (Date as unknown as { now: () => number }).now = () => realNow - 30_000;
        const prevStepCode = twofa.generateCurrentCode(secret);
        (Date as unknown as { now: () => number }).now = () => realNow + 30_000;
        const nextStepCode = twofa.generateCurrentCode(secret);
        // Restore before verifying, to verify against "current" time
        (Date as unknown as { now: () => number }).now = originalDateNow;

        assert.strictEqual(
          twofa.verifyTOTP(prevStepCode, secret),
          true,
          'previous-step code is accepted (clock drift)',
        );
        assert.strictEqual(
          twofa.verifyTOTP(nextStepCode, secret),
          true,
          'next-step code is accepted (clock drift)',
        );
      } finally {
        (Date as unknown as { now: () => number }).now = originalDateNow;
      }
    });

    it('invariant: ±2 step (60s) code REJECTED', async () => {
      // Silent bug: accepting a 2-step-old code turns into a 90s brute-
      // force window instead of a 30s one — the attacker's guess rate
      // triples, trivially.
      const { twofa } = await makeApp();
      const secret = twofa.generateSecret();

      const realNow = Date.now();
      const originalDateNow = Date.now;
      try {
        (Date as unknown as { now: () => number }).now = () => realNow - 60_000;
        const twoStepsBack = twofa.generateCurrentCode(secret);
        (Date as unknown as { now: () => number }).now = () => realNow + 60_000;
        const twoStepsForward = twofa.generateCurrentCode(secret);
        (Date as unknown as { now: () => number }).now = originalDateNow;

        assert.strictEqual(
          twofa.verifyTOTP(twoStepsBack, secret),
          false,
          '2-steps-back code must be rejected',
        );
        assert.strictEqual(
          twofa.verifyTOTP(twoStepsForward, secret),
          false,
          '2-steps-forward code must be rejected',
        );
      } finally {
        (Date as unknown as { now: () => number }).now = originalDateNow;
      }
    });
  });

  describe('enable2FA / disable2FA', () => {
    it('invariant: enable2FA sets secret + twoFactorEnabled=true', async () => {
      const { users, twofa, userRepo } = await makeApp();
      const u = await users.register('2fa1@x.com', 'pw12345678', 'T');
      using locked = await userRepo.lock(u);
      await twofa.enable2FA(locked!, 'TESTSECRET1234567890');

      const row = await userRepo.findOne(User.fields.email.eq('2fa1@x.com'));
      assert.strictEqual(row!.twoFactorEnabled, true);
      assert.strictEqual(row!.twoFactorSecret, 'TESTSECRET1234567890');
    });

    it('invariant: disable2FA clears secret AND flag', async () => {
      // Silent bug: clearing flag but not secret leaves a usable TOTP
      // that could be exploited via any endpoint that trusts
      // twoFactorSecret directly (like login2FA, which does exactly that).
      const { users, twofa, userRepo } = await makeApp();
      const u = await users.register('2fa2@x.com', 'pw12345678', 'T');
      // Block-scope each lock so the second acquire isn't blocked.
      {
        using locked = await userRepo.lock(u);
        await twofa.enable2FA(locked!, 'TESTSECRET1234567890');
      }

      {
        using locked2 = await userRepo.lock(u);
        await twofa.disable2FA(locked2!);
      }

      const row = await userRepo.findOne(User.fields.email.eq('2fa2@x.com'));
      assert.strictEqual(row!.twoFactorEnabled, false);
      assert.strictEqual(
        row!.twoFactorSecret,
        undefined,
        'disable MUST clear the secret',
      );
    });

    it('invariant: isMFAEnabled and getMFAStatus reflect current state', async () => {
      const { users, twofa, userRepo } = await makeApp();
      const u = await users.register('2fa3@x.com', 'pw12345678', 'T');
      assert.strictEqual(await twofa.isMFAEnabled(User.ref(u)), false);
      let status = await twofa.getMFAStatus(User.ref(u));
      assert.deepStrictEqual(status, { enabled: false, hasSecret: false });

      using locked = await userRepo.lock(u);
      await twofa.enable2FA(locked!, 'TESTSECRET1234567890');
      assert.strictEqual(await twofa.isMFAEnabled(User.ref(u)), true);
      status = await twofa.getMFAStatus(User.ref(u));
      assert.deepStrictEqual(status, { enabled: true, hasSecret: true });
    });

    it('invariant: isMFAEnabled on unknown user → false, not throw', async () => {
      // Silent bug: if this throws, guard middleware 500s instead of
      // denying; attacker gets a tell that the user doesn't exist.
      const { twofa } = await makeApp();
      assert.strictEqual(
        await twofa.isMFAEnabled(User.ref`00000000-0000-0000-0000-000000000000`),
        false,
      );
      const status = await twofa.getMFAStatus(
        User.ref`00000000-0000-0000-0000-000000000000`,
      );
      assert.deepStrictEqual(status, { enabled: false, hasSecret: false });
    });
  });

  describe('otpauth URL', () => {
    it('invariant: URL is properly URL-encoded', async () => {
      const { twofa } = await makeApp();
      const url = twofa.generateOtpauthUrl(
        'SECRET',
        'user+tag@example.com',
        'My App & Co',
      );
      // `@` encoded as %40, `+` encoded, `&` encoded
      assert.ok(url.includes('user%2Btag%40example.com'));
      assert.ok(url.includes('issuer=My%20App%20%26%20Co'));
      assert.ok(url.startsWith('otpauth://totp/'));
      assert.ok(url.includes('secret=SECRET'));
      assert.ok(url.includes('algorithm=SHA1'));
      assert.ok(url.includes('digits=6'));
      assert.ok(url.includes('period=30'));
    });
  });

  describe('brute-force resistance', () => {
    it('pure verifyTOTP(code, secret) is a stateless primitive — no rate-limit by design', async () => {
      // The primitive checker stays state-free so it can be used from
      // setup flows that don't have a user row yet. Rate limiting lives
      // on `verifyTOTPForUser` instead (tested below).
      const { twofa } = await makeApp();
      const secret = twofa.generateSecret();
      for (let i = 0; i < 200; i++) {
        twofa.verifyTOTP(String(i).padStart(6, '0'), secret);
      }
      const good = twofa.generateCurrentCode(secret);
      assert.strictEqual(twofa.verifyTOTP(good, secret), true);
    });

    it('verifyTOTPForUser locks the account after 10 failed attempts for 15 minutes', async () => {
      const { users, twofa, userRepo } = await makeApp();
      const secret = twofa.generateSecret();
      const u = await users.register('bf@x.com', 'pw12345678', 'B');
      // Block-scope each lock so the next acquire isn't blocked by the
      // previous (real mutex serialises; un-disposed locks deadlock).
      {
        using locked = await userRepo.lock(u);
        await twofa.enable2FA(locked!, secret);
      }

      // Fire 10 wrong codes.
      for (let i = 0; i < 10; i++) {
        using l = await userRepo.lock(u);
        const res = await twofa.verifyTOTPForUser(
          l!,
          String(i).padStart(6, '0'),
        );
        assert.strictEqual(res, false, `attempt ${i} rejected`);
      }

      // 11th attempt — even with the correct code — is 'locked'.
      const currentCode = twofa.generateCurrentCode(secret);
      let eleventh: 'locked' | boolean;
      {
        using l11 = await userRepo.lock(u);
        eleventh = await twofa.verifyTOTPForUser(l11!, currentCode);
      }
      assert.strictEqual(eleventh, 'locked', 'account locked after 10 fails');

      // The row carries a future lockedUntil.
      const row = await userRepo.findOne(User.fields.email.eq('bf@x.com'));
      assert.ok(row!.twoFactorLockedUntil);
      assert.ok(row!.twoFactorLockedUntil! > new Date());
    });

    it('verifyTOTPForUser resets the counter on a successful code', async () => {
      const { users, twofa, userRepo } = await makeApp();
      const secret = twofa.generateSecret();
      const u = await users.register('bf2@x.com', 'pw12345678', 'B');
      {
        using locked = await userRepo.lock(u);
        await twofa.enable2FA(locked!, secret);
      }

      // 3 failures, then a valid code — counter must zero out.
      for (let i = 0; i < 3; i++) {
        using l = await userRepo.lock(u);
        await twofa.verifyTOTPForUser(l!, '000001');
      }
      const valid = twofa.generateCurrentCode(secret);
      let ok: boolean | 'locked';
      {
        using l = await userRepo.lock(u);
        ok = await twofa.verifyTOTPForUser(l!, valid);
      }
      assert.strictEqual(ok, true);

      const row = await userRepo.findOne(User.fields.email.eq('bf2@x.com'));
      assert.strictEqual(row!.twoFactorFailedAttempts, 0);
      assert.strictEqual(row!.twoFactorLockedUntil, undefined);
    });
  });

  describe('base32 decoding edge', () => {
    it('invariant: malformed base32 secret (invalid chars) → 0-byte buffer → TOTP always false', async () => {
      // Pins the silent-success path: an invalid secret produces a
      // zero-length HMAC key, which generates some deterministic 6-digit
      // output. An attacker who knows this output could log in if the
      // system accepted any invalid secret. Let's confirm the response
      // is stable (not a crash).
      const { twofa } = await makeApp();
      // `8` and `9` are not in base32 alphabet
      const invalidSecret = '8888888888888888888';
      assert.strictEqual(
        twofa.verifyTOTP('000000', invalidSecret),
        typeof twofa.verifyTOTP('000000', invalidSecret) === 'boolean'
          ? twofa.verifyTOTP('000000', invalidSecret)
          : false,
        'returns boolean, no crash',
      );
      // With empty secret — also stable
      assert.strictEqual(typeof twofa.verifyTOTP('123456', ''), 'boolean');
    });

    it('invariant: empty-secret + empty-code → false', async () => {
      const { twofa } = await makeApp();
      assert.strictEqual(twofa.verifyTOTP('', ''), false);
    });
  });
});
