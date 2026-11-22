// Deterministic checks: no AI here. Each collector returns findings
//   { key, source, severity: 'warning' | 'critical', title, detail }
// where key identifies the problem across runs ("container:plex:unhealthy").
// The parsers are separate pure functions so tests can feed them fixtures.

// Containers whose state is part of this tool. Never alert on, never touch.
export const OWN_CONTAINERS = new Set(['claude-unraid-manager', 'claude-docker-proxy']);

// ── Containers (docker ps through the socket proxy) ─────────────────────────

// Exit codes from a normal stop: 0, and 143 (SIGTERM). 137 (SIGKILL) is also
// what `docker stop` leaves after its timeout, so it only counts when the
// kernel killed the container for memory (checked separately).
const NORMAL_EXIT = new Set([0, 143]);

export function parseDockerPs(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      rows.push({ name: String(r.Names ?? ''), state: String(r.State ?? ''), status: String(r.Status ?? ''), image: String(r.Image ?? '') });
    } catch {
      // A malformed line is skipped, not fatal.
    }
  }
  return rows;
}

export function containerFindings(rows, { ignore = [], oomKilled = new Set() } = {}) {
  const skip = new Set([...ignore, ...OWN_CONTAINERS]);
  const out = [];
  for (const c of rows) {
    if (!c.name || skip.has(c.name)) continue;
    const base = { source: 'containers', container: c.name };
    if (c.state === 'restarting') {
      out.push({ ...base, key: `container:${c.name}:restarting`, severity: 'critical', title: `${c.name} keeps restarting`, detail: c.status });
    } else if (c.state === 'running' && /\(unhealthy\)/.test(c.status)) {
      out.push({ ...base, key: `container:${c.name}:unhealthy`, severity: 'warning', title: `${c.name} is unhealthy`, detail: c.status });
    } else if (c.state === 'exited' || c.state === 'dead') {
      const m = /Exited \((\d+)\)/.exec(c.status);
      const code = m ? Number(m[1]) : null;
      if (c.state === 'dead') {
        out.push({ ...base, key: `container:${c.name}:dead`, severity: 'critical', title: `${c.name} is dead`, detail: c.status });
      } else if (code === 137 && !oomKilled.has(c.name)) {
        // Stopped by `docker stop` after its timeout: not a crash.
      } else if (code !== null && !NORMAL_EXIT.has(code)) {
        const why = code === 137 ? 'ran out of memory' : `crashed (exit code ${code})`;
        out.push({ ...base, key: `container:${c.name}:exited`, severity: 'warning', title: `${c.name} ${why}`, detail: c.status });
      }
    }
  }
  return out;
}

// ── Array state (host mdcmd status, over the read-only SSH checks) ──────────

export function parseMdcmd(text) {
  const v = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) v[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return v;
}

export function arrayFindings(md) {
  const state = md.mdState;
  if (!state) return [];
  if (state === 'STARTED') {
    const out = [];
    // Disabled data or parity disks: rdevStatus.N other than OK / not present.
    for (const [k, val] of Object.entries(md)) {
      const m = /^rdevStatus\.(\d+)$/.exec(k);
      if (!m) continue;
      if (val === 'DISK_OK' || val.startsWith('DISK_NP')) continue;
      const slot = Number(m[1]);
      const label = slot === 0 ? 'parity' : slot === 29 ? 'parity 2' : `disk${slot}`;
      const dev = md[`rdevName.${slot}`] || 'no device';
      out.push({ source: 'array', key: `array:slot${slot}:${val}`, severity: 'critical', title: `Array ${label} (${dev}) is ${val}`, detail: `mdcmd status: rdevStatus.${slot}=${val}` });
    }
    return out;
  }
  return [{ source: 'array', key: `array:state:${state}`, severity: 'critical', title: `Array is ${state}`, detail: `mdcmd status: mdState=${state}` }];
}

// ── Disk and pool fill (host df -h) ──────────────────────────────────────────

// Mounts under /mnt that are not disks or pools.
const NOT_STORAGE = new Set(['user', 'user0', 'addons', 'remotes', 'disks', 'rootshare']);

