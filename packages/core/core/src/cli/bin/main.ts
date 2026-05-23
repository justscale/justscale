/**
 * just CLI entry point
 *
 * Dispatches in two modes depending on the command:
 *
 * - Built-in commands (build, run, test, init, install, dev, mcp serve)
 *   execute in an isolated app with only `WorkspaceController`. They don't
 *   depend on any user-provided service, so we skip the cost of discovering
 *   and building the user's `justscale.config.ts` app entry.
 *
 * - Everything else (user-defined CLI commands, package-contributed CLI
 *   controllers, --help) loads the user's `app` entry (picked by env.type),
 *   appends the built-in controllers plus any CLI controllers discovered
 *   on installed packages via `justscale.modes.cli`, calls `.build()`, and
 *   runs the resulting app. That gives every controller access to the
 *   *same* DI container, so e.g. `@justscale/auth`'s `AuthCliController`
 *   can inject the user's `ModelRepository.of(User)` and `UserService`.
 *
 * Usage:
 *   just <command> [args]
 *   just --socket /path <command>
 *   just --env <name> <command>
 *   just --local
 */

import { createInterface } from 'node:readline';
import { assembleCliApp } from '../assemble.js';

// ============================================================================
// Types
// ============================================================================

interface GlobalFlags {
  socketPath?: string
  env?: string
  forceLocal: boolean
  help: boolean
  remaining: string[]
}

/**
 * Root commands that `WorkspaceController` owns. These execute without ever
 * bootstrapping the user's app, so `just build` works the same whether the
 * user's DI graph is complete or not.
 *
 * `--env=<name>` on a built-in sets JUSTSCALE_ENV for child processes (ptsc,
 * turbo, tsx, …) but never triggers remote-host dispatch.
 */
const BUILTIN_COMMANDS = new Set(['build', 'run', 'test', 'init', 'install', 'dev', 'mcp']);

// ============================================================================
// Unified CLI Runner
// ============================================================================

async function runCli(argv: string[]): Promise<void> {
  const { run } = await import('../runner.js');
  const { WorkspaceController, installShellCompletion } = await import('../workspace-controller.js');
  const { createAppInternal } = await import('../../app.js');

  const command = argv[0];

  // Idempotent shell-completion install — fires on ANY `just ...`
  // invocation except the `__complete` tab-callback itself (which
  // would recurse). Silent no-op when already installed, when the
  // shell isn't supported, when we're not in a dev-mode invocation,
  // or when JUSTSCALE_NO_COMPLETION_INSTALL=1 is set. The
  // per-directory command set flows naturally because `just __complete`
  // loads the full merged app from the cwd — the inlined shell
  // snippet is identical everywhere, candidates are project-local.
  if (command !== '__complete') {
    const notice = installShellCompletion();
    if (notice) process.stderr.write(`${notice}\n`);
  }

  // Fast path: built-in commands skip user-app discovery entirely.
  if (command && BUILTIN_COMMANDS.has(command)) {
    const app = createAppInternal({ controllers: [WorkspaceController] });
    await app.ready;
    await run(app, { argv, exitOnError: true, name: 'just' });
    return;
  }

  // Everything else — user CLI commands, package CLI commands, --help — runs
  // against the full merged app so DI resolves correctly across all sources.
  const app = await assembleCliApp();
  await run(app, { argv, exitOnError: true, name: 'just' });
}

// ============================================================================
// Remote Mode (Socket Connection)
// ============================================================================

/**
 * Run a command via socket connection to running cluster.
 */
async function runRemote(argv: string[], socketPath?: string): Promise<void> {
  const { connectToCluster } = await import('@justscale/core/cluster');

  const client = await connectToCluster({ socketPath });

  try {
    const commands = await client.listCommands();

    // Handle help
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
      showRemoteHelp(commands);
      await client.disconnect();
      return;
    }

    // Match command
    let matchedCommand: string | null = null;
    let argStartIdx = 0;

    for (let i = argv.length; i > 0; i--) {
      const candidate = argv.slice(0, i).join(' ');
      if (commands.includes(candidate)) {
        matchedCommand = candidate;
        argStartIdx = i;
        break;
      }
    }

    if (!matchedCommand) {
      console.error(`Unknown command: ${argv.join(' ')}`);
      console.error('\nAvailable commands:');
      for (const cmd of commands) {
        console.error(`  ${cmd}`);
      }
      process.exit(1);
    }

    // Parse remaining args
    const args = parseCommandArgs(argv.slice(argStartIdx));

    // Create prompt handler
    const promptHandler = createTerminalPromptHandler();

    // Invoke
    const result = await client.invoke(matchedCommand, args, {
      onStdout: (data) => process.stdout.write(`${data}\n`),
      onStderr: (data) => process.stderr.write(`${data}\n`),
      onPrompt: promptHandler,
    });

    if (result !== undefined) {
      if (typeof result === 'object') {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(result);
      }
    }

    await client.disconnect();
  } catch (error) {
    await client.disconnect().catch(() => {});
    throw error;
  }
}

