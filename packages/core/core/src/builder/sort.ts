/**
 * Topological Sort for Components
 *
 * Implements Kahn's algorithm to sort components based on dependencies.
 * Ensures features and services are registered in the correct order.
 */

import type { Component, AnyToken } from './types.js';
import type { ServiceDef } from '../core/service.js';
import { isServiceDef, isRepositoryBinding, isFeatureToken } from './types.js';
import { getTokenDescription } from './validation.js';
import { getFeatureMetadata } from './feature-builder.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Error thrown when a dependency cycle is detected.
 */
export class CycleError extends Error {
  constructor(public readonly cycle: string[]) {
    super(formatCycleError(cycle));
    this.name = 'CycleError';
  }
}

/**
 * Format a cycle error message.
 */
function formatCycleError(cycle: string[]): string {
  return `Dependency cycle detected:\n  ${cycle.join(' → ')}\n\nHint: Check if any features or services depend on each other in a circular way.`;
}

// ============================================================================
// Dependency Extraction
// ============================================================================

/**
 * Get a unique ID for a component.
 */
function getComponentId(component: Component): string {
  if (isFeatureToken(component)) {
    const meta = getFeatureMetadata(component);
    return `feature:${meta?.name ?? 'anonymous'}`;
  }
  if (isServiceDef(component)) {
    return `service:${getTokenDescription(component as any)}`;
  }
  if (isRepositoryBinding(component)) {
    return `binding:${getTokenDescription(component.token as AnyToken)}`;
  }
  return `unknown:${String(component)}`;
}

/**
 * Extract what tokens a component provides.
 */
function extractProvides(component: Component): AnyToken[] {
  if (isRepositoryBinding(component)) {
    return [component.token as AnyToken];
  }
  if (isServiceDef(component)) {
    // ServiceDef provides itself
    return [component as any as AnyToken];
  }
  // Features provide what their builder adds, but we can't know that statically
  // For sorting purposes, we track features by their identity
  if (isFeatureToken(component)) {
    return [component as any as AnyToken];
  }
  return [];
}

/**
 * Extract what tokens a component requires.
 */
function extractRequires(component: Component): AnyToken[] {
  if (isFeatureToken(component)) {
    const meta = getFeatureMetadata(component);
    return meta?.requires ?? [];
  }
  if (isServiceDef(component)) {
    return Object.values((component as ServiceDef<any, any>).deps ?? {}) as AnyToken[];
  }
  return [];
}

// ============================================================================
// Topological Sort
// ============================================================================

/**
 * Sort components topologically based on their dependencies.
 *
 * Uses Kahn's algorithm:
 * 1. Build a dependency graph
 * 2. Start with components that have no dependencies
 * 3. Process each component, removing it from dependencies of others
 * 4. Repeat until all components are processed or a cycle is detected
 *
 * @throws CycleError if a cycle is detected
 */
export function topologicalSort(components: Component[]): Component[] {
  if (components.length <= 1) {
    return [...components];
  }

  // Build the graph
  const nodes = new Map<Component, {
    id: string
    provides: AnyToken[]
    requires: AnyToken[]
    inDegree: number
    edges: Set<Component>
  }>();

  // Build the provider map (token -> component)
  const providers = new Map<AnyToken, Component>();

  // Initialize nodes
  for (const component of components) {
    const provides = extractProvides(component);
    const requires = extractRequires(component);

    nodes.set(component, {
      id: getComponentId(component),
      provides,
      requires,
      inDegree: 0,
      edges: new Set(),
    });

    // Register what this component provides
    for (const token of provides) {
      providers.set(token, component);
    }
  }

  // Build edges based on dependencies
  for (const [component, node] of nodes) {
    for (const required of node.requires) {
      const provider = providers.get(required);
      if (provider && provider !== component) {
        // provider must come before component
        const providerNode = nodes.get(provider)!;
        if (!providerNode.edges.has(component)) {
          providerNode.edges.add(component);
          node.inDegree++;
        }
      }
    }
  }

  // Kahn's algorithm
  const result: Component[] = [];
  const queue: Component[] = [];

  // Start with nodes that have no incoming edges
  for (const [component, node] of nodes) {
    if (node.inDegree === 0) {
      queue.push(component);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);

    const currentNode = nodes.get(current)!;
    for (const dependent of currentNode.edges) {
      const dependentNode = nodes.get(dependent)!;
      dependentNode.inDegree--;
      if (dependentNode.inDegree === 0) {
        queue.push(dependent);
      }
    }
  }

  // Check for cycle
  if (result.length !== components.length) {
    // Find the cycle for error reporting
    const remaining = components.filter(c => !result.includes(c));
    const cycle = findCycle(remaining, nodes);
    throw new CycleError(cycle);
  }

  return result;
}

/**
 * Find a cycle in the remaining nodes (for error reporting).
 */
function findCycle(
  remaining: Component[],
  nodes: Map<Component, { id: string; edges: Set<Component> }>
): string[] {
  // DFS to find a cycle - use a Set for O(1) membership checks
  const visited = new Set<Component>();
  const remainingSet = new Set<Component>(remaining);
  const path: Component[] = [];
  const onPath = new Set<Component>();

  function dfs(component: Component): boolean {
    if (onPath.has(component)) {
      // Found cycle, extract it
      return true;
    }
    if (visited.has(component)) {
      return false;
    }

    visited.add(component);
    path.push(component);
    onPath.add(component);

    const node = nodes.get(component);
    if (node) {
      for (const neighbor of node.edges) {
        if (remainingSet.has(neighbor) && dfs(neighbor)) {
          return true;
        }
      }
    }

    path.pop();
    onPath.delete(component);
    return false;
  }

  for (const component of remaining) {
    if (dfs(component)) {
      // Return the cycle as IDs
      const cycleStart = path.findIndex(c => path.lastIndexOf(c) !== path.indexOf(c));
      if (cycleStart === -1 && path.length > 0) {
        // The cycle is the whole path
        return [...path, path[0]].map(c => nodes.get(c)!.id);
      }
      const cycle = path.slice(cycleStart);
      cycle.push(cycle[0]); // Close the cycle
      return cycle.map(c => nodes.get(c)!.id);
    }
  }

  // Fallback: just list remaining nodes
  return remaining.map(c => nodes.get(c)!.id);
}
