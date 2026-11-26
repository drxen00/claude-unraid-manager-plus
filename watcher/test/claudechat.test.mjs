import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { ClaudeChats, parseTranscript, summarizeTool } from '../src/claudechat.mjs';
import { handleMessage } from '../src/fix-mcp.mjs';
import { FixBroker } from '../src/fix.mjs';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TRANSCRIPT = [
  { type: 'user', uuid: 'u1', cwd: '/workspace', version: '2.3.0', timestamp: '2026-11-26T10:00:00Z', message: { role: 'user', content: 'why is plex slow?' } },
  { type: 'assistant', uuid: 'a1', message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'docker logs plex --tail 50' } }] } },
  { type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'transcoding...', is_error: false }] } },
  { type: 'user', uuid: 'u3', isMeta: true, message: { role: 'user', content: 'meta' } },
  { type: 'assistant', uuid: 'a2', message: { id: 'msg_2', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'It is transcoding.' }] } },
].map((x) => JSON.stringify(x)).join('\n');

function fakeFs(files = {}) {
  const written = {};
  return {
    written,
    readdir: async (p, o) => {
      if (p === '/home/claude/.claude/projects') return ['-workspace'];
      if (p === '/home/claude/.claude/projects/-workspace') return Object.keys(files).map((f) => f.split('/').pop());
      if (p === '/workspace' && o?.withFileTypes) return [{ name: 'proj', isDirectory: () => true }, { name: '.hidden', isDirectory: () => true }];
      return [];
    },
    stat: async (p) => ({ mtimeMs: 1, size: (files[p] ?? '').length }),
    readFile: async (p) => files[p],
    unlink: async (p) => { delete files[p]; },
    mkdir: async () => {},
    writeFile: async (p, d) => { written[p] = d; },
    chown: async () => {},
  };
}

function setup({ files = { [`/home/claude/.claude/projects/-workspace/${ID}.jsonl`]: TRANSCRIPT } } = {}) {
  const events = [];
  const notices = [];
  const spawned = [];
  const signals = [];
  let names = {};
  const chats = new ClaudeChats({
    home: '/home/claude',
    workspace: '/workspace',
    fs: fakeFs(files),
    uid: 99,
    gid: 100,
    spawnClaude: (args, opts) => {
      const c = new EventEmitter();
      c.stdout = new EventEmitter();
      c.stderr = new EventEmitter();
      c.lines = [];
      c.stdin = { write: (d) => c.lines.push(d), on() {} };
      c.args = args;
      c.opts = opts;
      spawned.push(c);
      return c;
    },
    signal: (child, sig) => signals.push([child, sig]),
    emit: (e) => events.push(e),
    notify: (e) => notices.push(e),
    names: () => names,
    saveNames: async (n) => { names = n; },
  });
  const say = (c, obj) => c.stdout.emit('data', `${JSON.stringify(obj)}\n`);
  return { chats, events, notices, spawned, signals, say };
}

