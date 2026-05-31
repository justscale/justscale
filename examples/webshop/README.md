# Webshop Example

E-commerce backend demonstrating ORM and repository patterns:
- Product and order models
- Type-safe queries and relations
- PostgreSQL repository layer

## Run

```bash
# From monorepo root
pnpm install
pnpm build

# Run tests
cd examples/webshop
pnpm test
```

## Structure

```
src/
  models/       # Product, Order, Customer models
  services/     # Business logic (inventory, orders, pricing)
  controllers/  # API routes (if added)
  migrations/   # Database schema migrations
```

## What This Demonstrates

- Complex model relationships
- Repository pattern with type-safe queries
- Field expressions for filtering and sorting
- Transaction handling
- Migration workflow
