// unraid-watch: checks the server every few minutes without AI, asks Claude
// (read-only) to explain new problems and to write a morning report, and
// sends both to the owner's Discord DM, with buttons for the few fixes it is
// allowed to make. Started by the container's entrypoint as root, so Claude's
// user cannot read its Discord token; Claude itself runs as that user.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ActionBook, describeOffer, validateSuggestions } from './actions.mjs';
import { askClaude, chatPrompt, incidentPrompt, morningPrompt } from './claude.mjs';
import { collect } from './checks.mjs';
import { loadConfig } from './config.mjs';
import { startDiscord } from './discord.mjs';
import { diff, emptyState, failureFindings, openIncidents } from './incidents.mjs';
import {
  addMute, addNote, describeMute, emptyPrefs, expireMutes, matches, mutedBy,
  normalizePrefs, parseMuteArgs, partition, removeEntry,
} from './prefs.mjs';
import { asClaude, run } from './run.mjs';
import { msUntil } from './schedule.mjs';

const HELP = [
  '**Commands** (just type them here):',
  '• `report`: the full server report now',
  '• `status`: problems I currently know about',
  '• `check`: run the checks now',
  '• `mute <word or id> [7d|forever]`: no more alerts about it (default: until you unmute)',
  '• `snooze <word or id> [days]`: the same, for 7 days unless you say otherwise',
  '• `mutes`, `unmute <number|all>`: see or undo mutes',
  '• `note <text>`: a standing instruction for every report, e.g. `note don\'t mention parity`',
  '• `notes`, `forget <number|all>`: see or remove notes',
  '• `help`: this list',
  'Anything else goes to Claude, e.g. "why is plex slow?" or "snooze that". Claude can only look; changes come as buttons you tap.',
].join('\n');

