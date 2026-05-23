/**
 * MCP Server for JustScale
 *
 * Exposes CLI commands as MCP tools. Can run in stdio mode (launched by Claude Code)
 * or be started by `just dev` alongside the development server.
 *
 * Each Cli() command becomes an MCP tool with:
 * - Name: command path with spaces → underscores (e.g., "user add" → "user_add")
 * - Description: from Zod schema .describe() calls
 * - Parameters: derived from Zod input schema
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { App } from '../../app.js';
import { getInputSchema } from '../builder/index.js';
import { z } from 'zod';

interface CliRoute {
  fullCommand: string
  inputSchema?: z.ZodType
  route: any
  deps: Record<string, unknown>
}

/**
 * Extract CLI routes from a built app — same logic as the runner uses.
 */
function extractCliRoutes(app: App<any>): Map<string, CliRoute> {
  const routes = new Map<string, CliRoute>();

  for (const controller of app.controllers) {
    const prefix =
      (controller.settings as any)?.command ||
      (controller.settings as any)?.prefix ||
      '';

    for (const compiledRoute of controller.routes) {
      if ((compiledRoute as any).method !== 'CLI') continue;

      const route = compiledRoute as any;
      const commandName = route.path;
      const fullCommand = prefix ? `${prefix} ${commandName}` : commandName;

      const inputSchema = getInputSchema(route);

      routes.set(fullCommand, {
        fullCommand,
        inputSchema,
        route,
        deps: controller.deps,
      });
    }
  }

  return routes;
}

/**
 * Convert a Zod object schema to a plain shape for MCP tool registration.
 * MCP SDK accepts Zod schemas directly via its zod-compat layer.
 */
function zodToMcpShape(schema: z.ZodType | undefined): Record<string, z.ZodType> | undefined {
  if (!schema) return undefined;
  // If it's a ZodObject, extract its shape
  if ('shape' in schema && typeof (schema as any).shape === 'object') {
    return (schema as any).shape;
  }
  return undefined;
}

/**
 * Create and configure an MCP server with tools from a JustScale app.
 */
export function createMcpServer(app: App<any>): McpServer {
  const server = new McpServer({
    name: 'justscale',
    version: '0.1.0',
  }, {
    capabilities: {
      tools: {},
    },
  });

  const routes = extractCliRoutes(app);

  for (const [command, cliRoute] of routes) {
    const toolName = command.replace(/ /g, '_');
    const description = `CLI command: just ${command}`;
    const shape = zodToMcpShape(cliRoute.inputSchema);

    if (shape) {
      server.tool(toolName, description, shape, async (args) => {
        return await executeCliCommand(cliRoute, args);
      });
    } else {
      server.tool(toolName, description, async () => {
        return await executeCliCommand(cliRoute, {});
      });
    }
  }

  return server;
}

/**
 * Execute a CLI command and capture its output.
 */
async function executeCliCommand(route: CliRoute, args: Record<string, unknown>) {
  const output: string[] = [];

  // Create a CliIO implementation that captures output for MCP tool results
  const noop = () => {};
  const noopSpinner = { stop: noop, succeed: noop, fail: noop, update: noop };
  const noopProgress = { increment: noop, update: noop, finish: noop };

  const io = {
    write: (text: string) => { output.push(text); },
    log: (msg: string) => { output.push(msg); },
    error: (msg: string) => { output.push(`ERROR: ${msg}`); },
    warn: (msg: string) => { output.push(`WARN: ${msg}`); },
    debug: noop,
    result: (val: unknown) => { output.push(JSON.stringify(val)); },
    table: (data: any[], columns?: any[]) => {
      if (columns && data.length > 0) {
        const colNames = columns.map((c: any) => typeof c === 'string' ? c : c.key);
        output.push(colNames.join('\t'));
        for (const row of data) {
          output.push(colNames.map((c: string) => String((row as any)[c] ?? '')).join('\t'));
        }
      }
    },
    password: async () => '',
    prompt: async (_msg: string, defaultValue?: string) => defaultValue ?? '',
    confirm: async () => true,
    select: async (_msg: string, choices: any[]) => typeof choices[0] === 'string' ? choices[0] : choices[0]?.value,
    multiSelect: async (_msg: string, choices: any[]) => choices,
    progress: () => noopProgress,
    spinner: () => noopSpinner,
    hr: () => { output.push('---'); },
    newline: () => { output.push(''); },
    isInteractive: false,
    isVerbose: false,
  };

  try {
    const ctx = {
      args,
      io,
      ...route.deps,
    };
    await route.route.handler(ctx);

    return {
      content: [{ type: 'text' as const, text: output.join('\n') || 'Done.' }],
    };
  } catch (err: any) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
      isError: true,
    };
  }
}

/**
 * Start the MCP server in stdio mode.
 * Called by `just mcp serve` or launched directly by Claude Code.
 */
export async function startMcpStdio(app: App<any>): Promise<void> {
  const server = createMcpServer(app);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
