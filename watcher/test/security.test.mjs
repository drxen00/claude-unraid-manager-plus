import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { askClaude } from '../src/claude.mjs';
import { ClaudeChats } from '../src/claudechat.mjs';
import { findOrigin } from '../src/fix-mcp.mjs';
import { ownedFs } from '../src/ownedfs.mjs';
import { AlertFeed, LinkCodes, createPanelApi, newLinkCode } from '../src/panel.mjs';

// The security sweep of the Wraith work: root never follows Claude's links,
// changes from elsewhere never pose as a Wraith chat's, strangers cannot fill
// the audit log.

const linux = process.platform === 'linux';

test('the watch folder is made by Claude\'s user, never by root', async () => {
  const calls = [];
  const asClaude = async (_cfg, args) => {
    calls.push(args);
    return { code: 0, stdout: JSON.stringify({ result: 'ok', is_error: false }), stderr: '' };
  };
  await askClaude({ claudeCwd: '/workspace/watch', claudeTimeoutMs: 1000 }, 'P', { asClaude });
  assert.deepEqual(calls[0], ['mkdir', '-p', '--', '/workspace/watch']);
  assert.equal(calls[1][0], 'claude');
});

test('ownedFs: Claude\'s own regular files only; links and other owners refused', { skip: !linux && 'needs Linux' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'owned-'));
  try {
    const uid = process.getuid();
    await writeFile(join(dir, 'a.jsonl'), 'hello');
    await writeFile(join(dir, 'secret'), 'root only');
    await symlink(join(dir, 'secret'), join(dir, 'link.jsonl'));
    const fs = ownedFs(uid);
    assert.equal(await fs.readFile(join(dir, 'a.jsonl')), 'hello');
    await assert.rejects(fs.readFile(join(dir, 'link.jsonl')), /ELOOP|not a regular/);
    await assert.rejects(fs.stat(join(dir, 'link.jsonl')), /not a regular/);
    await assert.rejects(fs.unlink(join(dir, 'link.jsonl')), /not a regular/);
    assert.ok((await readdir(dir)).includes('link.jsonl'), 'the link was not deleted');
    // Someone else's file (here: a uid that is not ours).
    await assert.rejects(ownedFs(uid + 1).readFile(join(dir, 'a.jsonl')), /not owned/);
    await assert.rejects(ownedFs(uid + 1).unlink(join(dir, 'a.jsonl')), /not owned/);
    assert.equal(await readFile(join(dir, 'a.jsonl'), 'utf8'), 'hello');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('findOrigin: the chat id from the environment, else from the processes above', () => {
  const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.equal(findOrigin({ env: { WRAITH_CHAT_ID: ID }, ppid: 0 }), ID);
  // claude (pid 20) has it; the MCP server's own environment does not.
  const procs = {
    '/proc/30/environ': 'PATH=/bin\0HOME=/home/claude\0',
    '/proc/30/stat': '30 (sh) S 20 30 30 0',
    '/proc/20/environ': `HOME=/home/claude\0WRAITH_CHAT_ID=${ID}\0`,
  };
  const read = (p) => { if (!(p in procs)) throw new Error('EACCES'); return procs[p]; };
  assert.equal(findOrigin({ env: {}, ppid: 30, read }), ID);
  // Not a chat (the Claude app session): nothing found, nothing guessed.
  assert.equal(findOrigin({ env: {}, ppid: 30, read: (p) => (p.endsWith('environ') ? 'PATH=/bin\0' : '30 (claude (x)) S 1 1') }), null);
  assert.equal(findOrigin({ env: { WRAITH_CHAT_ID: 'not-an-id' }, ppid: 0 }), null);
});

function chats() {
  const events = [];
  const c = new ClaudeChats({
    home: '/home/claude', workspace: '/workspace', uid: 99, gid: 100,
    fs: { readdir: async () => [], stat: async () => ({}), readFile: async () => '', unlink: async () => {} },
    saveUpload: async () => {},
    spawnClaude: () => {
      const p = new EventEmitter();
      p.stdout = new EventEmitter();
      p.stderr = new EventEmitter();
      p.stdin = { write() {}, on() {} };
      return p;
    },
    signal: () => {}, emit: (e) => events.push(e), notify: () => {}, names: () => ({}), saveNames: async () => {},
  });
  return { c, events };
}

test('a change asked from outside a chat goes to Approvals, not into the chat that happens to be working', async () => {
  const { c, events } = chats();
  const st = await c.open({});
  c.message(st.sessionId, 'look at plex');
  c.ask(null, { tool: 'Claude wants to change something', summary: 'restart plex (from your Claude app session)', inbox: true });
  const asked = events.filter((e) => e.type === 'claude.permission');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].session, c.inboxId);
  assert.notEqual(asked[0].session, st.sessionId);
  // A permission prompt (only Wraith chats send those) still finds the working chat.
  void c.permission(null, { tool_name: 'Bash', input: { command: 'ls' } });
  assert.equal(events.filter((e) => e.type === 'claude.permission').at(-1).session, st.sessionId);
});

test('linking: with no code out, a stranger\'s tries are refused and not written to the audit log', async () => {
  const audits = [];
  const codes = new LinkCodes();
  const api = createPanelApi({
    link: () => null, setLink: async () => {}, codes, linkHint: '', hostname: () => 'h',
    sys: { history: [] }, disks: () => [], incidents: () => [], containers: async () => [],
    run: async () => ({ code: 0 }), act: async () => ({ ok: true }), alerts: new AlertFeed(null), test: async () => {},
    audit: async (e) => audits.push(e),
  });
  const USER = '22222222-2222-4222-8222-222222222222';
  for (let i = 0; i < 50; i++) assert.equal((await api.handle({ method: 'POST', path: 'link', user: USER, json: { code: 'AAAA-AAAA' } })).status, 400);
  assert.deepEqual(audits, []);
  codes.issue();
  await api.handle({ method: 'POST', path: 'link', user: USER, json: { code: 'AAAA-AAAA' } });
  assert.equal(audits.length, 1, 'a wrong guess at a real code is logged');
});

test('link codes: 8 letters from the alphabet, no look-alikes', () => {
  for (let i = 0; i < 200; i++) assert.match(newLinkCode(), /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
});

test('no regex in the watcher lost its backslashes (a /**/ is a comment, /s+/ splits on "s")', async () => {
  const dir = new URL('../src/', import.meta.url);
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.mjs')) continue;
    const src = await readFile(new URL(f, dir), 'utf8');
    assert.doesNotMatch(src, /\.replace\(\/\*\*\/g/, f);
    assert.doesNotMatch(src, /\.split\(\/s\+\/\)/, f);
    assert.ok(!src.includes('\0'), `${f} has a NUL byte`);
  }
});
