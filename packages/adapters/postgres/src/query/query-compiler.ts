/**
 * PostgreSQL Query Compiler
 *
 * Transforms Condition AST from @justscale/core/models into SQL AST,
 * then prints to PostgreSQL-specific SQL strings with parameters.
 *
 * Supports two storage modes:
 * - Columnar: Fields map to table columns (field -> column_name)
 * - JSONB: Fields stored in a data column (field -> data->>'field')
 *
 * @example
 * ```typescript
 * import { PgQueryCompiler, Sql } from '@justscale/postgres';
 *
 * const compiler = new PgQueryCompiler({
 *   storageMode: 'jsonb',
 *   dataColumn: 'data',
 * });
 *
 * const { text, values } = compiler.compileWhere(
 *   status.eq('published')
 * );
 * // text: "data->>'status' = $1"
 * // values: ['published']
 * ```
 */

import type {
  AfterCondition,
  Aggregation,
  AndCondition,
  ArrayContainsCondition,
  ArrayHasAllCondition,
  ArrayHasAnyCondition,
  ArrayOverlapsCondition,
  BeforeCondition,
  BetweenCondition,
  Condition,
  ContainsCondition,
  EndsWithCondition,
  EqCondition,
  FieldDef,
  GtCondition,
  GteCondition,
  HasCondition,
  ILikeCondition,
  InCondition,
  IsNotNullCondition,
  IsNullCondition,
  LikeCondition,
  LtCondition,
  LteCondition,
  NeqCondition,
  NotCondition,
  NotInCondition,
  OrCondition,
  OrderBy as OrderByOptions,
  RawCondition,
  StartsWithCondition,
} from '@justscale/core/models';
import { isOrderByItem } from '@justscale/core/models';

import { ModelRegistry } from '../model/model-registry.js';
import {
  Aggregate,
  And,
  ArrayContains,
  ArrayContainsAll,
  ArrayOverlap,
  Between,
  Cast,
  ColumnRef,
  Compare,
  type ConditionNode,
  Exists,
  type ExprNode,
  From,
  InList,
  IsNull,
  JsonPath,
  JsonbArrayContains,
  Not,
  Or,
  OrderBy as OrderByAst,
  Param,
  RawCondition as RawConditionNode,
  RawSql,
  Select,
  SelectColumn,
  Sql,
} from '../sql/sql-ast.js';

export interface CompiledSql {
  readonly text: string
  readonly values: unknown[]
}

export type StorageMode = 'columnar' | 'jsonb';

export interface ModelContext {
  modelName: string
  fieldDefs: Record<string, FieldDef>
}

/** Alias context for tracking unique table aliases in nested has() */
export interface AliasContext {
  /** Counter for generating unique aliases */
  counter: number
  /** Map of table name -> current alias (for self-joins) */
  aliases: Map<string, string>
}

export interface PgQueryCompilerOptions {
  /**
   * How fields are stored in the table.
   * - 'columnar': Fields map to columns (status -> status)
   * - 'jsonb': Fields stored in JSON column (status -> data->>'status')
   */
  storageMode?: StorageMode
  dataColumn?: string
  snakeCase?: boolean
  tableName?: string
  fieldMap?: Record<string, string>
  systemFields?: string[]
  /** Required when using has() conditions across model relationships. */
  modelContext?: ModelContext
  aliasContext?: AliasContext
  tableAlias?: string
}

class ParamContext {
  private values: unknown[] = [];
  private index = 0;

  add(value: unknown): number {
    this.values.push(value);
    return ++this.index;
  }

  getValues(): unknown[] {
    return this.values;
  }

  reset(): void {
    this.values = [];
    this.index = 0;
  }
}

// ============================================================================
// Query Compiler
// ============================================================================

/**
 * Compiles Condition AST to PostgreSQL SQL.
 *
 * Two-pass process:
 * 1. Transform Condition to SQL AST (with field mapping)
 * 2. Print SQL AST to SQL string (via node.toSql())
 */
export class PgQueryCompiler {
  private readonly storageMode: StorageMode;
  private readonly dataColumn: string;
  private readonly snakeCase: boolean;
  private readonly tableName?: string;
  private readonly fieldMap: Record<string, string>;
  private readonly systemFields: Set<string>;
  private readonly modelContext?: ModelContext;
  private readonly aliasContext: AliasContext;
  private readonly tableAlias?: string;

