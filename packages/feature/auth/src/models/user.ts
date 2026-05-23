import { defineModel, field } from '@justscale/core/models';

export class User extends defineModel({
  name: 'JustScale_User',
  fields: {
    email: field.string().max(255),
    passwordHash: field.string().max(255),
    name: field.string().max(100).optional(),
    emailVerifiedAt: field.timestamp().optional(),
    lastLoginAt: field.timestamp().optional(),
    /** TOTP secret for 2FA (encrypted in production) */
    twoFactorSecret: field.string().max(255).optional(),
    /** Whether 2FA is enabled for this user */
    twoFactorEnabled: field.boolean().default(false),
    /** Count of recent consecutive failed 2FA attempts (windowed). */
    twoFactorFailedAttempts: field.int().default(0),
    /** If set and in the future, verifyTOTP rejects without checking the code. */
    twoFactorLockedUntil: field.timestamp().optional(),
    /**
     * Soft-disable: when set, login fails (looks identical to wrong
     * credentials — no enumeration leak) and existing sessions are
     * rejected by the auth middleware on the next request.
     *
     * Timestamp rather than boolean so an audit trail records WHEN.
     */
    disabledAt: field.timestamp().optional(),
  },
}) {}
