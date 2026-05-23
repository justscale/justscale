import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Container, defineService } from '../src/core/service.js';

describe('Container', () => {
  describe('registerClass', () => {
    it('should instantiate a class with no dependencies', async () => {
      class SimpleService {
        getValue() {
          return 42;
        }
      }

      const container = new Container();
      container.registerClass(SimpleService);

      const instance = await container.resolve(SimpleService);
      assert.strictEqual(instance.getValue(), 42);
    });

    it('should return the same instance on multiple resolves', async () => {
      class SingletonService {
        id = Math.random();
      }

      const container = new Container();
      container.registerClass(SingletonService);

      const first = await container.resolve(SingletonService);
      const second = await container.resolve(SingletonService);

      assert.strictEqual(first, second);
      assert.strictEqual(first.id, second.id);
    });
  });

  describe('registerInstance', () => {
    it('should use the provided instance', async () => {
      class ConfigService {
        constructor(public value: string) {}
      }

      const container = new Container();
      const customInstance = new ConfigService('custom-value');
      container.registerInstance(ConfigService, customInstance);

      const resolved = await container.resolve(ConfigService);
      assert.strictEqual(resolved.value, 'custom-value');
      assert.strictEqual(resolved, customInstance);
    });
  });

  describe('resolve', () => {
    it('should auto-instantiate unregistered classes', async () => {
      class AutoService {
        getName() {
          return 'auto';
        }
      }

      const container = new Container();
      const instance = await container.resolve(AutoService);

      assert.strictEqual(instance.getName(), 'auto');
    });

    it('should throw for unresolvable tokens', async () => {
      const container = new Container();
      const badToken = { notAClass: true } as any;

      await assert.rejects(() => container.resolve(badToken), /Unable to resolve/);
    });
  });
});

describe('defineService (object form)', () => {
  it('should create a service definition', async () => {
    const service = defineService({
      inject: {},
      factory: () => ({
        greet: (name: string) => `Hello, ${name}!`,
      }),
    });

    assert.ok(service.factory);
    assert.deepStrictEqual(service.deps, {});
  });

  it('should resolve factory-based services', async () => {
    const GreetingService = defineService({
      inject: {},
      factory: () => ({
        greet: (name: string) => `Hello, ${name}!`,
      }),
    });

    const container = new Container();
    container.register(GreetingService);

    const instance = await container.resolve(GreetingService);
    assert.strictEqual(instance.greet('World'), 'Hello, World!');
  });

  it('should inject dependencies into factory-based services', async () => {
    class Database {
      query(sql: string) {
        return `Result of: ${sql}`;
      }
    }

    const UserService = defineService({
      inject: { db: Database },
      factory: ({ db }) => ({
        findAll: () => db.query('SELECT * FROM users'),
      }),
    });

    const container = new Container();
    container.registerClass(Database);
    container.register(UserService);

    const userService = await container.resolve(UserService);
    assert.strictEqual(
      userService.findAll(),
      'Result of: SELECT * FROM users'
    );
  });

  it('should handle nested dependencies', async () => {
    class Logger {
      log(msg: string) {
        return `[LOG] ${msg}`;
      }
    }

    const CacheService = defineService({
      inject: { logger: Logger },
      factory: ({ logger }) => ({
        get: (key: string) => {
          logger.log(`Cache get: ${key}`);
          return `cached:${key}`;
        },
      }),
    });

    const ApiService = defineService({
      inject: { cache: CacheService, logger: Logger },
      factory: ({ cache, logger }) => ({
        fetch: (url: string) => {
          logger.log(`Fetching: ${url}`);
          return cache.get(url);
        },
      }),
    });

    const container = new Container();
    container.registerClass(Logger);
    container.register(CacheService);
    container.register(ApiService);

    const api = await container.resolve(ApiService);
    assert.strictEqual(api.fetch('/users'), 'cached:/users');
  });

  it('should share singleton instances across dependencies', async () => {
    let instanceCount = 0;

    class Counter {
      id: number;
      constructor() {
        this.id = ++instanceCount;
      }
    }

    const ServiceA = defineService({
      inject: { counter: Counter },
      factory: ({ counter }) => ({ counterId: counter.id }),
    });

    const ServiceB = defineService({
      inject: { counter: Counter },
      factory: ({ counter }) => ({ counterId: counter.id }),
    });

    const container = new Container();
    container.registerClass(Counter);
    container.register(ServiceA);
    container.register(ServiceB);

    const a = await container.resolve(ServiceA);
    const b = await container.resolve(ServiceB);

    // Both should have the same counter instance
    assert.strictEqual(a.counterId, b.counterId);
    assert.strictEqual(instanceCount, 1);
  });

  it('should resolve deps regardless of registration order', async () => {
    class ServiceB {
      getValue() {
        return 'B';
      }
    }

    const ServiceA = defineService({
      inject: { b: ServiceB },
      factory: ({ b }) => ({
        getValue: () => `A+${b.getValue()}`,
      }),
    });

    // Register A before B (A depends on B)
    const container = new Container();
    container.register(ServiceA);
    container.registerClass(ServiceB);

    const a = await container.resolve(ServiceA);
    assert.strictEqual(a.getValue(), 'A+B');
  });

  it('should handle diamond dependencies', async () => {
    class ServiceD {
      id = Math.random();
    }

    const ServiceB = defineService({
      inject: { d: ServiceD },
      factory: ({ d }) => ({ dId: d.id }),
    });

    const ServiceC = defineService({
      inject: { d: ServiceD },
      factory: ({ d }) => ({ dId: d.id }),
    });

    const ServiceA = defineService({
      inject: { b: ServiceB, c: ServiceC },
      factory: ({ b, c }) => ({ bDId: b.dId, cDId: c.dId }),
    });

    const container = new Container();
    container.register(ServiceC);
    container.register(ServiceA);
    container.registerClass(ServiceD);
    container.register(ServiceB);

    const a = await container.resolve(ServiceA);
    assert.strictEqual(a.bDId, a.cDId, 'Diamond deps should share singleton');
  });
});

