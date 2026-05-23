/**
 * defineSignals — declarative signal group with DI-wired executor.
 *
 * Replaces the manual pattern of injecting AbstractProcessExecutor and
 * calling executor.createSignal() in every signal service.
 *
 * @example
 * ```typescript
 * export class PaymentSignals extends defineSignals(signal => ({
 *   confirmed: signal('/payment/:order/confirmed').types({ Order }),
 *   failed: signal<{ reason: string }>('/payment/:order/failed').types({ Order }),
 * })) {}
 *
 * // Inject and emit:
 * class OrderService extends defineService({
 *   inject: { payment: PaymentSignals },
 *   factory: ({ payment }) => ({
 *     async markPaid(order: Locked<Order>) {
 *       await payment.confirmed({ order });
 *     },
 *   }),
 * }) {}
 * ```
 */

import { defineService } from '../core/index.js';
import type { ResolveParamType, ExtractParamNames } from '../models/apply-types-config.js';
import { ADAPTER_KEY } from '../models/symbols.js';
import { isReference } from '../models/reference/reference.js';
import type { Locked } from '../models/types.js';
import { AbstractProcessExecutor } from '../runtime/process/executor.js';
import { SIGNAL_BRAND, type ModelClass, type Signal } from './types.js';

// ============================================================================
// Signal builder types
// ============================================================================

/**
 * Per-path-param, build the emit/receive type.
 * If the param matches a model in .types(), it's Locked<T>. Otherwise string.
 */
type SignalPathArgs<
  TPath extends string,
  TTypes extends Record<string, ModelClass>,
> = {
  [P in ExtractParamNames<TPath>]:
  ResolveParamType<P, TTypes> extends never
    ? string
    : Locked<InstanceType<Extract<ResolveParamType<P, TTypes>, ModelClass>>>
};

/**
 * Full signal args: path params (typed or string) + data fields from generic.
 * If there are no path params and no data, the arg is void (just call with ()).
 */
type SignalArgs<
  TPath extends string,
  TTypes extends Record<string, ModelClass>,
  TData,
> = [ExtractParamNames<TPath>] extends [never]
  ? (TData extends void ? void : TData)
  : TData extends void
    ? SignalPathArgs<TPath, TTypes>
    : SignalPathArgs<TPath, TTypes> & TData;

/**
 * A built, callable signal.
 *
 * Structurally compatible with `Signal<[], TArgs, string>`:
 *   - Identity tuple is empty (no positional args)
 *   - TPayload is the full args object (merged path + data fields)
 *   - Callable signature: `(args: TArgs)` — single object
 *
 * This lets the existing `signal()` primitive and race narrowing work
 * unchanged. The compiler reads `.signalName` for routing.
 */
export interface BuiltSignal<
  TPath extends string,
  TTypes extends Record<string, ModelClass>,
  TData,
> extends Signal<[], SignalArgs<TPath, TTypes, TData>, string> {
  /** Path pattern for identity extraction */
  readonly path: TPath;
  /** Types config, if .types() was called */
  readonly typesConfig: TTypes;
}

/**
 * Intermediate builder returned by `signal(path)`.
 * Supports:
 *   - `.data<T>()` to attach an extra data payload type
 *   - `.types(config)` to attach model classes to path params
 */
export interface SignalBuilder<
  TPath extends string,
  TData,
> extends BuiltSignal<TPath, {}, TData> {
  /**
   * Attach model types to path params.
   * Matched params become `Locked<T>` in the emit/receive signature.
   */
  types<TTypes extends Record<string, ModelClass>>(
    config: TTypes,
  ): BuiltSignal<TPath, TTypes, TData>;

  /**
   * Attach an extra data payload type. Fields from the generic are merged
   * into the signal args alongside path params.
   *
   * Use `.data<T>()` instead of `signal<T>('/path')` — the latter doesn't
   * work because TypeScript can't mix explicit + inferred generics.
   */
  data<TNewData>(): SignalBuilder<TPath, TNewData>;
}

/**
 * The `signal` factory passed to `defineSignals`.
 * Single generic `TPath` inferred from the path argument (via `const`).
 *
 * To add a data payload, use `.data<T>()`:
 *   signal('/path').data<{ code: string }>()
 *   signal('/path').data<{ reason: string }>().types({ Order })
 */
export interface SignalFactory {
  <const TPath extends string>(path: TPath): SignalBuilder<TPath, void>;
}

// ============================================================================
// Runtime: build a signal from a path + options
// ============================================================================

/**
 * Derive the signal name (for routing) from a path.
 * `/payment/:order/confirmed` → `payment.order.confirmed`
 * (strips leading `/`, replaces `/` with `.`, strips `:` prefix from params)
 */
