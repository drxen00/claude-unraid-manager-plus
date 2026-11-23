// The owner's rules, kept in the watcher's own state (never in Claude's
// reach), changed only by the owner's typed command, by a chat request the
// owner made, or by a button the owner taps:
//
// - mute  "don't tell me about <match> [until <time>] [until <condition>]"
// - alert "tell me when <condition>" (once, or every time), optional expiry
// - note  a standing instruction for every report ("don't mention parity")
//
// Conditions are checked by the watcher itself on every run, without AI, from
// the same facts the checks collect: disks, containers, the array, Unraid
// notifications, open problems, and the clock.

export const MAX_RULES = 50;
export const MAX_TEXT = 300;
const DAY = 86_400_000;
const MAX_AHEAD = 366 * DAY;
const MATCH = /^[\w .*:@/+#-]{1,120}$/;
const ID = /^[man]\d{1,6}$/;

const CONTAINER_STATES = ['running', 'stopped', 'restarting', 'unhealthy', 'healthy', 'gone'];
const ARRAY_STATES = ['started', 'stopped', 'syncing', 'not syncing'];

export function emptyPrefs() {
  return { next: 1, mutes: [], alerts: [], notes: [] };
}

export function normalizePrefs(p) {
  const list = (x, ok) => (Array.isArray(x) ? x.filter((r) => r && typeof r === 'object' && ok(r)) : []);
  const out = {
    next: Number.isInteger(p?.next) && p.next > 0 ? p.next : 1,
    mutes: list(p?.mutes, (r) => typeof r.match === 'string'),
    alerts: list(p?.alerts, (r) => r.when && typeof r.when.type === 'string'),
    notes: list(p?.notes, (r) => typeof r.text === 'string'),
  };
  // Older files had no ids: give them some.
  for (const [kind, prefix] of [['mutes', 'm'], ['alerts', 'a'], ['notes', 'n']]) {
    for (const r of out[kind]) if (!ID.test(String(r.id ?? ''))) r.id = `${prefix}${out.next++}`;
  }
  return out;
}

// ── Validation (everything Claude proposes passes through here) ──────────────

// A pattern: an exact name or id, or one with * (disk:*:full, *docker.img*),
// matched case-insensitively. "*" alone (everything) only where allowAll.
export function validMatch(match, { allowAll = false } = {}) {
  const m = String(match ?? '').trim();
  if (!MATCH.test(m)) return null;
  if (!allowAll && !m.replace(/[*\s]/g, '')) return null;
  return m;
}

export function validText(text, max = MAX_TEXT) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t && t.length <= max ? t : null;
}

// A point in time: ISO text (with offset or Z) or epoch ms, in the future
// (a minute of slack), at most a year ahead. Returns epoch ms or null.
export function validTime(v, now = Date.now()) {
  if (v === null || v === undefined || v === '') return null;
  const ms = typeof v === 'number' ? v : Date.parse(String(v));
  if (!Number.isFinite(ms) || ms < now - 60_000 || ms > now + MAX_AHEAD) return null;
  return ms;
}

// Returns the normalized condition, or null if it is not one we can check.
export function validCondition(c, now = Date.now()) {
  if (!c || typeof c !== 'object') return null;
  switch (c.type) {
    case 'time': {
      const at = validTime(c.at, now);
      return at ? { type: 'time', at } : null;
    }
    case 'disk': {
      const disk = validMatch(c.disk ?? '*', { allowAll: true });
      const op = c.op === '<=' ? '<=' : c.op === '>=' || c.op === undefined ? '>=' : null;
      const percent = Number(c.percent);
      if (!disk || !op || !Number.isInteger(percent) || percent < 1 || percent > 100) return null;
      return { type: 'disk', disk, op, percent };
    }
    case 'container': {
      const name = validMatch(c.name);
      const state = String(c.state ?? '').toLowerCase();
      return name && CONTAINER_STATES.includes(state) ? { type: 'container', name, state } : null;
    }
    case 'problem': {
      const match = validMatch(c.match);
      const is = c.is === 'cleared' ? 'cleared' : c.is === 'open' || c.is === undefined ? 'open' : null;
      return match && is ? { type: 'problem', match, is } : null;
    }
    case 'notification': {
      const match = validMatch(c.match);
      return match ? { type: 'notification', match } : null;
    }
    case 'array': {
      const is = String(c.is ?? '').toLowerCase();
      return ARRAY_STATES.includes(is) ? { type: 'array', is } : null;
    }
    default:
      return null;
  }
}

