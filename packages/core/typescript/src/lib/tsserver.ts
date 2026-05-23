#!/usr/bin/env node
/**
 * JustScale TypeScript Server
 *
 * Drop-in replacement for tsserver that uses our patched TypeScript.
 * This ensures proto support works in any IDE that loads this server.
 */

import { createLogger } from './logger';
import { resolve, dirname } from 'node:path';

const log = createLogger('tsserver');

log.info('JustScale TSServer starting...');
log.info('Process args', { argv: process.argv });

// Import our patched TypeScript to ensure patches are applied
// before the real tsserver loads
log.info('Loading patched TypeScript...');
require('./typescript');
log.info('Patched TypeScript loaded');

function findTsServer(): string {
  const __dirname = dirname(__filename);

  const possiblePaths = [
    // From lib/ directory, go up to find node_modules
    resolve(__dirname, '../node_modules/typescript/lib/tsserver.js'),
    resolve(__dirname, '../../node_modules/typescript/lib/tsserver.js'),
    resolve(__dirname, '../../../node_modules/typescript/lib/tsserver.js'),
    resolve(__dirname, '../../../../node_modules/typescript/lib/tsserver.js'),
    resolve(__dirname, '../../../../../node_modules/typescript/lib/tsserver.js'),
  ];

  for (const p of possiblePaths) {
    try {
      require.resolve(p);
      log.info('Found tsserver', { path: p });
      return p;
    } catch {
      log.debug('TSServer not at', { path: p });
    }
  }

  // Last resort: try to resolve from node_modules
  try {
    const resolved = require.resolve('typescript/lib/tsserver.js');
    log.info('Found tsserver via require.resolve', { path: resolved });
    return resolved;
  } catch (err) {
    log.error('Could not find tsserver', { error: String(err) });
    const error = new Error('Could not find TypeScript tsserver. Make sure typescript is installed.');
    (error as any).cause = err;
    throw error;
  }
}

// Run tsserver
const tsserverPath = findTsServer();
log.info('Starting real tsserver', { path: tsserverPath });

// The real tsserver.js will start the server when required
require(tsserverPath);
