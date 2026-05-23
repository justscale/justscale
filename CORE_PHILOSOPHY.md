# JustScale Core Philosophy

## The Problem

Modern backend development has an infrastructure obsession. We spend more time wiring databases, managing connections, handling transactions, configuring authentication, and dealing with deployment than writing actual business logic.

Look at any backend codebase. The core logic — what the application *actually does* — is a small fraction of the code. The rest is infrastructure: how data gets stored, how services communicate, how errors propagate, how state survives restarts.

We've accepted this as normal. It isn't.

## The T-Shirt Test

There's a running joke about programmer t-shirts with silly pseudocode:

```
while alive:
  if not coffee:
    get_coffee()
  drink_coffee()
  work()
```

We laugh because "real code doesn't work like this." But why doesn't it? The logic is clear. The intent is obvious. We understand it instantly.

Now consider a poker game:

```typescript
const hand = await dealCards(players)
const flop = await bettingRound(players, hand)
const turn = await bettingRound(players, flop)
const river = await bettingRound(players, turn)
const winner = determineWinner(players, river)
await awardPot(winner)
```

This is the actual logic of a poker hand. It's simple. It's readable. And in every existing framework, it's buried under infrastructure: WebSocket management, state persistence, reconnection handling, load balancing, transaction management.

JustScale's goal: **make the t-shirt code real.**

## Core Principles

### 1. Domain code describes WHAT, never HOW

Your code should read like a description of what happens, not how it happens.

```typescript
const subscription = createProcess({
  path: '/subscription/:userId',
  inject: { billing: BillingService, notifications: NotificationService },

  async handler({ billing, notifications }, { userId }) {
    while (true) {
      const r = race()
      switch (true) {
        case delay.days(r, 30):
          await billing.charge(userId)
          await notifications.send(userId, 'Payment processed')
          continue

        case signal(r, billing.cancellation):
          await notifications.send(userId, 'Subscription cancelled')
          return { status: 'cancelled' }
      }
    }
  },
})
```

This process runs for months. It survives server restarts. It works across multiple instances. But the code reads like a simple loop with a monthly timer. That's the point.

### 2. IDs do not exist in domain code

An ID is an infrastructure detail. It's how your storage layer tracks entities. It's not a domain concept.

```typescript
// WRONG (every other framework)
const user = await userRepo.findById('abc123')
const order = await orderRepo.findById(user.orderId)
user.id  // string — could be confused with any other string

// RIGHT (JustScale)
const user = await users.findOne(User.fields.email.eq('alice@example.com'))
const order = await orders.get(user)  // persistent instance IS a reference
// user has NO .id property. It's pure domain data.
```

`Persistent<T>` means "this entity is stored." That's it. No `.id`, no `.createdAt`, no system fields. Those are adapter concerns, stored internally via non-enumerable symbols.

**`Ref<T>` — the unified reference type.** Anything that points at an entity:

```typescript
type Ref<T> = Reference<T> | Persistent<T> | Lock<Persistent<T>>
```

Services accept `Ref<T>`. A persistent entity IS a valid ref — pass it directly:

```typescript
// Service accepts Ref<T> — works with references, entities, or locked entities
async transfer(from: Ref<Account>, to: Ref<Account>, amount: number) { ... }

// Callers:
await transfer(fromAccount, toAccount, 100)     // pass entities directly
await transfer(Account.ref`${id}`, toAccount, 100) // or a reference from string
```

Boundary code (controllers, processes) converts raw strings to refs with tagged templates: `User.ref\`${userId}\``. Domain code never sees strings.

If infrastructure truly needs a raw key (URLs, external APIs), the escape hatch is `Model.ref(entity).identifier` — deliberately awkward to signal you're leaving the domain.

### 3. You tell us what you need, we give you data in the right form

Traditional frameworks: "inject services, call methods, handle side effects."
JustScale: "declare what form of data your method needs. The caller provides it."

```typescript
class Order extends defineModel({
  fields: { amount: field.decimal(10, 2), status: field.enum('Status', ['pending', 'paid']) },
  inject: { payments: PaymentService },
}) {
  // I need a locked persistent order — safe to mutate
  async markPaid(this: Lock<Persistent<Order>>) {
    this.status = 'paid'  // Lock removes readonly
  }

  // I need either a new order or a locked one — both writable
  async applyDiscount(
    this: Transient<Order> | Lock<Persistent<Order>>,
    pct: number
  ) {
    this.amount *= (1 - pct / 100)
  }

  // I just need a stored order — read-only access
  async loadItems(this: Persistent<Order>) {
    return this.payments.getItemsFor(this)
  }

  // Works on anything
  validate() { return this.amount > 0 }
}
```

No hidden locking. No surprise side effects. The type signature IS the contract. If it compiles, the caller provided the right data in the right state.

**Type states:**
- `Transient<T>` — unsaved, writable (nobody else can see it)
- `Persistent<T>` — stored, readonly (others may be reading)
- `Lock<Persistent<T>>` — stored + locked, writable (safe to mutate)

### 4. Models are services

A model instance is not just data. It's an object whose prototype is a resolved service. When the framework boots, it resolves all injected dependencies and creates a "model service" — a singleton that becomes the prototype of every instance.

```
instance (own props: field data)
  -> modelService (injected deps, non-enumerable)
    -> ModelClass.prototype (methods from class body)
      -> BaseModel.prototype
```

