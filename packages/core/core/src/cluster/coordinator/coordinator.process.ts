/**
 * Durable cluster coordinator process.
 *
 * Maintains a live node registry (`using exports`) readable via handle.data.
 * The DB is the source of truth for crash recovery - the registry is hydrated
 * on startup. Runs on exactly one node via the process runtime's advisory lock.
 */

import { createProcess, race, signal, delay } from '../../process/index.js';
import { ClusterSignals } from './cluster-signals.js';
import { ModelRepository } from '../../models/index.js';
import { ClusterNode } from './cluster-node.model.js';

export const COORDINATOR_PATH = '/cluster/coordinator';

interface NodeInfo {
  address: string
  capabilities: string[]
  status: string
}

const RECONCILIATION_INTERVAL_SECONDS = 30;

export const clusterCoordinator = createProcess({
  path: '/cluster/coordinator',

  inject: {
    signals: ClusterSignals,
    nodes: ModelRepository.of(ClusterNode),
  },

  async handler({ signals, nodes }, _params) {
    // [Symbol.dispose] is a no-op required by the ES2023 Explicit Resource
    // Management spec so plain tsc accepts the `using` declaration. ptsc
    // rewrites `using exports = ...` into durable-process state wiring and
    // ignores this field at runtime.
    using exports = {
      nodeCount: 0,
      registry: new Map<string, NodeInfo>(),

      getNode(id: string) {
        return this.registry.get(id);
      },
      getNodesByCapability(cap: string) {
        return [...this.registry.values()].filter(n => n.capabilities.includes(cap));
      },

      [Symbol.dispose]() {},
    };

    for (const node of await nodes.find({})) {
      if (node.status === 'active') {
        exports.registry.set(node.nodeId, {
          address: node.address,
          capabilities: node.capabilities,
          status: node.status,
        });
      }
    }
    exports.nodeCount = exports.registry.size;

    while (true) {
      const r = race();

      switch (true) {
        case signal(r, signals.nodeJoin): {
          const { nodeId, address, capabilities, timestamp } = r;

          using existing = await nodes.lock(nodes.findOne(ClusterNode.fields.nodeId.eq(nodeId)));
          if (existing) {
            await nodes.update(existing, {
              status: 'active',
              lastSeen: new Date(timestamp),
              address,
              capabilities,
            });
            await signals.nodeStateChanged({
              nodeId, from: existing.status, to: 'active', reason: 'rejoin',
            });
          } else {
            await nodes.insert({
              nodeId,
              address,
              status: 'active',
              lastSeen: new Date(timestamp),
              capabilities,
            });
            await signals.nodeStateChanged({
              nodeId, from: 'none', to: 'active', reason: 'join',
            });
          }

          exports.registry.set(nodeId, { address, capabilities, status: 'active' });
          exports.nodeCount = exports.registry.size;
          break;
        }

        case signal(r, signals.nodeDeath): {
          const { nodeId, lastSeenMs } = r;
          using dead = await nodes.lock(nodes.findOne(ClusterNode.fields.nodeId.eq(nodeId)));
          if (dead && dead.status !== 'dead') {
            const previousStatus = dead.status;
            await nodes.update(dead, { status: 'dead' });
            await signals.nodeStateChanged({
              nodeId, from: previousStatus, to: 'dead',
              reason: `heartbeat timeout (last seen: ${new Date(lastSeenMs).toISOString()})`,
            });
          }

          exports.registry.delete(nodeId);
          exports.nodeCount = exports.registry.size;
          break;
        }

        case signal(r, signals.nodeLeave): {
          const { nodeId } = r;
          using leaving = await nodes.lock(nodes.findOne(ClusterNode.fields.nodeId.eq(nodeId)));
          if (leaving && leaving.status !== 'dead') {
            await nodes.update(leaving, { status: 'draining' });
            await signals.nodeStateChanged({
              nodeId, from: leaving.status, to: 'draining', reason: 'graceful leave',
            });
          }

          exports.registry.delete(nodeId);
          exports.nodeCount = exports.registry.size;
          break;
        }

        case signal(r, signals.processCreated): {
          break;
        }

        case signal(r, signals.rebalanceRequested): {
          const { reason } = r;
          await signals.nodeStateChanged({
            nodeId: 'coordinator', from: 'active', to: 'active',
            reason: `rebalance requested: ${reason}`,
          });
          break;
        }

        case delay.seconds(r, RECONCILIATION_INTERVAL_SECONDS): {
          break;
        }
      }
    }
  },
});
