/**
 * Runtime Validation for Builder
 *
 * Provides dependency graph analysis and clear error messages.
 */

import type { ServiceDef } from '../core/service.js';
import { getServiceProvides } from '../core/service.js';
import { Logger } from '../core/logger.js';
import { Lifecycle } from '../core/lifecycle.js';
import { AbstractContainer } from '../core/container-reflection.js';
import type { RepositoryBinding, ServiceBinding, InstanceBinding, FeatureToken, AnyToken } from './types.js';
import { isServiceDef, isRepositoryBinding, isFeatureToken } from './types.js';
import { getFeatureMetadata } from './feature-builder.js';

// ============================================================================
// Plugin Provides Registry
// ============================================================================

/**
 * Global registry of tokens that plugins will provide.
 * Plugins (like @justscale/process/cluster) register their provides here
 * so the builder validation knows these dependencies will be satisfied.
 */
const pluginProvides = new Set<AnyToken>();

/**
 * Register a token that a plugin will provide during beforeControllerResolution.
 * Call this when your plugin is imported (before build() is called).
 *
 * @example
 * ```typescript
 * import { registerPluginProvides, AbstractProcessExecutor } from '@justscale/core'
 * registerPluginProvides(AbstractProcessExecutor)
 * ```
 */
export function registerPluginProvides(...tokens: AnyToken[]): void {
  for (const token of tokens) {
    pluginProvides.add(token);
  }
}

/**
 * Get all tokens that plugins have registered as provided.
 */
export function getPluginProvides(): ReadonlySet<AnyToken> {
  return pluginProvides;
}

// ============================================================================
// Implicit Services Registry
// ============================================================================

/**
 * Services that a protocol package auto-registers into every builder on
 * import - used by protocols (HTTP, SSE, WS, CLI, …) to satisfy the
 * abstract token a route factory stamps on controllers (e.g.
 * `AbstractHttpAdapter` for HTTP). Registered services are *lazy*: the
 * container resolves them only when something actually injects the
 * abstract token, so an unused protocol costs nothing.
 *
 * Each implicit service must carry `provides: [AbstractToken]` metadata
 * (via `defineService`'s `provides` option) so the container's
 * abstract-to-concrete binding picks it up automatically.
 *
 * Duplicate registrations for the same abstract are ignored - last
 * winner semantics would surprise users who stack multiple transport
 * packages; if a user wants an override, they use `bindService` or the
 * builder's `.override()`.
 */
const implicitServices = new Map<AnyToken, ServiceDef<any, any>>();

/**
 * Register a service that should be auto-added to every builder.
 * Keyed by the abstract token the service provides.
 *
 * @example
 * ```typescript
 * // In @justscale/http/service.ts (module top-level):
 * registerImplicitService(AbstractHttpAdapter, HttpService);
 * ```
 */
export function registerImplicitService(
  abstractToken: AnyToken,
  service: ServiceDef<any, any>,
): void {
  if (!implicitServices.has(abstractToken)) {
    implicitServices.set(abstractToken, service);
  }
}

