import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askClaude, chatPrompt, fixPrompt, incidentPrompt, morningPrompt, parseReply } from '../src/claude.mjs';
import { loadConfig } from '../src/config.mjs';
import { approvalRow, buttonRows, remainingRows } from '../src/discord.mjs';
import { chunk, msUntil } from '../src/schedule.mjs';

const OWNER = '184695080709324800';

test('config: required values, defaults, validation', () => {
  assert.throws(() => loadConfig({}), /DISCORD_BOT_TOKEN/);
  assert.throws(() => loadConfig({ DISCORD_BOT_TOKEN: 't', DISCORD_USER_ID: 'me' }), /numeric Discord user ID/);
  const c = loadConfig({ DISCORD_BOT_TOKEN: ' t ', DISCORD_USER_ID: OWNER, WATCH_IGNORE: 'a, b,,' });
  assert.equal(c.token, 't');
  assert.equal(c.reportTime, '08:00');
  assert.equal(c.intervalMinutes, 15);
  assert.equal(c.diskWarnPercent, 90);
  assert.deepEqual(c.ignore, ['a', 'b']);
  assert.equal(c.hostChecks, false);
  assert.equal(c.stateDir, '/workspace/.unraid-watch');
  assert.equal(c.fixTimeoutMs, 2_700_000);
  assert.equal(c.fixSocket, '/run/unraid-watch/fix.sock');
  assert.equal(c.sshPort, 22);
  assert.equal(loadConfig({ DISCORD_BOT_TOKEN: 't', DISCORD_USER_ID: OWNER, REPORT_TIME: 'OFF' }).reportTime, 'off');
  assert.throws(() => loadConfig({ DISCORD_BOT_TOKEN: 't', DISCORD_USER_ID: OWNER, REPORT_TIME: '8am' }), /HH:MM/);
  assert.throws(() => loadConfig({ DISCORD_BOT_TOKEN: 't', DISCORD_USER_ID: OWNER, CHECK_INTERVAL: '1' }), /5 to 240/);
});

test('schedule: next occurrence today or tomorrow', () => {
  const now = new Date(2026, 10, 22, 7, 30, 0);
  assert.equal(msUntil('08:00', now), 30 * 60_000);
  assert.equal(msUntil('07:30', now), 24 * 3_600_000);
  assert.equal(msUntil('06:00', now), 22.5 * 3_600_000);
});

test('chunk: splits long text under the Discord limit, on paragraph breaks', () => {
  const para = 'x'.repeat(1000);
  const parts = chunk(`${para}\n\n${para}\n\n${para}`);
  assert.equal(parts.length, 3);
  assert.ok(parts.every((p) => p.length <= 1900));
  assert.deepEqual(chunk('short'), ['short']);
  assert.ok(chunk('y'.repeat(5000)).every((p) => p.length <= 1900));
});

test('parseReply: text without the actions block, actions as data', () => {
  const r = parseReply('Plex is stuck.\n\n```actions\n[{"action":"container.restart","target":"plex","reason":"stuck"}]\n```\n');
  assert.equal(r.text, 'Plex is stuck.');
  assert.deepEqual(r.actions, [{ action: 'container.restart', target: 'plex', reason: 'stuck' }]);
  const bad = parseReply('Hi\n```actions\nnot json\n```');
  assert.equal(bad.text, 'Hi');
  assert.deepEqual(bad.actions, []);
  assert.deepEqual(parseReply('No block').actions, []);
});

