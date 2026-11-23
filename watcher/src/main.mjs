// unraid-watch: checks the server every few minutes without AI, asks Claude
// (read-only) to explain new problems and to write a morning report, and
// sends both to the owner's Discord DM, with buttons for the few fixes it is
// allowed to make. The owner can also set rules in plain words ("don't tell
// me about X until Y", "let me know when Z"): Claude turns them into a rule,
// the watcher validates and checks it (rules.mjs). Started by the
// container's entrypoint as root, so Claude's user cannot read its Discord
// token or its state; Claude itself runs as that user.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ActionBook, CATALOG, describeOffer, validateSuggestions } from './actions.mjs';
import { askClaude, chatPrompt, incidentPrompt, morningPrompt } from './claude.mjs';
import { collect } from './checks.mjs';
import { loadConfig } from './config.mjs';
import { startDiscord } from './discord.mjs';
import { diff, emptyState, failureFindings, openIncidents } from './incidents.mjs';
import {
  addAlert, addMute, addNote, describeCondition, describeRule, emptyPrefs, listRules, matches,
  mutedBy, normalizePrefs, parseMuteArgs, partition, removeRules, restoreRules, step, validIds,
} from './rules.mjs';
import { asClaude, run } from './run.mjs';
import { msUntil } from './schedule.mjs';