function showRemoteHelp(commands: string[]): void {
  console.log('Usage: just <command> [options]');
  console.log('');
  console.log('Connected to running cluster.');
  console.log('');
  console.log('Commands:');
  for (const cmd of commands) {
    console.log(`  ${cmd}`);
  }
}

// ============================================================================
// Argument Parsing
// ============================================================================

function parseGlobalFlags(argv: string[]): GlobalFlags {
  const remaining: string[] = [];
  let socketPath: string | undefined;
  let env: string | undefined;
  let forceLocal = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--socket' && argv[i + 1]) {
      socketPath = argv[++i];
    } else if (argv[i].startsWith('--socket=')) {
      socketPath = argv[i].slice(9);
    } else if (argv[i] === '--env' && argv[i + 1]) {
      // Purely global. We set `process.env.JUSTSCALE_ENV` below, and
      // command handlers that need the name read from there. Keeping
      // `--env` out of `remaining` means `just --env=dev log level`
      // resolves `log level` as the command (argv[0]) instead of
      // hitting the flag as a bogus command name.
      env = argv[++i];
    } else if (argv[i].startsWith('--env=')) {
      env = argv[i].slice(6);
    } else if (argv[i] === '--local') {
      forceLocal = true;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      help = true;
      remaining.push(argv[i]);
    } else {
      remaining.push(argv[i]);
    }
  }

  return { socketPath, env, forceLocal, remaining, help };
}

function parseCommandArgs(argv: string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx);
        const value = arg.slice(eqIdx + 1);
        args[key] = parseValue(value);
      } else if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
        const key = arg.slice(2);
        args[key] = parseValue(argv[++i]);
      } else {
        const key = arg.slice(2);
        args[key] = true;
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const key = arg.slice(1);
      if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
        args[key] = parseValue(argv[++i]);
      } else {
        args[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }

  positional.forEach((val, idx) => {
    args[idx.toString()] = val;
  });

  return args;
}

function parseValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  const num = Number(value);
  if (!Number.isNaN(num) && value.trim() !== '') return num;
  return value;
}

// ============================================================================
// Terminal Input
// ============================================================================

let sharedReadline: ReturnType<typeof createInterface> | null = null;

function getReadline(): ReturnType<typeof createInterface> {
  if (!sharedReadline && process.stdin.isTTY) {
    sharedReadline = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
  }
  return sharedReadline!;
}

function closeReadline(): void {
  if (sharedReadline) {
    sharedReadline.close();
    sharedReadline = null;
  }
}

async function readLine(prompt: string): Promise<string> {
  process.stdout.write(prompt);

  if (process.stdin.isTTY) {
    const rl = getReadline();
    return new Promise((resolve) => {
      rl.question('', (answer) => {
        resolve(answer);
      });
    });
  }

  return '';
}

type PromptType = 'text' | 'password' | 'confirm' | 'select';
type PromptResult = string | boolean | null;
type PromptHandler = (
  type: PromptType,
  message: string,
  options?: {
    defaultValue?: string
    choices?: Array<{ label: string; value: unknown }>
  },
) => Promise<PromptResult>;

function createTerminalPromptHandler(): PromptHandler {
  return async (type, message, options) => {
    switch (type) {
      case 'text': {
        const prompt = options?.defaultValue
          ? `${message} [${options.defaultValue}]: `
          : `${message}: `;
        const answer = await readLine(prompt);
        return answer || options?.defaultValue || '';
      }

      case 'password': {
        if (!process.stdin.isTTY) {
          return await readLine(`${message}: `);
        }
        const rl = getReadline();
        rl.pause();
        return new Promise((resolve) => {
          process.stdout.write(`${message}: `);
          process.stdin.setRawMode(true);
          process.stdin.resume();

          let password = '';
          const onData = (char: Buffer) => {
            const c = char.toString();
            if (c === '\n' || c === '\r') {
              process.stdin.removeListener('data', onData);
              process.stdin.setRawMode(false);
              process.stdout.write('\n');
              rl.resume();
              resolve(password);
            } else if (c === '\u0003') {
              process.stdin.removeListener('data', onData);
              process.stdin.setRawMode(false);
              process.stdout.write('\n');
              rl.resume();
              resolve('');
            } else if (c === '\u007F' || c === '\b') {
              if (password.length > 0) {
                password = password.slice(0, -1);
              }
            } else {
              password += c;
            }
          };
          process.stdin.on('data', onData);
        });
      }

      case 'confirm': {
        const answer = await readLine(`${message} (y/n): `);
        const normalized = answer.toLowerCase().trim();
        return normalized === 'y' || normalized === 'yes';
      }

      case 'select': {
        if (!options?.choices || options.choices.length === 0) {
          throw new Error('Select requires choices');
        }
        console.log(message);
        options.choices.forEach((choice, idx) => {
          console.log(`  ${idx + 1}. ${choice.label}`);
        });
        const answer = await readLine('Enter number: ');
        const idx = Number.parseInt(answer, 10) - 1;
        if (idx >= 0 && idx < options.choices.length) {
          return String(options.choices[idx].value);
        }
        return String(options.choices[0].value);
      }

      default:
        throw new Error(`Unknown prompt type: ${type}`);
    }
  };
}

