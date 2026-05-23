import { z } from 'zod';

export const UserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string().optional(),
  emailVerifiedAt: z.string().datetime().optional(),
  twoFactorEnabled: z.boolean(),
});

export type UserDto = z.infer<typeof UserSchema>;

export const RegisterBody = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(1024),
  name: z.string().min(1).optional(),
});

export const LoginBody = z.object({
  email: z.string().email(),
  // Capped at the same upper bound as the service-layer guard. Login
  // returns 400 on over-cap rather than wasting scrypt on a request
  // that can never succeed.
  password: z.string().max(1024),
});

export const Login2FABody = z.object({
  code: z.string().length(6).regex(/^\d+$/),
});

export const ChangePasswordBody = z.object({
  currentPassword: z.string().max(1024),
  newPassword: z.string().min(8).max(1024),
});

export const ForgotPasswordBody = z.object({
  email: z.string().email(),
});

export const ResetPasswordBody = z.object({
  email: z.string().email(),
  token: z.string(),
  newPassword: z.string().min(8).max(1024),
});

export const VerifyEmailBody = z.object({
  token: z.string(),
});

export const AuthResponse = z.object({
  user: UserSchema,
  token: z.string(),
});

export const UserResponse = z.object({
  user: UserSchema,
});

export const MessageResponse = z.object({
  message: z.string(),
});

export const ErrorResponse = z.object({
  error: z.string(),
  code: z.string().optional(),
});

export const Login2FARequiredResponse = z.object({
  requires2FA: z.literal(true),
  userId: z.string(),
});

export const TwoFactorSetupResponse = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
  qrCode: z.string().optional(),
});

export const TwoFactorVerifyBody = z.object({
  code: z.string().length(6).regex(/^\d+$/),
});

export const TwoFactorStatusResponse = z.object({
  enabled: z.boolean(),
  hasSecret: z.boolean(),
});

export const SessionSchema = z.object({
  id: z.string(),
  createdAt: z.string().datetime(),
  lastActiveAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  ipAddress: z.string().optional(),
  userAgent: z.string().optional(),
});

export const SessionsResponse = z.object({
  sessions: z.array(SessionSchema),
});

export type RegisterInput = z.infer<typeof RegisterBody>;
export type LoginInput = z.infer<typeof LoginBody>;
export type ChangePasswordInput = z.infer<typeof ChangePasswordBody>;
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordBody>;
export type ResetPasswordInput = z.infer<typeof ResetPasswordBody>;
