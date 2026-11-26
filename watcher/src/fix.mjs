// The fix tools: the only way Claude can change anything. Claude calls them
// through fix-mcp.mjs, which forwards each call over a Unix socket to the
// watcher (root). The watcher checks the request, asks the owner in Discord
// ("Claude wants to update sonarr · Allow · Deny"), waits for the tap, and
// only then runs a fixed command it owns: docker start/stop/restart through
// the socket proxy, or update/chown through host-fix on the Unraid host over
// SSH with a key only the watcher can read. Claude's user can connect to the
// socket, but it can only ask: nothing runs without the owner's tap.
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { chmod, chown, unlink } from 'node:fs/promises';
import { OWN_CONTAINERS } from './checks.mjs';

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const OWNER = /^\d{1,5}:\d{1,5}$/;
const SEG = '[A-Za-z0-9_.@+=,:-]+';
const APPDATA_PATH = new RegExp(`^/mnt/[A-Za-z0-9_.-]+/[A-Za-z0-9_-]+/${SEG}(/${SEG})*$`);
// A file: at least one level below the container's own appdata folder.
const APPDATA_FILE = new RegExp(`^/mnt/[A-Za-z0-9_.-]+/[A-Za-z0-9_-]+/${SEG}(/${SEG})+$`);
// Short enough that the whole command fits in one Discord message with the question.
export const MAX_COMMAND = 1500;
export const MAX_EDIT_TEXT = 8000;
// The host-fix version that has exec, read and write.
export const HOST_FIX_FILES = 2;
export const APPROVAL_MS = 15 * 60_000;
export const MAX_FIXES_PER_HOUR = 10;
// Questions to the owner, allowed or not: keeps a looping run from flooding
// their DMs.
export const MAX_ASKS_PER_HOUR = 30;

const nameArg = { type: 'string', description: 'The container name exactly as docker ps shows it.' };
const reasonArg = { type: 'string', description: 'One plain sentence for the owner: why this helps. They see it before they decide.' };

function own(name) {
  return OWN_CONTAINERS.has(name) || name.startsWith('claude-unraid-manager') || name.startsWith('claude-docker-proxy');
}

function checkContainer(args, { containers }) {
  const name = String(args.name ?? '').trim();
  if (!NAME.test(name)) return { error: `"${name}" is not a container name.` };
  if (own(name)) return { error: `${name} is part of this tool; the owner manages it on the Docker tab.` };
  if (containers.length && !containers.some((c) => c.name === name)) return { error: `There is no container named ${name}. Check docker ps.` };
  return { args: { name } };
}

function dockerTool(verb, label, done) {
  return {
    description: `${label} one container through the Docker proxy. The owner must tap Allow in Discord first (up to 15 minutes).`,
    inputSchema: { type: 'object', properties: { name: nameArg, reason: reasonArg }, required: ['name', 'reason'] },
    check: checkContainer,
    what: (a) => `${verb} **${a.name}**`,
    async exec(a, { run }) {
      const r = await run('docker', [verb, a.name], { timeoutMs: 120_000 });
      const out = (r.stderr || r.stdout).trim().slice(-500);
      return r.code === 0 ? { ok: true, text: `${done} ${a.name}.` } : { ok: false, text: `docker ${verb} ${a.name} failed: ${out || `exit ${r.code}`}` };
    },
  };
}

