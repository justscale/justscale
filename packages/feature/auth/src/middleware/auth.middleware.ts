import { createMiddleware } from '@justscale/core';
import {ModelRepository, Persistent} from '@justscale/core/models';
import { MIDDLEWARE_RESPONSES } from '@justscale/http';
import { Session } from '../models/session.js';
import { SessionService } from '../services/session.service.js';
import { User } from '../models/index.js';

/**
 * Symbol attached to auth-style middlewares that declares an OpenAPI
 * security scheme. Tools like `@justscale/openapi` read this to auto-emit
 * `components.securitySchemes` + per-route `security` requirements.
 *
 * Use `Symbol.for(...)` so third-party packages can add schemes without
 * needing to import from this package.
 */
export const AUTH_SCHEME = Symbol.for('justscale:authScheme');

/** Shape stored under the AUTH_SCHEME symbol - mirrors OpenAPI 3.1 securityScheme. */
export interface AuthSchemeMetadata {
  readonly name: string;                             // name under components.securitySchemes
  readonly type: 'http' | 'apiKey' | 'oauth2' | 'openIdConnect';
  readonly scheme?: string;                          // http only - 'bearer' | 'basic' | ...
  readonly bearerFormat?: string;
  readonly in?: 'header' | 'query' | 'cookie';       // apiKey only
  readonly description?: string;
  /** If true, the route MUST present the scheme; if false, it's optional. */
  readonly required: boolean;
}

/**
 * Middleware that extracts and validates the session from the Authorization header.
 * Adds `session` and `user` to the context.
 *
 * Use with routes that require authentication.
 * For optional auth, use `optionalAuth` instead.
 */
const AUTH_BEARER_SCHEME: AuthSchemeMetadata = {
  name: 'bearerAuth',
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'token',
  description: 'Session token from POST /auth/login',
  required: true,
};

export const auth = createMiddleware({
  inject: {
    sessionService: SessionService,
    sessionRepo: ModelRepository.of(Session),
    userRepo: ModelRepository.of(User),
  },
  handler:
    ({ sessionService, sessionRepo, userRepo }) =>
      async (ctx: { headers: Record<string, string> }): Promise<{ user: Persistent<User>, session: Persistent<Session> }> => {
        const authHeader = ctx.headers.authorization ?? ctx.headers.Authorization;
        if (!authHeader) {
          throw new AuthenticationError('Missing Authorization header');
        }

        // Strict "Bearer <token>" - matches OAuth2 convention; rejects
        // raw tokens that were previously accepted by accident.
        if (!authHeader.startsWith('Bearer ')) {
          throw new AuthenticationError('Expected Bearer token');
        }
        const token = authHeader.slice(7);

        const session = await sessionService.findByToken(token);
        if (!session) {
          throw new AuthenticationError('Invalid or expired session');
        }

        // Re-fetch the user from the repo on every request instead of
        // trusting the snapshot stored on session.user (which is cached
        // from session creation time). Without this, deleting the user
        // row leaves their sessions authenticating - a revoked employee
        // keeps access until TTL.
        const user = await userRepo.get(session.user);
        if (!user) {
          throw new AuthenticationError('User not found');
        }

        // Disabled users get the same 401 as missing/invalid sessions —
        // no signal to the user about why. Existing sessions die on
        // the next request after UserService.disable() lands.
        if (user.disabledAt) {
          throw new AuthenticationError('Invalid or expired session');
        }

        // Touch session to update last active time. The touch+revoke race
        // that previously needed a try/catch is gone: sessionRepo.lock()
        // now serializes against any concurrent logout. If the row was
        // revoked before this lock, lockedSession is null and we skip.
        await using lockedSession = await sessionRepo.lock(session);
        if (lockedSession) await sessionService.touch(lockedSession);

        return { user, session };
      },
});
(auth as unknown as Record<symbol, unknown>)[AUTH_SCHEME] = AUTH_BEARER_SCHEME;
// Auth throws AuthenticationError → 401. Surface that to OpenAPI so route
// authors don't have to repeat .returns(401, ...) on every authed handler.
(auth as unknown as Record<symbol, unknown>)[MIDDLEWARE_RESPONSES] = { 401: null };

/**
 * Middleware that optionally extracts session if present.
 * Adds `session` and `user` to the context (may be null).
 *
 * Use for routes that work with or without authentication.
 */
export const optionalAuth = createMiddleware({
  inject: {
    sessionService: SessionService,
    sessionRepo: ModelRepository.of(Session),
    userRepo: ModelRepository.of(User),
  },
  handler:
    ({ sessionService, sessionRepo, userRepo }) =>
      async (ctx: { headers: Record<string, string> }) => {
        const authHeader = ctx.headers.authorization ?? ctx.headers.Authorization;
        if (!authHeader) {
          return { session: null, user: null };
        }

        // Same strictness as `auth`: no Bearer prefix - no user. The
        // route still succeeds (optional auth) but with null user.
        if (!authHeader.startsWith('Bearer ')) {
          return { session: null, user: null };
        }
        const token = authHeader.slice(7);

        const session = await sessionService.findByToken(token);
        if (!session) {
          return { session: null, user: null };
        }

        // Re-fetch the user each request (not from session.user cache)
        // so a deleted user's session reports no user. Disabled users
        // also surface as null — handler sees an unauthenticated request,
        // not a partially-authenticated one.
        const fetched = await userRepo.get(session.user);
        if (!fetched || fetched.disabledAt) {
          return { session: null, user: null };
        }

        await using lockedSession2 = await sessionRepo.lock(session);
        if (lockedSession2) await sessionService.touch(lockedSession2);

        return { session, user: fetched };
      },
});
(optionalAuth as unknown as Record<symbol, unknown>)[AUTH_SCHEME] = {
  ...AUTH_BEARER_SCHEME,
  required: false,
} satisfies AuthSchemeMetadata;

export class AuthenticationError extends Error {
  readonly statusCode = 401;
  constructor(message: string) {
    super(message);
    this.name = 'AuthenticationError';
  }
}
