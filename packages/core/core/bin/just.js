#!/usr/bin/env node
import { createRequire } from 'node:module';

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

// Await `main()` and drive an explicit exit code. Without this, if `main()`
// rejects under load, the process exits non-zero with no error message and
// any pending stdio may be lost — which manifested as flaky e2e tests that
// saw exitCode 1 despite correct help output reaching stdout. The explicit
// exit also closes lingering handles (readline, etc.) deterministically.
try {
  const { main } = await import('../dist/cli/bin/main.js');
  await main();
  process.exit(0);
} catch (err) {
  // Dump full diagnostic — the test harness captures stderr and this
  // makes intermittent failures debuggable in CI logs.
  console.error('[just] fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
}
