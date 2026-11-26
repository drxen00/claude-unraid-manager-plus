import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { FAILS_TO_DOWN, UptimeMonitor, validTarget } from '../src/uptime.mjs';
import { AlertFeed, LinkCodes, createPanelApi } from '../src/panel.mjs';
import { FixBroker } from '../src/fix.mjs';
import { ClaudeChats } from '../src/claudechat.mjs';
import { investigatePrompt } from '../src/claude.mjs';

// Website checks, the rule tools, the Approvals list, investigations and
// reports: what "all in on Wraith" adds.

function monitor({ status = 200, fail = false, cert = null } = {}) {
  const state = { status, fail, cert, saved: null, changes: 0 };
  let now = 1_000_000;
  const m = new UptimeMonitor({
    save: async (l) => { state.saved = l; },
    onChange: () => { state.changes++; },
    fetchFn: async () => {
      now += 120;
      if (state.fail) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
      return { status: state.status, body: { cancel: async () => {} } };
    },
    cert: async () => state.cert,
    now: () => now,
  });
  return { m, state };
}

test('website addresses: http(s) only, a name, no passwords', () => {
  assert.ok(validTarget({ name: 'Plex', url: 'https://plex.example.com/web' }).target);
  assert.match(validTarget({ name: 'x', url: 'ftp://a' }).error, /http/);
  assert.match(validTarget({ name: 'x', url: 'not a url' }).error, /web address/);
  assert.match(validTarget({ name: 'x', url: 'https://u:p@a.com' }).error, /password/);
  assert.match(validTarget({ name: ' ', url: 'https://a.com' }).error, /name/);
});

test('a site goes down only after two failures in a row, and comes back', async () => {
  const { m, state } = monitor();
  const view = await m.upsert({ name: 'Plex', url: 'https://plex.example.com' });
  assert.deepEqual(state.saved, [{ id: view.id, name: 'Plex', url: 'https://plex.example.com/', alerts: true }]);
  const t = m.targets[0];
  state.fail = true;
  assert.equal(await m.checkOne(t), FAILS_TO_DOWN === 1);
  assert.deepEqual(m.findings(), []);
  assert.equal(await m.checkOne(t), true);
  const [f] = m.findings();
  assert.equal(f.key, `uptime:${t.id}:down`);
  assert.equal(f.severity, 'critical');
  assert.match(f.detail, /ECONNREFUSED/);
  state.fail = false;
  assert.equal(await m.checkOne(t), true);
  assert.deepEqual(m.findings(), []);
  assert.ok(m.list()[0].uptimePct < 100);
  // A 404 is up (the server answers); a 503 is down.
  state.status = 503;
  await m.checkOne(t);
  await m.checkOne(t);
  assert.equal(m.findings().length, 1);
});

test('certificates: a warning two weeks out, critical in the last days; alerts can be turned off', async () => {
  const { m, state } = monitor({ cert: { daysLeft: 10, validTo: '2026-12-06T00:00:00.000Z' } });
  await m.upsert({ name: 'Site', url: 'https://site.example.com' });
  // Adding a site checks it straight away, in the background.
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(m.findings()[0].severity, 'warning');
  assert.match(m.findings()[0].title, /expires in 10 days/);
  state.cert = { daysLeft: 1, validTo: '2026-11-27T00:00:00.000Z' };
  m.targets[0].certAt = 0;
  await m.checkOne(m.targets[0]);
  assert.equal(m.findings()[0].severity, 'critical');
  await m.upsert({ id: m.targets[0].id, name: 'Site', url: 'https://site.example.com', alerts: false });
  assert.deepEqual(m.findings(), []);
  await m.remove(m.targets[0].id);
  await assert.rejects(m.remove('nope'), /gone/);
});

test('the panel: uptime shown and managed from #alerts', async () => {
  const OWNER = '11111111-1111-4111-8111-111111111111';
  const { m } = monitor();
  const api = createPanelApi({
    link: () => ({ user: OWNER, name: 'F' }), setLink: async () => {}, codes: new LinkCodes(), linkHint: '', hostname: () => 'h',
    sys: { history: [], info: async () => ({}) }, disks: () => [], incidents: () => [], containers: async () => [],
    run: async () => ({ code: 0 }), act: async () => ({ ok: true }), alerts: new AlertFeed(null), test: async () => {}, audit: async () => {},
    uptime: m,
  });
  const ask = (method, path, json) => api.handle({ method, path, user: OWNER, json });
  assert.equal((await ask('GET', 'me')).json.can.uptimeView, true);
  assert.equal((await ask('POST', 'alerts/uptime', { name: 'Plex', url: 'https://plex.example.com' })).status, 200);
  const o = (await ask('GET', 'alerts/overview')).json;
  assert.deepEqual(o.can.uptime, { view: true, control: true });
  assert.equal(o.rules.uptime[0].name, 'Plex');
  assert.ok(o.categories.some((c) => c.key === 'uptime'));
  assert.equal((await ask('GET', 'uptime')).json.targets.length, 1);
  assert.equal((await ask('POST', 'alerts/uptime', { name: 'x', url: 'ftp://x' })).status, 400);
  assert.equal((await ask('DELETE', `alerts/uptime/${o.rules.uptime[0].id}`)).status, 200);
});

test('reports always reach the phone; info-only events otherwise do not', async () => {
  const a = new AlertFeed(null);
  const report = await a.record({ source: 'report', severity: 'info', title: 'Morning report', detail: 'x'.repeat(3000) }, 'report');
  assert.equal(report.cat, 'report');
  assert.equal(report.detail.length, 3000, 'reports are kept in full');
  assert.equal(a.notifies(report), true);
  const info = await a.record({ source: 'containers', severity: 'info', title: 'fyi' }, 'raised');
  assert.equal(a.notifies(info), false);
});

