import { randomBytes, timingSafeEqual } from 'node:crypto';
import { defineService } from '@justscale/core';
import { User } from '../models/user.js';
import { createProcess, delay, race, signal } from '@justscale/core/process';
import { ModelRepository } from '@justscale/core/models';
import { NotificationService } from '../services/notification.service.js';
import { AuthSignals } from '../services/signals.service.js';
import { UserService } from '../services/user.service.js';

export class TokenService extends defineService({
  inject: {},
  factory: () => ({
    /**
     * Generate a secure verification token.
     * 32 random bytes, hex-encoded (64 chars, [0-9a-f]).
     */
    generateToken(): string {
      return randomBytes(32).toString('hex');
    },

    /**
     * Verify a token matches in constant time.
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
 * Email verification process - handles the durable email verification flow.
 *
 * Start this process after creating a user to handle email verification.
 * Supports resending the verification email up to 3 times.
 */
export const emailVerificationProcess = createProcess({
  path: '/auth/:userRef/verify-email',
  types: { User },
  inject: {
    users: UserService,
    notifications: NotificationService,
    tokens: TokenService,
    signals: AuthSignals,
    userRepo: ModelRepository.of(User),
  },

  async handler({ users, notifications, tokens, signals, userRepo }, { userRef }) {
    using user = await users.get(userRef);
    if (!user) {
      return { success: false, error: 'user_not_found' };
    }

    if (user.emailVerifiedAt) {
      return { success: true, alreadyVerified: true };
    }

    const verificationToken = tokens.generateToken();

    await notifications.sendVerificationEmail(user.email, verificationToken);

    let resendCount = 0;
    const maxResends = 3;

    while (resendCount <= maxResends) {
      const r = race();

      switch (true) {
        case signal(r, signals.emailVerified): {
          if (!tokens.verify(r.token, verificationToken)) {
            return {
              success: false,
              error: 'invalid_token',
            };
          }

          using lockedUser = await userRepo.lock(userRef);
          if (lockedUser) await users.verifyEmail(lockedUser);

          return {
            success: true,
            emailVerified: true,
          };
        }

        case signal(r, signals.resendVerification):
          resendCount++;
          if (resendCount <= maxResends) {
            await notifications.sendVerificationEmail(
              user.email,
              verificationToken,
            );
          }
          continue;

        case delay.hours(r, 24):
          return {
            success: false,
            error: 'verification_expired',
            resendCount,
          };
      }
    }

    return {
      success: false,
      error: 'max_resends_exceeded',
      resendCount,
    };
  },
});

// Alias for backwards compatibility
export const signup = emailVerificationProcess;
