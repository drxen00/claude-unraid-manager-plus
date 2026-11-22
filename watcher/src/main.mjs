// unraid-watch: checks the server every few minutes without AI, asks Claude
// (read-only) to explain new problems and to write a morning report, and
// sends both to the owner's Discord DM, with buttons for the few fixes it is
// allowed to make. Started by the container's entrypoint as root, so Claude's
// user cannot read its Discord token; Claude itself runs as that user.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ActionBook, validateSuggestions } from './actions.mjs';
import { askClaude, chatPrompt, incidentPrompt, morningPrompt } from './claude.mjs';
import { collect } from './checks.mjs';
import { loadConfig } from './config.mjs';
import { startDiscord } from './discord.mjs';
import { diff, emptyState, failureFindings, openIncidents } from './incidents.mjs';
import { asClaude, run } from './run.mjs';
import { msUntil } from './schedule.mjs';

const HELP = [
  '**Commands** (just type them here):',
  '• `report`: the full server report now',
  '• `status`: problems I currently know about',
  '• `check`: run the checks now',
  '• `help`: this list',
  'Anything else is a question for Claude, e.g. "why is plex slow?". Claude can only look, not change things; fixes come as buttons you tap.',
].join('\n');

const ICON = { critical: '🔴', warning: '⚠️' };

async function main() {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    console.error(`unraid-watch: not started: ${err.message}`);
    process.exit(2);
  }

  const statePath = join(cfg.stateDir, 'state.json');
  await mkdir(cfg.stateDir, { recursive: true, mode: 0o700 });
  let state = emptyState();
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    // First start or unreadable: start clean (open problems are re-reported).
  }
  async function saveState() {
    await writeFile(`${statePath}.tmp`, JSON.stringify(state), { mode: 0o600 });
    await rename(`${statePath}.tmp`, statePath);
  }

  const book = new ActionBook({ run, auditPath: join(cfg.stateDir, 'audit.jsonl') });
  let containers = [];

  // One Claude run at a time; later requests wait their turn.
  let queue = Promise.resolve();
  function withClaude(fn) {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  }

  let bot;

  async function sendWithOffers(text, suggestions) {
    const valid = validateSuggestions(suggestions, containers);
    const offers = valid.map((s) => ({ ...s, id: book.offer(s) }));
    await bot.send(text, offers);
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

  function plainList(incidents) {
    if (!incidents.length) return '✅ No open problems.';
    return incidents.map((i) => `${ICON[i.severity] ?? '•'} **${i.title}**${i.detail ? `\n   ${i.detail}` : ''}`).join('\n');
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
      if (!quiet) {
        if (d.resolved.length) {
          await bot.send(`✅ **Cleared:**\n${d.resolved.map((i) => `• ${i.title}`).join('\n')}`);
        }
        if (d.raised.length) {
          withClaude(async () => {
            const r = await ask(incidentPrompt(d.raised, openIncidents(state)));
            if (r.ok) {
              const head = d.raised.some((i) => i.severity === 'critical') ? '🔴 **New problem**' : '⚠️ **New problem**';
              await sendWithOffers(`${head}\n${r.text}`, r.actions);
            } else {
              await bot.send(`${plainList(d.raised)}\n\n_(Claude could not look into this: ${r.error})_`);
            }
          }).catch((err) => console.error(`unraid-watch: incident report failed: ${err.stack ?? err}`));
        }
      }
      return d;
    } finally {
      checking = false;
    }
  }

  async function report() {
    await check({ quiet: true });
    await withClaude(async () => {
      const r = await ask(morningPrompt(openIncidents(state)));
      if (r.ok) await sendWithOffers(`☀️ **Server report**\n${r.text}`, r.actions);
      else await bot.send(`☀️ **Server report** (without Claude: ${r.error})\n${plainList(openIncidents(state))}`);
    });
  }

  async function onText(raw) {
    const text = raw.trim();
    const word = text.toLowerCase();
    if (!text) return;
    if (word === 'help' || word === '?') return bot.send(HELP);
    if (word === 'status') return bot.send(plainList(openIncidents(state)));
    if (word === 'check') {
      const d = await check();
      if (!d.raised.length && !d.resolved.length) await bot.send(`Checked. Nothing new.\n${plainList(openIncidents(state))}`);
      return;
    }
    if (word === 'report') return report();
    return withClaude(async () => {
      const r = await ask(chatPrompt(text, openIncidents(state)));
      if (r.ok) await sendWithOffers(r.text, r.actions);
      else await bot.send(`Claude could not answer: ${r.error}`);
    });
  }

  bot = await startDiscord(cfg, {
    onText,
    onFix: (id, who) => book.approve(id, who),
    onSkip: (ids) => book.withdraw(ids),
  });

  const when = cfg.reportTime === 'off' ? 'no morning report' : `the morning report at ${cfg.reportTime}`;
  await bot.send(`👋 Unraid watcher started. I check the server every ${cfg.intervalMinutes} minutes and send ${when}. Type \`help\` for commands.`);

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
