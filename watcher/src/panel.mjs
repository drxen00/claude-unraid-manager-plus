// The Wraith server panel API (/api/integrations/wraith/v1), as this server
// answers it: #system (containers, load, disks) and #alerts (the watcher's
// problems). Wraith's own allowlist decides which paths can reach here at
// all (services/panel-rules.ts in Wraith); this file decides what they do,
// and it is the boundary that matters, because whoever runs the Wraith
// server could send any of them in the linked owner's name.
//
// So: nothing here touches disks, the array, parity, the flash drive or
// Unraid's settings; there is no terminal and no reboot; container changes
// go through the same ActionBook as the Discord buttons (state re-checked,
// at most a few an hour, audited); and every request but `link` needs the
// one Wraith account that was linked with a code from this server.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { OWN_CONTAINERS } from './checks.mjs';

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ── Link codes ────────────────────────────────────────────────────────── */

// No 0/O, 1/I/L: read off a terminal and typed on a phone.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const LINK_CODE_MS = 10 * 60_000;
const LINK_TRIES = 5;

export function newLinkCode() {
  const b = randomBytes(8);
  const c = [...b].map((x) => ALPHABET[x % ALPHABET.length]).join('');
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

/** One code at a time, ten minutes, five tries, used once. */
export class LinkCodes {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.current = null;
  }

  issue() {
    const code = newLinkCode();
    this.current = { code, expires: this.now() + LINK_CODE_MS, tries: 0 };
    return { code, expires: this.current.expires };
  }

  /** True once, for the right code; a wrong guess counts against it. */
  redeem(code) {
    const c = this.current;
    if (!c || this.now() > c.expires) {
      this.current = null;
      return false;
    }
    const a = Buffer.from(String(code ?? '').trim().toUpperCase());
    const b = Buffer.from(c.code);
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (ok) {
      this.current = null;
      return true;
    }
    if (++c.tries >= LINK_TRIES) this.current = null;
    return false;
  }
}

/* ── Alerts: the feed #alerts shows, and who gets told ─────────────────── */

const SEVERITY = { critical: 'error', warning: 'warn' };
const SEV_RANK = { info: 0, ok: 0, warn: 1, error: 2 };
const COLOR = { error: '#e5484d', warn: '#f5a524', ok: '#30a46c', info: '#8b8d98' };
export const CATEGORIES = [
  { key: 'containers', label: 'Containers', hint: 'A container crashed, keeps restarting or is unhealthy' },
  { key: 'disks', label: 'Disks', hint: 'A disk or pool is getting full' },
  { key: 'array', label: 'Array', hint: 'The array stopped or a disk is disabled' },
  { key: 'notifications', label: 'Unraid', hint: "Unraid's own warnings and alerts" },
  { key: 'watcher', label: 'Watcher', hint: 'The watcher could not check something' },
];
const CAT_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));
const FEED_MAX = 300;

export function catOf(incident) {
  const s = String(incident.source ?? '');
  return s.startsWith('watch:') ? 'watcher' : CAT_LABEL[s] ? s : 'watcher';
}

export function defaultAlertState() {
  return { prefs: { notify: true, minSeverity: 'warn', muted: [], paused: false, pausedUntil: null }, feed: [] };
}

export class AlertFeed {
  constructor(state, { now = () => Date.now(), save = async () => {} } = {}) {
    const d = defaultAlertState();
    this.state = {
      prefs: { ...d.prefs, ...(state?.prefs ?? {}) },
      feed: Array.isArray(state?.feed) ? state.feed.slice(0, FEED_MAX) : [],
    };
    this.now = now;
    this.save = save;
  }

  /** A problem came up (or got worse), or went away. Returns the feed event. */
  async record(incident, kind) {
    const severity = kind === 'resolved' ? 'ok' : SEVERITY[incident.severity] ?? 'warn';
    const cat = catOf(incident);
    const event = {
      id: randomBytes(8).toString('hex'),
      ts: this.now(),
      severity,
      type: kind,
      cat,
      category: CAT_LABEL[cat] ?? 'Watcher',
      title: kind === 'resolved' ? `Cleared: ${incident.title}` : String(incident.title ?? 'Problem'),
      detail: incident.detail ? String(incident.detail).slice(0, 500) : null,
      color: COLOR[severity],
      osUser: null,
    };
    this.state.feed.unshift(event);
    this.state.feed.length = Math.min(this.state.feed.length, FEED_MAX);
    await this.save(this.state);
    return event;
  }

