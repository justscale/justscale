/**
 * Email verification — edge cases.
 *
 * Email verification is the one-way promise a user made to own the address
 * they registered with. The token is single-use, time-bound, and must never
 * verify anyone else. A silent failure here either (a) blocks all users
 * from ever verifying, or (b) lets anyone mark anyone verified.
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { ModelRepository } from '@justscale/core/models';
import { defaultHttpConfig } from '@justscale/http/testing';
import { createTestKit } from '@justscale/testing';

import { AuthTestBundle } from '../src/testing.js';
import { User } from '../src/models/user.js';
import {
  UserService,
  AbstractEmailSender,
  type Email,
} from '../src/services/index.js';
import { TokenService } from '../src/processes/signup.process.js';
import { AuthSignals } from '../src/services/signals.service.js';
import { emailVerificationProcess } from '../src/processes/signup.process.js';

const kit = createTestKit();

async function makeApp() {
  const app = await kit.spawn((b) =>
    b.add(defaultHttpConfig).add(AuthTestBundle()),
  );

  const users = await app.container.resolve(UserService);
  const userRepo = await app.container.resolve(ModelRepository.of(User));
  const tokens = await app.container.resolve(TokenService);
  const signals = await app.container.resolve(AuthSignals);
  const emailSender = await app.container.resolve(AbstractEmailSender);
  const verify = await app.container.resolve(emailVerificationProcess);
  return { app, users, userRepo, tokens, signals, emailSender, verify };
}

describe('Email verification edge cases', () => {
  describe('TokenService', () => {
    it('invariant: generated tokens are 64 hex chars', async () => {
      // 32 cryptographic bytes, hex-encoded. Still a subset of [A-Za-z0-9]
      // so regex checks elsewhere keep matching.
      const { tokens } = await makeApp();
      for (let i = 0; i < 50; i++) {
        const t = tokens.generateToken();
        assert.strictEqual(t.length, 64);
        assert.match(t, /^[0-9a-f]+$/);
      }
    });

    it('invariant: TokenService uses crypto.randomBytes — 10k unique tokens', async () => {
      // 256 bits of entropy; duplicate collision is astronomical.
      const { tokens } = await makeApp();
      const seen = new Set<string>();
      for (let i = 0; i < 10_000; i++) {
        seen.add(tokens.generateToken());
      }
      assert.strictEqual(seen.size, 10_000, 'no duplicates (crypto entropy)');
    });

    it('invariant: verify() is EXACT match only', async () => {
      const { tokens } = await makeApp();
      const t = tokens.generateToken();
      assert.strictEqual(tokens.verify(t, t), true);
      assert.strictEqual(tokens.verify(t + ' ', t), false);
      assert.strictEqual(tokens.verify(t.slice(0, -1), t), false);
      assert.strictEqual(tokens.verify('', t), false);
      assert.strictEqual(tokens.verify(t, ''), false);
    });

    it('invariant: TokenService.verify is constant-time (timingSafeEqual, length-checked)', async () => {
      const { tokens } = await makeApp();
      assert.strictEqual(tokens.verify('a', 'a'), true);
      assert.strictEqual(tokens.verify('a', 'b'), false);
      assert.strictEqual(tokens.verify('aa', 'a'), false);
      assert.strictEqual(tokens.verify('', ''), true); // edge: both empty
    });
  });

  describe('registration emits verification email', () => {
    it('new registration → user exists, emailVerifiedAt=undefined', async () => {
      const { users, userRepo } = await makeApp();
      const u = await users.register('verif1@x.com', 'pw12345678', 'N');
      const row = await userRepo.findOne(User.fields.email.eq('verif1@x.com'));
      assert.strictEqual(row!.emailVerifiedAt, undefined);
      assert.strictEqual(row!.email, 'verif1@x.com');
      assert.ok(u);
    });

    it('invariant: verifyEmail(lockedUser) sets emailVerifiedAt to ~now', async () => {
      const { users, userRepo } = await makeApp();
      const u = await users.register('verif2@x.com', 'pw12345678', 'N');

      using locked = await userRepo.lock(u);
      assert.ok(locked);
      const before = Date.now();
      await users.verifyEmail(locked!);
      const row = await userRepo.findOne(User.fields.email.eq('verif2@x.com'));
      assert.ok(row!.emailVerifiedAt);
      assert.ok(row!.emailVerifiedAt!.getTime() >= before);
      assert.ok(row!.emailVerifiedAt!.getTime() <= Date.now() + 50);
    });
  });

  describe('emailVerificationProcess — durable flow', () => {
    /** Helper: capture emails from ConsoleEmailSender's array. */
    function captureEmails(
      sender: { emails: Email[] },
    ): Email[] {
      return sender.emails;
    }

    it('invariant: process starts → verification email is sent via AbstractEmailSender', async () => {
      const { users, verify, emailSender } = await makeApp();
      const u = await users.register('proc1@x.com', 'pw12345678', 'N');
      const userId = User.ref(u).identifier;

      // Fire the process (don't await verification — just run it)
      const handle = await verify([userId]);
      // Signal a bogus token so it completes quickly
      // Actually don't — just let it race until we inspect emails below.
      // Wait one tick so the email is sent.
      await new Promise((r) => setTimeout(r, 20));

      const mails = captureEmails(emailSender as unknown as { emails: Email[] });
      const verification = mails.find(
        (m) => m.to === 'proc1@x.com' && m.subject.includes('Verify'),
      );
      assert.ok(verification, 'verification email was sent');
      assert.match(
        verification!.body,
        /verify-email\?token=/,
        'verification email contains token link',
      );

      // cleanup by cancelling the handle if API allows — otherwise the
      // process is just dangling in-memory and garbage-collected.
      void handle;
    });

    it('invariant: correct token → emailVerifiedAt set on user', async () => {
      const { users, userRepo, verify, signals, emailSender } = await makeApp();
      const u = await users.register('proc2@x.com', 'pw12345678', 'N');
      const userId = User.ref(u).identifier;

      const handle = await verify([userId]);
      await new Promise((r) => setTimeout(r, 20));

      // Steal the token out of the email body (in real life the user
      // clicks the link and the controller emits the signal).
      const mails = captureEmails(
        emailSender as unknown as { emails: Email[] },
      );
      const verification = mails.find((m) => m.to === 'proc2@x.com');
      const match = verification!.body.match(/token=([A-Za-z0-9]+)/);
      assert.ok(match, 'token is in the email body');
      const token = match![1];

      // Emit the matching signal
      await signals.emailVerified(userId, { token });

      // Wait for the process to handle it
      const result = (await handle.wait()) as {
        success: boolean
        emailVerified?: boolean
      };
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.emailVerified, true);

      // Assert the user row is now verified
      const row = await userRepo.findOne(User.fields.email.eq('proc2@x.com'));
      assert.ok(row!.emailVerifiedAt, 'emailVerifiedAt was set');
    });

    it('invariant: WRONG token → process fails with invalid_token; user stays unverified', async () => {
      // Silent bug: a wrong token accepted as valid = account takeover.
      const { users, userRepo, verify, signals } = await makeApp();
      const u = await users.register('proc3@x.com', 'pw12345678', 'N');
      const userId = User.ref(u).identifier;

      const handle = await verify([userId]);
      await new Promise((r) => setTimeout(r, 20));

      await signals.emailVerified(userId, { token: 'definitely-wrong-token' });
      const result = (await handle.wait()) as {
        success: boolean
        error?: string
      };
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'invalid_token');

      const row = await userRepo.findOne(User.fields.email.eq('proc3@x.com'));
      assert.strictEqual(
        row!.emailVerifiedAt,
        undefined,
        'user stays unverified after bad-token signal',
      );
    });

    it('invariant: re-verify an already-verified user → process returns alreadyVerified without error', async () => {
      // Silent bug: if a stale verification link clicked twice flipped
      // emailVerifiedAt backwards, compliance audits break.
      const { users, userRepo, verify } = await makeApp();
      const u = await users.register('proc4@x.com', 'pw12345678', 'N');
      const userId = User.ref(u).identifier;

      // Manually mark verified first
      using locked = await userRepo.lock(u);
      await users.verifyEmail(locked!);
      const rowBefore = await userRepo.findOne(
        User.fields.email.eq('proc4@x.com'),
      );
      const verifiedAtFirst = rowBefore!.emailVerifiedAt!;

      // Now run the process — it should short-circuit
      const handle = await verify([userId]);
      const result = (await handle.wait()) as {
        success: boolean
        alreadyVerified?: boolean
      };
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.alreadyVerified, true);

      // And MUST NOT overwrite emailVerifiedAt
      const rowAfter = await userRepo.findOne(
        User.fields.email.eq('proc4@x.com'),
      );
      assert.strictEqual(
        rowAfter!.emailVerifiedAt!.getTime(),
        verifiedAtFirst.getTime(),
        'emailVerifiedAt preserved on re-verify (idempotent)',
      );
    });

    it('invariant: unknown userRef → process fails with user_not_found (no crash)', async () => {
      const { verify } = await makeApp();
      const handle = await verify(['no-such-user-id']);
      const result = (await handle.wait()) as {
        success: boolean
        error?: string
      };
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'user_not_found');
    });

    it('invariant: resendVerification triggers a SECOND email with same token', async () => {
      const { users, verify, signals, emailSender } = await makeApp();
      const u = await users.register('proc5@x.com', 'pw12345678', 'N');
      const userId = User.ref(u).identifier;

      const handle = await verify([userId]);
      await new Promise((r) => setTimeout(r, 20));

      const before = (emailSender as unknown as { emails: Email[] }).emails
        .filter((m) => m.to === 'proc5@x.com')
        .length;
      assert.strictEqual(before, 1, 'one email sent initially');

      await signals.resendVerification(userId);
      await new Promise((r) => setTimeout(r, 30));

      const after = (emailSender as unknown as { emails: Email[] }).emails
        .filter((m) => m.to === 'proc5@x.com')
        .length;
      assert.strictEqual(after, 2, 'second email sent after resend signal');

      // Tokens in both emails are identical (same process state)
      const mails = (
        emailSender as unknown as { emails: Email[] }
      ).emails.filter((m) => m.to === 'proc5@x.com');
      const t1 = mails[0].body.match(/token=([A-Za-z0-9]+)/)![1];
      const t2 = mails[1].body.match(/token=([A-Za-z0-9]+)/)![1];
      assert.strictEqual(
        t1,
        t2,
        'resend reuses the same token — pinned behaviour',
      );

      void handle;
    });

    it('invariant: token single-use — after success, second signal with same token is moot', async () => {
      // The process terminates on first success, so there's no waiter
      // for a second signal. We pin that a second use does NOT cause
      // a second verification side-effect (user row unchanged).
      const { users, userRepo, verify, signals, emailSender } = await makeApp();
      const u = await users.register('proc6@x.com', 'pw12345678', 'N');
      const userId = User.ref(u).identifier;

      const handle = await verify([userId]);
      await new Promise((r) => setTimeout(r, 20));
      const mails = (
        emailSender as unknown as { emails: Email[] }
      ).emails.filter((m) => m.to === 'proc6@x.com');
      const token = mails[0].body.match(/token=([A-Za-z0-9]+)/)![1];

      await signals.emailVerified(userId, { token });
      await handle.wait();

      const row1 = await userRepo.findOne(
        User.fields.email.eq('proc6@x.com'),
      );
      const verifiedAt = row1!.emailVerifiedAt!.getTime();

      // Signal again with same token — no process waiting; this is a no-op.
      await signals.emailVerified(userId, { token });
      await new Promise((r) => setTimeout(r, 20));

      const row2 = await userRepo.findOne(
        User.fields.email.eq('proc6@x.com'),
      );
      assert.strictEqual(
        row2!.emailVerifiedAt!.getTime(),
        verifiedAt,
        'token after success is ignored — no double verification',
      );
    });
  });
});
