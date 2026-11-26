import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { HostTerminal, buildScript, cleanOutput, splitTrailer } from '../src/terminal.mjs';
import { AlertFeed, LinkCodes, createPanelApi } from '../src/panel.mjs';

function fakeShell() {
  const spawned = [];
  const spawnShell = (script) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.written = [];
    c.stdin = { write: (d) => c.written.push(d), on() {} };
    c.killed = null;
    c.kill = (sig) => { c.killed = sig; c.emit('close', null); };
    c.script = script;
    spawned.push(c);
    return c;
  };
  return { spawned, spawnShell };
}
const tick = (ms = 200) => new Promise((r) => setTimeout(r, ms));

test('a command runs in the last directory; its output streams; the end marker sets the new one', async () => {
  const { spawned, spawnShell } = fakeShell();
  const events = [];
  const audits = [];
  const t = new HostTerminal({ spawnShell, emit: (e) => events.push(e), audit: async (a) => { audits.push(a); } });
  assert.deepEqual(await t.input('cd /mnt/user && ls'), { as: 'command' });
  const c = spawned[0];
  assert.match(c.script, /cd -- '\/root'/);
  assert.match(c.script, /\ncd \/mnt\/user && ls\n/);
  assert.equal(t.state().running, true);
  c.stdout.emit('data', 'appdata\r\n\x1b[01;34mMedia\x1b[0m\r\n');
  await tick();
  assert.ok(events.some((e) => e.type === 'term.update' && e.entry.text === 'appdata\nMedia\n'));
  c.stdout.emit('data', '\n\x1eWRAITH 0 /mnt/user\x1e');
  c.emit('close', 0);
  const out = t.history().entries.at(-1);
  assert.equal(out.kind, 'out');
  assert.equal(out.text, 'appdata\nMedia');
  assert.equal(out.exit, 0);
  assert.equal(out.running, false);
  assert.equal(t.state().cwd, '/mnt/user');
  assert.equal(audits[0].command, 'cd /mnt/user && ls');
  await t.input('pwd');
  assert.match(spawned[1].script, /cd -- '\/mnt\/user'/);
});

test('while a command runs, input goes to it (shown masked) and keys are control characters', async () => {
  const { spawned, spawnShell } = fakeShell();
  const t = new HostTerminal({ spawnShell });
  await t.input('read -s x; echo got');
  assert.deepEqual(await t.input('hunter2'), { as: 'stdin' });
  assert.deepEqual(spawned[0].written, ['hunter2\n']);
  assert.equal(t.history().entries.find((e) => e.kind === 'stdin').text, '•••••••');
  assert.equal(t.key('interrupt'), true);
  assert.equal(spawned[0].written.at(-1), '\x03');
  assert.throws(() => t.key('rm'), /Unknown key/);
  spawned[0].emit('close', 130);
  assert.equal(t.history().entries.find((e) => e.kind === 'out').exit, 130, 'no marker: the exit code of the connection');
  assert.equal(t.key('interrupt'), false, 'nothing running');
});

test('empty and huge commands are refused; reset kills and goes home; clear keeps the running one', async () => {
  const { spawned, spawnShell } = fakeShell();
  const t = new HostTerminal({ spawnShell });
  await assert.rejects(t.input('   '), /Type a command/);
  await assert.rejects(t.input('x'.repeat(8001)), /too long/);
  await t.input('ls');
  spawned[0].stdout.emit('data', '\n\x1eWRAITH 0 /tmp\x1e');
  spawned[0].emit('close', 0);
  await t.input('sleep 100');
  t.clear();
  assert.ok(t.history().entries.every((e) => e.running));
  t.reset();
  assert.equal(spawned[1].killed, 'SIGKILL');
  assert.equal(t.state().cwd, '/root');
  assert.equal(t.state().running, false);
});

test('history pages backwards', async () => {
  const { spawned, spawnShell } = fakeShell();
  const t = new HostTerminal({ spawnShell });
  for (let i = 0; i < 5; i++) {
    await t.input(`echo ${i}`);
    spawned[i].emit('close', 0);
  }
  const last = t.history({ limit: 4 }).entries;
  assert.equal(last.length, 4);
  const older = t.history({ limit: 4, before: last[0].id }).entries;
  assert.equal(older.at(-1).id, t.entries[t.entries.indexOf(last[0]) - 1].id);
});

test('the script really runs in bash: directory carried, exit code reported', { skip: spawnSync('bash', ['-c', 'true']).status !== 0 && 'no bash' }, () => {
  const r = spawnSync('bash', ['-c', buildScript('/', 'cd /tmp 2>/dev/null || cd /; echo hi # a comment\nfalse')], { encoding: 'utf8' });
  const s = splitTrailer(cleanOutput(r.stdout));
  assert.equal(s.text.trim(), 'hi');
  assert.equal(s.exit, 1);
  assert.ok(s.cwd);
});

test('the panel: terminal routes only when it is on, and me says so', async () => {
  const OWNER = '11111111-1111-4111-8111-111111111111';
  const base = {
    link: () => ({ user: OWNER, name: 'F' }), setLink: async () => {}, codes: new LinkCodes(), linkHint: '', hostname: () => 'h',
    sys: { history: [], info: async () => ({}) }, disks: () => [], incidents: () => [], containers: async () => [],
    run: async () => ({ code: 0, stdout: '', stderr: '' }), act: async () => ({ ok: true }), alerts: new AlertFeed(null), test: async () => {}, audit: async () => {},
  };
  const off = createPanelApi({ ...base, terminal: null, terminalHint: 'turn it on in the template' });
  let me = (await off.handle({ method: 'GET', path: 'me', user: OWNER })).json;
  assert.equal(me.can.terminal, false);
  assert.equal(me.why.terminal, 'turn it on in the template');
  assert.equal((await off.handle({ method: 'POST', path: 'terminal/input', user: OWNER, json: { text: 'id' } })).status, 403);

  const { spawned, spawnShell } = fakeShell();
  const on = createPanelApi({ ...base, terminal: new HostTerminal({ spawnShell }) });
  me = (await on.handle({ method: 'GET', path: 'me', user: OWNER })).json;
  assert.equal(me.can.terminal, true);
  assert.equal(me.runAs, 'root');
  assert.deepEqual((await on.handle({ method: 'POST', path: 'terminal/input', user: OWNER, json: { text: 'id' } })).json, { as: 'command' });
  assert.equal(spawned.length, 1);
  assert.equal((await on.handle({ method: 'POST', path: 'terminal/key', user: OWNER, json: { key: 'nope' } })).status, 400);
  assert.equal((await on.handle({ method: 'GET', path: 'terminal/history?limit=10', user: OWNER })).json.entries.length, 2);
  // Someone else: not linked, nothing runs.
  assert.equal((await on.handle({ method: 'POST', path: 'terminal/input', user: '22222222-2222-4222-8222-222222222222', json: { text: 'id' } })).json.error, 'not_linked');
  assert.equal(spawned.length, 1);
});
