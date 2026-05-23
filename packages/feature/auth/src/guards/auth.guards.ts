import { createGuard } from '@justscale/core';
import { type Persistent } from '@justscale/core/models';
import type { Session } from '../models/session.js';
import { User } from '../models/user.js';

interface AuthContext {
  session: Persistent<Session>
  user: Persistent<User>
}

/**
 * Guard that requires user to be authenticated.
 * Use after the `auth` middleware.
 */
export const requireAuth = createGuard({
  inject: {},
  check: () => (ctx: AuthContext) => {
    return ctx.user !== null && ctx.user !== undefined;
  },
});

/**
 * Guard that requires user's email to be verified.
 * Use after the `auth` middleware.
 */
export const requireVerifiedEmail = createGuard({
  inject: {},
  check: () => (ctx: AuthContext) => {
    return (
      ctx.user.emailVerifiedAt !== null &&
      ctx.user.emailVerifiedAt !== undefined
    );
  },
});

/**
 * Factory to create a guard that checks if user ID matches a param.
 * Useful for "own resource" checks.
 *
 * @example
 * ```typescript
 * Get('/users/:userId/profile')
 *   .use(auth)
 *   .guard(requireSelf('userId'))
 *   .handle(...)
 * ```
 */
export function requireSelf(paramName: string) {
  return createGuard({
    inject: {},
    check: () => (ctx: AuthContext & { params: Record<string, string> }) => {
      return ctx.params[paramName] === User.ref(ctx.user).identifier;
    },
  });
}
