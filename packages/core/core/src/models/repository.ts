/**
 * Repository Base
 *
 * Generic empty base class for repositories, used by core's DI system.
 * Repository<T> is intentionally empty - the contract depends on context:
 * ModelRepository adds CRUD operations; custom repositories define their own.
 */

// ============================================================================
// Symbols
// ============================================================================

/** Symbol to identify repository tokens */
export const REPO_TOKEN = Symbol('core:repositoryToken');

/** Symbol to brand Repository instances for type checking */
export const REPO_BRAND = Symbol('core:repositoryBrand');

// ============================================================================
// Repository Base Class
// ============================================================================

/**
 * Abstract base class for all repositories.
 *
 * Intentionally empty - subclasses define their own contracts.
 * Exists so core's DI system can work with any kind of repository.
 *
 * @typeParam T - The type this repository provides access to
 */
export abstract class Repository<T = unknown> {
  /** Brand to distinguish Repository from plain objects in type checking */
  declare readonly [REPO_BRAND]: true;
}

// ============================================================================
// Token Types
// ============================================================================

/** Brand for type-level token identification */
declare const TOKEN_BRAND: unique symbol;

/**
 * A generic repository token for dependency injection.
 *
 * This is the base token interface that all repository tokens extend.
 * Core's DI system uses this to wire up repositories without knowing
 * about the specific contract.
 *
 * @typeParam T - The entity type this repository provides access to
 * @typeParam TInstance - The repository instance type (defaults to Repository<T>)
 */
export interface RepositoryToken<T = unknown, TInstance = Repository<T>> {
  /** Type brand - makes Token<A> incompatible with Token<B> */
  readonly [TOKEN_BRAND]?: T
  /** Instance type brand - carries the actual instance type for DI */
  readonly __instanceType?: TInstance
  /** Symbol brand - runtime identification */
  readonly [REPO_TOKEN]: true
  /** Human-readable description */
  readonly description: string
  /** String representation */
  toString(): string
}

/**
 * Check if a value is a RepositoryToken.
 */
export function isRepositoryToken(value: unknown): value is RepositoryToken {
  return (
    typeof value === 'object' &&
    value !== null &&
    REPO_TOKEN in value &&
    (value as Record<symbol, unknown>)[REPO_TOKEN] === true
  );
}