export const FIX_TOOLS = {
  container_restart: dockerTool('restart', 'Restart', 'Restarted'),
  container_start: dockerTool('start', 'Start', 'Started'),
  container_stop: dockerTool('stop', 'Stop', 'Stopped'),
  container_update: {
    description:
      "Update one container the way Unraid's Docker tab does: pull the newest image and re-create the container from its Unraid template. Its settings and data stay; it restarts. Only for containers installed from the Docker tab. The owner must tap Allow in Discord first.",
    inputSchema: { type: 'object', properties: { name: nameArg, reason: reasonArg }, required: ['name', 'reason'] },
    needsHost: true,
    check: checkContainer,
    what: (a) => `update **${a.name}**: pull the newest image and re-create it from its Unraid template (like Update on the Docker tab; settings and data stay)`,
    async exec(a, { hostFix }) {
      const r = await hostFix(['update', a.name], 15 * 60_000);
      return { ok: r.code === 0, text: (r.stdout + r.stderr).trim().slice(-1500) || `exit ${r.code}` };
    },
  },
  appdata_chown: {
    description:
      'Change the owner of a folder below a container\'s appdata folder, and everything in it, e.g. after "permission denied" in its logs. Path like /mnt/user/appdata/sonarr or /mnt/cache/appdata/sonarr/config. Owner as uid:gid, usually the container\'s PUID:PGID (99:100 = nobody:users, the Unraid default). The owner must tap Allow in Discord first.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Folder below /mnt/<user|pool>/<appdata>/<app>.' },
        owner: { type: 'string', description: 'uid:gid, e.g. 99:100.' },
        reason: reasonArg,
      },
      required: ['path', 'owner', 'reason'],
    },
    needsHost: true,
    check(args) {
      const path = String(args.path ?? '').trim().replace(/\/+$/, '');
      const owner = String(args.owner ?? '99:100').trim();
      if (!APPDATA_PATH.test(path) || path.includes('..')) return { error: `${path} is not a folder below /mnt/<user|pool>/<appdata>/<app>.` };
      if (!OWNER.test(owner)) return { error: 'owner must be numeric uid:gid, e.g. 99:100.' };
      const app = path.split('/')[4];
      if (own(app)) return { error: "This tool's own data is not changed from here." };
      return { args: { path, owner } };
    },
    what: (a) => `give \`${a.path}\` and everything in it to owner **${a.owner}**${a.owner === '99:100' ? ' (nobody:users, the Unraid default)' : ''}`,
    async exec(a, { hostFix }) {
      const r = await hostFix(['chown', a.owner, a.path], 5 * 60_000);
      return { ok: r.code === 0, text: (r.stdout + r.stderr).trim().slice(-1500) || `exit ${r.code}` };
    },
  },
};

/**
 * Writable folders a container has outside appdata (media shares, array
 * disks): a command run inside it could change files there. From
 * `docker inspect --format '{{json .Mounts}}'`.
 */
export function writableOutsideAppdata(mountsJson) {
  let mounts;
  try {
    mounts = JSON.parse(mountsJson);
  } catch {
    return null;
  }
  if (!Array.isArray(mounts)) return null;
  return mounts
    .filter((m) => m && m.Type === 'bind' && m.RW !== false && typeof m.Source === 'string')
    .map((m) => m.Source)
    .filter((src) => src.startsWith('/mnt/') && !/^\/mnt\/[^/]+\/appdata(\/|$)/.test(src));
}

