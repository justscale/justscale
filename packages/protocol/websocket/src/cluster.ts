import type { Cluster, TransportPlugin } from '@justscale/core/cluster';
import { createWsHandler } from './server.js';

export async function tryRegisterWsTransport(): Promise<void> {
  try {
    const { registerTransport } = await import('@justscale/core/cluster');
    const { registerUpgradeHandler } = await import('@justscale/http');

    const wsPlugin: TransportPlugin = {
      name: 'websocket',
      async onServe(cluster: Cluster<any>) {
        const handler = createWsHandler(cluster.app);
        registerUpgradeHandler(handler.handleUpgrade);
      },
    };

    registerTransport(wsPlugin);
  } catch {
    // optional peer dependencies not installed
  }
}

tryRegisterWsTransport();
