import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AlertFeed, LinkCodes, createPanelApi, mergeLogs, newLinkCode, parsePath, parseStats } from '../src/panel.mjs';
import { encodeAnswer, startWraith } from '../src/wraith.mjs';
import { parseWraithCode, loadConfig } from '../src/config.mjs';
import { cpuPercent, diskTotals, parseCpuLine, parseMeminfo, parseSize } from '../src/sysinfo.mjs';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TOKEN = `wpanel_${'a'.repeat(64)}`;
const code = (url) => `wpc1.${Buffer.from(url).toString('base64url')}.${TOKEN}`;

function setup({ linked = OWNER } = {}) {
  let link = linked ? { user: linked, name: 'Fornzy' } : null;
  const calls = [];
  const audits = [];
  const codes = new LinkCodes();
  const alerts = new AlertFeed(null);
  const rows = [
    { name: 'plex', state: 'running', status: 'Up 2 hours', image: 'plexinc/pms' },
    { name: 'sonarr', state: 'exited', status: 'Exited (1) 5 minutes ago', image: 'lscr/sonarr' },
    { name: 'claude-unraid-manager', state: 'running', status: 'Up', image: 'x' },
  ];
  const api = createPanelApi({
    link: () => link,
    setLink: async (l) => { link = l; },
    codes,
    linkHint: 'run wraith-link',
    hostname: () => 'Castl3',
    sys: { history: [{ t: 1, cpu: 5, mem: 40 }], info: async ({ hostname }) => ({ hostname }) },
    disks: () => [],
    incidents: () => [{ key: 'container:sonarr:exited', source: 'containers', container: 'sonarr', severity: 'warning', title: 'sonarr crashed', detail: 'Exited (1)' }],
    containers: async () => rows,
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === 'logs') return { code: 0, stdout: '2026-01-01T00:00:02.000Z second\n', stderr: '2026-01-01T00:00:01.000Z first\n' };
      return { code: 0, stdout: '{"CPUPerc":"12.5%","MemUsage":"1.5GiB / 31GiB"}\n', stderr: '' };
    },
    act: async (action, name) => { calls.push([action, name]); return { ok: true, message: `Done: ${name}` }; },
    alerts,
    test: async () => {},
    audit: async (e) => { audits.push(e); },
  });
  const ask = (method, path, user = OWNER, json) => api.handle({ method, path, user, json });
  return { api, ask, calls, audits, codes, alerts, getLink: () => link };
}

test('a stranger gets not_linked with the hint, everywhere but link', async () => {
  const { ask } = setup();
  for (const [m, p] of [['GET', 'me'], ['GET', 'services'], ['POST', 'services/docker%3Aplex/restart'], ['GET', 'alerts/overview']]) {
    const r = await ask(m, p, OTHER);
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'not_linked');
    assert.equal(r.json.linkHint, 'run wraith-link');
  }
});

test('nothing works before linking, and a code links once', async () => {
  const { ask, codes, getLink, audits } = setup({ linked: null });
  assert.equal((await ask('GET', 'me')).json.error, 'not_linked');
  assert.equal((await ask('POST', 'link', OWNER, { code: 'AAAA-BBBB' })).status, 400);
  const { code: c } = codes.issue();
  assert.equal((await ask('POST', 'link', OWNER, { code: c.toLowerCase(), wraithName: 'Fornzy' })).status, 200);
  assert.deepEqual({ ...getLink(), at: 0 }, { user: OWNER, name: 'Fornzy', at: 0 });
  // Used up.
  assert.equal((await ask('POST', 'link', OTHER, { code: c })).status, 400);
  assert.equal(getLink().user, OWNER);
  assert.ok(audits.some((a) => a.action === 'wraith.link' && a.result.startsWith('ok')));
  assert.equal((await ask('GET', 'me')).json.can.terminal, false);
});

