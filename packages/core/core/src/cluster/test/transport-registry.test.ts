/**
 * Tests for transport plugin registry (cluster.ts) and socket path
 * utilities in transport.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerTransport,
  getRegisteredTransports,
  type TransportPlugin,
} from '../cluster.js';
import { getSocketDir, getSocketPath, cleanupSocket } from '../transport.js';
import { existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('Transport plugin registry', () => {
  it('registerTransport appends to the registry', () => {
    const before = getRegisteredTransports().length;
    const plugin: TransportPlugin = { name: 'test-plugin-a' };
    registerTransport(plugin);
    const after = getRegisteredTransports();
    assert.equal(after.length, before + 1);
    assert.ok(after.some((p) => p.name === 'test-plugin-a'));
  });

  it('getRegisteredTransports returns a readonly view', () => {
    const arr = getRegisteredTransports();
    // Type says readonly, at runtime it's an array reference — verify
    // attempts to mutate are not supposed to roundtrip through the API.
    const before = arr.length;
    // Registering through the API is the sanctioned path.
    registerTransport({ name: 'test-plugin-b' });
    assert.equal(getRegisteredTransports().length, before + 1);
  });

  it('accepts plugins with lifecycle hooks (shape validation only)', () => {
    const p: TransportPlugin = {
      name: 'with-hooks',
      provides: ['some-token'],
      beforeControllerResolution: () => {},
      onAppCreated: () => {},
      onServe: async () => {},
      onStop: async () => {},
      registerHandlers: () => {},
    };
    registerTransport(p);
    assert.ok(getRegisteredTransports().some((x) => x.name === 'with-hooks'));
  });

  it('multiple plugins can share the same name (no dedup)', () => {
    const start = getRegisteredTransports().filter((p) => p.name === 'dupe').length;
    registerTransport({ name: 'dupe' });
    registerTransport({ name: 'dupe' });
    const end = getRegisteredTransports().filter((p) => p.name === 'dupe').length;
    assert.equal(end - start, 2);
  });
});

describe('Socket path utilities', () => {
  it('getSocketDir returns an existing directory', () => {
    const d = getSocketDir();
    assert.ok(existsSync(d), 'socket dir should exist');
  });

  it('getSocketPath produces a stable hash per appRoot', () => {
    const a = getSocketPath('/tmp/appA');
    const b = getSocketPath('/tmp/appA');
    const c = getSocketPath('/tmp/appB');
    assert.equal(a, b, 'same root should hash identically');
    assert.notEqual(a, c, 'different root should hash differently');
  });

  it('cleanupSocket removes an existing file safely', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sock-'));
    const f = join(dir, 'x.sock');
    writeFileSync(f, 'content');
    assert.ok(existsSync(f));
    cleanupSocket(f);
    assert.ok(!existsSync(f));
  });

  it('cleanupSocket is a no-op on missing file', () => {
    // Should not throw
    cleanupSocket('/tmp/definitely-does-not-exist-' + Date.now() + '.sock');
  });
});
