// The owner's preferences, kept in the watcher's own state (never in Claude's
// reach): mutes, which stop alerts for matching problems for a while or until
// unmuted, and notes, standing instructions that go into every Claude prompt
// ("don't mention parity, I know"). They change only by the owner's typed
// command or a button the owner taps.

export const MAX_MUTES = 50;
export const MAX_NOTES = 20;
export const MAX_NOTE_LEN = 300;
export const MAX_MUTE_DAYS = 365;
const DAY = 86_400_000;
const MATCH = /^[\w .*:@/+#-]{1,120}$/;

export function emptyPrefs() {
  return { mutes: [], notes: [] };
}

export function normalizePrefs(p) {
  return {
    mutes: Array.isArray(p?.mutes) ? p.mutes.filter((m) => m && typeof m.match === 'string') : [],
    notes: Array.isArray(p?.notes) ? p.notes.filter((n) => n && typeof n.text === 'string') : [],
  };
}

// A mute pattern: a problem id (disk:disk1:full) or a pattern with *
// (disk:*:full, *docker.img*), matched case-insensitively against problem ids
// and titles. A pattern that is only * (everything) is refused.
export function validMatch(match) {
  const m = String(match ?? '').trim();
  if (!MATCH.test(m)) return null;
  if (!m.replace(/[*\s]/g, '')) return null;
  return m;
}

// null = until unmuted; otherwise whole days, 1 to MAX_MUTE_DAYS.
export function validDays(days) {
  if (days === null || days === undefined || days === 'forever') return { ok: true, days: null };
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > MAX_MUTE_DAYS) return { ok: false };
  return { ok: true, days: n };
}

export function validNote(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > MAX_NOTE_LEN) return null;
  return t;
}

function globToRegExp(glob) {
  const esc = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${esc}$`, 'i');
}

function active(m, now) {
  return m.until === null || m.until === undefined || m.until > now;
}

// Does this mute's pattern cover the incident (ignoring whether it expired)?
export function matches(mute, incident) {
  const re = globToRegExp(mute.match);
  return re.test(incident.key) || re.test(incident.title ?? '');
}

export function mutedBy(prefs, incident, now = Date.now()) {
  return prefs.mutes.find((m) => active(m, now) && matches(m, incident));
}

// Split incidents into those to show and those the owner muted.
export function partition(prefs, incidents, now = Date.now()) {
  const shown = [];
  const muted = [];
  for (const i of incidents) (mutedBy(prefs, i, now) ? muted : shown).push(i);
  return { shown, muted };
}

// Returns the new prefs and the mute, or throws with a message for the owner.
export function addMute(prefs, { match, days }, now = Date.now()) {
  const m = validMatch(match);
  if (!m) throw new Error('That mute pattern is not allowed (letters, numbers, spaces and . * : - only; not just *).');
  const d = validDays(days);
  if (!d.ok) throw new Error(`Days must be a whole number from 1 to ${MAX_MUTE_DAYS}, or forever.`);
  const mutes = prefs.mutes.filter((x) => x.match.toLowerCase() !== m.toLowerCase() && active(x, now));
  if (mutes.length >= MAX_MUTES) throw new Error(`Too many mutes (${MAX_MUTES}). Remove some with \`unmute\`.`);
  const mute = { match: m, until: d.days === null ? null : now + d.days * DAY, added: now };
  return { prefs: { ...prefs, mutes: [...mutes, mute] }, mute };
}

export function addNote(prefs, text, now = Date.now()) {
  const t = validNote(text);
  if (!t) throw new Error(`A note must be 1 to ${MAX_NOTE_LEN} characters.`);
  if (prefs.notes.some((n) => n.text.toLowerCase() === t.toLowerCase())) return { prefs, note: { text: t } };
  if (prefs.notes.length >= MAX_NOTES) throw new Error(`Too many notes (${MAX_NOTES}). Remove some with \`forget\`.`);
  const note = { text: t, added: now };
  return { prefs: { ...prefs, notes: [...prefs.notes, note] }, note };
}

// Remove entry n (1-based, as listed) or 'all' from mutes or notes.
export function removeEntry(prefs, kind, which) {
  const list = prefs[kind];
  if (String(which).toLowerCase() === 'all') return { prefs: { ...prefs, [kind]: [] }, removed: list };
  const n = Number(which);
  if (!Number.isInteger(n) || n < 1 || n > list.length) throw new Error(`Pick a number from the list (1 to ${list.length}) or all.`);
  return { prefs: { ...prefs, [kind]: list.filter((_, i) => i !== n - 1) }, removed: [list[n - 1]] };
}

// Drop timed mutes that have run out; returns them so their problems can be
// reported again.
export function expireMutes(prefs, now = Date.now()) {
  const expired = prefs.mutes.filter((m) => !active(m, now));
  if (!expired.length) return { prefs, expired };
  return { prefs: { ...prefs, mutes: prefs.mutes.filter((m) => active(m, now)) }, expired };
}

export function describeMute(m) {
  if (m.until === null || m.until === undefined) return `\`${m.match}\` until you unmute it`;
  return `\`${m.match}\` until ${new Date(m.until).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function daysText(days) {
  return days === null ? 'until unmuted' : `${days} day${days === 1 ? '' : 's'}`;
}

// Typed "mute"/"snooze" arguments: "<pattern> [for] [N days|Nd|forever]".
// A plain word becomes *word*, so "mute docker.img" catches any title with it.
export function parseMuteArgs(rest, defaultDays) {
  let text = rest.trim();
  let days = defaultDays;
  const m = text.match(/\s+(?:for\s+)?(forever|(\d+)\s*(?:d|days?))\s*$/i);
  if (m) {
    days = m[1].toLowerCase() === 'forever' ? null : Number(m[2]);
    text = text.slice(0, m.index).trim();
  }
  if (text && !text.includes('*') && !text.includes(':')) text = `*${text}*`;
  return { match: text, days };
}
