/**
 * PostgreSQL Query Builder
 *
 * Implements QueryBuilderLike for use with PgQueryIterator.
 * Wraps the existing SQL building logic from PgRepository.find() and PgQueryCompiler.
 */

import type { Condition } from '@justscale/core/models';
import { isOrderByItem, type OrderBy, type OrderByItem } from '@justscale/core/models';
import type { AbstractPostgresClient } from '../client/client.js';
import { PgQueryCompiler } from './query-compiler.js';
import {
  type QueryBuilderLike,
  generateKeysetWhereClause,
  createQueryHash,
} from './query-iterator.js';

export class PgQueryBuilder<T extends Record<string, unknown>> implements QueryBuilderLike<T> {
  constructor(
    private readonly client: AbstractPostgresClient,
    private readonly tableName: string,
    private readonly compiler: PgQueryCompiler,
    private readonly uniqueFields: Set<string>,
    private readonly where?: Condition,
    private readonly orderBySpec?: OrderBy<any>,
    private readonly limitN?: number,
    private readonly keysetFilter?: {
      sortKey: string[]
      lastSeen: Record<string, unknown>
      directions: ('asc' | 'desc')[]
    },
  ) {}

  clone(): PgQueryBuilder<T> {
    return new PgQueryBuilder(
      this.client,
      this.tableName,
      this.compiler,
      this.uniqueFields,
      this.where,
      this.orderBySpec,
      this.limitN,
      this.keysetFilter ? { ...this.keysetFilter } : undefined,
    );
  }

  limit(n: number): PgQueryBuilder<T> {
    return new PgQueryBuilder(
      this.client,
      this.tableName,
      this.compiler,
      this.uniqueFields,
      this.where,
      this.orderBySpec,
      n,
      this.keysetFilter,
    );
  }

  async execute(): Promise<T[]> {
    const sql = this.client.sql;
    const parts: string[] = [`SELECT * FROM ${this.tableName}`];
    const values: unknown[] = [];

    // Collect WHERE conditions
    const conditions: string[] = [];
    let paramOffset = 0;

    // User WHERE clause
    if (this.where) {
      const compiled = this.compiler.compileWhere(this.where);
      conditions.push(`(${compiled.text})`);
      values.push(...compiled.values);
      paramOffset = compiled.values.length;
    }

    // Keyset WHERE clause
    if (this.keysetFilter) {
      const keyset = generateKeysetWhereClause(
        this.keysetFilter.sortKey,
        this.keysetFilter.lastSeen,
        this.keysetFilter.directions,
      );
      // Rewrite parameter indices to account for user WHERE params
      const rewritten = paramOffset > 0
        ? keyset.text.replace(/\$(\d+)/g, (_, n) => `$${Number.parseInt(n, 10) + paramOffset}`)
        : keyset.text;
      conditions.push(`(${rewritten})`);
      values.push(...keyset.values);
    }

    if (conditions.length > 0) {
      parts.push(`WHERE ${conditions.join(' AND ')}`);
    }

    // ORDER BY clause
    if (this.orderBySpec) {
      const compiled = this.compiler.compileOrderBy(this.orderBySpec);
      if (compiled.text) {
        parts.push(`ORDER BY ${compiled.text}`);
      }
    }

    // LIMIT
    if (this.limitN !== undefined) {
      parts.push(`LIMIT ${this.limitN}`);
    }

    const query = parts.join(' ');
    const result = await sql.unsafe(
      query,
      values as (string | number | boolean | Date | null)[],
    );

    return result as unknown as T[];
  }

  getOrderByColumns(): string[] {
    return this.parseOrderBy().map(o => o.column);
  }

  getOrderByDirections(): ('asc' | 'desc')[] {
    return this.parseOrderBy().map(o => o.direction);
  }

  hasUniqueColumn(column: string): boolean {
    return this.uniqueFields.has(column);
  }

  getPrimaryKeyColumn(): string {
    return 'id';
  }

  appendOrderBy(column: string, direction: 'asc' | 'desc'): void {
    // Append to existing orderBy spec - cast away readonly for internal mutation
    const spec = (this.orderBySpec ?? {}) as Record<string, string>;
    spec[column] = direction;
    (this as unknown as { orderBySpec?: unknown }).orderBySpec = spec;
  }

  toHash(): string {
    const whereText = this.where
      ? this.compiler.compileWhere(this.where).text
      : undefined;
    const orderByText = this.orderBySpec
      ? this.compiler.compileOrderBy(this.orderBySpec).text
      : undefined;

    return createQueryHash({
      table: this.tableName,
      where: whereText,
      orderBy: orderByText,
    });
  }

  whereKeyset(
    sortKey: string[],
    lastSeen: Record<string, unknown>,
    directions: ('asc' | 'desc')[],
  ): PgQueryBuilder<T> {
    return new PgQueryBuilder(
      this.client,
      this.tableName,
      this.compiler,
      this.uniqueFields,
      this.where,
      this.orderBySpec,
      this.limitN,
      { sortKey, lastSeen, directions },
    );
  }

  /**
   * Parse the orderBy spec into column name + direction pairs.
   * Column names are the SQL column names (snake_case) as produced by the compiler.
   */
  private parseOrderBy(): { column: string; direction: 'asc' | 'desc' }[] {
    if (!this.orderBySpec) return [];

    const result: { column: string; direction: 'asc' | 'desc' }[] = [];

    if (Array.isArray(this.orderBySpec)) {
      for (const item of this.orderBySpec) {
        if (isOrderByItem(item)) {
          const compiled = this.compiler.compileOrderBy([item]);
          // compiled.text is like "created_at ASC" or "\"data\"->>'field' DESC"
          const col = this.extractColumnFromOrderBy(compiled.text);
          result.push({ column: col, direction: (item as OrderByItem).direction });
        }
      }
    } else {
      for (const [field, direction] of Object.entries(this.orderBySpec)) {
        if (direction) {
          const compiled = this.compiler.compileOrderBy({ [field]: direction });
          const col = this.extractColumnFromOrderBy(compiled.text);
          result.push({ column: col, direction: direction as 'asc' | 'desc' });
        }
      }
    }

    return result;
  }

  /**
   * Extract the column expression from a single ORDER BY clause.
   * Input: "orders.created_at ASC" -> "created_at"
   * Input: "created_at DESC NULLS FIRST" -> "created_at"
   */
  private extractColumnFromOrderBy(text: string): string {
    // Remove trailing ASC/DESC and NULLS FIRST/LAST
    let col = text
      .replace(/\s+(ASC|DESC)(\s+NULLS\s+(FIRST|LAST))?$/i, '')
      .trim();
    // Strip table prefix (e.g. "orders.created_at" -> "created_at")
    const dotIdx = col.lastIndexOf('.');
    if (dotIdx !== -1) {
      col = col.substring(dotIdx + 1);
    }
    return col;
  }
}