describe('defineService', () => {
  it('should create an extendable service definition', async () => {
    class TestService extends defineService({
      inject: {},
      factory: () => ({
        greet: (name: string) => `Hello, ${name}!`,
      }),
    }) {}

    assert.ok(TestService.factory);
    assert.deepStrictEqual(TestService.deps, {});
  });

  it('should resolve class-based services', async () => {
    class GreetingService extends defineService({
      inject: {},
      factory: () => ({
        greet: (name: string) => `Hello, ${name}!`,
      }),
    }) {}

    const container = new Container();
    container.register(GreetingService);

    const instance = await container.resolve(GreetingService);
    assert.strictEqual(instance.greet('World'), 'Hello, World!');
  });

  it('should inject dependencies into class-based services', async () => {
    class Database {
      query(sql: string) {
        return `Result of: ${sql}`;
      }
    }

    class UserService extends defineService({
      inject: { db: Database },
      factory: ({ db }) => ({
        findAll: () => db.query('SELECT * FROM users'),
      }),
    }) {}

    const container = new Container();
    container.registerClass(Database);
    container.register(UserService);

    const userService = await container.resolve(UserService);
    assert.strictEqual(
      userService.findAll(),
      'Result of: SELECT * FROM users'
    );
  });

  it('should throw error when trying to instantiate with new', async () => {
    class TestService extends defineService({
      inject: {},
      factory: () => ({ value: 42 }),
    }) {}

    assert.throws(
      () => new TestService(),
      /Service classes should not be instantiated directly/
    );
  });

  it('should work with defineService object-form deps (interop)', async () => {
    const LegacyService = defineService({
      inject: {},
      factory: () => ({
        getValue: () => 'legacy',
      }),
    });

    class ModernService extends defineService({
      inject: { legacy: LegacyService },
      factory: ({ legacy }) => ({
        getValue: () => `modern+${legacy.getValue()}`,
      }),
    }) {}

    const container = new Container();
    container.register(LegacyService);
    container.register(ModernService);

    const modern = await container.resolve(ModernService);
    assert.strictEqual(modern.getValue(), 'modern+legacy');
  });

  it('should work as dependency of defineService object-form (reverse interop)', async () => {
    class ModernService extends defineService({
      inject: {},
      factory: () => ({
        getValue: () => 'modern',
      }),
    }) {}

    const LegacyService = defineService({
      inject: { modern: ModernService },
      factory: ({ modern }) => ({
        getValue: () => `legacy+${modern.getValue()}`,
      }),
    });

    const container = new Container();
    container.register(ModernService);
    container.register(LegacyService);

    const legacy = await container.resolve(LegacyService);
    assert.strictEqual(legacy.getValue(), 'legacy+modern');
  });

  it('should handle nested class-based dependencies', async () => {
    class Logger {
      log(msg: string) {
        return `[LOG] ${msg}`;
      }
    }

    class CacheService extends defineService({
      inject: { logger: Logger },
      factory: ({ logger }) => ({
        get: (key: string) => {
          logger.log(`Cache get: ${key}`);
          return `cached:${key}`;
        },
      }),
    }) {}

    class ApiService extends defineService({
      inject: { cache: CacheService, logger: Logger },
      factory: ({ cache, logger }) => ({
        fetch: (url: string) => {
          logger.log(`Fetching: ${url}`);
          return cache.get(url);
        },
      }),
    }) {}

    const container = new Container();
    container.registerClass(Logger);
    container.register(CacheService);
    container.register(ApiService);

    const api = await container.resolve(ApiService);
    assert.strictEqual(api.fetch('/users'), 'cached:/users');
  });
});

