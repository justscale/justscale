/**
 * permit() builder - declares permission rules for models.
 *
 * @example
 * ```typescript
 * class Product extends defineModel({ fields: {...} }) {
 *   static can = {
 *     edit: permit(Seller).when(() => Product.fields.seller),
 *     view: permit(AppUser).always(),
 *     delete: [
 *       permit(Seller).when(() => Product.fields.seller),
 *       permit(Admin).always(),
 *     ],
 *   }
 * }
 * ```
 */

import { GUARD_DEF_MARKER, getAccessPrincipals, enterWithPrincipals } from '@justscale/core';
import { isReference, isRefTraversal, q, CONDITION } from '@justscale/core/models';
import type { Condition, EqCondition, HasCondition } from '@justscale/core/models';
import { AbstractPrincipalProvider } from './services/principal-provider.js';
import { Everyone } from './everyone.js';
import { PERMISSION_DEF } from './types.js';
import type { FieldExpr, FieldAccessor, RefTraversal, Principal, QueryablePermissionDef, SinglePermissionDef } from './types.js';

/** Resolve a FieldAccessor - accepts a field expression, traversal, or zero-arg lambda */
function resolveFieldAccessor(accessor: FieldAccessor): FieldExpr | RefTraversal {
  return typeof accessor === 'function' ? accessor() : accessor;
}
/**
 * Collect every Reference value in a params object.
 * Used by when-mode guards: every ref that resolves to an entity with the
 * permission's field must satisfy the rule (fail-closed against adversarial
 * param ordering like `{ friendlyRef, targetRef }`).
 */
function findAllReferences(
  params: Record<string, unknown>,
): import('@justscale/core/models').Reference<unknown>[] {
  const refs: import('@justscale/core/models').Reference<unknown>[] = [];
  for (const value of Object.values(params)) {
    if (isReference(value)) refs.push(value as import('@justscale/core/models').Reference<unknown>);
  }
  return refs;
}

/**
 * Extract the top-level field name a permission cares about.
 * For plain FieldExpr: fieldKey (e.g. 'seller').
 * For RefTraversal: first hop (e.g. 'ticket' from ['ticket', 'customer']).
 */
function getPermissionFieldName(resolved: FieldExpr | RefTraversal): string {
  if (isRefTraversal(resolved)) return resolved.path[0];
  // FieldExpr has a .fieldKey getter (FieldExprBase) - but type only exposes .eq().
  // Fall through .eq() to read the produced condition.field for safety.
  const anyResolved = resolved as FieldExpr & { fieldKey?: string };
  if (typeof anyResolved.fieldKey === 'string') return anyResolved.fieldKey;
  return resolved.eq(null).field;
}

/**
 * Find a principal matching the given subject class (supports subclass matching).
 */
function findPrincipal(
  principals: Principal[],
  subjectClass: abstract new (...args: any[]) => any,
): Principal | undefined {
  return principals.find((p) => p.type === subjectClass || p.type.prototype instanceof (subjectClass as any));
}

/**
 * Build the guard check function for a single permission def.
 */