  /** Does this event reach the owner's phone, by their #alerts settings? */
  notifies(event) {
    const p = this.state.prefs;
    if (!p.notify) return false;
    if (p.paused && (p.pausedUntil === null || this.now() < p.pausedUntil)) return false;
    if (p.muted.includes(event.cat)) return false;
    return (SEV_RANK[event.severity] ?? 0) >= (SEV_RANK[p.minSeverity] ?? 1) || event.type === 'test';
  }

  list({ limit = 100, before = null, severity = null, cat = null } = {}) {
    let items = this.state.feed;
    if (severity) items = items.filter((e) => e.severity === severity);
    if (cat) items = items.filter((e) => e.cat === cat);
    if (before) {
      const i = items.findIndex((e) => e.id === before);
      items = i >= 0 ? items.slice(i + 1) : [];
    }
    const n = Math.max(1, Math.min(200, Number(limit) || 100));
    const page = items.slice(0, n);
    return { events: page, hasMore: items.length > n, next: items.length > n ? page[page.length - 1].id : null };
  }

  async remove(id) {
    const before = this.state.feed.length;
    this.state.feed = this.state.feed.filter((e) => e.id !== id);
    if (this.state.feed.length !== before) await this.save(this.state);
    return before !== this.state.feed.length;
  }

  async clear() {
    this.state.feed = [];
    await this.save(this.state);
  }

  prefs() {
    const p = this.state.prefs;
    // A timed mute that ran out is over.
    if (p.paused && p.pausedUntil !== null && this.now() >= p.pausedUntil) return { ...p, paused: false, pausedUntil: null };
    return { ...p };
  }

  async setPrefs(patch) {
    const p = { ...this.state.prefs };
    if (typeof patch?.notify === 'boolean') p.notify = patch.notify;
    if (typeof patch?.minSeverity === 'string' && patch.minSeverity in SEV_RANK) p.minSeverity = patch.minSeverity;
    if (Array.isArray(patch?.muted)) p.muted = patch.muted.filter((k) => CAT_LABEL[k]).slice(0, CATEGORIES.length);
    if (typeof patch?.paused === 'boolean') {
      p.paused = patch.paused;
      const mins = Number(patch.pauseMinutes);
      p.pausedUntil = patch.paused && Number.isFinite(mins) && mins > 0 ? this.now() + Math.min(mins, 7 * 24 * 60) * 60_000 : null;
    }
    this.state.prefs = p;
    await this.save(this.state);
    return this.prefs();
  }
}

/* ── The API ───────────────────────────────────────────────────────────── */

const ok = (json) => ({ status: 200, json });
const err = (status, error, message, extra = {}) => ({ status, json: { error, message, ...extra } });

/** "services/docker%3Aplex/logs?lines=200" → { segs: ['services', 'docker:plex', 'logs'], query } */
export function parsePath(path) {
  const [p, q = ''] = String(path ?? '').split('?');
  const segs = [];
  for (const s of p.split('/').filter(Boolean)) {
    try {
      segs.push(decodeURIComponent(s));
    } catch {
      return null;
    }
  }
  return { segs, query: new URLSearchParams(q) };
}

/** "docker:plex" → "plex", for containers this panel may show and touch. */
function containerOf(id, rows) {
  const m = /^docker:(.+)$/.exec(String(id));
  if (!m || !NAME.test(m[1]) || OWN_CONTAINERS.has(m[1])) return null;
  return rows.some((r) => r.name === m[1]) ? m[1] : null;
}

function service(r) {
  return { id: `docker:${r.name}`, type: 'docker', target: r.name, name: r.name, status: r.state, raw: r.status, detail: { image: r.image } };
}

/** "12.5%" → 12.5; "1.2GiB / 31GiB" → bytes of the first. */
export function parseStats(line) {
  try {
    const s = JSON.parse(line);
    const cpu = Number(String(s.CPUPerc ?? '0').replace('%', '')) || 0;
    const m = /^([\d.]+)\s*([KMGT]?)i?B/i.exec(String(s.MemUsage ?? ''));
    const unit = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[(m?.[2] ?? '').toUpperCase()] ?? 1;
    return { cpu, mem: m ? Math.round(Number(m[1]) * unit) : 0 };
  } catch {
    return { cpu: 0, mem: 0 };
  }
}

/**
 * Merge `docker logs --timestamps` stdout and stderr back into one list in
 * time order, timestamps dropped.
 */
export function mergeLogs(stdout, stderr, max) {
  const lines = [];
  for (const text of [stdout, stderr]) {
    for (const l of String(text).split('\n')) {
      if (!l) continue;
      const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) ?(.*)$/.exec(l);
      lines.push(m ? { t: m[1], text: m[2] } : { t: '', text: l });
    }
  }
  lines.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return lines.slice(-max).map((l) => l.text.slice(0, 2000));
}