/** Old and new text as a short diff for the Allow question. */
export function editDiff(oldText, newText, max = 1200) {
  const lines = [
    ...oldText.split('\n').map((l) => `- ${l}`),
    ...newText.split('\n').map((l) => `+ ${l}`),
  ];
  let out = '';
  let shown = 0;
  for (const l of lines) {
    if (out.length + l.length + 1 > max) break;
    out += `${l}\n`;
    shown++;
  }
  if (shown < lines.length) out += `… ${lines.length - shown} more line${lines.length - shown === 1 ? '' : 's'}\n`;
  return out.replace(/```/g, "'''");
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// A host-fix too old for exec/read/write answers "unknown command".
function hostFixText(r, fallback) {
  const out = (r.stdout + r.stderr).trim();
  if (/unknown command '(exec|read|write)'/.test(out)) {
    return 'The host-fix script on the Unraid flash drive is older than this feature. Tell the owner: in the Unraid terminal run "docker exec -it claude-unraid-manager host-fix-setup" and repeat step 1 (copy the script).';
  }
  return out || fallback;
}

FIX_TOOLS.container_exec = {
  description:
    'Run one shell command inside a running container (sh -c, as the container\'s own user), to look at something the logs and docker inspect do not show or to fix it: a config value, a database check, a cache to clear. Output and exit code come back (2 minutes, 64 KB at most). The owner sees the exact command and must tap Allow in Discord first. Prefer read-only commands; a command can reach everything the container has mounted.',
  inputSchema: {
    type: 'object',
    properties: {
      name: nameArg,
      command: { type: 'string', description: `The command for sh -c inside the container, at most ${MAX_COMMAND} characters. Keep it short and readable: the owner reads it before deciding.` },
      reason: reasonArg,
    },
    required: ['name', 'command', 'reason'],
  },
  needsHost: true,
  check(args, deps) {
    const c = checkContainer(args, deps);
    if (c.error) return c;
    const command = String(args.command ?? '').trim();
    if (!command) return { error: 'The command is empty.' };
    if (command.length > MAX_COMMAND) return { error: `The command is longer than ${MAX_COMMAND} characters. Split it up.` };
    if (command.includes('\0')) return { error: 'The command contains a NUL byte.' };
    return { args: { name: c.args.name, command } };
  },
  // The owner should know what the container can reach before saying yes.
  async prepare(a, { run }) {
    const r = await run('docker', ['inspect', '--format', '{{json .Mounts}}', a.name], { timeoutMs: 15_000 });
    const outside = r.code === 0 ? writableOutsideAppdata(r.stdout.trim()) : null;
    return { args: { outside } };
  },
  what: (a) => `run a command inside **${a.name}**`,
  detail(a) {
    const warn = a.outside === null
      ? '\n⚠️ Could not check which folders this container can write to.'
      : a.outside.length
        ? `\n⚠️ **${a.name} can write to ${a.outside.slice(0, 4).map((s) => `\`${s}\``).join(', ')}${a.outside.length > 4 ? ` and ${a.outside.length - 4} more` : ''}.** This command could change or delete files there, including on the array.`
        : '';
    return `${'```'}sh\n${a.command.replace(/```/g, "'''")}\n${'```'}${warn}`;
  },
  async exec(a, { hostFix }) {
    const r = await hostFix(['exec', a.name], 150_000, a.command);
    const text = hostFixText(r, `exit ${r.code}`);
    return { ok: r.code === 0, text: text.length > 8000 ? `…${text.slice(-8000)}` : text };
  },
};

FIX_TOOLS.appdata_edit = {
  description:
    "Change one piece of text in a config file below a container's appdata folder, e.g. a wrong port, path or setting. Give the file's path on the Unraid host (like /mnt/user/appdata/sonarr/config.xml; docker inspect shows where a container's /config really is), the exact text to replace (it must appear exactly once in the file, so include enough around it) and the new text. The owner sees the change as a diff and must tap Allow in Discord first. A backup copy is kept next to the file. Restart the container afterwards if it only reads its config at start.",
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The file, below /mnt/<user|pool>/<appdata>/<app>/.' },
      old_text: { type: 'string', description: 'The exact text to replace, as it is in the file now. Must appear exactly once.' },
      new_text: { type: 'string', description: 'The text to put in its place.' },
      reason: reasonArg,
    },
    required: ['path', 'old_text', 'new_text', 'reason'],
  },
  needsHost: true,
  check(args) {
    const path = String(args.path ?? '').trim();
    if (!APPDATA_FILE.test(path) || path.includes('..')) return { error: `${path} is not a file below /mnt/<user|pool>/<appdata>/<app>/.` };
    const app = path.split('/')[4];
    if (own(app)) return { error: "This tool's own data is not changed from here." };
    const oldText = typeof args.old_text === 'string' ? args.old_text : '';
    const newText = typeof args.new_text === 'string' ? args.new_text : '';
    if (!oldText) return { error: 'old_text is empty: give the exact text to replace.' };
    if (oldText === newText) return { error: 'old_text and new_text are the same: nothing would change.' };
    if (oldText.length > MAX_EDIT_TEXT || newText.length > MAX_EDIT_TEXT) return { error: `old_text and new_text may be at most ${MAX_EDIT_TEXT} characters each.` };
    return { args: { path, oldText, newText } };
  },
  // Read the file first: the edit must apply exactly once, and the write
  // only goes through if the file is still what was read.
  async prepare(a, { hostFix }) {
    const r = await hostFix(['read', a.path], 30_000);
    if (r.code !== 0) return { error: `Could not read ${a.path}: ${hostFixText(r, `exit ${r.code}`).slice(-500)}` };
    const content = r.stdout;
    const count = content.split(a.oldText).length - 1;
    if (count === 0) return { error: `old_text was not found in ${a.path}. Read the file again and copy the text exactly (spaces and line breaks too).` };
    if (count > 1) return { error: `old_text appears ${count} times in ${a.path}. Include more of the text around it so it appears exactly once.` };
    return { args: { sha: sha256(content), content: content.replace(a.oldText, () => a.newText) } };
  },
  what: (a) => `edit \`${a.path}\``,
  detail: (a) => `${'```'}diff\n${editDiff(a.oldText, a.newText)}${'```'}\n_A backup copy is kept next to the file._`,
  async exec(a, { hostFix }) {
    const r = await hostFix(['write', a.path, a.sha], 60_000, a.content);
    return { ok: r.code === 0, text: hostFixText(r, `exit ${r.code}`).slice(-1500) };
  },
};