function buildGuardCheck(
  subjectClass: abstract new (...args: any[]) => any,
  mode: SinglePermissionDef['mode'],
  fieldAccessor?: FieldAccessor,
  checkFn?: SinglePermissionDef['checkFn'],
) {
  return async (
    deps: { principals: InstanceType<typeof AbstractPrincipalProvider> },
    ctx: any,
  ): Promise<boolean> => {
    // Reuse principals resolved earlier in the chain (e.g. by the permissions middleware).
    // Only call resolve() when no one else has populated the store yet.
    let principals = getAccessPrincipals() as Principal[] | undefined;
    if (!principals) {
      principals = await deps.principals.resolve(ctx);
      enterWithPrincipals(principals as any);
    }

    // Everyone is always a valid principal - guaranteed by the spec. Rather than
    // relying on every provider to contribute it, we inject it here so that
    // `permit(Everyone).always()` works regardless of provider configuration.
    const everyonePrincipal: Principal = { type: Everyone, ref: Everyone.ref as any };
    const allPrincipals = principals!.some((p) => p.type === Everyone)
      ? principals!
      : [everyonePrincipal, ...principals!];

    const principal = findPrincipal(allPrincipals, subjectClass);

    if (!principal) return false;

    if (mode === 'always') return true;

    // 'create' mode: explicit create-semantics marker.
    // Allow for any principal of the subject type - no resource to check.
    if (mode === 'create') return true;

    if (mode === 'when' && fieldAccessor) {
      const params = ctx.params ?? {};
      const refs = findAllReferences(params);

      // Fail closed: when-mode REQUIRES a resource. No refs means the route either
      // forgot `.types({Model})` (string params) or genuinely has no resource.
      // Either way, route authors must use `permit(X).forCreate()` for
      // create-semantics or ensure the resource ref is typed.
      if (refs.length === 0) return false;

      const resolved = resolveFieldAccessor(fieldAccessor);
      const fieldName = getPermissionFieldName(resolved);

      // Resolve all refs in parallel. Any that fail to resolve yield null.
      const resolvedEntities = await Promise.all(
        refs.map((r) => Promise.resolve(r as unknown as Promise<unknown>).catch(() => null)),
      );

      // Keep only entities that carry the permission's field - these are the
      // "relevant" resources the rule actually guards. Other refs in params
      // (query-tokens, unrelated handles) are ignored.
      const relevant = resolvedEntities.filter(
        (r): r is Record<string, unknown> =>
          r !== null && r !== undefined && typeof r === 'object' && fieldName in (r as object),
      );

      if (relevant.length === 0) return false;

      // ALL relevant resources must satisfy the rule - prevents adversarial
      // param ordering (`{ friendlyRef, targetRef }`) from skipping a check
      // by planting a friendly ref earlier.
      for (const resource of relevant) {
        if (!(await matchesRule(resource, resolved, principal))) return false;
      }
      return true;
    }

    if (mode === 'check' && checkFn) {
      const params = ctx.params ?? {};
      const refs = findAllReferences(params);
      const resource = refs.length > 0 ? await (refs[0] as any) : undefined;
      try {
        return await checkFn(principal.ref, resource);
      } catch {
        // Predicate threw - fail closed. A misbehaving predicate must never
        // grant access or leak error details through an unexpected 500.
        return false;
      }
    }

    // 'explicit' mode — an unchained `permit(X)` denies everything. The
    // builder is reserved for future per-principal grants (`principal.grant(perm)`);
    // until that lands, deny-all is the correct fail-closed default and is
    // pinned by tests in by-permissions-adversarial.test.ts.
    return false;
  };
}

/**
 * Check whether a resolved entity satisfies the permission rule for a principal.
 * Handles both plain field-equality and multi-hop RefTraversal.
 */
async function matchesRule(
  resource: Record<string, unknown>,
  resolved: FieldExpr | RefTraversal,
  principal: Principal,
): Promise<boolean> {
  if (isRefTraversal(resolved)) {
    // Walk the path: resource -> resource[path[0]] -> ... -> leaf
    let entity: any = resource;
    for (let i = 0; i < resolved.path.length - 1; i++) {
      const fieldValue = entity[resolved.path[i]];
      if (isReference(fieldValue)) {
        entity = await fieldValue;
      } else {
        entity = fieldValue;
      }
      if (!entity) return false;
    }
    const leafField = resolved.path[resolved.path.length - 1];
    const leafValue = entity[leafField];
    if (isReference(leafValue)) return leafValue.identifier === principal.ref.identifier;
    if (leafValue && typeof leafValue === 'object' && 'identifier' in leafValue) {
      return (leafValue as any).identifier === principal.ref.identifier;
    }
    return false;
  }

  const fieldName = getPermissionFieldName(resolved);
  const fieldValue = (resource as any)[fieldName];
  if (isReference(fieldValue)) {
    return fieldValue.identifier === principal.ref.identifier;
  }
  // Persistent entity with identifier
  if (fieldValue && typeof fieldValue === 'object' && 'identifier' in fieldValue) {
    return (fieldValue as any).identifier === principal.ref.identifier;
  }
  return false;
}

