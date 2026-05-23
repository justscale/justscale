/**
 * Transport plugin system and serve options for JustScale clusters.
 */

import type { App, ControllerDef, Container } from '../index.js';
import { ClusterServer } from './server.js';

export interface TransportPlugin {
  /** Name of the transport (e.g., "http", "cli") */
  name: string;
  /**
   * Tokens this plugin will provide during beforeControllerResolution.
   * Used by builder validation to know these dependencies will be satisfied.
   */
  provides?: unknown[];
  /**
   * Called after services are registered but before controllers are resolved.
   * Use this to register services that controllers may depend on.
   * @param container - The DI container
   * @param controllers - All controller definitions (not yet resolved)
   */
  beforeControllerResolution?: (container: Container, controllers: ControllerDef<any>[]) => void;
  /**
   * Called immediately after the app is created.
   * Use this to initialize services that depend on the app.
   * @param app - The created app instance
   */
  onAppCreated?: (app: App<any>) => void;
  /** Called when cluster.serve() is invoked */
  onServe?: (cluster: Cluster<any>, options: ServeOptions) => Promise<void>;
  /** Called when cluster.stop() is invoked - clean up transport resources */
  onStop?: (cluster: Cluster<any>) => Promise<void>;
  /** Called to register handlers on the cluster server */
  registerHandlers?: (server: ClusterServer, app: App<any>) => void;
}

// `var` (not `let`/`const`) so the registry survives module-eval-order
// cycles. Transport packages call registerTransport() at their own module
// load; on some import graphs this runs before cluster.ts top-level const
// initializers execute. `var` is hoisted + initialized to `undefined`, so
// the guard works. `let`/`const` hit the temporal dead zone and throw.
// eslint-disable-next-line no-var
var registeredTransports: TransportPlugin[] | undefined;

/**
 * Register a transport plugin.
 * Called by transport packages (e.g., @justscale/http, @justscale/cli) on import.
 */
export function registerTransport(plugin: TransportPlugin): void {
  if (!registeredTransports) registeredTransports = [];
  registeredTransports.push(plugin);
}

/**
 * Get all registered transport plugins.
 */
export function getRegisteredTransports(): readonly TransportPlugin[] {
  return registeredTransports ?? [];
}

export interface ServeOptions {
  /** Custom socket path (default: auto-generated) */
  socketPath?: string;
  /** Skip starting the cluster socket server */
  noSocket?: boolean;
  /** Scheduled task options (if using @justscale/cluster/scheduled-task) */
  scheduledTask?: {
    /** Polling interval in ms (default: 1000) */
    pollInterval?: number;
  };
}

export interface Cluster<TControllers extends ControllerDef<any>[] = ControllerDef<any>[]> {
  /** The underlying JustScale app - use for testing or direct access */
  readonly app: App<TControllers>;
  /** The cluster server instance (available after serve()) */
  readonly server: ClusterServer | null;
  /** Socket path (available after serve()) */
  readonly socketPath: string | null;
  /** Whether the cluster is currently serving */
  readonly isServing: boolean;

  /**
   * Start serving - starts cluster socket and all registered transports.
   *
   * @example
   * ```typescript
   * // Start with HTTP on port 3000
   * await cluster.serve({ http: 3000 });
   *
   * // Start socket only (for CLI access)
   * await cluster.serve();
   * ```
   */
  serve(options?: ServeOptions): Promise<void>;

  /**
   * Stop the cluster and all transports.
   */
  stop(): Promise<void>;
}

export { ClusterServer } from './server.js';
