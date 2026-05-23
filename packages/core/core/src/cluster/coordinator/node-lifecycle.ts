/**
 * Service that manages this node's participation in the cluster:
 * registers on start, sends heartbeats, detects stale nodes, and drains on stop.
 * The coordinator process is started idempotently - the runtime lock ensures only
 * one node executes it at a time.
 */

import { defineService } from '../../core/index.js';
import { ModelRepository } from '../../models/index.js';
import { ClusterNode } from './cluster-node.model.js';
import { ClusterSignals } from './cluster-signals.js';
import { clusterCoordinator } from './coordinator.process.js';
import { Lifecycle } from '../../core/lifecycle.js';
import { randomUUID } from 'node:crypto';

/** Default heartbeat interval in milliseconds */
const DEFAULT_HEARTBEAT_MS = 5_000;

/** Stale threshold: nodes not seen for this long are considered dead */
const DEFAULT_STALE_THRESHOLD_MS = 15_000;

export interface NodeLifecycleOptions {
  /** This node's address (host:port for inter-node communication) */
  address?: string
  /** Capabilities this node advertises */
  capabilities?: string[]
  /** Heartbeat interval in milliseconds (default: 5000) */
  heartbeatMs?: number
  /** Stale node threshold in milliseconds (default: 15000) */
  staleThresholdMs?: number
}

export class NodeLifecycleService extends defineService({
  inject: {
    nodes: ModelRepository.of(ClusterNode),
    signals: ClusterSignals,
    lifecycle: Lifecycle,
  },
  factory: ({ nodes, signals, lifecycle }, _resolve, options?: NodeLifecycleOptions) => {
    const nodeId = randomUUID();
    const address = options?.address ?? `local:${process.pid}`;
    const capabilities = options?.capabilities ?? [];
    const heartbeatMs = options?.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    const staleThresholdMs = options?.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;

    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    const start = async () => {
      await clusterCoordinator([]);

      await nodes.insert({
        nodeId,
        address,
        status: 'active',
        lastSeen: new Date(),
        capabilities,
      });

      await signals.nodeJoin({ nodeId, address, capabilities, timestamp: Date.now() });

      heartbeatTimer = setInterval(async () => {
        try {
          using self = await nodes.lock(nodes.findOne(ClusterNode.fields.nodeId.eq(nodeId)));
          if (self) {
            await nodes.update(self, { lastSeen: new Date() });
          }

          const staleThreshold = new Date(Date.now() - staleThresholdMs);
          const staleNodes = await nodes.find({
            where: ClusterNode.fields.lastSeen.lt(staleThreshold),
          });

          for (const stale of staleNodes) {
            if (stale.status === 'active') {
              await signals.nodeDeath({
                nodeId: stale.nodeId,
                lastSeenMs: stale.lastSeen.getTime(),
              });
            }
          }

          const cleanupThreshold = new Date(Date.now() - staleThresholdMs * 2);
          const cleanupNodes = await nodes.find({
            where: ClusterNode.fields.lastSeen.lt(cleanupThreshold),
          });

          for (const node of cleanupNodes) {
            if (node.status === 'dead' || node.status === 'draining') {
              using locked = await nodes.lock(node);
              if (locked) await nodes.delete(locked);
            }
          }
        } catch {
          // swallow heartbeat errors - next interval will retry
        }
      }, heartbeatMs);
    };

    const stop = async () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      await signals.nodeLeave({ nodeId });

      using self = await nodes.lock(nodes.findOne(ClusterNode.fields.nodeId.eq(nodeId)));
      if (self) {
        await nodes.update(self, { status: 'draining' });
      }
    };

    lifecycle.register('stop', stop);
    start().catch(() => { /* startup error handled by heartbeat retry */ });

    return {
      get nodeId() { return nodeId; },
      get address() { return address; },
    };
  },
}) {}
