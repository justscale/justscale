/**
 * Mocking utilities for JustScale testing
 *
 * Integrates with Node.js test runner's mock API while providing
 * type-safe helpers for mocking services and controllers.
 *
 * Supports `using` keyword for automatic cleanup:
 * ```typescript
 * using spied = spyOn(service);
 * // ... test code ...
 * // automatically restored when block exits
 * ```
 */

import { mock, type Mock as NodeMock } from 'node:test';
import { inspect } from 'node:util';
import * as inspector from 'node:inspector';
import type { ServiceDef, ServiceToken } from '@justscale/core';

// Re-export node:test mock for convenience
export { mock };

// ============================================================================
// CDP Custom Formatters (for V8-based debuggers)
// ============================================================================

/** Symbol to mark JustScale mock functions */
const MOCK_MARKER = Symbol('justscale.mock');

/** Read the mock marker metadata from an object. */
function getMockMarker(obj: unknown): { name?: string } | undefined {
  return (obj as Record<symbol, unknown>)?.[MOCK_MARKER] as { name?: string } | undefined;
}

/** Set the mock marker metadata on an object. */
function setMockMarker(obj: unknown, meta: { name?: string }): void {
  (obj as Record<symbol, unknown>)[MOCK_MARKER] = meta;
}

/** Debug logging for formatter development */
const FORMATTER_DEBUG = process.env.JUSTSCALE_FORMATTER_DEBUG === '1';

function formatterLog(...args: unknown[]) {
  if (FORMATTER_DEBUG) {
    console.log('[JustScale Mock Formatter]', ...args);
  }
}

/**
 * Enable custom object formatters via CDP and register our formatter.
 * This works when a debugger is attached that uses Chrome DevTools Protocol.
 */
function enableCustomFormatters(): void {
  // Only run once
  if ((globalThis as any).__justscaleMockFormattersEnabled) return;
  (globalThis as any).__justscaleMockFormattersEnabled = true;

  formatterLog('Initializing custom formatters...');

  try {
    // Try to enable via CDP when inspector is active
    const url = inspector.url();
    formatterLog('Inspector URL:', url);

    if (url) {
      const session = new inspector.Session();
      session.connect();
      formatterLog('CDP session connected');

      // Must enable Runtime first before setting custom formatters
      session.post('Runtime.enable', {}, (enableErr) => {
        if (enableErr) {
          formatterLog('Runtime.enable ERROR:', enableErr);
          return;
        }
        formatterLog('Runtime.enable SUCCESS');

        session.post('Runtime.setCustomObjectFormatterEnabled' as any, { enabled: true }, (err) => {
          if (err) {
            formatterLog('setCustomObjectFormatterEnabled ERROR:', err);
          } else {
            formatterLog('setCustomObjectFormatterEnabled SUCCESS');
          }
        });
      });
      // Don't disconnect - keep formatter enabled
    } else {
      formatterLog('No inspector URL - debugger not attached yet');
    }
  } catch (e) {
    formatterLog('Inspector setup failed:', e);
  }

  // Register devtoolsFormatters
  if (typeof globalThis !== 'undefined') {
    const formatters = ((globalThis as any).devtoolsFormatters ??= []);

    // Check if already registered
    if (formatters.some((f: any) => f.__justscaleMock)) {
      formatterLog('Formatter already registered');
      return;
    }

    formatterLog('Registering devtoolsFormatters...');

    formatters.push({
      __justscaleMock: true,

      header(obj: unknown) {
        formatterLog('header() called with:', typeof obj, obj?.constructor?.name);

        const meta = getMockMarker(obj);
        if (!meta) {
          formatterLog('header() - no MOCK_MARKER, returning null');
          return null;
        }

        const fn = obj as NodeMock<any>;
        const calls = fn.mock?.callCount?.() ?? 0;
        const name = meta.name || 'MockFn';

        formatterLog('header() - returning formatted header for:', name, 'calls:', calls);

        return [
          'span',
          { style: 'color: #9c27b0; font-weight: bold;' },
          `[MockFn] ${name} calls=${calls}`,
        ];
      },

      hasBody(obj: unknown) {
        const has = !!getMockMarker(obj);
        formatterLog('hasBody() called, result:', has);
        return has;
      },

      body(obj: unknown) {
        formatterLog('body() called');

        const meta = getMockMarker(obj);
        const fn = obj as NodeMock<any>;
        const calls = fn.mock?.calls ?? [];

        const children: any[] = [
          ['div', {}, `Name: ${meta?.name || '(anonymous)'}`],
          ['div', {}, `Call count: ${fn.mock?.callCount?.() ?? 0}`],
        ];

        if (calls.length > 0) {
          children.push(['div', { style: 'margin-top: 4px;' }, 'Recent calls:']);
          for (let i = Math.max(0, calls.length - 5); i < calls.length; i++) {
            const call = calls[i];
            children.push([
              'div',
              { style: 'margin-left: 8px; font-family: monospace;' },
              `[${i}] `,
              ['object', { object: call.arguments }],
            ]);
          }
        }

        return ['div', { style: 'padding: 4px;' }, ...children];
      },
    });

    formatterLog('devtoolsFormatters registered, total formatters:', formatters.length);
  }
}

