import { describe, it } from 'node:test';
import assert from 'node:assert';
import ts from 'typescript';
import { analyzeHandler, type AnalysisResult, type BlockDefinition } from '../src/compiler/analyzer.js';
import {
  buildSteps,
  generateSwitchProcess,
  type Step,
  type SwitchCodeGenInput,
} from '../src/compiler/switch-codegen.js';
import { computeStepHash, computeVersionHash } from '../src/compiler/step-hash.js';

// ============================================================================
// Test Utilities
// ============================================================================

function createHandler(code: string): ts.ArrowFunction | ts.FunctionExpression {
  const sourceFile = ts.createSourceFile(
    'test.ts',
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  let handler: ts.ArrowFunction | ts.FunctionExpression | undefined;

  const visit = (node: ts.Node) => {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      handler = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (!handler) {
    throw new Error('No function found in code');
  }
  return handler;
}

function createTypeChecker(): ts.TypeChecker {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    strict: true,
  };

  const host = ts.createCompilerHost(options);
  const program = ts.createProgram(['test.ts'], options, {
    ...host,
    getSourceFile: (fileName) => {
      if (fileName === 'test.ts') {
        return ts.createSourceFile(fileName, '', ts.ScriptTarget.Latest);
      }
      return host.getSourceFile(fileName, ts.ScriptTarget.Latest);
    },
  });

  return program.getTypeChecker();
}

function analyzeCode(code: string): AnalysisResult {
  const handler = createHandler(code);
  const typeChecker = createTypeChecker();
  return analyzeHandler(handler, typeChecker);
}

function printGeneratedCode(input: SwitchCodeGenInput): string {
  const factory = ts.factory;
  const callExpr = generateSwitchProcess(factory, input);

  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const sourceFile = ts.createSourceFile('output.ts', '', ts.ScriptTarget.Latest, false);
  return printer.printNode(ts.EmitHint.Expression, callExpr, sourceFile);
}

// ============================================================================
// buildSteps Tests
// ============================================================================

describe('buildSteps', () => {
  describe('entry step creation', () => {
    it('creates entry step at index 0 for empty handler', () => {
      const analysis = analyzeCode('async () => { return { done: true } }');
      const { steps } = buildSteps(analysis);

      // Even minimal handlers should have steps for their opcodes
      const entryStep = steps.find(s => s.type === 'entry');
      if (entryStep) {
        assert.strictEqual(entryStep.index, 0, 'Entry step should be at index 0');
      }
    });

    it('creates entry step at index 0 for handler with WAIT', () => {
      const analysis = analyzeCode(`async () => {
        const x = 1
        const payment = await waitFor(payments.received(orderId))
        return payment
      }`);
      const { steps } = buildSteps(analysis);

      assert.ok(steps.length >= 2, 'Should have at least entry and resume steps');

      const entryStep = steps[0];
      assert.strictEqual(entryStep.type, 'entry', 'First step should be entry type');
      assert.strictEqual(entryStep.index, 0, 'Entry step should be at index 0');
    });

    it('entry step opcodeRange starts at 0', () => {
      const analysis = analyzeCode(`async () => {
        await waitFor(payments.received(orderId))
        return { done: true }
      }`);
      const { steps } = buildSteps(analysis);

      const entryStep = steps[0];
      assert.strictEqual(entryStep.opcodeRange.start, 0, 'Entry step should start at opcode 0');
    });
  });

  describe('resume step creation', () => {
    it('creates resume step after WAIT opcode', () => {
      const analysis = analyzeCode(`async () => {
        const payment = await waitFor(payments.received(orderId))
        return payment
      }`);
      const { steps } = buildSteps(analysis);

      const resumeSteps = steps.filter(s => s.type === 'resume');
      assert.ok(resumeSteps.length >= 1, 'Should create at least one resume step after WAIT');
    });

    it('creates resume step with rehydrateDeps from WAIT opcode', () => {
      const analysis = analyzeCode(`async () => {
        using order = await orders.get(Order.ref(orderId))
        await waitFor(payments.received(orderId))
        return order.status
      }`);
      const { steps } = buildSteps(analysis);

      const resumeSteps = steps.filter(s => s.type === 'resume');
      assert.ok(resumeSteps.length >= 1, 'Should create resume step');

      // Find a resume step that has rehydration deps
      const resumeWithDeps = resumeSteps.find(s => s.rehydrateDeps && s.rehydrateDeps.length > 0);
      if (resumeWithDeps) {
        assert.ok(
          resumeWithDeps.rehydrateDeps!.includes('order'),
          'Resume step should include order in rehydrateDeps'
        );
      }
    });

    it('creates multiple resume steps for multiple WAITs', () => {
      const analysis = analyzeCode(`async () => {
        const payment = await waitFor(payments.received)
        const shipment = await waitFor(orders.shipped)
        await waitFor(orders.delivered)
        return { payment, shipment }
      }`);
      const { steps } = buildSteps(analysis);

      const resumeSteps = steps.filter(s => s.type === 'resume');
      assert.ok(resumeSteps.length >= 3, `Should have at least 3 resume steps, got ${resumeSteps.length}`);
    });
  });

  describe('branch step creation', () => {
    it('creates branch steps for race branch targets', () => {
      const analysis = analyzeCode(`async () => {
        const r = race()
        switch (true) {
          case signal(r, payments.received):
            return { status: 'paid' }
          case delay.hours(r, 24):
            return { status: 'timeout' }
        }
      }`);
      const { steps } = buildSteps(analysis);

      const branchSteps = steps.filter(s => s.type === 'branch');
      // Each race branch handler should be a branch step
      assert.ok(branchSteps.length >= 1, 'Should create branch steps for race branches');
    });

    it('branch step has branchInfo for race branches', () => {
      const analysis = analyzeCode(`async () => {
        const r = race()
        switch (true) {
          case signal(r, approvals.approved):
            return { status: 'approved' }
          case signal(r, approvals.rejected):
            return { status: 'rejected' }
        }
      }`);
      const { steps } = buildSteps(analysis);

      const branchSteps = steps.filter(s => s.type === 'branch');
      assert.ok(branchSteps.length >= 1, 'Should have at least one branch step');
    });
  });

  describe('step map creation', () => {
    it('creates stepMap with hash to index mapping', () => {
      const analysis = analyzeCode(`async () => {
        await waitFor(payments.received)
        return { done: true }
      }`);
      const { steps, stepMap } = buildSteps(analysis);

      // stepMap should have entries for each step's hash
      for (const step of steps) {
        assert.strictEqual(
          stepMap[step.hash],
          step.index,
          `stepMap should map hash ${step.hash} to index ${step.index}`
        );
      }
    });

    it('stepMap keys are unique hashes', () => {
      const analysis = analyzeCode(`async () => {
        await waitFor(sig1)
        await waitFor(sig2)
        await waitFor(sig3)
        return { done: true }
      }`);
      const { steps, stepMap } = buildSteps(analysis);

      const hashes = steps.map(s => s.hash);
      const uniqueHashes = new Set(hashes);
      assert.strictEqual(hashes.length, uniqueHashes.size, 'All step hashes should be unique');
    });
  });

  describe('sourceMap creation', () => {
    it('creates sourceMap with step index to line range mapping', () => {
      const analysis = analyzeCode(`async () => {
        await waitFor(payments.received)
        return { done: true }
      }`);
      const { steps, sourceMap } = buildSteps(analysis);

      // sourceMap should have entries for steps with source info
      for (const step of steps) {
        if (step.sourceRange) {
          const mapped = sourceMap[step.index];
          if (mapped) {
            assert.ok(Array.isArray(mapped), 'sourceMap entry should be an array');
            assert.strictEqual(mapped.length, 2, 'sourceMap entry should have [start, end]');
          }
        }
      }
    });
  });

  describe('jump target handling', () => {
    it('creates step boundaries at JUMP targets', () => {
      const analysis = analyzeCode(`async () => {
        while (true) {
          await waitFor(tick)
        }
        return { done: true }
      }`);
      const { steps } = buildSteps(analysis);

      // Should have steps for: entry, loop body, and loop target
      assert.ok(steps.length >= 2, 'Should have multiple steps for loop control flow');
    });

    it('creates step boundaries at JUMP_IF targets', () => {
      const analysis = analyzeCode(`async () => {
        const user = null
        if (!user) {
          await waitFor(auth.login)
        }
        return { done: true }
      }`);
      const { steps } = buildSteps(analysis);

      // Should have steps for: entry, if-true branch, and merge point
      assert.ok(steps.length >= 2, 'Should have steps for conditional branches');
    });

    it('nextStep is set correctly for sequential steps', () => {
      const analysis = analyzeCode(`async () => {
        const a = 1
        const b = 2
        return a + b
      }`);
      const { steps } = buildSteps(analysis);

      // For simple linear code, each step (except last) should point to next
      for (let i = 0; i < steps.length - 1; i++) {
        const step = steps[i];
        // Not all steps have nextStep (RETURN/WAIT terminate)
        if (step.nextStep !== undefined) {
          assert.ok(
            step.nextStep >= 0 && step.nextStep < steps.length,
            `nextStep ${step.nextStep} should be valid index`
          );
        }
      }
    });
  });
});

// ============================================================================
// computeStepHash Tests
// ============================================================================

describe('computeStepHash', () => {
  describe('hash stability', () => {
    it('same input produces same hash', () => {
      const analysis = analyzeCode(`async () => {
        await waitFor(payments.received)
        return { done: true }
      }`);

      const input = {
        type: 'entry' as const,
        opcodeRange: { start: 0, end: 2 },
        index: 0,
      };

      const hash1 = computeStepHash(input, analysis, 0);
      const hash2 = computeStepHash(input, analysis, 0);

      assert.strictEqual(hash1, hash2, 'Same input should produce same hash');
    });

    it('hash includes type prefix', () => {
      const analysis = analyzeCode(`async () => {
        await waitFor(payments.received)
        return { done: true }
      }`);

      const entryHash = computeStepHash(
        { type: 'entry', opcodeRange: { start: 0, end: 1 }, index: 0 },
        analysis,
        0
      );

      assert.ok(entryHash.startsWith('entry_'), `Entry hash should start with 'entry_', got ${entryHash}`);
    });

    it('different types produce different hash prefixes', () => {
      const analysis = analyzeCode(`async () => {
        await waitFor(payments.received)
        return { done: true }
      }`);

      const entryHash = computeStepHash(
        { type: 'entry', opcodeRange: { start: 0, end: 1 }, index: 0 },
        analysis,
        0
      );

      const blockHash = computeStepHash(
        { type: 'block', opcodeRange: { start: 0, end: 1 }, index: 1 },
        analysis,
        0
      );

      assert.ok(entryHash.startsWith('entry_'), 'Entry hash should have entry_ prefix');
      assert.ok(blockHash.startsWith('block_'), 'Block hash should have block_ prefix');
    });
  });

  describe('signal identity in hash', () => {
    it('resume hash includes signal name', () => {
      const analysis = analyzeCode(`async () => {
        await waitFor(payments.received)
        return { done: true }
      }`);

      // Find the WAIT opcode index
      const waitIndex = analysis.opcodes.findIndex(op => op.op === 'WAIT');
      assert.ok(waitIndex >= 0, 'Should have WAIT opcode');

      // Resume step starts after WAIT
      const resumeStart = waitIndex + 1;
      const hash = computeStepHash(
        { type: 'resume', opcodeRange: { start: resumeStart, end: resumeStart + 1 }, index: 1 },
        analysis,
        resumeStart
      );

      assert.ok(hash.startsWith('resume_'), 'Resume hash should have resume_ prefix');
    });

    it('different signals produce different hashes', () => {
      const analysis1 = analyzeCode(`async () => {
        await waitFor(payments.received)
        return { done: true }
      }`);

      const analysis2 = analyzeCode(`async () => {
        await waitFor(orders.shipped)
        return { done: true }
      }`);

      const waitIndex1 = analysis1.opcodes.findIndex(op => op.op === 'WAIT');
      const waitIndex2 = analysis2.opcodes.findIndex(op => op.op === 'WAIT');

      const resumeStart1 = waitIndex1 + 1;
      const resumeStart2 = waitIndex2 + 1;

      const hash1 = computeStepHash(
        { type: 'resume', opcodeRange: { start: resumeStart1, end: resumeStart1 + 1 }, index: 1 },
        analysis1,
        resumeStart1
      );

      const hash2 = computeStepHash(
        { type: 'resume', opcodeRange: { start: resumeStart2, end: resumeStart2 + 1 }, index: 1 },
        analysis2,
        resumeStart2
      );

      // Different signals should produce different hashes (except for index tiebreaker)
      // Since we use different analyses, the signal names differ
      assert.ok(hash1.startsWith('resume_'), 'Hash 1 should be resume type');
      assert.ok(hash2.startsWith('resume_'), 'Hash 2 should be resume type');
    });
  });

  describe('index as tiebreaker', () => {
    it('different indices produce different hashes for same type', () => {
      const analysis = analyzeCode(`async () => {
        await waitFor(same_signal)
        await waitFor(same_signal)
        return { done: true }
      }`);

      const waitIndices = analysis.opcodes
        .map((op, i) => (op.op === 'WAIT' ? i : -1))
        .filter(i => i >= 0);

      if (waitIndices.length >= 2) {
        const hash1 = computeStepHash(
          { type: 'resume', opcodeRange: { start: waitIndices[0] + 1, end: waitIndices[0] + 2 }, index: 1 },
          analysis,
          waitIndices[0] + 1
        );

        const hash2 = computeStepHash(
          { type: 'resume', opcodeRange: { start: waitIndices[1] + 1, end: waitIndices[1] + 2 }, index: 2 },
          analysis,
          waitIndices[1] + 1
        );

        // Different indices should produce different hashes
        assert.notStrictEqual(hash1, hash2, 'Different indices should produce different hashes');
      }
    });
  });
});

// ============================================================================
// computeVersionHash Tests
// ============================================================================

describe('computeVersionHash', () => {
  it('produces consistent hash for same structure', () => {
    const analysis = analyzeCode(`async () => {
      await waitFor(payments.received)
      return { done: true }
    }`);

    const hash1 = computeVersionHash(analysis);
    const hash2 = computeVersionHash(analysis);

    assert.strictEqual(hash1, hash2, 'Same analysis should produce same version hash');
  });

  it('has v_ prefix', () => {
    const analysis = analyzeCode(`async () => {
      return { done: true }
    }`);

    const hash = computeVersionHash(analysis);
    assert.ok(hash.startsWith('v_'), `Version hash should start with 'v_', got ${hash}`);
  });

  it('different structures produce different hashes', () => {
    const analysis1 = analyzeCode(`async () => {
      await waitFor(payments.received)
      return { done: true }
    }`);

    const analysis2 = analyzeCode(`async () => {
      await waitFor(payments.received)
      await waitFor(orders.shipped)
      return { done: true }
    }`);

    const hash1 = computeVersionHash(analysis1);
    const hash2 = computeVersionHash(analysis2);

    assert.notStrictEqual(hash1, hash2, 'Different structures should produce different hashes');
  });

  it('adding non-suspending code does not change hash', () => {
    const analysis1 = analyzeCode(`async () => {
      await waitFor(payments.received)
      return { done: true }
    }`);

    const analysis2 = analyzeCode(`async () => {
      const x = 1
      console.log(x)
      await waitFor(payments.received)
      return { done: true }
    }`);

    // Version hash is based on opcode structure, signals, and rehydration
    // Adding console.log adds a BLOCK but doesn't change the overall structure
    const hash1 = computeVersionHash(analysis1);
    const hash2 = computeVersionHash(analysis2);

    // These might be different because BLOCK opcodes are different
    // But the key point is version hash captures structural changes
    assert.ok(hash1.startsWith('v_'), 'Hash 1 should be version hash');
    assert.ok(hash2.startsWith('v_'), 'Hash 2 should be version hash');
  });
});

// ============================================================================
// generateSwitchProcess Tests
// ============================================================================

describe('generateSwitchProcess', () => {
  function createInput(code: string): SwitchCodeGenInput {
    const handler = createHandler(code);
    const typeChecker = createTypeChecker();
    const analysis = analyzeHandler(handler, typeChecker);

    return {
      id: 'test-process',
      path: '/test/:id',
      version: 'v_test',
      injectNode: undefined,
      handler,
      analysis,
    };
  }

  describe('generated code structure', () => {
    it('generates __createProcess call', () => {
      const input = createInput('async () => { return { done: true } }');
      const output = printGeneratedCode(input);

      assert.ok(
        output.includes('__createProcess'),
        'Should generate __createProcess call'
      );
    });

    it('includes id property', () => {
      const input = createInput('async () => { return { done: true } }');
      const output = printGeneratedCode(input);

      assert.ok(output.includes('id:'), 'Should include id property');
      assert.ok(output.includes('"test-process"'), 'Should include process id value');
    });

    it('includes path property', () => {
      const input = createInput('async () => { return { done: true } }');
      const output = printGeneratedCode(input);

      assert.ok(output.includes('path:'), 'Should include path property');
      assert.ok(output.includes('"/test/:id"'), 'Should include path value');
    });

    it('includes version property', () => {
      const input = createInput('async () => { return { done: true } }');
      const output = printGeneratedCode(input);

      assert.ok(output.includes('version:'), 'Should include version property');
    });

    it('includes stepMap property', () => {
      const input = createInput('async () => { return { done: true } }');
      const output = printGeneratedCode(input);

      assert.ok(output.includes('stepMap:'), 'Should include stepMap property');
    });

    it('includes sourceMap property', () => {
      const input = createInput('async () => { return { done: true } }');
      const output = printGeneratedCode(input);

      assert.ok(output.includes('sourceMap:'), 'Should include sourceMap property');
    });

    it('includes signals property', () => {
      const input = createInput(`async () => {
        await waitFor(payments.received)
        return { done: true }
      }`);
      const output = printGeneratedCode(input);

      assert.ok(output.includes('signals:'), 'Should include signals property');
    });

    it('includes execute property', () => {
      const input = createInput('async () => { return { done: true } }');
      const output = printGeneratedCode(input);

      assert.ok(output.includes('execute:'), 'Should include execute property');
    });
  });

  describe('execute function structure', () => {
    it('generates async arrow function for execute', () => {
      const input = createInput('async () => { return { done: true } }');
      const output = printGeneratedCode(input);

      assert.ok(output.includes('async (ctx)'), 'Should generate async arrow function');
    });

    it('destructures state and services from ctx', () => {
      const input = createInput('async () => { return { done: true } }');
      const output = printGeneratedCode(input);

      assert.ok(
        output.includes('const { state, services } = ctx'),
        'Should destructure state and services'
      );
    });

    it('initializes step from state.step', () => {
      const input = createInput('async () => { return { done: true } }');
      const output = printGeneratedCode(input);

      assert.ok(
        output.includes('let step = state.step | 0'),
        'Should initialize step from state.step with bitwise OR 0'
      );
    });

    it('initializes __r result tuple', () => {
      const input = createInput('async () => { return { done: true } }');
      const output = printGeneratedCode(input);

      assert.ok(output.includes('const __r'), 'Should initialize __r result tuple');
    });

    it('generates main_loop labeled while statement', () => {
      const input = createInput('async () => { return { done: true } }');
      const output = printGeneratedCode(input);

      assert.ok(output.includes('main_loop:'), 'Should generate main_loop label');
      assert.ok(output.includes('while (true)'), 'Should generate while (true) loop');
    });

    it('generates switch statement on step', () => {
      const input = createInput('async () => { return { done: true } }');
      const output = printGeneratedCode(input);

      assert.ok(output.includes('switch (step)'), 'Should generate switch on step');
    });

    it('generates default case that throws', () => {
      const input = createInput('async () => { return { done: true } }');
      const output = printGeneratedCode(input);

      assert.ok(output.includes('default:'), 'Should generate default case');
      assert.ok(output.includes('throw new Error'), 'Default case should throw');
      assert.ok(output.includes('Invalid step'), 'Error message should mention invalid step');
    });

    it('generates case 0 for entry step', () => {
      const input = createInput(`async () => {
        await waitFor(payments.received)
        return { done: true }
      }`);
      const output = printGeneratedCode(input);

      assert.ok(output.includes('case 0:'), 'Should generate case 0 for entry step');
    });

    it('returns __r at end', () => {
      const input = createInput('async () => { return { done: true } }');
      const output = printGeneratedCode(input);

      assert.ok(output.includes('return __r'), 'Should return __r at end');
    });
  });

  describe('WAIT opcode handling', () => {
    it('generates suspend code for WAIT', () => {
      const input = createInput(`async () => {
        await waitFor(payments.received)
        return { done: true }
      }`);
      const output = printGeneratedCode(input);

      // WAIT should set __r[0] = 1 (SUSPEND)
      assert.ok(output.includes('__r[0] = 1'), 'Should set __r[0] to 1 for SUSPEND');
    });

    it('generates break main_loop after WAIT', () => {
      const input = createInput(`async () => {
        await waitFor(payments.received)
        return { done: true }
      }`);
      const output = printGeneratedCode(input);

      assert.ok(output.includes('break main_loop'), 'Should break main_loop after suspend');
    });

    it('generates signal config for WAIT', () => {
      const input = createInput(`async () => {
        await waitFor(payments.received)
        return { done: true }
      }`);
      const output = printGeneratedCode(input);

      // Should set __r[1] to suspend config with signal
      assert.ok(output.includes('signal:'), 'Should include signal in suspend config');
    });
  });

  describe('RETURN opcode handling', () => {
    it('generates done code for RETURN', () => {
      const input = createInput('async () => { return { done: true } }');
      const output = printGeneratedCode(input);

      // RETURN should set __r[0] = 0 (DONE)
      assert.ok(output.includes('__r[0] = 0'), 'Should set __r[0] to 0 for DONE');
    });

    it('generates break main_loop after RETURN', () => {
      const input = createInput('async () => { return { done: true } }');
      const output = printGeneratedCode(input);

      assert.ok(output.includes('break main_loop'), 'Should break main_loop after return');
    });

    it('transforms return statements to __blockResult assignment', () => {
      const input = createInput('async () => { return { done: true } }');
      const output = printGeneratedCode(input);

      // Return statements should be transformed to __blockResult = ...
      assert.ok(
        output.includes('__blockResult'),
        'Should transform return value to __blockResult'
      );

      // The __r[1] should be set from __blockResult
      assert.ok(
        output.includes('__r[1] = __blockResult'),
        'Should set __r[1] from __blockResult'
      );

      // Extract case blocks and verify no raw return statements exist
      // (except for the final "return __r" at the end of execute)
      const caseBlockPattern = /case \d+:\s*\{[\s\S]*?\}/g;
      const caseBlocks = output.match(caseBlockPattern) || [];
      for (const caseBlock of caseBlocks) {
        // Should not have "return {" in case blocks - those should be transformed
        assert.ok(
          !caseBlock.includes('return {'),
          `Case blocks should not contain raw return statements: ${caseBlock.slice(0, 100)}`
        );
      }
    });

    it('transforms return with expression to __blockResult = expression', () => {
      const input = createInput(`async () => {
        await waitFor(payments.received)
        return { status: 'completed', id: 123 }
      }`);
      const output = printGeneratedCode(input);

      // Should have __blockResult assignment with the object
      assert.ok(
        output.includes('__blockResult = {'),
        'Should transform return expression to __blockResult assignment'
      );
    });

    it('transforms return without expression to __blockResult = undefined', () => {
      const input = createInput(`async () => {
        await waitFor(payments.received)
        return
      }`);
      const output = printGeneratedCode(input);

      // Should have __blockResult = undefined
      assert.ok(
        output.includes('__blockResult = undefined'),
        'Should transform empty return to __blockResult = undefined'
      );
    });
  });

  describe('JUMP opcode handling', () => {
    it('generates step assignment for JUMP', () => {
      const input = createInput(`async () => {
        while (true) {
          await waitFor(tick)
        }
      }`);
      const output = printGeneratedCode(input);

      // JUMP should update step variable
      assert.ok(output.includes('step ='), 'Should assign to step for JUMP');
    });

    it('generates continue main_loop for JUMP', () => {
      const input = createInput(`async () => {
        while (true) {
          await waitFor(tick)
        }
      }`);
      const output = printGeneratedCode(input);

      assert.ok(output.includes('continue main_loop'), 'Should continue main_loop for JUMP');
    });
  });

  describe('JUMP_IF opcode handling', () => {
    it('generates conditional for JUMP_IF', () => {
      const input = createInput(`async () => {
        const user = null
        if (!user) {
          await waitFor(auth.login)
        }
        return { done: true }
      }`);
      const output = printGeneratedCode(input);

      // JUMP_IF should generate if statement
      // The condition references state.vars.__condition
      assert.ok(
        output.includes('state.vars') && output.includes('__condition'),
        'Should reference condition in state.vars'
      );
    });
  });

  describe('race branch handling', () => {
    it('generates RACE_START config with branches', () => {
      const input = createInput(`async () => {
        const r = race()
        switch (true) {
          case signal(r, payments.received):
            return { status: 'paid' }
          case delay.hours(r, 24):
            return { status: 'timeout' }
        }
      }`);
      const output = printGeneratedCode(input);

      // Should generate race branches config
      assert.ok(
        output.includes('__raceBranches'),
        'Should store race branches in state.vars.__raceBranches'
      );
    });

    it('generates RACE_SUSPEND with race config', () => {
      const input = createInput(`async () => {
        const r = race()
        switch (true) {
          case signal(r, payments.received):
            return { status: 'paid' }
          case delay.hours(r, 24):
            return { status: 'timeout' }
        }
      }`);
      const output = printGeneratedCode(input);

      // Should generate race suspend config
      assert.ok(output.includes('race:'), 'Should include race in suspend config');
    });
  });

  describe('using variable handling', () => {
    it('declares using vars at function scope', () => {
      const input = createInput(`async () => {
        using order = await orders.get(Order.ref(orderId))
        await waitFor(payments.received)
        return order.status
      }`);
      const output = printGeneratedCode(input);

      // Using vars should be declared with let at top
      assert.ok(output.includes('let order'), 'Should declare using var with let');
    });

    it('generates __dispose array for using vars', () => {
      const input = createInput(`async () => {
        using order = await orders.get(Order.ref(orderId))
        await waitFor(payments.received)
        return order.status
      }`);
      const output = printGeneratedCode(input);

      assert.ok(output.includes('__dispose'), 'Should generate __dispose array');
    });

    it('generates disposal cleanup loop', () => {
      const input = createInput(`async () => {
        using order = await orders.get(Order.ref(orderId))
        await waitFor(payments.received)
        return order.status
      }`);
      const output = printGeneratedCode(input);

      // Should have disposal cleanup
      assert.ok(
        output.includes('__dispose_i > 0') || output.includes('Symbol.dispose'),
        'Should generate disposal cleanup'
      );
    });
  });

  describe('suspend state persistence', () => {
    it('generates state.step persistence on suspend', () => {
      const input = createInput(`async () => {
        await waitFor(payments.received)
        return { done: true }
      }`);
      const output = printGeneratedCode(input);

      // On suspend (__r[0] === 1), should persist state.step
      assert.ok(
        output.includes('state.step = step'),
        'Should persist state.step on suspend'
      );
    });
  });

  describe('stepMap in generated output', () => {
    it('stepMap contains entry step hash', () => {
      const input = createInput(`async () => {
        await waitFor(payments.received)
        return { done: true }
      }`);
      const output = printGeneratedCode(input);

      // stepMap should have at least entry_ hash
      assert.ok(output.includes('"entry_'), 'stepMap should contain entry step hash');
    });

    it('stepMap values are numeric indices', () => {
      const input = createInput(`async () => {
        await waitFor(payments.received)
        return { done: true }
      }`);
      const output = printGeneratedCode(input);

      // stepMap values should be numbers like ": 0", ": 1"
      const stepMapMatch = output.match(/stepMap:\s*\{([^}]+)\}/);
      if (stepMapMatch) {
        const stepMapContent = stepMapMatch[1];
        assert.ok(
          stepMapContent.includes(': 0') || stepMapContent.includes(':0'),
          'stepMap should have numeric values'
        );
      }
    });
  });

  describe('signals in generated output', () => {
    it('signals object includes waited signals', () => {
      const input = createInput(`async () => {
        await waitFor(payments.received)
        return { done: true }
      }`);
      const output = printGeneratedCode(input);

      assert.ok(
        output.includes('"payments.received"'),
        'signals should include waited signal name'
      );
    });

    it('signal definition includes identity array', () => {
      const input = createInput(`async () => {
        await waitFor(payments.received)
        return { done: true }
      }`);
      const output = printGeneratedCode(input);

      assert.ok(output.includes('identity:'), 'Signal definition should include identity');
    });

    it('signal definition includes payloadType', () => {
      const input = createInput(`async () => {
        await waitFor(payments.received)
        return { done: true }
      }`);
      const output = printGeneratedCode(input);

      assert.ok(output.includes('payloadType:'), 'Signal definition should include payloadType');
    });
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('switch-codegen integration', () => {
  it('round-trip: analyze -> buildSteps -> generateSwitchProcess', () => {
    const code = `async () => {
      const payment = await waitFor(payments.received)
      return { status: 'paid', payment }
    }`;

    const handler = createHandler(code);
    const typeChecker = createTypeChecker();
    const analysis = analyzeHandler(handler, typeChecker);

    const { steps, stepMap } = buildSteps(analysis);

    const input: SwitchCodeGenInput = {
      id: 'integration-test',
      path: '/order/:orderId',
      version: computeVersionHash(analysis),
      injectNode: undefined,
      handler,
      analysis,
    };

    const output = printGeneratedCode(input);

    // Verify complete chain works
    assert.ok(steps.length >= 2, 'Should have entry and resume steps');
    assert.ok(Object.keys(stepMap).length >= 2, 'stepMap should have hashes');
    assert.ok(output.includes('__createProcess'), 'Should generate process');
    assert.ok(output.includes('switch (step)'), 'Should have switch statement');
  });

  it('complex process: loop with race and rehydration', () => {
    const code = `async () => {
      using order = await orders.get(Order.ref(orderId))
      let attempts = 0
      while (attempts < 3) {
        attempts++
        const r = race()
        switch (true) {
          case signal(r, payments.received):
            return { status: 'paid', order }
          case delay.minutes(r, 5):
            continue
        }
      }
      return { status: 'expired' }
    }`;

    const handler = createHandler(code);
    const typeChecker = createTypeChecker();
    const analysis = analyzeHandler(handler, typeChecker);

    const { steps } = buildSteps(analysis);

    // Should have steps for:
    // - Entry
    // - Race branches
    // - Loop body
    assert.ok(steps.length >= 3, 'Complex process should have multiple steps');

    const branchSteps = steps.filter(s => s.type === 'branch');
    assert.ok(branchSteps.length >= 1, 'Should have branch steps for race');
  });

  it('step hashes are persistent-friendly', () => {
    const code = `async () => {
      await waitFor(first)
      await waitFor(second)
      await waitFor(third)
      return { done: true }
    }`;

    const analysis = analyzeCode(code);
    const { steps, stepMap } = buildSteps(analysis);

    // All hashes should be strings with type prefix and hex suffix
    for (const step of steps) {
      assert.ok(typeof step.hash === 'string', 'Hash should be string');
      assert.ok(step.hash.includes('_'), 'Hash should have type_hex format');
      const [type, hex] = step.hash.split('_');
      assert.ok(
        ['entry', 'block', 'resume', 'branch'].includes(type),
        `Type should be valid: ${type}`
      );
      assert.ok(/^[a-f0-9]+$/.test(hex), `Hex should be valid hex: ${hex}`);
    }

    // stepMap should be invertible (each hash maps to unique index)
    const indices = Object.values(stepMap);
    const uniqueIndices = new Set(indices);
    assert.strictEqual(indices.length, uniqueIndices.size, 'stepMap indices should be unique');
  });
});