function rulesBroker(decision = 'allow') {
  const applied = [];
  const asked = [];
  const b = new FixBroker({
    askOwner: async (q) => { asked.push(q); return decision; },
    run: async () => ({ code: 0 }), hostFix: null, audit: async () => {},
    containers: () => [{ name: 'plex' }],
    rules: { status: () => 'Open problems:\nNo open problems.\n\nRules:\nnone', apply: async (item) => { applied.push(item); return 'Muted.'; } },
  });
  return { b, applied, asked };
}

test('rules by talking: reading asks nothing; a change is asked, then applied', async () => {
  let t = rulesBroker();
  let r = await t.b.handle({ tool: 'watch_status', args: {} });
  assert.match(r.text, /No open problems/);
  assert.deepEqual(t.asked, []);

  r = await t.b.handle({ tool: 'watch_rule', args: { action: 'mute', match: 'disk:*:full', until_when: { type: 'disk', disk: '*', op: '>=', percent: 99 }, reason: 'The owner asked.' } });
  assert.equal(r.ok, true);
  assert.match(t.asked[0].what, /set a watcher rule/);
  assert.equal(t.applied[0].action, 'watch.mute');
  assert.equal(t.applied[0].spec.match, 'disk:*:full');

  t = rulesBroker('deny');
  r = await t.b.handle({ tool: 'watch_rule', args: { action: 'note', text: 'no parity on purpose', reason: 'r' } });
  assert.equal(r.ok, false);
  assert.deepEqual(t.applied, []);
});

test('rules that are not valid never reach the owner', async () => {
  for (const args of [
    { action: 'mute', match: 'array:state:STOPPED' },
    { action: 'mute' },
    { action: 'alert', when: { type: 'weather' } },
    { action: 'fix', match: 'x' },
    { action: 'undo' },
  ]) {
    const t = rulesBroker();
    const r = await t.b.handle({ tool: 'watch_rule', args: { ...args, reason: 'r' } });
    assert.match(r.text, /not valid/, JSON.stringify(args));
    assert.deepEqual(t.asked, []);
  }
});

function chats() {
  const events = [];
  const notices = [];
  const spawned = [];
  const c = new ClaudeChats({
    home: '/home/claude', workspace: '/workspace', uid: 99, gid: 100,
    fs: { readdir: async () => [], stat: async () => ({}), readFile: async () => '', unlink: async () => {}, mkdir: async () => {}, writeFile: async () => {}, chown: async () => {} },
    spawnClaude: (args) => {
      const p = new EventEmitter();
      p.stdout = new EventEmitter();
      p.stderr = new EventEmitter();
      p.lines = [];
      p.stdin = { write: (d) => p.lines.push(d), on() {} };
      p.args = args;
      spawned.push(p);
      return p;
    },
    signal: () => {}, emit: (e) => events.push(e), notify: (e) => notices.push(e), names: () => ({}), saveNames: async () => {},
  });
  return { c, events, notices, spawned };
}

test('the Approvals list: questions from outside a chat land there, readable later, answered in Wraith', async () => {
  const { c, events, notices } = chats();
  assert.equal(c.ask(null, { tool: 'x', summary: 'y' }), null, 'no chat, no list asked for');
  const pending = c.ask(null, { tool: 'Claude wants to change something', summary: 'restart plex (from your Claude app session)\nWhy: stuck', inbox: true });
  const inbox = c.inboxId;
  const [s] = await c.sessions();
  assert.equal(s.id, inbox);
  assert.equal(s.title, 'Approvals');
  const h = await c.history(inbox);
  assert.match(h.items[0].text, /restart plex/);
  assert.equal(h.state.status, 'waiting');
  assert.equal(h.state.pending.length, 1);
  assert.equal(notices.at(-1).reason, 'permission');
  assert.throws(() => c.message(inbox, 'hi'), /Approvals list/);
  assert.throws(() => c.settings(inbox, { model: 'haiku' }), /Approvals list/);
  await assert.rejects(c.remove(inbox), /cannot be deleted/);
  c.answer(inbox, h.state.pending[0], 'allow');
  assert.equal(await pending, 'allow');
  assert.equal(c.state(inbox).status, 'idle');
  // It does not count as a running chat.
  await c.open({});
  await c.open({});
  await c.open({});
  assert.ok(events.length);
});

test('investigations: the watcher hears when Claude has finished, not the owner\'s phone', async () => {
  const { c, notices, spawned } = chats();
  const st = await c.open({});
  let got = null;
  c.whenDone(st.sessionId, (r) => { got = r; });
  c.message(st.sessionId, investigatePrompt([{ key: 'container:plex:exited', title: 'plex crashed', severity: 'warning', detail: 'Exited (1)', firstSeen: 0 }], { mutes: [], alerts: [], notes: [{ id: 'n1', text: 'no parity on purpose' }] }));
  const sent = JSON.parse(spawned[0].lines[0]).message.content;
  assert.match(sent, /plex crashed/);
  assert.match(sent, /no parity on purpose/);
  assert.match(sent, /Never touch the array/);
  spawned[0].stdout.emit('data', `${JSON.stringify({ type: 'result', subtype: 'success', result: 'Plex ran out of memory.' })}\n`);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(got, { ok: true, text: 'Plex ran out of memory.' });
  assert.ok(!notices.some((n) => n.reason === 'done'), 'the report entry tells the owner instead');
});