// ============================================================================
// Main
// ============================================================================

export async function main() {
  const { socketPath, env, forceLocal, remaining } = parseGlobalFlags(
    process.argv.slice(2),
  );

  const command = remaining[0];

  // --env <name>: unified env-selection flag.
  //
  // Always propagate as JUSTSCALE_ENV so spawned children (tsx / ptsc /
  // turbo / pnpm) and any downstream `loadEnvironment()` call see the
  // selected env.
  //
  // For non-builtin commands (custom app commands, not build/run/test/etc.),
  // also check `justscale.config.ts` for a remote host registration; if one
  // exists for the env name, dispatch there. Built-in commands always run
  // locally — we skip the remote-lookup cost (which imports the user's app
  // file) entirely for them.
  if (env && command) {
    process.env.JUSTSCALE_ENV = env;

    if (!BUILTIN_COMMANDS.has(command)) {
      const remote = await resolveRemoteEnv(env);
      if (remote) {
        try {
          await runRemoteEnv(env, remaining);
          closeReadline();
          return;
        } catch (err) {
          console.error(`Failed to connect to environment '${env}': ${(err as Error).message}`);
          process.exit(1);
        }
      }
    }
  }

  // Try socket first for remote mode (unless forced local).
  // Built-in commands (build/run/test/...) are always local — they operate
  // on the workspace filesystem, never a remote host. Probing for a socket
  // risks picking up an unrelated cluster (e.g. during parallel test runs)
  // and dispatching the command there, which then 404s with "Unknown
  // command: build --help" or similar.
  if (!forceLocal && command && !BUILTIN_COMMANDS.has(command)) {
    try {
      const { connectToCluster } = await import('@justscale/core/cluster');
      const client = await connectToCluster({ socketPath });
      await client.disconnect();
      // Socket works, use remote mode
      await runRemote(remaining, socketPath);
      closeReadline();
      return;
    } catch {
      // Socket not available, fall back to local
    }
  }

  // Run CLI with merged built-in + app commands
  await runCli(remaining);
  closeReadline();
}

/**
 * Returns the remote-env config for `envName` if `justscale.config.ts`
 * declares one, otherwise `null`. Callers use the null result to decide
 * between the remote-connect path and the local env-selector path.
 */
async function resolveRemoteEnv(envName: string): Promise<{ url: string } | null> {
  const { discover } = await import('../discovery.js');
  const result = await discover();
  if (!result) return null;
  return result.config.environments?.[envName] ?? null;
}

/**
 * Run a command on a named remote environment.
 *
 * Loads the environment config from justscale.config.ts, connects
 * to the remote host, and forwards the command.
 */
async function runRemoteEnv(envName: string, argv: string[]): Promise<void> {
  const { discover } = await import('../discovery.js');
  const result = await discover();

  if (!result) {
    throw new Error('No justscale.config.ts found. Cannot resolve environment.');
  }

  const envConfig = result.config.environments?.[envName];
  if (!envConfig) {
    const available = Object.keys(result.config.environments ?? {});
    throw new Error(
      `Environment '${envName}' not found. Available: ${available.length ? available.join(', ') : 'none defined'}`,
    );
  }

  // For now, remote environments connect via the cluster's socket protocol
  // over TCP. The URL from the config specifies the host:port.
  const url = new URL(envConfig.url);
  const host = url.hostname;
  const port = parseInt(url.port || '9100', 10);

  console.log(`Connecting to ${envName} (${host}:${port})...`);

  const { connectToCluster } = await import('@justscale/core/cluster');
  const client = await connectToCluster({
    socketPath: `tcp://${host}:${port}`,
    timeout: 10000,
  });

  try {
    const commands = await client.listCommands();

    // Match command
    let matchedCommand: string | null = null;
    let argStartIdx = 0;

    for (let i = argv.length; i > 0; i--) {
      const candidate = argv.slice(0, i).join(' ');
      if (commands.includes(candidate)) {
        matchedCommand = candidate;
        argStartIdx = i;
        break;
      }
    }

    if (!matchedCommand) {
      console.error(`Unknown command on ${envName}: ${argv.join(' ')}`);
      console.error(`\nAvailable commands on ${envName}:`);
      for (const cmd of commands) {
        console.error(`  ${cmd}`);
      }
      process.exit(1);
    }

    const args = parseCommandArgs(argv.slice(argStartIdx));
    const promptHandler = createTerminalPromptHandler();

    const result = await client.invoke(matchedCommand, args, {
      onStdout: (data) => process.stdout.write(`${data}\n`),
      onStderr: (data) => process.stderr.write(`${data}\n`),
      onPrompt: promptHandler,
    });

    if (result !== undefined) {
      if (typeof result === 'object') {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(result);
      }
    }

    await client.disconnect();
  } catch (error) {
    await client.disconnect().catch(() => {});
    throw error;
  }
}
