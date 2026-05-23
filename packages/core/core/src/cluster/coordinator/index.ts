/**
 * Cluster Coordinator
 *
 * Three-layer architecture for cluster coordination:
 * - Layer 0: Postgres (advisory locks, LISTEN/NOTIFY, SKIP LOCKED)
 * - Layer 1: NodeLifecycleService (heartbeat, stale detection, signals)
 * - Layer 2: clusterCoordinator process (placement, drain, rebalance)
 */

export { ClusterNode, ClusterNodeStatus } from './cluster-node.model.js';
export { ClusterSignals } from './cluster-signals.js';
export { clusterCoordinator, COORDINATOR_PATH } from './coordinator.process.js';
export {
  NodeLifecycleService,
  type NodeLifecycleOptions,
} from './node-lifecycle.js';
