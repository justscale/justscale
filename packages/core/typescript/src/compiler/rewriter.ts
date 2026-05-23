/**
 * @justscale/core/process - AST Rewriter
 *
 * Rewrites variable references in block bodies to use state.vars and services.
 *
 * Transforms:
 * - Handler params (orderId) -> state.vars.orderId
 * - Injected services (payments) -> services.payments
 * - Local variables (payment) -> state.vars.payment
 * - Using variables (order) -> state.vars.order (rehydrated before block)
 */

import ts from 'typescript';

export interface RewriterContext {
  /** Variables from handler params: [orderId] or { order: orderId } */
  paramVars: Set<string>
  /** Aliases: local name -> param name, for { user: userId } -> Map("userId" -> "user") */
  paramAliases: Map<string, string>
  /** Injected service names: { payments, shipping } */
  serviceVars: Set<string>
  /** Local variables created via STORE opcodes (cross-block state) */
  localVars: Set<string>
  /** Using variables that need rehydration */
  usingVars: Set<string>
  /** Race result variables (from const r = race()) - rewrite to __raceResult */
  raceVars: Set<string>
  /** Variables declared within the current block - don't rewrite these */
  blockLocalVars?: Set<string>
  /**
   * Step index an unlabeled `break` should jump to when encountered
   * inside this rewrite scope. Used for race-branch case bodies, where
   * the user wrote `break;` to exit their `switch(true) { case signal(r, …): … }`
   * and we need the generated code to jump to the race's continuation step
   * instead of silently breaking out of the compiled `switch(step)`.
   *
   * Cleared when entering user-written loops or switches (their `break`
   * targets those constructs, not ours).
   */
  breakTarget?: number
  /**
   * Step index an unlabeled `continue` should jump to when encountered
   * inside this rewrite scope. Same problem as `break`: a naked `continue`
   * inside an if-body of a race branch restarts `main_loop` without advancing
   * `step`, causing the same branch body to re-execute immediately - infinite
   * loop. Rewrite to `step = continueTarget; continue main_loop;`.
   *
   * For race branches inside a while loop, `continueTarget` equals `nextStep`
   * (the continuation step). Both `break` and `continue` at the top of a race
   * branch body lead to the same place: the step after the branch completes.
   */
  continueTarget?: number
}

/**
 * Rewrite a statement to use state.vars and services.
 * Preserves source positions for accurate source maps.
 */
export function rewriteStatement(
  factory: ts.NodeFactory,
  stmt: ts.Statement,
  ctx: RewriterContext
): ts.Statement {
  const visitor = createRewriteVisitor(factory, ctx);
  const result = ts.visitNode(stmt, visitor) as ts.Statement;
  // Preserve source position from original statement for source maps
  return ts.setTextRange(result, stmt);
}

/**
 * Rewrite an expression to use state.vars and services.
 * Preserves source positions for accurate source maps.
 */
export function rewriteExpression(
  factory: ts.NodeFactory,
  expr: ts.Expression,
  ctx: RewriterContext
): ts.Expression {
  const visitor = createRewriteVisitor(factory, ctx);
  const result = ts.visitNode(expr, visitor) as ts.Expression;
  // Preserve source position from original expression for source maps
  return ts.setTextRange(result, expr);
}

/**
 * Build a derived RewriterContext that removes the given names from all
 * rewrite sets. Used when descending into a nested scope (function
 * parameters, catch clause variable, for-of/in loop variable) where those
 * names shadow the outer rewrite targets.
 */
function withShadowed(ctx: RewriterContext, shadowed: Set<string>): RewriterContext {
  if (shadowed.size === 0) return ctx;
  const subtract = (s: Set<string>) => {
    const out = new Set<string>();
    for (const v of s) if (!shadowed.has(v)) out.add(v);
    return out;
  };
  const subtractMap = (m: Map<string, string>) => {
    const out = new Map<string, string>();
    for (const [k, v] of m) if (!shadowed.has(k)) out.set(k, v);
    return out;
  };
  return {
    paramVars: subtract(ctx.paramVars),
    paramAliases: subtractMap(ctx.paramAliases),
    serviceVars: subtract(ctx.serviceVars),
    localVars: subtract(ctx.localVars),
    usingVars: subtract(ctx.usingVars),
    raceVars: subtract(ctx.raceVars),
    blockLocalVars: ctx.blockLocalVars ? subtract(ctx.blockLocalVars) : undefined,
    breakTarget: ctx.breakTarget,
    continueTarget: ctx.continueTarget,
  };
}

/**
 * Collect parameter binding names from a function-like node.
 */
function collectParameterNames(
  params: readonly ts.ParameterDeclaration[],
): Set<string> {
  const names = new Set<string>();
  for (const p of params) {
    extractBindingNames(p.name, names);
  }
  return names;
}

