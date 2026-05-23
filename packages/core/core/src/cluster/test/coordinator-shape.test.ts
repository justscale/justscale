/**
 * Tests for the cluster coordinator building blocks — model shape,
 * signals service, process identity, lifecycle service shape.
 *
 * These are shape-only checks: booting a real coordinator requires
 * postgres/advisory locks which are out of scope for core unit tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ClusterNode,
  ClusterNodeStatus,
  ClusterSignals,
  clusterCoordinator,
  COORDINATOR_PATH,
  NodeLifecycleService,
} from '../coordinator/index.js';

describe('ClusterNode model', () => {
  it('exposes all expected fields', () => {
    for (const f of ['nodeId', 'address', 'status', 'lastSeen', 'capabilities']) {
      assert.ok(
        (ClusterNode.fields as any)[f],
        `missing field: ${f}`,
      );
    }
  });

  it('status field uses the ClusterNodeStatus enum values', () => {
    assert.deepEqual([...ClusterNodeStatus], ['active', 'draining', 'dead']);
  });

  it('nodeId has string field operators (eq)', () => {
    assert.equal(typeof (ClusterNode.fields.nodeId as any).eq, 'function');
  });

  it('lastSeen supports comparison operators (lt, gt)', () => {
    const ls: any = ClusterNode.fields.lastSeen;
    assert.equal(typeof ls.lt, 'function');
    assert.equal(typeof ls.gt, 'function');
  });
});

describe('ClusterSignals service shape', () => {
  it('has deps and factory', () => {
    assert.ok((ClusterSignals as any).deps, 'missing deps');
    assert.ok((ClusterSignals as any).factory, 'missing factory');
  });

  it('depends on an executor token', () => {
    const d = (ClusterSignals as any).deps;
    assert.ok('executor' in d, 'expected executor dep key');
  });
});

describe('clusterCoordinator process', () => {
  it('is exported with the stable path constant', () => {
    assert.equal(COORDINATOR_PATH, '/cluster/coordinator');
  });

  it('is a function (process definitions are callable)', () => {
    assert.equal(typeof clusterCoordinator, 'function');
  });
});

describe('NodeLifecycleService shape', () => {
  it('is a service def', () => {
    assert.ok((NodeLifecycleService as any).deps);
    assert.ok((NodeLifecycleService as any).factory);
  });

  it('depends on nodes repo, signals, lifecycle', () => {
    const d = (NodeLifecycleService as any).deps;
    for (const k of ['nodes', 'signals', 'lifecycle']) {
      assert.ok(k in d, `missing dep: ${k}`);
    }
  });
});
