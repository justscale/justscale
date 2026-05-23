/**
 * Query System
 *
 * Provides type-safe field expressions for building queries.
 *
 * @example
 * ```typescript
 * const { status, createdAt, author } = Post.fields;
 *
 * await postRepo.find({
 *   where: q.and(
 *     status.eq('published'),
 *     createdAt.after(lastWeek),
 *     author.eq(currentUser),
 *   ),
 * });
 * ```
 */

import type { FieldDef, FieldType } from './field.js';
import { type Reference, isReference } from './reference/reference.js';
import { ADAPTER_KEY } from './symbols.js';

// ============================================================================
// Condition Types (AST)
// ============================================================================

/** Symbol to mark a condition */
export const CONDITION = Symbol('models:condition');

/** Base condition with marker */
interface ConditionBase {
  readonly [CONDITION]: true;
}

/** Equality condition */
export interface EqCondition extends ConditionBase {
  readonly type: 'eq';
  readonly field: string;
  readonly value: unknown;
}

/** Not equal condition */
export interface NeqCondition extends ConditionBase {
  readonly type: 'neq';
  readonly field: string;
  readonly value: unknown;
}

/** Greater than condition */
export interface GtCondition extends ConditionBase {
  readonly type: 'gt';
  readonly field: string;
  readonly value: unknown;
}

/** Greater than or equal condition */
export interface GteCondition extends ConditionBase {
  readonly type: 'gte';
  readonly field: string;
  readonly value: unknown;
}

/** Less than condition */
export interface LtCondition extends ConditionBase {
  readonly type: 'lt';
  readonly field: string;
  readonly value: unknown;
}

/** Less than or equal condition */
export interface LteCondition extends ConditionBase {
  readonly type: 'lte';
  readonly field: string;
  readonly value: unknown;
}

/** LIKE pattern condition */
export interface LikeCondition extends ConditionBase {
  readonly type: 'like';
  readonly field: string;
  readonly pattern: string;
}

/** Case-insensitive LIKE condition */
export interface ILikeCondition extends ConditionBase {
  readonly type: 'ilike';
  readonly field: string;
  readonly pattern: string;
}

/** IN list condition */
export interface InCondition extends ConditionBase {
  readonly type: 'in';
  readonly field: string;
  readonly values: unknown[];
}

/** NOT IN list condition */
export interface NotInCondition extends ConditionBase {
  readonly type: 'notIn';
  readonly field: string;
  readonly values: unknown[];
}

/** BETWEEN condition */
export interface BetweenCondition extends ConditionBase {
  readonly type: 'between';
  readonly field: string;
  readonly min: unknown;
  readonly max: unknown;
}

/** IS NULL condition */
export interface IsNullCondition extends ConditionBase {
  readonly type: 'isNull';
  readonly field: string;
}

/** IS NOT NULL condition */
export interface IsNotNullCondition extends ConditionBase {
  readonly type: 'isNotNull';
  readonly field: string;
}

/** Starts with condition (LIKE 'pattern%') */
export interface StartsWithCondition extends ConditionBase {
  readonly type: 'startsWith';
  readonly field: string;
  readonly prefix: string;
}

/** Ends with condition (LIKE '%pattern') */
export interface EndsWithCondition extends ConditionBase {
  readonly type: 'endsWith';
  readonly field: string;
  readonly suffix: string;
}

/** Contains condition (LIKE '%pattern%') */
export interface ContainsCondition extends ConditionBase {
  readonly type: 'contains';
  readonly field: string;
  readonly substring: string;
}

/** Array contains single element condition */
export interface ArrayContainsCondition extends ConditionBase {
  readonly type: 'arrayContains';
  readonly field: string;
  readonly value: unknown;
}

/** Array has any of values condition */
export interface ArrayHasAnyCondition extends ConditionBase {
  readonly type: 'arrayHasAny';
  readonly field: string;
  readonly values: unknown[];
}

/** Array has all of values condition */
export interface ArrayHasAllCondition extends ConditionBase {
  readonly type: 'arrayHasAll';
  readonly field: string;
  readonly values: unknown[];
}

/** Array overlaps with values condition */
export interface ArrayOverlapsCondition extends ConditionBase {
  readonly type: 'arrayOverlaps';
  readonly field: string;
  readonly values: unknown[];
}

/** Before date condition */
export interface BeforeCondition extends ConditionBase {
  readonly type: 'before';
  readonly field: string;
  readonly date: Date;
}

/** After date condition */
export interface AfterCondition extends ConditionBase {
  readonly type: 'after';
  readonly field: string;
  readonly date: Date;
}

