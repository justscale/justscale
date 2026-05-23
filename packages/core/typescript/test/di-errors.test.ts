/**
 * DI Error Formatter tests.
 *
 * Tests the parsing and formatting of MissingDepsError type errors.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import ts from 'typescript';
import {
  DIErrorCode,
  formatDIErrorCode,
  isDIDiagnostic,
  getDIErrorCode,
  createDIDiagnostic,
  formatTokenName,
  parseUnionType,
  extractGenericArgs,
  hasDIErrorMarkers,
  parseMissingDepsError,
  formatDIError,
  isDITypeDiagnostic,
  rewriteDIDiagnostic,
  processDIDiagnostics,
} from '../src/di-errors/index.js';

// ============================================================================
// Error Code Tests
// ============================================================================

describe('DI Error Formatter', () => {
  describe('DIErrorCode', () => {
    it('should have MissingDependencies code', () => {
      assert.strictEqual(DIErrorCode.MissingDependencies, 1001);
    });

    it('should have CircularDependency code', () => {
      assert.strictEqual(DIErrorCode.CircularDependency, 1002);
    });

    it('should have UnsatisfiedConstraint code', () => {
      assert.strictEqual(DIErrorCode.UnsatisfiedConstraint, 1003);
    });
  });

  describe('formatDIErrorCode', () => {
    it('should format MissingDependencies code', () => {
      assert.strictEqual(formatDIErrorCode(DIErrorCode.MissingDependencies), 'DI1001');
    });

    it('should format CircularDependency code', () => {
      assert.strictEqual(formatDIErrorCode(DIErrorCode.CircularDependency), 'DI1002');
    });
  });

  describe('isDIDiagnostic', () => {
    it('should return true for justscale-di source', () => {
      const diagnostic: ts.Diagnostic = {
        file: undefined,
        start: 0,
        length: 0,
        messageText: 'Some error',
        category: ts.DiagnosticCategory.Error,
        code: 201001,
        source: 'justscale-di',
      };
      assert.ok(isDIDiagnostic(diagnostic));
    });

    it('should return false for other sources', () => {
      const diagnostic: ts.Diagnostic = {
        file: undefined,
        start: 0,
        length: 0,
        messageText: 'Some error',
        category: ts.DiagnosticCategory.Error,
        code: 2345,
        source: 'typescript',
      };
      assert.ok(!isDIDiagnostic(diagnostic));
    });
  });

  describe('getDIErrorCode', () => {
    it('should extract error code from DI diagnostic', () => {
      const diagnostic: ts.Diagnostic = {
        file: undefined,
        start: 0,
        length: 0,
        messageText: 'Some error',
        category: ts.DiagnosticCategory.Error,
        code: 201001, // DI_CODE_OFFSET + 1001
        source: 'justscale-di',
      };
      assert.strictEqual(getDIErrorCode(diagnostic), DIErrorCode.MissingDependencies);
    });

    it('should return null for non-DI diagnostics', () => {
      const diagnostic: ts.Diagnostic = {
        file: undefined,
        start: 0,
        length: 0,
        messageText: 'Some error',
        category: ts.DiagnosticCategory.Error,
        code: 2345,
      };
      assert.strictEqual(getDIErrorCode(diagnostic), null);
    });
  });

  describe('createDIDiagnostic', () => {
    it('should create a diagnostic with correct properties', () => {
      const diagnostic = createDIDiagnostic(
        DIErrorCode.MissingDependencies,
        undefined,
        10,
        20,
        'Test message'
      );

      assert.strictEqual(diagnostic.code, 201001);
      assert.strictEqual(diagnostic.source, 'justscale-di');
      assert.strictEqual(diagnostic.start, 10);
      assert.strictEqual(diagnostic.length, 20);
      assert.ok((diagnostic.messageText as string).includes('DI1001'));
      assert.ok((diagnostic.messageText as string).includes('Test message'));
    });
  });

  // ============================================================================
  // Token Name Formatting Tests
  // ============================================================================

  describe('formatTokenName', () => {
    it('should format ModelRepositoryToken', () => {
      assert.strictEqual(
        formatTokenName('ModelRepositoryToken<User, {}>'),
        'ModelRepository<User>'
      );
    });

    it('should format ModelRepositoryToken without trailing object', () => {
      // Still simplify to ModelRepository even without explicit {}
      assert.strictEqual(
        formatTokenName('ModelRepositoryToken<User>'),
        'ModelRepository<User>'
      );
    });

    it('should format RepositoryToken', () => {
      assert.strictEqual(
        formatTokenName('RepositoryToken<User>'),
        'Repository<User>'
      );
    });

    it('should format typeof expressions', () => {
      assert.strictEqual(
        formatTokenName('typeof AbstractEmailSender'),
        'AbstractEmailSender'
      );
    });

    it('should format ServiceDef', () => {
      assert.strictEqual(
        formatTokenName('ServiceDef<UserService, {}>'),
        'Service<UserService>'
      );
    });

    it('should format FeatureToken', () => {
      assert.strictEqual(
        formatTokenName('FeatureToken<[], []>'),
        'Feature'
      );
    });

    it('should handle complex FeatureToken', () => {
      assert.strictEqual(
        formatTokenName('FeatureToken<[ModelRepositoryToken<User, {}>], [TokenA]>'),
        'Feature'
      );
    });

    it('should preserve unknown tokens', () => {
      assert.strictEqual(
        formatTokenName('SomeUnknownToken'),
        'SomeUnknownToken'
      );
    });
  });

  describe('parseUnionType', () => {
    it('should parse simple union', () => {
      const result = parseUnionType('A | B | C');
      assert.deepStrictEqual(result, ['A', 'B', 'C']);
    });

    it('should parse union with generics', () => {
      const result = parseUnionType('ModelRepositoryToken<User, {}> | ModelRepositoryToken<Session, {}>');
      assert.deepStrictEqual(result, [
        'ModelRepositoryToken<User, {}>',
        'ModelRepositoryToken<Session, {}>'
      ]);
    });

    it('should handle nested generics', () => {
      const result = parseUnionType('A<B<C>> | D');
      assert.deepStrictEqual(result, ['A<B<C>>', 'D']);
    });

    it('should handle single type', () => {
      const result = parseUnionType('SingleType');
      assert.deepStrictEqual(result, ['SingleType']);
    });

    it('should handle empty string', () => {
      const result = parseUnionType('');
      assert.deepStrictEqual(result, []);
    });
  });

  describe('hasDIErrorMarkers', () => {
    it('should detect __brand marker with double quotes', () => {
      const typeStr = '{ __brand: "MissingDependencies"; _missing: SomeType }';
      assert.ok(hasDIErrorMarkers(typeStr));
    });

    it('should detect __brand marker with single quotes', () => {
      const typeStr = "{ __brand: 'MissingDependencies'; _missing: SomeType }";
      assert.ok(hasDIErrorMarkers(typeStr));
    });

    it('should detect _missing field', () => {
      const typeStr = '{ _missing: ModelRepositoryToken<User> }';
      assert.ok(hasDIErrorMarkers(typeStr));
    });

    it('should detect _hint field', () => {
      const typeStr = "{ _hint: 'Add the missing dependencies before this component' }";
      assert.ok(hasDIErrorMarkers(typeStr));
    });

    it('should detect MissingDepsError generic type', () => {
      const typeStr = 'MissingDepsError<Component, Missing>';
      assert.ok(hasDIErrorMarkers(typeStr));
    });

    it('should not detect unrelated types', () => {
      const typeStr = 'SomeOtherType<A, B>';
      assert.ok(!hasDIErrorMarkers(typeStr));
    });

    it('should detect markers in complex nested messages', () => {
      const typeStr = 'Type \'FeatureToken<...>\' is not assignable to type \'{ __brand: "MissingDependencies"; _missing: A | B; _hint: "Add the missing dependencies before this component" }\'';
      assert.ok(hasDIErrorMarkers(typeStr));
    });
  });

  describe('extractGenericArgs', () => {
    it('should extract generic arguments', () => {
      const result = extractGenericArgs('MissingDepsError<Component, Missing>');
      assert.deepStrictEqual(result, ['Component', 'Missing']);
    });

    it('should handle nested generics in first arg', () => {
      const result = extractGenericArgs('MissingDepsError<FeatureToken<[], []>, Missing>');
      assert.deepStrictEqual(result, ['FeatureToken<[], []>', 'Missing']);
    });

    it('should handle complex types', () => {
      const result = extractGenericArgs(
        'MissingDepsError<FeatureToken<[A, B], [C]>, X | Y>'
      );
      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0], 'FeatureToken<[A, B], [C]>');
      assert.strictEqual(result[1], 'X | Y');
    });

    it('should return empty array for non-generic type', () => {
      const result = extractGenericArgs('SimpleType');
      assert.deepStrictEqual(result, []);
    });
  });

  describe('parseMissingDepsError', () => {
    it('should parse simple MissingDepsError', () => {
      const result = parseMissingDepsError(
        'MissingDepsError<typeof UserService, typeof AbstractEmailSender>'
      );

      assert.ok(result);
      assert.strictEqual(result.component, 'typeof UserService');
      assert.strictEqual(result.componentName, 'UserService');
      assert.deepStrictEqual(result.missingDeps, ['typeof AbstractEmailSender']);
      assert.deepStrictEqual(result.missingDepNames, ['AbstractEmailSender']);
    });

    it('should parse structural form with _missing field', () => {
      const result = parseMissingDepsError(
        '{ __brand: "MissingDependencies"; _missing: typeof AbstractEmailSender; _hint: "..." }'
      );

      assert.ok(result);
      assert.strictEqual(result.component, null);
      assert.deepStrictEqual(result.missingDepNames, ['AbstractEmailSender']);
    });

    it('should parse structural form with union _missing', () => {
      const result = parseMissingDepsError(
        '{ __brand: "MissingDependencies"; _missing: ModelRepositoryToken<User> | ModelRepositoryToken<Session>; _hint: "..." }'
      );

      assert.ok(result);
      assert.deepStrictEqual(result.missingDepNames, [
        'ModelRepository<User>',
        'ModelRepository<Session>'
      ]);
    });

    it('should parse MissingDepsError with union missing deps', () => {
      const result = parseMissingDepsError(
        'MissingDepsError<FeatureToken<[], []>, ModelRepositoryToken<User, {}> | ModelRepositoryToken<Session, {}>>'
      );

      assert.ok(result);
      assert.strictEqual(result.componentName, 'Feature');
      assert.strictEqual(result.missingDeps.length, 2);
      assert.deepStrictEqual(result.missingDepNames, [
        'ModelRepository<User>',
        'ModelRepository<Session>'
      ]);
    });

    it('should parse complex nested types', () => {
      const typeStr = 'MissingDepsError<FeatureToken<[ModelRepositoryToken<User, {}>, ModelRepositoryToken<Session, {}>, typeof AbstractEmailSender, typeof AbstractProcessExecutor], [...]>, ModelRepositoryToken<User, {}> | ModelRepositoryToken<Session, {}>>';

      const result = parseMissingDepsError(typeStr);

      assert.ok(result);
      assert.strictEqual(result.componentName, 'Feature');
      assert.deepStrictEqual(result.missingDepNames, [
        'ModelRepository<User>',
        'ModelRepository<Session>'
      ]);
    });

    it('should return null for non-MissingDepsError', () => {
      const result = parseMissingDepsError('Type "A" is not assignable to type "B"');
      assert.strictEqual(result, null);
    });

    it('should handle MissingDepsError in larger message', () => {
      const message = 'Argument of type \'typeof AuthFeature\' is not assignable to parameter of type \'MissingDepsError<FeatureToken<[A], [B]>, A>\'.';

      const result = parseMissingDepsError(message);

      assert.ok(result);
      assert.strictEqual(result.componentName, 'Feature');
    });
  });

  describe('formatDIError', () => {
    it('should format error with single missing dep', () => {
      const parsed = {
        component: 'typeof UserService',
        componentName: 'UserService',
        missingDeps: ['typeof AbstractEmailSender'],
        missingDepNames: ['AbstractEmailSender']
      };

      const result = formatDIError(parsed);

      assert.ok(result.includes('DI1001: Missing dependencies for UserService:'));
      assert.ok(result.includes('- AbstractEmailSender'));
      assert.ok(result.includes('Hint:'));
    });

    it('should format error with multiple missing deps', () => {
      const parsed = {
        component: 'FeatureToken<[], []>',
        componentName: 'AuthFeature',
        missingDeps: ['ModelRepositoryToken<User, {}>', 'ModelRepositoryToken<Session, {}>'],
        missingDepNames: ['ModelRepository<User>', 'ModelRepository<Session>']
      };

      const result = formatDIError(parsed);

      assert.ok(result.includes('DI1001: Missing dependencies for AuthFeature:'));
      assert.ok(result.includes('- ModelRepository<User>'));
      assert.ok(result.includes('- ModelRepository<Session>'));
    });
  });

  describe('isDITypeDiagnostic', () => {
    it('should detect MissingDepsError diagnostics', () => {
      const diagnostic: ts.Diagnostic = {
        file: undefined,
        start: 0,
        length: 0,
        messageText: 'Type MissingDepsError<A, B> is not assignable',
        category: ts.DiagnosticCategory.Error,
        code: 2345,
      };

      assert.ok(isDITypeDiagnostic(diagnostic));
    });

    it('should detect RequiresSatisfied diagnostics', () => {
      const diagnostic: ts.Diagnostic = {
        file: undefined,
        start: 0,
        length: 0,
        messageText: 'Type X is not assignable to RequiresSatisfied<Y, Z>',
        category: ts.DiagnosticCategory.Error,
        code: 2345,
      };

      assert.ok(isDITypeDiagnostic(diagnostic));
    });

    it('should detect FeatureToken assignment errors', () => {
      const diagnostic: ts.Diagnostic = {
        file: undefined,
        start: 0,
        length: 0,
        messageText: 'FeatureToken is not assignable to parameter',
        category: ts.DiagnosticCategory.Error,
        code: 2345,
      };

      assert.ok(isDITypeDiagnostic(diagnostic));
    });

    it('should not detect unrelated diagnostics', () => {
      const diagnostic: ts.Diagnostic = {
        file: undefined,
        start: 0,
        length: 0,
        messageText: 'Property x does not exist on type Y',
        category: ts.DiagnosticCategory.Error,
        code: 2339,
      };

      assert.ok(!isDITypeDiagnostic(diagnostic));
    });

    it('should handle DiagnosticMessageChain', () => {
      const diagnostic: ts.Diagnostic = {
        file: undefined,
        start: 0,
        length: 0,
        messageText: {
          messageText: 'Outer error',
          category: ts.DiagnosticCategory.Error,
          code: 2345,
          next: [{
            messageText: 'MissingDepsError<A, B>',
            category: ts.DiagnosticCategory.Error,
            code: 2345,
          }]
        },
        category: ts.DiagnosticCategory.Error,
        code: 2345,
      };

      assert.ok(isDITypeDiagnostic(diagnostic));
    });
  });

  describe('rewriteDIDiagnostic', () => {
    it('should rewrite MissingDepsError diagnostic', () => {
      const diagnostic: ts.Diagnostic = {
        file: undefined,
        start: 100,
        length: 50,
        messageText: 'MissingDepsError<typeof UserService, typeof AbstractEmailSender>',
        category: ts.DiagnosticCategory.Error,
        code: 2345,
      };

      const result = rewriteDIDiagnostic(diagnostic);

      assert.ok(result);
      assert.ok((result.messageText as string).includes('DI1001: Missing dependencies for UserService'));
      assert.ok((result.messageText as string).includes('AbstractEmailSender'));
      assert.strictEqual(result.source, 'justscale-di');
      assert.strictEqual(result.code, 201001); // DI_CODE_OFFSET + MissingDependencies
      assert.strictEqual(result.start, 100);
      assert.strictEqual(result.length, 50);
    });

    it('should return null for non-DI diagnostics', () => {
      const diagnostic: ts.Diagnostic = {
        file: undefined,
        start: 0,
        length: 0,
        messageText: 'Property x does not exist',
        category: ts.DiagnosticCategory.Error,
        code: 2339,
      };

      const result = rewriteDIDiagnostic(diagnostic);
      assert.strictEqual(result, null);
    });

    it('should preserve diagnostic location info and set DI code', () => {
      const diagnostic: ts.Diagnostic = {
        file: undefined,
        start: 42,
        length: 10,
        messageText: 'MissingDepsError<A, B>',
        category: ts.DiagnosticCategory.Error,
        code: 2345,
      };

      const result = rewriteDIDiagnostic(diagnostic);

      assert.ok(result);
      assert.strictEqual(result.start, 42);
      assert.strictEqual(result.length, 10);
      // Code is now the DI error code, not the original TS code
      assert.strictEqual(result.code, 201001);
    });
  });

  describe('processDIDiagnostics', () => {
    it('should process array of diagnostics', () => {
      const diagnostics: ts.Diagnostic[] = [
        {
          file: undefined,
          start: 0,
          length: 0,
          messageText: 'MissingDepsError<typeof A, typeof B>',
          category: ts.DiagnosticCategory.Error,
          code: 2345,
        },
        {
          file: undefined,
          start: 0,
          length: 0,
          messageText: 'Property x does not exist',
          category: ts.DiagnosticCategory.Error,
          code: 2339,
        }
      ];

      const result = processDIDiagnostics(diagnostics);

      assert.strictEqual(result.length, 2);
      // First diagnostic should be rewritten
      assert.ok((result[0].messageText as string).includes('Missing dependencies'));
      // Second diagnostic should be unchanged
      assert.strictEqual(result[1].messageText, 'Property x does not exist');
    });

    it('should handle empty array', () => {
      const result = processDIDiagnostics([]);
      assert.deepStrictEqual(result, []);
    });

    it('should preserve order', () => {
      const diagnostics: ts.Diagnostic[] = [
        {
          file: undefined,
          start: 10,
          length: 5,
          messageText: 'Error 1',
          category: ts.DiagnosticCategory.Error,
          code: 1001,
        },
        {
          file: undefined,
          start: 20,
          length: 5,
          messageText: 'MissingDepsError<A, B>',
          category: ts.DiagnosticCategory.Error,
          code: 2345,
        },
        {
          file: undefined,
          start: 30,
          length: 5,
          messageText: 'Error 3',
          category: ts.DiagnosticCategory.Error,
          code: 1003,
        }
      ];

      const result = processDIDiagnostics(diagnostics);

      assert.strictEqual(result.length, 3);
      assert.strictEqual(result[0].start, 10);
      assert.strictEqual(result[1].start, 20);
      assert.strictEqual(result[2].start, 30);
    });
  });

  describe('real-world error messages', () => {
    it('should handle typical builder.add() error', () => {
      const message = 'Argument of type \'FeatureToken<[ModelRepositoryToken<User, {}>, ModelRepositoryToken<Session, {}>, typeof AbstractEmailSender, typeof AbstractProcessExecutor], [ServiceDef<AuthService, {...}>]>\' is not assignable to parameter of type \'MissingDepsError<FeatureToken<[ModelRepositoryToken<User, {}>, ModelRepositoryToken<Session, {}>, typeof AbstractEmailSender, typeof AbstractProcessExecutor], [...]>, ModelRepositoryToken<User, {}> | ModelRepositoryToken<Session, {}>>\'.';

      const parsed = parseMissingDepsError(message);

      assert.ok(parsed);
      assert.strictEqual(parsed.componentName, 'Feature');
      assert.ok(parsed.missingDepNames.includes('ModelRepository<User>'));
      assert.ok(parsed.missingDepNames.includes('ModelRepository<Session>'));
    });

    it('should handle service dependency error', () => {
      const message = 'Argument of type \'ServiceDef<EmailService, { sender: typeof AbstractEmailSender }>\' is not assignable to parameter of type \'MissingDepsError<ServiceDef<EmailService, { sender: typeof AbstractEmailSender }>, typeof AbstractEmailSender>\'.';

      const parsed = parseMissingDepsError(message);

      assert.ok(parsed);
      assert.ok(parsed.missingDepNames.includes('AbstractEmailSender'));
    });
  });
});
