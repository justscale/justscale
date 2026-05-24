---
name: justscale-concepts
description: JustScale orientation skill — what the framework is for, the four core principles (durable processes, ID-free domain, type-states, distributed-first), the canonical project layout (domain/infra/app), and where things go. Load when starting work on a JustScale codebase, when the user asks "what is JustScale", "where does X go", "how is this structured", or before generating non-trivial framework code.
---

# Skill: justscale-concepts

Orientation. Loads what the framework is for, the principles that
constrain its API, and the canonical project layout — so subsequent code
generation matches the framework's grain instead of fighting it.

The full philosophy lives at `CORE_PHILOSOPHY.md` in the repo root. The
canonical example project is `examples/order-fulfillment/` in the
JustScale repo (github.com/justscale/justscale). When in doubt, read
those — this skill is a fast load for what's already there.

## What JustScale is

A TypeScript backend framework where **domain code describes what
happens, not how**. Infrastructure (databases, persistence across
restarts, coordination across nodes) is removed from the surface area
you write. The code reads like a description of the workflow.

The litmus test: the silly t-shirt pseudocode (`while alive: if not
coffee: get_coffee(); work()`) is readable because it states intent, not
plumbing. JustScale's goal is to make that real — a poker hand, a
subscription, an order fulfillment reads as the sequence of what happens,
and the framework supplies the persistence, locking, and cross-node
routing underneath. **Write a single-server backend. It just scales a
cluster.**

## The four principles

### 1. Domain code describes WHAT, never HOW

A subscription that charges monthly until cancelled looks like a `while`
loop with a monthly timer:

```typescript
const subscription = createProcess({
  path: '/subscription/:user',
  types: { user: User },
  inject: { billing: BillingService, notifications: NotificationService },

  async handler({ billing, notifications }, { user }) {
    while (true) {
      const r = race();
      switch (true) {
        case delay.days(r, 30):
          await billing.charge(user);
          await notifications.send(user, 'Payment processed');
          continue;
        case signal(r, billing.cancellation):
          return { status: 'cancelled' as const };
      }
    }
  },
});
```

The compiler turns this into an opcode-based state machine that survives
restarts and routes signals across nodes. You don't see that.

### 2. IDs do not exist in domain code

Domain methods take `Ref<T>`, `Persistent<T>`, or `Locked<T>`. A
persistent entity IS its own reference.

```typescript
// Domain: pass entities directly
await transfer(fromAccount, toAccount, amount);

// Boundary: strings become typed refs
const user = User.ref(userId);
```

`defineModel` blocks NEVER include `id`, `createdAt`, or `updatedAt` —
those are adapter concerns, stored via non-enumerable symbols.

Inter-entity links are typed refs, not foreign keys:

```typescript
export class Order extends defineModel({
  fields: {
    customer: field.ref(User),
    total: field.decimal(10, 2),
  },
  permissions: ({ customer }) => ({
    view:          permit(User).when(customer),
    requestReturn: permit(User).when(customer),
  }),
}) {}
```

Permissions live with the model. `permit(User).when(customer)` reads as
"a User can view this Order when they are its `customer`".

### 3. Type-states as compile-time contracts

A method that mutates says so in its signature:

```typescript
async addLine(
  cart: Locked<Cart>,
  product: Ref<Product>,
  quantity: number,
): Promise<Persistent<CartLine>> { /* ... */ }

async removeLine(cart: Locked<Cart>, line: Locked<CartLine>): Promise<void> {
  using stock = await inventory.lockFor(line.product);
  await inventory.release(stock, line.quantity);
}
```

`Locked<T>` is the only thing `repo.update`/`save`/`delete` accepts. The
only way to obtain one is `using x = await repo.lock(ref)`, which is
atomic with the read under `SELECT ... FOR UPDATE`. Stale-write bugs
are structurally impossible.

### 4. Distributed-first by default

Channels, locks, signals, and durable processes are framework primitives —
not transport helpers. The same domain code that runs against an
in-memory lock locally runs correctly against Postgres advisory locks
across 20 nodes, unchanged. Four mechanical rules close the loop:

- Every mutating repository method requires `Locked<T>`.
- `repo.lock()` is atomic with the read.
- `Locked<T>` cannot cross process boundaries (the serializer refuses).
- Signals carry routable identity. Every signal path param goes through
  `.types({...})`.