/**
 * Manually enable custom formatters after debugger connects.
 * This is opt-in — it is not called automatically on import.
 * Call it early in your test setup if you want CDP-based formatting in the debugger.
 *
 * @example
 * ```typescript
 * import { enableDebuggerFormatters } from '@justscale/testing';
 * enableDebuggerFormatters(); // Call early in your test
 * ```
 */
export function enableDebuggerFormatters(): void {
  enableCustomFormatters();
}


// ============================================================================
// Node.js util.inspect.custom Support (for console.log)
// ============================================================================

/**
 * Add custom inspect symbols to a mock function for better debugging.
 * When logged or inspected, shows: [MockFn name? calls=N lastArgs=... returned=...]
 */
function addMockInspect<T extends NodeMock<any>>(
  fn: T,
  name?: string
): T {
  // Mark as a JustScale mock for CDP formatters
  setMockMarker(fn, { name });

  // Store the name for later access (used by Symbol.toStringTag getter)
  (fn as any).__mockName = name;

  // Add a $mock property with a getter that shows current state in debugger
  // This appears when you expand the mock in JetBrains Variables panel
  Object.defineProperty(fn, '$mock', {
    get() {
      const calls = (this as NodeMock<any>).mock.callCount();
      const lastCall = (this as NodeMock<any>).mock.calls.at(-1);
      return {
        name: name || '(anonymous)',
        calls,
        lastArgs: lastCall?.arguments,
        lastResult: lastCall?.result,
        lastError: lastCall?.error?.message,
      };
    },
    enumerable: true, // Make it visible in debugger
  });

  // Node.js util.inspect.custom for console.log
  (fn as any)[inspect.custom] = function (
    depth: number,
    options: { stylize: (s: string, style: string) => string } & Record<string, unknown>,
    inspectFn: typeof inspect
  ) {
    const calls = this.mock.callCount();
    const lastCall = this.mock.calls.at(-1);
    const parts: string[] = [options.stylize('MockFn', 'special')];

    if (name) {
      parts.push(options.stylize(name, 'string'));
    }
    parts.push('calls=' + options.stylize(String(calls), 'number'));

    if (lastCall) {
      const argStr = inspectFn(lastCall.arguments, { ...options, depth: 1, colors: false });
      parts.push('lastArgs=' + argStr);
      if (lastCall.result !== undefined) {
        const resultStr = inspectFn(lastCall.result, { ...options, depth: 1, colors: false });
        parts.push('returned=' + resultStr);
      }
      if (lastCall.error) {
        parts.push(options.stylize('threw=' + lastCall.error.message, 'undefined'));
      }
    }

    return '[' + parts.join(' ') + ']';
  };

  // Dynamic Symbol.toStringTag for JetBrains debugger display
  // Shows: MockFn(name) calls=N
  Object.defineProperty(fn, Symbol.toStringTag, {
    get() {
      const mockName = (this as any).__mockName;
      const calls = (this as any).mock?.callCount?.() ?? 0;
      return mockName ? `MockFn(${mockName}) calls=${calls}` : `MockFn calls=${calls}`;
    },
  });

  return fn;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Extract the instance type from a ServiceDef or ServiceToken
 */
type ServiceInstance<T> = T extends ServiceDef<infer S, any>
  ? S
  : T extends ServiceToken<infer S>
    ? S
    : never;

/**
 * A mocked version of a service where all methods are mock functions
 */
export type MockedService<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? NodeMock<(...args: A) => R>
    : T[K];
};

/**
 * A spy wrapper that can be disposed to restore original methods
 */
export interface SpyWrapper<T> extends Disposable {
  /** The spied object with mock functions */
  readonly spied: MockedService<T>;
  /** The original object */
  readonly original: T;
  /** Reset all mock call tracking */
  reset(): void;
  /** Restore original methods (also called on dispose) */
  restore(): void;
}

// ============================================================================
// Service Mocking
// ============================================================================