/**
 * Create a visitor that rewrites variable references.
 */
function createRewriteVisitor(
  factory: ts.NodeFactory,
  ctx: RewriterContext
): ts.Visitor {
  const visitor: ts.Visitor = (node: ts.Node): ts.Node => {
    // Preserve literals unchanged - they don't need rewriting and visitEachChild
    // can corrupt them when no proper transformation context is provided
    // Note: We create new literals to ensure they have proper node structure for printing
    if (ts.isStringLiteral(node)) {
      return factory.createStringLiteral(node.text);
    }
    if (ts.isNumericLiteral(node)) {
      return factory.createNumericLiteral(node.text);
    }
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      return factory.createNoSubstitutionTemplateLiteral(node.text, node.rawText);
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword) {
      return factory.createTrue();
    }
    if (node.kind === ts.SyntaxKind.FalseKeyword) {
      return factory.createFalse();
    }
    if (node.kind === ts.SyntaxKind.NullKeyword) {
      return factory.createNull();
    }

    // Nested function-like scopes: parameter bindings shadow outer locals.
    // Build a sub-context with those names removed and recurse with a fresh
    // visitor so neither the parameter declaration sites NOR body references
    // to the shadowed names get rewritten to state.vars.* / services.*.
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      const shadowed = collectParameterNames(node.parameters);
      if (shadowed.size > 0) {
        const subVisitor = createRewriteVisitor(factory, withShadowed(ctx, shadowed));
        return ts.visitEachChild(
          node,
          subVisitor,
          undefined as unknown as ts.TransformationContext,
        );
      }
    }

    // for-of / for-in: the loop variable shadows outer names inside the
    // body. The iterable expression evaluates in OUTER scope so it must
    // not see the shadowing.
    if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
      const init = node.initializer;
      if (init && ts.isVariableDeclarationList(init)) {
        const shadowed = new Set<string>();
        for (const decl of init.declarations) {
          extractBindingNames(decl.name, shadowed);
        }
        if (shadowed.size > 0) {
          const subVisitor = createRewriteVisitor(factory, withShadowed(ctx, shadowed));
          const newExpr = ts.visitNode(node.expression, visitor) as ts.Expression;
          const newInit = ts.visitNode(node.initializer, subVisitor) as ts.ForInitializer;
          const newStmt = ts.visitNode(node.statement, subVisitor) as ts.Statement;
          return ts.isForOfStatement(node)
            ? factory.updateForOfStatement(node, node.awaitModifier, newInit, newExpr, newStmt)
            : factory.updateForInStatement(node, newInit, newExpr, newStmt);
        }
      }
    }

    // Catch clause: the bound variable shadows outer names inside the block.
    if (ts.isCatchClause(node) && node.variableDeclaration) {
      const shadowed = new Set<string>();
      extractBindingNames(node.variableDeclaration.name, shadowed);
      if (shadowed.size > 0) {
        const subVisitor = createRewriteVisitor(factory, withShadowed(ctx, shadowed));
        return ts.visitEachChild(
          node,
          subVisitor,
          undefined as unknown as ts.TransformationContext,
        );
      }
    }

    // Rewrite identifiers
    if (ts.isIdentifier(node)) {
      const name = node.text;

      // Don't rewrite if it's a property name (handled by parent)
      if (isPropertyName(node)) {
        return node;
      }

      // Block-local variables - declared in this block, don't rewrite
      if (ctx.blockLocalVars?.has(name)) {
        return node;
      }

      // Service variable -> services.xxx
      if (ctx.serviceVars.has(name)) {
        return factory.createPropertyAccessExpression(
          factory.createIdentifier('services'),
          name
        );
      }

      // Param variable -> state.vars.xxx (using alias if renamed via destructuring)
      if (ctx.paramVars.has(name)) {
        const varName = ctx.paramAliases.get(name) ?? name;
        return factory.createPropertyAccessExpression(
          factory.createPropertyAccessExpression(
            factory.createIdentifier('state'),
            'vars'
          ),
          varName
        );
      }

      // Race variable -> __raceResult (must check before localVars since r might be in both)
      // Race variables (from const r = race()) hold the race result after resumption
      if (ctx.raceVars?.has(name)) {
        return factory.createIdentifier('__raceResult');
      }

      // Local variable -> state.vars.xxx
      if (ctx.localVars.has(name)) {
        return factory.createPropertyAccessExpression(
          factory.createPropertyAccessExpression(
            factory.createIdentifier('state'),
            'vars'
          ),
          name
        );
      }

      // Using variable -> keep as local variable (declared with let at function scope)
      // These are rehydrated at resume points and accessed directly, not via state.vars
      if (ctx.usingVars.has(name)) {
        return node;  // Keep as-is, it's a local variable
      }
    }

    // Handle destructuring in variable declarations
    if (ts.isVariableDeclaration(node)) {
      // Skip rewriting the binding pattern itself
      // Only rewrite the initializer
      if (node.initializer) {
        const newInitializer = ts.visitNode(node.initializer, visitor) as ts.Expression;
        return factory.updateVariableDeclaration(
          node,
          node.name,
          node.exclamationToken,
          node.type,
          newInitializer
        );
      }
      return node;
    }

    // Handle shorthand property assignments: { orderId } -> { orderId: state.vars.orderId }
    if (ts.isShorthandPropertyAssignment(node)) {
      const name = node.name.text;

      // Using vars are local, keep shorthand as-is (will reference local var)
      if (ctx.usingVars.has(name)) {
        return node;
      }

      if (ctx.paramVars.has(name) || ctx.localVars.has(name)) {
        const varName = ctx.paramVars.has(name) ? (ctx.paramAliases.get(name) ?? name) : name;
        return factory.createPropertyAssignment(
          node.name,
          factory.createPropertyAccessExpression(
            factory.createPropertyAccessExpression(
              factory.createIdentifier('state'),
              'vars'
            ),
            varName
          )
        );
      }

      if (ctx.serviceVars.has(name)) {
        return factory.createPropertyAssignment(
          node.name,
          factory.createPropertyAccessExpression(
            factory.createIdentifier('services'),
            name
          )
        );
      }
    }

    return ts.visitEachChild(node, visitor, undefined as unknown as ts.TransformationContext);
  };

  return visitor;
}