/** AND logical condition */
export interface AndCondition extends ConditionBase {
  readonly type: 'and';
  readonly conditions: Condition[];
}

/** OR logical condition */
export interface OrCondition extends ConditionBase {
  readonly type: 'or';
  readonly conditions: Condition[];
}

/** NOT logical condition */
export interface NotCondition extends ConditionBase {
  readonly type: 'not';
  readonly condition: Condition;
}

/** Has related entity matching condition (for JOINs) */
export interface HasCondition extends ConditionBase {
  readonly type: 'has';
  readonly field: string;
  readonly condition: Condition;
}

/** Raw SQL condition (escape hatch) */
export interface RawCondition extends ConditionBase {
  readonly type: 'raw';
  readonly sql: string;
  readonly values: unknown[];
}

/** All condition types */
export type Condition =
  | EqCondition
  | NeqCondition
  | GtCondition
  | GteCondition
  | LtCondition
  | LteCondition
  | LikeCondition
  | ILikeCondition
  | InCondition
  | NotInCondition
  | BetweenCondition
  | IsNullCondition
  | IsNotNullCondition
  | StartsWithCondition
  | EndsWithCondition
  | ContainsCondition
  | ArrayContainsCondition
  | ArrayHasAnyCondition
  | ArrayHasAllCondition
  | ArrayOverlapsCondition
  | BeforeCondition
  | AfterCondition
  | AndCondition
  | OrCondition
  | NotCondition
  | HasCondition
  | RawCondition;

// ============================================================================
// Condition Factories
// ============================================================================

function createCondition<T extends Condition>(cond: Omit<T, typeof CONDITION>): T {
  return { [CONDITION]: true, ...cond } as T;
}

// ============================================================================
// Field Expression Base
// ============================================================================

/** Order by item */
export interface OrderByItem {
  readonly __orderBy: true;
  readonly field: string;
  readonly direction: 'asc' | 'desc';
  readonly nulls?: 'first' | 'last';
}

/** Symbol to identify OrderByItem */
export const ORDER_BY = Symbol('models:orderBy');

/** Create an order by item */
function createOrderBy(field: string, direction: 'asc' | 'desc', nulls?: 'first' | 'last'): OrderByItem {
  return { __orderBy: true, field, direction, nulls };
}

/** Check if value is an OrderByItem */
export function isOrderByItem(value: unknown): value is OrderByItem {
  return (
    value !== null &&
    typeof value === 'object' &&
    '__orderBy' in value &&
    (value as OrderByItem).__orderBy === true
  );
}

/** Base class for field expressions */
abstract class FieldExprBase {
  constructor(
    protected readonly fieldName: string,
    protected readonly fieldDef: FieldDef,
  ) {}

  /** The field name (for traversal and permission resolution) */
  get fieldKey(): string { return this.fieldName; }

  /** IS NULL */
  isNull(): IsNullCondition {
    return createCondition<IsNullCondition>({ type: 'isNull', field: this.fieldName });
  }

  /** IS NOT NULL */
  isNotNull(): IsNotNullCondition {
    return createCondition<IsNotNullCondition>({ type: 'isNotNull', field: this.fieldName });
  }

  /** Order ascending */
  asc(nulls?: 'first' | 'last'): OrderByItem {
    return createOrderBy(this.fieldName, 'asc', nulls);
  }

  /** Order descending */
  desc(nulls?: 'first' | 'last'): OrderByItem {
    return createOrderBy(this.fieldName, 'desc', nulls);
  }
}

// ============================================================================
// String Field Expression
// ============================================================================

/** Expression methods for string fields */
export class StringFieldExpr extends FieldExprBase {
  /** Equal to */
  eq(value: string): EqCondition {
    return createCondition<EqCondition>({ type: 'eq', field: this.fieldName, value });
  }

  /** Not equal to */
  neq(value: string): NeqCondition {
    return createCondition<NeqCondition>({ type: 'neq', field: this.fieldName, value });
  }

  /** LIKE pattern (use % for wildcards) */
  like(pattern: string): LikeCondition {
    return createCondition<LikeCondition>({ type: 'like', field: this.fieldName, pattern });
  }

  /** Case-insensitive LIKE */
  ilike(pattern: string): ILikeCondition {
    return createCondition<ILikeCondition>({ type: 'ilike', field: this.fieldName, pattern });
  }

  /** Starts with prefix */
  startsWith(prefix: string): StartsWithCondition {
    return createCondition<StartsWithCondition>({ type: 'startsWith', field: this.fieldName, prefix });
  }