export function parseDf(text) {
  const rows = [];
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6) continue;
    const mount = f.slice(5).join(' ');
    const m = /^\/mnt\/([^/]+)$/.exec(mount);
    if (!m || NOT_STORAGE.has(m[1])) continue;
    const pct = Number(f[4].replace('%', ''));
    if (!Number.isFinite(pct)) continue;
    rows.push({ name: m[1], size: f[1], used: f[2], free: f[3], pct });
  }
  return rows;
}

export function diskFindings(rows, warnPercent) {
  const out = [];
  for (const d of rows) {
    if (d.pct < warnPercent) continue;
    const severity = d.pct >= 98 ? 'critical' : 'warning';
    out.push({ source: 'disks', key: `disk:${d.name}:full`, severity, title: `${d.name} is ${d.pct}% full`, detail: `${d.used} used of ${d.size}, ${d.free} free` });
  }
  return out;
}

// ── Unraid's own notifications (read-only API key) ───────────────────────────

export const NOTIFICATIONS_QUERY =
  'query ($filter: NotificationFilter!) { notifications { list(filter: $filter) { id title subject description importance timestamp } } }';

export function notificationFindings(list) {
  const out = [];
  for (const n of list ?? []) {
    const imp = String(n.importance ?? '').toUpperCase();
    if (imp !== 'ALERT' && imp !== 'WARNING') continue;
    const subject = String(n.subject || n.title || 'Unraid notification').slice(0, 200);
    out.push({
      source: 'notifications',
      key: `notify:${n.id}`,
      severity: imp === 'ALERT' ? 'critical' : 'warning',
      title: `Unraid: ${subject}`,
      detail: String(n.description ?? '').slice(0, 500),
    });
  }
  return out;
}

// ── Collectors: run the commands, return findings plus failed sources ────────

export async function collect(cfg, { run, asClaude, fetchFn = fetch }) {
  const findings = [];
  const failed = new Map();
  const containers = [];

  // Containers
  const ps = await run('docker', ['ps', '-a', '--format', '{{json .}}'], { timeoutMs: 30_000 });
  if (ps.code === 0) {
    const rows = parseDockerPs(ps.stdout);
    containers.push(...rows);
    const oom = new Set();
    for (const c of rows) {
      if (c.state === 'exited' && /Exited \(137\)/.test(c.status) && !OWN_CONTAINERS.has(c.name)) {
        const r = await run('docker', ['inspect', '--format', '{{.State.OOMKilled}}', c.name], { timeoutMs: 15_000 });
        if (r.code === 0 && r.stdout.trim() === 'true') oom.add(c.name);
      }
    }
    findings.push(...containerFindings(rows, { ignore: cfg.ignore, oomKilled: oom }));
  } else {
    failed.set('containers', (ps.stderr || ps.stdout).trim().slice(0, 300));
  }

  // Array and disk fill, through the read-only host checks
  if (cfg.hostChecks) {
    const md = await asClaude(cfg, ['host', 'mdcmd', 'status'], { timeoutMs: 30_000 });
    if (md.code === 0) findings.push(...arrayFindings(parseMdcmd(md.stdout)));
    else failed.set('array', (md.stderr || md.stdout).trim().slice(0, 300));

    const df = await asClaude(cfg, ['host', 'df', '-h'], { timeoutMs: 30_000 });
    if (df.code === 0) findings.push(...diskFindings(parseDf(df.stdout), cfg.diskWarnPercent));
    else failed.set('disks', (df.stderr || df.stdout).trim().slice(0, 300));
  }

  // Unraid notifications through the read-only API key
  if (cfg.apiUrl && cfg.apiKey) {
    try {
      const res = await fetchFn(cfg.apiUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey },
        body: JSON.stringify({ query: NOTIFICATIONS_QUERY, variables: { filter: { type: 'UNREAD', offset: 0, limit: 50 } } }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = await res.json();
      if (!res.ok || body.errors) throw new Error(body.errors?.[0]?.message ?? `HTTP ${res.status}`);
      findings.push(...notificationFindings(body.data?.notifications?.list));
    } catch (err) {
      failed.set('notifications', String(err.message ?? err).slice(0, 300));
    }
  }

  return { findings, failed, containers };
}