/**
 * Creates a QueryablePermissionDef that is also a GuardDef.
 * Supports `.toCondition(principal)` for use in collection queries.
 */
function createQueryablePermissionDef<TSubject>(
  subjectClass: abstract new (...args: any[]) => TSubject,
  mode: 'when' | 'always',
  fieldAccessor?: FieldAccessor,
): QueryablePermissionDef<TSubject> {
  const check = buildGuardCheck(subjectClass, mode, fieldAccessor);

  const toCondition = (principal: Principal): Condition => {
    if (mode === 'always') {
      // Empty AND = TRUE - no WHERE clause filtering (principal type check is done at guard level)
      return q.and();
    }
    // when: field must equal principal's ref identifier (or traverse a ref chain)
    const resolved = resolveFieldAccessor(fieldAccessor!);
    if (isRefTraversal(resolved)) {
      // Build nested HasCondition from the traversal path.
      // path = ['ticket', 'customer'] -> HasCondition { field: 'ticket', condition: EqCondition { field: 'customer', value: principalId } }
      const { path } = resolved;
      const principalId = principal.ref.identifier;
      // Build from the inside out: last segment is an EqCondition
      let inner: Condition = { [CONDITION]: true, type: 'eq', field: path[path.length - 1], value: principalId } as EqCondition;
      for (let i = path.length - 2; i >= 0; i--) {
        inner = { [CONDITION]: true, type: 'has', field: path[i], condition: inner } as HasCondition;
      }
      return inner;
    }
    return resolved.eq(principal.ref) as unknown as Condition;
  };

  return {
    [PERMISSION_DEF]: true,
    subjectClass,
    mode,
    fieldAccessor,
    name: '', // Set by defineModel from the permissions record key
    toCondition,
    // GuardDef compatibility:
    __kind: GUARD_DEF_MARKER,
    deps: { principals: AbstractPrincipalProvider },
    factory: (deps: any) => (ctx: any) => check(deps, ctx),
  } as unknown as QueryablePermissionDef<TSubject>;
}

/**
 * Creates a SinglePermissionDef for create mode.
 * Allows when a principal of the subject type is present, independent of
 * params. Used for explicit create-semantics so `.when()` can fail closed on
 * routes that lack a resource ref.
 */
function createCreatePermissionDef<TSubject>(
  subjectClass: abstract new (...args: any[]) => TSubject,
): SinglePermissionDef<TSubject> {
  const check = buildGuardCheck(subjectClass, 'create');

  return {
    [PERMISSION_DEF]: true,
    subjectClass,
    mode: 'create',
    name: '',
    __kind: GUARD_DEF_MARKER,
    deps: { principals: AbstractPrincipalProvider },
    factory: (deps: any) => (ctx: any) => check(deps, ctx),
  } as unknown as SinglePermissionDef<TSubject>;
}

/**
 * Creates a SinglePermissionDef for check mode (not queryable).
 */
function createCheckPermissionDef<TSubject>(
  subjectClass: abstract new (...args: any[]) => TSubject,
  checkFn: SinglePermissionDef<TSubject>['checkFn'],
): SinglePermissionDef<TSubject> {
  const check = buildGuardCheck(subjectClass, 'check', undefined, checkFn);

  return {
    [PERMISSION_DEF]: true,
    subjectClass,
    mode: 'check',
    checkFn,
    name: '', // Set by defineModel from the permissions record key
    // GuardDef compatibility:
    __kind: GUARD_DEF_MARKER,
    deps: { principals: AbstractPrincipalProvider },
    factory: (deps: any) => (ctx: any) => check(deps, ctx),
  } as unknown as SinglePermissionDef<TSubject>;
}

