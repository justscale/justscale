import { defineService } from '@justscale/core';
import { AbstractProcessExecutor } from '@justscale/core/process';

/**
 * Auth Signals Service
 *
 * Contains all signals for the auth feature. Signals can be:
 * - Emitted by controllers to trigger process state changes
 * - Listened to by processes via `signal(r, signals.xxx)`
 */
export class AuthSignals extends defineService({
  inject: { executor: AbstractProcessExecutor },
  factory: ({ executor }) => ({
    /**
     * Signal: User clicked email verification link.
     */
    emailVerified: executor.createSignal<[userRef: string], { token: string }>(
      'auth.email.verified',
      ['userRef'],
    ),

    /**
     * Signal: User requested to resend verification email.
     */
    resendVerification: executor.createSignal<[userRef: string]>(
      'auth.email.resend_requested',
      ['userRef'],
    ),

    /**
     * Signal: User clicked reset link and submitted new password.
     */
    passwordResetVerified: executor.createSignal<
      [email: string],
      { token: string; newPassword: string }
    >('auth.password.reset_verified', ['email']),
  }),
}) {}
