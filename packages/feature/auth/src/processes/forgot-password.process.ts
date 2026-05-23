import { randomBytes, timingSafeEqual } from 'node:crypto';
import { defineService } from '@justscale/core';
import { createProcess, delay, race, signal } from '@justscale/core/process';
import { ModelRepository } from '@justscale/core/models';
import { User } from '../models/user.js';
import { NotificationService } from '../services/notification.service.js';
import { AuthSignals } from '../services/signals.service.js';
import { UserService } from '../services/user.service.js';


export class PasswordResetTokenService extends defineService({
  inject: {},
  factory: () => ({
    /**
     * Generate a secure reset token.
     * 32 random bytes, hex-encoded (64 chars).
     */
    generateToken(): string {
      return randomBytes(32).toString('hex');
    },

    /**
     * Verify tokens match in constant time.
     */
    verify(submitted: string, expected: string): boolean {
      const a = Buffer.from(submitted, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      if (a.length !== b.length) return false;
      if (a.length === 0) return true;
      return timingSafeEqual(a, b);
    },
  }),
}) {}

/**
 * Forgot password process - handles durable password reset flow.
 *
 * Identity is by email address. The process:
 * 1. Looks up user by email (returns success even if not found to prevent enumeration)
 * 2. Generates a secure reset token
 * 3. Sends reset email
 * 4. Waits for user to submit new password via signal
 * 5. Verifies token and updates password
 */
export const forgotPassword = createProcess({
  path: '/auth/forgot-password/:email',
  inject: {
    users: UserService,
    notifications: NotificationService,
    tokens: PasswordResetTokenService,
    signals: AuthSignals,
    userRepo: ModelRepository.of(User),
  },

  async handler({ users, notifications, tokens, signals, userRepo }, { email }) {
    using user = await users.findByEmail(email);

    if (!user) {
      // Don't reveal if user exists - just pretend we sent email
      return {
        success: true,
        message: 'If an account exists, a reset email has been sent.',
      };
    }

    const resetToken = tokens.generateToken();

    await notifications.sendPasswordResetEmail(email, resetToken);

    const r = race();

    switch (true) {
      case signal(r, signals.passwordResetVerified): {
        if (!tokens.verify(r.token, resetToken)) {
          return {
            success: false,
            error: 'invalid_token',
            message: 'Invalid or expired reset token',
          };
        }

        // Update password: re-fetch by email since process may have serialized/deserialized
        using lockedUser = await userRepo.lock(users.findByEmail(email));
        if (lockedUser) await users.updatePassword(lockedUser, r.newPassword);

        return {
          success: true,
          message: 'Password has been reset successfully.',
        };
      }

      case delay.minutes(r, 15):
        return {
          success: false,
          error: 'timeout',
          message: 'Password reset request expired.',
        };
    }
  },
});