  constructor(options: PgQueryCompilerOptions = {}) {
    this.storageMode = options.storageMode ?? 'columnar';
    this.dataColumn = options.dataColumn ?? 'data';
    this.snakeCase = options.snakeCase ?? true;
    this.tableName = options.tableName;
    this.fieldMap = options.fieldMap ?? {};
    this.systemFields = new Set(
      options.systemFields ?? [
        'id',
        'createdAt',
        'updatedAt',
        'version',
        'modelName',
      ],
    );
    this.modelContext = options.modelContext;
    this.aliasContext = options.aliasContext ?? {
      counter: 0,
      aliases: new Map(),
    };
    this.tableAlias = options.tableAlias;
  }

  /**
   * Get the effective table reference (alias if set, otherwise table name).
   */
  private getTableRef(): string | undefined {
    return this.tableAlias ?? this.tableName;
  }

  /**
   * Generate a unique table alias.
   */
  private generateAlias(tableName: string): string {
    this.aliasContext.counter++;
    return `${tableName}_${this.aliasContext.counter}`;
  }


  /**
   * Compile a WHERE clause condition to SQL.
   */
  compileWhere(condition: Condition): CompiledSql {
    const ctx = new ParamContext();
    const ast = this.conditionToAst(condition, ctx);
    return { text: ast.toSql(), values: ctx.getValues() };
  }

  /**
   * Compile an ORDER BY clause.
   * Supports both object form `{ field: 'asc' }` and array form `[field.asc()]`
   */
  compileOrderBy<T>(orderBy: OrderByOptions<T>): CompiledSql {
    const parts: string[] = [];

    // Check if it's the array form (OrderByItem[])
    if (Array.isArray(orderBy)) {
      for (const item of orderBy) {
        if (isOrderByItem(item)) {
          const expr = this.fieldToExpr(item.field);
          const dir = item.direction === 'desc' ? Sql.Sort.Desc : Sql.Sort.Asc;
          const nulls =
            item.nulls === 'first'
              ? Sql.Nulls.First
              : item.nulls === 'last'
                ? Sql.Nulls.Last
                : undefined;
          const orderAst = new OrderByAst(expr, dir, nulls);
          parts.push(orderAst.toSql());
        }
      }
    } else {
      // Object form { field: 'asc' | 'desc' }
      for (const [field, direction] of Object.entries(orderBy)) {
        if (direction) {
          const expr = this.fieldToExpr(field);
          const dir = direction === 'desc' ? Sql.Sort.Desc : Sql.Sort.Asc;
          const orderAst = new OrderByAst(expr, dir);
          parts.push(orderAst.toSql());
        }
      }
    }

    return { text: parts.join(', '), values: [] };
  }

  /**
   * Compile an aggregation expression.
   */
  compileAggregation(agg: Aggregation, ctx?: ParamContext): CompiledSql {
    const context = ctx ?? new ParamContext();
    const ast = this.aggregationToAst(agg, context);
    return { text: ast.toSql(), values: context.getValues() };
  }

  /**
   * Get the SQL AST for a condition (for inspection/optimization).
   */
  toAst(condition: Condition): { ast: ConditionNode; values: unknown[] } {
    const ctx = new ParamContext();
    const ast = this.conditionToAst(condition, ctx);
    return { ast, values: ctx.getValues() };
  }


