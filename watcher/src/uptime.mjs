// Website checks for Wraith's #alerts → Uptime monitors: the owner adds a
// site (a name and an http(s) address), the watcher fetches it every minute
// from the server, and a site that fails twice in a row becomes a problem
// like any other (source 'uptime'): an alert, a push, Claude looking into it.
// HTTPS sites also get their certificate's expiry checked, once an hour.
import { randomBytes } from 'node:crypto';
import { connect as tlsConnect } from 'node:tls';

export const MAX_TARGETS = 25;
const HISTORY = 90;
const CERT_EVERY_MS = 3_600_000;
export const CERT_WARN_DAYS = 14;
// Down only after this many failures in a row, so one slow answer is no alert.
export const FAILS_TO_DOWN = 2;

export function validTarget(body) {
  const name = String(body?.name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60);
  const raw = String(body?.url ?? '').trim();
  let url;
  try { url = new URL(raw); } catch { return { error: 'That is not a web address. It must start with http:// or https://.' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'Only http:// and https:// addresses can be checked.' };
  if (url.username || url.password) return { error: 'Leave the user name and password out of the address.' };
  if (!name) return { error: 'Give it a name.' };
  return { target: { name, url: url.href, alerts: body?.alerts !== false } };
}

/** The certificate's days left, from a TLS handshake (no request sent). */
export function certDaysLeft(host, port = 443, { now = Date.now(), timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const s = tlsConnect({ host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const c = s.getPeerCertificate();
      s.end();
      if (!c?.valid_to) return resolve(null);
      const end = Date.parse(c.valid_to);
      resolve(Number.isFinite(end) ? { daysLeft: Math.floor((end - now) / 86_400_000), validTo: new Date(end).toISOString() } : null);
    });
    s.on('error', () => resolve(null));
    s.on('timeout', () => { s.destroy(); resolve(null); });
  });
}

export class UptimeMonitor {
  /**
   * saved: [{ id, name, url, alerts }]; save(list); onChange(): a site went
   * down or came back (the watcher runs its checks then).
   */
  constructor({ saved = [], save = async () => {}, onChange = () => {}, fetchFn = fetch, cert = certDaysLeft, now = () => Date.now(), everyMs = 60_000 } = {}) {
    Object.assign(this, { save, onChange, fetchFn, cert, now, everyMs });
    this.targets = (Array.isArray(saved) ? saved : []).slice(0, MAX_TARGETS)
      .filter((t) => t && typeof t.id === 'string' && validTarget(t).target)
      .map((t) => ({ ...validTarget(t).target, id: t.id, current: null, cert: null, certAt: 0, history: [], fails: 0, down: false }));
    this.timer = null;
  }

  #persist() {
    return this.save(this.targets.map(({ id, name, url, alerts }) => ({ id, name, url, alerts })));
  }

  async upsert(body) {
    const v = validTarget(body);
    if (v.error) throw Object.assign(new Error(v.error), { status: 400, code: 'bad_target' });
    const existing = body?.id ? this.targets.find((t) => t.id === body.id) : null;
    if (existing) {
      const urlChanged = existing.url !== v.target.url;
      Object.assign(existing, v.target);
      if (urlChanged) Object.assign(existing, { current: null, cert: null, certAt: 0, history: [], fails: 0, down: false });
    } else {
      if (this.targets.length >= MAX_TARGETS) throw Object.assign(new Error(`At most ${MAX_TARGETS} sites can be checked.`), { status: 400, code: 'too_many' });
      this.targets.push({ ...v.target, id: randomBytes(6).toString('hex'), current: null, cert: null, certAt: 0, history: [], fails: 0, down: false });
    }
    await this.#persist();
    const t = existing ?? this.targets.at(-1);
    void this.checkOne(t).then((changed) => { if (changed) this.onChange(); });
    return this.view(t);
  }

  async remove(id) {
    const before = this.targets.length;
    const wasDown = this.targets.some((t) => t.id === id && t.down);
    this.targets = this.targets.filter((t) => t.id !== id);
    if (this.targets.length === before) throw Object.assign(new Error('That monitor is gone already.'), { status: 404, code: 'not_found' });
    await this.#persist();
    if (wasDown) this.onChange();
    return { ok: true };
  }

  /** Returns true when the site went down or came back. */
  async checkOne(t) {
    const started = this.now();
    let up = false;
    let code;
    let error = null;
    try {
      const res = await this.fetchFn(t.url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(10_000), headers: { 'user-agent': 'claude-unraid-manager uptime check' } });
      code = res.status;
      up = res.status < 500;
      if (!up) error = `HTTP ${res.status}`;
      res.body?.cancel?.().catch?.(() => {});
    } catch (e) {
      error = e?.name === 'TimeoutError' ? 'No answer within 10 seconds' : String(e?.cause?.code ?? e?.message ?? e).slice(0, 120);
    }
    const ms = this.now() - started;
    t.current = { up, ms, ...(code ? { code } : {}), at: this.now(), error };
    t.history.push({ t: this.now(), up, ms, ...(code ? { code } : {}) });
    while (t.history.length > HISTORY) t.history.shift();
    t.fails = up ? 0 : t.fails + 1;
    const wasDown = t.down;
    t.down = t.fails >= FAILS_TO_DOWN;

    const u = new URL(t.url);
    if (u.protocol === 'https:' && (!t.certAt || this.now() - t.certAt > CERT_EVERY_MS)) {
      t.certAt = this.now();
      t.cert = await this.cert(u.hostname, Number(u.port) || 443);
    }
    return wasDown !== t.down;
  }

  async checkAll() {
    let changed = false;
    for (const t of this.targets) if (await this.checkOne(t)) changed = true;
    if (changed) this.onChange();
  }

  start() {
    void this.checkAll();
    this.timer = setInterval(() => void this.checkAll(), this.everyMs);
    this.timer.unref?.();
  }

  view(t) {
    const h = t.history;
    return {
      id: t.id, name: t.name, url: t.url, alerts: t.alerts, current: t.current, cert: t.cert,
      uptimePct: h.length ? Math.round((h.filter((x) => x.up).length / h.length) * 1000) / 10 : null,
      history: h,
    };
  }

  list() { return this.targets.map((t) => this.view(t)); }

  /** Problems for the watcher's checks, like any other collector's. */
  findings() {
    const out = [];
    for (const t of this.targets) {
      if (!t.alerts) continue;
      if (t.down) {
        out.push({ source: 'uptime', key: `uptime:${t.id}:down`, severity: 'critical', title: `${t.name} is down`, detail: `${t.url}: ${t.current?.error ?? 'no answer'}` });
      }
      if (t.cert && t.cert.daysLeft < CERT_WARN_DAYS) {
        out.push({
          source: 'uptime', key: `uptime:${t.id}:cert`, severity: t.cert.daysLeft < 3 ? 'critical' : 'warning',
          title: t.cert.daysLeft < 0 ? `${t.name}'s certificate has expired` : `${t.name}'s certificate expires in ${t.cert.daysLeft} day${t.cert.daysLeft === 1 ? '' : 's'}`,
          detail: `${t.url}, valid until ${t.cert.validTo.slice(0, 10)}`,
        });
      }
    }
    return out;
  }
}
