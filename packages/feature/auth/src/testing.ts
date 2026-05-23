/**
 * @justscale/auth/testing - in-memory test composition.
 *
 * Wires all of auth's dependencies with in-memory adapters and includes
 * both `AuthFeature` and `AuthEndpointsFeature`. Factory shape (not a
 * module-level const) so every call returns fresh `InMemoryRepository`
 * instances - state does not leak between tests in the same process.
 *
 * The caller still needs `HttpConfig` in the container, because it's
 * app-level infrastructure and not auth-specific. Most tests get it
 * via `defaultHttpConfig` from `@justscale/http/testing`.
 *
 * @example
 * ```ts
 * import JustScale from '@justscale/core';
 * import { defaultHttpConfig } from '@justscale/http/testing';
 * import { AuthTestBundle } from '@justscale/auth/testing';
 *
 * const app = JustScale()
 *   .add(defaultHttpConfig)
 *   .add(AuthTestBundle())
 *   .build().compile();
 * await app.ready;
 * ```
 */

import { Config, Lifecycle, Logger, bindRepository, bindService, createFeatureBuilder } from '@justscale/core';
import { ModelRepository, getModelFields } from '@justscale/core/models';
import { InMemoryRepository } from '@justscale/core/models/in-memory';
import { InMemoryLockFeature } from '@justscale/core/memory';
import { InMemoryProcessFeature } from '@justscale/core/process';
import { HttpConfig } from '@justscale/http';

import { User } from './models/user.js';
import { Session } from './models/session.js';
import { AbstractEmailSender, ConsoleEmailSender } from './services/email.service.js';
import { AuthFeature, AuthEndpointsFeature } from './feature.js';

/**
 * Override hooks for the bundle. Tests can swap any individual piece
 * without rebuilding the whole composition.
 */
export interface AuthTestBundleOptions {
  /** Override the User repository (default: fresh InMemoryRepository<User>). */
  userRepo?: InMemoryRepository<User>
  /** Override the Session repository (default: fresh InMemoryRepository<Session>). */
  sessionRepo?: InMemoryRepository<Session>
}

export function AuthTestBundle(options: AuthTestBundleOptions = {}) {
  const userRepo =
    options.userRepo ??
    new InMemoryRepository<User>({ fieldDefs: getModelFields(User) });
  const sessionRepo =
    options.sessionRepo ??
    new InMemoryRepository<Session>({ fieldDefs: getModelFields(Session) });

  return createFeatureBuilder()
    .name('auth-test')
    // HttpConfig is app-level; the caller provides it (typically via
    // `defaultHttpConfig` from `@justscale/http/testing`).
    .requires(Config.of(HttpConfig))
    // Built-ins that inner features (InMemoryProcessFeature, AuthFeature's
    // services) transitively consume. `JustScale()` provides these.
    .requires(Logger)
    .requires(Lifecycle)
    .provides((b) =>
      b
        .add(InMemoryLockFeature)
        .add(InMemoryProcessFeature)
        .add(bindRepository(ModelRepository.of(User), userRepo))
        .add(bindRepository(ModelRepository.of(Session), sessionRepo))
        .add(bindService(AbstractEmailSender, ConsoleEmailSender))
        .add(AuthFeature)
        .add(AuthEndpointsFeature),
    );
}
