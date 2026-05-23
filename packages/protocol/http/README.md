# @justscale/http

HTTP route factories for JustScale. Provides `Get`, `Post`, `Put`, `Patch`, `Delete`, `Head`, `Options` plus request-parsing middleware (`body`, `query`, `upload`, `pagination`).

## Install

```bash
pnpm add @justscale/http
```

## Usage

```ts
import { Get, Post, body } from '@justscale/http';
import { createController } from '@justscale/core';
import { z } from 'zod';

createController({
  inject: { users: UserService },
  routes: ({ users }) => ({
    listUsers: Get('/users')
      .returns(200, UserSchema)
      .handle(({ res }) => res.json(users.findAll())),

    createUser: Post('/users')
      .use(body(z.object({ email: z.string() })))
      .handle(({ body, res }) => res.json(users.create(body))),
  }),
});
```

The HTTP server binds to `HttpConfig.port` (default `6142`) and `HttpConfig.host` (default `0.0.0.0`). Routes participate in the DI graph — guards and middleware are typed through, and `AbstractContainer` reflection powers `@justscale/feature-openapi`.

## Features

- **Body parsing** — `body(schema)` middleware validates request bodies via Zod; 1 MB default limit
- **CORS** — opt-in allowlist, not enabled by default
- **Client-IP trust** — `X-Forwarded-For` gating configurable via `HttpConfig`
- **Upload** — `upload(field)` middleware for multipart file uploads
- **OpenAPI** — routes are introspectable; `@justscale/feature-openapi` generates specs automatically

## Docs

https://justscale.sh/techniques/openapi · https://justscale.sh/fundamentals/middleware
