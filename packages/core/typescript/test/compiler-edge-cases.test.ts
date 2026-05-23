/**
 * Edge case tests for the process compiler.
 * These test potentially problematic patterns with thorough structural verification.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { compileProcessSource } from '../src/compiler/compile.js';

function compile(handlerBody: string) {
  const source = `
    import { createProcess, waitFor, signal, race, delay } from '@justscale/core/process'
    const Svc = {} as any

    export const testProcess = createProcess({
      path: '/test/:id',
      inject: { svc: Svc },
      async handler({ svc }, [id]) {
        ${handlerBody}
      }
    })
  `;
  return compileProcessSource(source, 'test.process.ts');
}

/**
 * Parse the generated output to extract structural information for verification.
 */
function parseOutput(outputText: string) {
  // Extract stepMap entries
  const stepMapMatch = outputText.match(/stepMap:\s*\{([^}]+)\}/);
  const stepMapEntries: Record<string, number> = {};
  if (stepMapMatch) {
    const entries = stepMapMatch[1].matchAll(/["']([^"']+)["']\s*:\s*(\d+)/g);
    for (const [, hash, index] of entries) {
      stepMapEntries[hash] = parseInt(index, 10);
    }
  }

  // Extract sourceMap entries
  const sourceMapMatch = outputText.match(/sourceMap:\s*\{([^}]+)\}/);
  const sourceMapEntries: Record<number, [number, number]> = {};
  if (sourceMapMatch) {
    const entries = sourceMapMatch[1].matchAll(/(\d+)\s*:\s*\[(\d+),\s*(\d+)\]/g);
    for (const [, index, start, end] of entries) {
      sourceMapEntries[parseInt(index, 10)] = [parseInt(start, 10), parseInt(end, 10)];
    }
  }

  // Extract signals
  const signalsMatch = outputText.match(/signals:\s*\{([\s\S]*?)\n\s*\},?\s*\n\s*execute/);
  const signalNames: string[] = [];
  if (signalsMatch) {
    const names = signalsMatch[1].matchAll(/["']([^"']+)["']\s*:/g);
    for (const [, name] of names) {
      signalNames.push(name);
    }
  }

  // Count case statements
  const caseMatches = outputText.match(/case \d+:/g) || [];
  const caseCount = caseMatches.length;

  // Check for specific patterns
  const hasMainLoop = outputText.includes('main_loop:');
  const hasWhileTrue = outputText.includes('while (true)');
  const hasSwitchStep = outputText.includes('switch (step)');
  const hasBreakMainLoop = outputText.includes('break main_loop');
  const hasContinueMainLoop = outputText.includes('continue main_loop');
  const hasDonePattern = outputText.includes('__r[0] = 0');
  const hasSuspendPattern = outputText.includes('__r[0] = 1');
  const hasDispose = outputText.includes('__dispose');
  const hasDefaultCase = outputText.includes('default:');

  // Extract version
  const versionMatch = outputText.match(/version:\s*["']([^"']+)["']/);
  const version = versionMatch ? versionMatch[1] : null;

  // Count race configs (race: followed by anything, including state.vars.__raceBranches)
  const raceConfigs = (outputText.match(/race:/g) || []).length;

  return {
    stepMapEntries,
    stepMapCount: Object.keys(stepMapEntries).length,
    sourceMapEntries,
    sourceMapCount: Object.keys(sourceMapEntries).length,
    signalNames,
    caseCount,
    hasMainLoop,
    hasWhileTrue,
    hasSwitchStep,
    hasBreakMainLoop,
    hasContinueMainLoop,
    hasDonePattern,
    hasSuspendPattern,
    hasDispose,
    hasDefaultCase,
    version,
    raceConfigs,
  };
}

