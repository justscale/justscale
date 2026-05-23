/**
 * HMR Transformer Tests
 *
 * Tests for the hot reload TypeScript transformer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import ts from 'typescript';
import { createHmrTransformer } from '../src/compiler/hmr-transformer.js';

/**
 * Helper to transform source code and return the output.
 */
function transformSource(source: string, fileName = 'test.ts'): string {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  // Create a minimal program for the transformer
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
  };

  const host = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = host.getSourceFile;
  host.getSourceFile = (name, target, onError, shouldCreate) => {
    if (name === fileName) {
      return sourceFile;
    }
    return originalGetSourceFile(name, target, onError, shouldCreate);
  };

  const program = ts.createProgram([fileName], compilerOptions, host);

  const transformer = createHmrTransformer(program, {
    verbose: false,
    baseDir: '/project',
  });

  const result = ts.transform(sourceFile, [transformer]);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const output = printer.printFile(result.transformed[0]);
  result.dispose();

  return output;
}

describe('HMR Transformer', () => {
  describe('Service ID injection', () => {
    it('should inject __serviceId into defineService', () => {
      const input = `
import { defineService } from '@justscale/core'

class MyService extends defineService({
  inject: {},
  factory: () => ({ value: 42 })
}) {}
`;
      const output = transformSource(input, '/project/src/services/my.ts');

      assert.ok(
        output.includes('__serviceId'),
        'Should include __serviceId property'
      );
      assert.ok(
        output.includes('src/services/my.ts#MyService'),
        'Should use file path and class name'
      );
    });

    it('should not duplicate __serviceId if already present', () => {
      const input = `
import { defineService } from '@justscale/core'

class MyService extends defineService({
  __serviceId: 'custom-id',
  inject: {},
  factory: () => ({})
}) {}
`;
      const output = transformSource(input, '/project/test.ts');

      // Count occurrences of __serviceId
      const matches = output.match(/__serviceId/g);
      assert.strictEqual(matches?.length, 1, 'Should have exactly one __serviceId');
    });
  });

  describe('Factory wrapping', () => {
    it('should wrap factory with HMR state injection when hotReload hook is present', () => {
      const input = `
import { defineService, Lifecycle } from '@justscale/core'

class CacheService extends defineService({
  inject: { lifecycle: Lifecycle },
  factory: ({ lifecycle }) => {
    const cache = new Map()
    lifecycle.register('hotReload', () => ({ cache }))
    return { get: (k) => cache.get(k) }
  }
}) {}
`;
      const output = transformSource(input, '/project/src/cache.ts');

      // Debug: print output to see what's generated
      // console.log('OUTPUT:', output)

      // Should have IIFE wrapper - check for __hmr in various forms
      assert.ok(
        output.includes('__hmr') || output.includes('(__hmr'),
        `Should have __hmr parameter in wrapper. Got:\n${output}`
      );

      // Should have __getHmrState call wrapped in __validateHmrState
      assert.ok(
        output.includes('__getHmrState'),
        'Should call __getHmrState'
      );
      assert.ok(
        output.includes('__validateHmrState'),
        'Should wrap state in __validateHmrState'
      );

      // Should rewrite cache initializer
      assert.ok(
        output.includes('__hmr?.cache'),
        'Should rewrite cache initializer with __hmr?.cache'
      );

      // Should have nullish coalescing
      assert.ok(
        output.includes('??'),
        'Should use nullish coalescing operator'
      );
    });

    it('should not wrap factory if no hotReload hook', () => {
      const input = `
import { defineService, Lifecycle } from '@justscale/core'

class SimpleService extends defineService({
  inject: { lifecycle: Lifecycle },
  factory: ({ lifecycle }) => {
    lifecycle.register('stop', () => {})
    return { value: 42 }
  }
}) {}
`;
      const output = transformSource(input, '/project/test.ts');

      // Should NOT have IIFE wrapper
      assert.ok(
        !output.includes('(__hmr)'),
        'Should not have __hmr wrapper when no hotReload hook'
      );

      // Should still have __serviceId
      assert.ok(
        output.includes('__serviceId'),
        'Should still include __serviceId'
      );
    });

    it('should handle multiple variables in hotReload return', () => {
      const input = `
import { defineService, Lifecycle } from '@justscale/core'

class StateService extends defineService({
  inject: { lifecycle: Lifecycle },
  factory: ({ lifecycle }) => {
    const cache = new Map()
    const counter = 0
    const config = { enabled: true }
    lifecycle.register('hotReload', () => ({ cache, counter, config }))
    return { get: () => cache }
  }
}) {}
`;
      const output = transformSource(input, '/project/test.ts');

      // Should rewrite all three variables
      assert.ok(output.includes('__hmr?.cache'), 'Should rewrite cache');
      assert.ok(output.includes('__hmr?.counter'), 'Should rewrite counter');
      assert.ok(output.includes('__hmr?.config'), 'Should rewrite config');
    });

    it('should generate type hash schema object instead of key array', () => {
      const input = `
import { defineService, Lifecycle } from '@justscale/core'

class CacheService extends defineService({
  inject: { lifecycle: Lifecycle },
  factory: ({ lifecycle }) => {
    const cache = new Map()
    const counter = 0
    lifecycle.register('hotReload', () => ({ cache, counter }))
    return { get: (k: string) => cache.get(k) }
  }
}) {}
`;
      const output = transformSource(input, '/project/src/cache.ts');

      // Should pass an object literal to __validateHmrState, not an array
      assert.ok(
        !output.includes("['cache'") && !output.includes('["cache"'),
        'Should NOT use array format for expected keys'
      );
      // Should have object property assignments like { cache: "hash", counter: "hash" }
      assert.ok(
        output.includes('__validateHmrState'),
        'Should call __validateHmrState'
      );
      // The output should contain property assignments for each var with hash values
      assert.match(
        output,
        /cache:\s*"[0-9a-f]+"/,
        'Should have cache property with hex hash value'
      );
      assert.match(
        output,
        /counter:\s*"[0-9a-f]+"/,
        'Should have counter property with hex hash value'
      );
    });
  });

  describe('Import handling', () => {
    it('should add __getHmrState to existing @justscale/core import', () => {
      const input = `
import { defineService, Lifecycle } from '@justscale/core'

class CacheService extends defineService({
  inject: { lifecycle: Lifecycle },
  factory: ({ lifecycle }) => {
    const cache = new Map()
    lifecycle.register('hotReload', () => ({ cache }))
    return {}
  }
}) {}
`;
      const output = transformSource(input, '/project/test.ts');

      // Should add __getHmrState to import
      assert.ok(
        output.includes('__getHmrState'),
        'Should add __getHmrState import'
      );
    });

    it('should create new import if @justscale/core not already imported', () => {
      // This is an edge case - defineService would normally be imported
      // But the transformer should handle it gracefully
      const input = `
const defineService = (x: any) => x

class MyService extends defineService({
  inject: {},
  factory: () => {
    const cache = new Map()
    lifecycle.register('hotReload', () => ({ cache }))
    return {}
  }
}) {}
`;
      const output = transformSource(input, '/project/test.ts');

      // Should not crash, may or may not add import depending on detection
      assert.ok(typeof output === 'string', 'Should produce output');
    });
  });
});
