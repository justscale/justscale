/**
 * Core permission types.
 */

import type { Condition, RefTraversal } from '@justscale/core/models';
import type { Reference } from '@justscale/core/models';
import type { GuardDef } from '@justscale/core';

export type { RefTraversal } from '@justscale/core/models';

/** Runtime marker for permission definitions */
export const PERMISSION_DEF = Symbol.for('@justscale/permission:permissionDef');

/**
 * A resolved principal - who is performing the action.
 * The type is the model class, ref is the typed reference.
 */
export interface Principal {
  readonly type: abstract new (...args: any[]) => any;
  readonly ref: Reference<any>;
}

/**
 * A field expression accessor - returns a field expression object that
 * exposes the field name via `.eq()` which returns an `EqCondition`.
 */
export type FieldExpr = {
  eq(value: any): { readonly type: 'eq'; readonly field: string; readonly value: unknown };
};

/** Field accessor: either a field expression, a traversal, or a zero-arg lambda returning one */
export type FieldAccessor = FieldExpr | RefTraversal | (() => FieldExpr | RefTraversal);

/** Mode of a single permission rule */
export type PermissionMode = 'when' | 'always' | 'check' | 'explicit' | 'create';

/**
 * Base shape shared by all permission definitions.
 * Extends GuardDef so permission defs are directly usable as guards in route builders.
 */
export interface SinglePermissionDef<TSubject = any, TName extends string = string> extends GuardDef {
  readonly [PERMISSION_DEF]: true;
  readonly subjectClass: abstract new (...args: any[]) => TSubject;
  readonly mode: PermissionMode;
  /** Permission name - set by defineModel from the key in the permissions record */
  readonly name: TName;
  readonly fieldAccessor?: FieldAccessor;
  readonly checkFn?: (principalRef: Reference<TSubject>, resource: any) => boolean | Promise<boolean>;
}

/**
 * A queryable permission - supports `.toCondition()` for use in collection queries.
 * Produced by `.when()` and `.always()`.
 *
 * `toCondition(principal)` returns a `Condition` that can be used in `repo.find({ where })`.
 * - `when` mode: EqCondition (field = principalId)
 * - `always` mode: empty AndCondition (compiles to TRUE - no filtering)
 */
export interface QueryablePermissionDef<TSubject = any, TName extends string = string> extends SinglePermissionDef<TSubject, TName> {
  readonly mode: 'when' | 'always';
  toCondition(principal: Principal): Condition;
}

/** Type guard for SinglePermissionDef */
export function isPermissionDef(value: unknown): value is SinglePermissionDef {
  return (
    typeof value === 'object' &&
    value !== null &&
    PERMISSION_DEF in value &&
    (value as any)[PERMISSION_DEF] === true
  );
}

/** Type guard for QueryablePermissionDef */
export function isQueryablePermissionDef(value: unknown): value is QueryablePermissionDef {
  return isPermissionDef(value) && (value.mode === 'when' || value.mode === 'always');
}

/** A permission definition: one rule or an array of rules (any match = allow). */
export type AnyPermissionDef = SinglePermissionDef | readonly SinglePermissionDef[];
