/**
 * PostgreSQL Namespace
 *
 * Groups pure SQL-generation helpers under a single namespace. Operations
 * that hit the database live on `PgDatabaseOps` / `PgSchemaIntrospection`
 * instead.
 *
 * @example
 * ```typescript
 * import { pg } from '@justscale/postgres';
 *
 * const sql = pg.generateCreateTableSQL(config);
 * ```
 */

import {
  generateCreateTableSQL,
  generateDropTableSQL,
  generateIndexSQL,
} from '../pg-database.js';

export const pg = {
  /** Generate CREATE TABLE SQL from storage config */
  generateCreateTableSQL,
  /** Generate CREATE INDEX SQL statements from storage config */
  generateIndexSQL,
  /** Generate DROP TABLE SQL for a table name */
  generateDropTableSQL,
} as const;
