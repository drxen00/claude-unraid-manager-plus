import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { FIX_TOOLS, FixBroker, editDiff, writableOutsideAppdata } from '../src/fix.mjs';

// Commands inside containers and config edits: what the owner is shown,
// what reaches host-fix, and what is turned down before anyone is asked.

const containers = [{ name: 'sonarr' }, { name: 'plex' }, { name: 'claude-unraid-manager' }];
const MOUNTS = {
  plex: JSON.stringify([
    { Type: 'bind', Source: '/mnt/user/appdata/plex', Destination: '/config', RW: true },
    { Type: 'bind', Source: '/mnt/user/Media', Destination: '/media', RW: true },
    { Type: 'bind', Source: '/mnt/disk1/tv', Destination: '/tv', RW: false },
  ]),
  sonarr: JSON.stringify([{ Type: 'bind', Source: '/mnt/cache/appdata/sonarr', Destination: '/config', RW: true }]),
};
const FILE = 'port=8989\nlog=info\n';
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

function broker({ decision = 'allow', file = FILE, hostCode = 0, hostOut = 'ok\nhost-fix: exit code 0\n' } = {}) {
  const calls = { asked: [], host: [], audit: [] };
  const b = new FixBroker({
    askOwner: async (q) => { calls.asked.push(q); return decision; },
    run: async (cmd, args) => {
      const name = args.at(-1);
      return MOUNTS[name] ? { code: 0, stdout: `${MOUNTS[name]}\n`, stderr: '' } : { code: 1, stdout: '', stderr: 'no such container' };
    },
    hostFix: async (args, timeoutMs, input) => {
      calls.host.push({ args: args.join(' '), input });
      if (args[0] === 'read') return { code: 0, stdout: file, stderr: '' };
      return { code: hostCode, stdout: hostOut, stderr: '' };
    },
    audit: async (e) => { calls.audit.push(e); },
    containers: () => containers,
    policy: () => ({ source: 'you asked in this chat' }),
  });
  return { b, calls };
}

test('a command: the owner sees it exactly, host-fix gets it on stdin', async () => {
  const { b, calls } = broker();
  const command = 'grep -i error /config/logs/sonarr.txt | tail -20';
  const r = await b.handle({ tool: 'container_exec', args: { name: 'sonarr', command, reason: 'Look for the error.' } });
  assert.equal(r.ok, true);
  assert.equal(calls.asked[0].what, 'run a command inside **sonarr**');
  assert.ok(calls.asked[0].detail.includes(command));
  assert.doesNotMatch(calls.asked[0].detail, /can write to/);
  assert.deepEqual(calls.host, [{ args: 'exec sonarr', input: command }]);
});

test('a command in a container that can write outside appdata comes with a warning', async () => {
  const { b, calls } = broker();
  await b.handle({ tool: 'container_exec', args: { name: 'plex', command: 'ls /media', reason: 'r' } });
  assert.match(calls.asked[0].detail, /plex can write to `\/mnt\/user\/Media`/);
  assert.match(calls.asked[0].detail, /including on the array/);
  assert.doesNotMatch(calls.asked[0].detail, /disk1/, 'read-only mounts are not a risk');
});

test('denied or bad commands never reach host-fix', async () => {
  let t = broker({ decision: 'deny' });
  let r = await t.b.handle({ tool: 'container_exec', args: { name: 'sonarr', command: 'id', reason: 'r' } });
  assert.equal(r.ok, false);
  assert.deepEqual(t.calls.host, []);
  for (const [args, re] of [
    [{ name: 'claude-unraid-manager', command: 'id' }, /part of this tool/],
    [{ name: 'nope', command: 'id' }, /no container named/],
    [{ name: 'sonarr', command: '   ' }, /empty/],
    [{ name: 'sonarr', command: 'x'.repeat(4001) }, /longer than/],
  ]) {
    t = broker();
    r = await t.b.handle({ tool: 'container_exec', args: { ...args, reason: 'r' } });
    assert.match(r.text, re);
    assert.deepEqual(t.calls.asked, []);
    assert.deepEqual(t.calls.host, []);
  }
});

