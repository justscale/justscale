# @justscale/typescript

Drop-in TypeScript replacement (`ptsc`, `ptscserver`) with two extensions your normal `tsc` can't do:

1. **Durable-process handler compilation** — handlers passed to `createProcess(...)` are rewritten into an opcode-driven shape that can be serialized at any suspension point, survive a restart, and resume mid-flight.
2. **TSPxxxx diagnostics** — process-specific errors (unhandled `await`, non-serializable `const`, unsupported control flow) surface as TS diagnostics with stable error codes.

Everything else behaves exactly like `tsc` / `tsserver`.

## Install

```bash
pnpm add -D @justscale/typescript typescript
```

`typescript` (>=6.0) is a peer dep — bring your own, `@justscale/typescript` wraps it.

## CLI

```bash
npx ptsc                     # compile using tsconfig.json
npx ptsc --noEmit            # type-check only
npx ptsc -w                  # watch
npx ptsc -b tsconfig.build.json
npx ptsc --init              # scaffold a tsconfig.json
```

Every `tsc` flag passes through. Also installed: `ptscserver` (tsserver equivalent), plus `justscale-tsc` / `justscale-tsserver` aliases.

## IDE

### VS Code

Point the TypeScript SDK at this package:

```json
// .vscode/settings.json
{ "typescript.tsdk": "node_modules/@justscale/typescript/lib" }
```

Full TypeScript IntelliSense plus JustScale diagnostics in the editor.

## tsconfig

A `justscale` section at the root of `tsconfig.json` configures the extensions:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true
  },
  "justscale": {
    "processFilePattern": "*.process.ts",
    "processModules": ["@justscale/core/process"],
    "strict": true,
    "verbose": false
  }
}
```

Defaults are almost always right; you only need the `justscale` section if you're customising the process-file convention or pointing at a non-standard process module.

## TSPxxxx diagnostics

Stable error codes for process-specific issues:

| Code | Meaning |
|-|-|
| TSP0001 | Missing `await` on a suspension point (`delay`, `signal`, `race`, ...) |
| TSP0002 | Variable captured incorrectly across a suspension point |
| TSP0003 | Invalid process handler signature |
| TSP0004 | Unsupported control flow in a process handler |
| TSP1001 | Awaited service call needs `using` instead of `const` so the value is re-fetched on resume |

TSP1001 in practice:

```ts
// fails — const captures the value; after a resume it's stale
const order = await orders.findById(orderId);

// works — using tells the runtime to re-hydrate on resume
using order = await orders.findById(orderId);
```

Full list: https://justscale.sh/docs/processes/compiler.

## Programmatic API

```ts
import { transpile, transpileProject } from '@justscale/typescript/api';

const result = transpile(source, 'example.process.ts');
if (result.success) console.log(result.code);

const project = transpileProject('./tsconfig.json');
for (const [file] of project.files) console.log('compiled:', file);
```

`createProcessTransformer(program, opts)` is also exported for wiring the transform into a custom `ts.createProgram` pipeline or ts-patch setup.

## Subpath exports

- `@justscale/typescript` — main programmatic API (`transpile`, `transpileProject`, `createProgram`, `createProcessTransformer`, `formatDiagnostics`).
- `@justscale/typescript/api` — the narrower `transpile*` surface if that's all you need.
- `@justscale/typescript/config` — config parsing (`parseConfig`, `findConfig`, `defaultConfig`).
- `@justscale/typescript/register` — Node `--import` hook; used by the monorepo's test runner (`node --import @justscale/typescript/register ...`) so tests see the same transform as production.
- `@justscale/typescript/loader` — lower-level loader primitives if you're building your own runtime.
- `@justscale/typescript/server` — embeddable `ptscserver` internals.
- `@justscale/typescript/editor` — editor-side helpers for refactors, quick fixes.

## How the process compilation works

The transformer walks each `createProcess(...)` handler AST:

1. **Analyses** suspension points (`delay`, `signal`, `race`, `for await`).
2. **Splits** the handler into synchronous blocks separated by suspension points.
3. **Generates opcodes** (WAIT, BLOCK, JUMP, RACE_START, ...) that the runtime executes.
4. **Tracks rehydration** for `using` declarations so the runtime knows what to re-fetch when resuming.
5. **Emits** a compiled process descriptor that replaces the handler at runtime.

The runtime pairs with `@justscale/core/process` to execute the opcodes, serialise state at any checkpoint, and resume from a saved state when a signal fires or a timer expires.

## Docs

https://justscale.sh/docs/processes/signals · https://justscale.sh/docs/processes/compiler · [VSCODE.md](./VSCODE.md) for detailed editor setup.
