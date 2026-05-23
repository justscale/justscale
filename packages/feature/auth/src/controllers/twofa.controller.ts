import { createController } from '@justscale/core';
import { Delete, Get, Post } from '@justscale/http/builder';
import { ModelRepository, type Persistent } from '@justscale/core/models';
import { User } from '../models/user.js';
import { Session } from '../models/session.js';
import {
  ErrorResponse,
  MessageResponse,
  TwoFactorSetupResponse,
  TwoFactorStatusResponse,
  TwoFactorVerifyBody,
} from '../schemas/auth.schemas.js';
import { NotificationService } from '../services/notification.service.js';
import { SessionService } from '../services/session.service.js';
import { TwoFactorService } from '../services/twofa.service.js';

/**
 * Two-Factor Authentication Controller
 *
 * Provides endpoints for managing TOTP-based 2FA.
 *
 * Endpoints:
 * - GET /auth/2fa/status - Get 2FA status
 * - POST /auth/2fa/setup - Start 2FA setup (returns secret and QR code URL)
 * - POST /auth/2fa/verify - Verify and enable 2FA
 * - DELETE /auth/2fa - Disable 2FA
 */
export const TwoFactorController = createController('/auth/2fa', {
  inject: {
    sessions: SessionService,
    twofa: TwoFactorService,
    notifications: NotificationService,
    sessionRepo: ModelRepository.of(Session),
    userRepo: ModelRepository.of(User),
  },
  routes: ({ sessions, twofa, notifications, sessionRepo, userRepo }) => {
    // Helper to extract authenticated user
    const requireAuth = async ({
      req,
      res,
    }: {
      req: { headers: Record<string, string | string[] | undefined> }
      res: any
    }) => {
      const authHeader = String(req.headers.authorization ?? '');
      const token = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : authHeader;

      if (!token) {
        res.status(401).json({ error: 'Missing Authorization header' });
        throw new Error('Unauthorized');
      }

      const session = await sessions.findByToken(token);
      if (!session) {
        res.status(401).json({ error: 'Invalid or expired session' });
        throw new Error('Unauthorized');
      }

      const user = await session.user as Persistent<User> | undefined;
      if (!user) {
        res.status(401).json({ error: 'User not found' });
        throw new Error('Unauthorized');
      }

      await using lockedSession = await sessionRepo.lock(session);
      if (lockedSession) await sessions.touch(lockedSession);
      return { session, user };
    };

    return {
      /**
       * GET /auth/2fa/status
       * Get current 2FA status for the authenticated user.
       */
      status: Get('/status')
        .use(requireAuth)
        .returns(200, TwoFactorStatusResponse)
        .handle(async ({ user, res }) => {
          const status = await twofa.getMFAStatus(user);
          res.json(status);
        }),

      /**
       * POST /auth/2fa/setup
       * Start 2FA setup. Returns secret and otpauth URL for QR code.
       * User must verify with /auth/2fa/verify before 2FA is enabled.
       */
      setup: Post('/setup')
        .use(requireAuth)
        .returns(200, TwoFactorSetupResponse)
        .returns(400, ErrorResponse)
        .handle(async ({ user, res }) => {
          // Check if already enabled
          if (user.twoFactorEnabled) {
            res.status(400).json({
              error: 'Two-factor authentication is already enabled',
              code: '2FA_ALREADY_ENABLED',
            });
            return;
          }

          // Generate secret
          const secret = twofa.generateSecret();
          const otpauthUrl = twofa.generateOtpauthUrl(secret, user.email);

          res.json({
            secret,
            otpauthUrl,
          });
        }),

      /**
       * POST /auth/2fa/verify
       * Verify 2FA code and enable 2FA on the account.
       */
      verify: Post('/verify')
        .use(requireAuth)
        .body(
          TwoFactorVerifyBody.extend({
            secret: TwoFactorSetupResponse.shape.secret,
          }),
        )
        .returns(200, MessageResponse)
        .returns(400, ErrorResponse)
        .handle(async ({ body, user, res }) => {
          // Verify the code against the provided secret
          const isValid = twofa.verifyTOTP(body.code, body.secret);

          if (!isValid) {
            res.status(400).json({
              error: 'Invalid verification code',
              code: 'INVALID_CODE',
            });
            return;
          }

          // Enable 2FA
          await using lockedUser = await userRepo.lock(user);
          if (!lockedUser) return;
          await twofa.enable2FA(lockedUser, body.secret);

          // Notify user
          await notifications.send2FAEnabledEmail(user.email);

          res.json({ message: 'Two-factor authentication has been enabled' });
        }),

      /**
       * DELETE /auth/2fa
       * Disable 2FA. Requires current 2FA code for verification.
       */
      disable: Delete('/')
        .use(requireAuth)
        .body(TwoFactorVerifyBody)
        .returns(200, MessageResponse)
        .returns(400, ErrorResponse)
        .returns(401, ErrorResponse)
        .handle(async ({ body, user, res }) => {
          // Check if 2FA is enabled
          if (!user.twoFactorEnabled || !user.twoFactorSecret) {
            res.status(400).json({
              error: 'Two-factor authentication is not enabled',
              code: '2FA_NOT_ENABLED',
            });
            return;
          }

          // Verify current code before disabling
          const isValid = twofa.verifyTOTP(body.code, user.twoFactorSecret);

          if (!isValid) {
            res.status(401).json({
              error: 'Invalid verification code',
              code: 'INVALID_CODE',
            });
            return;
          }

          // Disable 2FA
          await using lockedUser = await userRepo.lock(user);
          if (!lockedUser) return;
          await twofa.disable2FA(lockedUser);

          // Notify user
          await notifications.send2FADisabledEmail(user.email);

          res.json({ message: 'Two-factor authentication has been disabled' });
        }),
    };
  },
});
