# @justscale/testing

Test utilities for JustScale: a `createTestKit()` harness that spawns one or more app instances with lifecycle auto-drain, plus DI mocks and spy helpers built on `node:test`.

## Install

```bash
pnpm add -D @justscale/testing
```

## Usage

```ts
import { test } from 'node:test';
import { createTestKit } from '@justscale/testing';

test('user service', async (t) => {
  const kit = createTestKit(t);

  const app = await kit.spawn(builder =>
    builder.register(UserRepository, myInMemoryRepo),
  );

  const result = await app.service(UserService).findAll();
  assert.ok(result.length > 0);
});
```

`createTestKit(t)` registers `afterEach` automatically and drains all lifecycle handles (timers, locks, channels) on teardown — no manual cleanup required.

## API

- `createTestKit(t)` — primary harness.
  - `kit.spawn(builderFn)` — single in-process app.
  - `kit.spawnHttp(builderFn, opts?)` — app with real HTTP listener; returns typed client for controller endpoints.
  - `kit.spawnCluster(n, builderFn)` — `n` coordinated instances for distributed-invariant tests.
- `TestContainer` — low-level DI container that accepts mocks in place of concrete services.
- `createTestApp` — compiles an app without opening real sockets; use `.get` / `.post` / etc.
- `mockService` / `spyOn` / `mockFn` / `mockResolves` — thin wrappers over `node:test` mocks with DI-aware typings.
- `InMemoryLockProvider` — lock primitive without Postgres, useful for unit tests.

## Docs

https://justscale.sh/docs/techniques/testing
