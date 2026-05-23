import { createHmac } from 'node:crypto';
import { defineService } from '@justscale/core';
import { ModelRepository, type Locked, type Persistent, type Ref } from '@justscale/core/models';
import { AbstractProcessExecutor } from '@justscale/core/process';
import { User } from '../models/user.js';

/**
 * Rate-limit policy for login-time TOTP verification.
 *
 * After `MAX_FAILED_ATTEMPTS` failures the account is locked for
 * `LOCKOUT_MS` milliseconds. Failures persist in the User row
 * (`twoFactorFailedAttempts`, `twoFactorLockedUntil`) so a restart
 * doesn't reset the counter.
 */
const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Decode a base32-encoded string to a Buffer.
 * RFC 4648 base32 alphabet: A-Z2-7
 */
function base32Decode(encoded: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const stripped = encoded.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (const char of stripped) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/**
 * Generate a TOTP code for a given time counter.
 * Implements RFC 6238 / RFC 4226 HOTP with SHA-1, 6 digits.
 */
function generateTOTPCode(secret: Buffer, counter: bigint): string {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(counter);

  const hmac = createHmac('sha1', secret).update(counterBuf).digest();

  // Dynamic truncation (RFC 4226 Section 5.4)
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(code % 1_000_000).padStart(6, '0');
}

/**
 * TOTP-based Two-Factor Authentication Service
 *
 * Provides MFA using Time-based One-Time Passwords (TOTP) compatible with
 * authenticator apps like Google Authenticator, Authy, 1Password, etc.
 *
 * @example
 * ```typescript
 * // Setup flow:
 * const secret = twofa.generateSecret()
 * const otpauthUrl = twofa.generateOtpauthUrl(secret, user.email)
 * // Show QR code of otpauthUrl to user
 * // User scans with authenticator app
 * // User enters 6-digit code from app
 * const isValid = twofa.verifyTOTP(code, secret)
 * if (isValid) await twofa.enable2FA(userId, secret)
 * ```
 */
export class TwoFactorService extends defineService({
  inject: {
    users: ModelRepository.of(User),
    executor: AbstractProcessExecutor,
  },
  factory: ({ users, executor }) => ({
    /**
     * Generate a cryptographically secure TOTP secret.
     * Returns a base32-encoded 160-bit secret (32 characters).
     */
    generateSecret(): string {
      const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      const randomBytes = new Uint8Array(20); // 160 bits
      crypto.getRandomValues(randomBytes);

      let secret = '';
      for (const byte of randomBytes) {
        secret += base32Chars[byte % 32];
      }
      return secret;
    },

    /**
     * Generate an otpauth:// URL for authenticator apps.
     * This URL can be encoded as a QR code for easy scanning.
     *
     * @param secret - The TOTP secret (base32 encoded)
     * @param accountName - Usually the user's email
     * @param issuer - Your app name shown in authenticator
     */
    generateOtpauthUrl(
      secret: string,
      accountName: string,
      issuer = 'JustScale',
    ): string {
      const encodedIssuer = encodeURIComponent(issuer);
      const encodedAccount = encodeURIComponent(accountName);
      // Standard TOTP parameters: 6 digits, 30 second period, SHA1
      return `otpauth://totp/${encodedIssuer}:${encodedAccount}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`;
    },

    /**
     * Verify a TOTP code against a secret.
     *
     * Implements RFC 6238 TOTP verification with HMAC-SHA1
     * and a +/-1 time step window (30s) for clock drift.
     *
     * @param code - The 6-digit code from the authenticator app
     * @param secret - The user's TOTP secret (base32 encoded)
     * @returns true if code is valid for current or adjacent time windows
     */
    verifyTOTP(code: string, secret: string): boolean {
      if (!/^\d{6}$/.test(code)) {
        return false;
      }
      return this._verifyTOTPImpl(code, secret);
    },

    /**
     * Internal TOTP verification using HMAC-SHA1.
     * Checks current time step and +/-1 window for clock drift.
     */
    _verifyTOTPImpl(code: string, secret: string): boolean {
      const secretBytes = base32Decode(secret);
      const now = Math.floor(Date.now() / 1000);
      const timeStep = 30;

      // Check current time step and +/-1 for clock drift
      for (let offset = -1; offset <= 1; offset++) {
        const counter = BigInt(Math.floor(now / timeStep) + offset);
        if (generateTOTPCode(secretBytes, counter) === code) {
          return true;
        }
      }
      return false;
    },

    /**
     * Generate the current TOTP code for a secret.
     * Used in tests; in production the authenticator app generates codes.
     */
    generateCurrentCode(secret: string): string {
      const secretBytes = base32Decode(secret);
      const counter = BigInt(Math.floor(Date.now() / 1000 / 30));
      return generateTOTPCode(secretBytes, counter);
    },

    /**
     * Login-time TOTP verification with durable rate limiting.
     *
     * Checks the lockout window BEFORE the crypto compare so an attacker
     * who has saturated the counter cannot keep guessing. On success the
     * counter resets; on failure it increments and, at the threshold,
     * sets `twoFactorLockedUntil`.
     *
     * @returns 'locked' if the account is currently in the lockout
     *   window, otherwise whether the code was valid.
     */
    async verifyTOTPForUser(
      user: Locked<User>,
      code: string,
    ): Promise<'locked' | boolean> {
      const now = new Date();
      if (user.twoFactorLockedUntil && user.twoFactorLockedUntil > now) {
        return 'locked';
      }
      if (!user.twoFactorSecret) return false;

      const valid =
        /^\d{6}$/.test(code) && this._verifyTOTPImpl(code, user.twoFactorSecret);

      if (valid) {
        await users.update(user, {
          twoFactorFailedAttempts: 0,
          twoFactorLockedUntil: undefined,
        });
        return true;
      }

      const nextCount = (user.twoFactorFailedAttempts ?? 0) + 1;
      if (nextCount >= MAX_FAILED_ATTEMPTS) {
        await users.update(user, {
          twoFactorFailedAttempts: nextCount,
          twoFactorLockedUntil: new Date(now.getTime() + LOCKOUT_MS),
        });
      } else {
        await users.update(user, { twoFactorFailedAttempts: nextCount });
      }
      return false;
    },

    /**
     * Enable 2FA for a user after successful TOTP verification.
     */
    async enable2FA(user: Locked<User>, secret: string): Promise<void> {
      await users.update(user, {
        twoFactorSecret: secret,
        twoFactorEnabled: true,
        twoFactorFailedAttempts: 0,
        twoFactorLockedUntil: undefined,
      });
    },

    /**
     * Disable 2FA for a user.
     */
    async disable2FA(user: Locked<User>): Promise<void> {
      await users.update(user, {
        twoFactorSecret: undefined,
        twoFactorEnabled: false,
        twoFactorFailedAttempts: 0,
        twoFactorLockedUntil: undefined,
      });
    },

    /**
     * Check if a user has 2FA/MFA enabled.
     */
    async isMFAEnabled(user: Ref<User>): Promise<boolean> {
      const found = await users.get(user);
      return found?.twoFactorEnabled ?? false;
    },

    /**
     * Get user's 2FA status and metadata.
     */
    async getMFAStatus(user: Ref<User>): Promise<{
      enabled: boolean
      hasSecret: boolean
    }> {
      const found = await users.get(user);
      return {
        enabled: found?.twoFactorEnabled ?? false,
        hasSecret: !!found?.twoFactorSecret,
      };
    },

    /**
     * Signal: User submitted a TOTP code from their authenticator app.
     */
    codeSubmitted: executor.createSignal<
      [userRef: string],
      { code: string; attempt: number }
    >('auth.mfa.code_submitted', ['userRef']),

    /**
     * Signal: User cancelled MFA verification.
     */
    cancelled: executor.createSignal<[userRef: string]>('auth.mfa.cancelled', [
      'userRef',
    ]),

    /**
     * Signal: MFA setup completed successfully.
     */
    setupCompleted: executor.createSignal<[userRef: string]>(
      'auth.mfa.setup_completed',
      ['userRef'],
    ),
  }),
}) {}

export type TwoFactorServiceInstance = ReturnType<
  typeof TwoFactorService.factory
>;
