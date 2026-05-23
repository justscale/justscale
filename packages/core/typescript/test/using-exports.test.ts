import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { analyzeHandler, Opcode } from '../src/compiler/analyzer.js';
import { generateSwitchProcess, buildSteps, type SwitchCodeGenInput } from '../src/compiler/switch-codegen.js';
import { compileProcessSource } from '../src/compiler/compile.js';

function analyze(handlerCode: string) {
  const fullCode = `
    import { signal, race, delay } from '@justscale/core/process'
    const svc = { paid: {} as any, joined: {} as any }
    const handler = ${handlerCode}
  `;

  const sourceFile = ts.createSourceFile(
    'test.ts',
    fullCode,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noEmit: true,
  };

  const host = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = host.getSourceFile;
  host.getSourceFile = (fileName, languageVersion) => {
    if (fileName === 'test.ts') return sourceFile;
    return originalGetSourceFile.call(host, fileName, languageVersion);
  };

  const program = ts.createProgram(['test.ts'], compilerOptions, host);
  const typeChecker = program.getTypeChecker();

  let handler: ts.ArrowFunction | ts.FunctionExpression | null = null;
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === 'handler') {
          if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
            handler = decl.initializer;
          }
        }
      }
    }
  });

  if (!handler) throw new Error('Handler not found in test code');

  return analyzeHandler(handler, typeChecker);
}

function findOpcodes(opcodes: Opcode[], op: Opcode['op']): Opcode[] {
  return opcodes.filter((o) => o.op === op);
}