/**
 * Create a mock implementation of a service.
 * Uses node:test mock functions for tracking calls and assertions.
 *
 * @example
 * ```typescript
 * const mockRepo = mockService<typeof PlayerRepository>({
 *   get: mock.fn(() => Promise.resolve({ id: '1', name: 'Mock' })),
 *   find: mock.fn(() => Promise.resolve([])),
 * });
 * ```
 */
export function mockService<T extends ServiceToken>(
  impl: Partial<MockedService<ServiceInstance<T>>>,
  name?: string
): MockedService<ServiceInstance<T>> {
  const serviceName = name || 'MockedService';

  const proxy = new Proxy(impl as MockedService<ServiceInstance<T>>, {
    get(target, prop) {
      // Handle inspect symbols
      if (prop === inspect.custom) {
        return function (depth: number, options: any) {
          const methods = Object.entries(target)
            .filter(([, v]) => typeof v === 'function' && (v as any).mock)
            .map(([k, v]) => `${k}(${(v as NodeMock<any>).mock.callCount()})`)
            .join(', ');
          return options.stylize('[MockedService', 'special') +
            ` ${options.stylize(serviceName, 'string')}` +
            ` { ${methods} }` +
            options.stylize(']', 'special');
        };
      }
      if (prop === Symbol.toStringTag) {
        return 'MockedService';
      }
      if (prop in target) {
        return (target as any)[prop];
      }
      throw new Error(`Method "${String(prop)}" was not mocked`);
    },
  });

  return proxy;
}

/**
 * Create a spy wrapper around an existing service instance.
 * All method calls are tracked while still calling the real implementation.
 *
 * Supports `using` for automatic cleanup:
 * ```typescript
 * using spy = spyOn(playerRepo);
 * await spy.spied.get(Player.ref('123'));
 * assertCallCount(spy.spied.get, 1);
 * // Original methods restored when block exits
 * ```
 *
 * @example Manual cleanup
 * ```typescript
 * const spy = spyOn(playerRepo);
 * try {
 *   await spy.spied.get(Player.ref('123'));
 *   assertCallCount(spy.spied.get, 1);
 * } finally {
 *   spy.restore();
 * }
 * ```
 */
export function spyOn<T extends object>(instance: T): SpyWrapper<T> {
  const originalMethods = new Map<string | symbol, Function>();
  const spied: Record<string, unknown> = {};
  const instanceName = instance.constructor?.name || 'Object';

  // Spy on own properties
  for (const key of Object.keys(instance) as (keyof T)[]) {
    const value = instance[key];
    if (typeof value === 'function') {
      originalMethods.set(key as string, value);
      const fn = addMockInspect(mock.fn(value.bind(instance)), `${instanceName}.${String(key)}`);
      spied[key as string] = fn;
      // Also replace on original for in-place spying
      (instance as any)[key] = fn;
    } else {
      spied[key as string] = value;
    }
  }

  // Spy on prototype methods
  const proto = Object.getPrototypeOf(instance);
  if (proto && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, key);
      if (descriptor && typeof descriptor.value === 'function' && !(key in spied)) {
        originalMethods.set(key, descriptor.value);
        const fn = addMockInspect(mock.fn(descriptor.value.bind(instance)), `${instanceName}.${key}`);
        spied[key] = fn;
        (instance as any)[key] = fn;
      }
    }
  }

  const restore = () => {
    for (const [key, original] of originalMethods) {
      (instance as any)[key] = original;
    }
  };

  const reset = () => {
    for (const value of Object.values(spied)) {
      if (typeof value === 'function' && (value as any).mock) {
        (value as NodeMock<any>).mock.resetCalls();
      }
    }
  };

  const wrapper: SpyWrapper<T> = {
    spied: spied as MockedService<T>,
    original: instance,
    reset,
    restore,
    [Symbol.dispose]: restore,
  };

  // Add custom inspect for the wrapper itself
  (wrapper as any)[inspect.custom] = function (
    depth: number,
    options: any,
    _inspectFn: typeof inspect
  ) {
    const methods = Object.entries(spied)
      .filter(([, v]) => typeof v === 'function' && (v as any).mock)
      .map(([k, v]) => `${k}(${(v as NodeMock<any>).mock.callCount()})`)
      .join(', ');
    return options.stylize('[SpyWrapper', 'special') +
      ` ${options.stylize(instanceName, 'string')}` +
      ` { ${methods} }` +
      options.stylize(']', 'special');
  };

  Object.defineProperty(wrapper, Symbol.toStringTag, { value: 'SpyWrapper' });

  return wrapper;
}

/**
 * Create a spy that wraps an existing service instance.
 * Returns just the spied object (simpler API, no auto-cleanup).
 *
 * @example
 * ```typescript
 * const spiedRepo = spyService(playerRepo);
 * await spiedRepo.get(Player.ref('123'));
 * assertCallCount(spiedRepo.get, 1);
 * ```
 */
