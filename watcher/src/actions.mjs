// The only things a Discord button can do: start, stop or restart one
// container. Claude may suggest them; it never runs them. A button runs a
// fixed command owned by this file, after the owner taps it, within 15
// minutes, at most a few times an hour, and only after re-checking that the
// container is still in the state the suggestion was made for.
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { OWN_CONTAINERS } from './checks.mjs';

export const CATALOG = {
  'container.restart': { verb: 'restart', label: 'Restart', done: 'restarted', needs: (s) => s === 'running' || s === 'restarting' || s === 'exited' },
  'container.start': { verb: 'start', label: 'Start', done: 'started', needs: (s) => s === 'exited' || s === 'created' },
  'container.stop': { verb: 'stop', label: 'Stop', done: 'stopped', needs: (s) => s === 'running' || s === 'restarting' },
};

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
    const target = String(s.target ?? '');
    if (!CATALOG[action] || !NAME.test(target) || OWN_CONTAINERS.has(target) || !names.has(target)) continue;
    if (out.some((o) => o.action === action && o.target === target)) continue;
    out.push({ action, target, reason: String(s.reason ?? '').slice(0, 200) });
  }
  return out;
}

export class ActionBook {
  constructor({ run, auditPath, now = () => Date.now() }) {
    this.run = run;
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
    const hourAgo = this.now() - 3_600_000;
    this.executed = this.executed.filter((t) => t > hourAgo);
    if (this.executed.length >= MAX_PER_HOUR) {
      await this.audit({ who, action: offer.action, target: offer.target, result: 'rate-limited' });
      return { ok: false, message: `Limit reached: at most ${MAX_PER_HOUR} fixes an hour from Discord. Nothing was changed.` };
    }

    const entry = CATALOG[offer.action];
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