  /** Ends with suffix */
  endsWith(suffix: string): EndsWithCondition {
    return createCondition<EndsWithCondition>({ type: 'endsWith', field: this.fieldName, suffix });
  }

  /** Contains substring */
  contains(substring: string): ContainsCondition {
    return createCondition<ContainsCondition>({ type: 'contains', field: this.fieldName, substring });
  }

  /** In list of values */
  in(values: string[]): InCondition {
    return createCondition<InCondition>({ type: 'in', field: this.fieldName, values });
  }

  /** Not in list of values */
  notIn(values: string[]): NotInCondition {
    return createCondition<NotInCondition>({ type: 'notIn', field: this.fieldName, values });
  }
}

// ============================================================================
// Number Field Expression
// ============================================================================

/** Expression methods for number fields (int, float, double, etc.) */
export class NumberFieldExpr extends FieldExprBase {
  /** Equal to */
  eq(value: number): EqCondition {
    return createCondition<EqCondition>({ type: 'eq', field: this.fieldName, value });
  }

  /** Not equal to */
  neq(value: number): NeqCondition {
    return createCondition<NeqCondition>({ type: 'neq', field: this.fieldName, value });
  }

  /** Greater than */
  gt(value: number): GtCondition {
    return createCondition<GtCondition>({ type: 'gt', field: this.fieldName, value });
  }

  /** Greater than or equal */
  gte(value: number): GteCondition {
    return createCondition<GteCondition>({ type: 'gte', field: this.fieldName, value });
  }

  /** Less than */
  lt(value: number): LtCondition {
    return createCondition<LtCondition>({ type: 'lt', field: this.fieldName, value });
  }

  /** Less than or equal */
  lte(value: number): LteCondition {
    return createCondition<LteCondition>({ type: 'lte', field: this.fieldName, value });
  }

  /** Between min and max (inclusive) */
  between(min: number, max: number): BetweenCondition {
    return createCondition<BetweenCondition>({ type: 'between', field: this.fieldName, min, max });
  }

  /** In list of values */
  in(values: number[]): InCondition {
    return createCondition<InCondition>({ type: 'in', field: this.fieldName, values });
  }

  /** Not in list of values */
  notIn(values: number[]): NotInCondition {
    return createCondition<NotInCondition>({ type: 'notIn', field: this.fieldName, values });
  }
}

// ============================================================================
// BigInt Field Expression
// ============================================================================

/** Expression methods for bigint fields */
export class BigIntFieldExpr extends FieldExprBase {
  /** Equal to */
  eq(value: bigint): EqCondition {
    return createCondition<EqCondition>({ type: 'eq', field: this.fieldName, value });
  }

  /** Not equal to */
  neq(value: bigint): NeqCondition {
    return createCondition<NeqCondition>({ type: 'neq', field: this.fieldName, value });
  }

  /** Greater than */
  gt(value: bigint): GtCondition {
    return createCondition<GtCondition>({ type: 'gt', field: this.fieldName, value });
  }

  /** Greater than or equal */
  gte(value: bigint): GteCondition {
    return createCondition<GteCondition>({ type: 'gte', field: this.fieldName, value });
  }

  /** Less than */
  lt(value: bigint): LtCondition {
    return createCondition<LtCondition>({ type: 'lt', field: this.fieldName, value });
  }

  /** Less than or equal */
  lte(value: bigint): LteCondition {
    return createCondition<LteCondition>({ type: 'lte', field: this.fieldName, value });
  }

  /** Between min and max (inclusive) */
  between(min: bigint, max: bigint): BetweenCondition {
    return createCondition<BetweenCondition>({ type: 'between', field: this.fieldName, min, max });
  }

  /** In list of values */
  in(values: bigint[]): InCondition {
    return createCondition<InCondition>({ type: 'in', field: this.fieldName, values });
  }
}

// ============================================================================
// Decimal Field Expression (stored as string for precision)
// ============================================================================

/** Expression methods for decimal fields */
export class DecimalFieldExpr extends FieldExprBase {
  /** Equal to */
  eq(value: string): EqCondition {
    return createCondition<EqCondition>({ type: 'eq', field: this.fieldName, value });
  }

  /** Not equal to */
  neq(value: string): NeqCondition {
    return createCondition<NeqCondition>({ type: 'neq', field: this.fieldName, value });
  }

  /** Greater than */
  gt(value: string): GtCondition {
    return createCondition<GtCondition>({ type: 'gt', field: this.fieldName, value });
  }

  /** Greater than or equal */
  gte(value: string): GteCondition {
    return createCondition<GteCondition>({ type: 'gte', field: this.fieldName, value });
  }