/** Read the current implicit-service registry (map of abstract → concrete). */
export function getImplicitServices(): ReadonlyMap<AnyToken, ServiceDef<any, any>> {
  return implicitServices;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Represents a missing dependency.
 */
export interface MissingDependency {
  /** The token that is required */
  required: AnyToken
  /** What requires this token */
  requiredBy: string
  /** Human-readable description of the required token */
  requiredDescription: string
}

/**
 * Represents the dependency graph for validation.
 */
export interface DependencyGraph {
  /** All tokens that are provided */
  provided: Map<AnyToken, string>
  /** All tokens that are required, with what requires them */
  required: Map<AnyToken, Set<string>>
}

// ============================================================================
// Dependency Error
// ============================================================================

/**
 * Error thrown when dependencies are missing.
 */
export class DependencyError extends Error {
  constructor(public readonly missing: MissingDependency[]) {
    super(formatDependencyError(missing));
    this.name = 'DependencyError';
  }
}

/**
 * Format a dependency error message.
 */
function formatDependencyError(missing: MissingDependency[]): string {
  const lines: string[] = [
    'Missing dependencies:',
    '',
  ];

  // Group by requiredBy
  const grouped = new Map<string, MissingDependency[]>();
  for (const dep of missing) {
    const existing = grouped.get(dep.requiredBy) ?? [];
    existing.push(dep);
    grouped.set(dep.requiredBy, existing);
  }

  for (const [requiredBy, deps] of grouped) {
    lines.push(`  ${requiredBy} requires:`);
    for (const dep of deps) {
      lines.push(`    - ${dep.requiredDescription}`);
    }
    lines.push('');
  }

  lines.push('Hints:');
  lines.push('  - Make sure all required services are added before the services that depend on them');
  lines.push('  - Use bindRepository() to bind ModelRepository tokens');
  lines.push('  - Check that features have their requirements satisfied');

  return lines.join('\n');
}

// ============================================================================
// Dependency Graph Building
// ============================================================================

/**
 * Get a human-readable name for a token.
 */
export function getTokenDescription(token: AnyToken): string {
  // Token could be a symbol, function, or object with toString
  const t = token as unknown;
  if (typeof t === 'symbol') {
    return t.description ?? String(t);
  }
  if (typeof t === 'function') {
    return t.name || 'Anonymous';
  }
  if (typeof t === 'object' && t !== null) {
    // Check if it's a ServiceDef (has deps and factory)
    if (isServiceDef(t)) {
      // Try to get a name from the deps - e.g. "Service { client: AbstractPostgresClient }"
      const depNames = Object.entries(t.deps ?? {})
        .map(([key, dep]) => `${key}: ${getTokenDescription(dep as AnyToken)}`)
        .join(', ');
      return depNames ? `Service { ${depNames} }` : 'Anonymous Service';
    }
    // Resolvable tokens (Config.of / Secret.of / FeatureFlag.of) carry a description field
    if ('description' in t && typeof (t as { description: unknown }).description === 'string') {
      return (t as { description: string }).description;
    }
    // Try toString
    if ('toString' in t) {
      const result = (t as { toString(): string }).toString();
      if (result !== '[object Object]') {
        return result;
      }
    }
  }
  return String(t);
}

/**
 * Extract dependencies from a service definition.
 */
export function extractServiceDeps(service: ServiceDef<any, any>): AnyToken[] {
  return Object.values(service.deps ?? {}) as AnyToken[];
}

/**
 * Extract requirements from a feature.
 */
export function extractFeatureRequirements(feature: FeatureToken<any, any>): AnyToken[] {
  const meta = getFeatureMetadata(feature);
  return meta?.requires ?? [];
}

/**
 * Build a dependency graph from components.
 */
export function buildDependencyGraph(
  services: ServiceDef<any, any>[],
  repoBindings: RepositoryBinding<any>[],
  serviceBindings: ServiceBinding<any>[],
  instanceBindings: InstanceBinding<any>[],
  features: FeatureToken<any, any>[]
): DependencyGraph {
  const provided = new Map<AnyToken, string>();
  const required = new Map<AnyToken, Set<string>>();

  // Built-in tokens (auto-provided by the container/cluster builder)
  provided.set(Logger as any, 'Logger (built-in)');
  provided.set(Lifecycle as any, 'Lifecycle (built-in)');
  provided.set(AbstractContainer as any, 'AbstractContainer (built-in)');

  // Tokens provided by plugins (e.g., AbstractProcessExecutor from @justscale/process/cluster)
  for (const token of pluginProvides) {
    provided.set(token, `${getTokenDescription(token)} (provided by plugin)`);
  }

  // Services provide themselves
  for (const service of services) {
    const name = getTokenDescription(service as any);
    provided.set(service as any, name);

    // Check if service has explicit provides metadata
    const provides = getServiceProvides(service);
    if (provides) {
      for (const token of provides) {
        provided.set(token, `${name} (provides ${getTokenDescription(token)})`);
      }
    }

    // Track what they require
    for (const dep of extractServiceDeps(service)) {
      const reqBy = required.get(dep) ?? new Set();
      reqBy.add(name);
      required.set(dep, reqBy);
    }
  }

  // Repository bindings provide their tokens
  for (const binding of repoBindings) {
    const name = getTokenDescription(binding.token as AnyToken);
    provided.set(binding.token as AnyToken, name);
  }

  // Service bindings provide the abstract token
  for (const binding of serviceBindings) {
    const name = getTokenDescription(binding.token as AnyToken);
    provided.set(binding.token as AnyToken, name);
  }

  // Instance bindings provide the abstract token
  for (const binding of instanceBindings) {
    const name = getTokenDescription(binding.token as AnyToken);
    provided.set(binding.token as AnyToken, name);
  }

  // Features track their requirements AND what they provide
  for (const feature of features) {
    const meta = getFeatureMetadata(feature);
    const name = meta?.name ?? 'Anonymous Feature';

    // Track requirements
    for (const req of extractFeatureRequirements(feature)) {
      const reqBy = required.get(req) ?? new Set();
      reqBy.add(`Feature: ${name}`);
      required.set(req, reqBy);
    }

    // Expand feature to see what it provides
    // Feature is a function that takes a builder and returns a builder with additions
    const featureProvides = expandFeatureProvides(feature);
    for (const token of featureProvides) {
      provided.set(token, `Feature: ${name}`);
    }
  }

  return { provided, required };
}

/**
 * Expand a feature to see what tokens it provides.
 * Features are functions that take a builder and return a builder with additions.
 * We call the feature with a tracking builder to collect what gets added.
 *
 * The feature token itself is also registered as provided, so that a
 * downstream feature using `.requires(otherFeature)` is satisfied by the
 * parent having `.add(otherFeature)`.
 */
function expandFeatureProvides(feature: FeatureToken<any, any>): AnyToken[] {
  // The feature token itself counts as provided - features referenced via
  // `.requires(otherFeature)` are token-level requirements and must be
  // matched by the presence of the feature, not by the services it adds.
  const providedTokens: AnyToken[] = [feature as AnyToken];

  // Create a minimal mock builder that tracks what gets added
  const trackingBuilder: any = {
    add(component: unknown): any {
      // Track services (both defineService object-form and class-extends forms)
      if (isServiceDef(component)) {
        providedTokens.push(component as any);
        // Check for explicit provides metadata
        const provides = getServiceProvides(component);
        if (provides) {
          providedTokens.push(...provides);
        }
      }
      // Track nested features - their token satisfies a downstream
      // `.requires(nestedFeature)` the same way the outer feature does.
      if (isFeatureToken(component)) {
        providedTokens.push(component as AnyToken);
      }
      // Track repository bindings
      if (isRepositoryBinding(component)) {
        providedTokens.push((component as any).token);
      }
      return trackingBuilder;
    },
  };

  try {
    // Call the feature function to see what it adds
    feature(trackingBuilder);
  } catch (err) {
    const name = (feature as any).name || 'unknown';
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[builder] Feature expansion failed for "${name}": ${msg}`);
  }

  return providedTokens;
}

/**
 * Find all missing dependencies.
 */
export function findMissingDependencies(graph: DependencyGraph): MissingDependency[] {
  const missing: MissingDependency[] = [];

  for (const [token, requiredBy] of graph.required) {
    if (!graph.provided.has(token)) {
      for (const by of requiredBy) {
        missing.push({
          required: token,
          requiredBy: by,
          requiredDescription: getTokenDescription(token),
        });
      }
    }
  }

  return missing;
}

/**
 * Options for validateDependencies.
 */
export interface ValidationOptions {
  /** Additional tokens that are provided (e.g., storage classes detected at build time) */
  additionalProvides?: AnyToken[]
  /**
   * Additional tokens that a caller (e.g. an embedded sub-app) needs
   * this scope to provide. Used to bubble sub-app requires up into the
   * parent's build-time dependency check.
   */
  additionalRequires?: AnyToken[]
}

/**
 * Validate a dependency graph.
 * Throws DependencyError if there are missing dependencies.
 */
export function validateDependencies(
  services: ServiceDef<any, any>[],
  repoBindings: RepositoryBinding<any>[],
  serviceBindings: ServiceBinding<any>[],
  instanceBindings: InstanceBinding<any>[],
  features: FeatureToken<any, any>[],
  options?: ValidationOptions
): void {
  const graph = buildDependencyGraph(services, repoBindings, serviceBindings, instanceBindings, features);

  // Add additional provided tokens
  if (options?.additionalProvides) {
    for (const token of options.additionalProvides) {
      const name = getTokenDescription(token);
      graph.provided.set(token, `${name} (provided at build time)`);
    }
  }

  // Add additional required tokens (e.g. from embedded sub-apps).
  if (options?.additionalRequires) {
    for (const token of options.additionalRequires) {
      const name = getTokenDescription(token);
      const existing = graph.required.get(token) ?? new Set<string>();
      existing.add(`${name} (required by sub-app)`);
      graph.required.set(token, existing);
    }
  }

  const missing = findMissingDependencies(graph);

  if (missing.length > 0) {
    throw new DependencyError(missing);
  }
}
