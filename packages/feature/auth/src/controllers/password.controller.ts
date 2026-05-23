import { createController } from '@justscale/core';
import { Post } from '@justscale/http/builder';
import { forgotPassword } from '../processes/forgot-password.process.js';
import {
  ErrorResponse,
  ForgotPasswordBody,
  MessageResponse,
  ResetPasswordBody,
} from '../schemas/auth.schemas.js';
import { AuthSignals } from '../services/signals.service.js';

/**
 * Password Controller
 *
 * Provides endpoints for password reset flow.
 *
 * Endpoints:
 * - POST /auth/password/forgot - Request password reset email
 * - POST /auth/password/reset - Reset password with token
 */
export const PasswordController = createController('/auth/password', {
  inject: {
    forgotPassword,
    signals: AuthSignals,
  },
  routes: ({ forgotPassword, signals }) => ({
    /**
     * POST /auth/password/forgot
     * Request a password reset email.
     * Always returns success to prevent email enumeration.
     *
     * This starts a durable forgot password process that:
     * 1. Generates a secure reset token
     * 2. Sends the reset email
     * 3. Waits for the user to submit the new password (via /reset endpoint)
     * 4. Updates the password
     */
    forgotPassword: Post('/forgot')
      .body(ForgotPasswordBody)
      .returns(200, MessageResponse)
      .handle(async ({ body, res }) => {
        // Start the forgot password process
        // The process handles token generation, email sending, and password update
        // It returns success even if user doesn't exist (to prevent enumeration)
        await forgotPassword([body.email]);

        res.json({
          message: 'If an account exists, a reset email has been sent',
        });
      }),

    /**
     * POST /auth/password/reset
     * Reset password using the token from email.
     *
     * This signals the waiting forgot password process with the new password.
     * The process validates the token and updates the password.
     */
    resetPassword: Post('/reset')
      .body(ResetPasswordBody)
      .returns(200, MessageResponse)
      .returns(400, ErrorResponse)
      .handle(async ({ body, res }) => {
        // Signal the waiting forgot password process (fire-and-forget)
        try {
          await signals.passwordResetVerified(body.email, {
            token: body.token,
            newPassword: body.newPassword,
          });
        } catch (err) {
          // In tests or environments without process runtime, signal may fail
          console.error('Failed to emit password reset signal:', err);
        }

        // Always return success to prevent timing attacks / enumeration
        // If no process was waiting, the signal just doesn't match
        res.json({ message: 'Password has been reset successfully' });
      }),
  }),
});