/**
 * Check if an identifier is being used as a property name.
 */
function isPropertyName(node: ts.Identifier): boolean {
  const parent = node.parent;

  // Cloned/synthesized nodes may not have parents
  if (!parent) {
    return false;
  }

  // Property access: obj.prop - don't rewrite 'prop'
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return true;
  }

  // Property assignment: { prop: value } - don't rewrite 'prop'
  if (ts.isPropertyAssignment(parent) && parent.name === node) {
    return true;
  }

  // Method declaration: method() {} - don't rewrite 'method'
  if (ts.isMethodDeclaration(parent) && parent.name === node) {
    return true;
  }

  return false;
}

/**
 * Extract param variable names from handler parameters.
 *
 * Handles both tuple and object destructuring:
 *   handler(deps, [orderId])       -> paramVars: {orderId}, aliases: {}
 *   handler(deps, { order: orderId }) -> paramVars: {orderId}, aliases: {orderId -> order}
 *
 * The aliases map local names to the param names from the path.
 * The rewriter uses aliases to access state.vars[paramName] instead of state.vars[localName].
 */
export function extractParamVars(
  handler: ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration
): Set<string> {
  const params = new Set<string>();

  const paramsParam = handler.parameters[1];
  if (paramsParam) {
    extractBindingNames(paramsParam.name, params);
  }

  return params;
}

/**
 * Extract param aliases from object destructuring rename patterns.
 *
 * For `{ user: userId }`, returns Map { "userId" -> "user" }.
 * The rewriter uses this to access `state.vars.user` when it sees `userId`.
 */
export function extractParamAliases(
  handler: ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration
): Map<string, string> {
  const aliases = new Map<string, string>();

  const paramsParam = handler.parameters[1];
  if (!paramsParam) return aliases;

  const binding = paramsParam.name;
  if (!ts.isObjectBindingPattern(binding)) return aliases;

  for (const element of binding.elements) {
    if (!ts.isBindingElement(element)) continue;
    // { user: userId } - propertyName is "user", name is "userId"
    if (element.propertyName && ts.isIdentifier(element.propertyName) && ts.isIdentifier(element.name)) {
      aliases.set(element.name.text, element.propertyName.text);
    }
  }

  return aliases;
}

/**
 * Extract service variable names from handler parameters.
 *
 * Handles: async handler({ payments, shipping }, [...])
 */
export function extractServiceVars(
  handler: ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration
): Set<string> {
  const services = new Set<string>();

  // First parameter is the deps object: { payments, shipping }
  const depsParam = handler.parameters[0];
  if (depsParam) {
    extractBindingNames(depsParam.name, services);
  }

  return services;
}

/**
 * Extract variable names from a binding pattern.
 */
function extractBindingNames(name: ts.BindingName, result: Set<string>): void {
  if (ts.isIdentifier(name)) {
    result.add(name.text);
  } else if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        extractBindingNames(element.name, result);
      }
    }
  } else if (ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        extractBindingNames(element.name, result);
      }
    }
  }
}

