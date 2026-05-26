#!/usr/bin/env node
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Register tsx (if available in the user's project) so `just` can directly
// import TypeScript source — including .ts files referenced as .js, which
// Node's native type-stripping does not resolve. Without this, simple
// cases like `justscale.config.ts` → `./src/cli.mode.js` → `./app.js`
// chains fail with ERR_MODULE_NOT_FOUND.
try {
  const require = createRequire(`${process.cwd()}/`);
  const { register } = require('tsx/esm/api');
  register();
} catch {
  // tsx isn't installed in the user's project — Node still handles plain .ts
  // files via type stripping; .js→.ts rewriting just won't work. Users hit
  // that edge case get a clear ERR_MODULE_NOT_FOUND pointing at the missing
  // file, which is a decent nudge to install tsx or compile first.
}

// Resolve which CLI implementation to run. A globally-installed `just` should
// drive the PROJECT's pinned @justscale/core (the way the `nx` / `vite` global
// shims delegate to the local install) so the CLI behaviour always matches the
// framework version the project builds against — no global-vs-local drift.
//
// We walk up from cwd looking for a local install on disk rather than using
// module resolution, because core's `exports` map intentionally hides the CLI
// entry. Outside a project (e.g. `just init` in an empty dir, or a global-only
// setup) we fall back to the implementation bundled with this binary.
function findLocalCliMain(fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(
      dir, 'node_modules', '@justscale', 'core', 'dist', 'cli', 'bin', 'main.js',
    );
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const ownMain = fileURLToPath(new URL('../dist/cli/bin/main.js', import.meta.url));
const mainPath = findLocalCliMain(process.cwd()) ?? ownMain;

// Await `main()` and drive an explicit exit code. Without this, if `main()`
// rejects under load, the process exits non-zero with no error message and
// any pending stdio may be lost — which manifested as flaky e2e tests that
// saw exitCode 1 despite correct help output reaching stdout. The explicit
// exit also closes lingering handles (readline, etc.) deterministically.
try {
  const { main } = await import(pathToFileURL(mainPath).href);
  await main();
  process.exit(0);
} catch (err) {
  // Dump full diagnostic — the test harness captures stderr and this
  // makes intermittent failures debuggable in CI logs.
  console.error('[just] fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
}
