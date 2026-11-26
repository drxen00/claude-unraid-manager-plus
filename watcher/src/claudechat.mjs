// The Wraith Claude channel: Claude Code on this server, as Claude's own
// unprivileged user, with the same managed settings, guard hook and MCP
// servers as the Claude app session. Each chat is one `claude -p` process in
// stream-json mode (spawnClaude in main.mjs). Tool permissions Claude would
// ask for come to the owner in the Wraith chat (--permission-prompt-tool,
// through the fix MCP server and the watcher's socket), and so do the fix
// tools' Allow / Deny questions for changes Claude asks for from this chat.
//
// Transcripts are Claude Code's own (~/.claude/projects/*/<id>.jsonl), so a
// chat started here can be resumed in the Claude app and the other way round.
import { randomBytes, randomUUID } from 'node:crypto';
// Paths are the container's (Linux), whatever the tests run on.
import { basename, join, resolve as resolvePath } from 'node:path/posix';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PERMISSION_MS = 15 * 60_000;
const MAX_LIVE = 3;
const MAX_TRANSCRIPT = 20 * 1024 * 1024;
export const MODES = ['default', 'acceptEdits', 'plan'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const MODEL_OPTIONS = [
  { id: '', label: 'Default', group: 'Default', desc: "Your account's default model" },
  { id: 'opus', label: 'Opus', group: 'Latest', desc: 'Most capable', id1m: 'opus[1m]' },
  { id: 'sonnet', label: 'Sonnet', group: 'Latest', desc: 'Fast and capable', id1m: 'sonnet[1m]' },
  { id: 'haiku', label: 'Haiku', group: 'Latest', desc: 'Fastest and cheapest' },
  { id: 'fable', label: 'Fable', group: 'Latest', desc: 'Longest-running work' },
];
const MODEL = /^(|opus|sonnet|haiku|fable|claude-[a-z0-9.-]+)(\[1m\])?$/;

const family = (m) => (/(opus|sonnet|haiku|fable)/.exec(String(m ?? '')) ?? [])[1] ?? '';

/** One line for the permission card: what the tool would do. */
export function summarizeTool(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const pick = i.command ?? i.file_path ?? i.path ?? i.url ?? i.pattern ?? i.query ?? i.description;
  const s = typeof pick === 'string' ? pick : JSON.stringify(i);
  return String(s ?? '').replace(/\s+/g, ' ').slice(0, 400);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
}

function resultText(block) {
  const c = block?.content;
  const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text ?? '').join('\n') : '';
  return t.slice(0, 4000);
}

/**
 * A Claude Code transcript (.jsonl) → what the chat shows, plus what the
 * chat list needs.
 */
export function parseTranscript(text) {
  const items = [];
  const tools = new Map();
  let cwd = null;
  let model = '';
  let modelId = '';
  let version = '';
  let summary = null;
  let firstUser = null;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'summary' && typeof e.summary === 'string') { summary = e.summary; continue; }
    if (e.cwd) cwd = e.cwd;
    if (e.version) version = e.version;
    const ts = e.timestamp ? Date.parse(e.timestamp) || null : null;
    if (e.type === 'user' && !e.isMeta) {
      const content = e.message?.content;
      for (const b of Array.isArray(content) ? content : []) {
        if (b?.type === 'tool_result' && tools.has(b.tool_use_id)) {
          const item = tools.get(b.tool_use_id);
          item.tool.status = b.is_error ? 'error' : 'ok';
          item.tool.result = resultText(b);
        }
      }
      const t = textOf(content);
      if (t && !/^<(command-|local-command|system-reminder)/.test(t.trim())) {
        items.push({ id: e.uuid ?? randomBytes(6).toString('hex'), role: 'user', text: t, ts });
        firstUser ??= t;
      }
    } else if (e.type === 'assistant') {
      const msg = e.message ?? {};
      if (msg.model && msg.model !== '<synthetic>') { modelId = msg.model; model = family(msg.model); }
      (Array.isArray(msg.content) ? msg.content : []).forEach((b, i) => {
        if (b?.type === 'text' && b.text) {
          items.push({ id: `${msg.id ?? e.uuid}:${i}`, role: 'assistant', text: b.text, ts });
        } else if (b?.type === 'tool_use') {
          const item = { id: b.id, role: 'tool', tool: { name: b.name, summary: summarizeTool(b.name, b.input), status: 'running', result: null }, ts };
          tools.set(b.id, item);
          items.push(item);
        }
      });
    }
  }
  for (const t of tools.values()) if (t.tool.status === 'running') t.tool.status = 'ok';
  const title = (summary ?? firstUser ?? 'New chat').replace(/\s+/g, ' ').trim().slice(0, 80) || 'New chat';
  return { items, cwd, model, modelId, version, title };
}

