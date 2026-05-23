/**
 * Stream-Process Integration Utilities
 *
 * Shared utilities for stream signal naming conventions used by both
 * the repository (signal emission) and executor (wildcard resolution).
 *
 * The signal name format is: `stream:{ModelName}:{entityId}:{fieldName}`
 * The identity key format is: `{modelNameInCamelCase}Ref`
 */

import { MODEL_NAME } from '../models/define-model.js';

// ============================================================================
// Identity Key Conversion
// ============================================================================

/**
 * Convert a PascalCase model name to its corresponding identity key.
 *
 * The convention is: ModelName → modelNameRef
 * This matches the `types: { Model }` process parameter convention.
 *
 * Handles edge cases:
 * - `Order` → `orderRef`
 * - `OrderItem` → `orderItemRef`
 * - `ABC` → `abcRef` (all-caps acronym)
 * - `ABCOrder` → `abcOrderRef` (acronym prefix)
 * - `OrderABC` → `orderABCRef` (acronym suffix - preserves case)
 * - `HTTPServer` → `httpServerRef`
 * - `V2Order` → `v2OrderRef`
 *
 * @example
 * ```typescript
 * modelNameToIdentityKey('Order')      // 'orderRef'
 * modelNameToIdentityKey('OrderItem')  // 'orderItemRef'
 * modelNameToIdentityKey('ABC')        // 'abcRef'
 * modelNameToIdentityKey('HTTPServer') // 'httpServerRef'
 * ```
 */
export function modelNameToIdentityKey(modelName: string): string {
  if (!modelName || modelName.length === 0) {
    return 'ref';
  }

  const camelCase = pascalToCamelCase(modelName);
  return `${camelCase}Ref`;
}

/**
 * Convert PascalCase to camelCase with proper handling of:
 * - Leading acronyms: `ABC` → `abc`, `ABCOrder` → `abcOrder`
 * - Embedded acronyms: `HTTPServer` → `httpServer`
 * - Numbers: `V2Order` → `v2Order`
 * - Single letters: `A` → `a`
 */
export function pascalToCamelCase(str: string): string {
  if (!str || str.length === 0) {
    return str;
  }

  if (str.length === 1) {
    return str.toLowerCase();
  }

  let uppercaseEndIndex = 0;

  for (let i = 0; i < str.length; i++) {
    if (isUpperCase(str[i])) {
      uppercaseEndIndex = i + 1;
    } else {
      break;
    }
  }

  if (uppercaseEndIndex === 0) {
    return str;
  }

  if (uppercaseEndIndex === str.length) {
    return str.toLowerCase();
  }

  if (uppercaseEndIndex === 1) {
    return str[0].toLowerCase() + str.slice(1);
  }

  // If the char after the uppercase run is lowercase, the last uppercase belongs to the next word.
  // "HTTPServer": uppercaseEndIndex=5 (past 'S'), acronym="http", rest="Server" -> "httpServer"
  if (uppercaseEndIndex < str.length && isLowerCase(str[uppercaseEndIndex])) {
    const acronymPart = str.slice(0, uppercaseEndIndex - 1).toLowerCase();
    const rest = str.slice(uppercaseEndIndex - 1);
    return acronymPart + rest;
  }

  return str.slice(0, uppercaseEndIndex).toLowerCase() + str.slice(uppercaseEndIndex);
}

function isUpperCase(char: string): boolean {
  return char >= 'A' && char <= 'Z';
}

function isLowerCase(char: string): boolean {
  return char >= 'a' && char <= 'z';
}

// ============================================================================
// Signal Name Utilities
// ============================================================================

/**
 * Stream signal name format: `stream:{ModelName}:{entityId}:{fieldName}`
 */
export interface StreamSignalParts {
  prefix: 'stream'
  modelName: string
  entityId: string | '*'
  fieldName: string
}

/**
 * Parse a stream signal name into its components.
 *
 * @returns null if not a valid stream signal format
 */
export function parseStreamSignal(signalName: string): StreamSignalParts | null {
  const parts = signalName.split(':');
  if (parts.length !== 4 || parts[0] !== 'stream') {
    return null;
  }

  return {
    prefix: 'stream',
    modelName: parts[1],
    entityId: parts[2],
    fieldName: parts[3],
  };
}

/**
 * Build a stream signal name from components.
 */
export function buildStreamSignal(
  modelName: string,
  entityId: string | '*',
  fieldName: string
): string {
  return `stream:${modelName}:${entityId}:${fieldName}`;
}

/**
 * Check if a signal name is a stream signal with a wildcard.
 */
export function isWildcardStreamSignal(signalName: string): boolean {
  return signalName.startsWith('stream:') && signalName.includes(':*:');
}

// ============================================================================
// Identity Resolution
// ============================================================================

/**
 * Options for identity resolution.
 */
export interface IdentityResolutionOptions {
  /** Whether to use fallback strategies when primary key not found */
  useFallback?: boolean
  /** Custom identity key to use instead of deriving from model name */
  customIdentityKey?: string
}

