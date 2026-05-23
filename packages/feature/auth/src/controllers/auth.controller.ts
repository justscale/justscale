import { Config, createController } from '@justscale/core';
import { Get, Post } from '@justscale/http/builder';
import { HttpConfig, getClientIp } from '@justscale/http';
import { z } from 'zod';
import { ModelRepository, type Persistent } from '@justscale/core/models';
import { User } from '../models/user.js';
import { Session } from '../models/session.js';
import { emailVerificationProcess } from '../processes/signup.process.js';
import {
  AuthResponse,
  ChangePasswordBody,
  ErrorResponse,
  Login2FABody,
  Login2FARequiredResponse,
  LoginBody,
  MessageResponse,
  RegisterBody,
  UserResponse,
  VerifyEmailBody,
} from '../schemas/auth.schemas.js';
import { NotificationService } from '../services/notification.service.js';
import { SessionService } from '../services/session.service.js';
import { AuthSignals } from '../services/signals.service.js';
import { TwoFactorService } from '../services/twofa.service.js';
import { UserExistsError, UserService } from '../services/user.service.js';

/**
 * Authentication Controller
 *
 * Provides endpoints for user registration, login, logout, and profile management.
 *
 * Endpoints:
 * - POST /auth/register - Create new account
 * - POST /auth/login - Login with email/password
 * - POST /auth/login/2fa - Complete login with 2FA code
 * - POST /auth/logout - Logout current session
 * - GET /auth/me - Get current user
 * - POST /auth/change-password - Change password
 */