describe('using exports', () => {
  describe('detection', () => {
    it('detects using exports with data fields', () => {
      const result = analyze(`async () => {
        using exports = {
          count: 0,
          name: 'test',
        }
        return 'done'
      }`);

      assert.ok(result.exports, 'Should detect exports');
      assert.strictEqual(result.exports.fields.length, 2);
      assert.strictEqual(result.exports.fields[0].name, 'count');
      assert.strictEqual(result.exports.fields[1].name, 'name');
      assert.strictEqual(result.exports.methods.length, 0);
    });

    it('detects using exports with methods (method declarations)', () => {
      const result = analyze(`async () => {
        using exports = {
          count: 0,
          getCount() { return this.count },
        }
        return 'done'
      }`);

      assert.ok(result.exports);
      assert.strictEqual(result.exports.fields.length, 1);
      assert.strictEqual(result.exports.fields[0].name, 'count');
      assert.strictEqual(result.exports.methods.length, 1);
      assert.strictEqual(result.exports.methods[0].name, 'getCount');
    });

    it('detects arrow function properties as methods', () => {
      const result = analyze(`async () => {
        using exports = {
          items: [] as string[],
          getFirst: () => 'x',
        }
        return 'done'
      }`);

      assert.ok(result.exports);
      assert.strictEqual(result.exports.fields.length, 1);
      assert.strictEqual(result.exports.fields[0].name, 'items');
      assert.strictEqual(result.exports.methods.length, 1);
      assert.strictEqual(result.exports.methods[0].name, 'getFirst');
    });

    it('detects function expression properties as methods', () => {
      const result = analyze(`async () => {
        using exports = {
          value: 42,
          compute: function() { return this.value * 2 },
        }
        return 'done'
      }`);

      assert.ok(result.exports);
      assert.strictEqual(result.exports.fields.length, 1);
      assert.strictEqual(result.exports.methods.length, 1);
      assert.strictEqual(result.exports.methods[0].name, 'compute');
    });

    it('handles mixed fields and methods', () => {
      const result = analyze(`async () => {
        using exports = {
          nodeCount: 0,
          registry: new Map<string, { addr: string }>(),
          getNode(id: string) { return this.registry.get(id) },
          getNodesByCapability: (cap: string) => [],
        }
        return 'done'
      }`);

      assert.ok(result.exports);
      assert.strictEqual(result.exports.fields.length, 2);
      assert.strictEqual(result.exports.fields[0].name, 'nodeCount');
      assert.strictEqual(result.exports.fields[1].name, 'registry');
      assert.strictEqual(result.exports.methods.length, 2);
      assert.strictEqual(result.exports.methods[0].name, 'getNode');
      assert.strictEqual(result.exports.methods[1].name, 'getNodesByCapability');
    });
  });

  describe('variable tracking', () => {
    it('tracks exports as a regular serializable variable, not a using var', () => {
      const result = analyze(`async () => {
        using exports = {
          count: 0,
        }
        return 'done'
      }`);

      const exportsVar = result.variables.get('exports');
      assert.ok(exportsVar, 'exports should be tracked as a variable');
      assert.strictEqual(exportsVar.isUsing, false, 'exports should NOT be a using var');
      assert.strictEqual(exportsVar.isSerializable, true, 'exports should be serializable');
    });

    it('does not emit REHYDRATE opcode for exports', () => {
      const result = analyze(`async () => {
        using exports = {
          status: 'pending',
        }
        const r = race()
        switch (true) {
          case signal(r, svc.paid):
            exports.status = 'paid'
            break
        }
        return 'done'
      }`);

      const rehydrateOps = findOpcodes(result.opcodes, 'REHYDRATE');
      assert.strictEqual(rehydrateOps.length, 0, 'Should NOT emit REHYDRATE for exports');
    });

    it('does not add exports to rehydration blocks', () => {
      const result = analyze(`async () => {
        using exports = {
          count: 0,
        }
        return 'done'
      }`);

      assert.strictEqual(
        result.rehydrationBlocks['exports'],
        undefined,
        'exports should NOT be in rehydration blocks',
      );
    });
  });

  describe('without exports', () => {
    it('returns undefined exports for processes without using exports', () => {
      const result = analyze(`async () => {
        let count = 0
        const r = race()
        switch (true) {
          case signal(r, svc.paid):
            count++
            break
        }
        return count
      }`);

      assert.strictEqual(result.exports, undefined, 'Should have no exports');
    });
  });

  describe('coexistence with regular using', () => {
    it('exports and regular using vars coexist', () => {
      const result = analyze(`async () => {
        using exports = {
          count: 0,
        }
        using db = await someServiceCall()
        return 'done'
      }`);

      const exportsVar = result.variables.get('exports');
      assert.ok(exportsVar);
      assert.strictEqual(exportsVar.isUsing, false, 'exports is not a using var');

      const dbVar = result.variables.get('db');
      assert.ok(dbVar);
      assert.strictEqual(dbVar.isUsing, true, 'db IS a using var');
    });
  });

  describe('exports with other statements', () => {
    it('exports coexists with mutations and other code', () => {
      const result = analyze(`async () => {
        using exports = {
          phase: 'init' as string,
          pot: 0,
        }

        exports.phase = 'round1'
        exports.pot += 100

        return 'done'
      }`);

      assert.ok(result.exports, 'Should detect exports');
      assert.strictEqual(result.exports.fields.length, 2);
      assert.strictEqual(result.exports.fields[0].name, 'phase');
      assert.strictEqual(result.exports.fields[1].name, 'pot');

      const exportsVar = result.variables.get('exports');
      assert.ok(exportsVar);
      assert.strictEqual(exportsVar.isSerializable, true);
      assert.strictEqual(exportsVar.isUsing, false);
    });

    it('exports with shorthand properties', () => {
      const result = analyze(`async () => {
        const initial = 0
        using exports = {
          initial,
          name: 'test',
        }
        return 'done'
      }`);

      assert.ok(result.exports);
      assert.strictEqual(result.exports.fields.length, 2);
      assert.strictEqual(result.exports.fields[0].name, 'initial');
      assert.strictEqual(result.exports.fields[1].name, 'name');
    });
  });

  describe('codegen', () => {
    function generateCode(handlerCode: string): string {
      const fullCode = `const handler = ${handlerCode}`;
      const sourceFile = ts.createSourceFile('test.ts', fullCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const compilerOptions: ts.CompilerOptions = { target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, strict: true, noEmit: true };
      const host = ts.createCompilerHost(compilerOptions);
      const originalGetSourceFile = host.getSourceFile;
      host.getSourceFile = (fileName, languageVersion) => {
        if (fileName === 'test.ts') return sourceFile;
        return originalGetSourceFile.call(host, fileName, languageVersion);
      };
      const program = ts.createProgram(['test.ts'], compilerOptions, host);
      const typeChecker = program.getTypeChecker();

      let handler: ts.ArrowFunction | ts.FunctionExpression | null = null;
      ts.forEachChild(sourceFile, (node) => {
        if (ts.isVariableStatement(node)) {
          for (const decl of node.declarationList.declarations) {
            if (ts.isIdentifier(decl.name) && decl.name.text === 'handler' && decl.initializer) {
              if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
                handler = decl.initializer;
              }
            }
          }
        }
      });
      if (!handler) throw new Error('Handler not found');

      const analysis = analyzeHandler(handler, typeChecker);
      const input: SwitchCodeGenInput = {
        id: 'test-process',
        path: '/test',
        version: '1.0',
        injectNode: undefined,
        handler,
        analysis,
        originalNode: undefined as any,
      };

      const callExpr = generateSwitchProcess(ts.factory, input);
      const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
      const outFile = ts.createSourceFile('output.ts', '', ts.ScriptTarget.Latest, false);
      return printer.printNode(ts.EmitHint.Expression, callExpr, outFile);
    }

    it('emits exports with field names and methods', () => {
      const code = generateCode(`async () => {
        using exports = {
          count: 0,
          name: 'test',
          getCount() { return this.count },
        }
        return 'done'
      }`);

      // Check for `exports:` as a property key in the generated __createProcess call
      assert.ok(code.includes('"exports"') || code.includes('exports:'), 'Should emit exports property');
      assert.ok(code.includes('"count"'), 'Should include count in fields');
      assert.ok(code.includes('"name"'), 'Should include name in fields');
      assert.ok(code.includes('"getCount"'), 'Should include getCount in methods');
    });

    it('does not emit exports metadata for processes without exports', () => {
      const code = generateCode(`async () => {
        let x = 0
        return x
      }`);

      // Should not contain a "fields" array (exports metadata marker)
      assert.ok(!code.includes('"fields"'), 'Should NOT emit exports metadata');
    });

    it('emits methods as function expressions', () => {
      const code = generateCode(`async () => {
        using exports = {
          value: 42,
          double() { return this.value * 2 },
          triple: () => 0,
        }
        return 'done'
      }`);

      assert.ok(code.includes('"double"'), 'Should have double method');
      assert.ok(code.includes('"triple"'), 'Should have triple method');
      assert.ok(code.includes('"value"'));
    });
  });

  describe('declaration type inference (.d.ts)', () => {
    it('infers TExports from using exports in .d.ts output', () => {
      const source = `
        import { createProcess } from '@justscale/core/process'

        export const myProcess = createProcess({
          path: '/test/:id',
          inject: {},
          async handler({}, [id]) {
            using exports = {
              phase: 'init' as string,
              count: 0,
            }
            return 'done'
          }
        })
      `;

      const result = compileProcessSource(source, 'test.process.ts');
      assert.ok(result.declarationText, 'Should produce .d.ts output');

      // TExports should include phase and count - NOT be void
      assert.ok(
        result.declarationText.includes('phase'),
        `Declaration should include 'phase' in TExports, got: ${result.declarationText}`
      );
      assert.ok(
        result.declarationText.includes('count'),
        `Declaration should include 'count' in TExports, got: ${result.declarationText}`
      );
      assert.ok(
        !result.declarationText.includes('void'),
        `TExports should NOT be void, got: ${result.declarationText}`
      );
    });

    it('keeps TExports as void when no using exports', () => {
      const source = `
        import { createProcess } from '@justscale/core/process'

        export const simpleProcess = createProcess({
          path: '/simple',
          inject: {},
          async handler({}, []) {
            return 42
          }
        })
      `;

      const result = compileProcessSource(source, 'simple.process.ts');
      assert.ok(result.declarationText, 'Should produce .d.ts output');

      // TExports should be void (the default)
      assert.ok(
        result.declarationText.includes('void'),
        `TExports should be void when no exports, got: ${result.declarationText}`
      );
    });

    it('infers complex types including methods', () => {
      const source = `
        import { createProcess } from '@justscale/core/process'

        export const coordProcess = createProcess({
          path: '/coord',
          inject: {},
          async handler({}, []) {
            using exports = {
              nodeCount: 0,
              registry: new Map<string, { addr: string }>(),
              getNode(id: string) { return this.registry.get(id) },
            }
            return 'done'
          }
        })
      `;

      const result = compileProcessSource(source, 'coord.process.ts');
      assert.ok(result.declarationText, 'Should produce .d.ts output');

      assert.ok(
        result.declarationText.includes('nodeCount'),
        `Should include nodeCount, got: ${result.declarationText}`
      );
      assert.ok(
        result.declarationText.includes('registry'),
        `Should include registry, got: ${result.declarationText}`
      );
      assert.ok(
        result.declarationText.includes('getNode'),
        `Should include getNode method, got: ${result.declarationText}`
      );
    });

    it('auto-exports non-exported interfaces referenced by exports type', () => {
      const source = `
        import { createProcess } from '@justscale/core/process'

        interface SeatInfo {
          playerId: string
          chips: number
        }

        export const tableProcess = createProcess({
          path: '/table/:id',
          inject: {},
          async handler({}, [id]) {
            using exports = {
              seats: new Map<number, SeatInfo>(),
              count: 0,
            }
            return 'done'
          }
        })
      `;

      const result = compileProcessSource(source, 'table.process.ts');
      assert.ok(result.declarationText, 'Should produce .d.ts output');

      // SeatInfo should be auto-exported in .d.ts
      assert.ok(
        result.declarationText.includes('export interface SeatInfo') ||
        result.declarationText.includes('export declare interface SeatInfo'),
        `SeatInfo should be auto-exported, got: ${result.declarationText}`
      );

      // TExports should reference SeatInfo
      assert.ok(
        result.declarationText.includes('SeatInfo'),
        `TExports should reference SeatInfo, got: ${result.declarationText}`
      );

      // No TS4020 errors
      const ts4020 = result.diagnostics.filter(d => d.code === 4020);
      assert.strictEqual(ts4020.length, 0, `Should have no TS4020 errors, got: ${ts4020.map(d => typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText).join(', ')}`);
    });

    it('handles multiple processes with shared non-exported types', () => {
      const source = `
        import { createProcess } from '@justscale/core/process'

        interface PlayerInfo {
          name: string
          score: number
        }

        interface Card {
          suit: string
          rank: string
        }

        export const gameProcess = createProcess({
          path: '/game/:id',
          inject: {},
          async handler({}, [id]) {
            using exports = {
              players: new Map<string, PlayerInfo>(),
              communityCards: [] as Card[],
              phase: 'deal' as string,
            }
            return 'done'
          }
        })

        export const lobbyProcess = createProcess({
          path: '/lobby',
          inject: {},
          async handler({}, []) {
            using exports = {
              waiting: [] as PlayerInfo[],
            }
            return 'done'
          }
        })
      `;

      const result = compileProcessSource(source, 'multi.process.ts');
      assert.ok(result.declarationText, 'Should produce .d.ts output');

      // Both PlayerInfo and Card should be auto-exported
      assert.ok(
        result.declarationText.includes('PlayerInfo'),
        `Should export PlayerInfo, got: ${result.declarationText}`
      );
      assert.ok(
        result.declarationText.includes('Card'),
        `Should export Card, got: ${result.declarationText}`
      );

      // No errors
      const errors = result.diagnostics.filter(d => d.code === 4020);
      assert.strictEqual(errors.length, 0, 'Should have no TS4020 errors');
    });
  });
});
