/**
 * Signals emitted by NodeLifecycleService and consumed by the cluster coordinator process.
 */

import { defineService } from '../../core/index.js';
import { AbstractProcessExecutor } from '../../runtime/process/executor.js';

export class ClusterSignals extends defineService({
  inject: { executor: AbstractProcessExecutor },
  factory: ({ executor }) => ({
    /** A new node joined the cluster */
    nodeJoin: executor.createSignal<
      [],
      { nodeId: string; address: string; capabilities: string[]; timestamp: number }
    >('cluster.node.join'),

    /** A node is leaving gracefully (draining) */
    nodeLeave: executor.createSignal<
      [],
      { nodeId: string }
    >('cluster.node.leave'),

    /** A node was detected as dead (missed heartbeats) */
    nodeDeath: executor.createSignal<
      [],
      { nodeId: string; lastSeenMs: number }
    >('cluster.node.death'),

    /** A new process was created and needs placement */
    processCreated: executor.createSignal<
      [],
      { processId: string; instanceId: string; path: string }
    >('cluster.process.created'),

    /** Request to rebalance work across nodes */
    rebalanceRequested: executor.createSignal<
      [],
      { reason: string }
    >('cluster.rebalance'),

    /** Coordinator acknowledged a node state change (observability) */
    nodeStateChanged: executor.createSignal<
      [],
      { nodeId: string; from: string; to: string; reason: string }
    >('cluster.node.state_changed'),
  }),
}) {}
