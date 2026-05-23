/**
 * Builder Utilities
 *
 * Helper functions for creating bindings in the DI system.
 */

import type { RepositoryBinding, ServiceBinding, InstanceBinding } from './types.js';
import type { RepositoryToken } from '../models/repository.js';
import type { ServiceToken } from '../core/service.js';
import { REPO_BINDING, SERVICE_BINDING, INSTANCE_BINDING } from './types.js';
import { Logger } from '../core/logger.js';
import { Lifecycle } from '../core/lifecycle.js';

/**
 * Built-in tokens that are always available.
 * Logger and Lifecycle are auto-provided by the container/cluster builder.
 */
export type BuiltInTokens = [typeof Logger, typeof Lifecycle];

// ============================================================================
// Token Creation Helpers
// ============================================================================

/**
 * Bind a repository token to an implementation.
 *
 * This creates a binding for the DI system to wire up repositories.
 */
export function bindRepository<T>(
  token: RepositoryToken<T>,
  implementation: unknown
): RepositoryBinding<T> {
  return {
    [REPO_BINDING]: true,
    token,
    implementation,
  } as RepositoryBinding<T>;
}

/**
 * Bind an abstract service token to a concrete implementation.
 *
 * This creates a binding for the DI system to wire up abstract services.
 * Use this when you have an abstract class and want to specify which
 * concrete implementation should be used.
 *
 * @example
 * ```typescript
 * import JustScale, { bindService } from '@justscale/core'
 *
 * JustScale()
 *   .add(MemoryChannelBackend)
 *   .add(bindService(AbstractChannelBackend, MemoryChannelBackend))
 *   .build()
 * ```
 */
export function bindService<TAbstract, TImpl extends TAbstract = TAbstract>(
  abstractToken: ServiceToken<TAbstract>,
  implementation: ServiceToken<TImpl>
): ServiceBinding<TAbstract> {
  return {
    [SERVICE_BINDING]: true,
    token: abstractToken,
    implementation,
  } as ServiceBinding<TAbstract>;
}

/**
 * Bind an abstract service token to a pre-created instance.
 *
 * This creates a binding for the DI system to wire up abstract services
 * to specific instances. Use this when you have an instance you want to
 * share across the app.
 *
 * @example
 * ```typescript
 * import JustScale, { bindInstance } from '@justscale/core'
 *
 * const taskRepo = new InMemoryScheduledTaskRepository()
 *
 * JustScale()
 *   .add(bindInstance(ScheduledTaskRepository, taskRepo))
 *   .add(TaskController)
 *   .build()
 * ```
 */
export function bindInstance<T>(
  abstractToken: ServiceToken<T>,
  instance: T
): InstanceBinding<T> {
  return {
    [INSTANCE_BINDING]: true,
    token: abstractToken,
    instance,
  } as InstanceBinding<T>;
}
