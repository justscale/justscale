/**
 * Abstraction for CLI command execution.
 */

import type { App } from '../index.js';
import { createClient, invoke } from './runner.js';

/** Adapter interface for CLI command execution */
export interface CliAdapter {
  /** Execute a command with given arguments */
  execute(command: string, args: Record<string, unknown>): Promise<unknown>
  /** List all available commands */
  listCommands(): Promise<string[]>
}

/**
 * Create a local adapter that executes commands directly against an app.
 *
 * @example
 * ```typescript
 * const adapter = createLocalAdapter(app);
 * const result = await adapter.execute('auth create-user', { email: 'foo@bar.com' });
 * const commands = await adapter.listCommands();
 * ```
 */
export function createLocalAdapter(app: App<any>): CliAdapter {
  const client = createClient(app);

  return {
    async execute(
      command: string,
      args: Record<string, unknown>,
    ): Promise<unknown> {
      return invoke(app, command, args);
    },
    async listCommands(): Promise<string[]> {
      return client.routes;
    },
  };
}