## More principles (the rest of CORE_PHILOSOPHY.md)

- **Models are services.** A model instance's prototype IS a resolved
  service. `this.payments` on an instance walks the prototype chain to
  the injected, framework-resolved singleton. Fields are own properties;
  methods come from the class; dependencies come from the prototype.
- **References replace relationships.** `field.ref(User)` stores a
  `Reference<User>`, not a string FK. A reference is `PromiseLike` —
  `await post.author` resolves it. Type-safe and memoized (same key =
  same object via WeakRef).
- **Adapters own their concerns.** The domain defines models; the
  adapter decides the key shape (UUID/serial/composite), how system
  fields are stored, and how queries optimize. Swapping Postgres for
  in-memory changes zero domain code.
- **Async context is the framework.** `AsyncLocalStorage` tracks which
  instance you're in, so `Model.ref(...)` works in any callback and
  multiple framework instances stay isolated in one process. Never
  module-level mutable state.
- **The framework composes and reflects itself.** A `JustScale()` with
  `.requires(...)` IS a sub-app. Wrappers (HTTP prefixes, CLI
  namespaces) are sub-apps that rebind a service. Every scope exposes
  `AbstractContainer` — a queryable view tools inject to ask what's
  there. Mounting a sub-app elsewhere is wiring, not a code change.
- **If it compiles, it works.** The type system is contract enforcement,
  not documentation. Missing dep, wrong data-form (need locked, got
  readonly), impossible cross-adapter query, wrong ref type — all caught
  before runtime.

## The canonical project layout

Look at `examples/order-fulfillment/`. Each domain owns its own folder;
infra is separate; app composes them.

```
src/
├── app.ts                 ← composes everything via JustScale().add(...)
├── controllers/           ← HTTP/protocol surface (status codes, auth, serialization)
├── domains/
│   ├── order/
│   │   ├── order.model.ts        ← defineModel + permissions
│   │   ├── order.service.ts      ← defineService — mutators take Locked<T>
│   │   ├── order.feature.ts      ← createFeature — bundles the domain
│   │   └── order.cli.ts          ← Cli('order ...') routes
│   └── cart/
│       ├── cart.model.ts
│       ├── cart.service.ts
│       ├── cart.signals.ts        ← defineSignals
│       ├── cart-lifecycle.process.ts  ← createProcess
│       ├── cart.feature.ts
│       └── cart.cli.ts
└── infra/
    └── pg/                ← createPgModel + createPgRepository per model
```

Conventions:

- **`<domain>.model.ts`** — `defineModel` with fields, refs, and a
  `permissions` block.
- **`<domain>.service.ts`** — `defineService`. Mutators take `Locked<T>`.
- **`<domain>.signals.ts`** — `defineSignals`. Path params get `.types`.
- **`<domain>-<verb>.process.ts`** — `createProcess`.
- **`<domain>.feature.ts`** — `createFeature` bundling model, service,
  signals, processes, CLI. `app.ts` imports the feature.
- **`<domain>.cli.ts`** — `Cli('<verb>')` routes live in the domain
  folder. CLI is domain logic; HTTP is presentation.
- **`infra/pg/<model>.pg.ts`** — adapter bindings. Domain code does NOT
  import from `infra/`. Only `app.ts` does.

## Where things go

| Question | Answer |
|-|-|
| New domain entity? | `src/domains/<domain>/<entity>.model.ts` |
| Domain logic? | `src/domains/<domain>/<domain>.service.ts` |
| CLI command? | `src/domains/<domain>/<domain>.cli.ts` (NOT `controllers/`) |
| HTTP controller? | `src/controllers/<group>/...` |
| Durable workflow? | `src/domains/<domain>/<verb>.process.ts` |
| Storage details? | `src/infra/pg/...` |
| Migration? | Generated by `just migrate make` — never hand-author |

## Companion skills

When generating framework code, prefer the dedicated skills:

- `/justscale-new-process` — durable process with the rules baked in.
- `/justscale-audit-domain-purity` — static check before commit.
- `/justscale-multi-instance-test` — distributed e2e test scaffold (real
  `child_process.spawn` workers, not two builders in one process).

## When to load

- Starting a session on a JustScale codebase.
- The user asks "what is JustScale", "where does X go", "how should I
  structure this", or "why does the framework do Y".
- Before generating any non-trivial framework code (model, service,
  process, controller). The principles prevent drift.
