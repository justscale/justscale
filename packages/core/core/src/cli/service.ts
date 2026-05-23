/**
 * Provides reflection and execution capabilities for CLI commands.
 */

import type { App } from '../index.js';
import type { CliIO } from './io.js';
import { buildRouteMap, generateAppHelp } from './runner.js';
import { generateHelp } from './parser.js';

/**
 * CLI Service interface - provides command reflection and execution.
 */
export interface ICliService {
  /**
   * List all available CLI commands.
   * Returns command names in space-separated format (e.g., "auth create-user").
   */
  listCommands(): string[]

  /**
   * Execute a CLI command with the given arguments and IO.
   * The IO from the current handler can be passed to enable nested command output.
   *
   * @param command - Command name (e.g., "auth create-user")
   * @param args - Command arguments
   * @param io - CLI IO interface for output/input
   * @returns The command result (if any)
   */
  execute(
    command: string,
    args: Record<string, unknown>,
    io: CliIO<unknown>,
  ): Promise<unknown>

  /**
   * Render the grouped-by-prefix help text for the whole app - the
   * same layout `just --help` shows, minus the `just ` prefix in the
   * usage line (we're already inside a shell when calling this).
   */
  help(): string

  /**
   * Render per-command help - the same layout `just <cmd> --help`
   * shows. Returns null when `command` doesn't match any registered
   * CLI route.
   */
  helpFor(command: string): string | null
}

/**
 * Abstract class token for dependency injection.
 * Inject this in your controllers to access CLI capabilities.
 */
export abstract class CliService implements ICliService {
  abstract listCommands(): string[];
  abstract execute(
    command: string,
    args: Record<string, unknown>,
    io: CliIO<unknown>,
  ): Promise<unknown>;
  abstract help(): string;
  abstract helpFor(command: string): string | null;
}

/** @internal */
export class LazyCliService extends CliService {
  private _impl: ICliService | null = null;

  /** Set the real implementation. Called after app creation. */
  setImplementation(impl: ICliService): void {
    this._impl = impl;
  }

  private get impl(): ICliService {
    if (!this._impl) {
      throw new Error('CliService not initialized.');
    }
    return this._impl;
  }

  listCommands(): string[] {
    return this.impl.listCommands();
  }

  async execute(
    command: string,
    args: Record<string, unknown>,
    io: CliIO<unknown>,
  ): Promise<unknown> {
    return this.impl.execute(command, args, io);
  }

  help(): string {
    return this.impl.help();
  }

  helpFor(command: string): string | null {
    return this.impl.helpFor(command);
  }
}

/** Create a CliService instance for the given app. */
export function createCliService(app: App<any>): ICliService {
  return {
    listCommands(): string[] {
      const commands: string[] = [];
      for (const controller of app.controllers) {
        for (const route of controller.routes) {
          if ((route as any).method === 'CLI') {
            const command = route.segments.join(' ');
            commands.push(command);
          }
        }
      }
      return commands;
    },

    async execute(
      command: string,
      args: Record<string, unknown>,
      io: CliIO<unknown>,
    ): Promise<unknown> {
      const normalized = command.trim().replace(/\s+/g, ' ');
      let targetRoute: any = null;
      let targetDeps: Record<string, unknown> = {};

      for (const controller of app.controllers) {
        for (const route of controller.routes) {
          if ((route as any).method !== 'CLI') continue;
          if (route.segments.join(' ') === normalized) {
            targetRoute = route;
            targetDeps = controller.deps;
            break;
          }
        }
        if (targetRoute) break;
      }

      if (!targetRoute) {
        throw new Error(`Unknown command: ${command}`);
      }

      let result: unknown;
      const wrappedIO = {
        ...io,
        result: (data: unknown) => {
          result = data;
        },
      };

      await app.execute(
        { route: targetRoute, deps: targetDeps, params: {} },
        { args, io: wrappedIO },
      );

      return result;
    },

    help(): string {
      return generateAppHelp('', buildRouteMap(app));
    },

    helpFor(command: string): string | null {
      const normalized = command.trim().replace(/\s+/g, ' ');
      const route = buildRouteMap(app).get(normalized);
      if (!route) return null;
      return generateHelp(route.fullCommand, route.argDefs, route.description);
    },
  };
}
