import { defineAbstract, defineService } from '@justscale/core';

/**
 * Email message to send.
 */
export interface Email {
  to: string
  subject: string
  body: string
  html?: string
}

/**
 * Email sender interface.
 */
export interface EmailSender {
  send(email: Email): Promise<void>
}

/**
 * Abstract email sender for dependency injection.
 * Implementations (Console, SendGrid, SES, etc.) can be bound using bindService.
 *
 * @example Using SendGrid (production)
 * ```typescript
 * import { createClusterBuilder, bindService } from "@justscale/core/cluster"
 * import { AbstractEmailSender } from "@justscale/auth"
 * import { SendGridEmailSender } from "./my-sendgrid-sender"
 *
 * createClusterBuilder()
 *   .add(bindService(AbstractEmailSender, SendGridEmailSender))
 *   .add(AuthFeature)
 *   .build()
 * ```
 *
 * @example Using Console sender (development)
 * ```typescript
 * import { createClusterBuilder, bindService } from "@justscale/core/cluster"
 * import { AbstractEmailSender, ConsoleEmailSender } from "@justscale/auth"
 *
 * createClusterBuilder()
 *   .add(bindService(AbstractEmailSender, ConsoleEmailSender))
 *   .add(AuthFeature)
 *   .build()
 * ```
 */
export abstract class AbstractEmailSender extends defineAbstract<EmailSender>(
  'AbstractEmailSender',
) {}

/**
 * Console email sender for development/testing.
 * Logs emails to console instead of sending them.
 *
 * @example
 * ```typescript
 * import { createClusterBuilder, bindService } from "@justscale/core/cluster"
 * import { AbstractEmailSender, ConsoleEmailSender } from "@justscale/auth"
 *
 * createClusterBuilder()
 *   .add(bindService(AbstractEmailSender, ConsoleEmailSender))
 *   .build()
 * ```
 */
export class ConsoleEmailSender extends defineService({
  inject: {},
  provides: [AbstractEmailSender],
  factory: () => ({
    emails: [] as Email[],

    async send(email: Email): Promise<void> {
      this.emails.push(email);
      console.log(`[Email to ${email.to}]: ${email.subject}\n${email.body}`);
    },
  }),
}) {}

export type { EmailSender as EmailSenderType };