describe('concurrent resolution', () => {
  it('should not double-instantiate when resolved concurrently', async () => {
    let instantiationCount = 0;

    const SlowService = defineService({
      inject: {},
      factory: async () => {
        // Simulate slow async initialization
        await new Promise((resolve) => setTimeout(resolve, 10));
        instantiationCount++;
        return { count: instantiationCount };
      },
    });

    const container = new Container();
    container.register(SlowService);

    // Resolve concurrently
    const [result1, result2, result3] = await Promise.all([
      container.resolve(SlowService),
      container.resolve(SlowService),
      container.resolve(SlowService),
    ]);

    // Should only be instantiated once
    assert.strictEqual(instantiationCount, 1);

    // All results should be the same instance
    assert.strictEqual(result1, result2);
    assert.strictEqual(result2, result3);
  });

  it('should handle concurrent resolution of dependent services', async () => {
    let baseCount = 0;
    let dependentCount = 0;

    const BaseService = defineService({
      inject: {},
      factory: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        baseCount++;
        return { base: true, count: baseCount };
      },
    });

    const DependentService = defineService({
      inject: { base: BaseService },
      factory: async ({ base }) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        dependentCount++;
        return { dependent: true, base, count: dependentCount };
      },
    });

    const container = new Container();
    container.register(BaseService);
    container.register(DependentService);

    // Resolve both services concurrently
    const [base1, dep1, base2, dep2] = await Promise.all([
      container.resolve(BaseService),
      container.resolve(DependentService),
      container.resolve(BaseService),
      container.resolve(DependentService),
    ]);

    // Each service should only be instantiated once
    assert.strictEqual(baseCount, 1);
    assert.strictEqual(dependentCount, 1);

    // All should be same instances
    assert.strictEqual(base1, base2);
    assert.strictEqual(dep1, dep2);
    assert.strictEqual(dep1.base, base1);
  });
});

