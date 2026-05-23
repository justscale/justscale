import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateCompletions } from '../../src/cli/parser.js';

const routes = [
  { fullCommand: 'build', argDefs: [
    { name: 'watch', type: 'flag' as const, zodType: {} as any, required: false, hasDefault: false, isBoolean: true, isArray: false, flags: ['--watch'] },
    { name: 'verbose', type: 'flag' as const, zodType: {} as any, required: false, hasDefault: false, isBoolean: true, isArray: false, flags: ['--verbose'] },
  ] },
  { fullCommand: 'user add', argDefs: [
    { name: 'email', type: 'positional' as const, zodType: {} as any, required: true, hasDefault: false, isBoolean: false, isArray: false },
    { name: 'name', type: 'flag' as const, zodType: {} as any, required: false, hasDefault: false, isBoolean: false, isArray: false },
  ] },
  { fullCommand: 'user list', argDefs: [] },
  { fullCommand: 'session revoke', argDefs: [] },
  { fullCommand: 'session list', argDefs: [] },
];

describe('generateCompletions', () => {
  it('completes top-level commands from an empty cursor', () => {
    const result = generateCompletions([''], 0, routes);
    assert.deepEqual(result, ['build', 'session', 'user']);
  });

  it('narrows top-level by prefix', () => {
    const result = generateCompletions(['us'], 0, routes);
    assert.deepEqual(result, ['user']);
  });

  it('completes sub-commands under a group', () => {
    const result = generateCompletions(['user', ''], 1, routes);
    assert.deepEqual(result, ['add', 'list']);
  });

  it('narrows sub-commands by prefix', () => {
    const result = generateCompletions(['user', 'ad'], 1, routes);
    assert.deepEqual(result, ['add']);
  });

  it('suggests flag names after a fully-matched command', () => {
    const result = generateCompletions(['user', 'add', '-'], 2, routes);
    assert.deepEqual(result, ['--name']);
  });

  it('returns empty for unknown prefixes', () => {
    const result = generateCompletions(['nope'], 1, routes);
    assert.deepEqual(result, []);
  });
});
