export {
  // User
  UserSchema,
  type UserDto,
  // Auth requests
  RegisterBody,
  LoginBody,
  Login2FABody,
  ChangePasswordBody,
  ForgotPasswordBody,
  ResetPasswordBody,
  VerifyEmailBody,
  // Auth responses
  AuthResponse,
  UserResponse,
  MessageResponse,
  ErrorResponse,
  Login2FARequiredResponse,
  // 2FA
  TwoFactorSetupResponse,
  TwoFactorVerifyBody,
  TwoFactorStatusResponse,
  // Sessions
  SessionSchema,
  SessionsResponse,
  // Types
  type RegisterInput,
  type LoginInput,
  type ChangePasswordInput,
  type ForgotPasswordInput,
  type ResetPasswordInput,
} from './auth.schemas.js';
