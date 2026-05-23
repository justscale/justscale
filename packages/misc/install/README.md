# create-justscale

Project scaffolder for `pnpm create justscale` / `npm create justscale@latest` / `yarn create justscale`. Interactive prompt, detects your environment (OS, package manager, installed IDEs, AI tools, git hosting), then writes a minimal JustScale app with matching IDE + CI config.

Not a package you import — it's a CLI. Run it to bootstrap a new project.

## Usage

```bash
pnpm create justscale
# or
npm create justscale@latest
# or
yarn create justscale
```

You can also invoke it directly:

```bash
pnpm dlx create-justscale
```

The CLI asks for a project name (default: current directory name). If the name matches the current directory, it scaffolds in place; otherwise it creates a subdirectory. It refuses to run in a directory that already has a `package.json` — use `just init` for that case.

## What gets generated

Always:

- `package.json` with `@justscale/core` and `@justscale/typescript` pinned
- `tsconfig.json` (NodeNext, ES2022, strict)
- `justscale.config.ts` with `defineProject` and `serve` / `cli` mode entries
- `src/app.ts`, `src/serve.ts`, `src/cli.ts` stubs
- `.gitignore`

Based on detected environment:

- JetBrains IDE (WebStorm / IntelliJ): `.idea/typescript.xml` pointing at `@justscale/typescript`'s tsserver, plus `just dev` / `just build` / `just test` run configurations.
- VS Code / Cursor: `.vscode/settings.json` with `typescript.tsdk` pointed at the workspace JustScale TypeScript, plus a `launch.json` for `just dev`.
- Claude CLI on PATH: `.claude/settings.json` wiring the JustScale MCP server (`just mcp serve`) and a starter `CLAUDE.md`.
- GitHub remote: `.github/workflows/ci.yml` matching the detected package manager.
- GitLab remote: `.gitlab-ci.yml` equivalent.

After scaffolding, the CLI runs `<pm> install`, initialises git, and optionally opens your detected editor / Claude session.

## Detection

Detection is best-effort and purely read-only:

- **OS / arch** from `process.platform`
- **Package manager** via `which pnpm` / `yarn` (falls back to `npm`)
- **IDEs** by scanning app locations on macOS/Linux plus `code` / `cursor` on PATH
- **AI tools** by `claude` / `cursor` on PATH
- **Git hosting** from `.git/config` (github.com, gitlab.com)

No network calls, no telemetry.

## Starter app shape

The generated `app.ts` is intentionally empty — a `JustScale()` builder with comments showing where to `.add(...)` services / features:

```ts
import JustScale from '@justscale/core'

export const app = JustScale()
  // Add services, features, and adapters here
  // .add(PostgresClient)
  // .add(AuthFeature)
```

`serve.ts` and `cli.ts` each `.build()` it for their respective modes; `justscale.config.ts` wires the modes together. From there you follow the docs to add controllers, features, and an adapter.

## Next steps

```bash
cd your-project-name
just dev                 # boots the app
just install <plugin>    # installs and wires a JustScale plugin
```

## Docs

https://justscale.sh/overview/quick-start