test('a transcript becomes the chat: user, assistant, tools with their results; meta lines skipped', () => {
  const t = parseTranscript(TRANSCRIPT);
  assert.deepEqual(t.items.map((i) => i.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(t.items[2].tool.summary, 'docker logs plex --tail 50');
  assert.equal(t.items[2].tool.status, 'ok');
  assert.equal(t.items[2].tool.result, 'transcoding...');
  assert.equal(t.title, 'why is plex slow?');
  assert.equal(t.model, 'opus');
  assert.equal(t.cwd, '/workspace');
});

test('sessions and history from disk', async () => {
  const { chats } = setup();
  const [s] = await chats.sessions();
  assert.equal(s.id, ID);
  assert.equal(s.title, 'why is plex slow?');
  const h = await chats.history(ID, { limit: 2 });
  assert.equal(h.total, 4);
  assert.equal(h.start, 2);
  assert.equal(h.items.length, 2);
  assert.equal((await chats.history(ID, { limit: 2, before: 2 })).start, 0);
  await assert.rejects(chats.history('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), /No such chat/);
  assert.equal((await chats.search(ID, 'transcod')).hits.length, 1);
  assert.match((await chats.exportChat(ID)).markdown, /\*\*Claude:\*\*/);
  assert.deepEqual((await chats.projectDirs()).dirs, ['/workspace', '/workspace/proj']);
});

test('a new chat: claude -p in stream-json with the Wraith permission tool, its own session id, in the workspace', async () => {
  const { chats, spawned } = setup();
  const st = await chats.open({ model: 'sonnet', effort: 'high', permissionMode: 'plan', cwd: '/workspace/proj' });
  const a = spawned[0].args;
  for (const flag of ['-p', '--verbose', '--include-partial-messages']) assert.ok(a.includes(flag), flag);
  assert.equal(a[a.indexOf('--input-format') + 1], 'stream-json');
  assert.equal(a[a.indexOf('--permission-prompt-tool') + 1], 'mcp__fix__wraith_permission');
  assert.equal(a[a.indexOf('--session-id') + 1], st.sessionId);
  assert.equal(a[a.indexOf('--model') + 1], 'sonnet');
  assert.equal(a[a.indexOf('--effort') + 1], 'high');
  assert.equal(a[a.indexOf('--permission-mode') + 1], 'plan');
  assert.equal(spawned[0].opts.cwd, '/workspace/proj');
  assert.equal(spawned[0].opts.chatId, st.sessionId);
  assert.equal(st.status, 'idle');
});

test('what a chat may not be opened with', async () => {
  const { chats } = setup();
  await assert.rejects(chats.open({ cwd: '/boot' }), /Chats run in \/workspace/);
  await assert.rejects(chats.open({ cwd: '/workspace/../etc' }), /Chats run in/);
  await assert.rejects(chats.open({ permissionMode: 'bypassPermissions' }), /not available/);
  await assert.rejects(chats.open({ model: 'rm -rf' }), /Unknown model/);
  await assert.rejects(chats.open({ effort: 'ultra' }), /Unknown effort/);
  await assert.rejects(chats.open({ resume: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }), /No such chat/);
});

test('resume keeps the id; a message goes in as a stream-json line; output becomes events', async () => {
  const { chats, spawned, events, notices, say } = setup();
  const st = await chats.open({ resume: ID });
  assert.equal(st.sessionId, ID);
  const c = spawned[0];
  assert.equal(c.args[c.args.indexOf('--resume') + 1], ID);
  assert.ok(!c.args.includes('--session-id'));
  chats.message(ID, 'and now?');
  assert.deepEqual(JSON.parse(c.lines[0]), { type: 'user', message: { role: 'user', content: 'and now?' }, parent_tool_use_id: null });
  assert.equal(chats.state(ID).status, 'working');
  say(c, { type: 'system', subtype: 'init', session_id: ID, model: 'claude-opus-5-5', cwd: '/workspace', permissionMode: 'default' });
  say(c, { type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_9' } } });
  say(c, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } } });
  say(c, { type: 'assistant', message: { id: 'msg_9', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 'tu_9', name: 'Read', input: { file_path: '/appdata/plex/Preferences.xml' } }] } });
  say(c, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_9', content: [{ type: 'text', text: '<xml/>' }] }] } });
  say(c, { type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.02, duration_ms: 1200 });
  const types = events.map((e) => e.type);
  for (const t of ['claude.item', 'claude.status', 'claude.init', 'claude.delta', 'claude.tool', 'claude.result']) assert.ok(types.includes(t), t);
  assert.equal(events.find((e) => e.type === 'claude.delta').id, 'msg_9:0');
  assert.ok(events.some((e) => e.type === 'claude.item' && e.item.id === 'msg_9:0' && e.item.text === 'Hello'));
  assert.deepEqual(events.find((e) => e.type === 'claude.tool'), { type: 'claude.tool', id: 'tu_9', status: 'ok', result: '<xml/>', session: ID });
  assert.equal(events.find((e) => e.type === 'claude.result').costUsd, 0.02);
  assert.equal(chats.state(ID).status, 'idle');
  assert.equal(notices.at(-1).reason, 'done');
  assert.ok(events.every((e) => e.session === ID));
});

test('a fork gets a new id from Claude: the chat follows it', async () => {
  const { chats, spawned, events, say } = setup();
  const st = await chats.open({ resume: ID, fork: true });
  const c = spawned[0];
  assert.ok(c.args.includes('--fork-session'));
  const NEW = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  say(c, { type: 'system', subtype: 'init', session_id: NEW, model: 'claude-opus-5-5' });
  assert.ok(events.some((e) => e.type === 'claude.switched' && e.session === st.sessionId && e.to === NEW));
  assert.equal(chats.state(NEW).sessionId, NEW);
});

test('permissions: asked in the chat, answered from Wraith, as Claude Code expects', async () => {
  const { chats, events, notices } = setup();
  const st = await chats.open({});
  chats.message(st.sessionId, 'restart plex');
  const pending = chats.permission(st.sessionId, { tool_name: 'Bash', input: { command: 'docker restart plex' } });
  const ask = events.find((e) => e.type === 'claude.permission');
  assert.equal(ask.tool, 'Bash');
  assert.equal(ask.summary, 'docker restart plex');
  assert.equal(chats.state(st.sessionId).status, 'waiting');
  assert.deepEqual(chats.state(st.sessionId).pending, [ask.requestId]);
  assert.equal(notices.at(-1).reason, 'permission');
  assert.throws(() => chats.answer('dddddddd-dddd-4ddd-8ddd-dddddddddddd', ask.requestId, 'allow'), /no longer waiting/);
  chats.answer(st.sessionId, ask.requestId, 'allow');
  assert.deepEqual(await pending, { behavior: 'allow', updatedInput: { command: 'docker restart plex' } });
  assert.ok(events.some((e) => e.type === 'claude.permissionResolved' && e.requestId === ask.requestId));
  assert.equal(chats.state(st.sessionId).status, 'working');

  const denied = chats.permission(st.sessionId, { tool_name: 'Bash', input: { command: 'rm -rf /' } });
  const ask2 = events.filter((e) => e.type === 'claude.permission').at(-1);
  chats.answer(st.sessionId, ask2.requestId, 'deny');
  assert.deepEqual(await denied, { behavior: 'deny', message: 'The owner said no.' });
});

test('no chat to ask in: denied straight away; a chat that ends denies what was waiting', async () => {
  const { chats, events } = setup();
  assert.equal((await chats.permission(null, { tool_name: 'Bash', input: {} })).behavior, 'deny');
  const st = await chats.open({});
  chats.message(st.sessionId, 'x');
  const p = chats.permission(null, { tool_name: 'Bash', input: { command: 'ls' } }); // the only working chat
  assert.ok(events.some((e) => e.type === 'claude.permission'));
  chats.end(st.sessionId);
  assert.equal((await p).behavior, 'deny');
  assert.equal(chats.state(st.sessionId), null);
});

test('settings restart Claude on the same chat; not while it works', async () => {
  const { chats, spawned, signals } = setup();
  const st = await chats.open({ resume: ID });
  chats.message(ID, 'x');
  assert.throws(() => chats.settings(ID, { model: 'haiku' }), /Wait until/);
  spawned[0].stdout.emit('data', `${JSON.stringify({ type: 'result', subtype: 'success' })}\n`);
  const next = chats.settings(ID, { model: 'haiku', permissionMode: 'acceptEdits' });
  assert.equal(signals[0][0], spawned[0]);
  assert.equal(spawned[1].args[spawned[1].args.indexOf('--resume') + 1], ID);
  assert.equal(spawned[1].args[spawned[1].args.indexOf('--model') + 1], 'haiku');
  assert.equal(next.permissionMode, 'acceptEdits');
  // The old process closing does not end the chat.
  spawned[0].emit('close', 0);
  assert.equal(chats.state(st.sessionId).status, 'idle');
  chats.interrupt(ID);
  assert.deepEqual(signals.at(-1), [spawned[1], 'SIGINT']);
});

test('uploads land in the chat folder under a safe name', async () => {
  const { chats } = setup();
  const r = await chats.upload({ name: '../../etc/passwd', cwd: '/workspace/proj', raw: Buffer.from('x') });
  assert.match(r.path, /^\/workspace\/proj\/\.wraith-uploads\/[a-z0-9]+-passwd$/);
  await assert.rejects(chats.upload({ name: 'a', cwd: '/root', raw: Buffer.from('x') }), /Chats run in/);
});

test('the permission tool: listed only with Wraith on, answers as one text block, carries the chat', async () => {
  const calls = [];
  const call = async (req) => { calls.push(req); return { ok: true, text: '{"behavior":"allow","updatedInput":{}}' }; };
  const off = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { call, wraith: false });
  assert.ok(!off.result.tools.some((t) => t.name === 'wraith_permission'));
  const on = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { call, wraith: true });
  assert.ok(on.result.tools.some((t) => t.name === 'wraith_permission'));
  const r = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'wraith_permission', arguments: { tool_name: 'Bash', input: {} } } }, { call, wraith: true, origin: ID });
  assert.deepEqual(r.result.content, [{ type: 'text', text: '{"behavior":"allow","updatedInput":{}}' }]);
  assert.equal(r.result.isError, undefined);
  assert.equal(calls[0].origin, ID);
  const no = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'wraith_permission', arguments: {} } }, { call, wraith: false });
  assert.ok(no.error);
});

test('the broker hands permission requests to the chats, outside the fix limits', async () => {
  const seen = [];
  const b = new FixBroker({
    askOwner: async () => 'deny', run: async () => ({ code: 0 }), hostFix: null, audit: async () => {},
    permission: async (origin, args) => { seen.push([origin, args]); return { behavior: 'allow', updatedInput: {} }; },
  });
  const r = await b.handle({ tool: 'wraith_permission', origin: ID, args: { tool_name: 'Bash' } });
  assert.deepEqual(JSON.parse(r.text), { behavior: 'allow', updatedInput: {} });
  assert.deepEqual(seen, [[ID, { tool_name: 'Bash' }]]);
  assert.equal(summarizeTool('Write', { file_path: '/workspace/a.md', content: 'x' }), '/workspace/a.md');
});
