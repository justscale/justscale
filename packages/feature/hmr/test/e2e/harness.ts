/**
 * HMR e2e harness — spawns a fixture app as a real child process with
 * the HMR loader wired in, exposes helpers to make HTTP calls and edit
 * files.
 *
 * Each `startFixture()` call copies the fixture source (src/, env/,
 * package.json, tsconfig.json) to a fresh temp directory and points a
 * `node_modules` symlink back at the original, so pnpm's dependency
 * layout still resolves. All edits happen against the COPY, never the
 * checked-in fixture, so a crashed test can never leave the repo
 * dirty. On teardown the temp dir is removed.
 *
 * The child's stdout+stderr is parsed for `[http] listening on ...`
 * (readiness) and `[hmr] applied` / `[hmr] rebuild complete` (edit
 * roundtrip). Each test picks a free port up front to avoid races.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface HarnessHandle {
  readonly port: number
  readonly workDir: string
  fetch(path: string, init?: RequestInit): Promise<Response>
  json<T = unknown>(path: string, init?: RequestInit): Promise<T>
  /** Overwrite a fixture file (in the working copy) and wait for HMR to apply. */
  edit(relPath: string, transform: (source: string) => string): Promise<void>
  /** Raw string log output captured from the child so far. */
  readonly logs: string[]
  shutdown(): Promise<void>
}

export interface StartOptions {
  /** Source fixture — read-only. The harness works on a temp copy. */
  fixtureDir: string
  /** Additional env vars to pass to the child. */
  env?: Record<string, string>
  /** Max ms to wait for "[http] listening" before failing. */
  readyTimeoutMs?: number
  /** Max ms to wait for an "[hmr] applied" log after an edit. */
  hmrTimeoutMs?: number
}

