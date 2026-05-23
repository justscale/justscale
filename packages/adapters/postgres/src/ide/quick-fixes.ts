/**
 * PostgreSQL Quick Fixes
 *
 * Provides IDE quick fixes for common postgres patterns:
 * - "Generate PgModel" when cursor is on a defineModel() class
 */

import type { QuickFixDefinition } from '@justscale/typescript/editor';

const generatePgModel: QuickFixDefinition = {
  id: 'justscale.postgres.generate-pg-model',

  when(node, _checker, tsLib) {
    if (!tsLib.isClassDeclaration(node) && !tsLib.isIdentifier(node)) return false;

    const classDecl = tsLib.isClassDeclaration(node) ? node : node.parent;
    if (!classDecl || !tsLib.isClassDeclaration(classDecl)) return false;
    if (!classDecl.name) return false;

    const heritage = classDecl.heritageClauses;
    if (!heritage) return false;

    for (const clause of heritage) {
      for (const type of clause.types) {
        const expr = type.expression;
        if (tsLib.isCallExpression(expr)) {
          const callee = expr.expression;
          if (tsLib.isIdentifier(callee) && callee.text === 'defineModel') {
            return true;
          }
        }
      }
    }

    return false;
  },

  label: 'Generate PgModel for this model',

  fix(node, _checker, tsLib) {
    const classDecl = tsLib.isClassDeclaration(node) ? node : node.parent;
    const className = classDecl.name!.text;
    const tableName = toSnakeCase(className) + 's';
    const sourceFile = classDecl.getSourceFile();

    const insertPos = classDecl.getEnd();
    const newText = `\n\nexport const Pg${className} = createPgModel(${className}, { table: '${tableName}' })\n`;

    return [{
      fileName: sourceFile.fileName,
      textChanges: [{
        span: { start: insertPos, length: 0 },
        newText,
      }],
    }];
  },
};

function toSnakeCase(str: string): string {
  return str.replace(/([A-Z])/g, (_: string, c: string, i: number) => (i > 0 ? '_' : '') + c.toLowerCase());
}

export const quickFixes = [generatePgModel];
export default quickFixes;