/**
 * Extract all variable names declared in a list of statements.
 * Used to identify block-local variables that shouldn't be rewritten.
 */
export function extractDeclaredVars(statements: ts.Statement[]): Set<string> {
  const vars = new Set<string>();

  for (const stmt of statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        extractBindingNames(decl.name, vars);
      }
    }
  }

  return vars;
}

/**
 * Clone an expression, creating synthesized nodes that can be printed.
 * This is necessary when the original expression comes from a different source file.
 */
export function cloneExpression(factory: ts.NodeFactory, expr: ts.Expression): ts.Expression {
  // NumericLiteral
  if (ts.isNumericLiteral(expr)) {
    return factory.createNumericLiteral(expr.text);
  }

  // StringLiteral
  if (ts.isStringLiteral(expr)) {
    return factory.createStringLiteral(expr.text);
  }

  // Identifier
  if (ts.isIdentifier(expr)) {
    return factory.createIdentifier(expr.text);
  }

  // PropertyAccessExpression: obj.prop
  if (ts.isPropertyAccessExpression(expr)) {
    return factory.createPropertyAccessExpression(
      cloneExpression(factory, expr.expression),
      expr.name.text
    );
  }

  // ElementAccessExpression: obj[key]
  if (ts.isElementAccessExpression(expr)) {
    return factory.createElementAccessExpression(
      cloneExpression(factory, expr.expression),
      cloneExpression(factory, expr.argumentExpression)
    );
  }

  // BinaryExpression: a + b, a * b, etc.
  if (ts.isBinaryExpression(expr)) {
    return factory.createBinaryExpression(
      cloneExpression(factory, expr.left),
      expr.operatorToken.kind as ts.BinaryOperator,
      cloneExpression(factory, expr.right)
    );
  }

  // ParenthesizedExpression: (expr)
  if (ts.isParenthesizedExpression(expr)) {
    return factory.createParenthesizedExpression(
      cloneExpression(factory, expr.expression)
    );
  }

  // ConditionalExpression: cond ? a : b
  if (ts.isConditionalExpression(expr)) {
    return factory.createConditionalExpression(
      cloneExpression(factory, expr.condition),
      factory.createToken(ts.SyntaxKind.QuestionToken),
      cloneExpression(factory, expr.whenTrue),
      factory.createToken(ts.SyntaxKind.ColonToken),
      cloneExpression(factory, expr.whenFalse)
    );
  }

  // CallExpression: fn(args)
  if (ts.isCallExpression(expr)) {
    return factory.createCallExpression(
      cloneExpression(factory, expr.expression),
      undefined, // type arguments
      expr.arguments.map(arg => cloneExpression(factory, arg))
    );
  }

  // PrefixUnaryExpression: !x, -x, ++x
  if (ts.isPrefixUnaryExpression(expr)) {
    return factory.createPrefixUnaryExpression(
      expr.operator,
      cloneExpression(factory, expr.operand)
    );
  }

  // PostfixUnaryExpression: x++, x--
  if (ts.isPostfixUnaryExpression(expr)) {
    return factory.createPostfixUnaryExpression(
      cloneExpression(factory, expr.operand),
      expr.operator
    );
  }

  // ObjectLiteralExpression: { a: 1, b: 2 }
  if (ts.isObjectLiteralExpression(expr)) {
    return factory.createObjectLiteralExpression(
      expr.properties.map(prop => {
        if (ts.isPropertyAssignment(prop)) {
          const name = ts.isIdentifier(prop.name)
            ? factory.createIdentifier(prop.name.text)
            : ts.isStringLiteral(prop.name)
              ? factory.createStringLiteral(prop.name.text)
              : ts.isNumericLiteral(prop.name)
                ? factory.createNumericLiteral(prop.name.text)
                : prop.name;
          return factory.createPropertyAssignment(
            name,
            cloneExpression(factory, prop.initializer)
          );
        }
        if (ts.isShorthandPropertyAssignment(prop)) {
          return factory.createShorthandPropertyAssignment(prop.name.text);
        }
        return prop;
      }),
      true
    );
  }

  // ArrayLiteralExpression: [a, b, c]
  if (ts.isArrayLiteralExpression(expr)) {
    return factory.createArrayLiteralExpression(
      expr.elements.map(el => cloneExpression(factory, el as ts.Expression))
    );
  }

  // true/false literals
  if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    return factory.createTrue();
  }
  if (expr.kind === ts.SyntaxKind.FalseKeyword) {
    return factory.createFalse();
  }

  // null
  if (expr.kind === ts.SyntaxKind.NullKeyword) {
    return factory.createNull();
  }

  // Fallback: return original (may not print correctly)
  return expr;
}