  /**
   * Create an expression node for a field.
   * Supports dotted paths for nested object fields (e.g., 'settings.theme').
   */
  private fieldToExpr(fieldName: string): ExprNode {
    const tableRef = this.getTableRef();

    // Check if this is a dotted path (nested object field)
    if (fieldName.includes('.')) {
      const pathParts = fieldName.split('.');
      const rootField = pathParts[0];
      const nestedPath = pathParts.slice(1);

      // In JSONB mode, entire path goes through data column
      if (this.storageMode === 'jsonb' && !this.systemFields.has(rootField)) {
        const dataCol = tableRef
          ? `${tableRef}.${this.dataColumn}`
          : this.dataColumn;
        return new JsonPath(dataCol, pathParts, true);
      }

      // In columnar mode, the root field is a JSONB column, nested path goes into it
      const rootColName =
        this.fieldMap[rootField] ??
        (this.snakeCase ? this.toSnakeCase(rootField) : rootField);
      const colRef = tableRef ? `${tableRef}.${rootColName}` : rootColName;
      return new JsonPath(colRef, nestedPath, true);
    }

    // Check explicit mapping first
    if (fieldName in this.fieldMap) {
      return new ColumnRef(this.fieldMap[fieldName], tableRef);
    }

    // System fields are always columnar
    if (this.systemFields.has(fieldName)) {
      const colName = this.snakeCase ? this.toSnakeCase(fieldName) : fieldName;
      return new ColumnRef(colName, tableRef);
    }

    // For JSONB mode, non-system fields go into the data column
    if (this.storageMode === 'jsonb') {
      // For JSONB, we need to prefix the data column with table ref
      const dataCol = tableRef
        ? `${tableRef}.${this.dataColumn}`
        : this.dataColumn;
      return new JsonPath(dataCol, [fieldName], true);
    }

    // Columnar mode
    const colName = this.snakeCase ? this.toSnakeCase(fieldName) : fieldName;
    return new ColumnRef(colName, tableRef);
  }

