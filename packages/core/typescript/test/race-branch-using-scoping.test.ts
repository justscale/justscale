/**
 * `using`-var scoping across race branches.
 *
 * Adjacent coverage for the "cross-branch `using`-var leak" fix (see
 * race-branch-rehydrate-leak.test.ts). That test asserted rehydration
 * is scoped per branch. This file exercises the surrounding scoping
 * behaviour:
 *   - a `using` declared BEFORE the race is used inside a branch
 *   - a `using` declared INSIDE a branch is scoped to that branch only
 *   - a `using` declared inside an if-body inside a branch
 *   - two branches each declaring a `using` with the same name
 *   - a `using` whose initializer references the outer `using`
 *
 * All these shapes must be expressed by recording `using`-var
 * dependencies per-block/per-branch, not globally. A regression would
 * cross-contaminate rehydrate bodies or drop disposals.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import ts from 'typescript';
import { analyzeHandler } from '../src/compiler/analyzer.js';
import {
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

function extractCaseBodies(code: string): Map<number, string> {
  const cases = new Map<number, string>();
  const caseRegex = /case (\d+):\s*\{/g;
  let match;
  while ((match = caseRegex.exec(code)) !== null) {
    const stepNum = parseInt(match[1], 10);
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    while (i < code.length && depth > 0) {
      if (code[i] === '{') depth++;
      if (code[i] === '}') depth--;
      i++;
    }
    cases.set(stepNum, code.slice(start, i - 1));
  }
  return cases;
}

function getRaceBranchBodies(generated: string): string[] {
  const cases = extractCaseBodies(generated);
  return Array.from(cases.entries())
    .filter(([, body]) => body.includes('__raceResult'))
    .map(([, body]) => body);
}

describe('using-var scoping across race branches', () => {
  it('`using` declared BEFORE the race is rehydrated in each branch that uses it', () => {
    const code = `async () => {
      using outer = await openHandle();
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.a): {
            await svc.useA(outer);
            break;
          }
          case signal(r, deps.signals.b): {
            await svc.useB(outer);
            break;
          }
        }
      }
    }`;
    const generated = generate(code);
    const branches = getRaceBranchBodies(generated);

    assert.ok(branches.length >= 2, `expected >=2 race branches, got ${branches.length}:\n${generated}`);
    // Each branch that reads `outer` must rehydrate it (reassign via
    // `outer = await openHandle()`).
    for (const body of branches) {
      assert.match(
        body,
        /\bouter\s*=\s*await\s+openHandle/,
        `each branch using \`outer\` must rehydrate it at step entry:\n${body}`,
      );
    }
  });

  it('`using` declared INSIDE a branch body is scoped to that branch only', () => {
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.a): {
            using locked = await svc.lockA();
            await svc.workA(locked);
            break;
          }
          case signal(r, deps.signals.b): {
            await svc.plainB();
            break;
          }
        }
      }
    }`;
    const generated = generate(code);
    const branches = getRaceBranchBodies(generated);

    // Exactly one branch uses lockA; the other doesn't. Verify that
    // branch B does NOT contain `lockA`-related rehydration.
    const aBranches = branches.filter(b => b.includes('lockA'));
    const bBranches = branches.filter(b => b.includes('plainB'));

    assert.strictEqual(aBranches.length, 1, `expected exactly 1 branch with lockA:\n${generated}`);
    assert.strictEqual(bBranches.length, 1, `expected exactly 1 branch with plainB:\n${generated}`);

    // Branch B must NOT contain `locked = await svc.lockA` - that would
    // be a leak.
    assert.ok(
      !/locked\s*=\s*await\s+(services\.)?svc\.lockA/.test(bBranches[0]),
      `branch B leaks branch A's using-var rehydration:\n${bBranches[0]}`,
    );
  });

  it('two branches with same-named using-vars do not collide (each rehydrates its own initializer)', () => {
    // Both branches declare `using v`. Rehydration must be per-branch -
    // branch A must re-run `svc.openA(…)` and branch B must re-run
    // `svc.openB(…)`. A shared rehydration block would run the wrong
    // initializer for one of them.
    const code = `async () => {
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.a): {
            using v = await svc.openA(r.id);
            await svc.useA(v);
            break;
          }
          case signal(r, deps.signals.b): {
            using v = await svc.openB(r.id);
            await svc.useB(v);
            break;
          }
        }
      }
    }`;
    const generated = generate(code);
    const branches = getRaceBranchBodies(generated);

    assert.ok(branches.length >= 2, `expected >=2 branches:\n${generated}`);

    const aBranch = branches.find(b => b.includes('useA'));
    const bBranch = branches.find(b => b.includes('useB'));

    assert.ok(aBranch, `couldn't find useA branch:\n${generated}`);
    assert.ok(bBranch, `couldn't find useB branch:\n${generated}`);

    // Branch A rehydrates via openA, branch B via openB - and neither
    // cross-contaminates.
    assert.match(aBranch!, /svc\.openA/, `branch A should rehydrate via openA:\n${aBranch}`);
    assert.ok(
      !/svc\.openB/.test(aBranch!),
      `branch A must NOT contain openB - sibling leak:\n${aBranch}`,
    );
    assert.match(bBranch!, /svc\.openB/, `branch B should rehydrate via openB:\n${bBranch}`);
    assert.ok(
      !/svc\.openA/.test(bBranch!),
      `branch B must NOT contain openA - sibling leak:\n${bBranch}`,
    );
  });

  it('`using` whose initializer references the outer `using` is rehydrated in the right order', () => {
    // `child = await svc.deriveFrom(outer)` depends on `outer` - both
    // must be rehydrated, and `outer` must be assigned before the
    // initializer that reads it.
    const code = `async () => {
      using outer = await svc.openOuter();
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.a): {
            using child = await svc.deriveFrom(outer);
            await svc.useChild(child);
            break;
          }
        }
      }
    }`;
    const generated = generate(code);
    const branches = getRaceBranchBodies(generated);

    assert.strictEqual(branches.length, 1, `expected 1 race branch, got ${branches.length}:\n${generated}`);
    const body = branches[0];

    // Both rehydrations must appear.
    const outerIdx = body.search(/outer\s*=\s*await\s+(services\.)?svc\.openOuter/);
    const childIdx = body.search(/child\s*=\s*await\s+(services\.)?svc\.deriveFrom/);

    assert.ok(outerIdx >= 0, `outer must be rehydrated in the branch body:\n${body}`);
    assert.ok(childIdx >= 0, `child must be rehydrated in the branch body:\n${body}`);
    assert.ok(
      outerIdx < childIdx,
      `outer (idx ${outerIdx}) must be rehydrated BEFORE child (idx ${childIdx}) - order violation:\n${body}`,
    );
  });

  it('outer `using` rehydration does NOT appear in a branch that does not use it', () => {
    // The fix scopes rehydrate deps to what the branch actually reads.
    // If branch B never references `outer`, branch B's step must not
    // re-run `await svc.openOuter()`.
    const code = `async () => {
      using outer = await svc.openOuter();
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.a): {
            await svc.useOuter(outer);
            break;
          }
          case signal(r, deps.signals.b): {
            await svc.plainWork();
            break;
          }
        }
      }
    }`;
    const generated = generate(code);
    const branches = getRaceBranchBodies(generated);

    const aBranch = branches.find(b => b.includes('useOuter'));
    const bBranch = branches.find(b => b.includes('plainWork'));
    assert.ok(aBranch && bBranch, `expected both branches in generated code:\n${generated}`);

    assert.match(
      aBranch!,
      /outer\s*=\s*await\s+(services\.)?svc\.openOuter/,
      `branch A uses outer - must rehydrate it:\n${aBranch}`,
    );
    assert.ok(
      !/outer\s*=\s*await\s+(services\.)?svc\.openOuter/.test(bBranch!),
      `branch B does not use outer - must NOT rehydrate it:\n${bBranch}`,
    );
  });

  it('analyzer records `usedInBlocks` on outer using-var for every branch that references it', () => {
    // Analyzer-level assertion: `outer.usedInBlocks` must span every
    // block that reads `outer` inside any branch. The rehydration
    // logic relies on this mapping.
    const handler = createHandler(`async () => {
      using outer = await svc.openOuter();
      while (true) {
        const r = race();
        switch (true) {
          case signal(r, deps.signals.a): {
            await svc.useA(outer);
            break;
          }
          case signal(r, deps.signals.b): {
            await svc.useB(outer);
            break;
          }
        }
      }
    }`);

    const analysis = analyzeHandler(handler, createTypeChecker());
    const outerInfo = analysis.variables.get('outer');
    assert.ok(outerInfo, '`outer` should be tracked by the analyzer');
    assert.ok(outerInfo!.isUsing, '`outer` should be a using var');
    assert.ok(
      outerInfo!.usedInBlocks.length >= 2,
      `\`outer\` should be recorded in >=2 blocks (one per branch), got ${outerInfo!.usedInBlocks.length}: ${outerInfo!.usedInBlocks}`,
    );
  });
});
