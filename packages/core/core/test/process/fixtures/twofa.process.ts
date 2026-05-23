/**
 * Two-Factor Authentication Process
 *
 * Demonstrates:
 * - Signals with payloads (code submission returns the entered code)
 * - Using signal return values in process logic
 * - Race between signal and timeout with type narrowing
 * - Sequential signal waiting (not in race)
 * - New race pattern: switch (r) { case signal(r, ...): }
 */
import { defineService } from '@justscale/core';
import { defineModel, field, ModelRepository } from '@justscale/core/models';
import {
  createProcess,
  AbstractProcessExecutor,
  signal,
  race,
  delay,
} from '@justscale/core/process';

// ============================================================================
// Models
// ============================================================================

class User extends defineModel({
  email: field.string(),
  phone: field.string().optional(),
  twoFactorEnabled: field.boolean().default(false),
}) {}

class TwoFactorAttempt extends defineModel({
  userId: field.string(),
  code: field.string(),
  expiresAt: field.date(),
  verified: field.boolean().default(false),
}) {}

// ============================================================================
// Services
// ============================================================================

export class TwoFactorService extends defineService({
  inject: {
    users: ModelRepository.of(User),
    attempts: ModelRepository.of(TwoFactorAttempt),
    executor: AbstractProcessExecutor,
  },
  factory: ({ users, attempts, executor }) => ({
    findUser: (userId: string) => users.get(User.ref(userId)),

    async generateCode(userId: string): Promise<string> {
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

      await attempts.insert(
        new TwoFactorAttempt({ userId, code, expiresAt })
      );

      return code;
    },

    async verifyCode(userId: string, submittedCode: string): Promise<boolean> {
      // In real implementation, check against stored code
      // For demo, just check it's 6 digits
      return /^\d{6}$/.test(submittedCode);
    },

    // Signal: emitted when user submits 2FA code
    // Returns the submitted code as payload
    codeSubmitted: executor.createSignal<[userId: string], { code: string; attempt: number }>(
      'twofa.code_submitted',
      ['userId']
    ),

    // Signal: emitted when user requests code resend
    resendRequested: executor.createSignal<[userId: string], { reason: string }>(
      'twofa.resend_requested',
      ['userId']
    ),

    // Signal: emitted when user cancels 2FA
    cancelled: executor.createSignal<[userId: string]>(
      'twofa.cancelled',
      ['userId']
    ),
  }),
}) {}

export class NotificationService extends defineService({
  inject: {},
  factory: () => ({
    async sendSMS(phone: string, message: string): Promise<void> {
      console.log(`[SMS to ${phone}]: ${message}`);
    },

    async sendEmail(email: string, subject: string, body: string): Promise<void> {
      console.log(`[Email to ${email}]: ${subject} - ${body}`);
    },
  }),
}) {}

// ============================================================================
// Process: Simple 2FA - Waits for code, uses the payload
// ============================================================================

/**
 * Simple 2FA flow that demonstrates using the signal payload.
 *
 * The signal `codeSubmitted` carries a payload with the code the user entered.
 * We use that payload to verify the code.
 */
export const simpleTwoFactorAuth = createProcess({
  path: '/auth/:userId/2fa-simple',
  inject: {
    twofa: TwoFactorService,
    notifications: NotificationService,
  },

  async handler({ twofa, notifications }, { userId }) {
    // Fetch user - rehydrated on process resume
    using user = await twofa.findUser(userId);
    if (!user) {
      return { success: false, reason: 'user_not_found' };
    }

    if (!user.twoFactorEnabled) {
      return { success: true, twoFactorSkipped: true };
    }

    // Generate and send code
    const expectedCode = await twofa.generateCode(userId);
    await notifications.sendSMS(user.phone ?? '', `Your code: ${expectedCode}`);

    // Wait for the user to submit a code (signal with payload)
    // The process suspends here until codeSubmitted is emitted
    const submission = await signal(twofa.codeSubmitted);

    // Now we have the submitted code from the signal payload
    const isValid = await twofa.verifyCode(userId, submission.code);

    return {
      success: isValid,
      submittedCode: submission.code,
      attempt: submission.attempt,
    };
  },
});

