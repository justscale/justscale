/**
 * TypeScript Server integration for JustScale
 *
 * This module provides integration with the TypeScript Language Server
 * for IDE support. It can be used in several ways:
 *
 * 1. Direct plugin: Add to tsconfig.json plugins array
 * 2. Global plugin: Use ptscserver wrapper
 * 3. VS Code extension: Use the recommended VS Code settings
 */

export { default as plugin } from '../language-service/index.js';

/**
 * Configuration for the JustScale TypeScript server
 */
export interface ServerConfig {
  /**
   * Enable verbose logging
   */
  verbose?: boolean

  /**
   * Path to the TypeScript installation to use
   */
  typescriptPath?: string

  /**
   * Additional plugin paths to probe
   */
  pluginPaths?: string[]
}

/**
 * Start the TypeScript Language Server with JustScale plugin enabled
 */
export async function startLanguageServer(config: ServerConfig = {}): Promise<void> {
  // Dynamic import to avoid bundling issues
  const { spawn } = await import('node:child_process');
  const { resolve } = await import('node:path');

  const tsserverPath = config.typescriptPath
    ? resolve(config.typescriptPath, 'lib/tsserver.js')
    : 'tsserver';

  const args = [
    '--globalPlugins',
    '@justscale/typescript/language-service',
  ];

  if (config.pluginPaths) {
    args.push('--pluginProbeLocations', config.pluginPaths.join(','));
  }

  const tsserver = spawn(process.execPath, [tsserverPath, ...args], {
    stdio: 'inherit',
  });

  return new Promise((resolve, reject) => {
    tsserver.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tsserver exited with code ${code}`));
    });
    tsserver.on('error', reject);
  });
}