/**
 * Builder returned by `permit(SubjectClass)`.
 * Can be used directly as an explicit-grant permission,
 * or chained with `.when()`, `.always()`, `.check()`.
 */
export class PermitBuilder<TSubject> implements SinglePermissionDef<TSubject> {
  readonly [PERMISSION_DEF] = true as const;
  readonly subjectClass: abstract new (...args: any[]) => TSubject;
  readonly mode = 'explicit' as const;
  readonly name: string = '';
  // GuardDef compatibility:
  readonly __kind: typeof GUARD_DEF_MARKER = GUARD_DEF_MARKER;
  readonly deps: { principals: typeof AbstractPrincipalProvider };
  readonly factory: (deps: any) => (ctx: any) => Promise<boolean>;

  constructor(subjectClass: abstract new (...args: any[]) => TSubject) {
    this.subjectClass = subjectClass;
    this.deps = { principals: AbstractPrincipalProvider };
    const check = buildGuardCheck(subjectClass, 'explicit');
    this.factory = (deps: any) => (ctx: any) => check(deps, ctx);
  }

  /**
   * Allow when a field on the resource matches the principal's ref.
   * The resulting permission is queryable via `.toCondition()`.
   *
   * @example
   * ```typescript
   * permit(Seller).when(f.fields.seller)
   * // guard:  seller_id must equal principal's id
   * // query:  .toCondition(principal) -> EqCondition { field: 'seller', value: 'seller-42' }
   * ```
   */
  when(field: FieldAccessor): QueryablePermissionDef<TSubject> {
    return createQueryablePermissionDef(this.subjectClass, 'when', field);
  }

  /**
   * Always allow for any principal of this type (e.g., Admin bypass).
   * The resulting permission is queryable via `.toCondition()` which returns TRUE (no filtering).
   *
   * @example
   * ```typescript
   * permit(Admin).always()
   * // guard:  always true for any Admin principal
   * // query:  .toCondition(principal) -> AndCondition([]) -> TRUE
   * ```
   */
  always(): QueryablePermissionDef<TSubject> {
    return createQueryablePermissionDef(this.subjectClass, 'always');
  }

  /**
   * Explicit create-semantics: allow for any principal of this type, no
   * resource ref required in params. Use on create routes so `.when()` can
   * fail closed when it sees no resource.
   *
   * `.when()` is for editing/deleting an existing resource; `.forCreate()`
   * documents that this action has nothing to check against yet.
   *
   * @example
   * ```typescript
   * class Product extends defineModel({
   *   permissions: ({ seller }) => ({
   *     create: permit(Seller).forCreate(),
   *     edit:   permit(Seller).when(seller),
   *   }),
   * }) {}
   * ```
   */
  forCreate(): SinglePermissionDef<TSubject> {
    return createCreatePermissionDef(this.subjectClass);
  }

  /**
   * Custom check function - not queryable.
   * Use for logic that cannot be expressed as a field comparison.
   *
   * @example
   * ```typescript
   * permit(User).check((userRef, resource) => resource.ownerId === userRef.identifier)
   * ```
   */
  check(fn: (principalRef: import('@justscale/core/models').Reference<TSubject>, resource: any) => boolean | Promise<boolean>): SinglePermissionDef<TSubject> {
    return createCheckPermissionDef(this.subjectClass, fn);
  }
}

/**
 * Declare a permission rule for a model action.
 *
 * @param subjectClass - The model class that gets this permission.
 *
 * @example
 * ```typescript
 * class Product extends defineModel({ fields: {...} }) {
 *   static can = {
 *     create: permit(Seller),
 *     edit: permit(Seller).when(() => Product.fields.seller),
 *     view: permit(AppUser).always(),
 *     delete: [
 *       permit(Seller).when(() => Product.fields.seller),
 *       permit(Admin).always(),
 *     ],
 *   }
 * }
 * ```
 */
export function permit<TSubject>(
  subjectClass: abstract new (...args: any[]) => TSubject,
): PermitBuilder<TSubject> {
  return new PermitBuilder(subjectClass);
}
