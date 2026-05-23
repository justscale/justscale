/**
 * Container lifecycle hooks - a pub-sub that lets packages react when
 * the app has finished booting and the DI container is ready to query.
 *
 * Scope: process-wide. Hooks fire on every kernel `start()` in the same
 * process, each with its own container instance.
 */

import type { Container } from './service.js';

export type ContainerReadyHook = (container: Container) => void | Promise<void>;

const hooks: ContainerReadyHook[] = [];

/**
 * Register a hook to run after boot with the kernel's container.
 * Fires once per `kernel.start()`.
 */
export function onContainerReady(hook: ContainerReadyHook): void {
  hooks.push(hook);
}

/**
 * Invoke all registered hooks in registration order.
 * @internal
 */
export async function runContainerReadyHooks(container: Container): Promise<void> {
  for (const hook of hooks) {
    await hook(container);
  }
}

/** @internal Test helper: clear all registered hooks between kernel runs. */
export function __clearContainerReadyHooks(): void {
  hooks.length = 0;
}