  /** Less than */
  lt(value: string): LtCondition {
    return createCondition<LtCondition>({ type: 'lt', field: this.fieldName, value });
  }

  /** Less than or equal */
  lte(value: string): LteCondition {
    return createCondition<LteCondition>({ type: 'lte', field: this.fieldName, value });
  }

  /** Between min and max (inclusive) */
  between(min: string, max: string): BetweenCondition {
    return createCondition<BetweenCondition>({ type: 'between', field: this.fieldName, min, max });
  }

  /** In list of values */
  in(values: string[]): InCondition {
    return createCondition<InCondition>({ type: 'in', field: this.fieldName, values });
  }
}

// ============================================================================
// Boolean Field Expression
// ============================================================================

/** Expression methods for boolean fields */
export class BooleanFieldExpr extends FieldExprBase {
  /** Equal to */
  eq(value: boolean): EqCondition {
    return createCondition<EqCondition>({ type: 'eq', field: this.fieldName, value });
  }

  /** Is true */
  isTrue(): EqCondition {
    return this.eq(true);
  }

  /** Is false */
  isFalse(): EqCondition {
    return this.eq(false);
  }

  /** In list of values */
  in(values: boolean[]): InCondition {
    return createCondition<InCondition>({ type: 'in', field: this.fieldName, values });
  }

  /** Not in list of values */
  notIn(values: boolean[]): NotInCondition {
    return createCondition<NotInCondition>({ type: 'notIn', field: this.fieldName, values });
  }
}

// ============================================================================
// Timestamp/Date Field Expression
// ============================================================================

/** Expression methods for timestamp/date fields */
export class TimestampFieldExpr extends FieldExprBase {
  /** Equal to */
  eq(value: Date): EqCondition {
    return createCondition<EqCondition>({ type: 'eq', field: this.fieldName, value });
  }

  /** Not equal to */
  neq(value: Date): NeqCondition {
    return createCondition<NeqCondition>({ type: 'neq', field: this.fieldName, value });
  }

  /** Before date */
  before(date: Date): BeforeCondition {
    return createCondition<BeforeCondition>({ type: 'before', field: this.fieldName, date });
  }

  /** After date */
  after(date: Date): AfterCondition {
    return createCondition<AfterCondition>({ type: 'after', field: this.fieldName, date });
  }

  /** Between dates (inclusive) */
  between(start: Date, end: Date): BetweenCondition {
    return createCondition<BetweenCondition>({ type: 'between', field: this.fieldName, min: start, max: end });
  }

  /** Greater than */
  gt(value: Date): GtCondition {
    return createCondition<GtCondition>({ type: 'gt', field: this.fieldName, value });
  }

  /** Greater than or equal */
  gte(value: Date): GteCondition {
    return createCondition<GteCondition>({ type: 'gte', field: this.fieldName, value });
  }

  /** Less than */
  lt(value: Date): LtCondition {
    return createCondition<LtCondition>({ type: 'lt', field: this.fieldName, value });
  }

  /** Less than or equal */
  lte(value: Date): LteCondition {
    return createCondition<LteCondition>({ type: 'lte', field: this.fieldName, value });
  }
}

// ============================================================================
// UUID Field Expression
// ============================================================================

/** Expression methods for UUID fields */
export class UuidFieldExpr extends FieldExprBase {
  /** Equal to */
  eq(value: string): EqCondition {
    return createCondition<EqCondition>({ type: 'eq', field: this.fieldName, value });
  }

  /** Not equal to */
  neq(value: string): NeqCondition {
    return createCondition<NeqCondition>({ type: 'neq', field: this.fieldName, value });
  }

  /** In list of values */
  in(values: string[]): InCondition {
    return createCondition<InCondition>({ type: 'in', field: this.fieldName, values });
  }

  /** Not in list of values */
  notIn(values: string[]): NotInCondition {
    return createCondition<NotInCondition>({ type: 'notIn', field: this.fieldName, values });
  }
}

// ============================================================================
// Enum Field Expression
// ============================================================================

/** Expression methods for enum fields */
export class EnumFieldExpr<T extends string> extends FieldExprBase {
  /** Equal to */
  eq(value: T): EqCondition {
    return createCondition<EqCondition>({ type: 'eq', field: this.fieldName, value });
  }

  /** Not equal to */
  neq(value: T): NeqCondition {
    return createCondition<NeqCondition>({ type: 'neq', field: this.fieldName, value });
  }

  /** In list of values */
  in(values: T[]): InCondition {
    return createCondition<InCondition>({ type: 'in', field: this.fieldName, values });
  }