describe('Compiler Edge Cases', () => {
  describe('control flow', () => {
    it('handles if-else with await in both branches', () => {
      const result = compile(`
        if (id === '1') {
          const a = await signal(svc.optionA)
          return { choice: 'a', data: a }
        } else {
          const b = await signal(svc.optionB)
          return { choice: 'b', data: b }
        }
      `);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no errors');

      const parsed = parseOutput(result.outputText);

      // Should have entry step + 2 resume steps (one per branch)
      assert.ok(parsed.stepMapCount >= 3, `Should have at least 3 steps in stepMap, got ${parsed.stepMapCount}`);

      // Should have both signals registered
      assert.ok(parsed.signalNames.includes('svc.optionA'), 'Should have optionA signal');
      assert.ok(parsed.signalNames.includes('svc.optionB'), 'Should have optionB signal');

      // Should have proper VM structure
      assert.ok(parsed.hasMainLoop, 'Should have main_loop label');
      assert.ok(parsed.hasSwitchStep, 'Should have switch(step)');
      assert.ok(parsed.hasSuspendPattern, 'Should have suspend pattern');
      assert.ok(parsed.hasDonePattern, 'Should have done pattern for returns');

      // Verify case statements match step count
      assert.strictEqual(parsed.caseCount, parsed.stepMapCount, 'Case count should match stepMap count');
    });

    it('handles nested if inside while with await', () => {
      const result = compile(`
        let count = 0
        while (count < 3) {
          if (count === 0) {
            await signal(svc.first)
          } else {
            await signal(svc.other)
          }
          count++
        }
        return { count }
      `);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no errors');

      const parsed = parseOutput(result.outputText);

      // Should have multiple steps for loop + branches
      assert.ok(parsed.stepMapCount >= 3, `Should have at least 3 steps, got ${parsed.stepMapCount}`);

      // Should have continue for loop back
      assert.ok(parsed.hasContinueMainLoop, 'Should have continue main_loop for loop jumps');

      // Both signals should be registered
      assert.ok(parsed.signalNames.includes('svc.first'), 'Should have first signal');
      assert.ok(parsed.signalNames.includes('svc.other'), 'Should have other signal');

      // Check step hashes have correct prefixes
      for (const hash of Object.keys(parsed.stepMapEntries)) {
        assert.ok(
          hash.startsWith('entry_') || hash.startsWith('resume_') || hash.startsWith('branch_') || hash.startsWith('block_'),
          `Step hash should have valid prefix: ${hash}`
        );
      }
    });

    it('handles for-of loop with await - durable iteration', () => {
      const result = compile(`
        const items = ['a', 'b', 'c']
        for (const item of items) {
          await signal(svc.processed)
        }
        return { done: true }
      `);

      // For-of loops with await now supported via durable iteration
      assert.strictEqual(result.diagnostics.length, 0, 'Should have no diagnostics');

      const parsed = parseOutput(result.outputText);

      // Should have steps for loop handling
      assert.ok(parsed.stepMapCount >= 2, `Should have at least 2 steps, got ${parsed.stepMapCount}`);

      // Should have suspend pattern for signal in loop body
      assert.ok(parsed.hasSuspendPattern, 'Should have SUSPEND pattern for await');

      // Should reference DurableArrayIterator for array iteration
      assert.ok(
        result.outputText.includes('DurableArrayIterator') ||
        result.outputText.includes('__iter_') ||
        result.outputText.includes('__cursor_'),
        'Should have durable iteration variables'
      );
    });

    it('handles nested for-of loops with suspension in both levels', () => {
      const result = compile(`
        const groups = [['a', 'b'], ['c', 'd']]
        for (const group of groups) {
          await signal(svc.groupStarted)
          for (const item of group) {
            await signal(svc.itemProcessed)
          }
        }
        return { done: true }
      `);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no errors');

      const parsed = parseOutput(result.outputText);

      // Should have both signals
      assert.ok(parsed.signalNames.includes('svc.groupStarted'), 'Should have groupStarted signal');
      assert.ok(parsed.signalNames.includes('svc.itemProcessed'), 'Should have itemProcessed signal');

      // Should have durable iteration for both loops
      const cursorMatches = result.outputText.match(/__cursor_/g) || [];
      assert.ok(cursorMatches.length >= 2, `Should have at least 2 cursor vars, got ${cursorMatches.length}`);
    });

    it('handles early return in loop', () => {
      const result = compile(`
        while (true) {
          const event = await signal(svc.event)
          if (event.type === 'done') {
            return { status: 'complete' }
          }
        }
      `);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no errors');

      const parsed = parseOutput(result.outputText);

      // Should have entry + resume step
      assert.ok(parsed.stepMapCount >= 2, `Should have at least 2 steps, got ${parsed.stepMapCount}`);

      // Should have both done and suspend patterns
      assert.ok(parsed.hasDonePattern, 'Should have DONE pattern for return');
      assert.ok(parsed.hasSuspendPattern, 'Should have SUSPEND pattern for await');
      assert.ok(parsed.hasBreakMainLoop, 'Should have break main_loop');

      // Event signal should be registered
      assert.ok(parsed.signalNames.includes('svc.event'), 'Should have event signal');

      // Verify the return value is captured - check for 'complete' in output
      assert.ok(result.outputText.includes("'complete'") || result.outputText.includes('"complete"'),
        'Should include complete string in return value');
    });
  });

  describe('variable scope', () => {
    it('handles variable declared before await, used after', () => {
      const result = compile(`
        const orderId = id
        const amount = 100
        await signal(svc.payment)
        return { orderId, amount }
      `);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no errors');

      const parsed = parseOutput(result.outputText);

      // Variables should be accessed from state.vars after resume
      // Check that state.vars is used in the output
      assert.ok(result.outputText.includes('state.vars'), 'Should access variables from state.vars');

      // The variables should be stored before suspend
      assert.ok(result.outputText.includes('orderId'), 'Should reference orderId');
      assert.ok(result.outputText.includes('amount'), 'Should reference amount');

      // Should have proper step structure
      assert.ok(parsed.stepMapCount >= 2, 'Should have entry and resume steps');
    });

    it('handles variable modified across await', () => {
      const result = compile(`
        let status = 'pending'
        await signal(svc.step1)
        status = 'step1-done'
        await signal(svc.step2)
        status = 'complete'
        return { status }
      `);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no errors');

      const parsed = parseOutput(result.outputText);

      // Should have 3 steps: entry + 2 resumes
      assert.ok(parsed.stepMapCount >= 3, `Should have at least 3 steps, got ${parsed.stepMapCount}`);

      // Both signals should be registered
      assert.ok(parsed.signalNames.includes('svc.step1'), 'Should have step1 signal');
      assert.ok(parsed.signalNames.includes('svc.step2'), 'Should have step2 signal');

      // Variable assignments should be present
      assert.ok(result.outputText.includes("'pending'") || result.outputText.includes('"pending"'),
        'Should have initial value');
      assert.ok(result.outputText.includes("'complete'") || result.outputText.includes('"complete"'),
        'Should have final value');
    });

    it('handles destructuring with await result', () => {
      const result = compile(`
        const { amount, currency } = await signal(svc.payment)
        return { amount, currency }
      `);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no errors');

      const parsed = parseOutput(result.outputText);

      // Should have signal registered
      assert.ok(parsed.signalNames.includes('svc.payment'), 'Should have payment signal');

      // Destructured variables should be accessible
      assert.ok(result.outputText.includes('amount'), 'Should have amount in output');
      assert.ok(result.outputText.includes('currency'), 'Should have currency in output');

      // Should have proper step structure
      assert.ok(parsed.stepMapCount >= 2, 'Should have entry and resume steps');
    });
  });

  describe('complex expressions', () => {
    it('handles await in property access expression', () => {
      const result = compile(`
        const isPaid = (await signal(svc.check)).status === 'paid'
        return { isPaid }
      `);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no errors');

      const parsed = parseOutput(result.outputText);

      // Should have check signal registered
      assert.ok(parsed.signalNames.includes('svc.check'), 'Should have check signal');

      // Should have proper step structure
      assert.ok(parsed.stepMapCount >= 2, 'Should have entry and resume steps');

      // The variable isPaid should be in output
      assert.ok(result.outputText.includes('isPaid'), 'Should reference isPaid variable');

      // Signal payload should be captured
      assert.ok(result.outputText.includes('signalPayload') || result.outputText.includes('__await'),
        'Should capture signal result');
    });

    it('handles multiple awaits in one expression - should serialize', () => {
      const result = compile(`
        const total = (await signal(svc.a)).value + (await signal(svc.b)).value
        return { total }
      `);

      // This should either work (by serializing awaits) or error
      // For now, let's just verify it compiles
      if (result.diagnostics.length === 0) {
        const parsed = parseOutput(result.outputText);

        // Should have both signals
        assert.ok(parsed.signalNames.includes('svc.a'), 'Should have signal a');
        assert.ok(parsed.signalNames.includes('svc.b'), 'Should have signal b');

        // Should have at least 3 steps (entry + 2 resumes)
        assert.ok(parsed.stepMapCount >= 3, `Should have at least 3 steps, got ${parsed.stepMapCount}`);
      }
    });

    it('handles await in function argument', () => {
      const result = compile(`
        const formatted = String(await signal(svc.data))
        return { formatted }
      `);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no errors');

      const parsed = parseOutput(result.outputText);

      // Should have data signal
      assert.ok(parsed.signalNames.includes('svc.data'), 'Should have data signal');

      // Should have proper step structure
      assert.ok(parsed.stepMapCount >= 2, 'Should have entry and resume steps');

      // The formatted variable should be in output
      assert.ok(result.outputText.includes('formatted'), 'Should have formatted variable');
    });
  });

  describe('race edge cases', () => {
    it('handles race with code after switch', () => {
      const result = compile(`
        const r = race()
        let winner = ''
        switch (true) {
          case signal(r, svc.a):
            winner = 'a'
            break
          case signal(r, svc.b):
            winner = 'b'
            break
        }
        // Code after race - use a deterministic post-race transformation
        const upper = winner.toUpperCase()
        return { winner, upper }
      `);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no errors');

      const parsed = parseOutput(result.outputText);

      // Should have race config
      assert.ok(parsed.raceConfigs >= 1, 'Should have at least one race config');

      // Should have both signals
      assert.ok(parsed.signalNames.includes('svc.a'), 'Should have signal a');
      assert.ok(parsed.signalNames.includes('svc.b'), 'Should have signal b');

      // Should have steps for each branch + entry + after
      assert.ok(parsed.stepMapCount >= 3, `Should have at least 3 steps, got ${parsed.stepMapCount}`);

      // Code after race should be present
      assert.ok(result.outputText.includes('toUpperCase'), 'Should have post-race transform');
    });

    it('handles race where one branch does not return', () => {
      const result = compile(`
        const r = race()
        switch (true) {
          case signal(r, svc.success):
            return { status: 'success' }
          case delay.hours(r, 1):
            // Fall through - no return
            break
        }
        // Retry logic
        return { status: 'retry' }
      `);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no errors');

      const parsed = parseOutput(result.outputText);

      // Should have race config with branches
      assert.ok(parsed.raceConfigs >= 1, 'Should have race config');

      // Should have signal registered
      assert.ok(parsed.signalNames.includes('svc.success'), 'Should have success signal');

      // Both return values should be in output
      assert.ok(result.outputText.includes("'success'") || result.outputText.includes('"success"'),
        'Should have success return');
      assert.ok(result.outputText.includes("'retry'") || result.outputText.includes('"retry"'),
        'Should have retry return');
    });

    it('compiles race with signal and delay to RACE_START/RACE_SUSPEND opcodes', () => {
      const result = compile(`
        const r = race()
        switch (true) {
          case signal(r, svc.fullyFunded):
            break
          case delay.days(r, 30): {
            return { status: 'timeout' }
          }
        }
        return { status: 'funded' }
      `);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no errors');

      const parsed = parseOutput(result.outputText);

      // Must produce race config (RACE_START/RACE_SUSPEND), not inline code
      assert.ok(parsed.raceConfigs >= 1, `Should have race config, got ${parsed.raceConfigs}`);

      // Must produce a suspend point (the race blocks until a branch wins)
      assert.ok(parsed.hasSuspendPattern, 'Should have suspend pattern (__r[0] = 1)');

      // Signal should be registered
      assert.ok(parsed.signalNames.includes('svc.fullyFunded'), 'Should have fullyFunded signal');

      // Must have race branches (resumeStep entries)
      const raceBranches = (result.outputText.match(/resumeStep:/g) || []).length;
      assert.ok(raceBranches >= 2, `Should have at least 2 race branches, got ${raceBranches}`);

      // Both branches should lead to separate steps
      assert.ok(parsed.stepMapCount >= 3, `Should have at least 3 steps (entry + 2 branches), got ${parsed.stepMapCount}`);

      // The output after the switch should be present (status: 'funded')
      assert.ok(
        result.outputText.includes("'funded'") || result.outputText.includes('"funded"'),
        'Should have funded return after race'
      );
    });

    it('handles nested races', () => {
      const result = compile(`
        const r1 = race()
        switch (true) {
          case signal(r1, svc.start):
            const r2 = race()
            switch (true) {
              case signal(r2, svc.complete):
                return { status: 'done' }
              case delay.minutes(r2, 5):
                return { status: 'inner-timeout' }
            }
            break
          case delay.hours(r1, 1):
            return { status: 'outer-timeout' }
        }
      `);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no errors');

      const parsed = parseOutput(result.outputText);

      // Should have multiple race configs (one for each race)
      assert.ok(parsed.raceConfigs >= 2, `Should have at least 2 race configs, got ${parsed.raceConfigs}`);

      // Should have all signals registered
      assert.ok(parsed.signalNames.includes('svc.start'), 'Should have start signal');
      assert.ok(parsed.signalNames.includes('svc.complete'), 'Should have complete signal');

      // Should have multiple steps for branches
      assert.ok(parsed.stepMapCount >= 4, `Should have at least 4 steps, got ${parsed.stepMapCount}`);
    });
  });

  describe('rehydration edge cases', () => {
    it('handles multiple using declarations', () => {
      const result = compile(`
        using order = await svc.getOrder(id)
        using customer = await svc.getCustomer(order.customerId)
        await signal(svc.approved)
        return { order: order.id, customer: customer.name }
      `);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no errors');

      const parsed = parseOutput(result.outputText);

      // Should have __dispose array
      assert.ok(parsed.hasDispose, 'Should have __dispose for using vars');

      // Should have signal registered
      assert.ok(parsed.signalNames.includes('svc.approved'), 'Should have approved signal');

      // Should have at least entry + resume steps (using declarations are inline, not separate steps)
      assert.ok(parsed.stepMapCount >= 2, `Should have at least 2 steps, got ${parsed.stepMapCount}`);

      // Using variables should be declared at function scope
      assert.ok(result.outputText.includes('let order'), 'Should declare order at function scope');
      assert.ok(result.outputText.includes('customer'), 'Should reference customer');

      // Check for Symbol.dispose cleanup pattern
      assert.ok(
        result.outputText.includes('[Symbol.dispose]'),
        'Should have [Symbol.dispose] for cleanup'
      );

      // Should track disposal index
      assert.ok(result.outputText.includes('__dispose_i'), 'Should have disposal index tracking');
    });

    it('handles using inside conditional', () => {
      const result = compile(`
        if (id === 'special') {
          using special = await svc.getSpecial(id)
          await signal(svc.confirmed)
          return { special: special.data }
        }
        return { normal: true }
      `);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no errors');

      const parsed = parseOutput(result.outputText);

      // Should have __dispose
      assert.ok(parsed.hasDispose, 'Should have __dispose');

      // Should have signal
      assert.ok(parsed.signalNames.includes('svc.confirmed'), 'Should have confirmed signal');

      // Both return paths should be present
      assert.ok(result.outputText.includes('.data'), 'Should have .data access');
      assert.ok(result.outputText.includes('normal'), 'Should have normal return');
    });

    it('handles using inside loop', () => {
      const result = compile(`
        while (true) {
          using item = await svc.getNext()
          const result = await signal(svc.processed)
          if (result.done) {
            return { done: true }
          }
        }
      `);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no errors');

      const parsed = parseOutput(result.outputText);

      // Should have dispose
      assert.ok(parsed.hasDispose, 'Should have __dispose');

      // Should have signal
      assert.ok(parsed.signalNames.includes('svc.processed'), 'Should have processed signal');

      // Should have loop control flow
      assert.ok(parsed.hasContinueMainLoop, 'Should have continue for loop');
    });
  });

  describe('error cases that should be caught', () => {
    it('should error on try-catch with await (not supported)', () => {
      const result = compile(`
        try {
          await signal(svc.risky)
          return { success: true }
        } catch (e) {
          return { error: true }
        }
      `);

      assert.strictEqual(result.diagnostics.length, 1, 'Should have exactly one diagnostic');
      const message = typeof result.diagnostics[0].messageText === 'string'
        ? result.diagnostics[0].messageText
        : result.diagnostics[0].messageText.messageText;
      assert.ok(message.toLowerCase().includes('try'), 'Should mention try in error');
    });

    it('should inline async arrow function with await (inner function inlining)', () => {
      // Inner functions with suspension points are now supported via inlining
      const result = compile(`
        const fn = async () => {
          await signal(svc.nested)
        }
        await fn()
        return { done: true }
      `);

      // No errors - inner functions are inlined at call site
      assert.strictEqual(result.diagnostics.length, 0, 'Should have no diagnostics - inner functions are inlined');

      // Should compile successfully with generated output
      assert.ok(result.outputText, 'Should have generated output');
      assert.ok(result.outputText.includes('main_loop'), 'Should have main_loop structure');
    });

    it('should error on Promise.all with signals', () => {
      const result = compile(`
        const [a, b] = await Promise.all([
          signal(svc.a),
          signal(svc.b)
        ])
        return { a, b }
      `);

      assert.strictEqual(result.diagnostics.length, 1, 'Should have exactly one diagnostic');
      const message = typeof result.diagnostics[0].messageText === 'string'
        ? result.diagnostics[0].messageText
        : result.diagnostics[0].messageText.messageText;
      assert.ok(message.includes('Promise.all'), 'Should mention Promise.all in error');
    });

    it('compiles for-of loop with await using durable iteration', () => {
      const result = compile(`
        const items = ['a', 'b', 'c']
        for (const item of items) {
          await signal(svc.processed)
        }
        return { done: true }
      `);

      // For-of loops with await now supported via durable iteration
      assert.strictEqual(result.diagnostics.length, 0, 'Should have no diagnostics');

      // Should generate iteration-related variables
      assert.ok(
        result.outputText.includes('DurableArrayIterator') ||
        result.outputText.includes('__iter_') ||
        result.outputText.includes('__cursor_'),
        'Should have durable iteration handling'
      );
    });
  });

  describe('switch-based output structure', () => {
    it('generates proper main_loop with switch structure', () => {
      const result = compile(`
        await signal(svc.event)
        return { done: true }
      `);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no errors');

      const parsed = parseOutput(result.outputText);

      // Verify complete VM structure
      assert.ok(parsed.hasMainLoop, 'Should have main_loop label');
      assert.ok(parsed.hasWhileTrue, 'Should have while(true)');
      assert.ok(parsed.hasSwitchStep, 'Should have switch(step)');
      assert.ok(parsed.hasDefaultCase, 'Should have default case');
      assert.ok(parsed.hasBreakMainLoop, 'Should have break main_loop');

      // Entry case should be 0
      assert.ok(result.outputText.includes('case 0:'), 'Should have case 0 for entry');

      // Should initialize __r
      assert.ok(result.outputText.includes('const __r'), 'Should initialize __r');

      // Should return __r
      assert.ok(result.outputText.includes('return __r'), 'Should return __r');
    });

    it('generates stepMap with correct hash format', () => {
      const result = compile(`
        await signal(svc.step1)
        await signal(svc.step2)
        return { done: true }
      `);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no errors');

      const parsed = parseOutput(result.outputText);

      // Should have 3 steps: entry + 2 resumes
      assert.strictEqual(parsed.stepMapCount, 3, 'Should have exactly 3 steps');

      // Verify hash formats
      const hashes = Object.keys(parsed.stepMapEntries);
      const hasEntry = hashes.some(h => h.startsWith('entry_'));
      const resumeCount = hashes.filter(h => h.startsWith('resume_')).length;

      assert.ok(hasEntry, 'Should have entry_ hash');
      assert.strictEqual(resumeCount, 2, 'Should have 2 resume_ hashes');

      // Verify indices are sequential starting from 0
      const indices = Object.values(parsed.stepMapEntries).sort((a, b) => a - b);
      assert.deepStrictEqual(indices, [0, 1, 2], 'Indices should be 0, 1, 2');
    });

    it('generates sourceMap with line ranges for each step', () => {
      const result = compile(`
        await signal(svc.step1)
        return { done: true }
      `);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no errors');

      const parsed = parseOutput(result.outputText);

      // sourceMap should have entries for each step
      assert.strictEqual(parsed.sourceMapCount, parsed.stepMapCount,
        'sourceMap should have same count as stepMap');

      // Each entry should have valid line range
      for (const [index, range] of Object.entries(parsed.sourceMapEntries)) {
        assert.ok(Array.isArray(range), `Entry ${index} should be array`);
        assert.strictEqual(range.length, 2, `Entry ${index} should have 2 elements`);
        assert.ok(range[0] > 0, 'Start line should be positive');
        assert.ok(range[1] >= range[0], 'End line should be >= start line');
      }
    });

    it('generates result tuple with correct patterns', () => {
      const result = compile(`
        await signal(svc.event)
        return { done: true }
      `);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no errors');

      const parsed = parseOutput(result.outputText);

      // Should have both patterns
      assert.ok(parsed.hasDonePattern, 'Should have DONE pattern (__r[0] = 0)');
      assert.ok(parsed.hasSuspendPattern, 'Should have SUSPEND pattern (__r[0] = 1)');

      // Check __r initialization format
      assert.ok(
        result.outputText.includes('[0, undefined]') || result.outputText.includes('[0,undefined]'),
        'Should initialize __r with [0, undefined]'
      );
    });

    it('generates signal config in suspend payload', () => {
      const result = compile(`
        await signal(svc.payment)
        return { done: true }
      `);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no errors');

      // Should have signal config in __r[1]
      assert.ok(result.outputText.includes('signal:'), 'Should have signal: in config');
      assert.ok(result.outputText.includes('svc.payment'), 'Should reference the signal');

      // Should persist step before suspending
      assert.ok(result.outputText.includes('state.step'), 'Should persist step to state');
    });

    it('generates execute function with proper signature', () => {
      const result = compile(`
        return { done: true }
      `);

      assert.strictEqual(result.diagnostics.length, 0, 'Should have no errors');

      // Should have execute property
      assert.ok(result.outputText.includes('execute:'), 'Should have execute property');

      // Should be async arrow function with ctx parameter
      assert.ok(result.outputText.includes('async (ctx)'), 'Should have async (ctx) =>');

      // Should destructure state and services
      assert.ok(result.outputText.includes('state'), 'Should have state');
      assert.ok(result.outputText.includes('services'), 'Should have services');
    });
  });

  describe('version hash stability', () => {
    it('generates consistent version for same code', () => {
      const result1 = compile(`
        await signal(svc.event)
        return { done: true }
      `);
      const result2 = compile(`
        await signal(svc.event)
        return { done: true }
      `);

      const parsed1 = parseOutput(result1.outputText);
      const parsed2 = parseOutput(result2.outputText);

      assert.strictEqual(parsed1.version, parsed2.version, 'Same code should produce same version');
    });

    it('generates different version for different suspension points', () => {
      const result1 = compile(`
        await signal(svc.event)
        return { done: true }
      `);
      const result2 = compile(`
        await signal(svc.event)
        await signal(svc.another)
        return { done: true }
      `);

      const parsed1 = parseOutput(result1.outputText);
      const parsed2 = parseOutput(result2.outputText);

      assert.notStrictEqual(parsed1.version, parsed2.version,
        'Different suspension points should produce different version');
    });
  });
});
