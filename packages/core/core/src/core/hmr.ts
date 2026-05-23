/**
 * Hot Module Replacement (HMR) Runtime
 *
 * Provides runtime functions for the compiler-generated HMR code.
 * These functions are prefixed with __ to indicate they're compiler-internal.
 *
 * @module @justscale/core/hmr
 */

import type { Container } from './service.js';

// ============================================================================
// Global Container Reference
// ============================================================================

/**
 * Global container reference for HMR runtime.
 * Set by setHmrContainer() during app initialization.
 */
let hmrContainer: Container | null = null;

/**
 * Set the container for HMR runtime.
 * Called by the app builder during initialization in dev mode.
 *
 * @param container - The app's container instance
 */
export function setHmrContainer(container: Container): void {
  hmrContainer = container;
}

/**
 * Get the current HMR container.
 * Throws if not initialized.
 */
function getContainer(): Container {
  if (!hmrContainer) {
    throw new Error(
      '[HMR] Container not initialized. Are you running in dev mode with `just dev`?'
    );
  }
  return hmrContainer;
}

// ============================================================================
// Type Hash Registry
// ============================================================================

/**
 * Stores the current type hash schema for each service.
 * Updated each time __validateHmrState is called during factory execution.
 * Used by __wrapHmrStateForSave to bundle hashes with saved state.
 */
const typeHashRegistry = new Map<string, Record<string, string>>();

/**
 * Wrap user-provided hotReload state with type hashes for later validation.
 * Called by the container when saving HMR state during full reload.
 *
 * @param serviceId - The stable service ID
 * @param state - The raw state from the user's hotReload callback
 * @returns Wrapped state with __values and __typeHashes, or the raw state if no hashes registered
 */
export function __wrapHmrStateForSave(serviceId: string, state: unknown): unknown {
  if (state == null || typeof state !== 'object') {
    return state;
  }

  const schema = typeHashRegistry.get(serviceId);
  if (!schema) {
    return state;
  }

  return {
    __values: state,
    __typeHashes: { ...schema },
  };
}

// ============================================================================
// Compiler-Generated Functions
// ============================================================================

/**
 * Get HMR state for a service during factory execution.
 * Called by compiler-generated factory wrapper:
 *
 * ```typescript
 * factory: ((__hmr) =>
 *   ({ lifecycle }) => {
 *     const cache = __hmr?.cache ?? new Map()
 *     // ...
 *   }
 * )(__getHmrState('src/services/cache.ts#CacheService'))
 * ```
 *
 * @param serviceId - The stable service ID
 * @returns The saved HMR state, or undefined if none
 */
export function __getHmrState(serviceId: string): unknown {
  if (!hmrContainer) {
    // Not in dev mode or container not initialized yet
    return undefined;
  }
  return hmrContainer.getHmrState(serviceId);
}

/**
 * Patch methods on a service instance.
 * Called by compiler-generated HMR update code when only method bodies changed.
 *
 * @param serviceId - The stable service ID
 * @param changedMethods - List of method names that changed
 */
export async function __hmrPatchMethods(
  serviceId: string,
  changedMethods: string[]
): Promise<void> {
  const container = getContainer();
  await container.hotReload(serviceId, 'method-patch', changedMethods);
}

/**
 * Trigger a full reload of a service.
 * Called by compiler-generated HMR update code when structure changed.
 *
 * @param serviceId - The stable service ID
 */
export async function __hmrFullReload(serviceId: string): Promise<void> {
  const container = getContainer();
  await container.hotReload(serviceId, 'full-reload');
}

/**
 * Validate HMR state before injection.
 *
 * Performs per-variable type-aware validation. The state is stored as:
 *   { __values: { cache: ..., counter: ... }, __typeHashes: { cache: 'abc', counter: 'def' } }
 *
 * For each expected variable, compares the stored type hash against the current
 * expected hash. Variables whose types haven't changed are preserved; variables
 * whose types changed are discarded (returning undefined for that key, so the
 * ?? fallback in the factory kicks in).
 *
 * Also supports legacy format (plain object without __values/__typeHashes) for
 * backward compatibility - in that case, all keys are preserved if they match
 * by name (no type validation possible).
 *
 * @param state - The raw state from __getHmrState
 * @param expectedSchema - Map of variable name to type hash (or string[] for legacy)
 * @param serviceId - The service ID (for warning messages)
 * @returns The validated state (partial object with only type-compatible keys), or undefined
 */
export function __validateHmrState(
  state: unknown,
  expectedSchema: Record<string, string> | string[],
  serviceId: string
): unknown {
  // Register current schema for future saves (only for Record format)
  if (!Array.isArray(expectedSchema)) {
    typeHashRegistry.set(serviceId, expectedSchema);
  }

  if (state == null) {
    return undefined;
  }

  if (typeof state !== 'object') {
    console.warn(
      `[HMR] ${serviceId}: discarding state - expected object, got ${typeof state}`
    );
    return undefined;
  }

  if (Array.isArray(expectedSchema)) {
    const stateKeys = Object.keys(state);
    const expectedSet = new Set(expectedSchema);
    const stateSet = new Set(stateKeys);
    const missing = expectedSchema.filter(k => !stateSet.has(k));
    const extra = stateKeys.filter(k => !expectedSet.has(k));
    if (missing.length > 0 || extra.length > 0) {
      const parts: string[] = [];
      if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);
      if (extra.length > 0) parts.push(`extra: ${extra.join(', ')}`);
      console.warn(
        `[HMR] ${serviceId}: discarding state - shape mismatch (${parts.join('; ')})`
      );
      return undefined;
    }
    return state;
  }

  const stateObj = state as Record<string, unknown>;
  const storedValues = stateObj.__values as Record<string, unknown> | undefined;
  const storedHashes = stateObj.__typeHashes as Record<string, string> | undefined;

  if (!storedValues) {
    const stateKeys = Object.keys(state);
    const expectedKeys = Object.keys(expectedSchema);
    const expectedSet = new Set(expectedKeys);
    const stateSet = new Set(stateKeys);
    const missing = expectedKeys.filter(k => !stateSet.has(k));
    const extra = stateKeys.filter(k => !expectedSet.has(k));
    if (missing.length > 0 || extra.length > 0) {
      console.warn(
        `[HMR] ${serviceId}: discarding state - shape mismatch`
      );
      return undefined;
    }
    return state;
  }

  // Per-key type-aware validation
  const result: Record<string, unknown> = {};
  const discarded: string[] = [];

  for (const [key, expectedHash] of Object.entries(expectedSchema)) {
    const storedHash = storedHashes?.[key];
    const hasValue = key in storedValues;

    if (!hasValue) {
      // New variable added - will use ?? fallback
      continue;
    }

    // Empty hash means no type info (no checker was available) - always accept
    if (expectedHash === '' || storedHash === '' || storedHash === undefined) {
      result[key] = storedValues[key];
      continue;
    }

    if (storedHash === expectedHash) {
      result[key] = storedValues[key];
    } else {
      discarded.push(key);
    }
  }

  if (discarded.length > 0) {
    console.warn(
      `[HMR] ${serviceId}: type changed for ${discarded.join(', ')} - using fresh defaults`
    );
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Check if HMR is available (dev mode with container initialized).
 */
export function __hmrAvailable(): boolean {
  return hmrContainer !== null;
}
