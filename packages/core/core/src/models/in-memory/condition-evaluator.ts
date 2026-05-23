/**
 * Condition Evaluator for In-Memory Repository
 *
 * Evaluates query conditions against in-memory entities.
 * Supports all condition types from the query system.
 */

import type {
  Condition,
  EqCondition,
  NeqCondition,
  GtCondition,
  GteCondition,
  LtCondition,
  LteCondition,
  LikeCondition,
  ILikeCondition,
  InCondition,
  NotInCondition,
  BetweenCondition,
  IsNullCondition,
  IsNotNullCondition,
  StartsWithCondition,
  EndsWithCondition,
  ContainsCondition,
  BeforeCondition,
  AfterCondition,
  AndCondition,
  OrCondition,
  NotCondition,
  HasCondition,
  RawCondition,
  ArrayContainsCondition,
  ArrayHasAnyCondition,
  ArrayHasAllCondition,
  ArrayOverlapsCondition,
  OrderByItem,
  Aggregation,
} from '../query.js';
import { isOrderByItem } from '../query.js';
import type { Persistent } from '../types.js';
import type { FieldDef } from '../field.js';

// ============================================================================
// Relation Resolver
// ============================================================================

/**
 * Context for resolving related entities in has() conditions.
 */
export interface EvaluatorContext {
  /**
   * Resolve a related entity by ID.
   * Called when evaluating has() conditions.
   *
   * @param refId - The ID of the related entity
   * @param fieldDef - The field definition (contains refTarget for model info)
   * @returns The related entity or undefined if not found
   */
  resolveRef?: (refId: string, fieldDef: FieldDef) => Record<string, unknown> | undefined

  /**
   * Field definitions for the current model.
   * Required to get refTarget info for has() conditions.
   */
  fieldDefs?: Record<string, FieldDef>

  /**
   * Get field definitions for a related model from a ref field.
   * Required for nested has() conditions that traverse multiple relationships.
   *
   * @param fieldDef - The ref field definition (use refTarget to get the model)
   * @returns The related model's field definitions
   */
  getFieldDefsForRef?: (fieldDef: FieldDef) => Record<string, FieldDef> | undefined
}

// ============================================================================
// Condition Evaluator
// ============================================================================

/**
 * Resolve the actual storage field name, handling ref fields.
 * For ref fields, the ID is stored as `{fieldName}Id` (e.g., cart -> cartId).
 */
function resolveFieldName(field: string, fieldDefs?: Record<string, FieldDef>): string {
  if (!fieldDefs) {
    return field;
  }

  // Check if it's a top-level ref field
  const topLevelField = field.split('.')[0];
  const fieldDef = fieldDefs[topLevelField];

  if (fieldDef?.type === 'ref') {
    // For ref fields, the actual ID is stored as {fieldName}Id
    // Replace the top-level field name with {fieldName}Id
    if (field === topLevelField) {
      return `${field}Id`;
    }
    // For nested paths like 'cart.status', we're traversing into the related entity
    // This should be handled by has() instead
    return field;
  }

  if (fieldDef?.type === 'refs') {
    // For refs fields, the IDs are stored as {fieldName}Ids
    if (field === topLevelField) {
      return `${field}Ids`;
    }
    return field;
  }

  return field;
}

/**
 * Get a field value from an entity, supporting nested paths.
 */