export const AuthController = createController('/auth', {
  inject: {
    users: UserService,
    sessions: SessionService,
    twofa: TwoFactorService,
    notifications: NotificationService,
    signals: AuthSignals,
    emailVerificationProcess,
    sessionRepo: ModelRepository.of(Session),
    userRepo: ModelRepository.of(User),
    http: Config.of(HttpConfig),
  },
  routes: ({
    users,
    sessions,
    twofa,
    notifications,
    signals,
    emailVerificationProcess,
    sessionRepo,
    userRepo,
    http,
  }) => ({
    /**
     * POST /auth/register
     * Create a new user account.
     */
    register: Post('/register')
      .body(RegisterBody)
      .returns(201, AuthResponse)
      .returns(400, ErrorResponse)
      .returns(409, ErrorResponse)
      .handle(async ({ body, req, res }) => {
        try {
          const user = await users.register(
            body.email,
            body.password,
            body.name,
          );

          // Create session
          const session = await sessions.create(user, {
            ipAddress: getClientIp(req, http.trustedProxies),
            userAgent: String(req.headers['user-agent'] ?? ''),
          });

          // Start email verification process (durable workflow)
          // This sends the verification email and waits for the user to click the link
          await emailVerificationProcess([User.ref(user).identifier]);

          res.status(201).json({
            user: {
              id: User.ref(user).identifier,
              email: user.email,
              name: user.name,
              emailVerifiedAt: user.emailVerifiedAt?.toISOString(),
              twoFactorEnabled: user.twoFactorEnabled,
            },
            token: session.token,
          });
        } catch (error) {
          if (error instanceof UserExistsError) {
            res
              .status(409)
              .json({ error: 'Email already registered', code: 'USER_EXISTS' });
            return;
          }
          throw error;
        }
      }),

    /**
     * POST /auth/login
     * Login with email and password.
     * Returns token if no 2FA, or requires2FA: true if 2FA enabled.
     */
    login: Post('/login')
      .body(LoginBody)
      .returns(200, AuthResponse)
      .returns(202, Login2FARequiredResponse)
      .returns(401, ErrorResponse)
      .handle(async ({ body, req, res }) => {
        const user = await users.authenticate(body.email, body.password);

        if (!user) {
          res.status(401).json({
            error: 'Invalid email or password',
            code: 'INVALID_CREDENTIALS',
          });
          return;
        }

        // Check if 2FA is required
        if (user.twoFactorEnabled) {
          // Return indicator that 2FA is required
          // Client should call /auth/login/2fa with the code
          res.status(202).json({
            requires2FA: true as const,
            userId: User.ref(user).identifier,
          });
          return;
        }

        // No 2FA - create session directly
        const session = await sessions.create(user, {
          ipAddress: getClientIp(req, http.trustedProxies),
          userAgent: String(req.headers['user-agent'] ?? ''),
        });

        res.json({
          user: {
            id: User.ref(user).identifier,
            email: user.email,
            name: user.name,
            emailVerifiedAt: user.emailVerifiedAt?.toISOString(),
            twoFactorEnabled: user.twoFactorEnabled,
          },
          token: session.token,
        });
      }),

    /**
     * POST /auth/login/2fa
     * Complete login with 2FA code.
     */
    login2FA: Post('/login/2fa')
      .body(Login2FABody.extend({ userId: z.string() }))
      .returns(200, AuthResponse)
      .returns(401, ErrorResponse)
      .returns(429, ErrorResponse)
      .handle(async ({ body, req, res }) => {
        const user =
          (await users.get(User.ref`${body.userId}`)) ??
          (await users.findByEmail(body.userId));

        if (!user || !user.twoFactorSecret) {
          res
            .status(401)
            .json({ error: 'Invalid request', code: 'INVALID_REQUEST' });
          return;
        }

        await using lockedForVerify = await userRepo.lock(user);
        if (!lockedForVerify) {
          res
            .status(401)
            .json({ error: 'Invalid request', code: 'INVALID_REQUEST' });
          return;
        }
        const verifyResult = await twofa.verifyTOTPForUser(
          lockedForVerify,
          body.code,
        );
        if (verifyResult === 'locked') {
          res
            .status(429)
            .json({ error: 'Too many 2FA attempts', code: 'MFA_LOCKED' });
          return;
        }
        if (!verifyResult) {
          res
            .status(401)
            .json({ error: 'Invalid 2FA code', code: 'INVALID_2FA_CODE' });
          return;
        }

        const session = await sessions.create(user, {
          ipAddress: getClientIp(req, http.trustedProxies),
          userAgent: String(req.headers['user-agent'] ?? ''),
        });

        res.json({
          user: {
            id: User.ref(user).identifier,
            email: user.email,
            name: user.name,
            emailVerifiedAt: user.emailVerifiedAt?.toISOString(),
            twoFactorEnabled: user.twoFactorEnabled,
          },
          token: session.token,
        });
      }),

    /**
     * POST /auth/logout
     * Logout current session.
     */
    logout: Post('/logout')
      .use(async ({ req, res }) => {
        const authHeader = String(req.headers.authorization ?? '');
        if (!authHeader) {
          res.status(401).json({ error: 'Missing Authorization header' });
          throw new Error('Unauthorized');
        }
        if (!authHeader.startsWith('Bearer ')) {
          res.status(401).json({ error: 'Expected Bearer token' });
          throw new Error('Unauthorized');
        }
        const token = authHeader.slice(7);
        if (!token) {
          res.status(401).json({ error: 'Missing Authorization header' });
          throw new Error('Unauthorized');
        }

        const session = await sessions.findByToken(token);
        if (!session) {
          res.status(401).json({ error: 'Invalid or expired session' });
          throw new Error('Unauthorized');
        }

        return { session };
      })
      .returns(200, MessageResponse)
      .handle(async ({ session, res }) => {
        await using locked = await sessionRepo.lock(session);
        if (locked) await sessions.revoke(locked);
        res.json({ message: 'Logged out successfully' });
      }),

    /**
     * GET /auth/me
     * Get current authenticated user.
     */
    me: Get('/me')
      .use(async ({ req, res }) => {
        const authHeader = String(req.headers.authorization ?? '');
        if (!authHeader) {
          res.status(401).json({ error: 'Missing Authorization header' });
          throw new Error('Unauthorized');
        }
        if (!authHeader.startsWith('Bearer ')) {
          res.status(401).json({ error: 'Expected Bearer token' });
          throw new Error('Unauthorized');
        }
        const token = authHeader.slice(7);
        if (!token) {
          res.status(401).json({ error: 'Missing Authorization header' });
          throw new Error('Unauthorized');
        }

        const session = await sessions.findByToken(token);
        if (!session) {
          res.status(401).json({ error: 'Invalid or expired session' });
          throw new Error('Unauthorized');
        }

        const user = await userRepo.get(session.user);
        if (!user || user.disabledAt) {
          res.status(401).json({ error: 'Invalid or expired session' });
          throw new Error('Unauthorized');
        }

        await using lockedSession = await sessionRepo.lock(session);
        if (lockedSession) await sessions.touch(lockedSession);
        return { session, user };
      })
      .returns(200, UserResponse)
      .handle(async ({ user, res }) => {
        res.json({
          user: {
            id: User.ref(user).identifier,
            email: user.email,
            name: user.name,
            emailVerifiedAt: user.emailVerifiedAt?.toISOString(),
            twoFactorEnabled: user.twoFactorEnabled,
          },
        });
      }),

    /**
     * POST /auth/change-password
     * Change password for authenticated user.
     */
    changePassword: Post('/change-password')
      .use(async ({ req, res }) => {
        const authHeader = String(req.headers.authorization ?? '');
        if (!authHeader) {
          res.status(401).json({ error: 'Missing Authorization header' });
          throw new Error('Unauthorized');
        }
        if (!authHeader.startsWith('Bearer ')) {
          res.status(401).json({ error: 'Expected Bearer token' });
          throw new Error('Unauthorized');
        }
        const token = authHeader.slice(7);
        if (!token) {
          res.status(401).json({ error: 'Missing Authorization header' });
          throw new Error('Unauthorized');
        }

        const session = await sessions.findByToken(token);
        if (!session) {
          res.status(401).json({ error: 'Invalid or expired session' });
          throw new Error('Unauthorized');
        }

        const user = await userRepo.get(session.user);
        if (!user || user.disabledAt) {
          res.status(401).json({ error: 'Invalid or expired session' });
          throw new Error('Unauthorized');
        }

        await using lockedSession = await sessionRepo.lock(session);
        if (lockedSession) await sessions.touch(lockedSession);
        return { session, user };
      })
      .body(ChangePasswordBody)
      .returns(200, MessageResponse)
      .returns(401, ErrorResponse)
      .handle(async ({ body, user, session, res }) => {
        // Verify current password
        const verified = await users.authenticate(
          user.email,
          body.currentPassword,
        );
        if (!verified) {
          res.status(401).json({
            error: 'Current password is incorrect',
            code: 'INVALID_PASSWORD',
          });
          return;
        }

        await using lockedUser = await userRepo.lock(user as Persistent<User>);
        if (lockedUser) await users.updatePassword(lockedUser, body.newPassword);

        // Revoke every other session for this user - a password change
        // should kick out an attacker who may have stolen a session. The
        // caller's own session stays alive so they don't have to log in
        // again on the current device.
        await sessions.revokeAllForUser(User.ref(user), {
          exceptToken: session.token,
        });

        // Notify user
        await notifications.sendPasswordChangedEmail(user.email);

        res.json({ message: 'Password changed successfully' });
      }),

    /**
     * POST /auth/verify-email
     * Verify email address using the token from the verification email.
     *
     * This signals the waiting email verification process.
     */
    verifyEmail: Post('/verify-email')
      .body(VerifyEmailBody.extend({ userId: z.string() }))
      .returns(200, MessageResponse)
      .returns(400, ErrorResponse)
      .handle(async ({ body, res }) => {
        // Signal the waiting email verification process (fire-and-forget)
        try {
          await signals.emailVerified(body.userId, { token: body.token });
        } catch (err) {
          console.error('Failed to emit email verified signal:', err);
        }

        // Always return success (process validates token internally)
        res.json({ message: 'Email verified successfully' });
      }),

    /**
     * POST /auth/resend-verification
     * Request to resend the verification email.
     */
    resendVerification: Post('/resend-verification')
      .body(z.object({ userId: z.string() }))
      .returns(200, MessageResponse)
      .handle(async ({ body, res }) => {
        // Signal the waiting process to resend email (fire-and-forget)
        try {
          await signals.resendVerification(body.userId);
        } catch (err) {
          console.error('Failed to emit resend verification signal:', err);
        }

        res.json({ message: 'Verification email sent' });
      }),
  }),
});