export const FIX_HELP =
  'Changes go through these tools only. Every call is shown to the owner in Discord with Allow and Deny and waits for their tap (up to 15 minutes), so give a clear reason, change one thing at a time, and check the result afterwards.';

/**
 * Checks a request, asks the owner, runs it if allowed.
 *   askOwner({ tool, what, reason, source }) → 'allow' | 'deny' | 'timeout'
 *   exec deps: { run, hostFix } (hostFix null when host-fix is not set up)
 *   policy() → { refuse?: text, source: label }
 */
export class FixBroker {
  // permission(origin, args): the Wraith chat's --permission-prompt-tool, answered
  // by the owner in that chat (claudechat.mjs). Not a fix: no limits apply.
  constructor({ askOwner, run, hostFix, audit, containers = () => [], policy = () => ({ source: '' }), now = () => Date.now(), notify = async () => {}, permission = null }) {
    Object.assign(this, { askOwner, run, hostFix, audit, containers, policy, now, notify, permission });
    this.done = [];
    this.asked = [];
    this.waiting = false;
  }

  async handle(req) {
    const name = String(req?.tool ?? '');
    // origin: the Wraith chat the request came from (WRAITH_CHAT_ID), if any.
    const origin = typeof req?.origin === 'string' ? req.origin : null;
    if (name === 'wraith_permission') {
      if (!this.permission) return { ok: true, text: JSON.stringify({ behavior: 'deny', message: 'Wraith is not set up on this server.' }) };
      const r = await this.permission(origin, req.args ?? {});
      return { ok: true, text: JSON.stringify(r) };
    }
    const tool = Object.hasOwn(FIX_TOOLS, name) ? FIX_TOOLS[name] : null;
    if (!tool) return { ok: false, text: `Unknown fix tool "${name}".` };
    const p = this.policy();
    if (p.refuse) return { ok: false, text: p.refuse };
    if (tool.needsHost && !this.hostFix) {
      return { ok: false, text: 'This fix needs the host-fix setup on the Unraid host, which is not done yet. Tell the owner: in the Unraid terminal run "docker exec -it claude-unraid-manager host-fix-setup" and follow the steps.' };
    }
    const c = tool.check(req.args ?? {}, { containers: this.containers() });
    if (c.error) return { ok: false, text: c.error };
    const hourAgo = this.now() - 3_600_000;
    this.done = this.done.filter((t) => t > hourAgo);
    if (this.done.length >= MAX_FIXES_PER_HOUR) return { ok: false, text: `Limit reached: at most ${MAX_FIXES_PER_HOUR} changes an hour. Nothing was changed.` };
    this.asked = this.asked.filter((t) => t > hourAgo);
    if (this.asked.length >= MAX_ASKS_PER_HOUR) return { ok: false, text: `Limit reached: at most ${MAX_ASKS_PER_HOUR} requests to the owner an hour. Nothing was changed.` };
    // One question at a time: the owner decides on one change, then the next.
    if (this.waiting) return { ok: false, text: 'Another change is still waiting for the owner. Wait for that answer, then ask again. Nothing was changed.' };

    const reason = String(req.args?.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    this.waiting = true;
    let args = c.args;
    let what;
    let detail;
    let decision;
    try {
      // Some tools look first (mounts, the file's current content): that
      // can still turn the request down before the owner is asked.
      if (tool.prepare) {
        const prep = await tool.prepare(c.args, { run: this.run, hostFix: this.hostFix });
        if (prep.error) return { ok: false, text: `${prep.error} Nothing was changed.` };
        args = { ...c.args, ...prep.args };
      }
      what = tool.what(args);
      detail = tool.detail ? tool.detail(args) : '';
      this.asked.push(this.now());
      decision = await this.askOwner({ tool: name, what, detail, reason, source: p.source, origin });
    } catch (err) {
      decision = 'error';
      console.error(`unraid-watch: could not ask the owner: ${err.message ?? err}`);
    } finally {
      this.waiting = false;
    }
    // Long texts (a command, an edit) are cut for the log; the change itself is not.
    const logged = Object.fromEntries(Object.entries(c.args).map(([k, v]) => [k, typeof v === 'string' && v.length > 300 ? `${v.slice(0, 300)}…` : v]));
    const entry = { action: `fix.${name}`, target: c.args.name ?? c.args.path, args: logged, reason };
    if (decision !== 'allow') {
      await this.audit({ who: 'owner', ...entry, result: { deny: 'denied', error: 'not asked (Discord error)' }[decision] ?? 'no answer' });
      if (decision === 'deny') return { ok: false, text: 'The owner tapped Deny. Nothing was changed. Do not ask for the same change again; explain other options instead.' };
      if (decision === 'error') return { ok: false, text: 'The question could not be sent to the owner on Discord. Nothing was changed.' };
      return { ok: false, text: 'The owner did not answer within 15 minutes. Nothing was changed.' };
    }
    this.done.push(this.now());
    let r;
    try {
      r = await tool.exec(args, { run: this.run, hostFix: this.hostFix });
    } catch (err) {
      r = { ok: false, text: String(err.message ?? err) };
    }
    await this.audit({ who: 'owner', ...entry, result: r.ok ? 'ok' : 'failed', output: r.text.slice(-300) });
    try {
      await this.notify(`${r.ok ? '✅' : '⚠️'} ${what.replace(/\*\*/g, '')}: ${r.ok ? 'done' : 'failed'}.\n${'```'}\n${r.text.slice(-800).replace(/```/g, "'''")}\n${'```'}`);
    } catch (err) {
      console.error(`unraid-watch: could not report a fix result: ${err.message ?? err}`);
    }
    return r;
  }
}

// One JSON request per connection, one JSON answer back. Readable and
// writable by root and Claude's group only.
export async function serveFixSocket(path, broker, { gid = 100 } = {}) {
  await unlink(path).catch(() => {});
  const server = createServer((conn) => {
    let buf = '';
    let answered = false;
    conn.setEncoding('utf8');
    conn.on('data', async (d) => {
      buf += d;
      // An edit carries old and new text (8000 characters each, escaped).
      if (buf.length > 65_536) {
        conn.end(JSON.stringify({ ok: false, text: 'request too large' }) + '\n');
        return;
      }
      const nl = buf.indexOf('\n');
      if (nl < 0 || answered) return;
      answered = true;
      let res;
      try {
        res = await broker.handle(JSON.parse(buf.slice(0, nl)));
      } catch (err) {
        res = { ok: false, text: `bad request: ${err.message}` };
      }
      if (!conn.destroyed) conn.end(JSON.stringify(res) + '\n');
    });
    conn.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  await chmod(path, 0o660);
  await chown(path, 0, gid).catch(() => {});
  return server;
}
