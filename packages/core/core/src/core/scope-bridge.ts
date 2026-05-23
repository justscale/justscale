/**
 * Scope-switching bridge - wraps a service resolved in a parent scope so
 * every method call re-enters that parent scope via `runWithContainer`.
 * Used by sub-app composition to share services across container boundaries
 * without leaking async context.
 */

import { Container, type ServiceToken } from './service.js';
import { runWithContainer } from './context.js';

/**
 * Resolve `token` from `parentContainer` and wrap it so every method call
 * runs inside the parent's async scope. The returned proxy shares state
 * with the original instance.
 */
export async function createScopedBridge<T extends object>(
  parentContainer: Container,
  token: ServiceToken<T>,
): Promise<T> {
  const target = (await parentContainer.resolve(token)) as T;
  return wrapWithScope(target, parentContainer);
}

/**
 * Synchronous variant for cases where you've already resolved the
 * instance and just need scope switching on top.
 */
export function wrapWithScope<T extends object>(
  target: T,
  parentContainer: Container,
): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== 'function') return value;
      // Preserve the original function reference identity; only the call is wrapped.
      return function (this: unknown, ...args: unknown[]): unknown {
        return runWithContainer(parentContainer, () =>
          (value as (...a: unknown[]) => unknown).apply(obj, args),
        );
      };
    },
  });
}