This means `this.payments` on a model instance walks the prototype chain to the resolved service. All instances share the same service. Fields are own properties. Methods come from the class. Dependencies come from the prototype.

### 5. References replace relationships

You don't store foreign keys. You store references.

```typescript
class Post extends defineModel({
  fields: {
    title: field.string(),
    author: field.ref(User),  // Reference<User>, not a string ID
    tags: field.refs(Tag),    // References<Tag>, not string[]
  },
}) {}

const post = await posts.findOne(Post.fields.title.eq('Hello'))
const author = await post.author  // Reference is PromiseLike — just await it
const allTags = await post.tags   // Resolves all references
```

References are type-safe (`Reference<User>` can't be confused with `Reference<Order>`), memoized (same key = same object via WeakRef), and scoped to the current framework instance via async context.

### 6. Adapters own their concerns

The domain defines models. Adapters implement storage. The adapter decides:
- What the identification key looks like (UUID, auto-increment, composite)
- How to store system fields (createdAt, version, etc.)
- How to optimize queries (JOINs for same-adapter, delegation for cross-adapter)

```typescript
// Domain model — pure
class User extends defineModel({
  fields: { email: field.string(), name: field.string() },
}) {}

// PG adapter — owns storage details
const PgUser = createPgModel(User, { table: 'users' })
// PG decides: UUID for id, timestamps, version column

// In-memory adapter — for tests
const MemUser = createInMemoryModel(User)
// In-memory decides: random string for id, Date.now() for timestamps
```

Domain code never changes when you swap adapters.

### 7. Async context is the framework

The framework uses `AsyncLocalStorage` to track which instance you're in. This means:
- You can use `Model.ref(entity)` anywhere — in external library callbacks, setTimeout, wherever
- Multiple framework instances in one process are isolated (multi-tenancy)
- You don't need to "be inside the framework" explicitly — the async context is always there
- No global state, no passing context objects, no wrapper functions

### 8. Durable processes as plain code

Long-running processes (subscriptions, workflows, sagas) are written as plain TypeScript that the compiler transforms into resumable state machines.

```typescript
const orderFulfillment = createProcess({
  path: '/order/:orderId/fulfillment',
  inject: { signals: OrderSignals },

  async handler({ signals }, { orderId }) {
    const r = race()
    switch (true) {
      case signal(r, signals.paymentConfirmed):
        return { status: 'paid', txId: r.txId }
      case delay.days(r, 3):
        return { status: 'timeout' }
    }
  },
})
```

This compiles to an opcode-based state machine that persists its state to storage. It survives restarts, works across multiple instances, and scales to millions of concurrent processes. But the code reads like a simple switch statement.

### 9. The framework composes and reflects itself

Sub-systems are first-class. A `JustScale()` with `.requires(...)` is by definition a sub-app: it can't run alone; it must be composed into a parent that provides its requires. Features bundle services into a shared scope; sub-apps create their own scope with their own container, controllers, and models. Wrappers — HTTP prefixes, CLI namespaces, logger tags, metrics namespaces — are just sub-apps that require a service, rebind it in their scope, and contain a child.

```typescript
// Root app — no unsatisfied requires
JustScale()
  .add(env)
  .add(PostgresFeature)
  .add(HttpFeature)
  .add(httpPrefixed('/api/admin', AdminSubApp))
  .build()

// Sub-app — presence of requires makes it one
const AdminSubApp = JustScale()
  .requires(PostgresClientService)
  .requires(AbstractHttpServer)
  .add(AdminFeature)
  .add(OpenApiFeature)   // its own /docs, scoped to this sub-app
  .build()

// Wrapper — library sub-app that rebinds a service
export function httpPrefixed(prefix: string, child: SubApp): SubApp {
  return JustScale()
    .requires(AbstractHttpServer)
    .add(bindService(AbstractHttpServer, PrefixedHttpServer(prefix)))
    .add(child)
    .build()
}
```

Every scope exposes `AbstractContainer` — a queryable view of that scope's controllers, services, features, and bindings. Tools (OpenAPI, admin dashboards, permission auditors, HMR visualisers) inject `AbstractContainer` and pose questions; the container answers. Virtual and proxied entries — a remote contract, a hot-swapped service — appear the same as local ones. Nested scopes bind their own `AbstractContainer`; one introspection surface per scope, for free.

```typescript
class ApiDocService extends defineService({
  inject: { container: AbstractContainer },
  factory: ({ container }) => ({
    routes: () => [...container.controllers({ kind: 'http' })],
  }),
}) {}
```

Composition is the framework. Mounting a sub-app under a different prefix or moving it onto a different node is wiring, not code change. If you want to know what's there, you query it; if you want to add something, you go through the builder. No tool becomes privileged. No framework internals get exposed.

### 10. If it compiles, it works

The type system is not documentation. It's a contract enforcement mechanism. Every relationship between components is verified at compile time:
- Missing dependencies -> type error
- Wrong data form (need locked, got readonly) -> type error
- Impossible cross-adapter query -> detected at boot
- Wrong reference type -> type error

The goal: **zero runtime surprises that could have been caught statically.**

## What JustScale Is Not

- Not a micro-framework. It's opinionated and comprehensive — like Laravel for TypeScript, but with fundamentally different ideas.
- Not backwards-compatible with TypeORM/Prisma/etc. models. The mental model is different.
- Not trying to be everything to everyone. If you want raw SQL everywhere, use Drizzle. JustScale is for people who want to think in domain terms.
