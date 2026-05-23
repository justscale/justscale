/**
 * Registers CLI method handlers on the cluster server.
 * Auto-registers as a transport plugin when imported.
 */

import type { App, Container, ControllerDef } from '../index.js';
import type {
  ClusterServer,
  PromptOptions,
  PromptType,
} from '../cluster/index.js';
import {
  Methods,
  type TransportPlugin,
  registerTransport,
} from '../cluster/index.js';
import { CliService, LazyCliService, createCliService } from './service.js';

/** @internal */
let lazyCliService: LazyCliService | null = null;

/** Register CLI method handlers on a cluster server. */
export function registerCliHandlers(server: ClusterServer): void {
  server.handle(Methods.CLI_LIST, async (_, { app }) => {
    if (!app) {
      throw new Error('No app attached to cluster server');
    }

    const commands: string[] = [];
    for (const controller of app.controllers) {
      for (const route of controller.routes) {
        if ((route as any).method === 'CLI') {
          const command = route.path.replace(/\//g, ' ').trim();
          commands.push(command);
        }
      }
    }

    return { commands };
  });

  server.handle(Methods.CLI_INVOKE, async (params, ctx) => {
    const { app, stream, prompt } = ctx;
    if (!app) {
      throw new Error('No app attached to cluster server');
    }

    const { command, args = {} } = params as {
      command: string
      args?: Record<string, unknown>
    };

    if (!command) {
      throw new Error('Missing command parameter');
    }

    const commandAsPath = command.replace(/ /g, '/');

    let targetRoute: any = null;
    let targetDeps: Record<string, unknown> = {};

    for (const controller of app.controllers) {
      for (const route of controller.routes) {
        if ((route as any).method !== 'CLI') continue;

        if (route.path === commandAsPath) {
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
    const io = createStreamingIO(stream, prompt, (data) => {
      result = data;
    });

    const context = { args, io };
    await app.execute(
      { route: targetRoute, deps: targetDeps, params: {} },
      context,
    );

    return result;
  });
}

type PromptFn = (
  type: PromptType,
  message: string,
  options?: PromptOptions,
) => Promise<string | boolean | null>;

/**
 * Create a CLI IO implementation that streams output over cluster.
 */
function createStreamingIO(
  stream: (channel: string, data: unknown, done?: boolean) => Promise<void>,
  prompt: PromptFn,
  onResult: (data: unknown) => void,
) {
  return {
    log: (msg: string) => stream('stdout', msg),
    error: (msg: string) => stream('stderr', msg),
    warn: (msg: string) => stream('stderr', msg),
    result: onResult,

    prompt: async (message: string, defaultValue?: string): Promise<string> => {
      const result = await prompt('text', message, { defaultValue });
      if (result === null) {
        throw new Error('Prompt cancelled');
      }
      return result as string;
    },
    confirm: async (message: string): Promise<boolean> => {
      const result = await prompt('confirm', message);
      if (result === null) {
        return false; // Cancelled = no
      }
      return result as boolean;
    },
    select: async <T>(
      message: string,
      choices: Array<{ label: string; value: T }>,
    ): Promise<T> => {
      const choicesForPrompt = choices.map((c) => ({
        label: c.label,
        value: String(c.value),
      }));
      const result = await prompt('select', message, {
        choices: choicesForPrompt,
      });
      if (result === null) {
        throw new Error('Selection cancelled');
      }
      const selected = choices.find((c) => String(c.value) === result);
      if (!selected) {
        throw new Error('Invalid selection');
      }
      return selected.value;
    },

    spinner: (message: string) => {
      stream('spinner', { action: 'start', message });
      return {
        start: () => stream('spinner', { action: 'start', message }),
        stop: () => stream('spinner', { action: 'stop' }),
        success: (msg?: string) =>
          stream('spinner', { action: 'success', message: msg }),
        fail: (msg?: string) =>
          stream('spinner', { action: 'fail', message: msg }),
      };
    },
    progress: (total: number, message?: string) => {
      stream('progress', { action: 'start', total, message });
      return {
        update: (current: number) =>
          stream('progress', { action: 'update', current }),
        finish: () => stream('progress', { action: 'finish' }),
      };
    },

    table: (data: unknown[], columns?: unknown[]) => {
      stream('table', { data, columns });
    },
  };
}

/** CLI transport plugin - auto-registers CLI handlers on serve(). */
const cliTransportPlugin: TransportPlugin = {
  name: 'cli',

  provides: [CliService],

  beforeControllerResolution(
    container: Container,
    _controllers: ControllerDef<any>[],
  ): void {
    lazyCliService = new LazyCliService();
    container.registerInstance(CliService, lazyCliService);
  },

  onAppCreated(app: App<any>): void {
    const cliServiceImpl = createCliService(app);
    if (lazyCliService) {
      lazyCliService.setImplementation(cliServiceImpl);
    }
  },

  registerHandlers(server: ClusterServer, _app: App<any>): void {
    registerCliHandlers(server);
  },
};

registerTransport(cliTransportPlugin);

import { registerPluginProvides } from '../builder/validation.js';
registerPluginProvides(CliService);
