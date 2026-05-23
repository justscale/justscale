/**
 * Field-Level Access Evaluation
 *
 * Evaluates access rules against resolved principals to determine
 * which fields should be visible during serialization.
 */

import type { AccessPrincipal } from '../core/context.js';
import { ACCESS_RULES } from './symbols.js';
import { isReference } from './reference/reference.js';

/** Symbol used by permission defs - Symbol.for to match across packages */
const PERMISSION_DEF = Symbol.for('@justscale/permission:permissionDef');

/** Minimal shape of a permission def for access evaluation (duck-typed from @justscale/permission) */
interface PermissionDefLike {
  readonly subjectClass: abstract new (...args: unknown[]) => unknown;
  readonly mode: string;
  readonly fieldAccessor?: FieldAccessorLike;
}

/** Duck-typed field accessor - either a FieldExpr, RefTraversal, or a thunk returning one */
type FieldAccessorLike =
  | { eq(value: unknown): { readonly field: string } }
  | { readonly path: readonly string[] }
  | (() => FieldAccessorLike);

/** Duck-typed ref-like: has an identifier for comparison */
interface HasIdentifier {
  readonly identifier: string;
}

function isPermissionDefLike(value: unknown): value is PermissionDefLike {
  return typeof value === 'object' && value !== null && PERMISSION_DEF in value;
}

function hasIdentifier(value: unknown): value is HasIdentifier {
  return typeof value === 'object' && value !== null && 'identifier' in value;
}

function isRefTraversalLike(value: object): value is { readonly path: readonly string[] } {
  return 'path' in value && Array.isArray((value as { path: unknown }).path);
}

function isFieldExprLike(value: object): value is { eq(value: unknown): { readonly field: string } } {
  return 'eq' in value && typeof (value as { eq: unknown }).eq === 'function';
}

/**
 * Check if a single permission def matches any of the given principals
 * for a specific entity instance.
 */
function matchesPrincipal(
  def: PermissionDefLike,
  entity: Record<string, unknown>,
  principals: readonly AccessPrincipal[],
): boolean {
  const principal = principals.find(
    (p) => p.type === def.subjectClass || p.type.prototype instanceof (def.subjectClass as Function),
  );
  if (!principal) return false;
  if (def.mode === 'always') return true;

  if (def.mode === 'when' && def.fieldAccessor) {
    const accessor = typeof def.fieldAccessor === 'function' ? def.fieldAccessor() : def.fieldAccessor;
    if (!accessor || typeof accessor !== 'object') return false;

    // RefTraversal: walk the path on the entity
    if (isRefTraversalLike(accessor)) {
      let current: unknown = entity;
      for (let i = 0; i < accessor.path.length; i++) {
        current = (current as Record<string, unknown>)?.[accessor.path[i]];
        if (current && isReference(current)) {
          if (i === accessor.path.length - 1) {
            return (current as unknown as HasIdentifier).identifier === principal.ref.identifier;
          }
          return false; // can't traverse further without awaiting
        }
      }
      return hasIdentifier(current) && current.identifier === principal.ref.identifier;
    }

    // FieldExpr: get field name via .eq()
    if (isFieldExprLike(accessor)) {
      const condition = accessor.eq(principal.ref);
      const fieldValue = entity[condition.field];
      if (isReference(fieldValue)) {
        return (fieldValue as unknown as HasIdentifier).identifier === principal.ref.identifier;
      }
      return hasIdentifier(fieldValue) && fieldValue.identifier === principal.ref.identifier;
    }
  }

  return false;
}

/**
 * Normalize a see/set rule to extract the relevant portion.
 * Returns undefined if the rule has no `see` restriction (visible to all).
 */
function extractSeeRule(rule: unknown): unknown {
  if (typeof rule === 'object' && rule !== null && !Array.isArray(rule) && ('see' in rule || 'set' in rule)) {
    const objRule = rule as { see?: unknown; set?: unknown };
    if (objRule.see === undefined) return undefined; // no see restriction = visible to all
    return objRule.see;
  }
  return rule;
}

/**
 * Check if a field access rule allows visibility for the given principals.
 */
function isFieldVisible(
  rule: unknown,
  entity: Record<string, unknown>,
  principals: readonly AccessPrincipal[],
): boolean {
  const seeRule = extractSeeRule(rule);
  if (seeRule === undefined) return true; // { set: ... } without see = visible to all

  // Empty array = nobody
  if (Array.isArray(seeRule) && seeRule.length === 0) return false;

  // Single permission def
  if (isPermissionDefLike(seeRule)) {
    return matchesPrincipal(seeRule, entity, principals);
  }

  // Array of permission defs (OR semantics)
  if (Array.isArray(seeRule)) {
    return seeRule.some((def) =>
      isPermissionDefLike(def) && matchesPrincipal(def, entity, principals),
    );
  }

  return false;
}

/** Model class with optional access rules */
export interface ModelClassLike {
  readonly [ACCESS_RULES]?: Record<string, unknown>;
}

/**
 * Get the access rules from a model class (if any).
 */
export function getAccessRules(modelClass: ModelClassLike): Record<string, unknown> | undefined {
  return modelClass[ACCESS_RULES];
}

/**
 * Filter an entity's enumerable properties based on access rules and principals.
 * Returns a plain object with only the visible fields.
 *
 * - No access rules on model → returns all fields (backwards compatible)
 * - Field not in access rules → included (default: visible)
 * - Field in access rules → evaluated against principals
 */
export function filterByAccess(
  entity: Record<string, unknown>,
  modelClass: ModelClassLike,
  principals: readonly AccessPrincipal[],
): Record<string, unknown> {
  const rules = getAccessRules(modelClass);
  if (!rules) return { ...entity };

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(entity)) {
    const rule = rules[key];
    if (!rule) {
      result[key] = entity[key];
    } else if (isFieldVisible(rule, entity, principals)) {
      result[key] = entity[key];
    }
  }
  return result;
}