function getFieldValue(entity: Record<string, unknown>, field: string, fieldDefs?: Record<string, FieldDef>): unknown {
  // Resolve ref field names to their storage names
  const resolvedField = resolveFieldName(field, fieldDefs);

  // Support nested paths like 'address.city'
  const parts = resolvedField.split('.');
  let value: unknown = entity;
  for (const part of parts) {
    if (value === null || value === undefined) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/**
 * Compare two values for ordering.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 */
function compareValues(a: unknown, b: unknown): number {
  // Handle null/undefined
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;

  // Dates
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() - b.getTime();
  }

  // BigInt
  if (typeof a === 'bigint' && typeof b === 'bigint') {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  // Numbers
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }

  // Strings - try numeric comparison first for decimal values
  if (typeof a === 'string' && typeof b === 'string') {
    const numA = parseFloat(a);
    const numB = parseFloat(b);
    // If both are valid numbers, compare numerically
    if (!isNaN(numA) && !isNaN(numB)) {
      return numA - numB;
    }
    return a.localeCompare(b);
  }

  // Mixed number/string - convert to number if possible
  if ((typeof a === 'number' || typeof a === 'string') &&
      (typeof b === 'number' || typeof b === 'string')) {
    const numA = typeof a === 'number' ? a : parseFloat(a);
    const numB = typeof b === 'number' ? b : parseFloat(b);
    if (!isNaN(numA) && !isNaN(numB)) {
      return numA - numB;
    }
  }

  // Fallback: convert to string
  return String(a).localeCompare(String(b));
}

/**
 * Evaluate an equality condition.
 */
function evalEq(entity: Record<string, unknown>, cond: EqCondition, ctx?: EvaluatorContext): boolean {
  const value = getFieldValue(entity, cond.field, ctx?.fieldDefs);
  const condValue = cond.value;

  // Handle Date comparison
  if (value instanceof Date && condValue instanceof Date) {
    return value.getTime() === condValue.getTime();
  }

  // Handle BigInt comparison
  if (typeof value === 'bigint' || typeof condValue === 'bigint') {
    return BigInt(value as bigint) === BigInt(condValue as bigint);
  }

  return value === condValue;
}

/**
 * Evaluate a not-equal condition.
 */
function evalNeq(entity: Record<string, unknown>, cond: NeqCondition, ctx?: EvaluatorContext): boolean {
  const value = getFieldValue(entity, cond.field, ctx?.fieldDefs);
  const condValue = cond.value;

  // Handle Date comparison
  if (value instanceof Date && condValue instanceof Date) {
    return value.getTime() !== condValue.getTime();
  }

  return value !== condValue;
}

/**
 * Evaluate a greater-than condition.
 */
function evalGt(entity: Record<string, unknown>, cond: GtCondition, ctx?: EvaluatorContext): boolean {
  const value = getFieldValue(entity, cond.field, ctx?.fieldDefs);
  return compareValues(value, cond.value) > 0;
}

/**
 * Evaluate a greater-than-or-equal condition.
 */
function evalGte(entity: Record<string, unknown>, cond: GteCondition, ctx?: EvaluatorContext): boolean {
  const value = getFieldValue(entity, cond.field, ctx?.fieldDefs);
  return compareValues(value, cond.value) >= 0;
}

/**
 * Evaluate a less-than condition.
 */
function evalLt(entity: Record<string, unknown>, cond: LtCondition, ctx?: EvaluatorContext): boolean {
  const value = getFieldValue(entity, cond.field, ctx?.fieldDefs);
  return compareValues(value, cond.value) < 0;
}

/**
 * Evaluate a less-than-or-equal condition.
 */
function evalLte(entity: Record<string, unknown>, cond: LteCondition, ctx?: EvaluatorContext): boolean {
  const value = getFieldValue(entity, cond.field, ctx?.fieldDefs);
  return compareValues(value, cond.value) <= 0;
}

/**
 * Convert a SQL LIKE pattern to a RegExp.
 * % matches any sequence of characters
 * _ matches any single character
 */
function likePatternToRegex(pattern: string, caseInsensitive = false): RegExp {
  // Escape regex special chars except % and _
  let regex = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  // Convert SQL wildcards to regex
  regex = regex.replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${regex}$`, caseInsensitive ? 'i' : '');
}

/**
 * Evaluate a LIKE condition.
 */
function evalLike(entity: Record<string, unknown>, cond: LikeCondition, ctx?: EvaluatorContext): boolean {
  const value = getFieldValue(entity, cond.field, ctx?.fieldDefs);
  if (typeof value !== 'string') return false;
  const regex = likePatternToRegex(cond.pattern);
  return regex.test(value);
}

/**
 * Evaluate a case-insensitive LIKE condition.
 */
function evalILike(entity: Record<string, unknown>, cond: ILikeCondition, ctx?: EvaluatorContext): boolean {
  const value = getFieldValue(entity, cond.field, ctx?.fieldDefs);
  if (typeof value !== 'string') return false;
  const regex = likePatternToRegex(cond.pattern, true);
  return regex.test(value);
}

/**
 * Evaluate an IN condition.
 */
function evalIn(entity: Record<string, unknown>, cond: InCondition, ctx?: EvaluatorContext): boolean {
  const value = getFieldValue(entity, cond.field, ctx?.fieldDefs);
  return cond.values.some((v) => {
    if (value instanceof Date && v instanceof Date) {
      return value.getTime() === v.getTime();
    }
    return value === v;
  });
}

/**
 * Evaluate a NOT IN condition.
 */
function evalNotIn(entity: Record<string, unknown>, cond: NotInCondition, ctx?: EvaluatorContext): boolean {
  const value = getFieldValue(entity, cond.field, ctx?.fieldDefs);
  return !cond.values.some((v) => {
    if (value instanceof Date && v instanceof Date) {
      return value.getTime() === v.getTime();
    }
    return value === v;
  });
}

/**
 * Evaluate a BETWEEN condition.
 */
function evalBetween(entity: Record<string, unknown>, cond: BetweenCondition, ctx?: EvaluatorContext): boolean {
  const value = getFieldValue(entity, cond.field, ctx?.fieldDefs);
  return compareValues(value, cond.min) >= 0 && compareValues(value, cond.max) <= 0;
}

/**
 * Evaluate an IS NULL condition.
 */
function evalIsNull(entity: Record<string, unknown>, cond: IsNullCondition, ctx?: EvaluatorContext): boolean {
  const value = getFieldValue(entity, cond.field, ctx?.fieldDefs);
  return value === null || value === undefined;
}

/**
 * Evaluate an IS NOT NULL condition.
 */
function evalIsNotNull(entity: Record<string, unknown>, cond: IsNotNullCondition, ctx?: EvaluatorContext): boolean {
  const value = getFieldValue(entity, cond.field, ctx?.fieldDefs);
  return value !== null && value !== undefined;
}

/**
 * Evaluate a startsWith condition.
 */
function evalStartsWith(entity: Record<string, unknown>, cond: StartsWithCondition, ctx?: EvaluatorContext): boolean {
  const value = getFieldValue(entity, cond.field, ctx?.fieldDefs);
  if (typeof value !== 'string') return false;
  return value.startsWith(cond.prefix);
}

/**
 * Evaluate an endsWith condition.
 */
function evalEndsWith(entity: Record<string, unknown>, cond: EndsWithCondition, ctx?: EvaluatorContext): boolean {
  const value = getFieldValue(entity, cond.field, ctx?.fieldDefs);
  if (typeof value !== 'string') return false;
  return value.endsWith(cond.suffix);
}

/**
 * Evaluate a contains condition.
 */
function evalContains(entity: Record<string, unknown>, cond: ContainsCondition, ctx?: EvaluatorContext): boolean {
  const value = getFieldValue(entity, cond.field, ctx?.fieldDefs);

  // Handle string contains
  if (typeof value === 'string') {
    return value.includes(cond.substring);
  }

  // Handle array contains
  if (Array.isArray(value)) {
    return value.includes(cond.substring);
  }

  return false;
}

/**
 * Evaluate a before condition (for dates).
 */
function evalBefore(entity: Record<string, unknown>, cond: BeforeCondition, ctx?: EvaluatorContext): boolean {
  const value = getFieldValue(entity, cond.field, ctx?.fieldDefs);
  if (!(value instanceof Date)) return false;
  return value.getTime() < cond.date.getTime();
}

/**
 * Evaluate an after condition (for dates).
 */
function evalAfter(entity: Record<string, unknown>, cond: AfterCondition, ctx?: EvaluatorContext): boolean {
  const value = getFieldValue(entity, cond.field, ctx?.fieldDefs);
  if (!(value instanceof Date)) return false;
  return value.getTime() > cond.date.getTime();
}

/**
 * Evaluate an AND condition.
 */
function evalAnd(entity: Record<string, unknown>, cond: AndCondition, ctx?: EvaluatorContext): boolean {
  return cond.conditions.every((c) => evaluateCondition(entity, c, ctx));
}

/**
 * Evaluate an OR condition.
 */
function evalOr(entity: Record<string, unknown>, cond: OrCondition, ctx?: EvaluatorContext): boolean {
  return cond.conditions.some((c) => evaluateCondition(entity, c, ctx));
}

/**
 * Evaluate a NOT condition.
 */
function evalNot(entity: Record<string, unknown>, cond: NotCondition, ctx?: EvaluatorContext): boolean {
  return !evaluateCondition(entity, cond.condition, ctx);
}

/**
 * Evaluate a HAS condition (for related entities).
 * Requires a resolver to look up related entities.
 */
function evalHas(entity: Record<string, unknown>, cond: HasCondition, ctx?: EvaluatorContext): boolean {
  if (!ctx?.resolveRef || !ctx?.fieldDefs) {
    throw new Error(
      'InMemoryRepository: HAS conditions require a relation resolver. ' +
      'Pass fieldDefs and resolveRef in the evaluator context.',
    );
  }

  const fieldDef = ctx.fieldDefs[cond.field];
  if (!fieldDef) {
    throw new Error(`Unknown field "${cond.field}" in has() condition.`);
  }

  if (fieldDef.type !== 'ref' && fieldDef.type !== 'refs') {
    throw new Error(`Field "${cond.field}" is not a ref/refs field (got: ${fieldDef.type}).`);
  }

  // Get the related model's field definitions for nested has() conditions
  // If getFieldDefsForRef is not provided, fall back to current fieldDefs (for self-refs)
  const relatedFieldDefs = ctx.getFieldDefsForRef?.(fieldDef) ?? ctx.fieldDefs;
  const nestedCtx: EvaluatorContext = {
    resolveRef: ctx.resolveRef,
    fieldDefs: relatedFieldDefs,
    getFieldDefsForRef: ctx.getFieldDefsForRef,
  };

  // Get the ref ID(s) from the entity
  // For ref fields, the value is stored as `fieldId` (e.g., authorId)
  const refIdField = `${cond.field}Id`;
  const refId = entity[refIdField] as string | undefined;

  if (fieldDef.type === 'ref') {
    // Single reference
    if (!refId) {
      return false; // No related entity
    }

    const related = ctx.resolveRef(refId, fieldDef);
    if (!related) {
      return false; // Related entity not found
    }

    // Evaluate the nested condition against the related entity
    return evaluateCondition(related, cond.condition, nestedCtx);
  } else {
    // Multiple references (refs)
    const refIdsField = `${cond.field}Ids`;
    const refIds = entity[refIdsField] as string[] | undefined;

    if (!refIds || refIds.length === 0) {
      return false;
    }

    // Check if ANY related entity matches the condition
    for (const id of refIds) {
      const related = ctx.resolveRef(id, fieldDef);
      if (related && evaluateCondition(related, cond.condition, nestedCtx)) {
        return true;
      }
    }
    return false;
  }
}

/**
 * Evaluate a RAW condition.
 * Note: Raw SQL is not supported in-memory.
 */
function evalRaw(_entity: Record<string, unknown>, _cond: RawCondition): boolean {
  throw new Error('InMemoryRepository: RAW SQL conditions are not supported in-memory.');
}

/**
 * Evaluate an arrayContains condition.
 * Returns true if the array field contains the specified value.
 */
function evalArrayContains(entity: Record<string, unknown>, cond: ArrayContainsCondition, ctx?: EvaluatorContext): boolean {
  const value = getFieldValue(entity, cond.field, ctx?.fieldDefs);
  if (!Array.isArray(value)) return false;
  return value.includes(cond.value);
}

/**
 * Evaluate an arrayHasAny condition.
 * Returns true if the array field contains any of the specified values.
 */
function evalArrayHasAny(entity: Record<string, unknown>, cond: ArrayHasAnyCondition, ctx?: EvaluatorContext): boolean {
  const value = getFieldValue(entity, cond.field, ctx?.fieldDefs);
  if (!Array.isArray(value)) return false;
  return cond.values.some((v) => value.includes(v));
}

/**
 * Evaluate an arrayHasAll condition.
 * Returns true if the array field contains all of the specified values.
 */
function evalArrayHasAll(entity: Record<string, unknown>, cond: ArrayHasAllCondition, ctx?: EvaluatorContext): boolean {
  const value = getFieldValue(entity, cond.field, ctx?.fieldDefs);
  if (!Array.isArray(value)) return false;
  return cond.values.every((v) => value.includes(v));
}

/**
 * Evaluate an arrayOverlaps condition.
 * Returns true if the array field shares any elements with the specified values.
 */
function evalArrayOverlaps(entity: Record<string, unknown>, cond: ArrayOverlapsCondition, ctx?: EvaluatorContext): boolean {
  const value = getFieldValue(entity, cond.field, ctx?.fieldDefs);
  if (!Array.isArray(value)) return false;
  return cond.values.some((v) => value.includes(v));
}

/**
 * Evaluate a condition against an entity.
 *
 * @param entity - The entity to evaluate
 * @param condition - The condition to check
 * @param ctx - Optional context for relation resolution (required for has() conditions)
 */
export function evaluateCondition(
  entity: Record<string, unknown>,
  condition: Condition,
  ctx?: EvaluatorContext,
): boolean {
  switch (condition.type) {
    case 'eq':
      return evalEq(entity, condition, ctx);
    case 'neq':
      return evalNeq(entity, condition, ctx);
    case 'gt':
      return evalGt(entity, condition, ctx);
    case 'gte':
      return evalGte(entity, condition, ctx);
    case 'lt':
      return evalLt(entity, condition, ctx);
    case 'lte':
      return evalLte(entity, condition, ctx);
    case 'like':
      return evalLike(entity, condition, ctx);
    case 'ilike':
      return evalILike(entity, condition, ctx);
    case 'in':
      return evalIn(entity, condition, ctx);
    case 'notIn':
      return evalNotIn(entity, condition, ctx);
    case 'between':
      return evalBetween(entity, condition, ctx);
    case 'isNull':
      return evalIsNull(entity, condition, ctx);
    case 'isNotNull':
      return evalIsNotNull(entity, condition, ctx);
    case 'startsWith':
      return evalStartsWith(entity, condition, ctx);
    case 'endsWith':
      return evalEndsWith(entity, condition, ctx);
    case 'contains':
      return evalContains(entity, condition, ctx);
    case 'before':
      return evalBefore(entity, condition, ctx);
    case 'after':
      return evalAfter(entity, condition, ctx);
    case 'and':
      return evalAnd(entity, condition, ctx);
    case 'or':
      return evalOr(entity, condition, ctx);
    case 'not':
      return evalNot(entity, condition, ctx);
    case 'has':
      return evalHas(entity, condition, ctx);
    case 'raw':
      return evalRaw(entity, condition);
    case 'arrayContains':
      return evalArrayContains(entity, condition, ctx);
    case 'arrayHasAny':
      return evalArrayHasAny(entity, condition, ctx);
    case 'arrayHasAll':
      return evalArrayHasAll(entity, condition, ctx);
    case 'arrayOverlaps':
      return evalArrayOverlaps(entity, condition, ctx);
    default:
      throw new Error(`Unknown condition type: ${(condition as Condition).type}`);
  }
}

// ============================================================================
// Sorting
// ============================================================================

/**
 * Sort entities by the given order specification.
 */
export function sortEntities<T>(
  entities: Persistent<T>[],
  orderBy: Record<string, 'asc' | 'desc'> | OrderByItem[],
): Persistent<T>[] {
  // Normalize to array of OrderByItem-like objects
  const orderItems: Array<{ field: string; direction: 'asc' | 'desc'; nulls?: 'first' | 'last' }> = [];

  if (Array.isArray(orderBy)) {
    for (const item of orderBy) {
      if (isOrderByItem(item)) {
        orderItems.push(item);
      }
    }
  } else {
    for (const [field, direction] of Object.entries(orderBy)) {
      orderItems.push({ field, direction });
    }
  }

  if (orderItems.length === 0) {
    return entities;
  }

  return [...entities].sort((a, b) => {
    for (const item of orderItems) {
      const aVal = getFieldValue(a as Record<string, unknown>, item.field);
      const bVal = getFieldValue(b as Record<string, unknown>, item.field);

      // Handle nulls
      const aIsNull = aVal === null || aVal === undefined;
      const bIsNull = bVal === null || bVal === undefined;

      if (aIsNull && bIsNull) continue;
      if (aIsNull) {
        return item.nulls === 'first' ? -1 : 1;
      }
      if (bIsNull) {
        return item.nulls === 'first' ? 1 : -1;
      }

      const cmp = compareValues(aVal, bVal);
      if (cmp !== 0) {
        return item.direction === 'desc' ? -cmp : cmp;
      }
    }
    return 0;
  });
}

// ============================================================================
// Aggregation
// ============================================================================

/**
 * Compute an aggregation over entities.
 */
export function computeAggregation<T>(
  entities: Persistent<T>[],
  aggregation: Aggregation,
): number | null {
  switch (aggregation.type) {
    case 'count': {
      if (aggregation.field) {
        // Count non-null values of specific field
        const values = entities
          .map((e) => getFieldValue(e as Record<string, unknown>, aggregation.field!))
          .filter((v) => v !== null && v !== undefined);
        if (aggregation.distinct) {
          return new Set(values).size;
        }
        return values.length;
      }
      // Count all rows
      return entities.length;
    }

    case 'sum': {
      let sum = 0;
      for (const entity of entities) {
        const value = getFieldValue(entity as Record<string, unknown>, aggregation.field);
        if (value !== null && value !== undefined) {
          sum += Number(value);
        }
      }
      return sum;
    }

    case 'avg': {
      let sum = 0;
      let count = 0;
      for (const entity of entities) {
        const value = getFieldValue(entity as Record<string, unknown>, aggregation.field);
        if (value !== null && value !== undefined) {
          sum += Number(value);
          count++;
        }
      }
      return count > 0 ? sum / count : null;
    }

    case 'min': {
      let min: unknown = null;
      for (const entity of entities) {
        const value = getFieldValue(entity as Record<string, unknown>, aggregation.field);
        if (value !== null && value !== undefined) {
          if (min === null || compareValues(value, min) < 0) {
            min = value;
          }
        }
      }
      return min === null ? null : Number(min);
    }

    case 'max': {
      let max: unknown = null;
      for (const entity of entities) {
        const value = getFieldValue(entity as Record<string, unknown>, aggregation.field);
        if (value !== null && value !== undefined) {
          if (max === null || compareValues(value, max) > 0) {
            max = value;
          }
        }
      }
      return max === null ? null : Number(max);
    }

    default:
      throw new Error(`Unknown aggregation type: ${(aggregation as Aggregation).type}`);
  }
}
