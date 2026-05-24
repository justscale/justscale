# URL Shortener

A tiny HTTP backend that shows the everyday shape of a JustScale app: a model, a
service, and a controller. No durable processes, no distributed-systems jargon -
just plain code. (For the durable side, see
[`order-fulfillment`](../order-fulfillment).)

## The service is the business logic

`defineService` gives you a plain object of methods over injected dependencies.
No transport, no SQL, no locking ceremony leaks in:

```ts
export class LinkService extends defineService({
  inject: { links: ModelRepository.of(Link) },
  factory: ({ links }) => ({
    async shorten(target: string) {
      const slug = Math.random().toString(36).slice(2, 8);
      return links.insert({ slug, target });
    },

    async resolve(slug: string) {
      const link = await links.findOne(Link.fields.slug.eq(slug));
      if (!link) return null;
      using locked = await links.lock(link);     // Locked<Link> | null
      if (locked) await links.update(locked, { hits: locked.hits + 1 });
      return link;
    },
  }),
}) {}
```

The compiler won't let you mutate without a `Locked<Link>`, and `lock()` is
typed as possibly-null - so the hit counter is safe under concurrent reads
whether the app runs on one instance or many. That's the whole point: plain
code, and it just scales.

## Layers

- `domains/link/link.model.ts` - pure domain model (`defineModel`), no storage details.
- `domains/link/link.service.ts` - the business logic, injecting the abstract repository.
- `infra/pg/link.pg.ts` - Postgres adapter; owns the table + indexes.
- `controllers/link.controller.ts` - the only file that knows about HTTP.
- `app.ts` - wires the concrete adapters together; the domain never imports it.

## Run

```sh
docker compose up -d        # Postgres on :5433 (from the repo root)
pnpm dev                    # http://localhost:3000
```

```sh
curl -X POST localhost:3000/shorten -d '{"url":"https://justscale.sh"}' -H 'content-type: application/json'
# { "slug": "ab12cd", "short": "/ab12cd" }
curl localhost:3000/ab12cd
# { "target": "https://justscale.sh", "hits": 1 }
```

`pnpm typecheck` runs the JustScale compiler over the source.
