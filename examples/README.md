# Examples

Runnable JustScale apps. Each is self-contained, wires real adapters (Postgres),
and reads like plain code.

| Example | What it shows |
|-|-|
| [url-shortener](./url-shortener) | The everyday shape: a model, a `defineService`, and an HTTP controller. Start here. |
| [order-fulfillment](./order-fulfillment) | Durable processes (advanced): a workflow as plain async code that survives restarts and resumes across instances. |

Each example has a `pnpm dev` (or `pnpm test`) script and a `pnpm typecheck`
that runs the JustScale compiler. Most need Postgres - `docker compose up -d`
from the repo root.
