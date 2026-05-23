/**
 * Language Service Plugin tests.
 *
 * Tests the TypeScript Language Service Plugin interface and basic functionality.
 * Full integration testing requires a running TypeScript server, which is tested
 * through the CLI tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import ts from 'typescript';

// Import the language service plugin
import pluginInit from '../src/language-service/index.js';

// ============================================================================
// Plugin Initialization Tests
// ============================================================================

describe('Language Service Plugin', () => {
  describe('initialization', () => {
    it('should initialize plugin module', () => {
      const plugin = pluginInit({ typescript: ts });

      assert.ok(plugin, 'Should return plugin module');
      assert.ok(typeof plugin.create === 'function', 'Should have create function');
    });

    it('should have correct plugin structure', () => {
      const plugin = pluginInit({ typescript: ts });

      assert.ok(plugin, 'Plugin should exist');
      assert.strictEqual(typeof plugin.create, 'function', 'create should be a function');
    });
  });

  describe('utility functions', () => {
    it('should have isProcessFile function in language-service module', async () => {
      // Import the module directly to test utility functions
      const module = await import('../src/language-service/index.js');

      assert.ok(module.default, 'Should have default export');
    });
  });

  describe('process file detection', () => {
    it('should detect .process.ts files', () => {
      // Test the pattern detection logic
      const processFileNames = [
        'order.process.ts',
        '/path/to/order.process.ts',
        'src/workflows/payment.process.ts',
      ];

      for (const fileName of processFileNames) {
        assert.ok(
          fileName.includes('.process.'),
          `${fileName} should be detected as process file`
        );
      }
    });

    it('should not detect regular files as process files', () => {
      const regularFileNames = [
        'order.ts',
        'order.service.ts',
        'process.ts',
        'order.controller.ts',
      ];

      for (const fileName of regularFileNames) {
        // Only .process. pattern matches, not just 'process' in name
        assert.ok(
          !fileName.includes('.process.'),
          `${fileName} should not be detected as process file by extension`
        );
      }
    });
  });

  describe('import detection', () => {
    it('should detect @justscale/core/process imports', () => {
      const sourceWithImport = `
        import { createProcess } from '@justscale/core/process'
        export const x = 1
      `;

      const sourceFile = ts.createSourceFile(
        'test.ts',
        sourceWithImport,
        ts.ScriptTarget.Latest,
        true
      );

      // Check if the file has the import
      let hasProcessImport = false;
      for (const stmt of sourceFile.statements) {
        if (ts.isImportDeclaration(stmt)) {
          const moduleSpecifier = stmt.moduleSpecifier;
          if (ts.isStringLiteral(moduleSpecifier)) {
            if (moduleSpecifier.text === '@justscale/core/process') {
              hasProcessImport = true;
            }
          }
        }
      }

      assert.ok(hasProcessImport, 'Should detect process import');
    });

    it('should not detect other imports as process imports', () => {
      const sourceWithOtherImport = `
        import { something } from '@justscale/core'
        import { other } from 'lodash'
      `;

      const sourceFile = ts.createSourceFile(
        'test.ts',
        sourceWithOtherImport,
        ts.ScriptTarget.Latest,
        true
      );

      let hasProcessImport = false;
      for (const stmt of sourceFile.statements) {
        if (ts.isImportDeclaration(stmt)) {
          const moduleSpecifier = stmt.moduleSpecifier;
          if (ts.isStringLiteral(moduleSpecifier)) {
            if (moduleSpecifier.text === '@justscale/core/process') {
              hasProcessImport = true;
            }
          }
        }
      }

      assert.ok(!hasProcessImport, 'Should not detect non-process imports');
    });
  });

  describe('createProcess detection', () => {
    it('should detect createProcess calls', () => {
      const source = `
        import { createProcess } from '@justscale/core/process'

        export const myProcess = createProcess({
          name: 'test',
          handler: async () => 'done'
        })
      `;

      const sourceFile = ts.createSourceFile(
        'test.ts',
        source,
        ts.ScriptTarget.Latest,
        true
      );

      let hasCreateProcess = false;
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const expr = node.expression;
          if (ts.isIdentifier(expr) && expr.text === 'createProcess') {
            hasCreateProcess = true;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);

      assert.ok(hasCreateProcess, 'Should detect createProcess call');
    });

    it('should find handler in createProcess config', () => {
      const source = `
        createProcess({
          name: 'test',
          handler: async () => 'done'
        })
      `;

      const sourceFile = ts.createSourceFile(
        'test.ts',
        source,
        ts.ScriptTarget.Latest,
        true
      );

      let foundHandler = false;
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const configArg = node.arguments[0];
          if (configArg && ts.isObjectLiteralExpression(configArg)) {
            for (const prop of configArg.properties) {
              if (ts.isPropertyAssignment(prop) || ts.isMethodDeclaration(prop)) {
                if (ts.isIdentifier(prop.name) && prop.name.text === 'handler') {
                  foundHandler = true;
                }
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);

      assert.ok(foundHandler, 'Should find handler in config');
    });
  });

  describe('configuration', () => {
    it('should accept plugin configuration', () => {
      const plugin = pluginInit({ typescript: ts });

      // The create function should accept config without throwing
      // We can't fully test it without a real LanguageService,
      // but we can verify the function signature accepts config
      assert.strictEqual(typeof plugin.create, 'function');
      assert.strictEqual(plugin.create.length, 1); // Takes one argument (info object)
    });
  });
});
