import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rename, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pinStateDir } from '../src/statedir.mjs';

const linux = process.platform === 'linux';
const uid = process.getuid?.() ?? 0;
const quiet = () => {};

test('the state folder is created private and used through its open handle', { skip: !linux && 'needs /proc' }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'statedir-'));
  const dir = join(base, '.unraid-watch');
  const pinned = await pinStateDir(dir, { uid, log: quiet });
  assert.match(pinned, /^\/proc\/\d+\/fd\/\d+$/);
  await writeFile(join(pinned, 'prefs.json'), '{}');
  // Renamed away and replaced by someone else's folder: the watcher keeps
  // writing into the folder it checked, never into the new one.
  await rename(dir, join(base, 'moved'));
  await mkdir(dir);
  await writeFile(join(pinned, 'state.json'), '{"x":1}');
  assert.equal(await readFile(join(base, 'moved', 'state.json'), 'utf8'), '{"x":1}');
  assert.deepEqual(await readdir(dir), []);
});

test('a link, a file or a folder open to others is moved aside, never used', { skip: !linux && 'needs /proc' }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'statedir-'));
  const target = join(base, 'elsewhere');
  await mkdir(target);
  const cases = [
    async (d) => symlink(target, d),
    async (d) => writeFile(d, 'not a folder'),
    async (d) => { await mkdir(d); await chmod(d, 0o755); },
  ];
  for (const [i, plant] of cases.entries()) {
    const dir = join(base, `s${i}`);
    await plant(dir);
    const logs = [];
    const pinned = await pinStateDir(dir, { uid, log: (m) => logs.push(m) });
    await writeFile(join(pinned, 'k'), 'secret');
    assert.equal(logs.length, 1, `case ${i}`);
    assert.match(logs[0], /moved it to/);
    assert.equal(await readFile(join(dir, 'k'), 'utf8'), 'secret');
  }
  assert.deepEqual(await readdir(target), []);
});

test('a folder owned by another user is moved aside', { skip: !linux && 'needs /proc' }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'statedir-'));
  const dir = join(base, 'd');
  await mkdir(dir, { mode: 0o700 });
  const logs = [];
  // Expecting a different owner than the test's own user stands in for
  // "the folder is Claude's, not root's".
  await assert.rejects(pinStateDir(dir, { uid: uid + 1, log: (m) => logs.push(m) }), /could not get a root-only state folder/);
  assert.equal(logs.length, 3);
});