test('an edit: read first, a diff for the owner, then write with the sha it was read with', async () => {
  const { b, calls } = broker();
  const path = '/mnt/user/appdata/sonarr/config/config.ini';
  const r = await b.handle({ tool: 'appdata_edit', args: { path, old_text: 'log=info', new_text: 'log=debug', reason: 'More detail in the log.' } });
  assert.equal(r.ok, true);
  assert.equal(calls.asked[0].what, `edit \`${path}\``);
  assert.match(calls.asked[0].detail, /- log=info\n\+ log=debug/);
  assert.match(calls.asked[0].detail, /backup/);
  assert.deepEqual(calls.host.map((h) => h.args), [`read ${path}`, `write ${path} ${sha(FILE)}`]);
  assert.equal(calls.host[1].input, 'port=8989\nlog=debug\n');
  // The log keeps the request, not the whole file.
  assert.equal(calls.audit[0].args.oldText, 'log=info');
  assert.equal(calls.audit[0].args.content, undefined);
});

test('an edit that does not apply exactly once is sent back to Claude, the owner is not asked', async () => {
  const path = '/mnt/user/appdata/sonarr/config.ini';
  let t = broker();
  let r = await t.b.handle({ tool: 'appdata_edit', args: { path, old_text: 'log=warn', new_text: 'x', reason: 'r' } });
  assert.match(r.text, /was not found/);
  t = broker({ file: 'a=1\na=1\n' });
  r = await t.b.handle({ tool: 'appdata_edit', args: { path, old_text: 'a=1', new_text: 'a=2', reason: 'r' } });
  assert.match(r.text, /appears 2 times/);
  assert.deepEqual(t.calls.asked, []);
  assert.ok(t.calls.host.every((h) => !h.args.startsWith('write')));
});

test('edits only for files below a container\'s appdata, never this tool\'s', async () => {
  for (const [path, re] of [
    ['/mnt/user/appdata/sonarr', /not a file below/],
    ['/mnt/user/Media/movie.nfo', /not a file below/],
    ['/boot/config/go', /not a file below/],
    ['/mnt/user/appdata/sonarr/../../boot/x', /not a file below/],
    ['/mnt/user/appdata/claude-unraid-manager/home/.claude.json', /own data/],
  ]) {
    const t = broker();
    const r = await t.b.handle({ tool: 'appdata_edit', args: { path, old_text: 'a', new_text: 'b', reason: 'r' } });
    assert.match(r.text, re, path);
    assert.deepEqual(t.calls.host, []);
  }
  const t = broker();
  const r = await t.b.handle({ tool: 'appdata_edit', args: { path: '/mnt/user/appdata/sonarr/x', old_text: 'a', new_text: 'a', reason: 'r' } });
  assert.match(r.text, /the same/);
});

test('an old host-fix on the flash drive gets a clear way out', async () => {
  const { b } = broker({ hostCode: 65, hostOut: "host-fix: refused: unknown command 'exec'\n" });
  const r = await b.handle({ tool: 'container_exec', args: { name: 'sonarr', command: 'id', reason: 'r' } });
  assert.match(r.text, /host-fix-setup/);
});

test('helpers', () => {
  assert.deepEqual(writableOutsideAppdata(MOUNTS.plex), ['/mnt/user/Media']);
  assert.deepEqual(writableOutsideAppdata(MOUNTS.sonarr), []);
  assert.equal(writableOutsideAppdata('not json'), null);
  const d = editDiff('a\nb', 'c', 12);
  assert.match(d, /^- a\n- b\n/);
  assert.match(editDiff('x'.repeat(50), 'y', 20), /more line/);
  assert.ok(FIX_TOOLS.container_exec.needsHost && FIX_TOOLS.appdata_edit.needsHost);
});
