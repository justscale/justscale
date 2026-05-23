/**
 * Regression test for the "missing BLOCK body for `const x = await
 * nonPrimitiveCall()`" bug.
 *
 * The analyzer recognised that a `const m = await memberships.findOne(...)`
 * inside a race branch needed a block + STORE fromBlock, but it created the
 * block with an EMPTY statement list. `__blockResult` was therefore never
 * assigned, and the following `state.vars.m = __blockResult` silently
 * stored `undefined`.
 *
 * The fix: the BLOCK body must contain the synthetic assignment
 * `__blockResult = <await expr>` so the call actually runs and its
 * result populates the variable.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import ts from 'typescript';
import { analyzeHandler } from '../src/compiler/analyzer.js';
import {
  buildSteps,
  generateSwitchProcess,
  type SwitchCodeGenInput,
} from '../src/compiler/switch-codegen.js';
import { computeVersionHash } from '../src/compiler/step-hash.js';
import { createHandler, createTypeChecker } from './test-utils.js';

function generate(code: string): string {
  const handler = createHandler(code);
  const typeChecker = createTypeChecker();
  const analysis = analyzeHandler(handler, typeChecker);

  const input: SwitchCodeGenInput = {
    id: 'test',
    path: '/test',
    version: computeVersionHash(analysis),
    injectNode: undefined,
    handler,
    analysis,
  };

  const factory = ts.factory;
  const callExpr = generateSwitchProcess(factory, input);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const sourceFile = ts.createSourceFile('output.ts', '', ts.ScriptTarget.Latest, false);
  return printer.printNode(ts.EmitHint.Expression, callExpr, sourceFile);
}

describe('service-await inside race branch body', () => {
  it('emits `__blockResult = await call()` before `state.vars.x = __blockResult`', () => {
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.messagePosted): {
            const m = await memberships.findOne({ user: r.author });
            if (!m) {
              await deps.signals.postRejected({ reason: 'not_a_member' });
              break;
            }
            await messages.insert({ text: r.text });
            break;
          }
        }
      }
    }`;

    const generated = generate(code);

    // The branch body must contain an assignment to __blockResult that
    // awaits the service call - otherwise `state.vars.m = __blockResult`
    // reads undefined on every inbound signal.
    assert.match(
      generated,
      /__blockResult\s*=\s*await\s+(services\.)?memberships\.findOne/,
      `expected \`__blockResult = await memberships.findOne(...)\` in generated code:\n${generated}`,
    );

    // And the STORE into state.vars.m must follow.
    assert.match(
      generated,
      /state\.vars\.m\s*=\s*__blockResult/,
      `expected \`state.vars.m = __blockResult\` STORE in generated code:\n${generated}`,
    );

    // Sanity check: the order must be "assign __blockResult" BEFORE "read it".
    const assignIdx = generated.search(/__blockResult\s*=\s*await/);
    const readIdx = generated.search(/state\.vars\.m\s*=\s*__blockResult/);
    assert.ok(
      assignIdx >= 0 && readIdx >= 0 && assignIdx < readIdx,
      `\`__blockResult = await ...\` (idx ${assignIdx}) must precede \`state.vars.m = __blockResult\` (idx ${readIdx}):\n${generated}`,
    );
  });

  it('emits the awaited call even when the result is discarded (expression statement)', () => {
    // Bare `await someService.foo()` at the top-level of a handler is
    // a side-effecting call - it must still appear in generated code.
    // Before the fix, it vanished because analyzeAwaitExpression created
    // an empty block.
    const code = `async () => {
      await signal(deps.svc.ready);
      await memberships.touch();
      await signal(deps.svc.done);
    }`;

    const generated = generate(code);

    // The top-level await memberships.touch() must be emitted.
    assert.match(
      generated,
      /await\s+(services\.)?memberships\.touch/,
      `expected \`await memberships.touch(...)\` to appear in generated code:\n${generated}`,
    );
  });

  it('synthesised __blockResult assignment still contributes to the block\'s using-var uses', () => {
    // The awaited call references `found` which is a `using` var. The
    // block that wraps `__blockResult = await memberships.findOne({ room: found })`
    // should record `found` as a dependency so the branch step rehydrates
    // it. We assert this by looking at analyzer-level state: variable
    // `found` must list the block's id in `usedInBlocks`.
    const handler = createHandler(`async () => {
      using found = await room;
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.messagePosted): {
            const m = await memberships.findOne({ room: found });
            if (!m) break;
            await messages.insert({ room: found, text: r.text });
            break;
          }
        }
      }
    }`);

    const analysis = analyzeHandler(handler, createTypeChecker());
    const foundInfo = analysis.variables.get('found');
    assert.ok(foundInfo, 'found variable should be tracked by the analyzer');
    assert.ok(foundInfo!.isUsing, '`found` should be a using var');

    // Find BLOCK opcodes for the branch body. The first one should be
    // the synthesised `__blockResult = await memberships.findOne(...)`
    // - its block must list `found` as a dependency.
    const raceStartIdx = analysis.opcodes.findIndex(op => op.op === 'RACE_START');
    assert.ok(raceStartIdx >= 0, 'expected a RACE_START opcode');

    // First BLOCK after RACE_START's STORE __raceResult. We look for a
    // block whose single statement is the synthesised
    //   __blockResult = await memberships.findOne(...)
    // - no getText() because the synthetic node has no source file.
    let firstServiceBlockId: number | undefined;
    const containsFindOne = (node: ts.Node): boolean => {
      if (ts.isIdentifier(node) && node.text === 'findOne') return true;
      let found = false;
      node.forEachChild(child => {
        if (containsFindOne(child)) found = true;
      });
      return found;
    };
    for (let i = raceStartIdx; i < analysis.opcodes.length; i++) {
      const op = analysis.opcodes[i];
      if (op.op === 'BLOCK') {
        const block = analysis.blocks[op.blockId];
        const hasFindOne = block.statements.some(s => containsFindOne(s));
        if (hasFindOne) {
          firstServiceBlockId = op.blockId;
          break;
        }
      }
    }

    assert.ok(
      firstServiceBlockId !== undefined,
      `expected a BLOCK whose statements contain the findOne() call; opcodes: ${JSON.stringify(analysis.opcodes.map(o => o.op))}`,
    );

    assert.ok(
      foundInfo!.usedInBlocks.includes(firstServiceBlockId!),
      `\`found\` should list block ${firstServiceBlockId} (the findOne service call) in usedInBlocks, got: ${foundInfo!.usedInBlocks}`,
    );
  });
});