/**
 * Result of identity resolution.
 */
export interface IdentityResolutionResult {
  /** Whether resolution was successful */
  success: boolean
  /** The resolved entity ID (undefined if not found) */
  entityId?: string
  /** The identity key that was used */
  usedKey?: string
  /** Whether a fallback strategy was used */
  usedFallback: boolean
  /** Error message if resolution failed */
  error?: string
}

/**
 * Resolve the entity ID from a process identity map for a given model.
 *
 * Resolution strategy:
 * 1. Try the conventional key: `{modelName}Id` (e.g., `orderId` for `Order`)
 * 2. If not found and fallback enabled:
 *    a. Try any key ending in `Id`
 *    b. Try the key `id`
 *
 * @param modelName - The model name (e.g., 'Order')
 * @param identity - The process identity map (e.g., { orderId: '123' })
 * @param options - Resolution options
 */
export function resolveEntityId(
  modelName: string,
  identity: Record<string, string>,
  options: IdentityResolutionOptions = {}
): IdentityResolutionResult {
  const { useFallback = true, customIdentityKey } = options;

  // Use custom key if provided
  if (customIdentityKey) {
    const value = identity[customIdentityKey];
    if (value !== undefined) {
      return {
        success: true,
        entityId: value,
        usedKey: customIdentityKey,
        usedFallback: false,
      };
    }
  }

  // Try conventional key with `Ref` suffix (e.g. `orderRef` for model `Order`)
  const conventionalKey = modelNameToIdentityKey(modelName);
  const conventionalValue = identity[conventionalKey];

  if (conventionalValue !== undefined) {
    return {
      success: true,
      entityId: conventionalValue,
      usedKey: conventionalKey,
      usedFallback: false,
    };
  }

  // Try plain camelCase model name (e.g. `room` for model `Room`)
  const plainKey = pascalToCamelCase(modelName);
  const plainValue = identity[plainKey];

  if (plainValue !== undefined) {
    return {
      success: true,
      entityId: plainValue,
      usedKey: plainKey,
      usedFallback: false,
    };
  }

  // Fallback strategies
  if (useFallback) {
    // Try any key ending in 'Ref' or 'Id'
    for (const [key, value] of Object.entries(identity)) {
      if ((key.endsWith('Ref') || key.endsWith('Id')) && value !== undefined) {
        return {
          success: true,
          entityId: value,
          usedKey: key,
          usedFallback: true,
        };
      }
    }

    // Try 'ref' or 'id' key
    for (const fallbackKey of ['ref', 'id']) {
      if (identity[fallbackKey] !== undefined) {
        return {
          success: true,
          entityId: identity[fallbackKey],
          usedKey: fallbackKey,
          usedFallback: true,
        };
      }
    }
  }

  // Resolution failed
  return {
    success: false,
    usedFallback: useFallback,
    error: `Could not resolve entity ID for model "${modelName}". ` +
      `Expected key "${conventionalKey}", "${plainKey}", or any "*Ref"/"*Id" key in identity: ${JSON.stringify(identity)}`,
  };
}

/**
 * Resolve a wildcard stream signal to a concrete signal name.
 *
 * @param signalName - Signal with wildcard (e.g., 'stream:Order:*:statusUpdates')
 * @param identity - Process identity map
 * @param types - Optional types config from the process definition. When
 *   provided, the identity key is chosen by matching the signal's model
 *   name to an entry in `types` — so `types: { room: ChatRoom }` on a
 *   `stream:ChatRoom:*:broadcast` signal resolves via `identity.room`
 *   even though the key doesn't end in `Ref`/`Id`.
 * @returns Resolved signal name or original if resolution fails
 */
export function resolveStreamWildcard(
  signalName: string,
  identity: Record<string, string>,
  types?: Record<string, { [key: symbol]: string } | { name?: string }>
): { resolved: string; result: IdentityResolutionResult } {
  const parsed = parseStreamSignal(signalName);

  if (!parsed || parsed.entityId !== '*') {
    // Not a wildcard signal, return as-is
    return {
      resolved: signalName,
      result: { success: true, usedFallback: false },
    };
  }

  // Derive customIdentityKey from the types config: find the entry whose
  // model name matches the signal's model name. This lets path params with
  // short names (`:room`) work when they're typed to a specific model class.
  let customIdentityKey: string | undefined;
  if (types) {
    for (const [key, modelClass] of Object.entries(types)) {
      const modelName = (modelClass as { [MODEL_NAME]: string })[MODEL_NAME]
        ?? (modelClass as { name?: string }).name;
      if (modelName === parsed.modelName) {
        customIdentityKey = key;
        break;
      }
    }
  }

  const resolution = resolveEntityId(parsed.modelName, identity, { customIdentityKey });

  if (!resolution.success) {
    return {
      resolved: signalName, // Return unresolved
      result: resolution,
    };
  }

  const resolved = buildStreamSignal(
    parsed.modelName,
    resolution.entityId!,
    parsed.fieldName
  );

  return { resolved, result: resolution };
}
