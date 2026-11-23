// The fix tools: the only way Claude can change anything. Claude calls them
// through fix-mcp.mjs, which forwards each call over a Unix socket to the
// watcher (root). The watcher checks the request, asks the owner in Discord
// ("Claude wants to update sonarr · Allow · Deny"), waits for the tap, and
// only then runs a fixed command it owns: docker start/stop/restart through
// the socket proxy, or update/chown through host-fix on the Unraid host over
// SSH with a key only the watcher can read. Claude's user can connect to the
// socket, but it can only ask: nothing runs without the owner's tap.
import { createServer } from 'node:net';
import { chmod, chown, unlink } from 'node:fs/promises';
import { OWN_CONTAINERS } from './checks.mjs';

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const OWNER = /^\d{1,5}:\d{1,5}$/;
const SEG = '[A-Za-z0-9_.@+=,:-]+';
const APPDATA_PATH = new RegExp(`^/mnt/[A-Za-z0-9_.-]+/[A-Za-z0-9_-]+/${SEG}(/${SEG})*$`);
export const APPROVAL_MS = 15 * 60_000;
export const MAX_FIXES_PER_HOUR = 10;

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

export const FIX_HELP =
  'Changes go through these tools only. Every call is shown to the owner in Discord with Allow and Deny and waits for their tap (up to 15 minutes), so give a clear reason, change one thing at a time, and check the result afterwards.';

/**
 * Checks a request, asks the owner, runs it if allowed.
 *   askOwner({ tool, what, reason, source }) → 'allow' | 'deny' | 'timeout'
 *   exec deps: { run, hostFix } (hostFix null when host-fix is not set up)
 *   policy() → { refuse?: text, source: label }
 */
export class FixBroker {
  constructor({ askOwner, run, hostFix, audit, containers = () => [], policy = () => ({ source: '' }), now = () => Date.now(), notify = async () => {} }) {
    Object.assign(this, { askOwner, run, hostFix, audit, containers, policy, now, notify });
    this.done = [];
  }

  async handle(req) {
    const name = String(req?.tool ?? '');
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

    const reason = String(req.args?.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const what = tool.what(c.args);
    const decision = await this.askOwner({ tool: name, what, reason, source: p.source });
    const entry = { action: `fix.${name}`, target: c.args.name ?? c.args.path, args: c.args, reason };
    if (decision !== 'allow') {
      await this.audit({ who: 'owner', ...entry, result: decision === 'deny' ? 'denied' : 'no answer' });
      return decision === 'deny'
        ? { ok: false, text: 'The owner tapped Deny. Nothing was changed. Do not ask for the same change again; explain other options instead.' }
        : { ok: false, text: 'The owner did not answer within 15 minutes. Nothing was changed.' };
    }
    this.done.push(this.now());
    let r;
    try {
      r = await tool.exec(c.args, { run: this.run, hostFix: this.hostFix });
    } catch (err) {
      r = { ok: false, text: String(err.message ?? err) };
    }
    await this.audit({ who: 'owner', ...entry, result: r.ok ? 'ok' : 'failed', output: r.text.slice(-300) });
    await this.notify(`${r.ok ? '✅' : '⚠️'} ${what.replace(/\*\*/g, '')}: ${r.ok ? 'done' : 'failed'}.\n${'```'}\n${r.text.slice(-800)}\n${'```'}`);
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
      if (buf.length > 16_384) {
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
