/**
 * Helper for the standard "run only when invoked directly" entrypoint guard.
 *
 * Without this, importing a file that calls `main()` at module top level
 * causes side effects during `just`-style command discovery. The guard
 * checks whether the current file is the Node entrypoint (argv[1]) and
 * only runs the function if so.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Run `fn` only when the calling module is the Node entrypoint.
 *
 * Pass `import.meta` (or an equivalent `{ url }` object) so the helper can
 * compare the caller's file URL to `process.argv[1]`. When imported by
 * another module (e.g. during CLI command discovery), `fn` is skipped.
 *
 * Errors thrown by `fn` are re-thrown so the process exits non-zero via
 * Node's default unhandled-rejection behaviour.
 *
 * @example
 * ```typescript
 * import { defineMain } from '@justscale/core'
 *
 * defineMain(import.meta, async () => {
 *   const env = await loadEnvironment({ from: import.meta })
 *   const app = createApp(env)
 *   await app.serve({ http: 3000 })
 * })
 * ```
 */
export function defineMain(
  meta: ImportMeta | { url: string },
  fn: () => void | Promise<void>,
): void {
  const entrypointArg = process.argv[1];
  if (!entrypointArg) return;

  let metaPath: string;
  try {
    metaPath = fileURLToPath(meta.url);
  } catch {
    return;
  }

  // Compare realpaths — `fileURLToPath(import.meta.url)` returns the
  // canonical path, but `process.argv[1]` can be a symlinked path
  // (e.g. `/tmp` vs `/private/tmp` on macOS). Both paths may not exist
  // on disk (unit tests), so swallow ENOENT.
  let entrypointReal: string;
  try {
    entrypointReal = realpathSync(entrypointArg);
  } catch {
    entrypointReal = entrypointArg;
  }

  if (metaPath === entrypointArg || metaPath === entrypointReal) {
    // Re-throw from a timer so errors escape any surrounding promise chain
    // and trigger Node's uncaughtException handler → non-zero exit code.
    void (async () => {
      try {
        await fn();
      } catch (err) {
        setImmediate(() => { throw err; });
      }
    })();
  }
}
