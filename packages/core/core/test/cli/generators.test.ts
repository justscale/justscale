/**
 * Tests for the just init IDE generators.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateVSCodeConfig, generateJetBrainsConfig } from '../../src/cli/generators/ide.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `justscale-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('generateVSCodeConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates .vscode/settings.json with typescript.tsdk', () => {
    generateVSCodeConfig(dir);
    const settings = JSON.parse(readFileSync(join(dir, '.vscode/settings.json'), 'utf-8'));
    assert.ok(settings['typescript.tsdk'], 'Should set typescript.tsdk');
    assert.ok(settings['typescript.tsdk'].includes('@justscale/typescript'));
  });

  it('adds proto file association in settings.json', () => {
    generateVSCodeConfig(dir);
    const settings = JSON.parse(readFileSync(join(dir, '.vscode/settings.json'), 'utf-8'));
    const associations = settings['files.associations'] as Record<string, string>;
    assert.ok(associations, 'Should have files.associations');
    assert.strictEqual(associations['*.proto'], 'proto3', 'Should associate .proto with proto3');
  });

  it('includes justscale-vscode in extension recommendations', () => {
    generateVSCodeConfig(dir);
    const extensions = JSON.parse(readFileSync(join(dir, '.vscode/extensions.json'), 'utf-8'));
    const recs = extensions.recommendations as string[];
    assert.ok(recs.includes('justscale.justscale-vscode'), 'Should recommend justscale extension');
    assert.ok(recs.includes('dbaeumer.vscode-eslint'), 'Should still recommend eslint');
  });

  it('merges into existing settings without overwriting tsdk', () => {
    mkdirSync(join(dir, '.vscode'), { recursive: true });
    writeFileSync(join(dir, '.vscode/settings.json'), JSON.stringify({
      'typescript.tsdk': '/custom/path',
      'editor.tabSize': 2,
    }));
    generateVSCodeConfig(dir);
    const settings = JSON.parse(readFileSync(join(dir, '.vscode/settings.json'), 'utf-8'));
    assert.strictEqual(settings['typescript.tsdk'], '/custom/path', 'Should not overwrite existing tsdk');
    assert.strictEqual(settings['editor.tabSize'], 2, 'Should preserve other settings');
    assert.ok(settings['files.associations'], 'Should still add missing settings');
  });

  it('merges extension recommendations without duplicates', () => {
    mkdirSync(join(dir, '.vscode'), { recursive: true });
    writeFileSync(join(dir, '.vscode/extensions.json'), JSON.stringify({
      recommendations: ['dbaeumer.vscode-eslint', 'ms-vscode.vscode-typescript-next'],
    }));
    generateVSCodeConfig(dir);
    const extensions = JSON.parse(readFileSync(join(dir, '.vscode/extensions.json'), 'utf-8'));
    const recs = extensions.recommendations as string[];
    const eslintCount = recs.filter(r => r === 'dbaeumer.vscode-eslint').length;
    assert.strictEqual(eslintCount, 1, 'Should not duplicate eslint');
    assert.ok(recs.includes('justscale.justscale-vscode'), 'Should add justscale extension');
    assert.ok(recs.includes('ms-vscode.vscode-typescript-next'), 'Should preserve existing');
  });

  it('returns list of generated files', () => {
    const generated = generateVSCodeConfig(dir);
    assert.ok(generated.length >= 2, 'Should report generated files');
    const joined = generated.join(' ');
    assert.ok(joined.includes('settings'), 'Should include settings.json in output');
    assert.ok(joined.includes('extensions'), 'Should include extensions.json in output');
  });
});

describe('generateJetBrainsConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates .idea/typescript.xml pointing to @justscale/typescript', () => {
    generateJetBrainsConfig(dir);
    const content = readFileSync(join(dir, '.idea/typescript.xml'), 'utf-8');
    assert.ok(content.includes('@justscale/typescript'), 'Should reference @justscale/typescript');
    assert.ok(content.includes('useService'), 'Should enable TypeScript service');
  });

  it('creates .idea/justscale-lsp.xml with LSP config for proto files', () => {
    generateJetBrainsConfig(dir);
    const content = readFileSync(join(dir, '.idea/justscale-lsp.xml'), 'utf-8');
    assert.ok(content.includes('justscale-lsp'), 'Should reference justscale-lsp binary');
    assert.ok(content.includes('*.proto'), 'Should configure for proto files');
  });

  it('does not overwrite existing .idea/typescript.xml', () => {
    mkdirSync(join(dir, '.idea'), { recursive: true });
    writeFileSync(join(dir, '.idea/typescript.xml'), '<custom/>');
    generateJetBrainsConfig(dir);
    const content = readFileSync(join(dir, '.idea/typescript.xml'), 'utf-8');
    assert.strictEqual(content, '<custom/>', 'Should not overwrite existing config');
  });

  it('creates run configurations', () => {
    generateJetBrainsConfig(dir);
    const configs = ['just_dev.xml', 'just_build.xml', 'just_test.xml'];
    for (const config of configs) {
      const content = readFileSync(join(dir, `.idea/runConfigurations/${config}`), 'utf-8');
      assert.ok(content.includes('<configuration'), `${config} should be a run config`);
    }
  });
});