// ============================================================================
// Process: 2FA with timeout - Race between signal and delay
// ============================================================================

/**
 * 2FA with timeout using the new race() pattern with type narrowing.
 *
 * Demonstrates racing between:
 * - User submitting a code (signal with payload)
 * - User cancelling
 * - 5 minute timeout
 *
 * The new pattern uses `switch (r) { case signal(r, ...): }` for
 * type-safe narrowing - payload properties are directly accessible on `r`.
 */
export const twoFactorWithTimeout = createProcess({
  path: '/auth/:userId/2fa-timeout',
  inject: {
    twofa: TwoFactorService,
    notifications: NotificationService,
  },

  async handler({ twofa, notifications }, { userId }) {
    using user = await twofa.findUser(userId);
    if (!user?.twoFactorEnabled) {
      return { success: true, twoFactorSkipped: true };
    }

    // Generate and send code
    const expectedCode = await twofa.generateCode(userId);
    await notifications.sendSMS(user.phone ?? '', `Code: ${expectedCode}`);

    // Race: first one wins, with type narrowing!
    const r = race();

    switch (true) {
      case signal(r, twofa.codeSubmitted):
        // r is narrowed to { code: string; attempt: number }
        return {
          success: true,
          method: 'code_submitted',
          submittedCode: r.code,
          attempt: r.attempt,
        };

      case signal(r, twofa.cancelled):
        // r is narrowed to void (cancelled has no payload)
        return { success: false, reason: 'cancelled' };

      case delay.minutes(r, 5):
        // Timeout
        return { success: false, reason: 'expired' };
    }
  },
});

// ============================================================================
// Process: Full 2FA with resend capability
// ============================================================================

/**
 * Full 2FA flow with resend capability using the new race pattern.
 *
 * Uses a loop to allow the user to request code resends,
 * then waits for the actual code submission.
 *
 * Demonstrates combining the new race narrowing pattern with loops.
 */
export const fullTwoFactorAuth = createProcess({
  path: '/auth/:userId/2fa-full',
  inject: {
    twofa: TwoFactorService,
    notifications: NotificationService,
  },

  async handler({ twofa, notifications }, { userId }) {
    using user = await twofa.findUser(userId);
    if (!user?.twoFactorEnabled) {
      return { success: true, twoFactorSkipped: true };
    }

    let resendCount = 0;
    const maxResends = 3;

    // Initial code send
    let expectedCode = await twofa.generateCode(userId);
    await notifications.sendEmail(user.email, '2FA Code', `Your code: ${expectedCode}`);

    // Loop to handle resend requests
    while (resendCount < maxResends) {
      const r = race();

      switch (true) {
        case signal(r, twofa.codeSubmitted): {
          // User submitted a code - r is narrowed to { code: string; attempt: number }
          const isValid = await twofa.verifyCode(userId, r.code);
          return {
            success: isValid,
            submittedCode: r.code,
            attempt: r.attempt,
            resendCount,
          };
        }

        case signal(r, twofa.resendRequested):
          // r is narrowed to { reason: string }
          resendCount++;
          expectedCode = await twofa.generateCode(userId);
          await notifications.sendEmail(
            user.email,
            '2FA Code (Resent)',
            `Your new code: ${expectedCode}. Resends remaining: ${maxResends - resendCount}. Reason: ${r.reason}`
          );
          continue; // Stay in loop

        case signal(r, twofa.cancelled):
          return { success: false, reason: 'cancelled', resendCount };

        case delay.minutes(r, 10):
          return { success: false, reason: 'expired', resendCount };
      }
    }

    // Max resends reached - wait one more time for code submission
    const finalSubmission = await signal(twofa.codeSubmitted);
    const isValid = await twofa.verifyCode(userId, finalSubmission.code);

    return {
      success: isValid,
      submittedCode: finalSubmission.code,
      attempt: finalSubmission.attempt,
      resendCount,
    };
  },
});