test('prompts carry the rules and the data', () => {
  const inc = [{ key: 'k', title: 'plex crashed', severity: 'warning', detail: 'Exited (1)', firstSeen: 0 }];
  for (const p of [morningPrompt(inc), incidentPrompt(inc, inc), chatPrompt('why?', inc)]) {
    assert.match(p, /untrusted data/);
    assert.match(p, /Never\s+suggest them for claude-unraid-manager/);
    assert.match(p, /plex crashed/);
    assert.match(p, /watch\.mute/);
    assert.match(p, /"type": "notification"/);
    assert.match(p, /Now: .*UTC[+-]\d\d:\d\d/);
    assert.doesNotMatch(p, /standing notes/);
  }
  const ctx = {
    prefs: {
      mutes: [{ id: 'm1', match: 'disk:*:full', until: null, untilWhen: { type: 'disk', disk: '*', op: '>=', percent: 99 } }],
      alerts: [{ id: 'a2', when: { type: 'container', name: 'plex', state: 'running' }, say: 'plex is back', repeat: false }],
      notes: [{ id: 'n3', text: "Don't mention parity" }],
    },
    history: [{ who: 'bot', text: 'disk1 is 98% full' }, { who: 'owner', text: 'snooze that' }],
  };
  for (const p of [morningPrompt(inc, ctx), incidentPrompt(inc, inc, ctx), chatPrompt('snooze that', inc, ctx)]) {
    assert.match(p, /standing notes[^]*- Don't mention parity/);
    assert.match(p, /Current rules[^]*`m1` 🔕 Not telling you about `disk:\*:full` until any disk or pool is 99% full or more/);
    assert.match(p, /`a2` 🔔 Telling you once when `plex` is running: "plex is back"/);
    assert.match(p, /\[bot\] disk1 is 98% full\n\[owner\] snooze that/);
  }
  assert.match(chatPrompt('x', inc), /"id":"k"/);
});

test('reports may not fix; chat and Fix it get the fix rules', () => {
  const inc = [{ key: 'container:sonarr:exited', title: 'sonarr crashed', severity: 'warning', detail: '', firstSeen: 0 }];
  for (const p of [morningPrompt(inc), incidentPrompt(inc, inc)]) {
    assert.match(p, /do not call the fix tools/);
    assert.doesNotMatch(p, /Least invasive first/);
  }
  const chat = chatPrompt('sonarr says permission denied, fix it', inc);
  assert.match(chat, /Least invasive first/);
  assert.match(chat, /only when the owner asks you to fix/);
  const fix = fixPrompt([{ id: 'container:sonarr:exited', problem: 'sonarr crashed' }]);
  assert.match(fix, /tapped "Fix it"/);
  assert.match(fix, /sonarr crashed/);
  assert.match(fix, /appdata_chown/);
  assert.doesNotMatch(fix, /do not call the fix tools/);
});

test('askClaude: chat and fix runs get the long timeout and more turns', async () => {
  let seen;
  const asClaude = async (_cfg, args, opts) => {
    seen = { args, opts };
    return { code: 0, stdout: JSON.stringify({ result: 'Fixed.', is_error: false }), stderr: '' };
  };
  const cfg = { claudeCwd: `${process.cwd()}/.tmp-watch-cwd`, claudeTimeoutMs: 1000, fixTimeoutMs: 9000 };
  await askClaude(cfg, 'P', { asClaude, mode: 'fix' });
  assert.equal(seen.opts.timeoutMs, 9000);
  assert.equal(seen.args[seen.args.indexOf('--max-turns') + 1], '60');
  await askClaude(cfg, 'P', { asClaude });
  assert.equal(seen.opts.timeoutMs, 1000);
  assert.equal(seen.args[seen.args.indexOf('--max-turns') + 1], '30');
});

test('approval buttons: Allow and Deny for one request; a click clears both', () => {
  const row = approvalRow('abc').toJSON();
  assert.deepEqual(row.components.map((c) => [c.custom_id, c.label]), [['ok:abc', 'Allow'], ['no:abc', 'Deny']]);
  const asReceived = [{ components: row.components.map((c) => ({ ...c, customId: c.custom_id, toJSON: () => c })) }];
  assert.deepEqual(remainingRows(asReceived, 'ok:abc'), []);
});

test('askClaude: runs claude -p as Claude user with the prompt on stdin', async () => {
  let seen;
  const asClaude = async (_cfg, args, opts) => {
    seen = { args, opts };
    return { code: 0, stdout: JSON.stringify({ result: 'All good.\n```actions\n[]\n```', is_error: false }), stderr: '' };
  };
  const cfg = { claudeCwd: `${process.cwd()}/.tmp-watch-cwd`, claudeTimeoutMs: 1000 };
  const r = await askClaude(cfg, 'PROMPT', { asClaude });
  assert.deepEqual(r, { ok: true, text: 'All good.', actions: [] });
  assert.deepEqual(seen.args.slice(0, 4), ['claude', '-p', '--output-format', 'json']);
  assert.equal(seen.opts.input, 'PROMPT');

  const err = await askClaude(cfg, 'P', { asClaude: async () => ({ code: 1, stdout: JSON.stringify({ is_error: true, result: 'Usage limit reached' }), stderr: '' }) });
  assert.deepEqual(err, { ok: false, error: 'Usage limit reached' });
  const junk = await askClaude(cfg, 'P', { asClaude: async () => ({ code: 1, stdout: '', stderr: 'Not logged in' }) });
  assert.deepEqual(junk, { ok: false, error: 'Not logged in' });
  const slow = await askClaude(cfg, 'P', { asClaude: async () => ({ code: 137, stdout: '', stderr: '', timedOut: true }) });
  assert.equal(slow.ok, false);
});

test('buttons: one per offer plus "Not now"; a click removes only its button', () => {
  const rows = buttonRows([
    { id: 'aaa', action: 'container.restart', target: 'plex' },
    { id: 'bbb', action: 'container.stop', target: 'sonarr' },
  ]);
  const json = rows[0].toJSON();
  assert.deepEqual(json.components.map((c) => [c.custom_id, c.label]), [
    ['fix:aaa', 'Restart plex'], ['fix:bbb', 'Stop sonarr'], ['skip:aaa.bbb', 'Not now'],
  ]);
  assert.deepEqual(buttonRows([]), []);

  // What discord.js hands back on a click: rows of components with customId.
  const asReceived = [{ components: json.components.map((c) => ({ ...c, customId: c.custom_id, toJSON: () => c })) }];
  const after = remainingRows(asReceived, 'fix:aaa').map((r) => r.toJSON().components.map((c) => c.custom_id));
  assert.deepEqual(after, [['fix:bbb', 'skip:aaa.bbb']]);
  assert.deepEqual(remainingRows(asReceived, 'skip:aaa.bbb'), []);
  const lastOne = [{ components: [asReceived[0].components[1], asReceived[0].components[2]] }];
  assert.deepEqual(remainingRows(lastOne, 'fix:bbb'), []);
});