function pathToSignalName(path: string): string {
  if (!path) return `anonymous.${Math.random().toString(36).slice(2, 10)}`;
  return path
    .replace(/^\//, '')
    .replace(/\//g, '.')
    .replace(/:/g, '');
}

/**
 * Extract path param names from a path string.
 * `/payment/:order/confirmed` → ['order']
 */
function extractPathParams(path: string): string[] {
  if (!path) return [];
  const params: string[] = [];
  const regex = /:([a-zA-Z_][a-zA-Z0-9_]*)/g;
  let match;
  while ((match = regex.exec(path)) !== null) {
    params.push(match[1]);
  }
  return params;
}

/**
 * Resolve path param name against a types config using the same matching
 * rules as applyTypesConfig: direct key, lowercased key, lowercased + "Ref".
 */
function resolveModelForParam(
  paramName: string,
  typesConfig: Record<string, ModelClass> | undefined,
): ModelClass | undefined {
  if (!typesConfig) return undefined;
  for (const [key, model] of Object.entries(typesConfig)) {
    if (key === paramName) return model;
    if (key.toLowerCase() === paramName) return model;
    if (key.toLowerCase() + 'Ref' === paramName) return model;
  }
  return undefined;
}

/**
 * Extract identifier from a value that could be:
 *   - A string (raw ID)
 *   - A Reference (has .identifier)
 *   - A Persistent or Lock entity (has ADAPTER_KEY)
 *   - A plain object with .id
 *
 * Throws on null/undefined: silent string coercion to "null"/"undefined"
 * produces valid-looking but colliding identities that stomp unrelated
 * runs on the same path.
 */
function extractIdentifier(value: unknown): string {
  if (value === null || value === undefined) {
    throw new Error('extractIdentifier: identifier is null/undefined');
  }
  if (typeof value === 'string') return value;

  // Reference
  if (isReference(value)) {
    return (value as { identifier: string }).identifier;
  }

  // Persistent/Lock entity — check ADAPTER_KEY symbol
  const rec = value as Record<string | symbol, unknown>;
  const adapterKey = rec[ADAPTER_KEY];
  if (adapterKey !== undefined) return String(adapterKey);

  // Fallback: .id property
  if (rec.id !== undefined) return String(rec.id);

  throw new Error(`Cannot extract identifier from value: ${JSON.stringify(value)}`);
}

/**
 * Build a callable signal for a given path + types config.
 * The signal is wired to the executor for emission.
 */
function buildSignal(
  executor: InstanceType<typeof AbstractProcessExecutor>,
  path: string,
  typesConfig: Record<string, ModelClass>,
): unknown {
  const signalName = pathToSignalName(path);
  const pathParams = extractPathParams(path);

  // Duplicate path params collapse into a single identity key on emit
  // (last write wins), which silently conflates two distinct entities.
  // Fail at definition time so '/order/:id/line/:id' can't ship.
  const seenParams = new Set<string>();
  for (const name of pathParams) {
    if (seenParams.has(name)) {
      throw new Error(
        `defineSignals: path '${path}' has duplicate param ':${name}'`,
      );
    }
    seenParams.add(name);
  }

  const signal = async (argsOrVoid?: Record<string, unknown>): Promise<void> => {
    const args = argsOrVoid ?? {};

    // Extract identity: for each path param, pull from args and get its identifier
    const identity: Record<string, string> = {};
    for (const param of pathParams) {
      const value = args[param];
      if (value === undefined) {
        throw new Error(`Signal "${signalName}" missing required path param: ${param}`);
      }
      identity[param] = extractIdentifier(value);
    }

    // Build payload. Path params passed as Locked<T> cannot cross the wire —
    // lock guarantees are local. Replace each typed path param with its
    // Reference equivalent via Model.ref(locked) — receivers get Reference<T>
    // and re-acquire a lock themselves if they need mutating access.
    // Non-path-param fields pass through unchanged; the encoder throws on Locked<T>.
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (pathParams.includes(key)) {
        const model = resolveModelForParam(key, typesConfig);
        if (model && value && typeof value === 'object') {
          payload[key] = (model as unknown as { ref: (v: unknown) => unknown }).ref(value);
          continue;
        }
      }
      payload[key] = value;
    }

    await executor.emit(signalName, identity, payload);
  };

  // Add signal metadata
  Object.defineProperty(signal, SIGNAL_BRAND, {
    value: SIGNAL_BRAND,
    enumerable: false,
  });
  Object.defineProperty(signal, 'signalName', {
    value: signalName,
    enumerable: false,
  });
  Object.defineProperty(signal, '__identityParams', {
    value: pathParams,
    enumerable: false,
  });
  Object.defineProperty(signal, 'path', {
    value: path,
    enumerable: false,
  });
  Object.defineProperty(signal, 'typesConfig', {
    value: typesConfig,
    enumerable: false,
  });

  // Block direct `await signal` outside of process handlers
  Object.defineProperty(signal, 'then', {
    value: () => {
      throw new Error(
        `Cannot await signal "${signalName}" directly. Use signal() inside a process handler.`,
      );
    },
    enumerable: false,
  });

  return signal;
}

// ============================================================================
// Public API: defineSignals
// ============================================================================

/**
 * Factory type — no constraint on TSignals to preserve literal type inference.
 * The factory return is just a record of signal-like values.
 */
type SignalsFactory<TSignals> = (signal: SignalFactory) => TSignals;

/**
 * Define a group of signals. Returns a class that can be injected via DI.
 *
 * The factory receives a `signal` builder that's wired to the executor
 * internally — no need to inject AbstractProcessExecutor manually.
 *
 * @example
 * ```typescript
 * export class PaymentSignals extends defineSignals(signal => ({
 *   confirmed: signal('/payment/:order/confirmed').types({ Order }),
 *   failed: signal<{ reason: string }>('/payment/:order/failed').types({ Order }),
 * })) {}
 * ```
 */
export function defineSignals<TSignals>(factory: SignalsFactory<TSignals>) {
  return defineService({
    inject: { executor: AbstractProcessExecutor },
    factory: ({ executor }): TSignals => {
      const makeBuilder = (resolvedPath: string, typesConfig: Record<string, ModelClass>): unknown => {
        const s = buildSignal(executor, resolvedPath, typesConfig);
        // .types() → new builder with types config (runtime identical)
        Object.defineProperty(s, 'types', {
          value: (config: Record<string, ModelClass>) =>
            makeBuilder(resolvedPath, config),
          enumerable: false,
        });
        // .data<T>() → type-level only; runtime returns the same signal
        Object.defineProperty(s, 'data', {
          value: () => s,
          enumerable: false,
        });
        return s;
      };

      const signalFactory: SignalFactory = ((path: string) =>
        makeBuilder(path, {})) as SignalFactory;

      return factory(signalFactory);
    },
  });
}