  /**
   * Convert camelCase to snake_case.
   */
  private toSnakeCase(str: string): string {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Condition -> AST
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Transform a Condition to SQL AST.
   */
  private conditionToAst(
    condition: Condition,
    ctx: ParamContext,
  ): ConditionNode {
    switch (condition.type) {
      case 'eq':
        return this.eqToAst(condition, ctx);
      case 'neq':
        return this.neqToAst(condition, ctx);
      case 'gt':
        return this.gtToAst(condition, ctx);
      case 'gte':
        return this.gteToAst(condition, ctx);
      case 'lt':
        return this.ltToAst(condition, ctx);
      case 'lte':
        return this.lteToAst(condition, ctx);
      case 'like':
        return this.likeToAst(condition, ctx);
      case 'ilike':
        return this.ilikeToAst(condition, ctx);
      case 'in':
        return this.inToAst(condition, ctx);
      case 'notIn':
        return this.notInToAst(condition, ctx);
      case 'between':
        return this.betweenToAst(condition, ctx);
      case 'isNull':
        return this.isNullToAst(condition);
      case 'isNotNull':
        return this.isNotNullToAst(condition);
      case 'startsWith':
        return this.startsWithToAst(condition, ctx);
      case 'endsWith':
        return this.endsWithToAst(condition, ctx);
      case 'contains':
        return this.containsToAst(condition, ctx);
      case 'before':
        return this.beforeToAst(condition, ctx);
      case 'after':
        return this.afterToAst(condition, ctx);
      case 'and':
        return this.andToAst(condition, ctx);
      case 'or':
        return this.orToAst(condition, ctx);
      case 'not':
        return this.notToAst(condition, ctx);
      case 'has':
        return this.hasToAst(condition, ctx);
      case 'raw':
        return this.rawToAst(condition, ctx);
      case 'arrayContains':
        return this.arrayContainsToAst(condition, ctx);
      case 'arrayHasAny':
        return this.arrayHasAnyToAst(condition, ctx);
      case 'arrayHasAll':
        return this.arrayHasAllToAst(condition, ctx);
      case 'arrayOverlaps':
        return this.arrayOverlapsToAst(condition, ctx);
      default:
        throw new Error(
          `Unknown condition type: ${(condition as Condition).type}`,
        );
    }
  }

  private eqToAst(cond: EqCondition, ctx: ParamContext): ConditionNode {
    const fieldExpr = this.fieldToExpr(cond.field);
    const paramExpr = new Param(ctx.add(cond.value));

    // When comparing JSON path extraction with boolean, cast the extracted text to boolean
    if (
      fieldExpr instanceof JsonPath &&
      fieldExpr.asText &&
      typeof cond.value === 'boolean'
    ) {
      return new Compare(new Cast(fieldExpr, 'boolean'), Sql.Op.Eq, paramExpr);
    }

    return new Compare(fieldExpr, Sql.Op.Eq, paramExpr);
  }

  private neqToAst(cond: NeqCondition, ctx: ParamContext): ConditionNode {
    return new Compare(
      this.fieldToExpr(cond.field),
      Sql.Op.Neq,
      new Param(ctx.add(cond.value)),
    );
  }

  private gtToAst(cond: GtCondition, ctx: ParamContext): ConditionNode {
    return new Compare(
      this.fieldToExpr(cond.field),
      Sql.Op.Gt,
      new Param(ctx.add(cond.value)),
    );
  }

  private gteToAst(cond: GteCondition, ctx: ParamContext): ConditionNode {
    return new Compare(
      this.fieldToExpr(cond.field),
      Sql.Op.Gte,
      new Param(ctx.add(cond.value)),
    );
  }

  private ltToAst(cond: LtCondition, ctx: ParamContext): ConditionNode {
    return new Compare(
      this.fieldToExpr(cond.field),
      Sql.Op.Lt,
      new Param(ctx.add(cond.value)),
    );
  }

  private lteToAst(cond: LteCondition, ctx: ParamContext): ConditionNode {
    return new Compare(
      this.fieldToExpr(cond.field),
      Sql.Op.Lte,
      new Param(ctx.add(cond.value)),
    );
  }

  private likeToAst(cond: LikeCondition, ctx: ParamContext): ConditionNode {
    return new Compare(
      this.fieldToExpr(cond.field),
      Sql.Op.Like,
      new Param(ctx.add(cond.pattern)),
    );
  }

  private ilikeToAst(cond: ILikeCondition, ctx: ParamContext): ConditionNode {
    return new Compare(
      this.fieldToExpr(cond.field),
      Sql.Op.ILike,
      new Param(ctx.add(cond.pattern)),
    );
  }

  private inToAst(cond: InCondition, ctx: ParamContext): ConditionNode {
    const values = cond.values.map((v: unknown) => new Param(ctx.add(v)));
    return new InList(this.fieldToExpr(cond.field), values, false);
  }

  private notInToAst(cond: NotInCondition, ctx: ParamContext): ConditionNode {
    const values = cond.values.map((v: unknown) => new Param(ctx.add(v)));
    return new InList(this.fieldToExpr(cond.field), values, true);
  }

  private betweenToAst(
    cond: BetweenCondition,
    ctx: ParamContext,
  ): ConditionNode {
    return new Between(
      this.fieldToExpr(cond.field),
      new Param(ctx.add(cond.min)),
      new Param(ctx.add(cond.max)),
    );
  }

  private isNullToAst(cond: IsNullCondition): ConditionNode {
    return new IsNull(this.fieldToExpr(cond.field), false);
  }

  private isNotNullToAst(cond: IsNotNullCondition): ConditionNode {
    return new IsNull(this.fieldToExpr(cond.field), true);
  }

  private startsWithToAst(
    cond: StartsWithCondition,
    ctx: ParamContext,
  ): ConditionNode {
    const escaped = this.escapeLike(cond.prefix);
    return new Compare(
      this.fieldToExpr(cond.field),
      Sql.Op.Like,
      new Param(ctx.add(`${escaped}%`)),
    );
  }

  private endsWithToAst(
    cond: EndsWithCondition,
    ctx: ParamContext,
  ): ConditionNode {
    const escaped = this.escapeLike(cond.suffix);
    return new Compare(
      this.fieldToExpr(cond.field),
      Sql.Op.Like,
      new Param(ctx.add(`%${escaped}`)),
    );
  }

  private containsToAst(
    cond: ContainsCondition,
    ctx: ParamContext,
  ): ConditionNode {
    const escaped = this.escapeLike(cond.substring);
    return new Compare(
      this.fieldToExpr(cond.field),
      Sql.Op.Like,
      new Param(ctx.add(`%${escaped}%`)),
    );
  }

  private beforeToAst(cond: BeforeCondition, ctx: ParamContext): ConditionNode {
    return new Compare(
      this.fieldToExpr(cond.field),
      Sql.Op.Lt,
      new Param(ctx.add(cond.date)),
    );
  }

  private afterToAst(cond: AfterCondition, ctx: ParamContext): ConditionNode {
    return new Compare(
      this.fieldToExpr(cond.field),
      Sql.Op.Gt,
      new Param(ctx.add(cond.date)),
    );
  }

  private andToAst(cond: AndCondition, ctx: ParamContext): ConditionNode {
    if (cond.conditions.length === 0) {
      return new RawConditionNode('TRUE');
    }
    if (cond.conditions.length === 1) {
      return this.conditionToAst(cond.conditions[0], ctx);
    }
    return new And(
      cond.conditions.map((c: Condition) => this.conditionToAst(c, ctx)),
    );
  }

  private orToAst(cond: OrCondition, ctx: ParamContext): ConditionNode {
    if (cond.conditions.length === 0) {
      return new RawConditionNode('FALSE');
    }
    if (cond.conditions.length === 1) {
      return this.conditionToAst(cond.conditions[0], ctx);
    }
    return new Or(
      cond.conditions.map((c: Condition) => this.conditionToAst(c, ctx)),
    );
  }

  private notToAst(cond: NotCondition, ctx: ParamContext): ConditionNode {
    return new Not(this.conditionToAst(cond.condition, ctx));
  }

  private hasToAst(cond: HasCondition, ctx: ParamContext): ConditionNode {
    // .has() generates an EXISTS subquery
    // This requires model metadata to know the related table and join column

    if (!this.modelContext) {
      throw new Error(
        `has() conditions require model metadata. Field: ${cond.field}. Use the repository-level compiler with model context.`,
      );
    }

    // Get the field definition for the ref field
    const fieldDef = this.modelContext.fieldDefs[cond.field] as
      | FieldDef
      | undefined;
    if (!fieldDef) {
      throw new Error(
        `has() condition references unknown field "${cond.field}" on model "${this.modelContext.modelName}".`,
      );
    }

    if (fieldDef.type !== 'ref' && fieldDef.type !== 'refs') {
      throw new Error(
        `has() condition can only be used on ref/refs fields. Field "${cond.field}" is type "${fieldDef.type}".`,
      );
    }

    // Look up the source model in the registry
    const sourceEntry = ModelRegistry.get(this.modelContext.modelName);
    if (!sourceEntry) {
      throw new Error(
        `Model "${this.modelContext.modelName}" not found in registry. Ensure the model repository is created before using has() conditions.`,
      );
    }

    // Resolve the ref context (target model info)
    const refContext = ModelRegistry.resolveRefContext(
      sourceEntry,
      cond.field,
      fieldDef,
    );
    if (!refContext) {
      throw new Error(
        `Could not resolve target model for ref field "${cond.field}". Ensure the target model repository is created and registered.`,
      );
    }

    // Generate EXISTS subquery:
    // EXISTS (SELECT 1 FROM target_table AS t1 WHERE t1.id = source.fk_column AND nested_condition)

    // Generate unique alias for target table (important for self-joins and nested has())
    const targetAlias = this.generateAlias(refContext.targetTable);

    // Create a compiler for the target model to compile the nested condition
    const targetCompiler = new PgQueryCompiler({
      storageMode: refContext.targetStorageMode,
      dataColumn: this.dataColumn,
      snakeCase: this.snakeCase,
      tableName: refContext.targetTable,
      tableAlias: targetAlias, // Use the unique alias
      fieldMap: refContext.targetFieldMap,
      systemFields: Array.from(this.systemFields),
      modelContext: {
        modelName: refContext.targetModelName,
        fieldDefs: refContext.targetFieldDefs,
      },
      aliasContext: this.aliasContext, // Share alias context for consistent counting
    });

    // Compile the nested condition using the target compiler
    const nestedAst = targetCompiler.conditionToAstInternal(cond.condition, ctx);

    // Build the JOIN condition: target_alias.id = source.fk_column
    const sourceTableRef = this.getTableRef();
    const joinCondition = new Compare(
      new ColumnRef(refContext.targetIdColumn, targetAlias),
      Sql.Op.Eq,
      new ColumnRef(refContext.fkColumn, sourceTableRef),
    );

    // Combine JOIN condition with nested condition
    const whereClause = new And([joinCondition, nestedAst]);

    // Build EXISTS subquery with alias
    const subquery = new Select({
      columns: [new SelectColumn(new RawSql('1'))],
      from: new From(refContext.targetTable, targetAlias),
      where: whereClause,
    });

    return new Exists(subquery);
  }

  /**
   * Internal method for recursive condition compilation (used by has()).
   */
  conditionToAstInternal(
    condition: Condition,
    ctx: ParamContext,
  ): ConditionNode {
    return this.conditionToAst(condition, ctx);
  }

  private rawToAst(cond: RawCondition, ctx: ParamContext): ConditionNode {
    // Process raw SQL, mapping original $N placeholders to new context indices
    // Build a map from original placeholder index to new context index
    // This supports placeholder reuse - $1 appearing twice will refer to the same value
    const placeholderMap = new Map<number, number>();

    // Add each value to context and map its original index to the new index
    cond.values.forEach((value: unknown, idx: number) => {
      placeholderMap.set(idx + 1, ctx.add(value)); // $1 = values[0], $2 = values[1], etc.
    });

    // Replace $1, $2, etc. with their new indices based on the map
    const sql = cond.sql.replace(/\$(\d+)/g, (_: string, numStr: string) => {
      const originalIdx = Number.parseInt(numStr, 10);
      const newIdx = placeholderMap.get(originalIdx);
      if (newIdx === undefined) {
        throw new Error(
          `Raw SQL references $${originalIdx} but only ${cond.values.length} values provided`,
        );
      }
      return `$${newIdx}`;
    });

    return new RawConditionNode(sql);
  }

  private arrayContainsToAst(
    cond: ArrayContainsCondition,
    ctx: ParamContext,
  ): ConditionNode {
    const fieldExpr = this.fieldToExpr(cond.field);

    // When dealing with JSONB paths, use JSONB containment
    if (fieldExpr instanceof JsonPath) {
      // Create a JSONB path (asText=false) for containment check
      const jsonbPath = new JsonPath(fieldExpr.column, fieldExpr.path, false);
      return new JsonbArrayContains(jsonbPath, new Param(ctx.add(cond.value)));
    }

    return new ArrayContains(fieldExpr, new Param(ctx.add(cond.value)));
  }

  private arrayHasAnyToAst(
    cond: ArrayHasAnyCondition,
    ctx: ParamContext,
  ): ConditionNode {
    const values = cond.values.map((v: unknown) => new Param(ctx.add(v)));
    return new ArrayOverlap(this.fieldToExpr(cond.field), values);
  }

  private arrayHasAllToAst(
    cond: ArrayHasAllCondition,
    ctx: ParamContext,
  ): ConditionNode {
    const values = cond.values.map((v: unknown) => new Param(ctx.add(v)));
    return new ArrayContainsAll(this.fieldToExpr(cond.field), values);
  }

  private arrayOverlapsToAst(
    cond: ArrayOverlapsCondition,
    ctx: ParamContext,
  ): ConditionNode {
    const values = cond.values.map((v: unknown) => new Param(ctx.add(v)));
    return new ArrayOverlap(this.fieldToExpr(cond.field), values);
  }

  /**
   * Escape special LIKE characters.
   */
  private escapeLike(str: string): string {
    return str.replace(/[%_\\]/g, '\\$&');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Aggregation -> AST
  // ─────────────────────────────────────────────────────────────────────────

  private aggregationToAst(agg: Aggregation, _ctx: ParamContext): ExprNode {
    const funcMap: Record<string, Sql.Agg> = {
      count: Sql.Agg.Count,
      sum: Sql.Agg.Sum,
      avg: Sql.Agg.Avg,
      min: Sql.Agg.Min,
      max: Sql.Agg.Max,
    };

    const func = funcMap[agg.type];
    if (!func) {
      throw new Error(`Unknown aggregation type: ${agg.type}`);
    }

    const expr =
      'field' in agg && agg.field ? this.fieldToExpr(agg.field) : undefined;
    // Check if distinct is explicitly a boolean true (not the method)
    const distinct =
      'distinct' in agg && typeof agg.distinct === 'boolean' && agg.distinct;

    return new Aggregate(func, expr, distinct);
  }
}