/**
 * deps: {
 *   link(): { user, name } | null          the linked Wraith account
 *   setLink(link|null): Promise             link / unlink
 *   codes: LinkCodes
 *   linkHint: string                        where codes come from
 *   hostname(): string
 *   sys: SysSampler
 *   disks(): df rows | null
 *   incidents(): shown open incidents
 *   containers(): Promise<rows>             fresh docker ps
 *   run(cmd, args, opts)
 *   act(action, name): Promise<{ ok, message }>   ActionBook, as the owner
 *   alerts: AlertFeed
 *   test(event): Promise                    send a test alert to the owner
 *   audit(entry)
 * }
 */
export function createPanelApi(deps) {
  const notLinked = () => err(403, 'not_linked', 'Link your Wraith account to this server first.', { linkHint: deps.linkHint });

  function me(link) {
    const term = Boolean(deps.terminal);
    return {
      linked: true,
      username: link.name || 'Owner',
      role: 'Owner',
      scope: 'full',
      runAs: term ? 'root' : 'claude',
      can: { servicesView: true, servicesControl: true, uptimeView: false, power: false, terminal: term, claude: Boolean(deps.claude) },
      why: {
        terminal: term ? null : deps.terminalHint ?? 'The terminal is off. For a shell, use the Unraid web terminal.',
        claude: deps.claude ? null : 'Claude in Wraith is not ready yet. Use the Claude app or Discord for now.',
      },
    };
  }

  function health() {
    const open = deps.incidents();
    const error = open.filter((i) => i.severity === 'critical').length;
    const warn = open.length - error;
    return {
      ok: open.length === 0,
      systemState: error ? 'error' : warn ? 'warn' : 'ok',
      counts: { error, warn },
      alerts: open.map((i) => ({
        severity: SEVERITY[i.severity] ?? 'warn',
        title: i.title,
        detail: i.detail ?? undefined,
        serviceId: i.container ? `docker:${i.container}` : undefined,
      })),
    };
  }

  async function overview() {
    const h = health();
    return {
      state: { systemState: h.systemState, ok: h.ok, counts: h.counts, checkedAt: Date.now() },
      active: deps.incidents().map((i) => ({
        id: i.key,
        severity: SEVERITY[i.severity] ?? 'warn',
        source: CAT_LABEL[catOf(i)] ?? 'Watcher',
        title: i.title,
        detail: i.detail ?? null,
        serviceId: i.container ? `docker:${i.container}` : null,
      })),
      prefs: deps.alerts.prefs(),
      severities: ['info', 'warn', 'error'],
      categories: CATEGORIES.map((c) => ({ ...c, visible: true, logging: true })),
      can: { settings: false, autoheal: { view: false, control: false }, uptime: { view: false, control: false }, exposure: false, clearFeed: true },
      rules: { autoheal: [], uptime: [] },
      box: null,
    };
  }

  async function handle({ method, path, user, json }) {
    const p = parsePath(path);
    if (!p || typeof user !== 'string' || !UUID.test(user)) return err(400, 'bad_request', 'Bad request.');
    const { segs, query } = p;
    const route = segs.join('/');
    const m = String(method).toUpperCase();
    const link = deps.link();

    // The one request a stranger may make: link with a code from this server.
    if (m === 'POST' && route === 'link') {
      if (!deps.codes.redeem(json?.code)) {
        await deps.audit({ who: `wraith:${user}`, action: 'wraith.link', result: 'wrong code' });
        return err(400, 'bad_code', 'That code did not work. Get a new one on the server and try again.');
      }
      const name = String(json?.wraithName ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, 64);
      await deps.setLink({ user, name, at: Date.now() });
      await deps.audit({ who: `wraith:${user}`, action: 'wraith.link', result: `ok (${name || 'no name'})` });
      return ok({ ok: true });
    }
    if (!link || link.user !== user) return notLinked();

    if (m === 'GET' && route === 'me') return ok(me(link));
    if (m === 'POST' && route === 'unlink') {
      await deps.setLink(null);
      await deps.audit({ who: `wraith:${user}`, action: 'wraith.unlink', result: 'ok' });
      return ok({ ok: true });
    }

    /* #system */
    if (m === 'GET' && route === 'system') return ok(await deps.sys.info({ hostname: deps.hostname(), disks: deps.disks() }));
    if (m === 'GET' && route === 'metrics') return ok({ history: deps.sys.history });
    if (m === 'GET' && route === 'health') return ok(health());
    if (m === 'GET' && route === 'services') {
      const rows = (await deps.containers()).filter((r) => r.name && !OWN_CONTAINERS.has(r.name));
      return ok({ groups: [{ type: 'docker', label: 'Containers', items: rows.map(service) }] });
    }
    if (m === 'GET' && route === 'groups') return ok({ groups: [], nicks: {} });
    if (m === 'GET' && route === 'uptime') return ok({ targets: [] });
    if (m === 'GET' && route === 'updates') return ok({ count: 0, security: 0 });
    if (m === 'POST' && route === 'updates/refresh') return ok({ ok: true });
    if (m === 'GET' && route === 'restart') {
      return ok({ active: null, last: null, canRequest: false, canCancel: false, canForce: false, deadlines: [], maxAheadMs: 0, graceMs: 0 });
    }
    if (segs[0] === 'services' && segs.length === 3) {
      const rows = await deps.containers();
      const name = containerOf(segs[1], rows);
      if (!name) return err(404, 'not_found', 'No such container here.');
      if (m === 'GET' && segs[2] === 'logs') {
        const n = Math.max(1, Math.min(500, Number(query.get('lines')) || 200));
        const r = await deps.run('docker', ['logs', '--timestamps', '--tail', String(n), name], { timeoutMs: 20_000 });
        if (r.code !== 0) return err(502, 'docker_failed', (r.stderr || 'docker logs failed').trim().slice(0, 300));
        return ok({ lines: mergeLogs(r.stdout, r.stderr, n) });
      }
      if (m === 'GET' && segs[2] === 'stats') {
        const r = await deps.run('docker', ['stats', '--no-stream', '--format', '{{json .}}', name], { timeoutMs: 20_000 });
        return ok(r.code === 0 ? parseStats(r.stdout.trim().split('\n')[0]) : { cpu: 0, mem: 0 });
      }
      if (m === 'POST' && ['start', 'stop', 'restart'].includes(segs[2])) {
        const r = await deps.act(`container.${segs[2]}`, name);
        return r.ok ? ok({ ok: true, message: r.message }) : err(409, 'not_done', r.message);
      }
      if (m === 'POST' && segs[2] === 'ignore') return err(403, 'not_allowed', 'Use "Containers to ignore" in the Unraid template for that.');
    }
    if (segs[0] === 'power' || segs[0] === 'restart') {
      return err(403, 'not_allowed', 'Restarting or shutting down Unraid is never done from Wraith. Use the Unraid web UI.');
    }
    if (segs[0] === 'groups') return err(404, 'not_found', 'There are no stacks on this server.');
    if (segs[0] === 'terminal') {
      const t = deps.terminal;
      if (!t) return err(403, 'not_allowed', deps.terminalHint ?? 'The terminal is off. For a shell, use the Unraid web terminal.');
      if (m === 'GET' && route === 'terminal/history') return ok(t.history({ limit: query.get('limit'), before: query.get('before') }));
      try {
        if (m === 'POST' && route === 'terminal/input') return ok(await t.input(json?.text));
        if (m === 'POST' && route === 'terminal/key') return ok({ ok: true, sent: t.key(String(json?.key ?? '')) });
      } catch (e) {
        return err(400, e.code ?? 'bad_request', e.message);
      }
      if (m === 'POST' && route === 'terminal/clear') { t.clear(); return ok({ ok: true }); }
      if (m === 'POST' && route === 'terminal/reset') { t.reset(); return ok({ ok: true }); }
      return err(404, 'not_found', 'Not available on this server.');
    }
    if (segs[0] === 'claude') return err(403, 'not_allowed', 'Claude in Wraith is not ready yet.');

    /* #alerts */
    if (m === 'GET' && route === 'alerts/overview') return ok(await overview());
    if (m === 'GET' && route === 'alerts/feed') {
      return ok(deps.alerts.list({ limit: query.get('limit'), before: query.get('before'), severity: query.get('severity'), cat: query.get('cat') }));
    }
    if (m === 'DELETE' && route === 'alerts/feed') {
      await deps.alerts.clear();
      return ok({ ok: true });
    }
    if (m === 'DELETE' && segs[0] === 'alerts' && segs[1] === 'feed' && segs.length === 3) {
      return (await deps.alerts.remove(segs[2])) ? ok({ ok: true }) : err(404, 'not_found', 'That alert is gone already.');
    }
    if (m === 'PUT' && route === 'alerts/prefs') return ok(await deps.alerts.setPrefs(json));
    if (m === 'POST' && route === 'alerts/test') {
      const event = await deps.alerts.record({ source: 'watch:test', severity: 'warning', title: 'Test alert from your Unraid server', detail: 'If this reached your phone, alerts work.' }, 'test');
      await deps.test(event);
      return ok({ ok: true });
    }
    if (segs[0] === 'alerts') return err(403, 'not_allowed', 'That setting lives in the Unraid template, or by talking to the watcher.');

    return err(404, 'not_found', 'Not available on this server.');
  }

  return { handle };
}