// ── Matching and evaluating ──────────────────────────────────────────────────

function glob(pattern) {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${esc}$`, 'i');
}

function containerIs(r, state) {
  const unhealthy = /\(unhealthy\)/.test(r.status);
  switch (state) {
    case 'running': return r.state === 'running';
    case 'stopped': return r.state === 'exited' || r.state === 'created' || r.state === 'dead';
    case 'restarting': return r.state === 'restarting';
    case 'unhealthy': return r.state === 'running' && unhealthy;
    case 'healthy': return r.state === 'running' && !unhealthy;
    default: return false;
  }
}

/**
 * facts: { containers, disks, md, notifications, open } where a source that
 * could not be checked this run is null.
 * Returns { value: true | false | null (unknown), detail, ids? }.
 */
export function evaluate(c, facts, now = Date.now()) {
  switch (c.type) {
    case 'time':
      return { value: now >= c.at, detail: '' };
    case 'disk': {
      if (!facts.disks) return { value: null, detail: '' };
      const re = glob(c.disk);
      const hit = facts.disks.filter((d) => re.test(d.name) && (c.op === '>=' ? d.pct >= c.percent : d.pct <= c.percent));
      return { value: hit.length > 0, detail: hit.map((d) => `${d.name} is ${d.pct}% full`).join(', ') };
    }
    case 'container': {
      if (!facts.containers) return { value: null, detail: '' };
      const re = glob(c.name);
      const rows = facts.containers.filter((r) => re.test(r.name));
      if (c.state === 'gone') return { value: rows.length === 0, detail: '' };
      const hit = rows.filter((r) => containerIs(r, c.state));
      return { value: hit.length > 0, detail: hit.map((r) => `${r.name}: ${r.status}`).join(', ') };
    }
    case 'problem': {
      const re = glob(c.match);
      const hit = (facts.open ?? []).filter((i) => re.test(i.key) || re.test(i.title ?? ''));
      if (c.is === 'cleared') return { value: hit.length === 0, detail: '' };
      return { value: hit.length > 0, detail: hit.map((i) => i.title).join(', ') };
    }
    case 'array': {
      if (!facts.md || !facts.md.mdState) return { value: null, detail: '' };
      const started = facts.md.mdState === 'STARTED';
      const syncing = Number(facts.md.mdResyncPos || 0) > 0;
      const value = { started, stopped: !started, syncing, 'not syncing': !syncing }[c.is];
      return { value, detail: `array ${facts.md.mdState}${syncing ? ', parity sync/check running' : ''}` };
    }
    case 'notification': {
      if (!facts.notifications) return { value: null, detail: '', ids: [] };
      const re = glob(c.match);
      const hit = facts.notifications.filter((n) => re.test(n.text));
      return { value: hit.length > 0, detail: hit.map((n) => n.subject).join(', '), ids: hit.map((n) => n.id) };
    }
    default:
      return { value: null, detail: '' };
  }
}

// Array problems (array stopped, disk disabled) always come through.
export function mutable(incident) {
  return !String(incident.key).startsWith('array:');
}

export function matches(mute, incident) {
  const re = glob(mute.match);
  return re.test(incident.key) || re.test(incident.title ?? '');
}

export function mutedBy(prefs, incident) {
  if (!mutable(incident)) return undefined;
  return prefs.mutes.find((m) => matches(m, incident));
}

export function partition(prefs, incidents) {
  const shown = [];
  const muted = [];
  for (const i of incidents) (mutedBy(prefs, i) ? muted : shown).push(i);
  return { shown, muted };
}

// ── Changing rules ───────────────────────────────────────────────────────────

function room(prefs, kind) {
  if (prefs[kind].length >= MAX_RULES) throw new Error(`Too many ${kind} (${MAX_RULES}). Remove some first (\`rules\`, then \`remove <id>\`).`);
}

function withId(prefs, kind, prefix, rule) {
  const r = { id: `${prefix}${prefs.next}`, ...rule };
  return { prefs: { ...prefs, next: prefs.next + 1, [kind]: [...prefs[kind], r] }, rule: r };
}

