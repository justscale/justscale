/**
 * E2E Tests for Auth Controllers
 *
 * Tests the complete auth flow using in-memory repositories
 * and JustScale().
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import JustScale from '@justscale/core';
import { ModelRepository } from '@justscale/core/models';
import { httpTransport, createUserSession, defaultHttpConfig } from '@justscale/http/testing';
import { AbstractProcessExecutor, AbstractProcessStorage } from '@justscale/core/process';
import * as t from '@justscale/testing';

import { AuthTestBundle } from '../src/testing.js';
import { User } from '../src/models/user.js';
import {
  UserService,
  SessionService,
  TwoFactorService,
} from '../src/services/index.js';
import { AuthController } from '../src/controllers/auth.controller.js';
import { TwoFactorController } from '../src/controllers/twofa.controller.js';
import { PasswordController } from '../src/controllers/password.controller.js';
import { twoFactorSetup, twoFactorVerify, twoFactorDisable } from '../src/processes/twofa-setup.process.js';
import { AuthSignals } from '../src/services/signals.service.js';

describe('Auth Controllers E2E', async () => {
  const built = JustScale()
    .add(defaultHttpConfig)
    .add(AuthTestBundle())
    .build();

  const app = built.compile();
  await app.ready;

  const client = await t.createTestClient(app, {
    transports: { http: httpTransport },
  });
  const typedApi = client.http.useControllers({
    auth: AuthController,
    twofa: TwoFactorController,
    password: PasswordController,
  });
  const { api } = typedApi;

  const services = await client.services({
    users: UserService,
    sessions: SessionService,
    signals: AuthSignals,
    twofa: TwoFactorService,
  });

  // Get process runtime components for test assertions
  const processStorage = await app.container.resolve(AbstractProcessStorage);
  const processExecutor = await app.container.resolve(AbstractProcessExecutor);

  // Repository for direct state assertions (e.g. locking a user in a test).
  const userRepo = await app.container.resolve(ModelRepository.of(User));

  // Cleanup after all tests
  after(async () => {
    await client.close();
  });

  // ==========================================================================
  // Registration Tests
  // ==========================================================================

  describe('POST /auth/register', () => {
    it('should register a new user successfully', async () => {
      const result = await api.auth.register({
        email: 'newuser@example.com',
        password: 'password123',
        name: 'New User',
      });

      assert.strictEqual(result.status, 201);
      assert.ok(result.data.token);
      assert.strictEqual(result.data.user.email, 'newuser@example.com');
      assert.strictEqual(result.data.user.name, 'New User');
      // twoFactorEnabled may be undefined or false - both indicate 2FA is not enabled
      assert.ok(!result.data.user.twoFactorEnabled);
    });

    it('should return 409 when email already exists', async () => {
      // First registration
      await api.auth.register({
        email: 'duplicate@example.com',
        password: 'password123',
        name: 'First User',
      });

      // Second registration with same email
      const result = await api.auth.register({
        email: 'duplicate@example.com',
        password: 'password456',
        name: 'Second User',
      });

      assert.strictEqual(result.status, 409);
      assert.strictEqual(result.data.code, 'USER_EXISTS');
    });
  });

  // ==========================================================================
  // Login Tests
  // ==========================================================================

  describe('POST /auth/login', () => {
    it('should login with valid credentials', async () => {
      // Register first
      await api.auth.register({
        email: 'logintest@example.com',
        password: 'password123',
        name: 'Login Test',
      });

      // Login
      const result = await api.auth.login({
        email: 'logintest@example.com',
        password: 'password123',
      });

      assert.strictEqual(result.status, 200);
      if (result.status === 200 && 'token' in result.data) {
        assert.ok(result.data.token);
        assert.strictEqual(result.data.user.email, 'logintest@example.com');
      }
    });

    it('should return 401 with invalid credentials', async () => {
      const result = await api.auth.login({
        email: 'nonexistent@example.com',
        password: 'wrongpassword',
      });

      assert.strictEqual(result.status, 401);
      assert.strictEqual(result.data.code, 'INVALID_CREDENTIALS');
    });

    it('should return 401 with wrong password', async () => {
      // Register first
      await api.auth.register({
        email: 'wrongpass@example.com',
        password: 'correctpassword',
        name: 'Wrong Pass Test',
      });

      // Login with wrong password
      const result = await api.auth.login({
        email: 'wrongpass@example.com',
        password: 'incorrectpassword',
      });

      assert.strictEqual(result.status, 401);
      assert.strictEqual(result.data.code, 'INVALID_CREDENTIALS');
    });
  });

  // ==========================================================================
  // Authenticated Endpoint Tests
  // ==========================================================================

  describe('GET /auth/me', () => {
    it('should return current user when authenticated', async () => {
      // Create user session
      const session = createUserSession(typedApi, {
        captureToken: (route, res) => {
          if (route === 'auth.register' || route === 'auth.login') {
            return res.data?.token;
          }
        },
      });

      // Register to get token
      await session.api.auth.register({
        email: 'metest@example.com',
        password: 'password123',
        name: 'Me Test User',
      });

      // Get current user
      const result = await session.api.auth.me({});

      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.data.user.email, 'metest@example.com');
      assert.strictEqual(result.data.user.name, 'Me Test User');
    });

    it('should return 401 without auth token', async () => {
      const result = await api.auth.me({});

      assert.strictEqual(result.status, 401);
    });
  });

  describe('POST /auth/logout', () => {
    it('should logout successfully when authenticated', async () => {
      // Create user session
      const session = createUserSession(typedApi, {
        captureToken: (route, res) => {
          if (route === 'auth.register' || route === 'auth.login') {
            return res.data?.token;
          }
        },
      });

      // Register to get token
      await session.api.auth.register({
        email: 'logouttest@example.com',
        password: 'password123',
        name: 'Logout Test',
      });

      // Logout
      const result = await session.api.auth.logout({});

      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.data.message, 'Logged out successfully');

      // Verify session is invalidated - me should fail
      const meResult = await session.api.auth.me({});
      assert.strictEqual(meResult.status, 401);
    });
  });

  describe('POST /auth/change-password', () => {
    it('should change password successfully', async () => {
      // Create user session
      const session = createUserSession(typedApi, {
        captureToken: (route, res) => {
          if (route === 'auth.register' || route === 'auth.login') {
            return res.data?.token;
          }
        },
      });

      // Register to get token
      await session.api.auth.register({
        email: 'changepass@example.com',
        password: 'oldpassword123',
        name: 'Change Pass Test',
      });

      // Change password
      const result = await session.api.auth.changePassword({
        currentPassword: 'oldpassword123',
        newPassword: 'newpassword456',
      });

      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.data.message, 'Password changed successfully');

      // Verify new password works
      const loginResult = await api.auth.login({
        email: 'changepass@example.com',
        password: 'newpassword456',
      });
      assert.strictEqual(loginResult.status, 200);
    });

    it('should return 401 with incorrect current password', async () => {
      // Create user session
      const session = createUserSession(typedApi, {
        captureToken: (route, res) => {
          if (route === 'auth.register' || route === 'auth.login') {
            return res.data?.token;
          }
        },
      });

      // Register to get token
      await session.api.auth.register({
        email: 'badcurrent@example.com',
        password: 'correctpassword',
        name: 'Bad Current Test',
      });

      // Try to change with wrong current password
      const result = await session.api.auth.changePassword({
        currentPassword: 'wrongpassword',
        newPassword: 'newpassword456',
      });

      assert.strictEqual(result.status, 401);
      assert.strictEqual(result.data.code, 'INVALID_PASSWORD');
    });
  });

  // ==========================================================================
  // Two-Factor Authentication Tests
  // ==========================================================================

  describe('GET /auth/2fa/status', () => {
    it('should return 2FA status when authenticated', async () => {
      const session = createUserSession(typedApi, {
        captureToken: (route, res) => {
          if (route === 'auth.register' || route === 'auth.login') {
            return res.data?.token;
          }
        },
      });

      await session.api.auth.register({
        email: '2fa-status@example.com',
        password: 'password123',
        name: '2FA Status Test',
      });

      const result = await session.api.twofa.status({});

      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.data.enabled, false);
      assert.strictEqual(result.data.hasSecret, false);
    });

    it('should return 401 without auth token', async () => {
      const result = await api.twofa.status({});
      assert.strictEqual(result.status, 401);
    });
  });

  describe('POST /auth/2fa/setup', () => {
    it('should return secret and otpauth URL for 2FA setup', async () => {
      const session = createUserSession(typedApi, {
        captureToken: (route, res) => {
          if (route === 'auth.register' || route === 'auth.login') {
            return res.data?.token;
          }
        },
      });

      await session.api.auth.register({
        email: '2fa-setup@example.com',
        password: 'password123',
        name: '2FA Setup Test',
      });

      const result = await session.api.twofa.setup({});

      assert.strictEqual(result.status, 200);
      if (result.status === 200) {
        assert.ok(result.data.secret);
        assert.ok(result.data.otpauthUrl);
        assert.ok(result.data.otpauthUrl.startsWith('otpauth://totp/'));
        // Email is URL-encoded in otpauth URL
        assert.ok(result.data.otpauthUrl.includes('2fa-setup%40example.com'));
      }
    });

    it('should return 400 when 2FA is already enabled', async () => {
      const session = createUserSession(typedApi, {
        captureToken: (route, res) => {
          if (route === 'auth.register' || route === 'auth.login') {
            return res.data?.token;
          }
        },
      });

      await session.api.auth.register({
        email: '2fa-already@example.com',
        password: 'password123',
        name: '2FA Already Enabled',
      });

      // Setup and verify 2FA
      const setupResult = await session.api.twofa.setup({});
      assert.strictEqual(setupResult.status, 200);
      if (setupResult.status === 200) {
        const validCode = services.twofa.generateCurrentCode(setupResult.data.secret);
        await session.api.twofa.verify({
          code: validCode,
          secret: setupResult.data.secret,
        });
      }

      // Re-login to get fresh session with updated user state
      // (Session stores cached Reference which has stale user data)
      const loginResult = await session.api.auth.login({
        email: '2fa-already@example.com',
        password: 'password123',
      });
      // 2FA is now enabled, so login returns requires2FA with status 202
      assert.strictEqual(loginResult.status, 202);
      if (loginResult.status === 202) {
        // Complete 2FA login
        const login2faCode = services.twofa.generateCurrentCode(setupResult.data.secret);
        const login2faResult = await api.auth.login2FA({
          userId: loginResult.data.userId,
          code: login2faCode,
        });
        assert.strictEqual(login2faResult.status, 200);
        if (login2faResult.status === 200 && 'token' in login2faResult.data) {
          session.setToken(login2faResult.data.token);
        }
      }

      // Try setup again with fresh session - should fail
      const secondSetup = await session.api.twofa.setup({});
      assert.strictEqual(secondSetup.status, 400);
      if (secondSetup.status === 400) {
        assert.strictEqual(secondSetup.data.code, '2FA_ALREADY_ENABLED');
      }
    });
  });

  describe('POST /auth/2fa/verify', () => {
    it('should enable 2FA with valid code', async () => {
      const session = createUserSession(typedApi, {
        captureToken: (route, res) => {
          if (route === 'auth.register' || route === 'auth.login') {
            return res.data?.token;
          }
        },
      });

      await session.api.auth.register({
        email: '2fa-verify@example.com',
        password: 'password123',
        name: '2FA Verify Test',
      });

      // Setup 2FA
      const setupResult = await session.api.twofa.setup({});
      assert.strictEqual(setupResult.status, 200);
      if (setupResult.status !== 200) return;

      // Verify with a valid TOTP code
      const validCode = services.twofa.generateCurrentCode(setupResult.data.secret);
      const verifyResult = await session.api.twofa.verify({
        code: validCode,
        secret: setupResult.data.secret,
      });

      assert.strictEqual(verifyResult.status, 200);
      if (verifyResult.status === 200) {
        assert.strictEqual(verifyResult.data.message, 'Two-factor authentication has been enabled');
      }

      // Verify 2FA is now enabled
      const statusResult = await session.api.twofa.status({});
      assert.strictEqual(statusResult.status, 200);
      assert.strictEqual(statusResult.data.enabled, true);
      assert.strictEqual(statusResult.data.hasSecret, true);
    });

    it('should return 400 with invalid code format', async () => {
      const session = createUserSession(typedApi, {
        captureToken: (route, res) => {
          if (route === 'auth.register' || route === 'auth.login') {
            return res.data?.token;
          }
        },
      });

      await session.api.auth.register({
        email: '2fa-badcode@example.com',
        password: 'password123',
        name: '2FA Bad Code Test',
      });

      const setupResult = await session.api.twofa.setup({});
      assert.strictEqual(setupResult.status, 200);
      if (setupResult.status !== 200) return;

      // Try with invalid code format (not 6 digits)
      // Zod schema validates: code must be exactly 6 digits
      // This fails validation before reaching the handler
      const verifyResult = await session.api.twofa.verify({
        code: '12345', // Only 5 digits - fails Zod validation
        secret: setupResult.data.secret,
      });

      // Zod validation error returns 400 with issues array
      assert.strictEqual(verifyResult.status, 400);
    });
  });

  describe('DELETE /auth/2fa', () => {
    it('should disable 2FA with valid code', async () => {
      const session = createUserSession(typedApi, {
        captureToken: (route, res) => {
          if (route === 'auth.register' || route === 'auth.login') {
            return res.data?.token;
          }
        },
      });

      await session.api.auth.register({
        email: '2fa-disable@example.com',
        password: 'password123',
        name: '2FA Disable Test',
      });

      // Setup and verify 2FA
      const setupResult = await session.api.twofa.setup({});
      assert.strictEqual(setupResult.status, 200);
      if (setupResult.status !== 200) return;

      const setupCode = services.twofa.generateCurrentCode(setupResult.data.secret);
      await session.api.twofa.verify({
        code: setupCode,
        secret: setupResult.data.secret,
      });

      // Re-login to get fresh session with updated user state
      const loginResult = await session.api.auth.login({
        email: '2fa-disable@example.com',
        password: 'password123',
      });
      assert.strictEqual(loginResult.status, 202);
      if (loginResult.status === 202) {
        const loginCode = services.twofa.generateCurrentCode(setupResult.data.secret);
        const login2faResult = await api.auth.login2FA({
          userId: loginResult.data.userId,
          code: loginCode,
        });
        assert.strictEqual(login2faResult.status, 200);
        if (login2faResult.status === 200 && 'token' in login2faResult.data) {
          session.setToken(login2faResult.data.token);
        }
      }

      // Disable 2FA with fresh session
      const disableCode = services.twofa.generateCurrentCode(setupResult.data.secret);
      const disableResult = await session.api.twofa.disable({
        code: disableCode,
      });

      assert.strictEqual(disableResult.status, 200);
      if (disableResult.status === 200) {
        assert.strictEqual(disableResult.data.message, 'Two-factor authentication has been disabled');
      }
    });

    it('should return 400 when 2FA is not enabled', async () => {
      const session = createUserSession(typedApi, {
        captureToken: (route, res) => {
          if (route === 'auth.register' || route === 'auth.login') {
            return res.data?.token;
          }
        },
      });

      await session.api.auth.register({
        email: '2fa-notyet@example.com',
        password: 'password123',
        name: '2FA Not Enabled Test',
      });

      // Try to disable without enabling first
      const result = await session.api.twofa.disable({
        code: '123456',
      });

      // Returns 400 with 2FA_NOT_ENABLED error
      assert.strictEqual(result.status, 400);
      assert.strictEqual(result.data.code, '2FA_NOT_ENABLED');
    });
  });

  // ==========================================================================
  // Password Reset Tests
  // ==========================================================================

  describe('POST /auth/forgot-password', () => {
    it('should return success message for existing user', async () => {
      // Register a user first
      await api.auth.register({
        email: 'forgot-pass@example.com',
        password: 'password123',
        name: 'Forgot Pass Test',
      });

      const result = await api.password.forgotPassword({
        email: 'forgot-pass@example.com',
      });

      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.data.message, 'If an account exists, a reset email has been sent');
    });

    it('should return same success message for non-existent user (prevent enumeration)', async () => {
      const result = await api.password.forgotPassword({
        email: 'nonexistent-user@example.com',
      });

      // Same message to prevent email enumeration
      assert.strictEqual(result.status, 200);
      assert.strictEqual(result.data.message, 'If an account exists, a reset email has been sent');
    });
  });

  describe('POST /auth/reset-password', () => {
    it('should accept reset request (process validates token)', async () => {
      // Note: With process-based flow, the controller accepts the request
      // and the process validates the token. If no process is waiting,
      // the signal is just not matched (fire-and-forget semantics).
      const result = await api.password.resetPassword({
        email: 'test@example.com',
        token: 'invalid-token-that-does-not-exist',
        newPassword: 'newpassword123',
      });

      // The controller now returns success even for unmatched signals
      // (to prevent timing attacks / enumeration)
      assert.strictEqual(result.status, 200);
    });

    it('should complete full password reset flow with signal', async () => {
      // 1. Register a user
      const email = 'reset-flow@example.com';
      const originalPassword = 'originalPass123';
      const newPassword = 'newSecurePass456';

      await api.auth.register({
        email,
        password: originalPassword,
        name: 'Reset Flow Test',
      });

      // 2. Request password reset (starts the process)
      await api.password.forgotPassword({ email });

      // 3. Get the process state to find the reset token
      // In a real scenario, the token would come from the email link
      let resetProcess: { variables: Record<string, unknown> } | null = null;
      for await (const p of processStorage.findByProcessId('auth_forgot-password__email')) {
        if (p.variables.email === email) {
          resetProcess = p;
          break;
        }
      }
      assert.ok(resetProcess, 'Reset process should exist');
      const resetToken = resetProcess!.variables.resetToken as string;
      assert.ok(resetToken, 'Reset token should be stored in process state');

      // 4. Emit the signal with the correct token (simulates user clicking email link)
      // Signal emission now awaits until the process finishes handling
      await services.signals.passwordResetVerified(email, {
        token: resetToken,
        newPassword,
      });

      // 5. Verify we can login with the new password
      const loginResult = await api.auth.login({
        email,
        password: newPassword,
      });
      assert.strictEqual(loginResult.status, 200, 'Should login with new password');

      // 6. Verify we can NOT login with the old password
      const oldLoginResult = await api.auth.login({
        email,
        password: originalPassword,
      });
      assert.strictEqual(oldLoginResult.status, 401, 'Should not login with old password');
    });

    it('wrong reset token does NOT change the password (process invalid_token branch)', async () => {
      // The forgot-password process compares submitted token to its
      // stored reset token via constant-time `tokens.verify`. If a
      // refactor breaks that compare, a wrong token would silently
      // reset the password — pin the negative path so that's not
      // possible without flipping a test red.
      const email = 'reset-wrong@example.com';
      const original = 'originalPass123';
      const stillOriginal = original;

      await api.auth.register({ email, password: original, name: 'Wrong Token' });
      await api.password.forgotPassword({ email });

      // Drive the process with a bogus token.
      await services.signals.passwordResetVerified(email, {
        token: 'definitely-not-the-real-token',
        newPassword: 'attackerPicks999',
      });

      // The original password must still work; the new one must NOT.
      const original_login = await api.auth.login({ email, password: stillOriginal });
      assert.strictEqual(
        original_login.status,
        200,
        'wrong-token reset must NOT have changed the password',
      );
      const attacker_login = await api.auth.login({
        email,
        password: 'attackerPicks999',
      });
      assert.strictEqual(
        attacker_login.status,
        401,
        'attacker-picked password must NOT work',
      );
    });
  });

  // ==========================================================================
  // 2FA Process Tests
  // ==========================================================================

  describe('2FA Setup Process', () => {
    it('should complete 2FA setup with valid code', async () => {
      // 1. Create a user without 2FA
      const email = '2fa-setup-process@example.com';
      const password = 'password123';

      const registerResult = await api.auth.register({ email, password });
      assert.strictEqual(registerResult.status, 201);
      const userId = registerResult.data.user.id;

      // 2. Use the controller API which returns the secret
      const session = createUserSession(typedApi, {
        captureToken: (route, res) => {
          if (route === 'auth.register' || route === 'auth.login') return res.data?.token;
        },
      });
      // Login to get a session token
      const loginResult = await session.api.auth.login({ email, password });
      assert.strictEqual(loginResult.status, 200);

      // 3. Setup 2FA via API (returns the secret)
      const setupResult = await session.api.twofa.setup({});
      assert.strictEqual(setupResult.status, 200);
      if (setupResult.status !== 200) return;

      // 4. Verify with a valid TOTP code
      const validCode = services.twofa.generateCurrentCode(setupResult.data.secret);
      const verifyResult = await session.api.twofa.verify({
        code: validCode,
        secret: setupResult.data.secret,
      });
      assert.strictEqual(verifyResult.status, 200);

      // 5. Verify 2FA is enabled on the user
      const user = await services.users.get(User.ref`${userId}`);
      assert.strictEqual(user?.twoFactorEnabled, true);
      assert.ok(user?.twoFactorSecret);
    });

    it('should fail 2FA setup with invalid code format', async () => {
      // 1. Create a user
      const email = '2fa-setup-invalid@example.com';
      const registerResult = await api.auth.register({ email, password: 'password123' });
      assert.ok('user' in registerResult.data);
      const userId = registerResult.data.user.id;

      // 2. Start 2FA setup
      const handle = await twoFactorSetup([userId]);

      // 3. Submit invalid code (not 6 digits)
      await services.twofa.codeSubmitted(userId, { code: '12345', attempt: 1 });

      // 4. Process should complete with failure
      const result = await handle.wait();
      assert.ok(result);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'invalid_code');
    });

    it('should allow cancellation of 2FA setup', async () => {
      // 1. Create a user
      const email = '2fa-setup-cancel@example.com';
      const registerResult = await api.auth.register({ email, password: 'password123' });
      assert.ok('user' in registerResult.data);
      const userId = registerResult.data.user.id;

      // 2. Start 2FA setup
      const handle = await twoFactorSetup([userId]);

      // 3. Cancel the setup
      await services.twofa.cancelled(userId);

      // 4. Process should complete with cancellation
      const result = await handle.wait();
      assert.ok(result);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'cancelled');
    });
  });

  describe('2FA Verify Process', () => {
    it('should verify 2FA with valid code', async () => {
      // 1. Create a user with 2FA enabled
      const email = '2fa-verify-process@example.com';
      const registerResult = await api.auth.register({ email, password: 'password123' });
      assert.ok('user' in registerResult.data);
      const userId = registerResult.data.user.id;

      // Enable 2FA directly. Block-scoped so the lock releases before
      // twoFactorVerify starts (the verify process re-locks the user).
      {
        using lockedUser = await userRepo.lock(User.ref(userId));
        assert.ok(lockedUser);
        await services.twofa.enable2FA(lockedUser!, 'TESTSECRET123456789012');
      }

      // 2. Start verification process
      const handle = await twoFactorVerify([userId]);

      // 3. Submit valid code generated from the known secret
      const validCode = services.twofa.generateCurrentCode('TESTSECRET123456789012');
      await services.twofa.codeSubmitted(userId, { code: validCode, attempt: 1 });

      // 4. Verify success
      const result = await handle.wait();
      assert.ok(result);
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.attempts, 1);
    });

    it('should fail after max attempts with invalid codes', async () => {
      // 1. Create a user with 2FA enabled
      const email = '2fa-verify-maxattempts@example.com';
      const registerResult = await api.auth.register({ email, password: 'password123' });
      assert.ok('user' in registerResult.data);
      const userId = registerResult.data.user.id;

      // Enable 2FA directly. Block-scoped so the lock releases before
      // twoFactorVerify starts (the verify process re-locks the user).
      {
        using lockedUser = await userRepo.lock(User.ref(userId));
        assert.ok(lockedUser);
        await services.twofa.enable2FA(lockedUser!, 'TESTSECRET123456789012');
      }

      // 2. Start verification process
      const handle = await twoFactorVerify([userId]);

      // 3. Submit 3 invalid codes (wrong format)
      for (let i = 1; i <= 3; i++) {
        await services.twofa.codeSubmitted(userId, { code: '12345', attempt: i }); // Invalid: 5 digits
      }

      // 4. Should fail with max attempts exceeded
      const result = await handle.wait();
      assert.ok(result);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'max_attempts_exceeded');
      assert.strictEqual(result.attempts, 3);
    });
  });

  describe('2FA Disable Process', () => {
    it('should disable 2FA with valid verification code', async () => {
      // 1. Create a user with 2FA enabled
      const email = '2fa-disable-process@example.com';
      const registerResult = await api.auth.register({ email, password: 'password123' });
      assert.ok('user' in registerResult.data);
      const userId = registerResult.data.user.id;

      // Enable 2FA directly. Release the lock before the disable
      // process starts — that process locks the same user internally
      // and would deadlock against a still-held test lock.
      {
        await using lockedUser = await userRepo.lock(User.ref(userId));
        assert.ok(lockedUser);
        await services.twofa.enable2FA(lockedUser!, 'TESTSECRET123456789012');
      }

      // Verify 2FA is enabled
      let user = await services.users.get(User.ref`${userId}`);
      assert.strictEqual(user?.twoFactorEnabled, true);

      // 2. Start disable process
      const handle = await twoFactorDisable([userId]);

      // 3. Submit valid code to confirm disable
      const validCode = services.twofa.generateCurrentCode('TESTSECRET123456789012');
      await services.twofa.codeSubmitted(userId, { code: validCode, attempt: 1 });

      // 4. Verify success
      const result = await handle.wait();
      assert.ok(result);
      assert.strictEqual(result.success, true);
      assert.ok(result.message?.includes('disabled'));

      // 5. Verify 2FA is disabled on the user
      user = await services.users.get(User.ref`${userId}`);
      assert.strictEqual(user?.twoFactorEnabled, false);
    });

    it('should not disable 2FA with invalid code', async () => {
      // 1. Create a user with 2FA enabled
      const email = '2fa-disable-invalid@example.com';
      const registerResult = await api.auth.register({ email, password: 'password123' });
      assert.ok('user' in registerResult.data);
      const userId = registerResult.data.user.id;

      // Release the test lock before the disable process starts (it
      // locks the same user internally — deadlocks otherwise).
      {
        await using lockedUser = await userRepo.lock(User.ref(userId));
        assert.ok(lockedUser);
        await services.twofa.enable2FA(lockedUser!, 'TESTSECRET123456789012');
      }

      // 2. Start disable process
      const handle = await twoFactorDisable([userId]);

      // 3. Submit invalid code
      await services.twofa.codeSubmitted(userId, { code: '12345', attempt: 1 });

      // 4. Should fail
      const result = await handle.wait();
      assert.ok(result);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.error, 'invalid_code');

      // 5. 2FA should still be enabled
      const user = await services.users.get(User.ref`${userId}`);
      assert.strictEqual(user?.twoFactorEnabled, true);
    });
  });
});
