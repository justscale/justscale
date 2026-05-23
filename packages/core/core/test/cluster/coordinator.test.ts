/**
 * Tests for cluster coordinator components:
 * - ClusterNode model definition
 * - ClusterSignals service shape
 * - Coordinator process definition
 * - NodeLifecycleService shape
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ClusterNode,
  ClusterSignals,
  clusterCoordinator,
  COORDINATOR_PATH,
  NodeLifecycleService,
} from '../../src/cluster/coordinator/index.js';

describe('Cluster Coordinator', () => {
  describe('ClusterNode model', () => {
    it('has expected fields', () => {
      assert.ok(ClusterNode.fields.nodeId, 'should have nodeId field');
      assert.ok(ClusterNode.fields.address, 'should have address field');
      assert.ok(ClusterNode.fields.status, 'should have status field');
      assert.ok(ClusterNode.fields.lastSeen, 'should have lastSeen field');
      assert.ok(ClusterNode.fields.capabilities, 'should have capabilities field');
    });

    it('has field accessors for queries', () => {
      // Fields should be usable for query building (eq, lt, etc.)
      assert.ok(typeof ClusterNode.fields.nodeId.eq === 'function');
      assert.ok(typeof ClusterNode.fields.lastSeen.lt === 'function');
    });
  });

  describe('ClusterSignals', () => {
    it('is a service definition', () => {
      assert.ok(ClusterSignals.deps, 'should have deps');
      assert.ok(ClusterSignals.factory, 'should have factory');
    });
  });

  describe('clusterCoordinator process', () => {
    it('has correct path', () => {
      assert.equal(COORDINATOR_PATH, '/cluster/coordinator');
    });

    it('is a process definition', () => {
      assert.ok(clusterCoordinator, 'should exist');
      assert.equal(typeof clusterCoordinator, 'function', 'process definitions are callable');
    });
  });

  describe('NodeLifecycleService', () => {
    it('is a service definition', () => {
      assert.ok(NodeLifecycleService.deps, 'should have deps');
      assert.ok(NodeLifecycleService.factory, 'should have factory');
    });
  });
});
