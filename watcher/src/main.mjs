// unraid-watch: checks the server every few minutes without AI, asks Claude
// (read-only) to explain new problems and to write a morning report, and
// sends both to the owner's Discord DM, with buttons for the few fixes it is
// allowed to make. The owner can also set rules in plain words ("don't tell
// me about X until Y", "let me know when Z"): Claude turns them into a rule,
// the watcher validates and checks it (rules.mjs). Started by the
// container's entrypoint as root, so Claude's user cannot read its Discord
// token or its state; Claude itself runs as that user.
import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ActionBook, CATALOG, describeOffer, validateSuggestions } from './actions.mjs';
import { askClaude, chatPrompt, fixPrompt, incidentPrompt, morningPrompt } from './claude.mjs';
import { collect } from './checks.mjs';
import { loadConfig } from './config.mjs';
import { approvalRow, startDiscord } from './discord.mjs';
import { APPROVAL_MS, FixBroker, serveFixSocket } from './fix.mjs';
import { diff, emptyState, failureFindings, openIncidents } from './incidents.mjs';
import {
  addAlert, addMute, addNote, describeCondition, describeRule, emptyPrefs, listRules, matches,
  mutedBy, normalizePrefs, parseMuteArgs, partition, removeRules, restoreRules, step, validIds,
} from './rules.mjs';
import { asClaude, run } from './run.mjs';
import { pinStateDir } from './statedir.mjs';
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
  'To fix something, tap 🛠️ Fix it on an alert or just ask ("sonarr says permission denied, fix it"). Claude asks you with Allow / Deny before every single change.',
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

