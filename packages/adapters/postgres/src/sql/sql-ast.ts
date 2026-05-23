/**
 * SQL Abstract Syntax Tree
 *
 * A structured representation of SQL queries that can be transformed
 * and printed to dialect-specific SQL strings.
 *
 * Uses a class hierarchy for:
 * - Type-safe instanceof checks
 * - Visitor pattern support
 * - Node-specific printing logic
 * - Better IDE support
 */


/**
 * Base class for all SQL AST nodes.
 */
export abstract class SqlNode {
  /**
   * Print this node to SQL string.
   * Override in subclasses for specific formatting.
   */
  abstract toSql(): string;

  /**
   * Accept a visitor for double-dispatch pattern.
   */
  abstract accept<R>(visitor: SqlVisitor<R>): R;
}

/**
 * Base class for expression nodes (things that produce values).
 */
export abstract class ExprNode extends SqlNode {}

/**
 * Base class for condition nodes (things that produce boolean).
 */
export abstract class ConditionNode extends SqlNode {}

/**
 * Base class for statement nodes (SELECT, INSERT, etc.).
 */
export abstract class StatementNode extends SqlNode {}


/**
 * SQL namespace containing all enums and type constants.
 * Use as: Sql.Op.Eq, Sql.Agg.Count, etc.
 */
export namespace Sql {
  /** Comparison operators */
  export enum Op {
    Eq = '=',
    Neq = '<>',
    Gt = '>',
    Gte = '>=',
    Lt = '<',
    Lte = '<=',
    Like = 'LIKE',
    ILike = 'ILIKE',
  }

  /** Aggregate functions */
  export enum Agg {
    Count = 'COUNT',
    Sum = 'SUM',
    Avg = 'AVG',
    Min = 'MIN',
    Max = 'MAX',
  }

  /** JOIN types */
  export enum Join {
    Inner = 'INNER',
    Left = 'LEFT',
    Right = 'RIGHT',
    Full = 'FULL',
  }

  /** Sort direction */
  export enum Sort {
    Asc = 'ASC',
    Desc = 'DESC',
  }

  /** NULLS position */
  export enum Nulls {
    First = 'FIRST',
    Last = 'LAST',
  }
}