// spec: { match, until?: ms, untilWhen?: condition } (already validated or not)
export function addMute(prefs, spec, now = Date.now()) {
  const match = validMatch(spec.match);
  if (!match) throw new Error('That mute pattern is not allowed (letters, numbers, spaces and . * : - only; not just *).');
  if (/^array:/i.test(match)) throw new Error('Array problems (array stopped, disk disabled) cannot be muted.');
  const until = spec.until === undefined || spec.until === null ? null : validTime(spec.until, now);
  if (spec.until !== undefined && spec.until !== null && until === null) throw new Error('That end time is not valid (it must be in the future, within a year).');
  const untilWhen = spec.untilWhen ? validCondition(spec.untilWhen, now) : null;
  if (spec.untilWhen && !untilWhen) throw new Error('I cannot check that end condition.');
  // A new mute for the same pattern replaces the old one.
  const base = { ...prefs, mutes: prefs.mutes.filter((m) => m.match.toLowerCase() !== match.toLowerCase()) };
  room(base, 'mutes');
  return withId(base, 'mutes', 'm', { match, until, untilWhen, added: now });
}

// spec: { when, say, repeat?, expires?: ms }. facts: the latest facts, so an
// alert only fires on a change: "tell me when plex is running" while it
// already runs waits for it to stop and start again.
export function addAlert(prefs, spec, facts, now = Date.now()) {
  const when = validCondition(spec.when, now);
  if (!when) throw new Error('I cannot check that condition.');
  const say = validText(spec.say, 200) ?? describeCondition(when);
  const expires = spec.expires === undefined || spec.expires === null ? null : validTime(spec.expires, now);
  if (spec.expires && expires === null) throw new Error('That expiry time is not valid.');
  room(prefs, 'alerts');
  const e = facts ? evaluate(when, facts, now) : { value: null, ids: [] };
  return withId(prefs, 'alerts', 'a', {
    when, say, repeat: Boolean(spec.repeat), expires,
    last: when.type === 'time' ? false : e.value, seen: e.ids ?? [], added: now,
  });
}

export function addNote(prefs, text, now = Date.now()) {
  const t = validText(text);
  if (!t) throw new Error(`A note must be 1 to ${MAX_TEXT} characters.`);
  const same = prefs.notes.find((n) => n.text.toLowerCase() === t.toLowerCase());
  if (same) return { prefs, rule: same };
  room(prefs, 'notes');
  return withId(prefs, 'notes', 'n', { text: t, added: now });
}