async function exists(path) {
  return access(path).then(() => true, () => false);
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

  // Every path below goes through the checked, open directory (statedir.mjs).
  const stateDir = await pinStateDir(cfg.stateDir, { uid: process.getuid?.() ?? 0 });
  // Marks this appdata folder as the tool's own data: host-fix never changes
  // anything below a folder that has it.
  await writeFile(join(stateDir, '.claude-unraid-watch'), 'claude-unraid-manager watcher state\n', { mode: 0o600 });
  // The key for host fixes (update, chown); host-fix-setup prints the steps
  // to allow it on the Unraid host. Only root (this process) can read it.
  const hostFixKey = join(stateDir, 'host-fix-key');
  if (!(await exists(hostFixKey))) {
    const k = await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'claude-unraid-manager-host-fix', '-f', hostFixKey]);
    if (k.code !== 0) console.error(`unraid-watch: could not create the host-fix key: ${(k.stderr || k.stdout).trim().slice(0, 200)}`);
  }
  const statePath = join(stateDir, 'state.json');
  const prefsPath = join(stateDir, 'prefs.json');
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
    auditPath: join(stateDir, 'audit.jsonl'),
    local: {
      ...Object.fromEntries(
        ['watch.mute', 'watch.alert', 'watch.note', 'watch.remove', 'watch.undo'].map((a) => [a, async (o) => (await applyRule(o)).message]),
      ),
      'watch.fix': async (o) => {
        const busy = activeMode !== null;
        startFix(o.spec.problems);
        return busy
          ? '🛠️ Queued: Claude starts on it as soon as the current task is done, and asks you before every change.'
          : '🛠️ On it. Claude looks into it now and asks you before every change.';
      },
    },
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
  async function respond(text, suggestions, { apply = false, fixFor = [] } = {}) {
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
    if (fixFor.length) {
      const f = { action: 'watch.fix', target: 'fix', spec: { problems: fixFor.map((i) => ({ id: i.key, problem: i.title, detail: i.detail })) } };
      offers.push({ ...f, id: book.offer(f) });
    }
    const exact = offers.map(describeOffer).filter(Boolean).map((d) => `Tap to: ${d}`);
    const tail = [...done, ...exact];
    await say(tail.length ? `${text}\n\n${tail.join('\n')}` : text, offers);
  }

  // Which kind of Claude run is going on: fix requests during a report or an
  // alert are refused, and the owner sees where a request comes from.
  let activeMode = null;
  async function ask(prompt, mode = 'report') {
    const stop = setInterval(() => bot.typing(), 8000);
    bot.typing();
    activeMode = mode;
    try {
      return await askClaude(cfg, prompt, { asClaude, mode });
    } finally {
      activeMode = null;
      clearInterval(stop);
    }
  }

  function startFix(problems) {
    withClaude(async () => {
      const r = await ask(fixPrompt(problems, ctx()), 'fix');
      await say(r.ok ? `🛠️ **Fix report**\n${r.text}` : `🛠️ Claude could not finish: ${r.error}`);
    }).catch((err) => console.error(`unraid-watch: fix run failed: ${err.stack ?? err}`));
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
              await respond(`${head}\n${r.text}`, r.actions, { fixFor: raised });
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
      const r = await ask(chatPrompt(text, shownIncidents(), ctx()), 'chat');
      if (r.ok) await respond(r.text, r.actions, { apply: true });
      else await say(`Claude could not answer: ${r.error}`);
    });
  }

  // One Allow/Deny question per change Claude asks for (fix.mjs).
  const approvals = new Map();
  async function askOwner({ what, reason, source }) {
    const id = randomBytes(9).toString('base64url');
    const from = source ? ` (${source})` : '';
    const text = `🛠️ **Claude wants to ${what}**${from}${reason ? `\nWhy: ${reason}` : ''}\n_Nothing happens unless you tap Allow (within 15 minutes)._`;
    remember('bot', text);
    const msg = await bot.send(text, [], { rows: [approvalRow(id)] });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        approvals.delete(id);
        msg?.edit({ components: [] }).catch(() => {});
        say('⌛ No answer in 15 minutes, so that change was not made.').catch(() => {});
        resolve('timeout');
      }, APPROVAL_MS);
      approvals.set(id, { resolve, timer });
    });
  }
  function onApproval(id, allow) {
    const a = approvals.get(id);
    if (!a) return 'That request is no longer waiting. Nothing was changed.';
    approvals.delete(id);
    clearTimeout(a.timer);
    a.resolve(allow ? 'allow' : 'deny');
    remember('owner', allow ? '(tapped Allow)' : '(tapped Deny)');
    return allow ? '👍 Allowed. Working on it…' : '👎 Denied. Nothing was changed.';
  }

  // host-fix on the Unraid host, with the watcher's own key (made above).
  const hostFixReady = Boolean(cfg.sshHost) && (await exists(hostFixKey));
  const hostFix = hostFixReady
    ? (args, timeoutMs) => run('ssh', [
      '-T', '-i', hostFixKey, '-p', String(cfg.sshPort),
      '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=5', '-o', 'LogLevel=ERROR',
      '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${join(stateDir, 'known_hosts')}`,
      `root@${cfg.sshHost}`, '--', args.join(' '),
    ], { timeoutMs })
    : null;
  if (hostFix) {
    const v = await hostFix(['version'], 15_000);
    if (v.code === 0) console.log(`unraid-watch: host fixes over SSH to ${cfg.sshHost} (host-fix ${v.stdout.trim()})`);
    else console.log(`unraid-watch: host fixes not working yet (${(v.stderr || v.stdout).trim().slice(0, 200) || `exit ${v.code}`}); updates and permission fixes need host-fix-setup`);
  }

  const broker = new FixBroker({
    askOwner,
    run,
    hostFix,
    audit: (e) => book.audit(e),
    containers: () => containers,
    notify: (text) => say(text),
    policy: () => {
      if (activeMode === 'report') return { refuse: 'Fix tools are not used during reports and alerts. Say what you would change; the owner can tap Fix it.' };
      return { source: activeMode === 'chat' ? 'you asked in this chat' : activeMode === 'fix' ? 'Fix it' : 'from your Claude app session' };
    },
  });

  bot = await startDiscord(cfg, {
    onText,
    onApproval,
    onFix: async (id, who) => {
      const r = await book.approve(id, who);
      remember('bot', r.message);
      return r;
    },
    onSkip: (ids) => book.withdraw(ids),
  });

  try {
    await mkdir(dirname(cfg.fixSocket), { recursive: true, mode: 0o750 });
    await serveFixSocket(cfg.fixSocket, broker, { gid: cfg.claudeGid });
    console.log(`unraid-watch: fix requests on ${cfg.fixSocket}`);
  } catch (err) {
    console.error(`unraid-watch: cannot listen for fix requests on ${cfg.fixSocket}: ${err.message}; Claude cannot change anything`);
  }

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