describe('service aliasing (bindService)', () => {
  it('should not instantiate a service twice when registered under multiple tokens', async () => {
    let instantiationCount = 0;

    abstract class AbstractService {
      abstract getValue(): string;
    }

    const ConcreteService = defineService({
      inject: {},
      factory: () => {
        instantiationCount++;
        return {
          getValue: () => 'concrete',
        };
      },
    });

    const container = new Container();
    // Register the concrete service
    container.register(ConcreteService);
    // Register it under the abstract token too (like bindService does)
    container.registerFor(AbstractService, ConcreteService);

    // Resolve via abstract token
    const instance1 = await container.resolve(AbstractService);
    assert.strictEqual(instantiationCount, 1);

    // Resolve via concrete token - should return same instance
    const instance2 = await container.resolve(ConcreteService);
    assert.strictEqual(instantiationCount, 1);

    // Should be the exact same instance
    assert.strictEqual(instance1, instance2);
  });

  it('should handle resolveAll with aliased services correctly', async () => {
    let instantiationCount = 0;

    abstract class AbstractService {
      abstract getValue(): string;
    }

    const ConcreteService = defineService({
      inject: {},
      factory: () => {
        instantiationCount++;
        return {
          getValue: () => 'concrete',
        };
      },
    });

    const container = new Container();
    container.register(ConcreteService);
    container.registerFor(AbstractService, ConcreteService);

    // resolveAll should only instantiate once even though service is registered under 2 tokens
    await container.resolveAll();

    assert.strictEqual(instantiationCount, 1);
  });

  it('should handle concurrent resolution of aliased services', async () => {
    let instantiationCount = 0;

    // Use a plain class as the abstract token
    class AbstractService {
      getValue(): string {
        throw new Error('Not implemented');
      }
    }

    class ConcreteService extends defineService({
      inject: {},
      factory: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        instantiationCount++;
        return {
          getValue: () => 'concrete',
        };
      },
    }) {}

    const container = new Container();
    container.register(ConcreteService);
    container.registerFor(AbstractService, ConcreteService);

    // Resolve both tokens concurrently
    const [instance1, instance2] = await Promise.all([
      container.resolve(AbstractService),
      container.resolve(ConcreteService),
    ]);

    // Should only instantiate once
    assert.strictEqual(instantiationCount, 1);

    // Should be the same instance
    assert.strictEqual(instance1, instance2);
  });
});

describe('resolveAll', () => {
  it('should instantiate all registered services', async () => {
    let serviceAInstantiated = false;
    let serviceBInstantiated = false;

    const ServiceA = defineService({
      inject: {},
      factory: () => {
        serviceAInstantiated = true;
        return { name: 'A' };
      },
    });

    const ServiceB = defineService({
      inject: {},
      factory: () => {
        serviceBInstantiated = true;
        return { name: 'B' };
      },
    });

    const container = new Container();
    container.register(ServiceA);
    container.register(ServiceB);

    // Services should not be instantiated yet
    assert.strictEqual(serviceAInstantiated, false);
    assert.strictEqual(serviceBInstantiated, false);

    // resolveAll should instantiate all registered services
    await container.resolveAll();

    assert.strictEqual(serviceAInstantiated, true);
    assert.strictEqual(serviceBInstantiated, true);
  });

  it('should instantiate services even without dependencies', async () => {
    // Simulates a service that registers hooks/listeners as a side effect
    const hooksCalled: string[] = [];

    const HookService = defineService({
      inject: {},
      factory: () => {
        hooksCalled.push('HookService initialized');
        return {
          registered: true,
        };
      },
    });

    const container = new Container();
    container.register(HookService);

    // Hook should not be called yet
    assert.strictEqual(hooksCalled.length, 0);

    await container.resolveAll();

    // Hook should be called after resolveAll
    assert.strictEqual(hooksCalled.length, 1);
    assert.strictEqual(hooksCalled[0], 'HookService initialized');
  });

  it('should not re-instantiate already resolved services', async () => {
    let instantiationCount = 0;

    const CountingService = defineService({
      inject: {},
      factory: () => {
        instantiationCount++;
        return { count: instantiationCount };
      },
    });

    const container = new Container();
    container.register(CountingService);

    // First resolution
    await container.resolve(CountingService);
    assert.strictEqual(instantiationCount, 1);

    // resolveAll should not re-instantiate
    await container.resolveAll();
    assert.strictEqual(instantiationCount, 1);
  });
});
