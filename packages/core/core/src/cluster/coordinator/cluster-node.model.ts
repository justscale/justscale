/** Represents a node (process instance) in the cluster. */

import { defineModel, field } from '../../models/index.js';

export const ClusterNodeStatus = ['active', 'draining', 'dead'] as const;
export type ClusterNodeStatus = (typeof ClusterNodeStatus)[number];

export class ClusterNode extends defineModel({
  name: 'JustScale_ClusterNode',
  fields: {
    nodeId: field.string().max(64),
    address: field.string().max(255),
    status: field.enum('ClusterNodeStatus', ClusterNodeStatus).default('active'),
    lastSeen: field.timestamp(),
    capabilities: field.json<string[]>().default([]),
  },
}) {}
