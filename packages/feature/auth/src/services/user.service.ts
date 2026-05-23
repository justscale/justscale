import { defineService } from '@justscale/core';
import { ModelRepository, type Locked, type Ref } from '@justscale/core/models';
import { User } from '../models/user.js';
import { PasswordService } from './password.service.js';

export class UserExistsError extends Error {
  constructor(email: string) {
    super(`User with email ${email} already exists`);
    this.name = 'UserExistsError';
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super('Invalid email or password');
    this.name = 'InvalidCredentialsError';
  }
}

/**
 * Canonical email form: trimmed + lowercased. Applied on both
 * storage (register) and lookup (login, findByEmail) so
 * `Alice@X.com` and `alice@x.com` collide as the same identity.
 */
function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class UserService extends defineService({
  inject: {
    users: ModelRepository.of(User),
    passwords: PasswordService,
  },
  factory: ({ users, passwords }) => ({
    async register(email: string, password: string, name?: string) {
      if (!password || password.length === 0) {
        throw new Error('Password required');
      }
      const normalised = normaliseEmail(email);
      const existing = await users.findOne(
        User.fields.email.eq(normalised),
      );
      if (existing) {
        throw new UserExistsError(normalised);
      }

      const passwordHash = await passwords.hash(password);
      return users.insert({ email: normalised, passwordHash, name });
    },

    async authenticate(email: string, password: string) {
      const user = await users.findOne(
        User.fields.email.eq(normaliseEmail(email)),
      );
      if (!user) {
        return;
      }

      // Disabled users look identical to wrong-credentials at the
      // endpoint layer — no enumeration leak.
      if (user.disabledAt) {
        return;
      }

      const valid = await passwords.verify(password, user.passwordHash);
      if (!valid) {
        return;
      }

      using locked = await users.lock(user);
      if (locked) await users.update(locked, { lastLoginAt: new Date() });
      return user;
    },

    async get(user: Ref<User>) {
      return users.get(user);
    },

    async findByEmail(email: string) {
      return users.findOne(User.fields.email.eq(normaliseEmail(email)));
    },

    async updatePassword(user: Locked<User>, newPassword: string) {
      const passwordHash = await passwords.hash(newPassword);
      return users.update(user, { passwordHash });
    },

    async verifyEmail(user: Locked<User>) {
      return users.update(user, { emailVerifiedAt: new Date() });
    },

    /**
     * Soft-disable a user. Sets `disabledAt` to now. Subsequent
     * authenticate() calls return undefined, and the auth middleware
     * rejects existing sessions with 401 on their next request.
     *
     * Active sessions are not eagerly deleted — the middleware re-checks
     * the user row on every request, so a session is dead the moment
     * disabledAt lands. Callers who want immediate revocation can also
     * call SessionService.revokeAllForUser(user).
     */
    async disable(user: Locked<User>) {
      return users.update(user, { disabledAt: new Date() });
    },

    /**
     * Re-enable a previously disabled user. Clears `disabledAt`.
     */
    async enable(user: Locked<User>) {
      return users.update(user, { disabledAt: undefined });
    },
  }),
}) {}

export type UserServiceInstance = ReturnType<typeof UserService.factory>;
