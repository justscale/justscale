# @justscale/auth

User + Session models, password hashing, email verification, 2FA (TOTP), password reset, plus ready-made HTTP endpoints for all of it. Ships as two features so you can take the services without the endpoints if you're building your own surface.

Storage-agnostic: the feature declares `ModelRepository.of(User)` / `ModelRepository.of(Session)` requirements and the app binds them to whatever adapter it uses (Postgres, in-memory for tests, etc.).

## Install

```bash
pnpm add @justscale/auth
```

Peers: `@justscale/core`, `@justscale/http`, `zod`.

## Usage

```ts
import JustScale, { bindService, bindRepository } from '@justscale/core';
import { ModelRepository } from '@justscale/core/models';
import { PostgresClientService, createPgModel, createPgRepository } from '@justscale/postgres';
import {
  AuthFeature,
  AuthEndpointsFeature,
  User,
  Session,
  AbstractEmailSender,
  ConsoleEmailSender,
} from '@justscale/auth';

const PgUser = createPgModel(User, { table: 'users' });
const PgSession = createPgModel(Session, { table: 'sessions' });
const UserRepository = createPgRepository(PgUser);
const SessionRepository = createPgRepository(PgSession);

const app = JustScale()
  .add(PostgresClientService)
  .add(UserRepository)
  .add(SessionRepository)
  .add(bindRepository(ModelRepository.of(User), UserRepository))
  .add(bindRepository(ModelRepository.of(Session), SessionRepository))
  .add(bindService(AbstractEmailSender, ConsoleEmailSender))
  .add(AuthFeature)
  .add(AuthEndpointsFeature)
  .build();
```

`AuthFeature` provides the services. `AuthEndpointsFeature` adds the REST controllers. Use both if you want the framework's default surface; use only `AuthFeature` if you're wiring your own controllers around the services.

## Endpoints

`AuthEndpointsFeature` mounts three controllers:

- `AuthController` — `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/change-password`
- `TwoFactorController` — `GET /auth/2fa/status`, `POST /auth/2fa/setup`, `POST /auth/2fa/verify`, `DELETE /auth/2fa`
- `PasswordController` — `POST /auth/forgot-password`, `POST /auth/reset-password`

Request and response shapes are exported as zod schemas (`RegisterBody`, `LoginBody`, `AuthResponse`, etc.) — use them to type your client or to drive OpenAPI / RPC generation.

## Services (when you skip the endpoints)

- `UserService` — `register`, `authenticate`, `findByEmail`, `changePassword`. Throws `UserExistsError` / `InvalidCredentialsError`.
- `SessionService` — create/revoke sessions; the auth middleware reads and refreshes them.
- `PasswordService` — hash / verify; uses a modern KDF under the hood.
- `TwoFactorService` — TOTP setup, verification, disable.
- `NotificationService` — wraps `AbstractEmailSender` for verification + reset emails.
- `AuthSignals` — the signal set used by signup / 2FA / password-reset durable processes.

## Middleware + guards

```ts
import { auth, requireAuth, requireVerifiedEmail } from '@justscale/auth';

Get('/profile')
  .use(auth)                  // attaches `ctx.user` if a session cookie is present
  .guard(requireAuth)         // rejects anonymous requests
  .guard(requireVerifiedEmail)
  .handle(ctx => ctx.res.json({ user: ctx.user }));
```

`auth` is lenient (populates `ctx.user` when it can), `optionalAuth` is the alias; the guards are the enforcement layer. `requireSelf` compares a route param reference to `ctx.user` and rejects mismatches.

## Email sending

`AbstractEmailSender` is an abstract DI token. Bind a concrete sender (your SMTP wrapper, Postmark, SES client). `ConsoleEmailSender` is shipped for local development — it prints emails to stdout instead of sending them.

## Models

- `User` — email + password hash + optional name + `emailVerifiedAt` + TOTP fields. Register with `createPgModel(User, { table: 'users' })` or any other repository binding.
- `Session` — rotating session tokens; keyed by the user reference.

Both are `defineModel` classes, so they integrate with the rest of the JustScale model layer (queries, repositories, references).

## Durable processes

Signup (with email verification), password reset, and 2FA setup / verification are implemented as durable processes via `@justscale/core/process`. They survive restarts — if a user confirms their email an hour after signup, the verification process resumes and completes the signup. The app must provide `AbstractProcessExecutor` (e.g. via `PostgresProcessFeature`).

## CLI

Installing this package contributes subcommands to `just` via `justscale.modes.cli` in `package.json`. The `just` binary's `assembleCliApp()` walks the project's `dependencies`/`devDependencies`, imports each dependency's CLI module, and registers any discovered controllers against the user's DI container, so these commands share services and repositories with the rest of the app:

```bash
just user add --email admin@example.com     # create a user (prompts for password)
just user list                              # list registered users
just session list                           # list active sessions
just session revoke --email admin@example.com
```

See `src/cli.ts` for the command definitions.

## Testing

`@justscale/auth/testing` exports helpers for test apps — mock principals, password hashing without the full KDF cost, and a factory for creating sessions in isolation.

## Docs

https://justscale.sh/docs/features/auth