export class ClaudeChats {
  /**
   * deps: {
   *   home: Claude's home ('/home/claude'), workspace: '/workspace',
   *   fs: { readFile, readdir, stat, unlink, mkdir, writeFile, chown },
   *   spawnClaude(args, { cwd, chatId }) → child (stdin, stdout, stderr, pid, on('close')),
   *   signal(child, sig),
   *   emit(event), notify(event),   // to the linked owner: live events / phone
   *   names(): {id: name}, saveNames(names),
   *   version(): Promise<string|null>,
   *   uid, gid,
   * }
   */
  constructor(deps) {
    this.d = deps;
    this.live = new Map();
    this.pending = new Map();
    this.cache = new Map();
    this.done = new Map();
    this.inboxId = null;
  }

  get projects() { return join(this.d.home, '.claude', 'projects'); }

  // ── Transcripts ──

  async #files() {
    const out = [];
    let dirs = [];
    try { dirs = await this.d.fs.readdir(this.projects); } catch { return out; }
    for (const dir of dirs) {
      let names = [];
      try { names = await this.d.fs.readdir(join(this.projects, dir)); } catch { continue; }
      for (const n of names) {
        const id = n.replace(/\.jsonl$/, '');
        if (n.endsWith('.jsonl') && UUID.test(id)) out.push({ id, path: join(this.projects, dir, n) });
      }
    }
    return out;
  }

  async #find(id) {
    if (!UUID.test(String(id))) return null;
    return (await this.#files()).find((f) => f.id === id) ?? null;
  }

  async #read(file) {
    const st = await this.d.fs.stat(file.path);
    const hit = this.cache.get(file.path);
    if (hit && hit.mtime === st.mtimeMs) return { ...hit.parsed, mtime: st.mtimeMs };
    if (st.size > MAX_TRANSCRIPT) return { items: [], cwd: null, model: '', modelId: '', version: '', title: 'Very long chat', mtime: st.mtimeMs };
    const parsed = parseTranscript(await this.d.fs.readFile(file.path, 'utf8'));
    this.cache.set(file.path, { mtime: st.mtimeMs, parsed });
    return { ...parsed, mtime: st.mtimeMs };
  }

  async sessions() {
    const names = this.d.names();
    const list = [];
    for (const f of await this.#files()) {
      try {
        const t = await this.#read(f);
        const live = this.live.get(f.id);
        list.push({
          id: f.id, cwd: t.cwd, name: names[f.id] ?? null, title: t.title, model: t.model, modelId: t.modelId || undefined,
          permission: live?.permissionMode ?? 'default', version: t.version, ctx: 0, mtime: t.mtime, live: Boolean(live),
        });
      } catch { /* unreadable: skip */ }
    }
    // Chats started here that Claude has not written to disk yet.
    for (const c of this.live.values()) {
      if (!list.some((s) => s.id === c.id)) {
        list.push({ id: c.id, cwd: c.cwd, name: names[c.id] ?? null, title: c.title ?? 'New chat', model: family(c.model), version: '', permission: c.permissionMode, ctx: 0, mtime: Date.now(), live: true });
      }
    }
    return list.sort((a, b) => b.mtime - a.mtime);
  }

  async history(id, { limit = 200, before = null } = {}) {
    const v = this.live.get(id);
    const f = v?.virtual ? null : await this.#find(id);
    const t = v?.virtual ? { items: v.items } : f ? await this.#read(f) : { items: [] };
    if (!f && !this.live.has(id)) throw Object.assign(new Error('No such chat.'), { status: 404, code: 'not_found' });
    const total = t.items.length;
    const end = before === null || before === undefined || before === '' ? total : Math.max(0, Math.min(total, Number(before) || 0));
    const n = Math.max(1, Math.min(500, Number(limit) || 200));
    const start = Math.max(0, end - n);
    return { items: t.items.slice(start, end), total, start, state: this.state(id) };
  }

  async exportChat(id) {
    const f = await this.#find(id);
    if (!f) throw Object.assign(new Error('No such chat.'), { status: 404, code: 'not_found' });
    const t = await this.#read(f);
    const md = t.items.map((x) => (x.role === 'tool'
      ? `> **${x.tool.name}** ${x.tool.summary}`
      : `**${x.role === 'user' ? 'You' : 'Claude'}:**\n\n${x.text}`)).join('\n\n');
    return { markdown: `# ${t.title}\n\n${md}\n` };
  }

  async search(id, q) {
    const f = await this.#find(id);
    if (!f) throw Object.assign(new Error('No such chat.'), { status: 404, code: 'not_found' });
    const needle = String(q ?? '').toLowerCase().trim();
    if (!needle) return { hits: [] };
    const t = await this.#read(f);
    const hits = [];
    t.items.forEach((x, i) => {
      const s = x.role === 'tool' ? `${x.tool.name} ${x.tool.summary}` : x.text ?? '';
      const at = s.toLowerCase().indexOf(needle);
      if (at >= 0 && hits.length < 50) hits.push({ i, role: x.role, snippet: s.slice(Math.max(0, at - 60), at + 120) });
    });
    return { hits };
  }

  async rename(id, name) {
    if (!UUID.test(String(id))) throw Object.assign(new Error('No such chat.'), { status: 404, code: 'not_found' });
    const names = { ...this.d.names() };
    const n = String(name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
    if (n) names[id] = n; else delete names[id];
    await this.d.saveNames(names);
    return { ok: true };
  }

  async remove(id) {
    if (id === this.inboxId) throw Object.assign(new Error('The Approvals list cannot be deleted.'), { status: 400, code: 'inbox' });
    const f = await this.#find(id);
    if (this.live.has(id)) this.end(id, 'deleted');
    if (f) await this.d.fs.unlink(f.path);
    await this.rename(id, '');
    return { ok: true };
  }

  async projectDirs() {
    const ws = this.d.workspace;
    const dirs = [ws];
    try {
      for (const e of await this.d.fs.readdir(ws, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith('.')) dirs.push(join(ws, e.name));
      }
    } catch { /* none */ }
    return { dirs, home: ws };
  }

  /** Inside the workspace, or the workspace itself. */
  #cwd(raw) {
    const ws = this.d.workspace;
    const p = resolvePath(ws, String(raw || ws));
    if (p !== ws && !p.startsWith(`${ws}/`)) throw Object.assign(new Error(`Chats run in ${ws} or a folder in it.`), { status: 400, code: 'bad_cwd' });
    return p;
  }

  // ── Live chats ──

  state(id) {
    const c = this.live.get(id);
    if (!c) return null;
    return {
      sessionId: c.id, status: c.status, model: family(c.modelId || c.model), modelId: c.modelId || undefined,
      permissionMode: c.permissionMode, effort: c.effort, cwd: c.cwd, pending: [...c.pending],
    };
  }

  options() {
    return {
      models: MODEL_OPTIONS.map((m) => m.id),
      modelOptions: MODEL_OPTIONS,
      permissionModes: MODES,
      efforts: EFFORTS,
      live: [...this.live.keys()].map((id) => this.state(id)),
    };
  }

  #emit(c, event) {
    this.d.emit({ ...event, session: c.id });
  }

  async open(body = {}) {
    const resume = body.resume ? String(body.resume) : null;
    if (resume && !body.fork && this.live.has(resume)) return this.state(resume);
    if (resume && !(await this.#find(resume))) throw Object.assign(new Error('No such chat.'), { status: 404, code: 'not_found' });
    if ([...this.live.values()].filter((x) => !x.virtual).length >= MAX_LIVE) throw Object.assign(new Error(`At most ${MAX_LIVE} chats can run at once. End one first.`), { status: 409, code: 'too_many' });
    const model = String(body.model ?? '');
    if (!MODEL.test(model)) throw Object.assign(new Error('Unknown model.'), { status: 400, code: 'bad_model' });
    const effort = body.effort ? String(body.effort) : '';
    if (effort && !EFFORTS.includes(effort)) throw Object.assign(new Error('Unknown effort level.'), { status: 400, code: 'bad_effort' });
    const permissionMode = body.permissionMode ? String(body.permissionMode) : 'default';
    if (!MODES.includes(permissionMode)) throw Object.assign(new Error('That permission mode is not available here.'), { status: 400, code: 'bad_mode' });
    let cwd = this.#cwd(body.cwd);
    if (resume) {
      const t = await this.#read(await this.#find(resume));
      if (t.cwd) cwd = this.#cwd(t.cwd);
    }
    const id = resume && !body.fork ? resume : randomUUID();
    const c = { id, cwd, model, modelId: '', effort, permissionMode, status: 'idle', pending: new Set(), child: null, stderr: '', blocks: new Map(), msg: null };
    this.live.set(id, c);
    this.#spawn(c, { resume, fork: Boolean(body.fork && resume) });
    return this.state(id);
  }

  #args(c, { resume, fork }) {
    const a = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--permission-prompt-tool', 'mcp__fix__wraith_permission', '--permission-mode', c.permissionMode];
    if (resume) a.push('--resume', resume);
    if (fork) a.push('--fork-session');
    if (!resume || fork) a.push('--session-id', c.id);
    if (c.model) a.push('--model', c.model);
    if (c.effort) a.push('--effort', c.effort);
    return a;
  }

  #spawn(c, how) {
    const child = this.d.spawnClaude(this.#args(c, how), { cwd: c.cwd, chatId: c.id });
    c.child = child;
    let buf = '';
    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) this.#onLine(c, line);
      }
    });
    child.stderr?.setEncoding?.('utf8');
    child.stderr?.on('data', (d) => { c.stderr = (c.stderr + d).slice(-2000); });
    child.stdin.on?.('error', () => {});
    child.on('close', (code) => {
      if (c.child !== child) return; // replaced by a settings change
      this.#closed(c, code === 0 || code === null ? 'ended' : `Claude stopped (exit ${code})${c.stderr ? `: ${c.stderr.trim().split('\n').pop()}` : ''}`);
    });
  }

  #closed(c, reason) {
    c.child = null;
    for (const rid of c.pending) this.#resolvePermission(rid, 'deny', 'The chat ended.');
    this.live.delete(c.id);
    c.status = 'closed';
    this.#emit(c, { type: 'claude.status', status: 'closed', reason });
  }

  #status(c, status) {
    if (c.status === status) return;
    c.status = status;
    this.#emit(c, { type: 'claude.status', status });
  }

  #onLine(c, line) {
    let e;
    try { e = JSON.parse(line); } catch { return; }
    if (e.type === 'system' && e.subtype === 'init') {
      if (e.session_id && e.session_id !== c.id && UUID.test(e.session_id)) {
        // A fork, or a /clear: the chat lives on under a new id.
        const old = c.id;
        this.live.delete(old);
        c.id = e.session_id;
        this.live.set(c.id, c);
        this.d.emit({ type: 'claude.switched', session: old, to: c.id });
      }
      if (e.model) c.modelId = e.model;
      if (e.permissionMode && MODES.includes(e.permissionMode)) c.permissionMode = e.permissionMode;
      this.#emit(c, { type: 'claude.init', model: family(e.model) || e.model, cwd: e.cwd ?? c.cwd, permissionMode: c.permissionMode });
    } else if (e.type === 'stream_event') {
      const ev = e.event ?? {};
      if (ev.type === 'message_start') c.msg = ev.message?.id ?? null;
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && c.msg) {
        this.#emit(c, { type: 'claude.delta', id: `${c.msg}:${ev.index ?? 0}`, text: ev.delta.text ?? '' });
      }
    } else if (e.type === 'assistant') {
      const msg = e.message ?? {};
      if (msg.model && msg.model !== '<synthetic>') c.modelId = msg.model;
      (Array.isArray(msg.content) ? msg.content : []).forEach((b, i) => {
        if (b?.type === 'text' && b.text) {
          this.#emit(c, { type: 'claude.item', item: { id: `${msg.id}:${i}`, role: 'assistant', text: b.text, ts: Date.now() } });
        } else if (b?.type === 'tool_use') {
          this.#emit(c, { type: 'claude.item', item: { id: b.id, role: 'tool', tool: { name: b.name, summary: summarizeTool(b.name, b.input), status: 'running', result: null }, ts: Date.now() } });
        }
      });
    } else if (e.type === 'user') {
      for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
        if (b?.type === 'tool_result') this.#emit(c, { type: 'claude.tool', id: b.tool_use_id, status: b.is_error ? 'error' : 'ok', result: resultText(b) });
      }
    } else if (e.type === 'result') {
      const ok = !e.is_error && (e.subtype === 'success' || e.subtype === undefined);
      this.#emit(c, { type: 'claude.result', ok, costUsd: e.total_cost_usd ?? null, durationMs: e.duration_ms ?? null, error: ok ? null : String(e.result ?? e.subtype ?? 'error').slice(0, 300) });
      this.#status(c, 'idle');
      const hook = this.done.get(c.id);
      if (hook) {
        this.done.delete(c.id);
        Promise.resolve(hook({ ok, text: typeof e.result === 'string' ? e.result : '' })).catch(() => {});
        return; // the hook tells the owner itself
      }
      this.d.notify({ type: 'claude.attention', session: c.id, reason: 'done', title: this.d.names()[c.id] ?? 'Claude chat', detail: ok ? 'Claude finished' : 'Claude stopped with an error' });
    }
  }

  message(id, text) {
    const c = this.live.get(id);
    if (c?.virtual) throw Object.assign(new Error('This is your Approvals list: questions from outside a Wraith chat land here. Start a new chat to talk to Claude.'), { status: 409, code: 'inbox' });
    if (!c?.child) throw Object.assign(new Error('That chat is not running. Open it again.'), { status: 409, code: 'not_running' });
    const t = String(text ?? '');
    if (!t.trim()) throw Object.assign(new Error('Type a message.'), { status: 400, code: 'empty' });
    if (t.length > 100_000) throw Object.assign(new Error('That message is too long.'), { status: 400, code: 'too_long' });
    c.child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: t }, parent_tool_use_id: null })}\n`);
    this.#emit(c, { type: 'claude.item', item: { id: `u-${randomBytes(6).toString('hex')}`, role: 'user', text: t, ts: Date.now() } });
    this.#status(c, 'working');
    return { ok: true };
  }

  /** fn({ ok, text }) once, when this chat's current turn ends. */
  whenDone(id, fn) {
    this.done.set(id, fn);
  }

  interrupt(id) {
    const c = this.live.get(id);
    if (!c?.child) return { ok: false };
    this.d.signal(c.child, 'SIGINT');
    return { ok: true };
  }

  end(id, reason = 'ended') {
    const c = this.live.get(id);
    if (!c || c.virtual) return { ok: true };
    const child = c.child;
    this.#closed(c, reason);
    if (child) this.d.signal(child, 'SIGTERM');
    return { ok: true };
  }

  /** Model, effort or mode: Claude restarts on the same chat with the new choice. */
  settings(id, patch = {}) {
    const c = this.live.get(id);
    if (c?.virtual) throw Object.assign(new Error('This is your Approvals list, not a chat.'), { status: 409, code: 'inbox' });
    if (!c) throw Object.assign(new Error('That chat is not running.'), { status: 409, code: 'not_running' });
    if (c.status !== 'idle') throw Object.assign(new Error('Wait until Claude has finished, then change it.'), { status: 409, code: 'busy' });
    if (patch.model !== undefined) {
      if (!MODEL.test(String(patch.model))) throw Object.assign(new Error('Unknown model.'), { status: 400, code: 'bad_model' });
      c.model = String(patch.model);
      c.modelId = '';
    }
    if (patch.effort !== undefined) {
      if (patch.effort && !EFFORTS.includes(patch.effort)) throw Object.assign(new Error('Unknown effort level.'), { status: 400, code: 'bad_effort' });
      c.effort = String(patch.effort ?? '');
    }
    if (patch.permissionMode !== undefined) {
      if (!MODES.includes(patch.permissionMode)) throw Object.assign(new Error('That permission mode is not available here.'), { status: 400, code: 'bad_mode' });
      c.permissionMode = patch.permissionMode;
    }
    const old = c.child;
    c.child = null;
    if (old) this.d.signal(old, 'SIGTERM');
    this.#spawn(c, { resume: c.id, fork: false });
    this.#emit(c, { type: 'claude.settings', model: c.model, permissionMode: c.permissionMode });
    return this.state(id);
  }

  // ── Questions to the owner ──

  /**
   * The Approvals list: a chat-shaped list in the Claude channel for
   * questions that come from outside a Wraith chat (the Claude app, the
   * watcher's own runs). No Claude runs behind it.
   */
  inbox() {
    let c = this.inboxId && this.live.get(this.inboxId);
    if (!c) {
      const id = randomUUID();
      c = { id, cwd: this.d.workspace, model: '', modelId: '', effort: '', permissionMode: 'default', status: 'idle', pending: new Set(), child: null, stderr: '', virtual: true, title: 'Approvals', items: [] };
      this.live.set(id, c);
      this.inboxId = id;
    }
    return c;
  }

  /** The chat a question belongs to: the one named, else the only one working. */
  chatFor(origin) {
    if (origin && this.live.has(origin)) return this.live.get(origin);
    const working = [...this.live.values()].filter((c) => !c.virtual && (c.status === 'working' || c.status === 'waiting'));
    return working.length === 1 ? working[0] : null;
  }

  /**
   * Ask the owner in the chat. Resolves 'allow' | 'deny' | 'timeout', or
   * null when there is no chat to ask in.
   */
  ask(origin, { tool, summary, inbox = false }) {
    const c = this.chatFor(origin) ?? (inbox ? this.inbox() : null);
    if (!c) return null;
    if (c.virtual) {
      // The list keeps what was asked, so it can be read later.
      const item = { id: `q-${randomBytes(6).toString('hex')}`, role: 'assistant', text: `**${tool}**\n\n${summary}`, ts: Date.now() };
      c.items.push(item);
      while (c.items.length > 200) c.items.shift();
      this.#emit(c, { type: 'claude.item', item });
    }
    const requestId = randomBytes(9).toString('hex');
    c.pending.add(requestId);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.#resolvePermission(requestId, 'timeout'), PERMISSION_MS);
      timer.unref?.();
      this.pending.set(requestId, { chat: c, resolve, timer });
      this.#status(c, 'waiting');
      this.#emit(c, { type: 'claude.permission', requestId, tool, summary, canAlways: false });
      this.d.notify({ type: 'claude.attention', session: c.id, reason: 'permission', title: this.d.names()[c.id] ?? 'Claude chat', detail: `${tool}: ${summary}`.slice(0, 200) });
    });
  }

  #resolvePermission(requestId, decision) {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    clearTimeout(p.timer);
    p.chat.pending.delete(requestId);
    this.#emit(p.chat, { type: 'claude.permissionResolved', requestId });
    if (!p.chat.pending.size && p.chat.status === 'waiting') this.#status(p.chat, p.chat.virtual ? 'idle' : 'working');
    p.resolve(decision);
    return true;
  }

  /** The owner's tap in Wraith: allow, always (treated as allow) or deny. */
  answer(id, requestId, decision) {
    const p = this.pending.get(String(requestId));
    if (!p || p.chat.id !== id) throw Object.assign(new Error('That question is no longer waiting.'), { status: 404, code: 'not_found' });
    this.#resolvePermission(String(requestId), decision === 'allow' || decision === 'always' ? 'allow' : 'deny');
    return { ok: true };
  }

  /** --permission-prompt-tool: Claude wants to use a tool its rules do not allow outright. */
  async permission(origin, { tool_name: toolName, input }) {
    const name = String(toolName ?? 'a tool');
    const decision = await this.ask(origin, { tool: name, summary: summarizeTool(name, input) });
    if (decision === 'allow') return { behavior: 'allow', updatedInput: input && typeof input === 'object' ? input : {} };
    const why = decision === null ? 'There is no Wraith chat to ask the owner in.' : decision === 'timeout' ? 'The owner did not answer within 15 minutes.' : 'The owner said no.';
    return { behavior: 'deny', message: why };
  }

  async upload({ name, cwd, raw }) {
    const dir = join(this.#cwd(cwd), '.wraith-uploads');
    const safe = basename(String(name ?? 'file')).replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
    const path = join(dir, `${Date.now().toString(36)}-${safe}`);
    await this.d.fs.mkdir(dir, { recursive: true });
    await this.d.fs.chown(dir, this.d.uid, this.d.gid).catch(() => {});
    await this.d.fs.writeFile(path, raw ?? Buffer.alloc(0), { mode: 0o644 });
    await this.d.fs.chown(path, this.d.uid, this.d.gid).catch(() => {});
    return { path };
  }
}
