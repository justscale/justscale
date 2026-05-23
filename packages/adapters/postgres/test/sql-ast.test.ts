/**
 * SQL AST Unit Tests
 *
 * Tests for the SQL Abstract Syntax Tree nodes, factory functions,
 * and visitor pattern.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  // Base classes
  SqlNode,
  ExprNode,
  ConditionNode,
  StatementNode,
  // Namespace
  Sql,
  // Expression nodes
  ColumnRef,
  JsonPath,
  Param,
  RawSql,
  NullLiteral,
  Aggregate,
  // Condition nodes
  Compare,
  IsNull,
  Between,
  InList,
  AnyArray,
  And,
  Or,
  Not,
  RawCondition,
  Exists,
  // Statement components
  SelectColumn,
  From,
  Join,
  OrderBy,
  Select,
  // Visitor
  BaseSqlVisitor,
  // Factory functions
  col,
  json,
  param,
  raw,
  cmp,
  isNull,
  between,
  inList,
  and,
  or,
  not,
  exists,
  agg,
} from '../src/sql/sql-ast.js';

// ============================================================================
// Expression Nodes
// ============================================================================

describe('SQL AST - Expression Nodes', () => {
  describe('ColumnRef', () => {
    it('should generate simple column reference', () => {
      const node = new ColumnRef('email');
      assert.strictEqual(node.toSql(), 'email');
    });

    it('should generate qualified column reference', () => {
      const node = new ColumnRef('email', 'users');
      assert.strictEqual(node.toSql(), 'users.email');
    });

    it('should be an ExprNode', () => {
      const node = new ColumnRef('id');
      assert.ok(node instanceof ExprNode);
      assert.ok(node instanceof SqlNode);
    });
  });

  describe('JsonPath', () => {
    it('should return column name for empty path', () => {
      const node = new JsonPath('data', []);
      assert.strictEqual(node.toSql(), 'data');
    });

    it('should generate text extraction (->>)', () => {
      const node = new JsonPath('data', ['name'], true);
      assert.strictEqual(node.toSql(), "data->>'name'");
    });

    it('should generate jsonb extraction (->)', () => {
      const node = new JsonPath('data', ['settings'], false);
      assert.strictEqual(node.toSql(), "data->'settings'");
    });

    it('should handle nested paths', () => {
      const node = new JsonPath('data', ['user', 'profile', 'name'], true);
      assert.strictEqual(node.toSql(), "data->'user'->'profile'->>'name'");
    });

    it('should handle deeply nested paths with jsonb return', () => {
      const node = new JsonPath('config', ['a', 'b', 'c'], false);
      assert.strictEqual(node.toSql(), "config->'a'->'b'->'c'");
    });

    // Path parts are user-data keys that reach SQL inside '...' literals,
    // so a key containing ' would break out without escaping.
    it("should escape single quotes inside path parts to prevent injection", () => {
      const node = new JsonPath('data', ["k'='admin' --"], true);
      assert.strictEqual(node.toSql(), "data->>'k''=''admin'' --'");
    });

    it("should escape single quotes in nested path parts", () => {
      const node = new JsonPath('data', ["a'b", 'c'], false);
      assert.strictEqual(node.toSql(), "data->'a''b'->'c'");
    });

    // Column part comes from internal callers but is interpolated raw
    // (no quoting). Reject anything that isn't a valid SQL identifier so
    // a runtime caller can't smuggle SQL through it.
    it('should reject column names with non-identifier characters', () => {
      assert.throws(() => new JsonPath('data; DROP TABLE x; --', ['k']), /Invalid SQL/);
      assert.throws(() => new JsonPath("data'", ['k']), /Invalid SQL/);
    });

    it('should accept qualified column refs like users_1.data', () => {
      const node = new JsonPath('users_1.data', ['name']);
      assert.strictEqual(node.toSql(), "users_1.data->>'name'");
    });
  });

  describe('ColumnRef injection guard', () => {
    // Realistic vector: repo.find({ orderBy: req.body }) with a malicious key.
    // ColumnRef must reject names that aren't valid identifiers.
    it('should reject column names with semicolons', () => {
      assert.throws(() => new ColumnRef('id; DROP TABLE users; --'), /Invalid SQL/);
    });

    it('should reject column names with quotes', () => {
      assert.throws(() => new ColumnRef("id\""), /Invalid SQL/);
      assert.throws(() => new ColumnRef("id'"), /Invalid SQL/);
    });

    it('should reject column names with whitespace', () => {
      assert.throws(() => new ColumnRef('id OR 1=1'), /Invalid SQL/);
    });

    it('should reject empty column name', () => {
      assert.throws(() => new ColumnRef(''), /Invalid SQL/);
    });

    it('should reject malicious table name on qualified ref', () => {
      assert.throws(() => new ColumnRef('id', 'users; DROP --'), /Invalid SQL/);
    });

    it('should accept valid snake_case names', () => {
      assert.strictEqual(new ColumnRef('user_id').toSql(), 'user_id');
      assert.strictEqual(new ColumnRef('_internal').toSql(), '_internal');
      assert.strictEqual(new ColumnRef('id', 'users_1').toSql(), 'users_1.id');
    });
  });

  describe('Param', () => {
    it('should generate parameter placeholder', () => {
      assert.strictEqual(new Param(1).toSql(), '$1');
      assert.strictEqual(new Param(10).toSql(), '$10');
      assert.strictEqual(new Param(100).toSql(), '$100');
    });
  });

  describe('RawSql', () => {
    it('should pass through raw SQL', () => {
      const node = new RawSql('NOW()');
      assert.strictEqual(node.toSql(), 'NOW()');
    });

    it('should preserve complex expressions', () => {
      const node = new RawSql("COALESCE(name, 'Unknown')");
      assert.strictEqual(node.toSql(), "COALESCE(name, 'Unknown')");
    });
  });

  describe('NullLiteral', () => {
    it('should generate NULL', () => {
      const node = new NullLiteral();
      assert.strictEqual(node.toSql(), 'NULL');
    });
  });

  describe('Aggregate', () => {
    it('should generate COUNT(*)', () => {
      const node = new Aggregate(Sql.Agg.Count);
      assert.strictEqual(node.toSql(), 'COUNT(*)');
    });

    it('should generate COUNT(column)', () => {
      const node = new Aggregate(Sql.Agg.Count, new ColumnRef('id'));
      assert.strictEqual(node.toSql(), 'COUNT(id)');
    });

    it('should generate COUNT(DISTINCT column)', () => {
      const node = new Aggregate(Sql.Agg.Count, new ColumnRef('status'), true);
      assert.strictEqual(node.toSql(), 'COUNT(DISTINCT status)');
    });

    it('should generate SUM', () => {
      const node = new Aggregate(Sql.Agg.Sum, new ColumnRef('amount'));
      assert.strictEqual(node.toSql(), 'SUM(amount)');
    });

    it('should generate AVG', () => {
      const node = new Aggregate(Sql.Agg.Avg, new ColumnRef('price'));
      assert.strictEqual(node.toSql(), 'AVG(price)');
    });

    it('should generate MIN/MAX', () => {
      assert.strictEqual(
        new Aggregate(Sql.Agg.Min, new ColumnRef('created_at')).toSql(),
        'MIN(created_at)',
      );
      assert.strictEqual(
        new Aggregate(Sql.Agg.Max, new ColumnRef('updated_at')).toSql(),
        'MAX(updated_at)',
      );
    });
  });
});

// ============================================================================
// Condition Nodes
// ============================================================================

describe('SQL AST - Condition Nodes', () => {
  describe('Compare', () => {
    it('should generate equality comparison', () => {
      const node = new Compare(new ColumnRef('status'), Sql.Op.Eq, new Param(1));
      assert.strictEqual(node.toSql(), 'status = $1');
    });

    it('should generate inequality comparison', () => {
      const node = new Compare(new ColumnRef('age'), Sql.Op.Neq, new Param(1));
      assert.strictEqual(node.toSql(), 'age <> $1');
    });

    it('should generate greater than', () => {
      const node = new Compare(new ColumnRef('price'), Sql.Op.Gt, new Param(1));
      assert.strictEqual(node.toSql(), 'price > $1');
    });

    it('should generate greater than or equal', () => {
      const node = new Compare(new ColumnRef('price'), Sql.Op.Gte, new Param(1));
      assert.strictEqual(node.toSql(), 'price >= $1');
    });

    it('should generate less than', () => {
      const node = new Compare(new ColumnRef('price'), Sql.Op.Lt, new Param(1));
      assert.strictEqual(node.toSql(), 'price < $1');
    });

    it('should generate less than or equal', () => {
      const node = new Compare(new ColumnRef('price'), Sql.Op.Lte, new Param(1));
      assert.strictEqual(node.toSql(), 'price <= $1');
    });

    it('should generate LIKE', () => {
      const node = new Compare(new ColumnRef('name'), Sql.Op.Like, new Param(1));
      assert.strictEqual(node.toSql(), 'name LIKE $1');
    });

    it('should generate ILIKE', () => {
      const node = new Compare(new ColumnRef('email'), Sql.Op.ILike, new Param(1));
      assert.strictEqual(node.toSql(), 'email ILIKE $1');
    });

    it('should be a ConditionNode', () => {
      const node = new Compare(new ColumnRef('x'), Sql.Op.Eq, new Param(1));
      assert.ok(node instanceof ConditionNode);
      assert.ok(node instanceof SqlNode);
    });
  });

  describe('IsNull', () => {
    it('should generate IS NULL', () => {
      const node = new IsNull(new ColumnRef('deleted_at'));
      assert.strictEqual(node.toSql(), 'deleted_at IS NULL');
    });

    it('should generate IS NOT NULL', () => {
      const node = new IsNull(new ColumnRef('email'), true);
      assert.strictEqual(node.toSql(), 'email IS NOT NULL');
    });
  });

  describe('Between', () => {
    it('should generate BETWEEN', () => {
      const node = new Between(new ColumnRef('age'), new Param(1), new Param(2));
      assert.strictEqual(node.toSql(), 'age BETWEEN $1 AND $2');
    });
  });

  describe('InList', () => {
    it('should generate IN', () => {
      const node = new InList(new ColumnRef('status'), [
        new Param(1),
        new Param(2),
        new Param(3),
      ]);
      assert.strictEqual(node.toSql(), 'status IN ($1, $2, $3)');
    });

    it('should generate NOT IN', () => {
      const node = new InList(
        new ColumnRef('status'),
        [new Param(1), new Param(2)],
        true,
      );
      assert.strictEqual(node.toSql(), 'status NOT IN ($1, $2)');
    });
  });

  describe('AnyArray', () => {
    it('should generate = ANY()', () => {
      const node = new AnyArray(new ColumnRef('id'), new Param(1));
      assert.strictEqual(node.toSql(), 'id = ANY($1)');
    });
  });

  describe('And', () => {
    it('should return TRUE for empty conditions', () => {
      const node = new And([]);
      assert.strictEqual(node.toSql(), 'TRUE');
    });

    it('should unwrap single condition', () => {
      const node = new And([new Compare(new ColumnRef('x'), Sql.Op.Eq, new Param(1))]);
      assert.strictEqual(node.toSql(), 'x = $1');
    });

    it('should combine multiple conditions', () => {
      const node = new And([
        new Compare(new ColumnRef('a'), Sql.Op.Eq, new Param(1)),
        new Compare(new ColumnRef('b'), Sql.Op.Eq, new Param(2)),
      ]);
      assert.strictEqual(node.toSql(), '(a = $1 AND b = $2)');
    });

    it('should handle three or more conditions', () => {
      const node = new And([
        new Compare(new ColumnRef('a'), Sql.Op.Eq, new Param(1)),
        new Compare(new ColumnRef('b'), Sql.Op.Eq, new Param(2)),
        new Compare(new ColumnRef('c'), Sql.Op.Eq, new Param(3)),
      ]);
      assert.strictEqual(node.toSql(), '(a = $1 AND b = $2 AND c = $3)');
    });
  });

  describe('Or', () => {
    it('should return FALSE for empty conditions', () => {
      const node = new Or([]);
      assert.strictEqual(node.toSql(), 'FALSE');
    });

    it('should unwrap single condition', () => {
      const node = new Or([new Compare(new ColumnRef('x'), Sql.Op.Eq, new Param(1))]);
      assert.strictEqual(node.toSql(), 'x = $1');
    });

    it('should combine multiple conditions', () => {
      const node = new Or([
        new Compare(new ColumnRef('status'), Sql.Op.Eq, new Param(1)),
        new Compare(new ColumnRef('status'), Sql.Op.Eq, new Param(2)),
      ]);
      assert.strictEqual(node.toSql(), '(status = $1 OR status = $2)');
    });
  });

  describe('Not', () => {
    it('should generate NOT', () => {
      const node = new Not(new Compare(new ColumnRef('active'), Sql.Op.Eq, new Param(1)));
      assert.strictEqual(node.toSql(), 'NOT (active = $1)');
    });
  });

  describe('RawCondition', () => {
    it('should pass through raw SQL condition', () => {
      const node = new RawCondition("status = 'active'");
      assert.strictEqual(node.toSql(), "status = 'active'");
    });
  });

  describe('Exists', () => {
    it('should generate EXISTS subquery', () => {
      const subquery = new Select({
        columns: [new SelectColumn(new RawSql('1'))],
        from: new From('orders'),
        where: new Compare(new ColumnRef('user_id', 'orders'), Sql.Op.Eq, new ColumnRef('id', 'users')),
      });
      const node = new Exists(subquery);
      assert.strictEqual(
        node.toSql(),
        'EXISTS (SELECT 1 FROM orders WHERE orders.user_id = users.id)',
      );
    });
  });
});

// ============================================================================
// Statement Components
// ============================================================================

describe('SQL AST - Statement Components', () => {
  describe('SelectColumn', () => {
    it('should generate column without alias', () => {
      const node = new SelectColumn(new ColumnRef('email'));
      assert.strictEqual(node.toSql(), 'email');
    });

    it('should generate column with alias', () => {
      const node = new SelectColumn(new ColumnRef('email'), 'user_email');
      assert.strictEqual(node.toSql(), 'email AS user_email');
    });

    it('should work with expressions', () => {
      const node = new SelectColumn(
        new Aggregate(Sql.Agg.Count, new ColumnRef('id')),
        'total',
      );
      assert.strictEqual(node.toSql(), 'COUNT(id) AS total');
    });
  });

  describe('From', () => {
    it('should generate simple FROM', () => {
      const node = new From('users');
      assert.strictEqual(node.toSql(), 'users');
    });

    it('should generate FROM with alias', () => {
      const node = new From('users', 'u');
      assert.strictEqual(node.toSql(), 'users AS u');
    });

    it('should include joins', () => {
      const node = new From('users', 'u', [
        new Join(
          Sql.Join.Inner,
          'orders',
          new Compare(new ColumnRef('id', 'u'), Sql.Op.Eq, new ColumnRef('user_id', 'orders')),
          'o',
        ),
      ]);
      assert.strictEqual(
        node.toSql(),
        'users AS u INNER JOIN orders AS o ON u.id = orders.user_id',
      );
    });
  });

  describe('Join', () => {
    it('should generate INNER JOIN', () => {
      const node = new Join(
        Sql.Join.Inner,
        'orders',
        new Compare(new ColumnRef('user_id'), Sql.Op.Eq, new ColumnRef('id', 'users')),
      );
      assert.strictEqual(node.toSql(), 'INNER JOIN orders ON user_id = users.id');
    });

    it('should generate LEFT JOIN with alias', () => {
      const node = new Join(
        Sql.Join.Left,
        'profiles',
        new Compare(new ColumnRef('user_id', 'p'), Sql.Op.Eq, new ColumnRef('id', 'u')),
        'p',
      );
      assert.strictEqual(node.toSql(), 'LEFT JOIN profiles AS p ON p.user_id = u.id');
    });

    it('should generate RIGHT JOIN', () => {
      const node = new Join(
        Sql.Join.Right,
        'departments',
        new Compare(new ColumnRef('dept_id'), Sql.Op.Eq, new ColumnRef('id', 'departments')),
      );
      assert.strictEqual(node.toSql(), 'RIGHT JOIN departments ON dept_id = departments.id');
    });

    it('should generate FULL JOIN', () => {
      const node = new Join(
        Sql.Join.Full,
        'other',
        new Compare(new ColumnRef('id'), Sql.Op.Eq, new ColumnRef('other_id')),
      );
      assert.strictEqual(node.toSql(), 'FULL JOIN other ON id = other_id');
    });
  });

  describe('OrderBy', () => {
    it('should generate ASC order', () => {
      const node = new OrderBy(new ColumnRef('name'), Sql.Sort.Asc);
      assert.strictEqual(node.toSql(), 'name ASC');
    });

    it('should generate DESC order', () => {
      const node = new OrderBy(new ColumnRef('created_at'), Sql.Sort.Desc);
      assert.strictEqual(node.toSql(), 'created_at DESC');
    });

    it('should include NULLS FIRST', () => {
      const node = new OrderBy(new ColumnRef('priority'), Sql.Sort.Desc, Sql.Nulls.First);
      assert.strictEqual(node.toSql(), 'priority DESC NULLS FIRST');
    });

    it('should include NULLS LAST', () => {
      const node = new OrderBy(new ColumnRef('name'), Sql.Sort.Asc, Sql.Nulls.Last);
      assert.strictEqual(node.toSql(), 'name ASC NULLS LAST');
    });
  });
});

// ============================================================================
// Select Statement
// ============================================================================

describe('SQL AST - Select Statement', () => {
  it('should generate simple SELECT', () => {
    const node = new Select({
      columns: [new SelectColumn(new ColumnRef('id')), new SelectColumn(new ColumnRef('name'))],
      from: new From('users'),
    });
    assert.strictEqual(node.toSql(), 'SELECT id, name FROM users');
  });

  it('should generate SELECT with WHERE', () => {
    const node = new Select({
      columns: [new SelectColumn(new RawSql('*'))],
      from: new From('users'),
      where: new Compare(new ColumnRef('status'), Sql.Op.Eq, new Param(1)),
    });
    assert.strictEqual(node.toSql(), 'SELECT * FROM users WHERE status = $1');
  });

  it('should generate SELECT with ORDER BY', () => {
    const node = new Select({
      columns: [new SelectColumn(new RawSql('*'))],
      from: new From('users'),
      orderBy: [
        new OrderBy(new ColumnRef('created_at'), Sql.Sort.Desc),
        new OrderBy(new ColumnRef('name'), Sql.Sort.Asc),
      ],
    });
    assert.strictEqual(
      node.toSql(),
      'SELECT * FROM users ORDER BY created_at DESC, name ASC',
    );
  });

  it('should generate SELECT with LIMIT and OFFSET', () => {
    const node = new Select({
      columns: [new SelectColumn(new RawSql('*'))],
      from: new From('users'),
      limit: new Param(1),
      offset: new Param(2),
    });
    assert.strictEqual(node.toSql(), 'SELECT * FROM users LIMIT $1 OFFSET $2');
  });

  it('should generate SELECT with GROUP BY', () => {
    const node = new Select({
      columns: [
        new SelectColumn(new ColumnRef('status')),
        new SelectColumn(new Aggregate(Sql.Agg.Count), 'count'),
      ],
      from: new From('users'),
      groupBy: [new ColumnRef('status')],
    });
    assert.strictEqual(
      node.toSql(),
      'SELECT status, COUNT(*) AS count FROM users GROUP BY status',
    );
  });

  it('should generate SELECT with HAVING', () => {
    const node = new Select({
      columns: [
        new SelectColumn(new ColumnRef('status')),
        new SelectColumn(new Aggregate(Sql.Agg.Count), 'count'),
      ],
      from: new From('users'),
      groupBy: [new ColumnRef('status')],
      having: new Compare(new Aggregate(Sql.Agg.Count), Sql.Op.Gt, new Param(1)),
    });
    assert.strictEqual(
      node.toSql(),
      'SELECT status, COUNT(*) AS count FROM users GROUP BY status HAVING COUNT(*) > $1',
    );
  });

  it('should generate SELECT with FOR UPDATE', () => {
    const node = new Select({
      columns: [new SelectColumn(new RawSql('*'))],
      from: new From('users'),
      where: new Compare(new ColumnRef('id'), Sql.Op.Eq, new Param(1)),
      forUpdate: true,
    });
    assert.strictEqual(node.toSql(), 'SELECT * FROM users WHERE id = $1 FOR UPDATE');
  });

  it('should generate complex SELECT with all clauses', () => {
    const node = new Select({
      columns: [
        new SelectColumn(new ColumnRef('status', 'u')),
        new SelectColumn(new Aggregate(Sql.Agg.Count, new ColumnRef('id', 'o')), 'order_count'),
      ],
      from: new From('users', 'u', [
        new Join(
          Sql.Join.Left,
          'orders',
          new Compare(new ColumnRef('id', 'u'), Sql.Op.Eq, new ColumnRef('user_id', 'o')),
          'o',
        ),
      ]),
      where: new IsNull(new ColumnRef('deleted_at', 'u')),
      groupBy: [new ColumnRef('status', 'u')],
      having: new Compare(new Aggregate(Sql.Agg.Count, new ColumnRef('id', 'o')), Sql.Op.Gte, new Param(1)),
      orderBy: [new OrderBy(new ColumnRef('status', 'u'), Sql.Sort.Asc)],
      limit: new Param(2),
      offset: new Param(3),
    });

    assert.strictEqual(
      node.toSql(),
      'SELECT u.status, COUNT(o.id) AS order_count FROM users AS u LEFT JOIN orders AS o ON u.id = o.user_id WHERE u.deleted_at IS NULL GROUP BY u.status HAVING COUNT(o.id) >= $1 ORDER BY u.status ASC LIMIT $2 OFFSET $3',
    );
  });

  it('should be a StatementNode', () => {
    const node = new Select({
      columns: [new SelectColumn(new RawSql('1'))],
      from: new From('dual'),
    });
    assert.ok(node instanceof StatementNode);
    assert.ok(node instanceof SqlNode);
  });
});

// ============================================================================
// Factory Functions
// ============================================================================

describe('SQL AST - Factory Functions', () => {
  it('col() creates ColumnRef', () => {
    assert.strictEqual(col('email').toSql(), 'email');
    assert.strictEqual(col('email', 'users').toSql(), 'users.email');
  });

  it('json() creates JsonPath', () => {
    assert.strictEqual(json('data', ['name']).toSql(), "data->>'name'");
    assert.strictEqual(json('data', ['obj'], false).toSql(), "data->'obj'");
  });

  it('param() creates Param', () => {
    assert.strictEqual(param(1).toSql(), '$1');
    assert.strictEqual(param(42).toSql(), '$42');
  });

  it('raw() creates RawSql', () => {
    assert.strictEqual(raw('NOW()').toSql(), 'NOW()');
  });

  it('cmp() creates Compare', () => {
    assert.strictEqual(cmp(col('x'), Sql.Op.Eq, param(1)).toSql(), 'x = $1');
  });

  it('isNull() creates IsNull', () => {
    assert.strictEqual(isNull(col('x')).toSql(), 'x IS NULL');
    assert.strictEqual(isNull(col('x'), true).toSql(), 'x IS NOT NULL');
  });

  it('between() creates Between', () => {
    assert.strictEqual(between(col('x'), param(1), param(2)).toSql(), 'x BETWEEN $1 AND $2');
  });

  it('inList() creates InList', () => {
    assert.strictEqual(inList(col('x'), [param(1), param(2)]).toSql(), 'x IN ($1, $2)');
    assert.strictEqual(inList(col('x'), [param(1)], true).toSql(), 'x NOT IN ($1)');
  });

  it('and() creates And', () => {
    assert.strictEqual(
      and(cmp(col('a'), Sql.Op.Eq, param(1)), cmp(col('b'), Sql.Op.Eq, param(2))).toSql(),
      '(a = $1 AND b = $2)',
    );
  });

  it('or() creates Or', () => {
    assert.strictEqual(
      or(cmp(col('a'), Sql.Op.Eq, param(1)), cmp(col('b'), Sql.Op.Eq, param(2))).toSql(),
      '(a = $1 OR b = $2)',
    );
  });

  it('not() creates Not', () => {
    assert.strictEqual(not(cmp(col('x'), Sql.Op.Eq, param(1))).toSql(), 'NOT (x = $1)');
  });

  it('exists() creates Exists', () => {
    const subquery = new Select({
      columns: [new SelectColumn(raw('1'))],
      from: new From('t'),
    });
    assert.strictEqual(exists(subquery).toSql(), 'EXISTS (SELECT 1 FROM t)');
  });

  it('agg() creates Aggregate', () => {
    assert.strictEqual(agg(Sql.Agg.Count).toSql(), 'COUNT(*)');
    assert.strictEqual(agg(Sql.Agg.Sum, col('amount')).toSql(), 'SUM(amount)');
    assert.strictEqual(agg(Sql.Agg.Count, col('id'), true).toSql(), 'COUNT(DISTINCT id)');
  });
});

// ============================================================================
// Visitor Pattern
// ============================================================================

describe('SQL AST - Visitor Pattern', () => {
  class NodeCounter extends BaseSqlVisitor<number> {
    private count = 0;

    defaultValue(): number {
      this.count++;
      return this.count;
    }

    getCount(): number {
      return this.count;
    }
  }

  it('should visit ColumnRef', () => {
    const visitor = new NodeCounter();
    col('x').accept(visitor);
    assert.strictEqual(visitor.getCount(), 1);
  });

  it('should visit Compare and its children', () => {
    const visitor = new NodeCounter();
    cmp(col('x'), Sql.Op.Eq, param(1)).accept(visitor);
    // Compare visits left (ColumnRef) + right (Param) + itself
    assert.strictEqual(visitor.getCount(), 3);
  });

  it('should visit And and its conditions', () => {
    const visitor = new NodeCounter();
    and(
      cmp(col('a'), Sql.Op.Eq, param(1)),
      cmp(col('b'), Sql.Op.Eq, param(2)),
    ).accept(visitor);
    // And visits: Compare1 (col + param + self) + Compare2 (col + param + self) + And self
    // = 3 + 3 + 1 = 7
    assert.strictEqual(visitor.getCount(), 7);
  });

  it('should visit Select and all its components', () => {
    const visitor = new NodeCounter();
    const select = new Select({
      columns: [new SelectColumn(col('id')), new SelectColumn(col('name'))],
      from: new From('users'),
      where: cmp(col('status'), Sql.Op.Eq, param(1)),
      orderBy: [new OrderBy(col('created_at'), Sql.Sort.Desc)],
      limit: param(2),
      offset: param(3),
    });
    select.accept(visitor);
    // Columns: id + name = 2
    // Where: Compare (col + param + self) = 3
    // OrderBy: col = 1
    // Limit: param = 1
    // Offset: param = 1
    // Select itself = 1
    // Total = 2 + 3 + 1 + 1 + 1 + 1 = 9
    assert.strictEqual(visitor.getCount(), 9);
  });

  it('should visit Exists and its subquery', () => {
    const visitor = new NodeCounter();
    const subquery = new Select({
      columns: [new SelectColumn(raw('1'))],
      from: new From('t'),
      where: cmp(col('x'), Sql.Op.Eq, col('y')),
    });
    exists(subquery).accept(visitor);
    // Subquery: raw + Compare (col + col + self) + Select = 1 + 3 + 1 = 5
    // Exists itself = 1
    // Total = 6
    assert.strictEqual(visitor.getCount(), 6);
  });

  it('should visit Aggregate with expression', () => {
    const visitor = new NodeCounter();
    agg(Sql.Agg.Sum, col('amount')).accept(visitor);
    // col + Aggregate = 2
    assert.strictEqual(visitor.getCount(), 2);
  });

  it('should visit InList and all its values', () => {
    const visitor = new NodeCounter();
    inList(col('status'), [param(1), param(2), param(3)]).accept(visitor);
    // col + param1 + param2 + param3 + InList = 5
    assert.strictEqual(visitor.getCount(), 5);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('SQL AST - Edge Cases', () => {
  describe('Empty and boundary values', () => {
    it('should handle single character column name', () => {
      const node = new ColumnRef('x');
      assert.strictEqual(node.toSql(), 'x');
    });

    it('should handle single item IN list', () => {
      const node = new InList(new ColumnRef('id'), [new Param(1)]);
      assert.strictEqual(node.toSql(), 'id IN ($1)');
    });

    it('should handle empty IN list', () => {
      const node = new InList(new ColumnRef('id'), []);
      assert.strictEqual(node.toSql(), 'id IN ()');
    });

    it('should handle large parameter index', () => {
      const node = new Param(9999);
      assert.strictEqual(node.toSql(), '$9999');
    });

    it('should handle parameter index zero', () => {
      const node = new Param(0);
      assert.strictEqual(node.toSql(), '$0');
    });
  });

  describe('Special characters and Unicode', () => {
    it('should handle column names with underscores', () => {
      const node = new ColumnRef('user_first_name');
      assert.strictEqual(node.toSql(), 'user_first_name');
    });

    it('should handle raw SQL with special characters', () => {
      const node = new RawSql("'hello''world'");
      assert.strictEqual(node.toSql(), "'hello''world'");
    });

    it('should handle raw SQL with parentheses', () => {
      const node = new RawSql('(a + b) * c');
      assert.strictEqual(node.toSql(), '(a + b) * c');
    });

    it('should handle raw condition with quotes', () => {
      const node = new RawCondition("name = 'O''Brien'");
      assert.strictEqual(node.toSql(), "name = 'O''Brien'");
    });

    it('should handle JSON path with special keys', () => {
      const node = new JsonPath('data', ['key-with-dashes', 'key.with.dots'], true);
      assert.strictEqual(node.toSql(), "data->'key-with-dashes'->>'key.with.dots'");
    });

    it('should handle numeric JSON path keys', () => {
      const node = new JsonPath('arr', ['0', '1', '2'], true);
      assert.strictEqual(node.toSql(), "arr->'0'->'1'->>'2'");
    });
  });

  describe('Deeply nested conditions', () => {
    it('should handle deeply nested AND', () => {
      const deep = and(
        and(
          and(
            cmp(col('a'), Sql.Op.Eq, param(1)),
            cmp(col('b'), Sql.Op.Eq, param(2)),
          ),
          cmp(col('c'), Sql.Op.Eq, param(3)),
        ),
        cmp(col('d'), Sql.Op.Eq, param(4)),
      );
      assert.ok(deep.toSql().includes('a = $1'));
      assert.ok(deep.toSql().includes('d = $4'));
    });

    it('should handle deeply nested OR', () => {
      const deep = or(
        or(
          cmp(col('x'), Sql.Op.Eq, param(1)),
          cmp(col('y'), Sql.Op.Eq, param(2)),
        ),
        cmp(col('z'), Sql.Op.Eq, param(3)),
      );
      assert.ok(deep.toSql().includes('OR'));
    });

    it('should handle mixed AND/OR nesting', () => {
      const mixed = and(
        or(
          cmp(col('a'), Sql.Op.Eq, param(1)),
          cmp(col('b'), Sql.Op.Eq, param(2)),
        ),
        or(
          cmp(col('c'), Sql.Op.Eq, param(3)),
          cmp(col('d'), Sql.Op.Eq, param(4)),
        ),
      );
      const sql = mixed.toSql();
      assert.ok(sql.includes('AND'));
      assert.ok(sql.includes('OR'));
    });

    it('should handle NOT with nested conditions', () => {
      const nested = not(and(
        cmp(col('x'), Sql.Op.Gt, param(1)),
        cmp(col('y'), Sql.Op.Lt, param(2)),
      ));
      assert.strictEqual(nested.toSql(), 'NOT ((x > $1 AND y < $2))');
    });

    it('should handle double NOT', () => {
      const doubleNot = not(not(cmp(col('x'), Sql.Op.Eq, param(1))));
      assert.strictEqual(doubleNot.toSql(), 'NOT (NOT (x = $1))');
    });
  });

  describe('Complex JSON paths', () => {
    it('should handle single key path', () => {
      const node = new JsonPath('data', ['key'], true);
      assert.strictEqual(node.toSql(), "data->>'key'");
    });

    it('should handle very deep nesting', () => {
      const path = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
      const node = new JsonPath('data', path, true);
      assert.strictEqual(
        node.toSql(),
        "data->'a'->'b'->'c'->'d'->'e'->'f'->'g'->>'h'",
      );
    });
  });

  describe('Aggregate edge cases', () => {
    it('should handle COUNT(*) with DISTINCT', () => {
      // COUNT(*) with DISTINCT generates COUNT(DISTINCT *)
      const node = new Aggregate(Sql.Agg.Count, undefined, true);
      assert.strictEqual(node.toSql(), 'COUNT(DISTINCT *)');
    });

    it('should handle aggregate on complex expression', () => {
      const node = new Aggregate(Sql.Agg.Sum, new RawSql('price * quantity'));
      assert.strictEqual(node.toSql(), 'SUM(price * quantity)');
    });

    it('should handle aggregate on JSON path', () => {
      const node = new Aggregate(
        Sql.Agg.Max,
        new JsonPath('data', ['score'], true),
      );
      assert.strictEqual(node.toSql(), "MAX(data->>'score')");
    });
  });

  describe('Select edge cases', () => {
    it('should handle SELECT with only columns', () => {
      const node = new Select({
        columns: [new SelectColumn(new RawSql('1'))],
        from: new From('dual'),
      });
      assert.strictEqual(node.toSql(), 'SELECT 1 FROM dual');
    });

    it('should handle SELECT with LIMIT only', () => {
      const node = new Select({
        columns: [new SelectColumn(new RawSql('*'))],
        from: new From('t'),
        limit: new Param(1),
      });
      assert.strictEqual(node.toSql(), 'SELECT * FROM t LIMIT $1');
    });

    it('should handle SELECT with OFFSET only', () => {
      const node = new Select({
        columns: [new SelectColumn(new RawSql('*'))],
        from: new From('t'),
        offset: new Param(1),
      });
      assert.strictEqual(node.toSql(), 'SELECT * FROM t OFFSET $1');
    });

    it('should handle multiple columns with same alias', () => {
      const node = new Select({
        columns: [
          new SelectColumn(new ColumnRef('id'), 'key'),
          new SelectColumn(new ColumnRef('name'), 'key'),
        ],
        from: new From('t'),
      });
      assert.strictEqual(node.toSql(), 'SELECT id AS key, name AS key FROM t');
    });

    it('should handle SELECT with many joins', () => {
      const node = new Select({
        columns: [new SelectColumn(new RawSql('*'))],
        from: new From('a', undefined, [
          new Join(Sql.Join.Inner, 'b', new RawCondition('a.id = b.a_id')),
          new Join(Sql.Join.Inner, 'c', new RawCondition('b.id = c.b_id')),
          new Join(Sql.Join.Left, 'd', new RawCondition('c.id = d.c_id')),
        ]),
      });
      const sql = node.toSql();
      assert.ok(sql.includes('INNER JOIN b'));
      assert.ok(sql.includes('INNER JOIN c'));
      assert.ok(sql.includes('LEFT JOIN d'));
    });

    it('should handle SELECT with empty GROUP BY', () => {
      const node = new Select({
        columns: [new SelectColumn(new Aggregate(Sql.Agg.Count), 'total')],
        from: new From('t'),
        groupBy: [],
      });
      // Empty groupBy should not add GROUP BY clause
      assert.ok(!node.toSql().includes('GROUP BY'));
    });

    it('should handle SELECT with empty ORDER BY', () => {
      const node = new Select({
        columns: [new SelectColumn(new RawSql('*'))],
        from: new From('t'),
        orderBy: [],
      });
      assert.ok(!node.toSql().includes('ORDER BY'));
    });
  });

  describe('Between edge cases', () => {
    it('should handle between with same values', () => {
      const node = new Between(new ColumnRef('x'), new Param(1), new Param(1));
      assert.strictEqual(node.toSql(), 'x BETWEEN $1 AND $1');
    });

    it('should handle between with expressions', () => {
      const node = new Between(
        new RawSql('date_column'),
        new RawSql("NOW() - INTERVAL '1 day'"),
        new RawSql('NOW()'),
      );
      assert.strictEqual(
        node.toSql(),
        "date_column BETWEEN NOW() - INTERVAL '1 day' AND NOW()",
      );
    });
  });

  describe('Exists edge cases', () => {
    it('should handle EXISTS with complex subquery', () => {
      const subquery = new Select({
        columns: [new SelectColumn(new RawSql('1'))],
        from: new From('orders', 'o'),
        where: and(
          new Compare(new ColumnRef('user_id', 'o'), Sql.Op.Eq, new ColumnRef('id', 'u')),
          new Compare(new ColumnRef('status', 'o'), Sql.Op.Eq, new Param(1)),
        ),
      });
      const node = new Exists(subquery);
      assert.ok(node.toSql().includes('EXISTS'));
      assert.ok(node.toSql().includes('o.user_id = u.id'));
    });
  });

  describe('AnyArray edge cases', () => {
    it('should work with JSON path', () => {
      const node = new AnyArray(
        new JsonPath('data', ['tags'], true),
        new Param(1),
      );
      assert.strictEqual(node.toSql(), "data->>'tags' = ANY($1)");
    });
  });

  describe('Compare edge cases', () => {
    it('should compare two columns', () => {
      const node = new Compare(
        new ColumnRef('start_date'),
        Sql.Op.Lt,
        new ColumnRef('end_date'),
      );
      assert.strictEqual(node.toSql(), 'start_date < end_date');
    });

    it('should compare column to null literal', () => {
      const node = new Compare(
        new ColumnRef('value'),
        Sql.Op.Eq,
        new NullLiteral(),
      );
      // Note: This generates "value = NULL" which is not recommended in SQL
      // but is syntactically valid
      assert.strictEqual(node.toSql(), 'value = NULL');
    });

    it('should compare column to raw expression', () => {
      const node = new Compare(
        new ColumnRef('created_at'),
        Sql.Op.Gte,
        new RawSql("NOW() - INTERVAL '1 hour'"),
      );
      assert.strictEqual(node.toSql(), "created_at >= NOW() - INTERVAL '1 hour'");
    });
  });
});
