import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FIX_TOOLS, FixBroker, MAX_ASKS_PER_HOUR, MAX_FIXES_PER_HOUR, serveFixSocket } from '../src/fix.mjs';
import { callWatcher, handleMessage } from '../src/fix-mcp.mjs';

const containers = [{ name: 'sonarr' }, { name: 'plex' }, { name: 'claude-unraid-manager' }];

function broker({ decision = 'allow', hostFix = null, policy, runCode = 0 } = {}) {
  const calls = { run: [], host: [], asked: [], audit: [], notes: [] };
  let now = 1_000_000;
  const b = new FixBroker({
    askOwner: async (q) => { calls.asked.push(q); return typeof decision === 'function' ? decision(q) : decision; },
    run: async (cmd, args) => { calls.run.push([cmd, ...args].join(' ')); return { code: runCode, stdout: '', stderr: runCode ? 'boom' : '' }; },
    hostFix: hostFix && (async (args, t) => { calls.host.push([args.join(' '), t]); return hostFix(args); }),
    audit: async (e) => { calls.audit.push(e); },
    notify: async (t) => { calls.notes.push(t); },
    containers: () => containers,
    policy: policy ?? (() => ({ source: 'Fix it' })),
    now: () => now,
  });
  return { b, calls, tick: (ms) => { now += ms; } };
}

test('an allowed restart asks the owner with the exact change, then runs the fixed command', async () => {
  const { b, calls } = await broker();
  const r = await b.handle({ tool: 'container_restart', args: { name: 'sonarr', reason: 'It is stuck since 3 AM.' } });
  assert.deepEqual(r, { ok: true, text: 'Restarted sonarr.' });
  assert.deepEqual(calls.asked, [{ tool: 'container_restart', what: 'restart **sonarr**', reason: 'It is stuck since 3 AM.', source: 'Fix it' }]);
  assert.deepEqual(calls.run, ['docker restart sonarr']);
  assert.equal(calls.audit[0].result, 'ok');
  assert.match(calls.notes[0], /restart sonarr: done/);
});

test('deny and no answer change nothing and tell Claude why', async () => {
  for (const [decision, re, result] of [['deny', /tapped Deny/, 'denied'], ['timeout', /did not answer/, 'no answer']]) {
    const { b, calls } = await broker({ decision });
    const r = await b.handle({ tool: 'container_stop', args: { name: 'plex', reason: 'x' } });
    assert.equal(r.ok, false);
    assert.match(r.text, re);
    assert.deepEqual(calls.run, []);
    assert.equal(calls.audit[0].result, result);
  }
});

test('bad requests are refused before the owner is even asked', async () => {
  const { b, calls } = await broker({ hostFix: async () => ({ code: 0, stdout: '', stderr: '' }) });
  const cases = [
    [{ tool: 'shell', args: {} }, /Unknown fix tool/],
    [{ tool: '__proto__', args: {} }, /Unknown fix tool/],
    [{ tool: 'container_restart', args: { name: 'claude-unraid-manager' } }, /part of this tool/],
    [{ tool: 'container_restart', args: { name: 'claude-docker-proxy-2' } }, /part of this tool/],
    [{ tool: 'container_restart', args: { name: 'ghost' } }, /no container named ghost/],
    [{ tool: 'container_restart', args: { name: 'plex; rm -rf /' } }, /not a container name/],
    [{ tool: 'appdata_chown', args: { path: '/etc/shadow', owner: '99:100' } }, /not a folder below/],
    [{ tool: 'appdata_chown', args: { path: '/mnt/user/appdata', owner: '99:100' } }, /not a folder below/],
    [{ tool: 'appdata_chown', args: { path: '/mnt/user/appdata/../../boot', owner: '99:100' } }, /not a folder below/],
    [{ tool: 'appdata_chown', args: { path: '/mnt/user/appdata/sonarr', owner: 'root' } }, /numeric/],
    [{ tool: 'appdata_chown', args: { path: '/mnt/user/appdata/claude-unraid-manager/home', owner: '99:100' } }, /own data/],
  ];
  for (const [req, re] of cases) {
    const r = await b.handle(req);
    assert.equal(r.ok, false, JSON.stringify(req));
    assert.match(r.text, re, JSON.stringify(req));
  }
  assert.deepEqual(calls.asked, []);
  assert.deepEqual(calls.run, []);
  assert.deepEqual(calls.host, []);
});