test('link codes: readable, ten minutes, five wrong tries', () => {
  assert.match(newLinkCode(), /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  let now = 0;
  const codes = new LinkCodes({ now: () => now });
  let { code: c } = codes.issue();
  now = 11 * 60_000;
  assert.equal(codes.redeem(c), false);
  ({ code: c } = codes.issue());
  for (let i = 0; i < 5; i++) assert.equal(codes.redeem('WRNG-CODE'), false);
  assert.equal(codes.redeem(c), false, 'five wrong tries burn the code');
});

test('the owner sees containers, never this tool\'s own, and can act on them', async () => {
  const { ask, calls } = setup();
  const r = await ask('GET', 'services');
  const items = r.json.groups[0].items;
  assert.deepEqual(items.map((i) => i.id), ['docker:plex', 'docker:sonarr']);
  assert.equal((await ask('POST', 'services/docker%3Aplex/restart')).status, 200);
  assert.deepEqual(calls.at(-1), ['container.restart', 'plex']);
  assert.equal((await ask('POST', 'services/docker%3Aclaude-unraid-manager/stop')).status, 404);
  assert.equal((await ask('POST', 'services/docker%3Anope/start')).status, 404);
  assert.equal((await ask('POST', 'services/docker%3Aplex/rm')).status, 404);
});

test('logs come back merged in time order, stats as numbers', async () => {
  const { ask } = setup();
  assert.deepEqual((await ask('GET', 'services/docker%3Aplex/logs?lines=50')).json.lines, ['first', 'second']);
  assert.deepEqual((await ask('GET', 'services/docker%3Aplex/stats')).json, { cpu: 12.5, mem: Math.round(1.5 * 1024 ** 3) });
});

test('power, terminal and reboot are refused whoever asks', async () => {
  const { ask } = setup();
  for (const [m, p] of [['POST', 'power/reboot'], ['POST', 'power/shutdown'], ['POST', 'restart/request'], ['POST', 'terminal/input'], ['POST', 'claude/open']]) {
    assert.equal((await ask(m, p)).status, 403, p);
  }
  const me = (await ask('GET', 'me')).json;
  assert.equal(me.can.power, false);
  assert.equal(me.can.terminal, false);
});

test('a smuggled path or a bad user id is a bad request', async () => {
  const { ask } = setup();
  assert.equal(parsePath('services/%E0%A4%A/logs'), null);
  assert.equal((await ask('GET', 'services/%E0%A4%A/logs')).status, 400);
  assert.equal((await ask('GET', 'me', 'not-a-uuid')).status, 400);
});

test('#alerts: overview from open problems, feed, prefs', async () => {
  const { ask, alerts } = setup();
  const o = (await ask('GET', 'alerts/overview')).json;
  assert.equal(o.state.counts.warn, 1);
  assert.equal(o.active[0].serviceId, 'docker:sonarr');
  const e = await alerts.record({ source: 'disks', severity: 'critical', title: 'disk1 is 99% full' }, 'raised');
  await alerts.record({ source: 'disks', severity: 'critical', title: 'disk1 is 99% full' }, 'resolved');
  const feed = (await ask('GET', 'alerts/feed?limit=1')).json;
  assert.equal(feed.events.length, 1);
  assert.equal(feed.events[0].title, 'Cleared: disk1 is 99% full');
  assert.equal(feed.hasMore, true);
  const next = (await ask('GET', `alerts/feed?limit=1&before=${feed.next}`)).json;
  assert.equal(next.events[0].id, e.id);
  assert.equal(alerts.notifies(e), true);
  await ask('PUT', 'alerts/prefs', OWNER, { muted: ['disks', 'bogus'] });
  assert.deepEqual(alerts.prefs().muted, ['disks']);
  assert.equal(alerts.notifies(e), false);
  assert.equal((await ask('DELETE', `alerts/feed/${e.id}`)).status, 200);
  assert.equal((await ask('DELETE', `alerts/feed/${e.id}`)).status, 404);
});

test('alerts: severity floor, timed pause, recoveries stay quiet', async () => {
  let now = 1000;
  const a = new AlertFeed(null, { now: () => now });
  const warn = await a.record({ source: 'containers', severity: 'warning', title: 'x' }, 'raised');
  const cleared = await a.record({ source: 'containers', severity: 'warning', title: 'x' }, 'resolved');
  assert.equal(a.notifies(warn), true);
  assert.equal(a.notifies(cleared), false);
  await a.setPrefs({ minSeverity: 'error' });
  assert.equal(a.notifies(warn), false);
  await a.setPrefs({ minSeverity: 'warn', paused: true, pauseMinutes: 60 });
  assert.equal(a.notifies(warn), false);
  now += 61 * 60_000;
  assert.equal(a.notifies(warn), true);
  assert.equal(a.prefs().paused, false);
});

test('helpers', () => {
  assert.deepEqual(mergeLogs('2026-01-01T00:00:03Z c\n', '2026-01-01T00:00:01Z a\nplain\n', 10), ['plain', 'a', 'c']);
  assert.deepEqual(parseStats('nope'), { cpu: 0, mem: 0 });
  assert.equal(parseSize('3.6T'), Math.round(3.6 * 1024 ** 4));
  assert.equal(parseSize('512M'), 512 * 1024 ** 2);
  assert.equal(diskTotals([{ size: '1T', used: '512G' }]).percent, 50);
  const a = parseCpuLine('cpu  100 0 100 800 0 0 0 0 0 0\n');
  const b = parseCpuLine('cpu  150 0 150 900 0 0 0 0 0 0\n');
  assert.equal(cpuPercent(a, b), 50);
  assert.deepEqual(parseMeminfo('MemTotal: 1000 kB\nMemAvailable: 250 kB\n'), { total: 1024000, used: 768000, percent: 75 });
});

test('the connection code: https only, all of it', () => {
  assert.deepEqual(parseWraithCode(code('https://wrraith.com')), { url: 'https://wrraith.com', token: TOKEN });
  assert.equal(parseWraithCode(''), null);
  assert.throws(() => parseWraithCode(code('http://wrraith.com')), /not https/);
  assert.throws(() => parseWraithCode(code('https://wrraith.com').slice(0, -1)), /not a Wraith connection code/);
  assert.equal(parseWraithCode(code('http://localhost:3002')).url, 'http://localhost:3002');
});

test('Wraith alone is enough to start; neither is not', () => {
  const cfg = loadConfig({ WRAITH_PANEL_CODE: code('https://wrraith.com') });
  assert.equal(cfg.discord, false);
  assert.equal(cfg.wraith.url, 'https://wrraith.com');
  assert.throws(() => loadConfig({}), /neither/);
});

test('answers that would not fit in one Socket.IO message become a 502', () => {
  assert.equal(encodeAnswer({ status: 200, json: { a: 1 } }).body, '{"a":1}');
  assert.equal(encodeAnswer({ status: 200, json: { big: 'x'.repeat(1024 * 1024) } }).status, 502);
});

test('the connector answers requests and streams only to the linked owner', async () => {
  const fake = new EventEmitter();
  fake.connected = true;
  const sent = [];
  fake.emit = function emit(name, ...args) {
    // Events from "Wraith" to us go through EventEmitter; ours are recorded.
    if (['request', 'subscribe', 'unsubscribe', 'ready', 'connect', 'disconnect', 'connect_error'].includes(name)) return EventEmitter.prototype.emit.call(this, name, ...args);
    sent.push([name, ...args]);
    return true;
  };
  fake.close = () => {};
  let opts;
  const w = startWraith({
    url: 'https://wrraith.com',
    token: TOKEN,
    api: { handle: async (req) => ({ status: 200, json: { echo: req } }) },
    linkedUser: () => OWNER,
    connect: (url, o) => { opts = { url, ...o }; return fake; },
    log: { log() {}, error() {} },
  });
  assert.equal(opts.url, 'https://wrraith.com/panel-connector');
  assert.equal(opts.auth.token, TOKEN);
  const answer = await new Promise((resolve) => fake.emit('request', { method: 'GET', path: 'me', user: OWNER }, resolve));
  assert.equal(answer.status, 200);
  assert.equal(JSON.parse(answer.body).echo.path, 'me');

  w.emitEvent(OWNER, { type: 'alert.new' });
  assert.equal(sent.length, 0, 'not watching yet');
  fake.emit('subscribe', { user: OWNER });
  fake.emit('subscribe', { user: OTHER });
  w.emitEvent(OWNER, { type: 'alert.new' });
  w.emitEvent(OTHER, { type: 'alert.new' });
  assert.deepEqual(sent, [['event', { user: OWNER, event: { type: 'alert.new' } }]]);
  w.attention({ id: 'x', title: 't' });
  assert.equal(sent[1][0], 'attention');
  assert.equal(sent[1][1].wraithUser, OWNER);
  assert.equal(sent[1][1].type, 'panel.alert');
});
