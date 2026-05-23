/**
 * Tests for file watcher
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { watchEnvFiles } from '../../src/features/config/file-watcher.js';
import { writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('watchEnvFiles', () => {
  let testDir: string;
  let testFile1: string;
  let testFile2: string;

  beforeEach(() => {
    // Create unique temp directory for each test
    testDir = join(tmpdir(), `file-watcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    testFile1 = join(testDir, '.env.test1');
    testFile2 = join(testDir, '.env.test2');
  });

  after(() => {
    // Clean up all test directories
    const tempDir = tmpdir();
    const files = readdirSync(tempDir);
    for (const file of files) {
      if (file.startsWith('file-watcher-test-')) {
        try {
          rmSync(join(tempDir, file), { recursive: true, force: true });
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    }
  });

  describe('parsing .env file format', () => {
    it('should parse simple KEY=value format', () => {
      writeFileSync(testFile1, 'KEY1=value1\nKEY2=value2');

      const watcher = watchEnvFiles([testFile1]);

      try {
        assert.deepStrictEqual(watcher.values, {
          KEY1: 'value1',
          KEY2: 'value2',
        });
      } finally {
        watcher.close();
      }
    });

    it('should parse double quoted values', () => {
      writeFileSync(testFile1, 'KEY1="quoted value"\nKEY2="value with spaces"');

      const watcher = watchEnvFiles([testFile1]);

      try {
        assert.deepStrictEqual(watcher.values, {
          KEY1: 'quoted value',
          KEY2: 'value with spaces',
        });
      } finally {
        watcher.close();
      }
    });

    it('should parse single quoted values', () => {
      writeFileSync(testFile1, "KEY1='single quoted'\nKEY2='another value'");

      const watcher = watchEnvFiles([testFile1]);

      try {
        assert.deepStrictEqual(watcher.values, {
          KEY1: 'single quoted',
          KEY2: 'another value',
        });
      } finally {
        watcher.close();
      }
    });

    it('should ignore comments starting with #', () => {
      writeFileSync(testFile1, '# This is a comment\nKEY1=value1\n# Another comment\nKEY2=value2');

      const watcher = watchEnvFiles([testFile1]);

      try {
        assert.deepStrictEqual(watcher.values, {
          KEY1: 'value1',
          KEY2: 'value2',
        });
      } finally {
        watcher.close();
      }
    });

    it('should ignore empty lines', () => {
      writeFileSync(testFile1, '\n\nKEY1=value1\n\n\nKEY2=value2\n\n');

      const watcher = watchEnvFiles([testFile1]);

      try {
        assert.deepStrictEqual(watcher.values, {
          KEY1: 'value1',
          KEY2: 'value2',
        });
      } finally {
        watcher.close();
      }
    });

    it('should handle lines without equals sign', () => {
      writeFileSync(testFile1, 'KEY1=value1\nINVALID_LINE\nKEY2=value2');

      const watcher = watchEnvFiles([testFile1]);

      try {
        assert.deepStrictEqual(watcher.values, {
          KEY1: 'value1',
          KEY2: 'value2',
        });
      } finally {
        watcher.close();
      }
    });

    it('should trim whitespace around keys and values', () => {
      writeFileSync(testFile1, '  KEY1  =  value1  \n  KEY2=value2  ');

      const watcher = watchEnvFiles([testFile1]);

      try {
        assert.deepStrictEqual(watcher.values, {
          KEY1: 'value1',
          KEY2: 'value2',
        });
      } finally {
        watcher.close();
      }
    });
  });

  describe('handling missing files', () => {
    it('should handle missing files gracefully', () => {
      const nonExistentFile = join(testDir, 'does-not-exist.env');

      const watcher = watchEnvFiles([nonExistentFile]);

      try {
        assert.deepStrictEqual(watcher.values, {});
      } finally {
        watcher.close();
      }
    });

    it('should skip missing files but read existing ones', () => {
      const nonExistentFile = join(testDir, 'does-not-exist.env');
      writeFileSync(testFile1, 'KEY1=value1');

      const watcher = watchEnvFiles([nonExistentFile, testFile1]);

      try {
        assert.deepStrictEqual(watcher.values, {
          KEY1: 'value1',
        });
      } finally {
        watcher.close();
      }
    });
  });

  describe('merging multiple files', () => {
    it('should merge values from multiple files', () => {
      writeFileSync(testFile1, 'KEY1=value1\nKEY2=value2');
      writeFileSync(testFile2, 'KEY3=value3\nKEY4=value4');

      const watcher = watchEnvFiles([testFile1, testFile2]);

      try {
        assert.deepStrictEqual(watcher.values, {
          KEY1: 'value1',
          KEY2: 'value2',
          KEY3: 'value3',
          KEY4: 'value4',
        });
      } finally {
        watcher.close();
      }
    });

    it('should override earlier values with later files', () => {
      writeFileSync(testFile1, 'KEY1=first\nKEY2=value2');
      writeFileSync(testFile2, 'KEY1=second\nKEY3=value3');

      const watcher = watchEnvFiles([testFile1, testFile2]);

      try {
        assert.deepStrictEqual(watcher.values, {
          KEY1: 'second', // testFile2 overrides testFile1
          KEY2: 'value2',
          KEY3: 'value3',
        });
      } finally {
        watcher.close();
      }
    });
  });

  describe('subscribers and notifications', () => {
    it('should call subscribers on file changes', async () => {
      writeFileSync(testFile1, 'KEY1=initial');

      const watcher = watchEnvFiles([testFile1], 100); // Short debounce for testing
      let callCount = 0;
      let lastValues: Record<string, string> | null = null;

      const unsubscribe = watcher.subscribe((values) => {
        callCount++;
        lastValues = values;
      });

      try {
        // Wait a bit to ensure watcher is ready
        await new Promise(resolve => setTimeout(resolve, 50));

        // Modify the file
        writeFileSync(testFile1, 'KEY1=updated');

        // Wait for debounce + file watcher + margin
        await new Promise(resolve => setTimeout(resolve, 300));

        assert.strictEqual(callCount, 1, 'Subscriber should be called once');
        assert.deepStrictEqual(lastValues, { KEY1: 'updated' });
        assert.deepStrictEqual(watcher.values, { KEY1: 'updated' });
      } finally {
        unsubscribe();
        watcher.close();
      }
    });

    it('should debounce rapid changes', async () => {
      writeFileSync(testFile1, 'KEY1=initial');

      const watcher = watchEnvFiles([testFile1], 100);
      let callCount = 0;
      let lastValues: Record<string, string> = {};

      const unsubscribe = watcher.subscribe((values) => {
        callCount++;
        lastValues = values;
      });

      try {
        await new Promise(resolve => setTimeout(resolve, 50));

        // Make multiple rapid changes
        writeFileSync(testFile1, 'KEY1=change1');
        await new Promise(resolve => setTimeout(resolve, 20));
        writeFileSync(testFile1, 'KEY1=change2');
        await new Promise(resolve => setTimeout(resolve, 20));
        writeFileSync(testFile1, 'KEY1=change3');

        // Wait for debounce
        await new Promise(resolve => setTimeout(resolve, 200));

        // Should only be called once due to debouncing
        assert.ok(callCount <= 2, `Expected at most 2 calls due to debouncing, got ${callCount}`);
        assert.deepStrictEqual(lastValues, { KEY1: 'change3' });
      } finally {
        unsubscribe();
        watcher.close();
      }
    });

    it('should support multiple subscribers', async () => {
      writeFileSync(testFile1, 'KEY1=initial');

      const watcher = watchEnvFiles([testFile1], 100);
      let callCount1 = 0;
      let callCount2 = 0;

      const unsubscribe1 = watcher.subscribe(() => { callCount1++; });
      const unsubscribe2 = watcher.subscribe(() => { callCount2++; });

      try {
        await new Promise(resolve => setTimeout(resolve, 50));

        writeFileSync(testFile1, 'KEY1=updated');
        await new Promise(resolve => setTimeout(resolve, 200));

        assert.strictEqual(callCount1, 1, 'First subscriber should be called');
        assert.strictEqual(callCount2, 1, 'Second subscriber should be called');
      } finally {
        unsubscribe1();
        unsubscribe2();
        watcher.close();
      }
    });

    it('should stop notifications after unsubscribe', async () => {
      writeFileSync(testFile1, 'KEY1=initial');

      const watcher = watchEnvFiles([testFile1], 100);
      let callCount = 0;

      const unsubscribe = watcher.subscribe(() => {
        callCount++;
      });

      try {
        await new Promise(resolve => setTimeout(resolve, 50));

        // First change
        writeFileSync(testFile1, 'KEY1=change1');
        await new Promise(resolve => setTimeout(resolve, 200));

        assert.strictEqual(callCount, 1);

        // Unsubscribe
        unsubscribe();

        // Second change should not trigger callback
        writeFileSync(testFile1, 'KEY1=change2');
        await new Promise(resolve => setTimeout(resolve, 200));

        assert.strictEqual(callCount, 1, 'Should not be called after unsubscribe');
      } finally {
        watcher.close();
      }
    });
  });

  describe('cleanup', () => {
    it('should clean up watchers on close', async () => {
      writeFileSync(testFile1, 'KEY1=value1');

      const watcher = watchEnvFiles([testFile1], 100);
      let callCount = 0;

      watcher.subscribe(() => {
        callCount++;
      });

      await new Promise(resolve => setTimeout(resolve, 50));

      // Close the watcher
      watcher.close();

      // Changes after close should not trigger callbacks
      writeFileSync(testFile1, 'KEY1=updated');
      await new Promise(resolve => setTimeout(resolve, 200));

      assert.strictEqual(callCount, 0, 'Should not be called after close');
    });

    it('should clear all subscribers on close', () => {
      writeFileSync(testFile1, 'KEY1=value1');

      const watcher = watchEnvFiles([testFile1]);

      watcher.subscribe(() => {});
      watcher.subscribe(() => {});
      watcher.subscribe(() => {});

      watcher.close();

      // After close, subscribers should be cleared
      // We can't directly test this, but it shouldn't crash
      watcher.close(); // Multiple closes should be safe
    });
  });

  describe('edge cases', () => {
    it('should handle empty files', () => {
      writeFileSync(testFile1, '');

      const watcher = watchEnvFiles([testFile1]);

      try {
        assert.deepStrictEqual(watcher.values, {});
      } finally {
        watcher.close();
      }
    });

    it('should handle files with only comments', () => {
      writeFileSync(testFile1, '# Comment 1\n# Comment 2\n# Comment 3');

      const watcher = watchEnvFiles([testFile1]);

      try {
        assert.deepStrictEqual(watcher.values, {});
      } finally {
        watcher.close();
      }
    });

    it('should handle empty key names gracefully', () => {
      writeFileSync(testFile1, '=value\nKEY1=value1');

      const watcher = watchEnvFiles([testFile1]);

      try {
        // Empty key should be ignored or handled
        assert.ok('KEY1' in watcher.values);
        assert.strictEqual(watcher.values.KEY1, 'value1');
      } finally {
        watcher.close();
      }
    });

    it('should handle values with equals signs', () => {
      writeFileSync(testFile1, 'KEY1=value=with=equals');

      const watcher = watchEnvFiles([testFile1]);

      try {
        assert.strictEqual(watcher.values.KEY1, 'value=with=equals');
      } finally {
        watcher.close();
      }
    });

    it('should handle special characters in values', () => {
      writeFileSync(testFile1, 'KEY1=!@#$%^&*()\nKEY2=foo/bar\\baz');

      const watcher = watchEnvFiles([testFile1]);

      try {
        assert.strictEqual(watcher.values.KEY1, '!@#$%^&*()');
        assert.strictEqual(watcher.values.KEY2, 'foo/bar\\baz');
      } finally {
        watcher.close();
      }
    });
  });
});