  /** Not in list of values */
  notIn(values: T[]): NotInCondition {
    return createCondition<NotInCondition>({ type: 'notIn', field: this.fieldName, values });
  }
}

// ============================================================================
// Ref Traversal (permission multi-hop)
// ============================================================================

/**
 * Describes a chain of ref-field hops used by the permission system.
 * e.g. `ticket.has(Ticket.fields.customer)` → `{ path: ['ticket', 'customer'] }`
 */
export interface RefTraversal {
  readonly __isRefTraversal: true;
  readonly path: string[];
  /** Extend the chain by one more hop */
  has(field: RefFieldExpr<any>): RefTraversal;
}

/** Type guard for RefTraversal */
export function isRefTraversal(value: unknown): value is RefTraversal {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__isRefTraversal' in value &&
    (value as any).__isRefTraversal === true
  );
}

function makeRefTraversal(path: string[]): RefTraversal {
  return {
    __isRefTraversal: true as const,
    path,
    has(field: RefFieldExpr<any>): RefTraversal {
      return makeRefTraversal([...path, field.fieldKey]);
    },
  };
}

// ============================================================================
// Reference Field Expression
// ============================================================================

/**
 * Extract the string identifier from any Ref<T> - Reference, Persistent entity, or string.
 *
 * @example
 * ```typescript
 * refId(ticket)          // Persistent<Ticket> → '123'
 * refId(Ticket.ref('1')) // Reference<Ticket>  → '1'
 * refId('abc')           // string             → 'abc'
 * ```
 */
export function refId<T>(value: Reference<T> | string | unknown): string {
  if (typeof value === 'string') return value;
  if (isReference(value)) return (value as Reference<T>).identifier;
  // Persistent entity with adapter key
  const adapterKey = (value as Record<symbol, unknown>)?.[ADAPTER_KEY];
  if (adapterKey !== undefined) return String(adapterKey);
  throw new Error('Cannot extract key from value - pass a Reference, persistent entity, or string');
}

/** @internal Use refId() for the public API */
const extractRefKey = refId;

/** Expression methods for reference fields */
export class RefFieldExpr<T> extends FieldExprBase {
  /** Equal to (accepts Reference, persistent entity, or id string) */
  eq(value: Reference<T> | string | unknown): EqCondition {
    return createCondition<EqCondition>({ type: 'eq', field: this.fieldName, value: extractRefKey(value) });
  }

  /** Not equal to */
  neq(value: Reference<T> | string | unknown): NeqCondition {
    return createCondition<NeqCondition>({ type: 'neq', field: this.fieldName, value: extractRefKey(value) });
  }

  /** In list of values */
  in(values: (Reference<T> | string | unknown)[]): InCondition {
    return createCondition<InCondition>({ type: 'in', field: this.fieldName, values: values.map(extractRefKey) });
  }

  /** Not in list of values */
  notIn(values: (Reference<T> | string | unknown)[]): NotInCondition {
    return createCondition<NotInCondition>({ type: 'notIn', field: this.fieldName, values: values.map(extractRefKey) });
  }

  /** Has related entity matching condition (generates JOIN) */
  has(condition: Condition): HasCondition;
  /** Build a multi-hop traversal for the permission system */
  has(field: RefFieldExpr<any>): RefTraversal;
  has(conditionOrField: Condition | RefFieldExpr<any>): HasCondition | RefTraversal {
    if (conditionOrField instanceof RefFieldExpr) {
      return makeRefTraversal([this.fieldName, conditionOrField.fieldKey]);
    }
    return createCondition<HasCondition>({ type: 'has', field: this.fieldName, condition: conditionOrField });
  }

  /** Alias for has() with a Condition */
  where(condition: Condition): HasCondition {
    return createCondition<HasCondition>({ type: 'has', field: this.fieldName, condition });
  }
}

// ============================================================================
// References Field Expression (many-to-many)
// ============================================================================

/** Expression methods for refs fields (many-to-many) */
export class RefsFieldExpr<T> extends FieldExprBase {
  /** Has any of the given references */
  hasAny(values: (Reference<T> | string | unknown)[]): InCondition {
    return createCondition<InCondition>({ type: 'in', field: this.fieldName, values: values.map(extractRefKey) });
  }

  /** Has all of the given references */
  hasAll(values: (Reference<T> | string | unknown)[]): AndCondition {
    const ids = values.map(extractRefKey);
    // Each ID must be present
    const conditions = ids.map((id) =>
      createCondition<EqCondition>({ type: 'eq', field: this.fieldName, value: id }),
    );
    return createCondition<AndCondition>({ type: 'and', conditions });
  }

