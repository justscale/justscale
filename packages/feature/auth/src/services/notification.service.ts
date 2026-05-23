import { defineService } from '@justscale/core';
import { AbstractEmailSender } from './email.service.js';

/**
 * Notification Service
 *
 * Sends auth-related emails using the configured EmailSender.
 * Provides high-level methods for verification, password reset, etc.
 *
 * @example
 * ```typescript
 * // The EmailSender must be registered in your cluster:
 * cluster.register(EmailSender, SendGridEmailSender)
 *
 * // Then NotificationService will use it automatically
 * const notifications = container.resolve(NotificationService)
 * await notifications.sendVerificationEmail('user@example.com', 'token123')
 * ```
 */
export class NotificationService extends defineService({
  inject: {
    email: AbstractEmailSender,
  },
  factory: ({ email }) => ({
    /**
     * Send a verification email with a token.
     */
    async sendVerificationEmail(
      to: string,
      token: string,
      baseUrl = 'https://app.example.com',
    ): Promise<void> {
      const verifyUrl = `${baseUrl}/verify-email?token=${token}`;
      await email.send({
        to,
        subject: 'Verify your email address',
        body: `Welcome! Please verify your email by clicking this link:\n\n${verifyUrl}\n\nThis link expires in 24 hours.`,
        html: `
          <h1>Welcome!</h1>
          <p>Please verify your email by clicking the link below:</p>
          <p><a href="${verifyUrl}">Verify Email</a></p>
          <p>This link expires in 24 hours.</p>
        `,
      });
    },

    /**
     * Send a password reset email.
     */
    async sendPasswordResetEmail(
      to: string,
      token: string,
      baseUrl = 'https://app.example.com',
    ): Promise<void> {
      const resetUrl = `${baseUrl}/reset-password?token=${token}`;
      await email.send({
        to,
        subject: 'Password Reset Request',
        body: `Click here to reset your password: ${resetUrl}\n\nThis link expires in 15 minutes.`,
        html: `
          <h1>Password Reset</h1>
          <p>Click the link below to reset your password:</p>
          <p><a href="${resetUrl}">Reset Password</a></p>
          <p>This link expires in 15 minutes.</p>
          <p>If you didn't request this, you can safely ignore this email.</p>
        `,
      });
    },

    /**
     * Send a 2FA setup confirmation email.
     */
    async send2FAEnabledEmail(to: string): Promise<void> {
      await email.send({
        to,
        subject: 'Two-Factor Authentication Enabled',
        body: 'Two-factor authentication has been enabled on your account.\n\nIf you didn\'t do this, please contact support immediately.',
        html: `
          <h1>2FA Enabled</h1>
          <p>Two-factor authentication has been enabled on your account.</p>
          <p>If you didn't do this, please contact support immediately.</p>
        `,
      });
    },

    /**
     * Send a 2FA disabled notification email.
     */
    async send2FADisabledEmail(to: string): Promise<void> {
      await email.send({
        to,
        subject: 'Two-Factor Authentication Disabled',
        body: 'Two-factor authentication has been disabled on your account.\n\nIf you didn\'t do this, please contact support immediately.',
        html: `
          <h1>2FA Disabled</h1>
          <p>Two-factor authentication has been disabled on your account.</p>
          <p>If you didn't do this, please contact support immediately.</p>
        `,
      });
    },

    /**
     * Send a welcome email after registration.
     */
    async sendWelcomeEmail(to: string, name?: string): Promise<void> {
      const greeting = name ? `Hi ${name}!` : 'Welcome!';
      await email.send({
        to,
        subject: 'Welcome to JustScale',
        body: `${greeting}\n\nThank you for signing up. We're excited to have you!`,
        html: `
          <h1>${greeting}</h1>
          <p>Thank you for signing up. We're excited to have you!</p>
        `,
      });
    },

    /**
     * Send a password changed notification.
     */
    async sendPasswordChangedEmail(to: string): Promise<void> {
      await email.send({
        to,
        subject: 'Password Changed',
        body: 'Your password has been changed.\n\nIf you didn\'t do this, please reset your password immediately.',
        html: `
          <h1>Password Changed</h1>
          <p>Your password has been changed.</p>
          <p>If you didn't do this, please reset your password immediately.</p>
        `,
      });
    },
  }),
}) {}

export type NotificationServiceInstance = ReturnType<
  typeof NotificationService.factory
>;
