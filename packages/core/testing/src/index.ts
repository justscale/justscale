/**
 * JustScale Testing Utilities
 *
 * Provides helpers for testing JustScale applications:
 * - TestContainer: Container with mock support
 * - createTestApp: Create an app instance for testing
 * - Test client with pluggable transports
 */

if (process.env.NODE_ENV === 'production') {
  throw new Error(
    '@justscale/core/testing must not be imported in production code. ' +
    'This package contains test-only utilities (mocks, spies, TestContainer).',
  );
}

export { TestContainer } from './container.js';
export { createTestApp, type TestApp } from './app.js';
export {
  createTestClient,
  teardownApp,
  type TestClient,
  type TestClientWithTransports,
  type TestClientOptions,
  type TestTransport,
  type TransportState,
  type TransportClient,
  type TransportOptions,
  type TestResponse,
  type BuildControllerAPI,
} from './client.js';
export {
  createTestKit,
  type TestKit,
  type CreateTestKitOptions,
  type KitBuilderFn,
  type SpawnHttpOptions,
  type SpawnHttpResult,
} from './kit.js';
export {
  // Re-exported from node:test
  mock,
  // Mock helpers
  mockFn,
  mockService,
  spyOn,
  spyService,
  mockResolves,
  mockRejects,
  mockThrows,
  // Assertions
  assertCalledWith,
  assertCallCount,
  assertNotCalled,
  // Debugger support
  enableDebuggerFormatters,
  // Types
  type MockedService,
  type SpyWrapper,
} from './mock.js';

// Lock testing utilities
export { InMemoryLockProvider } from '@justscale/core/memory';
