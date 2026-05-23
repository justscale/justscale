import assert from 'node:assert';
import { describe, it } from 'node:test';
import { NotificationService } from './notification.service.js';

// No-op resolver for unit tests
const noopResolver = () => {
  throw new Error('Resolver not available in unit tests');
};

describe('NotificationService', () => {
  // Mock EmailSender that records sent emails
  const sentEmails: Array<{ to: string; subject: string; body: string }> = [];
  const mockEmailSender = {
    async send(email: { to: string; subject: string; body: string }) {
      sentEmails.push(email);
    },
  };

  const notifications = NotificationService.factory(
    { email: mockEmailSender },
    noopResolver,
  );

  it('should send verification email without throwing', async () => {
    await assert.doesNotReject(
      notifications.sendVerificationEmail('test@example.com', 'abc123'),
    );
  });

  it('should send password reset email without throwing', async () => {
    await assert.doesNotReject(
      notifications.sendPasswordResetEmail('test@example.com', 'resetToken123'),
    );
  });

  it('should send 2FA enabled email without throwing', async () => {
    await assert.doesNotReject(
      notifications.send2FAEnabledEmail('test@example.com'),
    );
  });

  it('should send welcome email without throwing', async () => {
    await assert.doesNotReject(
      notifications.sendWelcomeEmail('test@example.com', 'Test User'),
    );
  });

  it('should send password changed email without throwing', async () => {
    await assert.doesNotReject(
      notifications.sendPasswordChangedEmail('test@example.com'),
    );
  });
});
