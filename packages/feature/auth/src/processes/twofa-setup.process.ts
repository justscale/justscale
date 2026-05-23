/**
 * Two-Factor Authentication Setup Process
 *
 * Durable process for setting up 2FA on a user account.
 *
 * Flow:
 * 1. Generate TOTP secret and QR code
 * 2. User scans QR code with authenticator app
 * 3. Wait for user to submit verification code
 * 4. Verify code matches the secret
 * 5. Enable 2FA on account
 *
 * @example
 * ```typescript
 * // Start 2FA setup
 * const result = await runtime.invoke(twoFactorSetup, { userId: 'user-123' })
 * // Returns: { qrCodeUrl: '...', setupId: '...' }
 *
 * // User scans QR code, then submits code via signal
 * await signalBus.emit('auth.2fa.code_submitted', {
 *   userId: 'user-123',
 *   code: '123456',
 *   attempt: 1
 * })
 * ```
 */
import { createProcess, delay, race, signal } from '@justscale/core/process';
import { ModelRepository } from '@justscale/core/models';
import { User } from '../models/user.js';
import { TwoFactorService } from '../services/twofa.service.js';
import { UserService } from '../services/user.service.js';

export const twoFactorSetup = createProcess({
  path: '/auth/:userRef/2fa/setup',
  types: { User },
  inject: {
    twofa: TwoFactorService,
    users: UserService,
    userRepo: ModelRepository.of(User),
  },

  async handler({ twofa, users, userRepo }, { userRef }) {
    // Check if user exists (using for rehydration support)
    using user = await users.get(userRef);
    if (!user) {
      return { success: false, error: 'user_not_found' };
    }

    // Check if 2FA is already enabled
    if (user.twoFactorEnabled) {
      return { success: false, error: '2fa_already_enabled' };
    }

    // Generate TOTP secret and otpauth URL for QR code
    const secret = twofa.generateSecret();
    const _otpauthUrl = twofa.generateOtpauthUrl(secret, user.email);

    // Race: wait for code submission or timeout
    const r = race();

    switch (true) {
      case signal(r, twofa.codeSubmitted): {
        // User submitted a code - verify it
        const isValid = twofa.verifyTOTP(r.code, secret);

        if (!isValid) {
          return {
            success: false,
            error: 'invalid_code',
            attempt: r.attempt,
          };
        }

        // Enable 2FA on the account
        using lockedUser = await userRepo.lock(userRef);
        if (lockedUser) await twofa.enable2FA(lockedUser, secret);

        return {
          success: true,
          message: 'Two-factor authentication has been enabled.',
        };
      }

      case signal(r, twofa.cancelled):
        return { success: false, error: 'cancelled' };

      case delay.minutes(r, 10):
        return { success: false, error: 'setup_timeout' };
    }
  },
});

/**
 * Process to verify 2FA during login.
 *
 * Called after password verification when 2FA is enabled.
 */
export const twoFactorVerify = createProcess({
  path: '/auth/:userRef/2fa/verify',
  types: { User },
  inject: {
    twofa: TwoFactorService,
    users: UserService,
  },

  async handler({ twofa, users }, { userRef }) {
    using user = await users.get(userRef);
    if (!user) {
      return { success: false, error: 'user_not_found' };
    }

    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      return { success: false, error: '2fa_not_enabled' };
    }

    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      const r = race();

      switch (true) {
        case signal(r, twofa.codeSubmitted): {
          attempts++;

          const isValid = twofa.verifyTOTP(r.code, user.twoFactorSecret);

          if (isValid) {
            return {
              success: true,
              attempts,
            };
          }

          // Invalid code - continue loop for retry
          if (attempts >= maxAttempts) {
            return {
              success: false,
              error: 'max_attempts_exceeded',
              attempts,
            };
          }
          continue;
        }

        case signal(r, twofa.cancelled):
          return { success: false, error: 'cancelled', attempts };

        case delay.minutes(r, 5):
          return { success: false, error: 'verification_timeout', attempts };
      }
    }

    return { success: false, error: 'max_attempts_exceeded', attempts };
  },
});

/**
 * Process to disable 2FA on an account.
 *
 * Requires current 2FA code verification before disabling.
 */
export const twoFactorDisable = createProcess({
  path: '/auth/:userRef/2fa/disable',
  types: { User },
  inject: {
    twofa: TwoFactorService,
    users: UserService,
    userRepo: ModelRepository.of(User),
  },

  async handler({ twofa, users, userRepo }, { userRef }) {
    using user = await users.get(userRef);
    if (!user) {
      return { success: false, error: 'user_not_found' };
    }

    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      return { success: false, error: '2fa_not_enabled' };
    }

    // Require code verification before disabling
    const r = race();

    switch (true) {
      case signal(r, twofa.codeSubmitted): {
        const isValid = twofa.verifyTOTP(r.code, user.twoFactorSecret);

        if (!isValid) {
          return { success: false, error: 'invalid_code' };
        }

        // Disable 2FA
        using lockedUser = await userRepo.lock(userRef);
        if (lockedUser) await twofa.disable2FA(lockedUser);

        return {
          success: true,
          message: 'Two-factor authentication has been disabled.',
        };
      }

      case signal(r, twofa.cancelled):
        return { success: false, error: 'cancelled' };

      case delay.minutes(r, 5):
        return { success: false, error: 'verification_timeout' };
    }
  },
});