  /** Has related entity matching condition (generates JOIN) */
  has(condition: Condition): HasCondition {
    return createCondition<HasCondition>({ type: 'has', field: this.fieldName, condition });
  }
}

// ============================================================================
// Array Field Expression
// ============================================================================

/** Expression methods for array fields */
export class ArrayFieldExpr<T> extends FieldExprBase {
  /** Contains single element */
  contains(value: T): ArrayContainsCondition {
    return createCondition<ArrayContainsCondition>({
      type: 'arrayContains',
      field: this.fieldName,
      value,
    });
  }

  /** Has any of the given values */
  hasAny(values: T[]): ArrayHasAnyCondition {
    return createCondition<ArrayHasAnyCondition>({
      type: 'arrayHasAny',
      field: this.fieldName,
      values,
    });
  }

  /** Has all of the given values */
  hasAll(values: T[]): ArrayHasAllCondition {
    return createCondition<ArrayHasAllCondition>({
      type: 'arrayHasAll',
      field: this.fieldName,
      values,
    });
  }

  /** Array overlaps with values */
  overlaps(values: T[]): ArrayOverlapsCondition {
    return createCondition<ArrayOverlapsCondition>({
      type: 'arrayOverlaps',
      field: this.fieldName,
      values,
    });
  }
}

// ============================================================================
// JSON Field Expression
// ============================================================================

/** Expression methods for JSON/JSONB fields */
export class JsonFieldExpr extends FieldExprBase {
  /** Equal to (deep equality) */
  eq(value: unknown): EqCondition {
    return createCondition<EqCondition>({ type: 'eq', field: this.fieldName, value });
  }

  /** Contains (JSONB @>) */
  contains(value: unknown): ContainsCondition {
    return createCondition<ContainsCondition>({
      type: 'contains',
      field: this.fieldName,
      substring: JSON.stringify(value),
    });
  }
}

// ============================================================================
// Object Field Expression
// ============================================================================

/** Expression methods for object fields with nested access */
export class ObjectFieldExpr<T extends Record<string, unknown>> extends FieldExprBase {
  constructor(
    fieldName: string,
    fieldDef: FieldDef,
    private readonly objectShape: Record<string, FieldDef>,
  ) {
    super(fieldName, fieldDef);
  }

  /** Equal to (deep equality) */
  eq(value: T): EqCondition {
    return createCondition<EqCondition>({ type: 'eq', field: this.fieldName, value });
  }

  /** Contains (partial match) */
  contains(value: Partial<T>): ContainsCondition {
    return createCondition<ContainsCondition>({
      type: 'contains',
      field: this.fieldName,
      substring: JSON.stringify(value),
    });
  }
}

// ============================================================================
// Nested Field Expression Type Helper
// ============================================================================

/**
 * Recursively map nested object shape to field expression types.
 * This allows type-safe access to nested fields like User.fields.settings.theme
 */
export type ObjectFieldExprsFromShape<T extends Record<string, FieldDef>> = {
  [K in keyof T]: T[K] extends FieldDef<infer V>
    ? T[K]['type'] extends 'object'
      ? T[K]['objectShape'] extends Record<string, FieldDef>
        ? ObjectFieldExpr<V extends Record<string, unknown> ? V : never> &
            ObjectFieldExprsFromShape<T[K]['objectShape']>
        : ObjectFieldExpr<V extends Record<string, unknown> ? V : never>
      : FieldExprForType<T[K]['type'], V>
    : never;
};

// ============================================================================
// Field Expression Type Mapping
// ============================================================================

/** Map field type to expression class */
export type FieldExprForType<T extends FieldType, V = unknown> = T extends 'string' | 'text'
  ? StringFieldExpr
  : T extends 'int' | 'smallint' | 'float' | 'double' | 'version'
    ? NumberFieldExpr
    : T extends 'bigint'
      ? BigIntFieldExpr
      : T extends 'decimal'
        ? DecimalFieldExpr
        : T extends 'boolean'
          ? BooleanFieldExpr
          : T extends 'timestamp' | 'date' | 'createdAt' | 'updatedAt' | 'deletedAt'
            ? TimestampFieldExpr
            : T extends 'uuid'
              ? UuidFieldExpr
              : T extends 'enum'
                ? EnumFieldExpr<string>
                : T extends 'ref'
                  ? RefFieldExpr<V>
                  : T extends 'refs'
                    ? RefsFieldExpr<V>
                    : T extends 'array'
                      ? ArrayFieldExpr<V>
                      : T extends 'json' | 'jsonb'
                        ? JsonFieldExpr
                        : FieldExprBase;

