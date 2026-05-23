/**
 * Tests for PTS Compiler
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { PtsCompiler } from '../src/loader/incremental.js';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

const TEST_DIR = join(import.meta.dirname, '.test-fixtures');
const CACHE_DIR = join(TEST_DIR, '.justscale', 'pts-cache');

describe('PtsCompiler', () => {
  beforeEach(() => {
    // Clean up test fixtures
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  it('should compile a simple .pts file', () => {
    // Create a test .pts file
    const ptsContent = `
import { createProcess, signal, race, delay, minutes } from '@justscale/core/process'

export const testProcess = createProcess({
  path: '/test/:id',
  inject: {},
  async handler({}, [id]) {
    console.log('Processing:', id)
    return { success: true }
  },
})
`;
    const ptsPath = join(TEST_DIR, 'test.process.ts');
    writeFileSync(ptsPath, ptsContent);

    // Create compiler and compile
    const compiler = new PtsCompiler({
      rootDir: TEST_DIR,
      cacheDir: CACHE_DIR,
      verbose: true,
    });

    const result = compiler.compile(ptsPath);

    // Should have compiled code
    assert.ok(result.code.length > 0);
    assert.strictEqual(result.cached, false);

    // Should have transformed createProcess to __createProcess
    assert.ok(result.code.includes('__createProcess'));
  });

  it('should produce consistent output for same source', () => {
    const ptsContent = `
import { createProcess } from '@justscale/core/process'

export const cachedProcess = createProcess({
  path: '/cached/:id',
  inject: {},
  async handler({}, [id]) {
    return { id }
  },
})
`;
    const ptsPath = join(TEST_DIR, 'cached.process.ts');
    writeFileSync(ptsPath, ptsContent);

    const compiler = new PtsCompiler({
      rootDir: TEST_DIR,
      cacheDir: CACHE_DIR,
    });

    const result1 = compiler.compile(ptsPath);
    const result2 = compiler.compile(ptsPath);
    assert.strictEqual(result1.code, result2.code);
  });

  it('should produce different output when source changes', () => {
    const ptsPath = join(TEST_DIR, 'changing.process.ts');

    const compiler = new PtsCompiler({
      rootDir: TEST_DIR,
      cacheDir: CACHE_DIR,
    });

    // First version
    writeFileSync(ptsPath, `
import { createProcess } from '@justscale/core/process'
export const v1 = createProcess({
  path: '/v1',
  inject: {},
  async handler() { return { version: 1 } },
})
`);

    const result1 = compiler.compile(ptsPath);

    // Change source
    writeFileSync(ptsPath, `
import { createProcess } from '@justscale/core/process'
export const v2 = createProcess({
  path: '/v2',
  inject: {},
  async handler() { return { version: 2 } },
})
`);

    const result2 = compiler.compile(ptsPath);
    assert.notStrictEqual(result1.code, result2.code);
  });
});
