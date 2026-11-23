// The only things a Discord button can do: start, stop or restart one
// container, or change the watcher's own preferences (mute a problem, keep a
// note). Claude may suggest them; it never runs them. A button runs a fixed
// command owned by this file, after the owner taps it, within 15 minutes, at
// most a few times an hour, and only after re-checking that the container is
// still in the state the suggestion was made for.
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { OWN_CONTAINERS } from './checks.mjs';
import { daysText, validDays, validMatch, validNote } from './prefs.mjs';

export const CATALOG = {
  'container.restart': { verb: 'restart', label: 'Restart', done: 'restarted', needs: (s) => s === 'running' || s === 'restarting' || s === 'exited' },
  'container.start': { verb: 'start', label: 'Start', done: 'started', needs: (s) => s === 'exited' || s === 'created' },
  'container.stop': { verb: 'stop', label: 'Stop', done: 'stopped', needs: (s) => s === 'running' || s === 'restarting' },
  // Local: carried out by the watcher itself (ActionBook's `local`), no docker.
  'watch.mute': { local: true },
  'watch.note': { local: true },
};

export function buttonLabel(o) {
  if (o.action === 'watch.mute') return `🔕 Mute ${o.target} (${daysText(o.days)})`.slice(0, 80);
  if (o.action === 'watch.note') return '📝 Remember this note';
  return `${CATALOG[o.action].label} ${o.target}`.slice(0, 80);
}

// What a preference button will do exactly, written by the watcher (not by
// Claude) under the message, so the owner sees it before tapping.
export function describeOffer(o) {
  if (o.action === 'watch.mute') return `🔕 **Mute** \`${o.target}\` for ${daysText(o.days)}: no alerts for problems whose id or title matches it.`;
  if (o.action === 'watch.note') return `📝 **Note** for every report: "${o.text}"`;
  return '';
}

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
export const EXPIRY_MS = 15 * 60_000;
export const MAX_PER_HOUR = 5;
export const MAX_SUGGESTIONS = 3;

// Keep only well-formed suggestions for containers that exist right now.
export function validateSuggestions(list, containers) {
  const names = new Set(containers.map((c) => c.name));
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (out.length >= MAX_SUGGESTIONS) break;
    if (!s || typeof s !== 'object') continue;
    const action = String(s.action ?? '');
    const reason = String(s.reason ?? '').slice(0, 200);
    if (action === 'watch.mute') {
      const target = validMatch(s.target);
      const d = validDays(s.days);
      if (!target || !d.ok || out.some((o) => o.action === action && o.target === target)) continue;
      out.push({ action, target, days: d.days, reason });
      continue;
    }
    if (action === 'watch.note') {
      const text = validNote(s.text);
      if (!text || out.some((o) => o.action === action && o.text === text)) continue;
      out.push({ action, target: 'note', text, reason });
      continue;
    }
    const target = String(s.target ?? '');
    if (!CATALOG[action] || CATALOG[action].local || !NAME.test(target) || OWN_CONTAINERS.has(target) || !names.has(target)) continue;
    if (out.some((o) => o.action === action && o.target === target)) continue;
    out.push({ action, target, reason });
  }
  return out;
}

export class ActionBook {
  // local: { 'watch.mute': async (offer) => message, ... } for the actions
  // the watcher carries out itself.
  constructor({ run, auditPath, now = () => Date.now(), local = {} }) {
    this.run = run;
    this.local = local;
    this.auditPath = auditPath;
    this.now = now;
    this.pending = new Map();
    this.executed = [];
  }

  // Register a suggestion; returns the one-time id the button carries.
  offer(suggestion) {
    const id = randomBytes(9).toString('base64url');
    this.pending.set(id, { ...suggestion, created: this.now() });
    return id;
  }

  // Forget offers (the "Not now" button, or a newer message superseding them).
  withdraw(ids) {
    for (const id of ids) this.pending.delete(id);
  }

  async audit(entry) {
    const line = JSON.stringify({ time: new Date(this.now()).toISOString(), ...entry });
    console.log(`unraid-watch audit: ${line}`);
    try {
      await mkdir(dirname(this.auditPath), { recursive: true, mode: 0o700 });
      await appendFile(this.auditPath, line + '\n', { mode: 0o600 });
    } catch (err) {
      console.error(`unraid-watch: cannot write audit log: ${err.message}`);
    }
  }

  // Run an offer the owner approved. Returns { ok, message }.
  async approve(id, who) {
    const offer = this.pending.get(id);
    this.pending.delete(id);
    if (!offer) return { ok: false, message: 'That button has already been used or is no longer valid.' };
    if (this.now() - offer.created > EXPIRY_MS) {
      await this.audit({ who, action: offer.action, target: offer.target, result: 'expired' });
      return { ok: false, message: 'That button expired (15 minutes). Nothing was changed. Ask me again if it still needs fixing.' };
    }
    const entry = CATALOG[offer.action];
    if (entry.local) {
      const fn = this.local[offer.action];
      try {
        if (!fn) throw new Error('not available');
        const message = await fn(offer);
        await this.audit({ who, action: offer.action, target: offer.target, text: offer.text, days: offer.days, result: 'ok' });
        return { ok: true, message };
      } catch (err) {
        await this.audit({ who, action: offer.action, target: offer.target, result: `failed (${err.message})` });
        return { ok: false, message: `Could not do that: ${err.message}` };
      }
    }

    const hourAgo = this.now() - 3_600_000;
    this.executed = this.executed.filter((t) => t > hourAgo);
    if (this.executed.length >= MAX_PER_HOUR) {
      await this.audit({ who, action: offer.action, target: offer.target, result: 'rate-limited' });
      return { ok: false, message: `Limit reached: at most ${MAX_PER_HOUR} fixes an hour from Discord. Nothing was changed.` };
    }

    const state = await this.run('docker', ['inspect', '--format', '{{.State.Status}}', offer.target], { timeoutMs: 15_000 });
    if (state.code !== 0) {
      await this.audit({ who, action: offer.action, target: offer.target, result: 'gone' });
      return { ok: false, message: `${offer.target} no longer exists. Nothing was changed.` };
    }
    const current = state.stdout.trim();
    if (!entry.needs(current)) {
      await this.audit({ who, action: offer.action, target: offer.target, result: `skipped (state ${current})` });
      return { ok: false, message: `${offer.target} is now ${current}, so "${entry.label.toLowerCase()}" no longer applies. Nothing was changed.` };
    }

    this.executed.push(this.now());
    const r = await this.run('docker', [entry.verb, offer.target], { timeoutMs: 120_000 });
    const tail = (r.stderr || r.stdout).trim().slice(-300);
    await this.audit({ who, action: offer.action, target: offer.target, result: r.code === 0 ? 'ok' : `failed (${r.code})`, output: tail });
    if (r.code === 0) return { ok: true, message: `Done: ${entry.done} ${offer.target}.` };
    return { ok: false, message: `Docker refused or failed to ${entry.verb} ${offer.target}: ${tail || 'no output'}` };
  }
}
