import { describe, it } from 'node:test';
import assert from 'node:assert';
import JustScale, { defineService, bindService } from '../src/index.js';

describe('defineService with provides option', () => {
  it('should auto-bind to abstract token when provides is set', async () => {
    // Abstract token
    abstract class AbstractFoo {
      abstract bar(): string;
    }

    // Implementation with provides
    class FooImpl extends defineService({
      inject: {},
      provides: [AbstractFoo],
      factory: () => ({ bar: () => 'baz' }),
    }) {}

    const app = JustScale().add(FooImpl).build();

    // Should be resolvable via abstract token
    const foo = await app.container.resolve(AbstractFoo);
    assert.strictEqual(foo.bar(), 'baz');
  });

  it('should still be resolvable via implementation token', async () => {
    abstract class AbstractFoo {
      abstract bar(): string;
    }

    class FooImpl extends defineService({
      inject: {},
      provides: [AbstractFoo],
      factory: () => ({ bar: () => 'impl' }),
    }) {}

    const app = JustScale().add(FooImpl).build();

    // Both tokens should work
    const viaImpl = await app.container.resolve(FooImpl);
    const viaAbstract = await app.container.resolve(AbstractFoo);

    assert.strictEqual(viaImpl.bar(), 'impl');
    assert.strictEqual(viaAbstract.bar(), 'impl');
  });

  it('should allow explicit bindService to override implicit provides', async () => {
    abstract class AbstractFoo {
      abstract bar(): string;
    }

    class FooImpl1 extends defineService({
      inject: {},
      provides: [AbstractFoo],
      factory: () => ({ bar: () => 'impl1' }),
    }) {}

    class FooImpl2 extends defineService({
      inject: {},
      factory: () => ({ bar: () => 'impl2' }),
    }) {}

    // FooImpl1 has implicit provides, but bindService explicitly overrides
    const app = JustScale()
      .add(FooImpl1)
      .add(FooImpl2)
      .add(bindService(AbstractFoo, FooImpl2))
      .build();

    const foo = await app.container.resolve(AbstractFoo);
    assert.strictEqual(foo.bar(), 'impl2');
  });

  it('should allow factory to return more than abstract requires', async () => {
    abstract class AbstractFoo {
      abstract bar(): string;
    }

    class FooImpl extends defineService({
      inject: {},
      provides: [AbstractFoo],
      factory: () => ({
        bar: () => 'baz',
        extra: () => 'extra method',
      }),
    }) {}

    const app = JustScale().add(FooImpl).build();

    // Resolve via implementation to get extra method
    const impl = await app.container.resolve(FooImpl);
    assert.strictEqual(impl.extra(), 'extra method');

    // Resolve via abstract only gets abstract interface
    const foo = await app.container.resolve(AbstractFoo);
    assert.strictEqual(foo.bar(), 'baz');
  });

  it('should work with multiple provides tokens', async () => {
    abstract class AbstractFoo {
      abstract foo(): string;
    }

    abstract class AbstractBar {
      abstract bar(): string;
    }

    class MultiImpl extends defineService({
      inject: {},
      provides: [AbstractFoo, AbstractBar],
      factory: () => ({
        foo: () => 'foo',
        bar: () => 'bar',
      }),
    }) {}

    const app = JustScale().add(MultiImpl).build();

    const foo = await app.container.resolve(AbstractFoo);
    const bar = await app.container.resolve(AbstractBar);

    assert.strictEqual(foo.foo(), 'foo');
    assert.strictEqual(bar.bar(), 'bar');
  });

  it('should work with dependencies', async () => {
    // Define a custom logger service for this test
    class CustomLogger extends defineService({
      inject: {},
      factory: () => ({
        log(msg: string) {
          return `[LOG] ${msg}`;
        },
      }),
    }) {}

    abstract class AbstractStorage {
      abstract get(key: string): string;
    }

    class InMemoryStorage extends defineService({
      inject: { logger: CustomLogger },
      provides: [AbstractStorage],
      factory: ({ logger }) => {
        const data = new Map<string, string>();
        return {
          get(key: string) {
            logger.log(`Getting ${key}`);
            return data.get(key) ?? 'not found';
          },
          set(key: string, value: string) {
            data.set(key, value);
          },
        };
      },
    }) {}

    const app = JustScale()
      .add(CustomLogger)
      .add(InMemoryStorage)
      .build();

    const storage = await app.container.resolve(AbstractStorage);
    assert.strictEqual(storage.get('test'), 'not found');
  });

  it('should satisfy type-level dependency checking via provides', async () => {
    abstract class AbstractDatabase {
      abstract query(sql: string): string;
    }

    class InMemoryDatabase extends defineService({
      inject: {},
      provides: [AbstractDatabase],
      factory: () => ({
        query: (sql: string) => `Result: ${sql}`,
      }),
    }) {}

    // Service that depends on AbstractDatabase
    class UserService extends defineService({
      inject: { db: AbstractDatabase },
      factory: ({ db }) => ({
        findAll: () => db.query('SELECT * FROM users'),
      }),
    }) {}

    // This should compile - InMemoryDatabase provides AbstractDatabase
    const app = JustScale()
      .add(InMemoryDatabase)
      .add(UserService)
      .build();

    const userService = await app.container.resolve(UserService);
    assert.strictEqual(userService.findAll(), 'Result: SELECT * FROM users');
  });
});
