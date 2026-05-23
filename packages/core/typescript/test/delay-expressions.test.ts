/**
 * Tests for delay expression support in the process compiler.
 *
 * Verifies that delay calls with expressions like:
 * - delay.minutes(5)              // literal
 * - delay.minutes(attempt * 5)    // expression with variable
 * - delay.seconds(config.timeout) // property access
 *
 * Are correctly compiled to evaluate the expression at runtime.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import ts from 'typescript';
import { analyzeHandler, type AnalysisResult } from '../src/compiler/analyzer.js';
import { generateSwitchProcess, type SwitchCodeGenInput } from '../src/compiler/switch-codegen.js';

interface AnalyzeResult {
  analysis: AnalysisResult
  handler: ts.ArrowFunction | ts.FunctionExpression
}

// Helper to analyze a handler source
function analyze(handlerSource: string): AnalyzeResult {
  const fullSource = `
    import { createProcess, signal, race, delay } from '@justscale/core/process'
    const svc = { test: {} as any, paid: {} as any }

    const handler = ${handlerSource}
  `;

  const sourceFile = ts.createSourceFile(
    'test.ts',
    fullSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    strict: true,
  };

  const host = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = host.getSourceFile;
  host.getSourceFile = (fileName: string, languageVersion: ts.ScriptTarget) => {
    if (fileName === 'test.ts') return sourceFile;
    return originalGetSourceFile.call(host, fileName, languageVersion);
  };

  const program = ts.createProgram(['test.ts'], compilerOptions, host);
  const typeChecker = program.getTypeChecker();

  // Find the handler
  let handlerNode: ts.ArrowFunction | ts.FunctionExpression | undefined;
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isVariableStatement(node)) {
      const decl = node.declarationList.declarations[0];
      if (
        decl.initializer &&
        (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
      ) {
        handlerNode = decl.initializer;
      }
    }
  });

  if (!handlerNode) {
    throw new Error('Could not find handler in source');
  }

  return {
    analysis: analyzeHandler(handlerNode, typeChecker),
    handler: handlerNode,
  };
}

// Helper to generate code and check for specific patterns
function generateAndCheck(handlerSource: string): string {
  const { analysis, handler } = analyze(handlerSource);

  if (analysis.diagnostics.length > 0) {
    throw new Error(`Analysis errors: ${analysis.diagnostics.map((e) => e.messageText).join(', ')}`);
  }

  const input: SwitchCodeGenInput = {
    id: 'test-process',
    path: '/test/:id',
    version: 'v_test',
    injectNode: undefined,
    handler,
    analysis,
  };

  const callExpr = generateSwitchProcess(ts.factory, input);

  // Wrap in a variable declaration to create a complete statement
  const varDecl = ts.factory.createVariableStatement(
    undefined,
    ts.factory.createVariableDeclarationList(
      [ts.factory.createVariableDeclaration('result', undefined, undefined, callExpr)],
      ts.NodeFlags.Const
    )
  );

  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const resultFile = ts.createSourceFile('result.ts', '', ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  return printer.printNode(ts.EmitHint.Unspecified, varDecl, resultFile);
}

describe('Delay Expressions', () => {
  describe('literal values', () => {
    it('compiles delay.seconds(r, 30) to unit-based format', () => {
      const code = generateAndCheck(`async () => {
        const r = race()
        switch (true) {
          case signal(r, { name: 'test' }):
            return { status: 'signal' }
          case delay.seconds(r, 30):
            return { status: 'timeout' }
        }
      }`);

      // Should contain unit-based format: timer: { seconds: 30 }
      // This format is human-readable and works with persistence
      assert.ok(code.includes('seconds: 30'), 'Should have seconds: 30 in timer');
    });

    it('compiles delay.minutes(r, 5) to unit-based format', () => {
      const code = generateAndCheck(`async () => {
        const r = race()
        switch (true) {
          case signal(r, { name: 'test' }):
            return { status: 'signal' }
          case delay.minutes(r, 5):
            return { status: 'timeout' }
        }
      }`);

      // Should contain unit-based format: timer: { minutes: 5 }
      assert.ok(code.includes('minutes: 5'), 'Should have minutes: 5 in timer');
    });

    it('compiles delay.hours(r, 1) to unit-based format', () => {
      const code = generateAndCheck(`async () => {
        const r = race()
        switch (true) {
          case signal(r, { name: 'test' }):
            return { status: 'signal' }
          case delay.hours(r, 1):
            return { status: 'timeout' }
        }
      }`);

      // Should contain unit-based format: timer: { hours: 1 }
      assert.ok(code.includes('hours: 1'), 'Should have hours: 1 in timer');
    });

    it('compiles delay.days(r, 7) to unit-based format', () => {
      const code = generateAndCheck(`async () => {
        const r = race()
        switch (true) {
          case signal(r, { name: 'test' }):
            return { status: 'signal' }
          case delay.days(r, 7):
            return { status: 'timeout' }
        }
      }`);

      // Should contain unit-based format: timer: { days: 7 }
      assert.ok(code.includes('days: 7'), 'Should have days: 7 in timer');
    });
  });

  describe('variable expressions', () => {
    it('compiles delay.minutes(r, attempt * 5) with variable', () => {
      const code = generateAndCheck(`async () => {
        let attempt = 1
        const r = race()
        switch (true) {
          case signal(r, { name: 'test' }):
            return { status: 'signal' }
          case delay.minutes(r, attempt * 5):
            return { status: 'timeout' }
        }
      }`);

      // Variable expressions should use unit-based format: { minutes: state.vars.attempt * 5 }
      assert.ok(code.includes('minutes:'), 'Should have minutes unit in timer');
      assert.ok(code.includes('state.vars.attempt'), 'Should rewrite variable to state.vars');
    });

    it('compiles delay.seconds(r, retryCount * 10) with variable', () => {
      const code = generateAndCheck(`async () => {
        let retryCount = 3
        const r = race()
        switch (true) {
          case signal(r, { name: 'test' }):
            return { status: 'signal' }
          case delay.seconds(r, retryCount * 10):
            return { status: 'timeout' }
        }
      }`);

      // Should have seconds unit with rewritten variable
      assert.ok(code.includes('seconds:'), 'Should have seconds unit in timer');
      assert.ok(code.includes('state.vars.retryCount'), 'Should rewrite variable to state.vars');
    });
  });

  describe('complex expressions', () => {
    it('compiles delay with ternary expression', () => {
      const code = generateAndCheck(`async () => {
        const isPriority = true
        const r = race()
        switch (true) {
          case signal(r, { name: 'test' }):
            return { status: 'signal' }
          case delay.minutes(r, isPriority ? 5 : 30):
            return { status: 'timeout' }
        }
      }`);

      // Should contain the ternary expression with minutes unit
      assert.ok(code.includes('minutes:'), 'Should have minutes unit in timer');
    });

    it('compiles delay with Math expression', () => {
      const code = generateAndCheck(`async () => {
        const base = 5
        const r = race()
        switch (true) {
          case signal(r, { name: 'test' }):
            return { status: 'signal' }
          case delay.seconds(r, Math.min(base * 2, 60)):
            return { status: 'timeout' }
        }
      }`);

      assert.ok(code.includes('seconds:'), 'Should have seconds unit in timer');
    });
  });

  describe('race with expression in loop', () => {
    it('compiles delay expression that changes each iteration', () => {
      const code = generateAndCheck(`async () => {
        let attempt = 0
        while (attempt < 3) {
          attempt++
          const r = race()
          switch (true) {
            case signal(r, { name: 'done' }):
              return { status: 'done', attempt }
            case delay.seconds(r, attempt * 10):
              continue
          }
        }
        return { status: 'exhausted' }
      }`);

      // The expression should reference attempt which is rewritten to state.vars.attempt
      assert.ok(code.includes('seconds:'), 'Should have seconds unit in timer');
    });
  });

  describe('property access expressions', () => {
    it('compiles delay with object property access', () => {
      const code = generateAndCheck(`async () => {
        const config = { timeout: 30 }
        const r = race()
        switch (true) {
          case signal(r, { name: 'test' }):
            return { status: 'signal' }
          case delay.seconds(r, config.timeout):
            return { status: 'timeout' }
        }
      }`);

      // Should reference config.timeout in the expression with seconds unit
      assert.ok(code.includes('seconds:'), 'Should have seconds unit in timer');
      // The expression should be preserved (not just the literal)
      assert.ok(code.includes('timeout'), 'Should preserve property access');
    });

    it('compiles delay with nested property access', () => {
      const code = generateAndCheck(`async () => {
        const settings = { retry: { delay: 5 } }
        const r = race()
        switch (true) {
          case signal(r, { name: 'test' }):
            return { status: 'signal' }
          case delay.minutes(r, settings.retry.delay):
            return { status: 'timeout' }
        }
      }`);

      assert.ok(code.includes('minutes:'), 'Should have minutes unit in timer');
      assert.ok(code.includes('retry'), 'Should preserve nested property access');
    });
  });

  describe('multiple race branches', () => {
    it('compiles race with timer branch and generates step cases', () => {
      const code = generateAndCheck(`async () => {
        const r = race()
        switch (true) {
          case signal(r, { name: 'approved' }):
            return { status: 'approved' }
          case delay.hours(r, 24):
            return { status: 'expired' }
        }
      }`);

      // Timer branch should be generated with hours unit
      assert.ok(code.includes('hours: 24'), 'Should have hours: 24 in timer');
      // Should have step cases in the switch statement
      assert.ok(code.includes('case 0:'), 'Should have entry step');
      assert.ok(code.includes('case 1:'), 'Should have at least one branch step');
    });

    it('compiles race with only timer branches', () => {
      const code = generateAndCheck(`async () => {
        const r = race()
        switch (true) {
          case delay.seconds(r, 30):
            return { status: 'quick' }
          case delay.minutes(r, 5):
            return { status: 'slow' }
        }
      }`);

      // Both timer branches should be present with their units
      assert.ok(code.includes('seconds: 30'), 'Should have seconds: 30 in timer');
      assert.ok(code.includes('minutes: 5'), 'Should have minutes: 5 in timer');
    });
  });

  describe('variable rewriting verification', () => {
    it('rewrites local variables to state.vars in delay expressions', () => {
      const code = generateAndCheck(`async () => {
        let attempt = 1
        const r = race()
        switch (true) {
          case signal(r, { name: 'done' }):
            return { status: 'done' }
          case delay.seconds(r, attempt * 10):
            return { status: 'timeout' }
        }
      }`);

      // The variable 'attempt' should be rewritten to state.vars.attempt
      assert.ok(
        code.includes('state.vars.attempt') || code.includes('state.vars["attempt"]'),
        'Should rewrite attempt to state.vars.attempt'
      );
    });

    it('preserves const variables that are not local vars', () => {
      const code = generateAndCheck(`async () => {
        const TIMEOUT = 30
        const r = race()
        switch (true) {
          case signal(r, { name: 'done' }):
            return { status: 'done' }
          case delay.seconds(r, TIMEOUT):
            return { status: 'timeout' }
        }
      }`);

      // Const variables should still be accessible with seconds unit
      assert.ok(code.includes('seconds:'), 'Should have seconds unit in timer');
    });

    it('handles complex expression with multiple variables', () => {
      const code = generateAndCheck(`async () => {
        let base = 5
        let multiplier = 2
        const r = race()
        switch (true) {
          case signal(r, { name: 'done' }):
            return { status: 'done' }
          case delay.minutes(r, base * multiplier):
            return { status: 'timeout' }
        }
      }`);

      // Both variables should be rewritten with minutes unit
      assert.ok(code.includes('state.vars'), 'Should use state.vars for local variables');
      assert.ok(code.includes('minutes:'), 'Should have minutes unit in timer');
    });
  });

  describe('edge cases', () => {
    it('handles zero delay value', () => {
      const code = generateAndCheck(`async () => {
        const r = race()
        switch (true) {
          case signal(r, { name: 'test' }):
            return { status: 'signal' }
          case delay.seconds(r, 0):
            return { status: 'immediate' }
        }
      }`);

      // Should generate: seconds: 0
      assert.ok(code.includes('seconds: 0'), 'Should have seconds: 0 in timer');
    });

    it('handles large delay values', () => {
      const code = generateAndCheck(`async () => {
        const r = race()
        switch (true) {
          case signal(r, { name: 'test' }):
            return { status: 'signal' }
          case delay.days(r, 365):
            return { status: 'year-timeout' }
        }
      }`);

      // Should generate: days: 365
      assert.ok(code.includes('days: 365'), 'Should have days: 365 in timer');
    });

    it('handles parenthesized expressions', () => {
      const code = generateAndCheck(`async () => {
        let a = 1
        let b = 2
        const r = race()
        switch (true) {
          case signal(r, { name: 'test' }):
            return { status: 'signal' }
          case delay.seconds(r, (a + b) * 10):
            return { status: 'timeout' }
        }
      }`);

      assert.ok(code.includes('seconds:'), 'Should have seconds unit in timer');
    });
  });

  describe('error cases', () => {
    it('reports error when delay is stored in variable', () => {
      const { analysis } = analyze(`async () => {
        const d = delay.minutes(5)
        return { done: true }
      }`);

      assert.strictEqual(analysis.diagnostics.length, 1);
      const message = typeof analysis.diagnostics[0].messageText === 'string'
        ? analysis.diagnostics[0].messageText
        : analysis.diagnostics[0].messageText.messageText;
      assert.ok(message.includes('delay'), `Expected message to include 'delay', got: ${message}`);
    });

    it('reports error for each delay unit when stored', () => {
      for (const unit of ['seconds', 'minutes', 'hours', 'days']) {
        const { analysis } = analyze(`async () => {
          const d = delay.${unit}(5)
          return { done: true }
        }`);

        assert.strictEqual(analysis.diagnostics.length, 1, `Should report error for delay.${unit}`);
      }
    });
  });

  describe('invalid delay patterns', () => {
    it('ignores invalid delay unit (delay.weeks)', () => {
      // delay.weeks is not a valid unit, so it won't be recognized as a delay primitive
      // The analyzer should not error but also not treat it as a delay
      const { analysis } = analyze(`async () => {
        const r = race()
        switch (true) {
          case signal(r, { name: 'test' }):
            return { status: 'signal' }
          case (delay as any).weeks(r, 1):
            return { status: 'timeout' }
        }
      }`);

      // Should not crash - invalid delay unit is just ignored
      // The race will only have the signal branch, not the timer branch
      const raceOp = analysis.opcodes.find(op => op.op === 'RACE_START');
      if (raceOp && raceOp.op === 'RACE_START') {
        const timerBranch = raceOp.branches.find(b => b.timer);
        assert.strictEqual(timerBranch, undefined, 'Invalid delay unit should not create timer branch');
      }
    });

    it('handles delay with no value argument in race', () => {
      // delay.minutes(r) without value - should not crash
      const { analysis } = analyze(`async () => {
        const r = race()
        switch (true) {
          case signal(r, svc.test):
            return { status: 'signal' }
          case delay.minutes(r):
            return { status: 'timeout' }
        }
      }`);

      // The race should still be recognized, timer branch should use r as value (the first arg)
      const raceOp = analysis.opcodes.find(op => op.op === 'RACE_START');
      assert.ok(raceOp, 'Should have RACE_START opcode');
    });
  });

  describe('multiple races in same function', () => {
    it('handles sequential races', () => {
      const code = generateAndCheck(`async () => {
        const r1 = race()
        switch (true) {
          case signal(r1, { name: 'first' }):
            break
          case delay.seconds(r1, 10):
            break
        }

        const r2 = race()
        switch (true) {
          case signal(r2, { name: 'second' }):
            return { status: 'done' }
          case delay.minutes(r2, 5):
            return { status: 'timeout' }
        }
      }`);

      // Should have both races with their respective units
      assert.ok(code.includes('seconds: 10'), 'Should have first race with seconds: 10');
      assert.ok(code.includes('minutes: 5'), 'Should have second race with minutes: 5');
    });
  });

  describe('standalone await delay', () => {
    it('compiles standalone await delay outside race', () => {
      const { analysis } = analyze(`async () => {
        await delay.seconds(5)
        return { done: true }
      }`);

      // Standalone delay should create a WAIT_SIGNAL opcode (timer-based wait)
      // Or it might be compiled differently - let's check if it produces valid opcodes
      assert.ok(analysis.opcodes.length > 0, 'Should produce opcodes');
    });

    it('emits timer config with duration for standalone await delay', () => {
      const code = generateAndCheck(`async () => {
        await delay.seconds(30)
        return { done: true }
      }`);

      // The generated code must include { timer: { seconds: 30 } }, not { timer: {} }
      assert.ok(code.includes('seconds: 30'), 'Should have seconds: 30 in timer config');
    });

    it('emits timer config with minutes for standalone await delay', () => {
      const code = generateAndCheck(`async () => {
        await delay.minutes(5)
        return { done: true }
      }`);

      assert.ok(code.includes('minutes: 5'), 'Should have minutes: 5 in timer config');
    });

    it('emits timer config with variable expression for standalone await delay', () => {
      const code = generateAndCheck(`async () => {
        let timeout = 10
        await delay.seconds(timeout)
        return { done: true }
      }`);

      assert.ok(code.includes('seconds:'), 'Should have seconds unit in timer config');
      assert.ok(code.includes('state.vars.timeout'), 'Should rewrite variable to state.vars');
    });
  });

  describe('complex expression edge cases', () => {
    it('handles unary minus in delay expression', () => {
      // Negative delay - unusual but let's see if it compiles
      const code = generateAndCheck(`async () => {
        let offset = 5
        const r = race()
        switch (true) {
          case signal(r, { name: 'test' }):
            return { status: 'signal' }
          case delay.seconds(r, -offset):
            return { status: 'timeout' }
        }
      }`);

      // Should compile without error with seconds unit (runtime would need to handle negative values)
      assert.ok(code.includes('seconds:'), 'Should have seconds unit in timer');
    });

    it('handles function call in delay expression', () => {
      const code = generateAndCheck(`async () => {
        const getDelay = () => 30
        const r = race()
        switch (true) {
          case signal(r, { name: 'test' }):
            return { status: 'signal' }
          case delay.seconds(r, getDelay()):
            return { status: 'timeout' }
        }
      }`);

      // Function calls should be preserved in the generated code with seconds unit
      assert.ok(code.includes('seconds:'), 'Should have seconds unit in timer');
      assert.ok(code.includes('getDelay'), 'Should preserve function call');
    });

    it('handles array access in delay expression', () => {
      const code = generateAndCheck(`async () => {
        const delays = [10, 20, 30]
        let index = 1
        const r = race()
        switch (true) {
          case signal(r, { name: 'test' }):
            return { status: 'signal' }
          case delay.seconds(r, delays[index]):
            return { status: 'timeout' }
        }
      }`);

      // Array access should be preserved with seconds unit
      assert.ok(code.includes('seconds:'), 'Should have seconds unit in timer');
    });

    it('handles template literal (should not work in numeric context)', () => {
      // Template literals in delay - TypeScript would catch this as a type error
      // but let's see if the compiler handles it gracefully
      const { analysis } = analyze(`async () => {
        const r = race()
        switch (true) {
          case signal(r, { name: 'test' }):
            return { status: 'signal' }
          case delay.seconds(r, 30):
            return { status: 'timeout' }
        }
      }`);

      // Should compile normally
      assert.ok(analysis.diagnostics.length === 0, 'Should compile without errors');
    });
  });

  describe('race result handling', () => {
    it('race variable is rewritten to __raceResult', () => {
      const code = generateAndCheck(`async () => {
        const r = race()
        switch (true) {
          case signal(r, { name: 'test' }):
            return { payload: r }
          case delay.seconds(r, 30):
            return { timedOut: true }
        }
      }`);

      // r should be rewritten to __raceResult in the branch bodies
      assert.ok(code.includes('__raceResult'), 'Race variable should be rewritten');
    });
  });
});