export async function startFixture(options: StartOptions): Promise<HarnessHandle> {
  const port = await getFreePort();
  // Generous startup/reload budgets: on a loaded CI runner (e.g. the publish
  // job building every package in parallel) spinning up the dev-server fixture
  // and recompiling on edit intermittently took >10s, flaking the whole suite
  // with "fixture failed to start within 10000ms". These are upper bounds for
  // a genuinely-stuck fixture, not the expected time, so larger is safe.
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000;
  const hmrTimeoutMs = options.hmrTimeoutMs ?? 30_000;

  // Fresh temp copy per invocation. Edits never touch the original.
  const workDir = createFixtureCopy(options.fixtureDir);

  // Same app root → same cluster socket path across runs. If a prior
  // fixture crashed the file can linger; unlink it so the new child
  // doesn't hit EADDRINUSE on the cluster server's bind. (The work
  // dir is unique per run, so this is mostly belt-and-braces.)
  await removeStaleSocket(workDir);

  const child = spawn(
    process.execPath,
    [
      '--import', '@justscale/typescript/register',
      '--import', 'tsx',
      '--import', '@justscale/hmr/register',
      'src/app.ts',
    ],
    {
      cwd: workDir,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        JUSTSCALE_ENV: 'test',
        PORT: String(port),
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const logs: string[] = [];
  const readyWaiters = new Set<() => void>();
  const hmrWaiters = new Set<() => void>();

  const onLine = (line: string) => {
    logs.push(line);
    if (line.includes('[http] listening')) {
      for (const fn of readyWaiters) fn();
    }
    // "rebuild failed" also wakes waiters: a validation error in the
    // new build is a legitimate terminal state for the edit cycle
    // (the live app is untouched; tests asserting on the failure
    // shouldn't time out waiting for a "complete" that never comes).
    //
    // Match by substring rather than anchored prefix — the logger may
    // inject severity tags like `[hmr] error: rebuild failed ...`
    // between the prefix and the event name.
    if (
      line.includes('[hmr] applied') ||
      line.includes('rebuild complete') ||
      line.includes('rebuild failed')
    ) {
      for (const fn of hmrWaiters) fn();
    }
  };
  pipeLines(child.stdout!, onLine);
  pipeLines(child.stderr!, onLine);

  const exitPromise = new Promise<void>((resolve) => child.once('exit', () => resolve()));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(
        `fixture failed to start within ${readyTimeoutMs}ms. Logs:\n${logs.join('\n')}`,
      ));
    }, readyTimeoutMs);
    const ok = () => {
      clearTimeout(timer);
      readyWaiters.delete(ok);
      resolve();
    };
    readyWaiters.add(ok);
  });

  const edit: HarnessHandle['edit'] = async (relPath, transform) => {
    const path = join(workDir, relPath);
    const original = await (await import('node:fs/promises')).readFile(path, 'utf8');
    const next = transform(original);
    if (next === original) {
      throw new Error(`edit(${relPath}): transform produced no changes`);
    }
    const waitHmr = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        hmrWaiters.delete(ok);
        reject(new Error(
          `timed out (${hmrTimeoutMs}ms) waiting for HMR to apply edit to ${relPath}. Logs:\n${logs.slice(-30).join('\n')}`,
        ));
      }, hmrTimeoutMs);
      const ok = () => {
        clearTimeout(timer);
        hmrWaiters.delete(ok);
        resolve();
      };
      hmrWaiters.add(ok);
    });
    await writeFile(path, next, 'utf8');
    await waitHmr;
    // Small grace period so the swapped module is fully live when
    // the caller sends the next HTTP request.
    await sleep(50);
  };

  const fetchFn: HarnessHandle['fetch'] = (path, init) =>
    fetch(`http://127.0.0.1:${port}${path}`, init);

  const json: HarnessHandle['json'] = async (path, init) => {
    const res = await fetchFn(path, init);
    if (!res.ok) {
      throw new Error(`GET ${path} → ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as never;
  };

  const shutdown = async () => {
    if (!child.killed && child.exitCode === null) {
      child.kill('SIGTERM');
      const killed = await Promise.race([
        exitPromise.then(() => true),
        sleep(2_000).then(() => false),
      ]);
      if (!killed && !child.killed) child.kill('SIGKILL');
    }
    await exitPromise;
    // Drop the temp copy. Safe to rm -rf: the workDir is under $TMPDIR
    // and was created by this harness for this run specifically.
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Best-effort — OS will eventually reap temp anyway.
    }
  };

  return {
    port,
    workDir,
    fetch: fetchFn,
    json,
    edit,
    logs,
    shutdown,
  };
}

/**
 * Copy the fixture's source files (src/, env/, package.json,
 * tsconfig.json) into a fresh temp directory and symlink
 * `node_modules` back at the original so pnpm's dependency graph
 * still resolves. We skip copying `node_modules` itself because it's
 * huge and contains symlinks; a single top-level symlink back at the
 * source is enough for Node's resolver to walk into the real tree.
 */
function createFixtureCopy(source: string): string {
  const workDir = join(tmpdir(), `justscale-hmr-${randomBytes(6).toString('hex')}`);
  const copy = ['src', 'env', 'package.json', 'tsconfig.json'];
  for (const entry of copy) {
    const from = join(source, entry);
    if (!existsSync(from)) continue;
    cpSync(from, join(workDir, entry), { recursive: true });
  }
  const nmSrc = join(source, 'node_modules');
  if (existsSync(nmSrc)) {
    symlinkSync(nmSrc, join(workDir, 'node_modules'), 'dir');
  }
  return workDir;
}

function pipeLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line) onLine(line);
    }
  });
  stream.on('end', () => {
    if (buf) onLine(buf);
  });
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Mirror of `@justscale/core`'s `getSocketPath(appRoot)` so we can
 * remove a stale UNIX socket from a previous crashed run without
 * depending on internal symbols. Sha-256(appRoot)[0..12] →
 * `<tmp>/justscale/app-<hash>.sock`.
 */
async function removeStaleSocket(appRoot: string): Promise<void> {
  const hash = createHash('sha256').update(appRoot).digest('hex').slice(0, 12);
  const path = join(tmpdir(), 'justscale', `app-${hash}.sock`);
  try {
    await unlink(path);
  } catch {
    // Not there — fine.
  }
}
