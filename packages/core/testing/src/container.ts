/**
 * Test Container
 *
 * Extended container with support for mocking and overriding services.
 */

import {
  Container,
  type ServiceToken,
  type InstanceOf,
} from '@justscale/core';

/**
 * A container designed for testing with mock support.
 *
 * @example
 * ```typescript
 * const container = new TestContainer();
 *
 * // Register real services
 * container.register(UserRepository);
 * container.register(UserService);
 *
 * // Override with a mock
 * container.mock(UserRepository, {
 *   findById: mockFn().returns(Promise.resolve({ id: '1', name: 'Test' })),
 * });
 *
 * // Resolve - will use the mock for UserRepository
 * const userService = container.resolve(UserService);
 * ```
 */
export class TestContainer extends Container {
  private mocks = new Map<ServiceToken, unknown>();

  /**
   * Override a service with a mock implementation.
   * The mock will be used instead of the real service when resolving.
   */
  mock<T>(token: ServiceToken<T>, mockInstance: Partial<T>): this {
    this.mocks.set(token, mockInstance);
    return this;
  }

  /**
   * Override a service with a complete replacement instance.
   */
  override<T>(token: ServiceToken<T>, instance: T): this {
    this.mocks.set(token, instance);
    return this;
  }

  /**
   * Clear all mocks, restoring original service resolution.
   */
  clearMocks(): this {
    this.mocks.clear();
    return this;
  }

  /**
   * Clear a specific mock.
   */
  clearMock<T>(token: ServiceToken<T>): this {
    this.mocks.delete(token);
    return this;
  }

  /**
   * Get the mock for a service if one exists.
   */
  getMock<T>(token: ServiceToken<T>): T | undefined {
    return this.mocks.get(token) as T | undefined;
  }

  /**
   * Check if a service has been mocked.
   */
  isMocked<T>(token: ServiceToken<T>): boolean {
    return this.mocks.has(token);
  }

  /**
   * Resolve a service - returns mock if available, otherwise resolves normally.
   */
  override async resolve<T>(token: ServiceToken<T>): Promise<T> {
    // Check for mock first
    if (this.mocks.has(token)) {
      return this.mocks.get(token) as T;
    }

    // Fall back to normal resolution
    return super.resolve(token);
  }

  /**
   * Get typed access to a resolved service.
   * Useful for accessing services in tests.
   *
   * @example
   * ```typescript
   * const userService = await container.get(UserService);
   * // userService is typed as InstanceOf<typeof UserService>
   * ```
   */
  async get<T extends ServiceToken>(token: T): Promise<InstanceOf<T>> {
    return this.resolve(token) as Promise<InstanceOf<T>>;
  }
}
