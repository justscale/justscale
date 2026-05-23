import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { analyzeHandler, type Opcode, type SubProcessInfo } from '../src/compiler/analyzer.js';

function analyze(handlerCode: string) {
  const fullCode = `
    import { signal, race, delay } from '@justscale/core/process'
    declare function createSubProcess(config: any): any
    const svc = { paid: {} as any, action: {} as any }
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

describe('createSubProcess', () => {
  describe('detection', () => {
    it('detects createSubProcess declaration', () => {
      const result = analyze(`async () => {
        const playerSeat = createSubProcess({
          name: 'player',
          path: '/:playerId',
          async handler(playerId: string) {
            await signal(svc.action)
          }
        })
        return 'done'
      }`);

      assert.strictEqual(result.subprocesses.length, 1);
      assert.strictEqual(result.subprocesses[0].name, 'player');
      assert.strictEqual(result.subprocesses[0].path, '/:playerId');
      assert.strictEqual(result.subprocesses[0].varName, 'playerSeat');
      assert.strictEqual(result.subprocesses[0].handlerParams.length, 1);
      assert.strictEqual(result.subprocesses[0].handlerParams[0], 'playerId');
    });

    it('analyzes subprocess handler body recursively', () => {
      const result = analyze(`async () => {
        const playerSeat = createSubProcess({
          name: 'player',
          path: '/:playerId',
          async handler(playerId: string) {
            let chips = 1000
            return chips
          }
        })
        return 'done'
      }`);

      const subAnalysis = result.subprocesses[0].analysis;
      assert.ok(subAnalysis, 'Subprocess should have analysis result');
      assert.ok(subAnalysis.variables.has('chips'), 'Should track subprocess variables');
    });

    it('detects subprocess handler with using exports', () => {
      const result = analyze(`async () => {
        const playerSeat = createSubProcess({
          name: 'player',
          path: '/:playerId',
          async handler(playerId: string) {
            using exports = {
              chips: 1000,
              isMyTurn: false,
            }
            return 'done'
          }
        })
        return 'done'
      }`);

      const subExports = result.subprocesses[0].analysis.exports;
      assert.ok(subExports, 'Subprocess should detect exports');
      assert.strictEqual(subExports.fields.length, 2);
      assert.strictEqual(subExports.fields[0].name, 'chips');
      assert.strictEqual(subExports.fields[1].name, 'isMyTurn');
    });

    it('tracks subprocess variable in parent scope', () => {
      const result = analyze(`async () => {
        const playerSeat = createSubProcess({
          name: 'player',
          path: '/:playerId',
          async handler(playerId: string) {
            return 'done'
          }
        })
        return 'done'
      }`);

      const varInfo = result.variables.get('playerSeat');
      assert.ok(varInfo, 'Should track playerSeat variable');
      assert.strictEqual(varInfo.isSerializable, false);
    });
  });

  describe('spawn', () => {
    it('emits SUBPROCESS_SPAWN opcode at call site', () => {
      const result = analyze(`async () => {
        const playerSeat = createSubProcess({
          name: 'player',
          path: '/:playerId',
          async handler(playerId: string) {
            return 'done'
          }
        })
        const alice = await playerSeat('alice')
        return 'done'
      }`);

      const spawnOps = findOpcodes(result.opcodes, 'SUBPROCESS_SPAWN');
      assert.strictEqual(spawnOps.length, 1, 'Should emit SUBPROCESS_SPAWN');
      const spawn = spawnOps[0] as Extract<Opcode, { op: 'SUBPROCESS_SPAWN' }>;
      assert.strictEqual(spawn.name, 'player');
      assert.strictEqual(spawn.storeVar, 'alice');
    });

    it('handles multiple subprocess spawns', () => {
      const result = analyze(`async () => {
        const playerSeat = createSubProcess({
          name: 'player',
          path: '/:playerId',
          async handler(playerId: string) {
            return 'done'
          }
        })
        const alice = await playerSeat('alice')
        const bob = await playerSeat('bob')
        return 'done'
      }`);

      const spawnOps = findOpcodes(result.opcodes, 'SUBPROCESS_SPAWN');
      assert.strictEqual(spawnOps.length, 2, 'Should emit 2 SUBPROCESS_SPAWN');
    });
  });

  describe('multiple subprocesses', () => {
    it('detects multiple createSubProcess declarations', () => {
      const result = analyze(`async () => {
        const playerSeat = createSubProcess({
          name: 'player',
          path: '/:playerId',
          async handler(playerId: string) {
            return 'done'
          }
        })
        const dealerSeat = createSubProcess({
          name: 'dealer',
          path: '/dealer',
          async handler() {
            return 'done'
          }
        })
        return 'done'
      }`);

      assert.strictEqual(result.subprocesses.length, 2);
      assert.strictEqual(result.subprocesses[0].name, 'player');
      assert.strictEqual(result.subprocesses[1].name, 'dealer');
    });
  });
});
