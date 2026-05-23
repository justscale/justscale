// Features
export { AuthFeature, AuthEndpointsFeature } from './feature.js';

// Models
export { User } from './models/user.js';
export { Session } from './models/session.js';

// Services
export {
  PasswordService,
  PasswordTooLongError,
  type PasswordServiceInstance,
} from './services/password.service.js';
export {
  UserService,
  UserExistsError,
  InvalidCredentialsError,
  type UserServiceInstance,
} from './services/user.service.js';
export {
  SessionService,
  type SessionServiceInstance,
  type CreateSessionOptions,
} from './services/session.service.js';
export {
  TwoFactorService,
  type TwoFactorServiceInstance,
} from './services/twofa.service.js';
export {
  NotificationService,
  type NotificationServiceInstance,
} from './services/notification.service.js';
export {
  AbstractEmailSender,
  ConsoleEmailSender,
  type Email,
  type EmailSender,
} from './services/email.service.js';

// Controllers
export {
  AuthController,
  TwoFactorController,
  PasswordController,
} from './controllers/index.js';

// Schemas
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
} from './schemas/index.js';

// Middleware
export {
  auth,
  optionalAuth,
  AuthenticationError,
  AUTH_SCHEME,
  type AuthSchemeMetadata,
} from './middleware/auth.middleware.js';

// Guards
export {
  requireAuth,
  requireVerifiedEmail,
  requireSelf,
} from './guards/auth.guards.js';

// Processes (durable workflows)
export {
  // 2FA processes
  twoFactorSetup,
  twoFactorVerify,
  twoFactorDisable,
  // Email verification processes
  emailVerificationProcess,
  signup,
  TokenService,
  // Password reset
  forgotPassword,
  PasswordResetTokenService,
} from './processes/index.js';

// Signals (DI-friendly signal service)
export { AuthSignals } from './services/signals.service.js';