const HELP = [
  'Talk to me normally, e.g. "why is plex slow?", "don\'t tell me about disk space until a disk hits 99%", "let me know when the parity check finishes", "snooze that till Friday". Rules apply right away and come with an Undo button.',
  '',
  '**Commands:**',
  '• `report`: the full server report now',
  '• `status`: problems I currently know about',
  '• `check`: run the checks now',
  '• `rules`: your mutes, alerts and notes, with their ids',
  '• `remove <id>` (e.g. `remove m1`) or `remove all`',
  '• `mute <word> [7d|12h|forever]`, `snooze <word> [days]`, `note <text>`: quick versions without Claude',
  '• `help`: this list',
  'Claude can only look; container fixes come as buttons you tap.',
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

  // The latest raw facts from the checks, for new alerts' starting point.
  let facts = null;
  let containers = [];

  // Apply one validated rule change. Returns { message, created, removed }.
  async function applyRule(s) {
    let message;
    let created = [];
    let removed = [];
    if (s.action === 'watch.mute') {
      const r = addMute(prefs, s.spec);
      prefs = r.prefs;
      created = [r.rule.id];
      const n = openIncidents(state).filter((i) => matches(r.rule, i)).length;
      message = `${describeRule(r.rule)}.${n ? ` That covers ${n} open problem${n === 1 ? '' : 's'}.` : ''}`;
    } else if (s.action === 'watch.alert') {
      const r = addAlert(prefs, s.spec, facts && { ...facts, open: openIncidents(state) });
      prefs = r.prefs;
      created = [r.rule.id];
      const already = r.rule.last === true && r.rule.when.type !== 'notification';
      message = `${describeRule(r.rule)}.${already ? ' That is already the case right now, so I will tell you the next time it happens.' : ''}`;
    } else if (s.action === 'watch.note') {
      const r = addNote(prefs, s.spec.text);
      prefs = r.prefs;
      created = [r.rule.id];
      message = `${describeRule(r.rule)}.`;
    } else if (s.action === 'watch.remove') {
      const r = removeRules(prefs, s.spec.ids);
      prefs = r.prefs;
      removed = r.removed;
      message = `🗑️ Removed: ${r.removed.map((x) => `\`${x.id}\``).join(', ')}.`;
    } else if (s.action === 'watch.undo') {
      if (s.spec.remove.length) {
        try {
          prefs = removeRules(prefs, s.spec.remove).prefs;
        } catch {
          // Already removed by hand: fine.
        }
      }
      prefs = restoreRules(prefs, s.spec.add);
      message = '↩️ Undone.';
    } else {
      throw new Error('unknown rule action');
    }
    await savePrefs();
    return { message, created, removed };
  }

  const book = new ActionBook({
    run,
    auditPath: join(cfg.stateDir, 'audit.jsonl'),
    local: Object.fromEntries(
      ['watch.mute', 'watch.alert', 'watch.note', 'watch.remove', 'watch.undo'].map((a) => [a, async (o) => (await applyRule(o)).message]),
    ),
  });

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

  const ctx = () => ({ prefs, history: [...history] });

  // Send Claude's reply. apply: rule changes were asked for in the owner's
  // own chat message, so they take effect now, with an Undo button; in
  // reports and alerts they are only offered as buttons.
  async function respond(text, suggestions, { apply = false } = {}) {
    const valid = validateSuggestions(suggestions, containers);
    const done = [];
    const offers = [];
    const undo = { add: [], remove: [] };
    for (const s of valid) {
      if (apply && CATALOG[s.action].local) {
        try {
          const r = await applyRule(s);
          done.push(`✅ ${r.message}`);
          undo.remove.push(...r.created);
          undo.add.push(...r.removed);
          await book.audit({ who: 'owner (chat)', action: s.action, target: s.target, spec: s.spec, result: 'ok' });
        } catch (err) {
          done.push(`⚠️ ${err.message}`);
        }
      } else {
        offers.push({ ...s, id: book.offer(s) });
      }
    }
    if (undo.add.length || undo.remove.length) {
      const u = { action: 'watch.undo', target: 'undo', spec: undo };
      offers.push({ ...u, id: book.offer(u) });
    }
    const exact = offers.map(describeOffer).filter(Boolean).map((d) => `Tap to: ${d}`);
    const tail = [...done, ...exact];
    await say(tail.length ? `${text}\n\n${tail.join('\n')}` : text, offers);
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

  const shownIncidents = () => partition(prefs, openIncidents(state)).shown;

  function plainList(incidents) {
    if (!incidents.length) return '✅ No open problems.';
    return incidents.map((i) => `${ICON[i.severity] ?? '•'} **${i.title}**${i.detail ? `\n   ${i.detail}` : ''}`).join('\n');
  }

  function statusText() {
    const { shown, muted } = partition(prefs, openIncidents(state));
    const tail = muted.length ? `\n_${muted.length} muted problem${muted.length === 1 ? '' : 's'} not shown: type \`rules\`._` : '';
    return plainList(shown) + tail;
  }

  let checking = false;
  async function check({ quiet = false } = {}) {
    if (checking) return { raised: [], resolved: [] };
    checking = true;
    try {
      const res = await collect(cfg, { run, asClaude });
      containers = res.containers.length ? res.containers : containers;
      const findings = [...res.findings, ...failureFindings(res.failed)];
      const d = diff(state, findings, res.failed);
      state = d.state;
      await saveState();

      facts = res.facts;
      const st = step(prefs, { ...facts, open: openIncidents(state) });
      prefs = st.prefs;
      if (st.lifted.length || st.fired.length || st.expired.length) await savePrefs();

      const raised = d.raised.filter((i) => !mutedBy(prefs, i));
      // A mute that ended: its problems, if still there, come back once.
      for (const i of openIncidents(state)) {
        if (raised.some((r) => r.key === i.key) || mutedBy(prefs, i)) continue;
        if (st.lifted.some((l) => matches(l.rule, i))) raised.push(i);
      }
      const resolved = d.resolved.filter((i) => !mutedBy(prefs, i));

      // The owner's own alerts always go out, also during a report.
      for (const { rule, detail } of st.fired) {
        const more = rule.repeat ? ` I'll keep telling you; \`remove ${rule.id}\` to stop.` : '';
        await say(`🔔 **${rule.say}**${detail ? `\n${detail}` : ''}\n_You asked me to tell you when ${describeCondition(rule.when)}.${more}_`);
      }
      for (const { rule, detail } of st.lifted) {
        await say(`🔔 Back to telling you about \`${rule.match}\`: ${detail}.`);
      }
      for (const rule of st.expired) {
        await say(`⌛ Stopped watching for: "${rule.say}" (the time you set ran out).`);
      }

      if (!quiet) {
        if (resolved.length) {
          await say(`✅ **Cleared:**\n${resolved.map((i) => `• ${i.title}`).join('\n')}`);
        }
        if (raised.length) {
          withClaude(async () => {
            const r = await ask(incidentPrompt(raised, shownIncidents(), ctx()));
            if (r.ok) {
              const head = raised.some((i) => i.severity === 'critical') ? '🔴 **New problem**' : '⚠️ **New problem**';
              await respond(`${head}\n${r.text}`, r.actions);
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
      if (r.ok) await respond(`☀️ **Server report**\n${r.text}`, r.actions);
      else await say(`☀️ **Server report** (without Claude: ${r.error})\n${statusText()}`);
    });
  }

  // Typed commands; returns the reply, '' when already answered, or null
  // when the text is for Claude.
  async function command(text) {
    const [first, ...restWords] = text.split(/\s+/);
    const word = first.toLowerCase();
    const rest = restWords.join(' ').trim();
    if (!rest) {
      if (word === 'help' || word === '?') return HELP;
      if (word === 'status') return statusText();
      if (['rules', 'mutes', 'muted', 'notes', 'alerts'].includes(word)) return listRules(prefs);
      if (word === 'report') {
        await report();
        return '';
      }
      if (word === 'check') {
        const d = await check();
        return d.raised.length || d.resolved.length ? '' : `Checked. Nothing new.\n${statusText()}`;
      }
    }
    if (['remove', 'unmute', 'forget', 'cancel', 'delete'].includes(word) && rest) {
      const ids = validIds(rest);
      if (!ids) return null; // "forget about plex": let Claude work out which rule
      const r = await applyRule({ action: 'watch.remove', spec: { ids } });
      return r.message;
    }
    if (word === 'mute' || word === 'snooze') {
      const spec = parseMuteArgs(rest, word === 'snooze' ? 7 : null);
      if (VAGUE.has(spec.match.replace(/\*/g, '').toLowerCase())) return null;
      return `✅ ${(await applyRule({ action: 'watch.mute', spec })).message}`;
    }
    if (word === 'note' && rest) return `✅ ${(await applyRule({ action: 'watch.note', spec: { text: rest } })).message}`;
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
      if (r.ok) await respond(r.text, r.actions, { apply: true });
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