// ============================================================================
// Field Expression Factory
// ============================================================================

/**
 * Create a Proxy wrapper for ObjectFieldExpr that allows nested property access.
 * This enables syntax like `User.fields.settings.theme.eq('dark')`.
 */
function createObjectFieldExprProxy<T extends Record<string, unknown>>(
  fieldName: string,
  fieldDef: FieldDef,
  objectShape: Record<string, FieldDef>,
): ObjectFieldExpr<T> {
  const expr = new ObjectFieldExpr<T>(fieldName, fieldDef, objectShape);

  return new Proxy(expr, {
    get(target, prop: string | symbol) {
      // First check if the property is an own method/property of ObjectFieldExpr
      if (prop in target) {
        const value = (target as any)[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      }

      // Then check if it's a nested field in the object shape
      if (typeof prop === 'string' && prop in objectShape) {
        const nestedFieldDef = objectShape[prop];
        const nestedFieldName = `${fieldName}.${prop}`;
        return createFieldExpr(nestedFieldName, nestedFieldDef);
      }

      return undefined;
    },
  }) as ObjectFieldExpr<T>;
}

/** Create a field expression for a given field definition */
export function createFieldExpr(fieldName: string, fieldDef: FieldDef): FieldExprBase {
  switch (fieldDef.type) {
    case 'string':
    case 'text':
      return new StringFieldExpr(fieldName, fieldDef);

    case 'int':
    case 'smallint':
    case 'float':
    case 'double':
    case 'version':
      return new NumberFieldExpr(fieldName, fieldDef);

    case 'bigint':
      return new BigIntFieldExpr(fieldName, fieldDef);

    case 'decimal':
      return new DecimalFieldExpr(fieldName, fieldDef);

    case 'boolean':
      return new BooleanFieldExpr(fieldName, fieldDef);

    case 'timestamp':
    case 'date':
    case 'createdAt':
    case 'updatedAt':
    case 'deletedAt':
      return new TimestampFieldExpr(fieldName, fieldDef);

    case 'uuid':
      return new UuidFieldExpr(fieldName, fieldDef);

    case 'enum':
      return new EnumFieldExpr(fieldName, fieldDef);

    case 'ref':
      return new RefFieldExpr(fieldName, fieldDef);

    case 'refs':
      return new RefsFieldExpr(fieldName, fieldDef);

    case 'array':
      return new ArrayFieldExpr(fieldName, fieldDef);

    case 'json':
    case 'jsonb':
      return new JsonFieldExpr(fieldName, fieldDef);

    case 'object':
      if (fieldDef.objectShape) {
        return createObjectFieldExprProxy(fieldName, fieldDef, fieldDef.objectShape);
      }
      return new JsonFieldExpr(fieldName, fieldDef);

    case 'time':
    case 'duration':
    case 'bytes':
    default:
      return new StringFieldExpr(fieldName, fieldDef); // Fallback to string-like
  }
}

// ============================================================================
// Aggregation Types
// ============================================================================

/** Symbol to mark an aggregation */
export const AGGREGATION = Symbol('models:aggregation');

/** Base aggregation */
interface AggregationBase {
  readonly [AGGREGATION]: true;
}

/** Count aggregation */
export interface CountAggregation extends AggregationBase {
  readonly type: 'count';
  readonly field?: string;
  readonly distinct?: boolean;
}

/** Sum aggregation */
export interface SumAggregation extends AggregationBase {
  readonly type: 'sum';
  readonly field: string;
}

/** Avg aggregation */
export interface AvgAggregation extends AggregationBase {
  readonly type: 'avg';
  readonly field: string;
}

/** Min aggregation */
export interface MinAggregation extends AggregationBase {
  readonly type: 'min';
  readonly field: string;
}

/** Max aggregation */
export interface MaxAggregation extends AggregationBase {
  readonly type: 'max';
  readonly field: string;
}

/** All aggregation types */
export type Aggregation =
  | CountAggregation
  | SumAggregation
  | AvgAggregation
  | MinAggregation
  | MaxAggregation;

// ============================================================================
// Query Helpers Namespace (q)
// ============================================================================

/**
 * Query helpers namespace.
 *
 * @example
 * ```typescript
 * import { q } from '@justscale/core/models';
 *
 * // Logical operators
 * q.and(status.eq('published'), createdAt.after(lastWeek))
 * q.or(author.eq(user1), author.eq(user2))
 * q.not(status.eq('draft'))
 *
 * // Aggregations
 * q.count()
 * q.sum(views)
 * q.avg(rating)
 * q.min(price)
 * q.max(price)
 * ```
 */
export const q = {
  // ─── LOGICAL OPERATORS ───

  /** AND condition - all must match */
  and(...conditions: Condition[]): AndCondition {
    return createCondition<AndCondition>({ type: 'and', conditions });
  },

  /** OR condition - any must match */
  or(...conditions: Condition[]): OrCondition {
    return createCondition<OrCondition>({ type: 'or', conditions });
  },

  /** NOT condition - negates the condition */
  not(condition: Condition): NotCondition {
    return createCondition<NotCondition>({ type: 'not', condition });
  },

  // ─── AGGREGATIONS ───

  /** Count rows or distinct values */
  count(field?: FieldExprBase): CountAggregation & { distinct(): CountAggregation } {
    const agg: CountAggregation = {
      [AGGREGATION]: true,
      type: 'count',
      field: field?.['fieldName'],
    };

    return Object.assign(agg, {
      distinct(): CountAggregation {
        return { ...agg, distinct: true };
      },
    });
  },

  /** Sum of field values */
  sum(field: NumberFieldExpr | DecimalFieldExpr | BigIntFieldExpr): SumAggregation {
    return {
      [AGGREGATION]: true,
      type: 'sum',
      field: field['fieldName'],
    };
  },

  /** Average of field values */
  avg(field: NumberFieldExpr | DecimalFieldExpr): AvgAggregation {
    return {
      [AGGREGATION]: true,
      type: 'avg',
      field: field['fieldName'],
    };
  },

  /** Minimum value */
  min(field: FieldExprBase): MinAggregation {
    return {
      [AGGREGATION]: true,
      type: 'min',
      field: field['fieldName'],
    };
  },

  /** Maximum value */
  max(field: FieldExprBase): MaxAggregation {
    return {
      [AGGREGATION]: true,
      type: 'max',
      field: field['fieldName'],
    };
  },

  // ─── RAW SQL (escape hatch) ───

  /** Raw SQL condition */
  raw(sql: string, ...values: unknown[]): RawCondition {
    return createCondition<RawCondition>({ type: 'raw', sql, values });
  },
};

// ============================================================================
// Type Guards
// ============================================================================

/** Check if value is a Condition */
export function isCondition(value: unknown): value is Condition {
  return (
    value !== null &&
    typeof value === 'object' &&
    CONDITION in value &&
    (value as Record<symbol, unknown>)[CONDITION] === true
  );
}

/** Check if value is an Aggregation */
export function isAggregation(value: unknown): value is Aggregation {
  return (
    value !== null &&
    typeof value === 'object' &&
    AGGREGATION in value &&
    (value as Record<symbol, unknown>)[AGGREGATION] === true
  );
}

// ============================================================================
// Query Types
// ============================================================================

/** Order direction */
export type OrderDirection = 'asc' | 'desc';

/** Order by specification (object form) */
export type OrderByObject<T> = {
  [K in keyof T]?: OrderDirection;
};

/** Order by specification - supports both object and array forms */
export type OrderBy<T> = OrderByObject<T> | OrderByItem[];

/** Find options */
export interface FindOptions<T> {
  /** Filter conditions */
  where?: Condition;
  /**
   * Order by fields.
   * Supports both object form `{ field: 'asc' }` and array form `[field.asc()]`
   */
  orderBy?: OrderBy<T>;
  /** Maximum results */
  limit?: number;
  /** Skip results */
  offset?: number;
  /** Eager load relations */
  load?: string[] | Record<string, boolean | Record<string, unknown>>;
}

/** Paginated options */
export interface PageOptions<T> extends Omit<FindOptions<T>, 'limit' | 'offset'> {
  /** Page size (default: 20) */
  pageSize?: number;
}

/** Batch options for streaming */
export interface BatchOptions<T> extends Omit<FindOptions<T>, 'limit' | 'offset'> {
  /** Batch size (default: 100) */
  batchSize?: number;
}

/** Page result */
export interface Page<T> {
  /** Page data */
  data: T[];
  /** Current page number (1-indexed) */
  page: number;
  /** Whether there are more pages */
  hasMore: boolean;
  /** Total count (if requested) */
  total?: number;
}

/** Aggregation options */
export interface AggregateOptions {
  /** Filter conditions */
  where?: Condition;
  /** Group by fields */
  groupBy?: FieldExprBase[];
  /** Computed aggregations */
  compute: Record<string, Aggregation>;
  /** Having condition (filter after grouping) */
  having?: Condition;
}
