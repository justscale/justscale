import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JustScale from '../../../index.js';
import { ProfileServiceDef, type ProfileService } from '../index.js';

describe('ProfileService', () => {
  let origCwd: string;
  let tmp: string;
  let origProfile: string | undefined;

  beforeEach(() => {
    origCwd = process.cwd();
    origProfile = process.env.JUSTSCALE_PROFILE;
    delete process.env.JUSTSCALE_PROFILE;
    tmp = mkdtempSync(join(tmpdir(), 'jst-prof-'));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(origCwd);
    if (origProfile !== undefined) process.env.JUSTSCALE_PROFILE = origProfile;
    else delete process.env.JUSTSCALE_PROFILE;
    try { rmSync(tmp, { recursive: true, force: true }); } catch {
      /* best-effort */
    }
  });

  async function make(): Promise<ProfileService> {
    const app = JustScale().add(ProfileServiceDef).build();
    await app.compile().ready;
    return app.container.resolve(ProfileServiceDef);
  }

  it('defaults to "local" when nothing is configured', async () => {
    const svc = await make();
    assert.strictEqual(svc.active(), 'local');
  });

  it('uses $JUSTSCALE_PROFILE as highest priority', async () => {
    process.env.JUSTSCALE_PROFILE = 'staging';
    const svc = await make();
    assert.strictEqual(svc.active(), 'staging');
  });

  it('falls back to .active-profile file when env var is unset', async () => {
    mkdirSync(join(tmp, '.justscale'), { recursive: true });
    writeFileSync(join(tmp, '.justscale', '.active-profile'), 'dev');
    const svc = await make();
    assert.strictEqual(svc.active(), 'dev');
  });

  it('list() returns [] when no profiles dir', async () => {
    const svc = await make();
    assert.deepStrictEqual(svc.list(), []);
  });

  it('create() + list() round-trip', async () => {
    const svc = await make();
    svc.create('dev');
    svc.create('prod');
    const list = svc.list().sort();
    assert.deepStrictEqual(list, ['dev', 'prod']);
  });

  it('create() throws on duplicate profile name', async () => {
    const svc = await make();
    svc.create('dup');
    assert.throws(() => svc.create('dup'), /already exists/);
  });

  it('create() with copyFrom copies contents', async () => {
    const svc = await make();
    svc.create('src');
    const src = join(tmp, '.justscale', 'profiles', 'src.json');
    writeFileSync(src, JSON.stringify({ a: 1, b: { c: 2 } }));
    svc.create('dst', 'src');
    const dstRaw = JSON.parse(readFileSync(join(tmp, '.justscale', 'profiles', 'dst.json'), 'utf-8'));
    assert.deepStrictEqual(dstRaw, { a: 1, b: { c: 2 } });
  });

  it('create() throws when copyFrom target does not exist', async () => {
    const svc = await make();
    assert.throws(() => svc.create('new', 'missing'), /does not exist/);
  });

  it('use() throws when profile does not exist', async () => {
    const svc = await make();
    assert.throws(() => svc.use('ghost'), /does not exist/);
  });

  it('use() writes .active-profile', async () => {
    const svc = await make();
    svc.create('live');
    svc.use('live');
    assert.strictEqual(svc.active(), 'live');
    assert.strictEqual(
      readFileSync(join(tmp, '.justscale', '.active-profile'), 'utf-8'),
      'live',
    );
  });

  it('delete() removes the profile file', async () => {
    const svc = await make();
    svc.create('scratch');
    svc.delete('scratch');
    assert.strictEqual(existsSync(join(tmp, '.justscale', 'profiles', 'scratch.json')), false);
  });

  it('delete() throws when deleting the active profile', async () => {
    const svc = await make();
    svc.create('guard');
    svc.use('guard');
    assert.throws(() => svc.delete('guard'), /Cannot delete active profile/);
  });

  it('delete() throws when profile does not exist', async () => {
    const svc = await make();
    assert.throws(() => svc.delete('ghost'), /does not exist/);
  });

  it('get() returns {} on missing profile (non-throwing)', async () => {
    const svc = await make();
    assert.deepStrictEqual(svc.get('missing'), {});
  });

  it('get() returns {} on corrupted JSON', async () => {
    const svc = await make();
    mkdirSync(join(tmp, '.justscale', 'profiles'), { recursive: true });
    writeFileSync(join(tmp, '.justscale', 'profiles', 'corrupt.json'), '{broken');
    assert.deepStrictEqual(svc.get('corrupt'), {});
  });

  it('diff() shows added, removed, and modified keys', async () => {
    const svc = await make();
    svc.create('a');
    svc.create('b');
    const A = join(tmp, '.justscale', 'profiles', 'a.json');
    const B = join(tmp, '.justscale', 'profiles', 'b.json');
    writeFileSync(A, JSON.stringify({ keep: 1, changed: 'old', removed: true }));
    writeFileSync(B, JSON.stringify({ keep: 1, changed: 'new', added: 42 }));
    const diff = svc.diff('a', 'b').map((d) => d.key).sort();
    assert.deepStrictEqual(diff, ['added', 'changed', 'removed']);
    // 'keep' has same value in both, not in the diff
    const keep = svc.diff('a', 'b').find((d) => d.key === 'keep');
    assert.strictEqual(keep, undefined);
  });

  it('diff() treats deeply-equal nested objects as equal (via JSON roundtrip)', async () => {
    const svc = await make();
    svc.create('x');
    svc.create('y');
    const X = join(tmp, '.justscale', 'profiles', 'x.json');
    const Y = join(tmp, '.justscale', 'profiles', 'y.json');
    writeFileSync(X, JSON.stringify({ n: { a: 1, b: 2 } }));
    writeFileSync(Y, JSON.stringify({ n: { a: 1, b: 2 } }));
    assert.deepStrictEqual(svc.diff('x', 'y'), []);
  });
});
