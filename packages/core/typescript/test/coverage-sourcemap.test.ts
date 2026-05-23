/**
 * Coverage Source Map Verification Tests
 *
 * Verifies that V8 code coverage can correctly map back to original source lines
 * when running compiled JustScale durable processes.
 *
 * The JustScale compiler transforms process handlers into switch/case state machines.
 * These tests verify:
 * 1. The generated sourceMap property correctly maps step indices to original source lines
 * 2. The TypeScript source map (external or inline) is valid and parseable
 * 3. Race branch steps point to the correct original branch lines
 * 4. Inline source maps from PtsCompiler embed original sources for debugger support
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { compileProcessSource, formatDiagnostics } from '../src/compiler/compile.js';
import { PtsCompiler } from '../src/loader/incremental.js';
import { SourceMapConsumer } from 'source-map';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseOutput } from './test-utils.js';

describe('coverage source map verification', () => {

  describe('internal sourceMap maps steps to original lines', () => {

    it('waitFor step maps to the correct original line', () => {
      // Each line is numbered for easy verification.
      // The handler starts at line 7 (0-indexed from the template string).
      const source = `
import { createProcess, waitFor } from '@justscale/core/process'

const PaymentService = {} as any

export const orderProcess = createProcess({
  path: '/order/:orderId',
  inject: { payments: PaymentService },
  async handler({ payments }, [orderId]) {
    const status = 'pending'
    const payment = await waitFor(payments.received(orderId))
    return { status: 'paid', payment }
  }
})
`;
      // Line numbers (1-indexed):
      // L10: const status = 'pending'
      // L11: const payment = await waitFor(payments.received(orderId))
      // L12: return { status: 'paid', payment }

      const result = compileProcessSource(source, 'order.process.ts', { sourceMap: true });
      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const parsed = parseOutput(result.outputText);

      // Should have entry step (case 0) and resume step (case 1)
      assert.ok(parsed.stepMapCount >= 2, `Expected at least 2 steps, got ${parsed.stepMapCount}`);

      // Entry step (index 0) should cover original lines that include the waitFor line
      const entryRange = parsed.sourceMapEntries[0];
      assert.ok(entryRange, 'Entry step should have sourceMap entry');
      assert.ok(entryRange[0] >= 9 && entryRange[0] <= 11,
        `Entry step start should be near line 10 (const status), got ${entryRange[0]}`);
      assert.ok(entryRange[1] >= 11,
        `Entry step end should include the waitFor line (11), got ${entryRange[1]}`);

      // Resume step (index 1) should cover lines after the waitFor
      const resumeRange = parsed.sourceMapEntries[1];
      assert.ok(resumeRange, 'Resume step should have sourceMap entry');
      assert.ok(resumeRange[0] >= 11,
        `Resume step start should be at or after the waitFor line (11), got ${resumeRange[0]}`);
      assert.ok(resumeRange[1] >= 12,
        `Resume step end should include the return line (12), got ${resumeRange[1]}`);
    });

    it('race branches map to distinct original lines', () => {
      const source = `
import { createProcess, signal, race, delay } from '@justscale/core/process'

const PaymentService = {} as any

export const paymentProcess = createProcess({
  path: '/payment/:orderId',
  inject: { payments: PaymentService },
  async handler({ payments }, [orderId]) {
    const r = race()
    switch (true) {
      case signal(r, payments.received(orderId)):
        return { status: 'paid' }
      case delay.hours(r, 24):
        return { status: 'timeout' }
    }
  }
})
`;
      // Line numbers (1-indexed):
      // L10: const r = race()
      // L11: switch (true) {
      // L12:   case signal(r, payments.received(orderId)):
      // L13:     return { status: 'paid' }
      // L14:   case delay.hours(r, 24):
      // L15:     return { status: 'timeout' }

      const result = compileProcessSource(source, 'payment.process.ts', { sourceMap: true });
      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const parsed = parseOutput(result.outputText);

      // Should have entry step + 2 branch steps
      assert.ok(parsed.stepMapCount >= 3, `Expected at least 3 steps, got ${parsed.stepMapCount}`);

      // Verify branch steps exist
      const hashes = Object.keys(parsed.stepMapEntries);
      const branchHashes = hashes.filter(h => h.startsWith('branch_'));
      assert.ok(branchHashes.length >= 2, `Expected at least 2 branch steps, got ${branchHashes.length}`);

      // Get the two branch step indices
      const branchIndices = branchHashes.map(h => parsed.stepMapEntries[h]).sort((a, b) => a - b);

      // Branch 1 (signal) should map to line 13 (return { status: 'paid' })
      const branch1Range = parsed.sourceMapEntries[branchIndices[0]];
      assert.ok(branch1Range, `Branch step ${branchIndices[0]} should have sourceMap entry`);

      // Branch 2 (delay) should map to line 15 (return { status: 'timeout' })
      const branch2Range = parsed.sourceMapEntries[branchIndices[1]];
      assert.ok(branch2Range, `Branch step ${branchIndices[1]} should have sourceMap entry`);

      // The two branches should map to different original lines
      assert.notDeepStrictEqual(branch1Range, branch2Range,
        'Signal branch and delay branch should map to different source lines');

      // Branch lines should be within the handler
      assert.ok(branch1Range[0] >= 12 && branch1Range[0] <= 14,
        `Signal branch should point near line 13, got ${branch1Range[0]}`);
      assert.ok(branch2Range[0] >= 14 && branch2Range[0] <= 16,
        `Delay branch should point near line 15, got ${branch2Range[0]}`);
    });

    it('multiple sequential waitFor steps map to successive original lines', () => {
      const source = `
import { createProcess, waitFor } from '@justscale/core/process'

const Svc = {} as any

export const multiStep = createProcess({
  path: '/multi/:id',
  inject: { svc: Svc },
  async handler({ svc }, [id]) {
    const a = await waitFor(svc.step1(id))
    const b = await waitFor(svc.step2(id))
    const c = await waitFor(svc.step3(id))
    return { a, b, c }
  }
})
`;
      // L10: const a = await waitFor(svc.step1(id))
      // L11: const b = await waitFor(svc.step2(id))
      // L12: const c = await waitFor(svc.step3(id))
      // L13: return { a, b, c }

      const result = compileProcessSource(source, 'multi.process.ts', { sourceMap: true });
      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const parsed = parseOutput(result.outputText);

      // 4 steps: entry + 3 resume steps
      assert.ok(parsed.stepMapCount >= 4, `Expected at least 4 steps, got ${parsed.stepMapCount}`);

      // At least the entry step should have a sourceMap entry
      assert.ok(parsed.sourceMapCount >= 1,
        `Expected at least 1 sourceMap entry, got ${parsed.sourceMapCount}`);

      // Each sourceMap entry that exists should have valid ranges
      for (const [idx, range] of Object.entries(parsed.sourceMapEntries)) {
        assert.ok(range[0] > 0 && range[1] >= range[0],
          `Step ${idx} range should be valid: [${range[0]}, ${range[1]}]`);
      }

      // The sourceMap ranges that exist should be monotonically non-decreasing
      const entries = Object.entries(parsed.sourceMapEntries)
        .map(([idx, range]) => ({ idx: Number(idx), range }))
        .sort((a, b) => a.idx - b.idx);

      for (let i = 1; i < entries.length; i++) {
        assert.ok(entries[i].range[0] >= entries[i - 1].range[0],
          `Step ${entries[i].idx} start (${entries[i].range[0]}) should be >= step ${entries[i - 1].idx} start (${entries[i - 1].range[0]})`);
      }
    });
  });

  describe('TypeScript source map generation', () => {

    it('external source map is valid v3 with correct sources', () => {
      const source = `
import { createProcess, waitFor } from '@justscale/core/process'

const Svc = {} as any

export const testProcess = createProcess({
  path: '/test/:id',
  inject: { svc: Svc },
  async handler({ svc }, [id]) {
    const result = await waitFor(svc.done(id))
    return result
  }
})
`;
      const result = compileProcessSource(source, 'test.process.ts', { sourceMap: true });
      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      // Should generate an external source map
      assert.ok(result.sourceMapText, 'Should have source map text');

      const sourceMap = JSON.parse(result.sourceMapText!);
      assert.strictEqual(sourceMap.version, 3, 'Should be source map v3');
      assert.ok(Array.isArray(sourceMap.sources), 'Should have sources array');
      assert.ok(sourceMap.sources.includes('test.process.ts'),
        `Sources should include test.process.ts, got: ${sourceMap.sources}`);
      assert.ok(typeof sourceMap.mappings === 'string', 'Should have mappings string');
      assert.ok(sourceMap.mappings.length > 0, 'Mappings should not be empty');

      // Output should reference the source map
      assert.ok(result.outputText.includes('//# sourceMappingURL='),
        'Output should have sourceMappingURL reference');
    });

    it('source map is parseable by SourceMapConsumer', async () => {
      const source = `
import { createProcess, waitFor } from '@justscale/core/process'

const Svc = {} as any

export const testProcess = createProcess({
  path: '/test/:id',
  inject: { svc: Svc },
  async handler({ svc }, [id]) {
    return { done: true }
  }
})
`;
      const result = compileProcessSource(source, 'test.process.ts', { sourceMap: true });
      assert.ok(result.sourceMapText, 'Should have source map text');

      const rawMap = JSON.parse(result.sourceMapText!);
      const consumer = await new SourceMapConsumer(rawMap);

      // Should be able to iterate mappings
      let mappingCount = 0;
      consumer.eachMapping(() => { mappingCount++; });
      assert.ok(mappingCount > 0, `Should have mappings, got ${mappingCount}`);

      // The non-transformed parts (import, const) should still map back
      // The import line in generated output should map to the original import
      const generatedLines = result.outputText.split('\n');
      const importLineIdx = generatedLines.findIndex(l => l.includes('__createProcess'));
      if (importLineIdx >= 0) {
        const orig = consumer.originalPositionFor({ line: importLineIdx + 1, column: 0 });
        // If the mapping exists, source should be our file
        if (orig.source) {
          assert.ok(orig.source.includes('test.process.ts'),
            `Import should map to test.process.ts, got ${orig.source}`);
        }
      }

      consumer.destroy();
    });

    it('generated switch/case code maps back to original handler lines', async () => {
      const source = `
import { createProcess, waitFor } from '@justscale/core/process'

const Svc = {} as any

export const testProcess = createProcess({
  path: '/test/:id',
  inject: { svc: Svc },
  async handler({ svc }, [id]) {
    const result = await waitFor(svc.done(id))
    return result
  }
})
`;
      // Line numbers (1-indexed):
      // L9: async handler({ svc }, [id]) {
      // L10: const result = await waitFor(svc.done(id))
      // L11: return result

      const result = compileProcessSource(source, 'test.process.ts', { sourceMap: true });
      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));
      assert.ok(result.sourceMapText, 'Should have source map text');

      const rawMap = JSON.parse(result.sourceMapText!);
      const consumer = await new SourceMapConsumer(rawMap);
      const lines = result.outputText.split('\n');

      // Helper: find first mapping on a generated line at or after first non-space char
      function mapLine(genLine: number): { line: number | null; source: string | null } {
        const col = (lines[genLine - 1] || '').search(/\S/);
        if (col < 0) return { line: null, source: null };
        let orig = consumer.originalPositionFor({ line: genLine, column: col });
        if (!orig.source) {
          orig = consumer.originalPositionFor({ line: genLine, column: col, bias: SourceMapConsumer.LEAST_UPPER_BOUND });
        }
        return { line: orig.line, source: orig.source };
      }

      // Find key generated lines
      const executeLine = lines.findIndex(l => l.includes('async (ctx)')) + 1;
      const switchLine = lines.findIndex(l => l.includes('switch (step)')) + 1;
      const case0Line = lines.findIndex(l => l.match(/case 0:/)) + 1;
      const case1Line = lines.findIndex(l => l.match(/case 1:/)) + 1;

      // Execute arrow should map to handler line (L9)
      if (executeLine > 0) {
        const m = mapLine(executeLine);
        assert.ok(m.source, 'execute arrow should have source mapping');
        assert.ok(m.line! >= 9 && m.line! <= 10,
          `execute arrow should map to handler (L9-10), got L${m.line}`);
      }

      // Switch statement should map to handler body
      if (switchLine > 0) {
        const m = mapLine(switchLine);
        assert.ok(m.source, 'switch statement should have source mapping');
        assert.ok(m.line! >= 9 && m.line! <= 11,
          `switch should map to handler body (L9-11), got L${m.line}`);
      }

      // Case 0 (entry/waitFor step) should map to the waitFor line (L10)
      if (case0Line > 0) {
        const m = mapLine(case0Line);
        assert.ok(m.source, 'case 0 should have source mapping');
        assert.ok(m.line! >= 10 && m.line! <= 11,
          `case 0 should map to waitFor line (L10-11), got L${m.line}`);
      }

      // Case 1 (resume step) should map to waitFor or return line (L10-11)
      if (case1Line > 0) {
        const m = mapLine(case1Line);
        assert.ok(m.source, 'case 1 should have source mapping');
        assert.ok(m.line! >= 10 && m.line! <= 12,
          `case 1 should map to resume area (L10-12), got L${m.line}`);
      }

      consumer.destroy();
    });
  });

  describe('inline source map via PtsCompiler', () => {
    const TEST_DIR = '/tmp/.justscale-coverage-test';

    function setupTestDir() {
      if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
      mkdirSync(TEST_DIR, { recursive: true });
    }

    function cleanupTestDir() {
      if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    }

    it('inline source map is embedded when sourceMap is enabled', () => {
      setupTestDir();
      try {
        const source = `import { createProcess, waitFor } from '@justscale/core/process'

const Svc = {} as any

export const testProcess = createProcess({
  path: '/test/:id',
  inject: { svc: Svc },
  async handler({ svc }, [id]) {
    const result = await waitFor(svc.done(id))
    return result
  }
})
`;
        const ptsPath = join(TEST_DIR, 'test.process.ts');
        writeFileSync(ptsPath, source);

        const compiler = new PtsCompiler({
          rootDir: TEST_DIR,
          cacheDir: join(TEST_DIR, '.cache'),
          sourceMap: true,
        });

        const result = compiler.compile(ptsPath);

        // Should have inline source map
        assert.ok(result.code.includes('//# sourceMappingURL=data:application/json;base64,'),
          'Compiled code should contain inline source map');

        // Extract and parse the inline source map
        const match = result.code.match(
          /\/\/# sourceMappingURL=data:application\/json;base64,(.+)/
        );
        assert.ok(match, 'Should be able to extract base64 source map');

        const sourceMap = JSON.parse(Buffer.from(match![1], 'base64').toString());
        assert.strictEqual(sourceMap.version, 3, 'Should be source map v3');
        assert.ok(Array.isArray(sourceMap.sources), 'Should have sources array');
        assert.ok(typeof sourceMap.mappings === 'string', 'Should have mappings');
        assert.ok(sourceMap.mappings.length > 0, 'Mappings should not be empty');
      } finally {
        cleanupTestDir();
      }
    });

    it('inline source map embeds original source content', () => {
      setupTestDir();
      try {
        const source = `import { createProcess, waitFor } from '@justscale/core/process'

const Svc = {} as any

export const testProcess = createProcess({
  path: '/test/:id',
  inject: { svc: Svc },
  async handler({ svc }, [id]) {
    return { done: true }
  }
})
`;
        const ptsPath = join(TEST_DIR, 'inline-sources.process.ts');
        writeFileSync(ptsPath, source);

        const compiler = new PtsCompiler({
          rootDir: TEST_DIR,
          cacheDir: join(TEST_DIR, '.cache'),
          sourceMap: true,
        });

        const result = compiler.compile(ptsPath);

        const match = result.code.match(
          /\/\/# sourceMappingURL=data:application\/json;base64,(.+)/
        );
        assert.ok(match, 'Should extract inline source map');

        const sourceMap = JSON.parse(Buffer.from(match![1], 'base64').toString());

        // inlineSources should embed original TypeScript source
        assert.ok(sourceMap.sourcesContent, 'Should have sourcesContent for debugger support');
        assert.ok(Array.isArray(sourceMap.sourcesContent), 'sourcesContent should be array');
        assert.ok(sourceMap.sourcesContent.length > 0, 'Should have at least one source content');
        assert.ok(sourceMap.sourcesContent[0].includes('createProcess'),
          'Embedded source should contain the original createProcess call');
      } finally {
        cleanupTestDir();
      }
    });

    it('inline source map is parseable by SourceMapConsumer', async () => {
      setupTestDir();
      try {
        const source = `import { createProcess, signal, race, delay } from '@justscale/core/process'

const PaymentService = {} as any

export const paymentProcess = createProcess({
  path: '/payment/:orderId',
  inject: { payments: PaymentService },
  async handler({ payments }, [orderId]) {
    const r = race()
    switch (true) {
      case signal(r, payments.received(orderId)):
        return { status: 'paid' }
      case delay.hours(r, 24):
        return { status: 'timeout' }
    }
  }
})
`;
        const ptsPath = join(TEST_DIR, 'race.process.ts');
        writeFileSync(ptsPath, source);

        const compiler = new PtsCompiler({
          rootDir: TEST_DIR,
          cacheDir: join(TEST_DIR, '.cache'),
          sourceMap: true,
        });

        const result = compiler.compile(ptsPath);

        const match = result.code.match(
          /\/\/# sourceMappingURL=data:application\/json;base64,(.+)/
        );
        assert.ok(match, 'Should extract inline source map');

        const rawMap = JSON.parse(Buffer.from(match![1], 'base64').toString());
        const consumer = await new SourceMapConsumer(rawMap);

        let mappingCount = 0;
        consumer.eachMapping(() => { mappingCount++; });
        assert.ok(mappingCount > 0, `Should have mappings, got ${mappingCount}`);

        consumer.destroy();
      } finally {
        cleanupTestDir();
      }
    });
  });

  describe('coverage simulation via sourceMap property', () => {

    it('step-level coverage correctly identifies covered vs uncovered branches', () => {
      const source = `
import { createProcess, signal, race, delay } from '@justscale/core/process'

const PaymentService = {} as any

export const paymentProcess = createProcess({
  path: '/payment/:orderId',
  inject: { payments: PaymentService },
  async handler({ payments }, [orderId]) {
    const r = race()
    switch (true) {
      case signal(r, payments.received(orderId)):
        return { status: 'paid' }
      case delay.hours(r, 24):
        return { status: 'timeout' }
    }
  }
})
`;
      const result = compileProcessSource(source, 'payment.process.ts', { sourceMap: true });
      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const parsed = parseOutput(result.outputText);

      // Simulate: process runs entry (step 0) then signal branch fires (step 1)
      // The delay branch (step 2) is never executed.
      const executedSteps = new Set([0, 1]); // entry + signal branch
      const allSteps = new Set(Object.values(parsed.stepMapEntries));

      // Find the uncovered step
      const uncoveredSteps = [...allSteps].filter(s => !executedSteps.has(s));
      assert.ok(uncoveredSteps.length > 0, 'Should have at least one uncovered step');

      // The uncovered step should be the delay branch (step 2)
      const delayBranchIndex = uncoveredSteps[0];
      const delayRange = parsed.sourceMapEntries[delayBranchIndex];
      assert.ok(delayRange, `Uncovered step ${delayBranchIndex} should have sourceMap entry`);

      // The uncovered step should map to the delay branch line (around line 15)
      assert.ok(delayRange[0] >= 14,
        `Uncovered delay branch should map to line >= 14, got ${delayRange[0]}`);

      // The covered signal branch should map to an earlier line (around line 13)
      const signalRange = parsed.sourceMapEntries[1]; // branch step 1
      assert.ok(signalRange, 'Covered signal branch should have sourceMap entry');
      assert.ok(signalRange[0] < delayRange[0],
        `Signal branch line (${signalRange[0]}) should be before delay branch line (${delayRange[0]})`);
    });

    it('sourceMap + stepMap enables hash-to-line lookup for persisted processes', () => {
      const source = `
import { createProcess, waitFor } from '@justscale/core/process'

const Svc = {} as any

export const testProcess = createProcess({
  path: '/test/:id',
  inject: { svc: Svc },
  async handler({ svc }, [id]) {
    const a = await waitFor(svc.step1(id))
    const b = await waitFor(svc.step2(id))
    return { a, b }
  }
})
`;
      const result = compileProcessSource(source, 'test.process.ts', { sourceMap: true });
      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const parsed = parseOutput(result.outputText);

      // stepMap should have entries
      assert.ok(parsed.stepMapCount >= 3, `Expected at least 3 steps, got ${parsed.stepMapCount}`);

      // For steps that have sourceMap entries, verify the lookup chain works:
      // hash -> stepMap -> index -> sourceMap -> [startLine, endLine]
      for (const [hash, index] of Object.entries(parsed.stepMapEntries)) {
        const range = parsed.sourceMapEntries[index];
        if (range) {
          assert.ok(range[0] > 0, `Line should be positive for hash "${hash}"`);
          assert.ok(range[1] >= range[0], `End >= start for hash "${hash}"`);
        }
      }

      // At least the entry step should have a sourceMap entry
      const entryHash = Object.keys(parsed.stepMapEntries).find(h => h.startsWith('entry_'));
      assert.ok(entryHash, 'Should have an entry hash');
      const entryIndex = parsed.stepMapEntries[entryHash!];
      const entryRange = parsed.sourceMapEntries[entryIndex];
      assert.ok(entryRange, 'Entry step should have sourceMap range');
      assert.ok(entryRange[0] > 0, 'Entry step line should be positive');

      // For resume steps that have sourceMap entries, they should be non-decreasing
      const resumeHashes = Object.keys(parsed.stepMapEntries).filter(h => h.startsWith('resume_'));
      assert.ok(resumeHashes.length >= 2, `Expected at least 2 resume hashes, got ${resumeHashes.length}`);

      const resumeWithRanges = resumeHashes
        .map(h => ({ hash: h, index: parsed.stepMapEntries[h], range: parsed.sourceMapEntries[parsed.stepMapEntries[h]] }))
        .filter(r => r.range !== undefined)
        .sort((a, b) => a.index - b.index);

      for (let i = 1; i < resumeWithRanges.length; i++) {
        assert.ok(resumeWithRanges[i].range![0] >= resumeWithRanges[i - 1].range![0],
          'Resume step lines should be non-decreasing');
      }
    });
  });

  describe('no source map when disabled', () => {
    it('omits source map text when sourceMap option is false', () => {
      const source = `
import { createProcess, waitFor } from '@justscale/core/process'

const Svc = {} as any

export const testProcess = createProcess({
  path: '/test/:id',
  inject: { svc: Svc },
  async handler({ svc }, [id]) {
    return { done: true }
  }
})
`;
      const result = compileProcessSource(source, 'test.process.ts', { sourceMap: false });
      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));
      assert.ok(!result.sourceMapText, 'Should not have source map text when disabled');
    });

    it('still generates internal sourceMap property even without TS source maps', () => {
      const source = `
import { createProcess, waitFor } from '@justscale/core/process'

const Svc = {} as any

export const testProcess = createProcess({
  path: '/test/:id',
  inject: { svc: Svc },
  async handler({ svc }, [id]) {
    const result = await waitFor(svc.done(id))
    return result
  }
})
`;
      // Compile WITHOUT source maps
      const result = compileProcessSource(source, 'test.process.ts', { sourceMap: false });
      assert.strictEqual(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics));

      const parsed = parseOutput(result.outputText);

      // The internal sourceMap property is always generated (it's part of the process definition)
      assert.ok(parsed.sourceMapCount > 0,
        'Internal sourceMap property should be present even without TS source maps');
      assert.ok(parsed.stepMapCount > 0, 'stepMap should be present');
      assert.strictEqual(parsed.sourceMapCount, parsed.stepMapCount,
        'sourceMap and stepMap counts should match');
    });
  });
});
