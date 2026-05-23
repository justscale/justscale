import { Config, createFeatureBuilder } from '@justscale/core';
import { ModelRepository } from '@justscale/core/models';
import { AbstractProcessExecutor } from '@justscale/core/process';
import { HttpConfig } from '@justscale/http';

import { AuthController } from './controllers/auth.controller.js';
import { PasswordController } from './controllers/password.controller.js';
import { TwoFactorController } from './controllers/twofa.controller.js';
import { Session } from './models/session.js';
import { User } from './models/user.js';
import { PasswordResetTokenService } from './processes/forgot-password.process.js';
import { TokenService } from './processes/signup.process.js';
import { AbstractEmailSender } from './services/email.service.js';
import { NotificationService } from './services/notification.service.js';
import { PasswordService } from './services/password.service.js';
import { SessionService } from './services/session.service.js';
import { AuthSignals } from './services/signals.service.js';
import { TwoFactorService } from './services/twofa.service.js';
import { UserService } from './services/user.service.js';

/**
 * Auth Feature
 *
 * Provides core authentication services:
 * - User registration/authentication
 * - Session management
 * - Two-factor authentication (TOTP)
 * - Email notifications
 *
 * Requires:
 * - ModelRepository.of(User) - User storage
 * - ModelRepository.of(Session) - Session storage
 * - AbstractEmailSender - Email sending implementation
 *
 * Provides:
 * - PasswordService - Password hashing/verification
 * - UserService - User registration/authentication
 * - SessionService - Session management
 * - TwoFactorService - TOTP-based 2FA
 * - NotificationService - Auth email notifications
 *
 * @example
 * ```typescript
 * import { createClusterBuilder, bindService } from '@justscale/core/cluster'
 * import { AuthFeature, User, Session, AbstractEmailSender, ConsoleEmailSender } from '@justscale/auth'
 * import { createPgModel, createPgRepository } from '@justscale/postgres'
 *
 * const PgUser = createPgModel(User, { table: 'users' })
 * const PgSession = createPgModel(Session, { table: 'sessions' })
 *
 * createClusterBuilder()
 *   .add(PostgresClient)
 *   .add(createPgRepository(PgUser))
 *   .add(createPgRepository(PgSession))
 *   .add(bindService(AbstractEmailSender, ConsoleEmailSender))
 *   .add(AuthFeature)
 *   .build()
 * ```
 */
export const AuthFeature = createFeatureBuilder()
  .name('auth')
  .requires(ModelRepository.of(User))
  .requires(ModelRepository.of(Session))
  .requires(AbstractEmailSender)
  .requires(AbstractProcessExecutor)
  .provides((b) =>
    b
      .add(PasswordService)
      .add(UserService)
      .add(SessionService)
      .add(TwoFactorService)
      .add(NotificationService)
      .add(AuthSignals)
      .add(TokenService)
      .add(PasswordResetTokenService),
  );

/**
 * Auth Endpoints Feature
 *
 * Provides HTTP endpoints for authentication.
 * Add this feature after AuthFeature if you want the standard REST API endpoints.
 *
 * Requires (all provided by AuthFeature):
 * - ModelRepository.of(User), ModelRepository.of(Session)
 * - AbstractEmailSender
 * - PasswordService, UserService, SessionService, TwoFactorService, NotificationService
 *
 * Provides:
 * - AuthController - /auth/register, /auth/login, /auth/logout, /auth/me, /auth/change-password
 * - TwoFactorController - /auth/2fa/status, /auth/2fa/setup, /auth/2fa/verify, /auth/2fa (DELETE)
 * - PasswordController - /auth/forgot-password, /auth/reset-password
 *
 * @example With endpoints
 * ```typescript
 * createClusterBuilder()
 *   .add(PostgresClient)
 *   .add(createPgRepository(PgUser))
 *   .add(createPgRepository(PgSession))
 *   .add(bindService(AbstractEmailSender, ConsoleEmailSender))
 *   .add(AuthFeature)
 *   .add(AuthEndpointsFeature)
 *   .build()
 * ```
 *
 * @example Without endpoints (use services directly)
 * ```typescript
 * createClusterBuilder()
 *   .add(PostgresClient)
 *   .add(createPgRepository(PgUser))
 *   .add(createPgRepository(PgSession))
 *   .add(bindService(AbstractEmailSender, ConsoleEmailSender))
 *   .add(AuthFeature)
 *   // No AuthEndpointsFeature - build your own controllers
 *   .add(MyCustomAuthController)
 *   .build()
 * ```
 */
export const AuthEndpointsFeature = createFeatureBuilder()
  .name('auth-endpoints')
  .requires(ModelRepository.of(User))
  .requires(ModelRepository.of(Session))
  .requires(AbstractEmailSender)
  .requires(AbstractProcessExecutor)
  .requires(PasswordService)
  .requires(UserService)
  .requires(SessionService)
  .requires(TwoFactorService)
  .requires(NotificationService)
  .requires(AuthSignals)
  .requires(TokenService)
  .requires(PasswordResetTokenService)
  // AuthController/TwoFactorController/PasswordController use Get/Post routes,
  // which transitively require Config.of(HttpConfig). Declare it here so any
  // app using AuthEndpointsFeature must provide HttpConfig in env.
  .requires(Config.of(HttpConfig))
  .provides((b) =>
    b.add(AuthController).add(TwoFactorController).add(PasswordController),
  );