// Valid SQL identifier (unquoted): leading letter/underscore, then alnum/underscore.
// Used to fail-fast when a runtime caller (e.g. orderBy: req.body) routes a
// non-DSL string into a ColumnRef / JsonPath. Column names produced by the
// framework's own toSnakeCase always satisfy this pattern, so legitimate use
// is unaffected; only injection-shaped input is rejected.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdent(name: string, role: 'column' | 'table'): void {
  if (!IDENT_RE.test(name)) {
    throw new Error(
      `Invalid SQL ${role} name: ${JSON.stringify(name)}. Identifiers must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
    );
  }
}

// Postgres single-quoted string literal: escape ' as ''. JSON path parts
// reach SQL inside '...' literals (e.g. data->>'key'), so unescaped quotes
// would let a key like  k'='admin' --  break out of the literal.
function escapeSqlLiteral(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * Column reference (e.g., "status", "users.email")
 */
export class ColumnRef extends ExprNode {
  constructor(
    public readonly column: string,
    public readonly table?: string,
  ) {
    super();
    assertIdent(column, 'column');
    if (table !== undefined) assertIdent(table, 'table');
  }

  toSql(): string {
    return this.table ? `${this.table}.${this.column}` : this.column;
  }

  accept<R>(visitor: SqlVisitor<R>): R {
    return visitor.visitColumnRef(this);
  }
}

/**
 * JSONB path access (e.g., data->'field' or data->>'field')
 */
export class JsonPath extends ExprNode {
  constructor(
    public readonly column: string,
    public readonly path: string[],
    /** ->> returns text, -> returns jsonb */
    public readonly asText: boolean = true,
  ) {
    super();
    // Column may be a qualified ref (table.col); validate each segment.
    for (const part of column.split('.')) assertIdent(part, 'column');
  }

  toSql(): string {
    if (this.path.length === 0) return this.column;

    const parts = this.path.slice(0, -1);
    const last = this.path[this.path.length - 1];

    let expr = this.column;
    for (const part of parts) {
      expr += `->'${escapeSqlLiteral(part)}'`;
    }
    if (last !== undefined) {
      const esc = escapeSqlLiteral(last);
      expr += this.asText ? `->>'${esc}'` : `->'${esc}'`;
    }
    return expr;
  }

  accept<R>(visitor: SqlVisitor<R>): R {
    return visitor.visitJsonPath(this);
  }
}

/**
 * Parameter placeholder ($1, $2, etc.)
 */
export class Param extends ExprNode {
  constructor(public readonly index: number) {
    super();
  }

  toSql(): string {
    return `$${this.index}`;
  }

  accept<R>(visitor: SqlVisitor<R>): R {
    return visitor.visitParam(this);
  }
}

/**
 * Type cast expression (e.g., expr::type)
 */
export class Cast extends ExprNode {
  constructor(
    public readonly expr: ExprNode,
    public readonly type: string,
  ) {
    super();
  }

  toSql(): string {
    return `(${this.expr.toSql()})::${this.type}`;
  }

  accept<R>(visitor: SqlVisitor<R>): R {
    return visitor.visitCast?.(this) ?? (undefined as R);
  }
}

/**
 * Raw SQL fragment (escape hatch)
 */
export class RawSql extends ExprNode {
  constructor(public readonly sql: string) {
    super();
  }

  toSql(): string {
    return this.sql;
  }

  accept<R>(visitor: SqlVisitor<R>): R {
    return visitor.visitRawSql(this);
  }
}

/**
 * NULL literal
 */
export class NullLiteral extends ExprNode {
  toSql(): string {
    return 'NULL';
  }

  accept<R>(visitor: SqlVisitor<R>): R {
    return visitor.visitNullLiteral(this);
  }
}

/**
 * Aggregate function (COUNT, SUM, AVG, MIN, MAX)
 */
export class Aggregate extends ExprNode {
  constructor(
    public readonly func: Sql.Agg,
    public readonly expr?: ExprNode,
    public readonly distinct: boolean = false,
  ) {
    super();
  }

  toSql(): string {
    let inner = this.expr ? this.expr.toSql() : '*';
    if (this.distinct) {
      inner = `DISTINCT ${inner}`;
    }
    return `${this.func}(${inner})`;
  }

  accept<R>(visitor: SqlVisitor<R>): R {
    return visitor.visitAggregate(this);
  }
}


/**
 * Binary comparison (e.g., status = $1)
 */
export class Compare extends ConditionNode {
  constructor(
    public readonly left: ExprNode,
    public readonly op: Sql.Op,
    public readonly right: ExprNode,
  ) {
    super();
  }

  toSql(): string {
    return `${this.left.toSql()} ${this.op} ${this.right.toSql()}`;
  }

  accept<R>(visitor: SqlVisitor<R>): R {
    return visitor.visitCompare(this);
  }
}

/**
 * IS NULL / IS NOT NULL
 */
export class IsNull extends ConditionNode {
  constructor(
    public readonly expr: ExprNode,
    public readonly negated: boolean = false,
  ) {
    super();
  }

  toSql(): string {
    return this.negated
      ? `${this.expr.toSql()} IS NOT NULL`
      : `${this.expr.toSql()} IS NULL`;
  }

  accept<R>(visitor: SqlVisitor<R>): R {
    return visitor.visitIsNull(this);
  }
}

/**
 * BETWEEN expression
 */
export class Between extends ConditionNode {
  constructor(
    public readonly expr: ExprNode,
    public readonly low: ExprNode,
    public readonly high: ExprNode,
  ) {
    super();
  }

  toSql(): string {
    return `${this.expr.toSql()} BETWEEN ${this.low.toSql()} AND ${this.high.toSql()}`;
  }

  accept<R>(visitor: SqlVisitor<R>): R {
    return visitor.visitBetween(this);
  }
}

/**
 * IN / NOT IN expression
 */
export class InList extends ConditionNode {
  constructor(
    public readonly expr: ExprNode,
    public readonly values: ExprNode[],
    public readonly negated: boolean = false,
  ) {
    super();
  }

  toSql(): string {
    const values = this.values.map((v) => v.toSql()).join(', ');
    const op = this.negated ? 'NOT IN' : 'IN';
    return `${this.expr.toSql()} ${op} (${values})`;
  }

  accept<R>(visitor: SqlVisitor<R>): R {
    return visitor.visitInList(this);
  }
}

/**
 * ANY(array) for efficient IN with many values
 */
export class AnyArray extends ConditionNode {
  constructor(
    public readonly expr: ExprNode,
    public readonly array: ExprNode,
  ) {
    super();
  }

  toSql(): string {
    return `${this.expr.toSql()} = ANY(${this.array.toSql()})`;
  }

  accept<R>(visitor: SqlVisitor<R>): R {
    return visitor.visitAnyArray(this);
  }
}

/**
 * AND expression
 */
export class And extends ConditionNode {
  constructor(public readonly conditions: ConditionNode[]) {
    super();
  }

  toSql(): string {
    if (this.conditions.length === 0) return 'TRUE';
    if (this.conditions.length === 1) return this.conditions[0].toSql();
    const parts = this.conditions.map((c) => c.toSql());
    return `(${parts.join(' AND ')})`;
  }

  accept<R>(visitor: SqlVisitor<R>): R {
    return visitor.visitAnd(this);
  }
}

/**
 * OR expression
 */
export class Or extends ConditionNode {
  constructor(public readonly conditions: ConditionNode[]) {
    super();
  }

  toSql(): string {
    if (this.conditions.length === 0) return 'FALSE';
    if (this.conditions.length === 1) return this.conditions[0].toSql();
    const parts = this.conditions.map((c) => c.toSql());
    return `(${parts.join(' OR ')})`;
  }

  accept<R>(visitor: SqlVisitor<R>): R {
    return visitor.visitOr(this);
  }
}

/**
 * NOT expression
 */
export class Not extends ConditionNode {
  constructor(public readonly condition: ConditionNode) {
    super();
  }

  toSql(): string {
    return `NOT (${this.condition.toSql()})`;
  }

  accept<R>(visitor: SqlVisitor<R>): R {
    return visitor.visitNot(this);
  }
}

/**
 * Raw SQL condition (escape hatch)
 */
export class RawCondition extends ConditionNode {
  constructor(public readonly sql: string) {
    super();
  }

  toSql(): string {
    return this.sql;
  }

  accept<R>(visitor: SqlVisitor<R>): R {
    return visitor.visitRawCondition(this);
  }
}

/**
 * Array contains single element: column @> ARRAY[value]
 */
export class ArrayContains extends ConditionNode {
  constructor(
    public readonly array: ExprNode,
    public readonly value: ExprNode,
  ) {
    super();
  }

  toSql(): string {
    return `${this.array.toSql()} @> ARRAY[${this.value.toSql()}]`;
  }

  accept<R>(visitor: SqlVisitor<R>): R {
    return visitor.visitArrayContains?.(this) ?? (undefined as R);
  }
}

/**
 * JSONB array containment: column @> jsonb_build_array(value::text)
 * Used when arrays are stored within JSONB columns.
 */
export class JsonbArrayContains extends ConditionNode {
  constructor(
    public readonly jsonbPath: ExprNode,
    public readonly value: ExprNode,
  ) {
    super();
  }

  toSql(): string {
    // The jsonbPath extracts as JSONB (not text), cast value to text for type inference
    return `${this.jsonbPath.toSql()} @> jsonb_build_array(${this.value.toSql()}::text)`;
  }

  accept<R>(visitor: SqlVisitor<R>): R {
    return visitor.visitJsonbArrayContains?.(this) ?? (undefined as R);
  }
}

/**
 * Array contains all elements: column @> ARRAY[values...]
 */
export class ArrayContainsAll extends ConditionNode {
  constructor(
    public readonly array: ExprNode,
    public readonly values: ExprNode[],
  ) {
    super();
  }

  toSql(): string {
    const valuesSql = this.values.map((v) => v.toSql()).join(', ');
    return `${this.array.toSql()} @> ARRAY[${valuesSql}]`;
  }

  accept<R>(visitor: SqlVisitor<R>): R {
    return visitor.visitArrayContainsAll?.(this) ?? (undefined as R);
  }
}

/**
 * Array overlaps: column && ARRAY[values...]
 */
export class ArrayOverlap extends ConditionNode {
  constructor(
    public readonly array: ExprNode,
    public readonly values: ExprNode[],
  ) {
    super();
  }

  toSql(): string {
    const valuesSql = this.values.map((v) => v.toSql()).join(', ');
    return `${this.array.toSql()} && ARRAY[${valuesSql}]`;
  }

  accept<R>(visitor: SqlVisitor<R>): R {
    return visitor.visitArrayOverlap?.(this) ?? (undefined as R);
  }
}

/**
 * EXISTS subquery
 */
export class Exists extends ConditionNode {
  constructor(public readonly subquery: Select) {
    super();
  }

  toSql(): string {
    return `EXISTS (${this.subquery.toSql()})`;
  }

  accept<R>(visitor: SqlVisitor<R>): R {
    return visitor.visitExists(this);
  }
}


/**
 * SELECT column (expression AS alias)
 */
export class SelectColumn {
  constructor(
    public readonly expr: ExprNode,
    public readonly alias?: string,
  ) {}

  toSql(): string {
    const sql = this.expr.toSql();
    return this.alias ? `${sql} AS ${this.alias}` : sql;
  }
}

/**
 * FROM clause
 */
export class From {
  constructor(
    public readonly table: string,
    public readonly alias?: string,
    public readonly joins: Join[] = [],
  ) {}

  toSql(): string {
    let sql = this.table;
    if (this.alias) {
      sql += ` AS ${this.alias}`;
    }
    for (const join of this.joins) {
      sql += ` ${join.toSql()}`;
    }
    return sql;
  }
}

/**
 * JOIN clause
 */
export class Join {
  constructor(
    public readonly type: Sql.Join,
    public readonly table: string,
    public readonly on: ConditionNode,
    public readonly alias?: string,
  ) {}

  toSql(): string {
    let sql = `${this.type} JOIN ${this.table}`;
    if (this.alias) {
      sql += ` AS ${this.alias}`;
    }
    sql += ` ON ${this.on.toSql()}`;
    return sql;
  }
}

/**
 * ORDER BY item
 */
export class OrderBy {
  constructor(
    public readonly expr: ExprNode,
    public readonly direction: Sql.Sort = Sql.Sort.Asc,
    public readonly nulls?: Sql.Nulls,
  ) {}

  toSql(): string {
    let sql = `${this.expr.toSql()} ${this.direction}`;
    if (this.nulls) {
      sql += ` NULLS ${this.nulls}`;
    }
    return sql;
  }
}


/**
 * SELECT statement options
 */
export interface SelectOptions {
  columns: SelectColumn[]
  from: From
  where?: ConditionNode
  orderBy?: OrderBy[]
  limit?: ExprNode
  offset?: ExprNode
  groupBy?: ExprNode[]
  having?: ConditionNode
  forUpdate?: boolean
}

/**
 * SELECT statement
 */
export class Select extends StatementNode {
  public readonly columns: SelectColumn[];
  public readonly from: From;
  public readonly where?: ConditionNode;
  public readonly orderBy?: OrderBy[];
  public readonly limit?: ExprNode;
  public readonly offset?: ExprNode;
  public readonly groupBy?: ExprNode[];
  public readonly having?: ConditionNode;
  public readonly forUpdate?: boolean;

  constructor(options: SelectOptions) {
    super();
    this.columns = options.columns;
    this.from = options.from;
    this.where = options.where;
    this.orderBy = options.orderBy;
    this.limit = options.limit;
    this.offset = options.offset;
    this.groupBy = options.groupBy;
    this.having = options.having;
    this.forUpdate = options.forUpdate;
  }

  toSql(): string {
    const parts: string[] = ['SELECT'];

    // Columns
    parts.push(this.columns.map((c) => c.toSql()).join(', '));

    // FROM
    parts.push('FROM', this.from.toSql());

    // WHERE
    if (this.where) {
      parts.push('WHERE', this.where.toSql());
    }

    // GROUP BY
    if (this.groupBy && this.groupBy.length > 0) {
      parts.push('GROUP BY', this.groupBy.map((e) => e.toSql()).join(', '));
    }

    // HAVING
    if (this.having) {
      parts.push('HAVING', this.having.toSql());
    }

    // ORDER BY
    if (this.orderBy && this.orderBy.length > 0) {
      parts.push('ORDER BY', this.orderBy.map((o) => o.toSql()).join(', '));
    }

    // LIMIT
    if (this.limit) {
      parts.push('LIMIT', this.limit.toSql());
    }

    // OFFSET
    if (this.offset) {
      parts.push('OFFSET', this.offset.toSql());
    }

    // FOR UPDATE
    if (this.forUpdate) {
      parts.push('FOR UPDATE');
    }

    return parts.join(' ');
  }

  accept<R>(visitor: SqlVisitor<R>): R {
    return visitor.visitSelect(this);
  }
}


/**
 * Visitor interface for traversing SQL AST.
 * Useful for optimization passes, analysis, and custom printing.
 */
export interface SqlVisitor<R> {
  // Expression nodes
  visitColumnRef(node: ColumnRef): R
  visitJsonPath(node: JsonPath): R
  visitParam(node: Param): R
  visitRawSql(node: RawSql): R
  visitNullLiteral(node: NullLiteral): R
  visitAggregate(node: Aggregate): R
  visitCast?(node: Cast): R

  // Condition nodes
  visitCompare(node: Compare): R
  visitIsNull(node: IsNull): R
  visitBetween(node: Between): R
  visitInList(node: InList): R
  visitAnyArray(node: AnyArray): R
  visitAnd(node: And): R
  visitOr(node: Or): R
  visitNot(node: Not): R
  visitRawCondition(node: RawCondition): R
  visitArrayContains?(node: ArrayContains): R
  visitJsonbArrayContains?(node: JsonbArrayContains): R
  visitArrayContainsAll?(node: ArrayContainsAll): R
  visitArrayOverlap?(node: ArrayOverlap): R
  visitExists(node: Exists): R

  // Statement nodes
  visitSelect(node: Select): R
}

/**
 * Base visitor with default implementations that visit children.
 * Extend this for specific transformations.
 */
export abstract class BaseSqlVisitor<R> implements SqlVisitor<R> {
  abstract defaultValue(): R;

  visitColumnRef(_node: ColumnRef): R {
    return this.defaultValue();
  }

  visitJsonPath(_node: JsonPath): R {
    return this.defaultValue();
  }

  visitParam(_node: Param): R {
    return this.defaultValue();
  }

  visitRawSql(_node: RawSql): R {
    return this.defaultValue();
  }

  visitNullLiteral(_node: NullLiteral): R {
    return this.defaultValue();
  }

  visitAggregate(node: Aggregate): R {
    node.expr?.accept(this);
    return this.defaultValue();
  }

  visitCompare(node: Compare): R {
    node.left.accept(this);
    node.right.accept(this);
    return this.defaultValue();
  }

  visitIsNull(node: IsNull): R {
    node.expr.accept(this);
    return this.defaultValue();
  }

  visitBetween(node: Between): R {
    node.expr.accept(this);
    node.low.accept(this);
    node.high.accept(this);
    return this.defaultValue();
  }

  visitInList(node: InList): R {
    node.expr.accept(this);
    for (const v of node.values) {
      v.accept(this);
    }
    return this.defaultValue();
  }

  visitAnyArray(node: AnyArray): R {
    node.expr.accept(this);
    node.array.accept(this);
    return this.defaultValue();
  }

  visitAnd(node: And): R {
    for (const c of node.conditions) {
      c.accept(this);
    }
    return this.defaultValue();
  }

  visitOr(node: Or): R {
    for (const c of node.conditions) {
      c.accept(this);
    }
    return this.defaultValue();
  }

  visitNot(node: Not): R {
    node.condition.accept(this);
    return this.defaultValue();
  }

  visitRawCondition(_node: RawCondition): R {
    return this.defaultValue();
  }

  visitExists(node: Exists): R {
    node.subquery.accept(this);
    return this.defaultValue();
  }

  visitSelect(node: Select): R {
    for (const col of node.columns) {
      col.expr.accept(this);
    }
    if (node.where) node.where.accept(this);
    if (node.having) node.having.accept(this);
    for (const ob of node.orderBy ?? []) {
      ob.expr.accept(this);
    }
    for (const gb of node.groupBy ?? []) {
      gb.accept(this);
    }
    node.limit?.accept(this);
    node.offset?.accept(this);
    return this.defaultValue();
  }
}


/** Create a column reference */
export const col = (column: string, table?: string) =>
  new ColumnRef(column, table);

/** Create a JSON path access */
export const json = (column: string, path: string[], asText = true) =>
  new JsonPath(column, path, asText);

/** Create a parameter placeholder */
export const param = (index: number) => new Param(index);

/** Create raw SQL */
export const raw = (sql: string) => new RawSql(sql);

/** Create a comparison */
export const cmp = (left: ExprNode, op: Sql.Op, right: ExprNode) =>
  new Compare(left, op, right);

/** Create IS NULL */
export const isNull = (expr: ExprNode, negated = false) =>
  new IsNull(expr, negated);

/** Create BETWEEN */
export const between = (expr: ExprNode, low: ExprNode, high: ExprNode) =>
  new Between(expr, low, high);

/** Create IN list */
export const inList = (expr: ExprNode, values: ExprNode[], negated = false) =>
  new InList(expr, values, negated);

/** Create AND */
export const and = (...conditions: ConditionNode[]) => new And(conditions);

/** Create OR */
export const or = (...conditions: ConditionNode[]) => new Or(conditions);

/** Create NOT */
export const not = (condition: ConditionNode) => new Not(condition);

/** Create EXISTS */
export const exists = (subquery: Select) => new Exists(subquery);

/** Create aggregate */
export const agg = (func: Sql.Agg, expr?: ExprNode, distinct = false) =>
  new Aggregate(func, expr, distinct);