test('updates and chown go through host-fix, and need it to be set up', async () => {
  let t = await broker();
  let r = await t.b.handle({ tool: 'container_update', args: { name: 'sonarr', reason: 'r' } });
  assert.match(r.text, /host-fix-setup/);
  assert.deepEqual(t.calls.asked, []);

  t = await broker({ hostFix: async () => ({ code: 0, stdout: 'update_container finished with exit code 0\nimage: changed\n', stderr: '' }) });
  r = await t.b.handle({ tool: 'container_update', args: { name: 'sonarr', reason: 'Old image crashes on start.' } });
  assert.equal(r.ok, true);
  assert.match(r.text, /image: changed/);
  assert.match(t.calls.asked[0].what, /update \*\*sonarr\*\*: pull the newest image/);
  r = await t.b.handle({ tool: 'appdata_chown', args: { path: '/mnt/cache/appdata/sonarr/config/', owner: '99:100', reason: 'Permission denied in the log.' } });
  assert.equal(r.ok, true);
  assert.match(t.calls.asked[1].what, /`\/mnt\/cache\/appdata\/sonarr\/config` .* \*\*99:100\*\* \(nobody:users/);
  assert.deepEqual(t.calls.host.map(([a]) => a), ['update sonarr', 'chown 99:100 /mnt/cache/appdata/sonarr/config']);
});

test('no fixes during reports; failures and the hourly limit are reported', async () => {
  let t = await broker({ policy: () => ({ refuse: 'Fix tools are not used during reports.' }) });
  let r = await t.b.handle({ tool: 'container_restart', args: { name: 'plex' } });
  assert.match(r.text, /not used during reports/);
  assert.deepEqual(t.calls.asked, []);

  t = await broker({ runCode: 1 });
  r = await t.b.handle({ tool: 'container_start', args: { name: 'plex', reason: 'x' } });
  assert.equal(r.ok, false);
  assert.match(r.text, /docker start plex failed: boom/);

  t = await broker();
  for (let i = 0; i < MAX_FIXES_PER_HOUR; i++) assert.equal((await t.b.handle({ tool: 'container_restart', args: { name: 'plex' } })).ok, true);
  r = await t.b.handle({ tool: 'container_restart', args: { name: 'plex' } });
  assert.match(r.text, /Limit reached/);
  assert.equal(t.calls.asked.length, MAX_FIXES_PER_HOUR, 'not even asked');
  t.tick(3_600_001);
  assert.equal((await t.b.handle({ tool: 'container_restart', args: { name: 'plex' } })).ok, true);
});

test('MCP server: initialize, list, call forwarded, errors', async () => {
  const init = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.match(init.result.instructions, /Allow and Deny/);
  const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), Object.keys(FIX_TOOLS));
  assert.ok(list.result.tools.every((t) => t.inputSchema.required.includes('reason')));
  let seen;
  const call = await handleMessage(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'container_restart', arguments: { name: 'plex', reason: 'r' } } },
    { call: async (req) => { seen = req; return { ok: false, text: 'The owner tapped Deny.' }; } },
  );
  assert.deepEqual(seen, { tool: 'container_restart', args: { name: 'plex', reason: 'r' } });
  assert.deepEqual(call.result, { content: [{ type: 'text', text: 'The owner tapped Deny.' }], isError: true });
  const bad = await handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'rm' } });
  assert.equal(bad.error.code, -32602);
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal((await handleMessage({ jsonrpc: '2.0', id: 5, method: 'resources/list' })).error.code, -32601);
});

test('MCP server: an unreachable watcher means nothing changes', async () => {
  const r = await callWatcher({ tool: 'container_restart', args: {} }, { socket: join(tmpdir(), 'no-such-watch.sock'), timeoutMs: 2000 });
  assert.equal(r.ok, false);
  assert.match(r.text, /not reachable|Nothing was changed/);
});

test('socket round trip: request in, broker answer out', { skip: process.platform === 'win32' && 'unix sockets' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixsock-'));
  const path = join(dir, 'fix.sock');
  const seen = [];
  const server = await serveFixSocket(path, { handle: async (req) => { seen.push(req); return { ok: true, text: 'Restarted plex.' }; } }, { gid: process.getgid?.() ?? 0 });
  try {
    const r = await callWatcher({ tool: 'container_restart', args: { name: 'plex' } }, { socket: path, timeoutMs: 5000 });
    assert.deepEqual(r, { ok: true, text: 'Restarted plex.' });
    assert.deepEqual(seen, [{ tool: 'container_restart', args: { name: 'plex' } }]);
  } finally {
    server.close();
  }
});

test('one question to the owner at a time, and a cap on questions an hour', async () => {
  let release;
  const { b, calls } = await broker({ decision: () => new Promise((r) => { release = r; }) });
  const first = b.handle({ tool: 'container_restart', args: { name: 'sonarr', reason: 'r' } });
  await new Promise((r) => setImmediate(r));
  const second = await b.handle({ tool: 'container_restart', args: { name: 'plex', reason: 'r' } });
  assert.equal(second.ok, false);
  assert.match(second.text, /still waiting for the owner/);
  release('deny');
  assert.equal((await first).ok, false);
  assert.equal(calls.asked.length, 1);

  // Denied questions count too, so a looping run cannot flood the DMs.
  const t = await broker({ decision: 'deny' });
  for (let i = 0; i < MAX_ASKS_PER_HOUR; i++) await t.b.handle({ tool: 'container_restart', args: { name: 'sonarr', reason: 'r' } });
  const over = await t.b.handle({ tool: 'container_restart', args: { name: 'sonarr', reason: 'r' } });
  assert.match(over.text, /requests to the owner an hour/);
  assert.equal(t.calls.asked.length, MAX_ASKS_PER_HOUR);
  t.tick(3_600_001);
  await t.b.handle({ tool: 'container_restart', args: { name: 'sonarr', reason: 'r' } });
  assert.equal(t.calls.asked.length, MAX_ASKS_PER_HOUR + 1);
});

test('a Discord error while asking changes nothing; a failed result message does not hide the result', async () => {
  let t = await broker({ decision: () => { throw new Error('discord down'); } });
  let r = await t.b.handle({ tool: 'container_restart', args: { name: 'sonarr', reason: 'r' } });
  assert.equal(r.ok, false);
  assert.match(r.text, /could not be sent/);
  assert.deepEqual(t.calls.run, []);
  // The broker is free again afterwards.
  t = await broker();
  t.b.notify = async () => { throw new Error('discord down'); };
  r = await t.b.handle({ tool: 'container_restart', args: { name: 'sonarr', reason: 'r' } });
  assert.deepEqual(r, { ok: true, text: 'Restarted sonarr.' });
});
