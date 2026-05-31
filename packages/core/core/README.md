# @justscale/core

The foundation every JustScale app sits on. `@justscale/core` is the DI container, the service/controller/feature primitives, the composition builder (`JustScale()`), the durable-process runtime, the model layer, and the distributed primitives (locks + channels). It also ships the `just` binary.

The distinguishing idea: **composition is validated at compile time.** A missing dependency is a type error, not a runtime crash. You get that by describing services, controllers, and features as values with typed dependency tokens and letting `build()` check the graph.

Full docs: [justscale.sh](https://justscale.sh) — start at [overview/philosophy](https://justscale.sh/docs/overview/philosophy).

## Install

```bash
pnpm add @justscale/core
```

Peer deps: `zod` (required for schemas), `@justscale/typescript` (optional; installs `ptsc` for the durable-process compiler), `esbuild` (optional; used by parts of the CLI).

## Hello world

```ts
import JustScale, { defineService, createController } from '@justscale/core';
import { Get } from '@justscale/http';

class Greeter extends defineService({
  factory: () => ({ hello: (name: string) => `Hello, ${name}!` }),
}) {}

const GreetController = createController({
  inject: { greeter: Greeter },
  routes: ({ greeter }) => ({
    greet: Get('/greet/:name').handle(({ params, res }) =>
      res.json({ message: greeter.hello(params.name) }),
    ),
  }),
});

const app = JustScale()
  .add(Greeter)
  .add(GreetController)
  .build();

await app.serve();
```

`.add(...)` composes services, controllers, and features into a scope. `build()` type-checks the DI graph — forget `.add(Greeter)` and `GreetController` won't compile. `serve()` pulls `HttpConfig` from the scope (default port `6142`) and opens the sockets.

Real apps usually declare per-environment config through `createEnvironment` + an env contract and boot via `just dev` / `just test`; see [examples/simple-app](https://github.com/justscale/justscale/tree/main/examples/simple-app) for the canonical shape.

## Primitives

### Services — [justscale.sh/docs/fundamentals/services](https://justscale.sh/docs/fundamentals/services)

```ts
class UserService extends defineService({
  inject: { users: UserRepository },
  factory: ({ users }) => ({
    findByEmail: (email: string) =>
      users.findOne(User.fields.email.eq(email)),
  }),
}) {}
```

`defineService({ inject, factory })` returns a class you extend. `inject` lists the DI tokens you need; `factory` receives the resolved instances and returns your service. The returned class is itself the DI token — pass `UserService` to `.add(UserService)` or inject it elsewhere.

Abstract tokens (`defineAbstract`) let services declare "I need _something_ that implements this interface" without naming a concrete class. Bind a concrete implementation at compose time with `bindService(AbstractToken, ConcreteService)`. Same pattern for repositories via `bindRepository(ModelRepository.of(User), UserRepository)`.

### Controllers — [justscale.sh/docs/fundamentals/controllers](https://justscale.sh/docs/fundamentals/controllers)

```ts
createController({
  inject: { svc: MyService },
  routes: ({ svc }) => ({
    foo: Get('/foo').use(middleware).guard(check).handle(ctx => svc.foo(ctx)),
    bar: Cli('bar').input(z.object({...})).handle(ctx => svc.bar(ctx)),
  }),
});
```

Controllers are DI units that hold routes. Route factories come from transport packages — `Get`/`Post`/... from `@justscale/http`, `Cli` from `@justscale/core/cli`, server-sent events from `@justscale/sse` — and all flow through the same `.use(middleware).guard(...).handle(...)` pipeline with per-route typing. Further transports (WebSocket, RPC) graduate from `next` as those packages settle.

### Features — [justscale.sh/docs/fundamentals/features](https://justscale.sh/docs/fundamentals/features)

```ts
export const AuthFeature = createFeatureBuilder()
  .name('auth')
  .requires(Config.of(AuthConfig))
  .provides(b => b.add(AuthService).add(AuthEndpointsController));
```

Features are shippable capability bundles: a named package of services + controllers + config requirements that other apps consume via `.add(AuthFeature)`. `.requires(...)` bubbles DI requirements up to whoever adds the feature — the requirement is checked at their `build()`, not yours.

## Composition

### `JustScale()`

```ts
JustScale()
  .add(ServiceA)
  .add(ControllerB)
  .add(FeatureC)
  .build();
```

The builder is the unit of composition. Every `.add()` contributes services, controllers, features, or bindings into a scope. `.build()` returns a validated `BuiltApp` with `.serve()`, `.match()`, `.run()`, and friends.

### Sub-apps

```ts
const AdminSubApp = JustScale()
  .requires(CatalogService)
  .requires(InventoryService)
  .add(AdminController)
  .build();

const Shop = JustScale()
  .add(CatalogService)
  .add(InventoryService)
  .add(ShopController)
  .add(AdminSubApp)
  .build();
```

A `JustScale()` compilation unit with `.requires(...)` is a sub-app. Mounting it into a parent (`parent.add(SubApp)`) bridges the required services in via scope-switched proxies — calls from inside the sub-app still execute under the parent's container, locks, and observability context. Admin-only services live in their own scope without polluting the host.

### `AbstractContainer`

Reflection on a scope. Inject `AbstractContainer` into a service or controller and you get a typed view of the controllers/services/features bound to that scope. Useful for per-scope introspection (e.g. generating an OpenAPI spec scoped to a single sub-app).

## Durable processes — [justscale.sh/docs/processes/signals](https://justscale.sh/docs/processes/signals)

```ts
import { createProcess, signal, race, delay } from '@justscale/core/process';
import { defineSignals } from '@justscale/core/process';

class OrderSignals extends defineSignals(signal => ({
  paid: signal('/order/:order/paid').data<{ txId: string }>().types({ Order }),
})) {}

const orderFulfillment = createProcess({
  path: '/order/:order/fulfillment',
  inject: { signals: OrderSignals },
  async handler({ signals }, { order }) {
    const r = race();
    switch (true) {
      case signal(r, signals.paid):
        return { status: 'paid', txId: r.txId };
      case delay.days(r, 3):
        return { status: 'timeout' };
    }
  },
});
```

Durable processes survive restarts. Their state is serialized through the `Processable` protocol, timers and signals resume transparently, and the compiler (via `@justscale/typescript`'s `ptsc`) rewrites the handler into a safely resumable shape. The runtime is transport-agnostic — signals can fire from HTTP, CLI, cluster, anywhere.

## Models — [justscale.sh/docs/models/overview](https://justscale.sh/docs/models/overview)

```ts
import { defineModel, field } from '@justscale/core/models';

class User extends defineModel({
  name: 'User',
  fields: {
    email: field.string().max(255).unique(),
    balance: field.decimal(10, 2).default('0.00'),
  },
}) {}

repo.find({ where: User.fields.email.eq('test@example.com') });
```

Field builders, not Zod — `field.*` gives you typed queryable field expressions (`.eq`, `.gt`, `.ilike`, composed with `and`/`or`). Services inject the abstract `ModelRepository.of(User)` token and stay storage-agnostic; the concrete implementation (e.g. `createPgRepository` from `@justscale/postgres`) is bound at compose time.

References (`field.ref(OtherModel)`) are first-class values, not string IDs. Controllers receive `Reference<T>` in their params and services take `Locked<T>` for mutations; the framework keeps the domain ID-free.

## Authorization — [justscale.sh/docs/features/permissions](https://justscale.sh/docs/features/permissions)

Models declare *who may do what* next to their fields. A `permissions:` block generates a typed `Model.can.*` map of guards; an `access:` block restricts field-level visibility (`see`) and mutability (`set`). Both are evaluated by core — the rule builders (`permit()`, `Everyone`) ship in `@justscale/permission`.

```ts
import { permit, Everyone } from '@justscale/permission';

class Post extends defineModel({
  name: 'Post',
  fields: { author: field.ref(Author), title: field.string(), body: field.text() },
  permissions: ({ author }) => ({
    edit: permit(Author).when(author), // only the row's author
    view: permit(Everyone).always(),
  }),
}) {}
```

One rule then drives the whole request path: guard a route with `.guard(Post.can.edit)`, branch a response by `.returns(200, View, Post.can.view)`, or fold the rule into a query with `byPermissions(Post.can.view, principal)` — declared once, enforced everywhere.

## Distributed primitives

### Locks — [justscale.sh/docs/fundamentals/locks](https://justscale.sh/docs/fundamentals/locks)

Abstract lock API with an `acquire(key, opts)` signature that returns a disposable guard — integrates with the `using` statement for auto-release. The default provider is in-memory (good for tests). `@justscale/postgres` provides a Postgres advisory-lock backend that coordinates across instances, so locks survive being held from different processes hitting the same database.

### Channels — [justscale.sh/docs/fundamentals/channels](https://justscale.sh/docs/fundamentals/channels)

Typed pub/sub with async iterables. `createChannels({ ... })` declares a set of named channels with per-message schemas; subscribers consume via `for await` on a subscription. The default `MemoryChannelBackend` works for a single process; `@justscale/postgres`'s `createPostgresChannelBackend` fans messages out over `LISTEN/NOTIFY` so multiple app instances pointed at the same database all see each publish. Message encoding goes through the `Processable` protocol so domain values (model refs, dates, decimals) survive the round-trip.

## Configuration — [justscale.sh/docs/configuration/overview](https://justscale.sh/docs/configuration/overview)

```ts
import { defineConfigPartial, createConfig, Config } from '@justscale/core';

export const AppConfig = defineConfigPartial('app', z.object({
  siteUrl: z.string(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
}));

.add(createConfig({
  provides: [AppConfig],
  factory: () => ({ [AppConfig.key]: { siteUrl: 'https://example.com' } }),
}));
```

Config is a first-class primitive, not an env-var dip. Features declare the `Config.of(...)` partials they need; the app satisfies them with `createConfig(...)`. Zod schemas validate at startup and defaults feed through (e.g. `HttpConfig.port` defaults to `6142`).

## Subpath exports

Everything beyond the bare `@justscale/core` import lives behind a subpath so you pay only for what you load:

- `@justscale/core/models` — `defineModel`, `field`, `ModelRepository`, references
- `@justscale/core/process` — durable `createProcess`, `defineSignals`, `race`, `signal`, `delay`
- `@justscale/core/cluster` — multi-node transport, routing, scheduled tasks
- `@justscale/core/cli` — `Cli` route factory for `just`-discovered commands
- `@justscale/core/channel` — typed pub/sub async iterables
- `@justscale/core/lock` — abstract lock API with an in-memory default
- `@justscale/core/config` — config service, `defineConfigPartial`, `createConfig`
- `@justscale/core/contract` — `defineContract` for cross-transport controllers
- `@justscale/core/feature` — `createFeatureBuilder`
- `@justscale/core/memory` — in-memory adapter implementations (tests / prototyping)
- `@justscale/core/middleware`, `/logger`, `/lifecycle`, `/plugin` — narrower slices of the bare surface

## `just` CLI — [justscale.sh/docs/cli/usage](https://justscale.sh/docs/cli/usage)

Installing this package installs the `just` binary:

```bash
just dev               # boot the app in dev mode with HMR
just build             # build the workspace
just test              # run tests (filterable via flags)
just init              # initialize project / IDE / AI config
just install <plugin>  # install a JustScale plugin package
```

`just` also discovers commands exported by any installed `@justscale/*` plugin — adding `@justscale/postgres` gives you `just migrate`, for example. Tab-completion installs itself on first invocation; `just __complete` is the internal back-channel, not a user-facing command.

## Observability

Services and controllers run under an async context with request tracing, scope management, and pluggable instrumentation. `registerInstrumentation` lets OpenTelemetry / Datadog / custom collectors subscribe without the app code having to know.

## More

- [Quick start](https://justscale.sh/docs/overview/quick-start)
- [Core philosophy](https://justscale.sh/docs/overview/philosophy)
- [Repository pattern](https://justscale.sh/docs/repositories/overview)
- [Cluster overview](https://justscale.sh/docs/cluster/overview)