export function validIds(ids) {
  const list = (Array.isArray(ids) ? ids : String(ids ?? '').split(/[\s,]+/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  if (!list.length || list.length > 20 || !list.every((x) => ID.test(x) || x === 'all')) return null;
  return [...new Set(list)];
}

// Remove rules by id ("m1", "a2", "n3") or "all". Returns the removed rules.
export function removeRules(prefs, ids) {
  const all = ids.includes('all');
  const removed = [];
  const keep = {};
  for (const kind of ['mutes', 'alerts', 'notes']) {
    keep[kind] = prefs[kind].filter((r) => {
      const gone = all || ids.includes(r.id);
      if (gone) removed.push(r);
      return !gone;
    });
  }
  if (!removed.length) throw new Error(`No rule with id ${ids.join(', ')}. Type \`rules\` to see them.`);
  return { prefs: { ...prefs, ...keep }, removed };
}

// Put removed rules back (the Undo button).
export function restoreRules(prefs, rules) {
  const out = { ...prefs, mutes: [...prefs.mutes], alerts: [...prefs.alerts], notes: [...prefs.notes] };
  for (const r of rules) {
    const kind = r.id?.startsWith('m') ? 'mutes' : r.id?.startsWith('a') ? 'alerts' : 'notes';
    if (!out[kind].some((x) => x.id === r.id)) out[kind].push(r);
  }
  return out;
}

/**
 * One watcher run: lift mutes whose time or condition came, fire alerts whose
 * condition became true, drop alerts that expired.
 * Returns { prefs, lifted: [{ rule, detail }], fired: [{ rule, detail }], expired: [rule] }.
 */
export function step(prefs, facts, now = Date.now()) {
  const lifted = [];
  const mutes = [];
  for (const m of prefs.mutes) {
    if (m.until !== null && m.until !== undefined && now >= m.until) {
      lifted.push({ rule: m, detail: 'its time ran out' });
      continue;
    }
    if (m.untilWhen) {
      const e = evaluate(m.untilWhen, facts, now);
      if (e.value === true) {
        lifted.push({ rule: m, detail: e.detail || describeCondition(m.untilWhen) });
        continue;
      }
    }
    mutes.push(m);
  }

  const fired = [];
  const expired = [];
  const alerts = [];
  for (const a of prefs.alerts) {
    if (a.expires && now >= a.expires) {
      expired.push(a);
      continue;
    }
    const e = evaluate(a.when, facts, now);
    let fire = false;
    let next = { ...a };
    if (a.when.type === 'notification') {
      const fresh = (e.ids ?? []).filter((id) => !(a.seen ?? []).includes(id));
      fire = fresh.length > 0;
      if (e.value !== null) next.seen = [...new Set([...(a.seen ?? []), ...fresh])].slice(-200);
    } else if (e.value !== null) {
      fire = e.value === true && a.last !== true;
      next.last = e.value;
    }
    if (fire) fired.push({ rule: a, detail: e.detail });
    if (!fire || a.repeat) alerts.push(next);
  }

  return { prefs: { ...prefs, mutes, alerts }, lifted, fired, expired };
}

// ── Plain-English descriptions (written by the watcher, not by Claude) ──────

export function fmtTime(ms) {
  return new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function describeCondition(c) {
  switch (c.type) {
    case 'time': return `it is ${fmtTime(c.at)}`;
    case 'disk': return `${c.disk === '*' ? 'any disk or pool' : `\`${c.disk}\``} is ${c.op === '>=' ? `${c.percent}% full or more` : `${c.percent}% full or less`}`;
    case 'container': return c.state === 'gone' ? `\`${c.name}\` no longer exists` : `\`${c.name}\` is ${c.state}`;
    case 'problem': return c.is === 'cleared' ? `problems matching \`${c.match}\` have cleared` : `a problem matching \`${c.match}\` comes up`;
    case 'notification': return `Unraid sends a notification matching \`${c.match}\``;
    case 'array': return c.is === 'syncing' ? 'a parity sync or check is running' : c.is === 'not syncing' ? 'the parity sync or check has finished' : `the array is ${c.is}`;
    default: return 'something I cannot check';
  }
}

export function describeRule(r) {
  const id = r.id ? `\`${r.id}\` ` : '';
  if (r.match !== undefined) {
    const ends = [];
    if (r.until) ends.push(fmtTime(r.until));
    if (r.untilWhen) ends.push(describeCondition(r.untilWhen));
    return `${id}🔕 Not telling you about \`${r.match}\` ${ends.length ? `until ${ends.join(', or until ')}` : 'until you remove this'}`;
  }
  if (r.when) {
    return `${id}🔔 Telling you ${r.repeat ? 'every time' : 'once'} when ${describeCondition(r.when)}${r.expires ? ` (until ${fmtTime(r.expires)})` : ''}: "${r.say}"`;
  }
  return `${id}📝 Note for every report: "${r.text}"`;
}

export function listRules(prefs) {
  const all = [...prefs.mutes, ...prefs.alerts, ...prefs.notes];
  if (!all.length) return 'No rules yet. Tell me things like "don\'t tell me about disk space until a disk hits 99%" or "let me know when plex is back up".';
  return `**Your rules:**\n${all.map(describeRule).join('\n')}\nRemove with \`remove <id>\` (e.g. \`remove m1\`) or \`remove all\`.`;
}

// Typed "mute"/"snooze" arguments: "<pattern> [for] [N days|Nd|Nh|forever]".
// A plain word becomes *word*, so "mute docker.img" catches any title with it.
export function parseMuteArgs(rest, defaultDays, now = Date.now()) {
  let text = rest.trim();
  let ms = defaultDays === null ? null : defaultDays * DAY;
  const m = text.match(/\s+(?:for\s+)?(forever|(\d+)\s*(d|days?|h|hours?))\s*$/i);
  if (m) {
    ms = m[1].toLowerCase() === 'forever' ? null : Number(m[2]) * (m[3].toLowerCase().startsWith('h') ? 3_600_000 : DAY);
    text = text.slice(0, m.index).trim();
  }
  if (text && !text.includes('*') && !text.includes(':')) text = `*${text}*`;
  return { match: text, until: ms === null ? null : now + ms };
}
