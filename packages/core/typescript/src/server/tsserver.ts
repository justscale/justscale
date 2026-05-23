#!/usr/bin/env node
/**
 * ptscserver - Process TypeScript Language Server
 *
 * Drop-in replacement for tsserver that automatically loads the JustScale
 * language service plugin. This enables IDE integration without requiring
 * manual plugin configuration in tsconfig.json.
 *
 * Usage:
 *   ptscserver [tsserver options]
 *
 * This is equivalent to running tsserver with the @justscale/typescript/language-service
 * plugin globally enabled.
 *
 * VS Code Integration:
 *   In .vscode/settings.json:
 *   {
 *     "typescript.tsdk": "node_modules/typescript/lib",
 *     "typescript.tsserver.pluginPaths": ["node_modules/@justscale/typescript"]
 *   }
 *
 * Or use this wrapper directly:
 *   {
 *     "typescript.tsserver.path": "node_modules/@justscale/typescript/dist/server/tsserver.js"
 *   }
 */

import { spawn, ChildProcess } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Find the TypeScript server executable
 */
function findTsServer(): string {
  // Try to find typescript in node_modules
  const possiblePaths = [
    // From project root
    resolve(process.cwd(), 'node_modules/typescript/lib/tsserver.js'),
    // From this package
    resolve(__dirname, '../../../node_modules/typescript/lib/tsserver.js'),
    resolve(__dirname, '../../../../typescript/lib/tsserver.js'),
    // Global
    'tsserver',
  ];

  for (const serverPath of possiblePaths) {
    try {
      if (serverPath === 'tsserver') {
        // Will be resolved by PATH
        return serverPath;
      }
      // Check if file exists
      require.resolve(serverPath);
      return serverPath;
    } catch {
      continue;
    }
  }

  // Fallback to global tsserver
  return 'tsserver';
}

/**
 * Start the TypeScript server with our plugin
 */
function startServer(): void {
  const tsserverPath = findTsServer();

  // Prepare arguments - pass through all original args
  const args = process.argv.slice(2);

  // Add our plugin using the --globalPlugins flag
  // This injects our plugin into all projects without requiring tsconfig changes
  const pluginArgs = [
    '--globalPlugins',
    '@justscale/typescript/language-service',
    '--pluginProbeLocations',
    resolve(__dirname, '../../..'),
  ];

  let tsserver: ChildProcess;

  if (tsserverPath === 'tsserver') {
    // Use global tsserver
    tsserver = spawn('tsserver', [...pluginArgs, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TSS_LOG: process.env.TSS_LOG || '-level verbose',
      },
    });
  } else {
    // Use local tsserver.js
    tsserver = spawn(
      process.execPath,
      [tsserverPath, ...pluginArgs, ...args],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          TSS_LOG: process.env.TSS_LOG || '-level verbose',
        },
      }
    );
  }

  // Pipe stdin/stdout/stderr
  if (tsserver.stdin) {
    process.stdin.pipe(tsserver.stdin);
  }
  if (tsserver.stdout) {
    tsserver.stdout.pipe(process.stdout);
  }
  if (tsserver.stderr) {
    tsserver.stderr.pipe(process.stderr);
  }

  // Handle exit
  tsserver.on('exit', (code) => {
    process.exit(code ?? 0);
  });

  tsserver.on('error', (err) => {
    console.error('Failed to start TypeScript server:', err);
    process.exit(1);
  });

  // Handle signals
  process.on('SIGTERM', () => {
    tsserver.kill('SIGTERM');
  });

  process.on('SIGINT', () => {
    tsserver.kill('SIGINT');
  });
}

// Start the server
startServer();