const ICON = { critical: '🔴', warning: '⚠️' };
const HISTORY = 12;
// Words that mean "the thing we just talked about": Claude resolves those.
const VAGUE = new Set(['', 'that', 'this', 'it', 'these', 'those', 'them', 'all', 'everything']);

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(`unraid-watch: not started: ${err.message}`);
    process.exit(2);
  }

  await mkdir(cfg.stateDir, { recursive: true, mode: 0o700 });
  const statePath = join(cfg.stateDir, 'state.json');
  const prefsPath = join(cfg.stateDir, 'prefs.json');
  // First start or unreadable: start clean (open problems are re-reported).
  let state = await readJson(statePath, emptyState());
  if (!state || typeof state.open !== 'object') state = emptyState();
  let prefs = normalizePrefs(await readJson(prefsPath, emptyPrefs()));
  const saveState = () => writeJson(statePath, state);
  const savePrefs = () => writeJson(prefsPath, prefs);

  async function muteNow(match, days) {
    const r = addMute(prefs, { match, days });
    prefs = r.prefs;
    await savePrefs();
    const n = openIncidents(state).filter((i) => matches(r.mute, i)).length;
    return `🔕 Muted ${describeMute(r.mute)}.${n ? ` That covers ${n} open problem${n === 1 ? '' : 's'}.` : ''} Type \`mutes\` to see or undo.`;
  }

  async function noteNow(text) {
    const r = addNote(prefs, text);
    prefs = r.prefs;
    await savePrefs();
    return `📝 Noted for every report: "${r.note.text}". Type \`notes\` to see or remove.`;
  }

  const book = new ActionBook({
    run,
    auditPath: join(cfg.stateDir, 'audit.jsonl'),
    local: {
      'watch.mute': (o) => muteNow(o.target, o.days),
      'watch.note': (o) => noteNow(o.text),
    },
  });
  let containers = [];

  // One Claude run at a time; later requests wait their turn.
  let queue = Promise.resolve();
  function withClaude(fn) {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  }

  // The last few messages, so "snooze that" in a fresh Claude run knows what
  // "that" is.
  const history = [];
  function remember(who, text) {
    history.push({ who, text: String(text).replace(/\s+/g, ' ').slice(0, 600) });
    while (history.length > HISTORY) history.shift();
  }

  let bot;
  async function say(text, offers = []) {
    remember('bot', text);
    await bot.send(text, offers);
  }

  function ctx() {
    return { notes: prefs.notes, muted: prefs.mutes, history: [...history] };
  }

  async function sendWithOffers(text, suggestions) {
    const valid = validateSuggestions(suggestions, containers);
    const offers = valid.map((s) => ({ ...s, id: book.offer(s) }));
    const exact = offers.map(describeOffer).filter(Boolean);
    await say(exact.length ? `${text}\n\n${exact.join('\n')}` : text, offers);
  }

  async function ask(prompt) {
    const stop = setInterval(() => bot.typing(), 8000);
    bot.typing();
    try {
      return await askClaude(cfg, prompt, { asClaude });
    } finally {
      clearInterval(stop);
    }
  }

  function shownIncidents() {
    return partition(prefs, openIncidents(state)).shown;
  }

  function plainList(incidents) {
    if (!incidents.length) return '✅ No open problems.';
    return incidents.map((i) => `${ICON[i.severity] ?? '•'} **${i.title}**${i.detail ? `\n   ${i.detail}` : ''}`).join('\n');
  }

  function statusText() {
    const { shown, muted } = partition(prefs, openIncidents(state));
    const tail = muted.length ? `\n_${muted.length} muted problem${muted.length === 1 ? '' : 's'} not shown: type \`mutes\`._` : '';
    return plainList(shown) + tail;
  }

  let checking = false;
  async function check({ quiet = false } = {}) {
    if (checking) return { raised: [], resolved: [] };
    checking = true;
    try {
      const exp = expireMutes(prefs);
      if (exp.expired.length) {
        prefs = exp.prefs;
        await savePrefs();
      }
      const res = await collect(cfg, { run, asClaude });
      containers = res.containers.length ? res.containers : containers;
      const findings = [...res.findings, ...failureFindings(res.failed)];
      const d = diff(state, findings, res.failed);
      state = d.state;
      await saveState();

      const raised = d.raised.filter((i) => !mutedBy(prefs, i));
      // A snooze that ran out: its problems, if still there, come back once.
      for (const i of openIncidents(state)) {
        if (raised.some((r) => r.key === i.key) || mutedBy(prefs, i)) continue;
        if (exp.expired.some((m) => matches(m, i))) raised.push(i);
      }
      const resolved = d.resolved.filter((i) => !mutedBy(prefs, i));

      if (!quiet) {
        if (resolved.length) {
          await say(`✅ **Cleared:**\n${resolved.map((i) => `• ${i.title}`).join('\n')}`);
        }
        if (raised.length) {
          withClaude(async () => {
            const r = await ask(incidentPrompt(raised, shownIncidents(), ctx()));
            if (r.ok) {
              const head = raised.some((i) => i.severity === 'critical') ? '🔴 **New problem**' : '⚠️ **New problem**';
              await sendWithOffers(`${head}\n${r.text}`, r.actions);
            } else {
              await say(`${plainList(raised)}\n\n_(Claude could not look into this: ${r.error})_`);
            }
          }).catch((err) => console.error(`unraid-watch: incident report failed: ${err.stack ?? err}`));
        }
      }
      return { raised, resolved };
    } finally {
      checking = false;
    }
  }

  async function report() {
    await check({ quiet: true });
    await withClaude(async () => {
      const r = await ask(morningPrompt(shownIncidents(), ctx()));
      if (r.ok) await sendWithOffers(`☀️ **Server report**\n${r.text}`, r.actions);
      else await say(`☀️ **Server report** (without Claude: ${r.error})\n${statusText()}`);
    });
  }

  function listMutes() {
    if (!prefs.mutes.length) return 'Nothing is muted.';
    return `**Muted:**\n${prefs.mutes.map((m, i) => `${i + 1}. ${describeMute(m)}`).join('\n')}\nUndo with \`unmute <number>\` or \`unmute all\`.`;
  }

  function listNotes() {
    if (!prefs.notes.length) return 'No notes. Add one with `note <text>`.';
    return `**Notes for every report:**\n${prefs.notes.map((n, i) => `${i + 1}. ${n.text}`).join('\n')}\nRemove with \`forget <number>\` or \`forget all\`.`;
  }

  async function remove(kind, which) {
    const r = removeEntry(prefs, kind, which);
    prefs = r.prefs;
    await savePrefs();
    const what = kind === 'mutes' ? 'Unmuted' : 'Forgot';
    const items = r.removed.map((x) => (kind === 'mutes' ? `\`${x.match}\`` : `"${x.text}"`));
    return items.length ? `${what}: ${items.join(', ')}.` : 'Nothing to remove.';
  }

  // Typed commands; returns the reply, or null when the text is for Claude.
  async function command(text) {
    const [first, ...restWords] = text.split(/\s+/);
    const word = first.toLowerCase();
    const rest = restWords.join(' ').trim();
    if (!rest) {
      if (word === 'help' || word === '?') return HELP;
      if (word === 'status') return statusText();
      if (word === 'mutes' || word === 'muted') return listMutes();
      if (word === 'notes') return listNotes();
      if (word === 'report') {
        await report();
        return '';
      }
      if (word === 'check') {
        const d = await check();
        return d.raised.length || d.resolved.length ? '' : `Checked. Nothing new.\n${statusText()}`;
      }
    }
    if (word === 'mute' || word === 'snooze') {
      const { match, days } = parseMuteArgs(rest, word === 'snooze' ? 7 : null);
      if (VAGUE.has(match.replace(/\*/g, '').toLowerCase())) return null;
      return muteNow(match, days);
    }
    if (word === 'unmute' && rest) return remove('mutes', rest);
    if (word === 'forget' && rest) return remove('notes', rest);
    if (word === 'note' && rest) return noteNow(rest);
    return null;
  }

  async function onText(raw) {
    const text = raw.trim();
    if (!text) return;
    remember('owner', text);
    let reply;
    try {
      reply = await command(text);
    } catch (err) {
      reply = `⚠️ ${err.message}`;
    }
    if (reply === '') return;
    if (reply !== null) return say(reply);
    return withClaude(async () => {
      const r = await ask(chatPrompt(text, shownIncidents(), ctx()));
      if (r.ok) await sendWithOffers(r.text, r.actions);
      else await say(`Claude could not answer: ${r.error}`);
    });
  }

  bot = await startDiscord(cfg, {
    onText,
    onFix: async (id, who) => {
      const r = await book.approve(id, who);
      remember('bot', r.message);
      return r;
    },
    onSkip: (ids) => book.withdraw(ids),
  });

  const when = cfg.reportTime === 'off' ? 'no morning report' : `the morning report at ${cfg.reportTime}`;
  await say(`👋 Unraid watcher started. I check the server every ${cfg.intervalMinutes} minutes and send ${when}. Type \`help\` for commands.`);

  await check().catch((err) => console.error(`unraid-watch: check failed: ${err.stack ?? err}`));
  setInterval(() => {
    check().catch((err) => console.error(`unraid-watch: check failed: ${err.stack ?? err}`));
  }, cfg.intervalMinutes * 60_000);

  if (cfg.reportTime !== 'off') {
    const schedule = () => {
      setTimeout(async () => {
        try {
          await report();
        } catch (err) {
          console.error(`unraid-watch: morning report failed: ${err.stack ?? err}`);
        }
        schedule();
      }, msUntil(cfg.reportTime));
    };
    schedule();
  }
}

main().catch((err) => {
  console.error(`unraid-watch: fatal: ${err.stack ?? err}`);
  process.exit(1);
});