export function spyService<T extends object>(instance: T): MockedService<T> {
  const spied: Record<string, unknown> = {};
  const instanceName = instance.constructor?.name || 'Object';

  for (const key of Object.keys(instance) as (keyof T)[]) {
    const value = instance[key];
    if (typeof value === 'function') {
      spied[key as string] = addMockInspect(mock.fn(value.bind(instance)), `${instanceName}.${String(key)}`);
    } else {
      spied[key as string] = value;
    }
  }

  const proto = Object.getPrototypeOf(instance);
  if (proto && proto !== Object.prototype) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, key);
      if (descriptor && typeof descriptor.value === 'function' && !(key in spied)) {
        spied[key] = addMockInspect(mock.fn(descriptor.value.bind(instance)), `${instanceName}.${key}`);
      }
    }
  }

  // Add custom inspect for the spied service object
  (spied as any)[inspect.custom] = function (
    depth: number,
    options: any
  ) {
    const methods = Object.entries(this)
      .filter(([, v]) => typeof v === 'function' && (v as any).mock)
      .map(([k, v]) => `${k}(${(v as NodeMock<any>).mock.callCount()})`)
      .join(', ');
    return options.stylize('[SpiedService', 'special') +
      ` ${options.stylize(instanceName, 'string')}` +
      ` { ${methods} }` +
      options.stylize(']', 'special');
  };

  Object.defineProperty(spied, Symbol.toStringTag, { value: 'SpiedService' });

  return spied as MockedService<T>;
}

// ============================================================================
// Mock Function Helpers
// ============================================================================

/**
 * Create a mock function with a specific implementation.
 * @param implementation Optional function to call when the mock is invoked
 * @param name Optional name for debugging (shown in console.log)
 */
export function mockFn<TArgs extends unknown[], TReturn>(
  implementation?: (...args: TArgs) => TReturn,
  name?: string
): NodeMock<(...args: TArgs) => TReturn> {
  return addMockInspect(mock.fn(implementation), name);
}

/**
 * Create a mock function that returns a resolved promise.
 * @param value The value to resolve with
 * @param name Optional name for debugging (shown in console.log)
 */
export function mockResolves<T>(value: T, name?: string): NodeMock<(...args: unknown[]) => Promise<T>> {
  return addMockInspect(mock.fn(() => Promise.resolve(value)), name ?? 'resolves');
}

/**
 * Create a mock function that returns a rejected promise.
 * @param error The error to reject with
 * @param name Optional name for debugging (shown in console.log)
 */
export function mockRejects(error: Error, name?: string): NodeMock<(...args: unknown[]) => Promise<never>> {
  return addMockInspect(mock.fn(() => Promise.reject(error)), name ?? 'rejects');
}

/**
 * Create a mock function that throws an error.
 * @param error The error to throw
 * @param name Optional name for debugging (shown in console.log)
 */
export function mockThrows(error: Error, name?: string): NodeMock<(...args: unknown[]) => never> {
  return addMockInspect(
    mock.fn(() => {
      throw error;
    }),
    name ?? 'throws'
  );
}

// ============================================================================
// Assertion Helpers
// ============================================================================

/**
 * Assert that a mock was called with specific arguments.
 */
export function assertCalledWith<TArgs extends unknown[], TReturn>(
  mockFn: NodeMock<(...args: TArgs) => TReturn>,
  ...expectedArgs: TArgs
): void {
  const calls = mockFn.mock.calls;
  const found = calls.some((call) =>
    JSON.stringify(call.arguments) === JSON.stringify(expectedArgs)
  );

  if (!found) {
    const actualCalls = calls.map((c) => JSON.stringify(c.arguments)).join('\n  ');
    throw new Error(
      `Expected mock to be called with ${JSON.stringify(expectedArgs)}\n` +
        `Actual calls:\n  ${actualCalls || '(none)'}`
    );
  }
}

/**
 * Assert that a mock was called exactly n times.
 */
export function assertCallCount<TArgs extends unknown[], TReturn>(
  mockFn: NodeMock<(...args: TArgs) => TReturn>,
  expected: number
): void {
  const actual = mockFn.mock.callCount();
  if (actual !== expected) {
    throw new Error(`Expected mock to be called ${expected} times, but was called ${actual} times`);
  }
}

/**
 * Assert that a mock was never called.
 */
export function assertNotCalled<TArgs extends unknown[], TReturn>(
  mockFn: NodeMock<(...args: TArgs) => TReturn>
): void {
  assertCallCount(mockFn, 0);
}
