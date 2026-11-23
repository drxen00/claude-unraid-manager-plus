import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ActionBook, buttonLabel, describeOffer, EXPIRY_MS, MAX_PER_HOUR, validateSuggestions } from '../src/actions.mjs';

const containers = [{ name: 'plex' }, { name: 'sonarr' }, { name: 'claude-docker-proxy' }, { name: 'claude-unraid-manager' }];

test('only catalog actions on existing, non-own containers survive', () => {
  const v = validateSuggestions([
    { action: 'container.restart', target: 'plex', reason: 'stuck' },
    { action: 'container.restart', target: 'plex', reason: 'duplicate' },
    { action: 'container.remove', target: 'sonarr' },
    { action: 'container.stop', target: 'claude-docker-proxy' },
    { action: 'container.restart', target: 'claude-unraid-manager' },
    { action: 'container.start', target: 'ghost' },
    { action: 'container.start', target: 'plex; rm -rf /' },
    { action: 'container.stop', target: 'sonarr', reason: 'x'.repeat(500) },
    null,
    'string',
  ], containers);
  assert.deepEqual(v.map((s) => `${s.action} ${s.target}`), ['container.restart plex', 'container.stop sonarr']);
  assert.equal(v[1].reason.length, 200);
  assert.deepEqual(validateSuggestions('not a list', containers), []);
});

test('rule suggestions are validated and described by the watcher', () => {
  const now = Date.parse('2026-11-22T12:00:00Z');
  const v = validateSuggestions([
    { action: 'watch.mute', match: 'disk:*:full', until_when: { type: 'disk', disk: '*', op: '>=', percent: 99 }, until: '2026-11-27T09:00:00-06:00' },
    { action: 'watch.alert', when: { type: 'notification', match: '*parity*' }, message: 'Parity check done' },
    { action: 'watch.note', text: "Don't mention parity." },
  ], containers, now);
  assert.deepEqual(v.map((s) => s.action), ['watch.mute', 'watch.alert', 'watch.note']);
  assert.deepEqual(v[0].spec.untilWhen, { type: 'disk', disk: '*', op: '>=', percent: 99 });
  assert.equal(v[0].spec.until, Date.parse('2026-11-27T15:00:00Z'));
  assert.equal(buttonLabel(v[0]), '🔕 Mute disk:*:full');
  assert.match(describeOffer(v[0]), /Not telling you about `disk:\*:full` until .*, or until any disk or pool is 99% full or more/);
  assert.match(describeOffer(v[1]), /once when Unraid sends a notification matching `\*parity\*`: "Parity check done"/);
  assert.match(describeOffer(v[2]), /"Don't mention parity\."/);
  assert.equal(describeOffer({ action: 'container.restart', target: 'plex' }), '');

  const bad = validateSuggestions([
    { action: 'watch.mute', match: '*' },
    { action: 'watch.mute', match: 'array:*' },
    { action: 'watch.mute', match: 'x', until: '2020-01-01T00:00:00Z' },
    { action: 'watch.mute', match: 'x', until_when: { type: 'weather', is: 'rain' } },
    { action: 'watch.alert', when: { type: 'disk', percent: 150 } },
    { action: 'watch.alert', when: { type: 'container', name: 'plex', state: 'happy' } },
    { action: 'watch.note', text: '' },
    { action: 'watch.remove', ids: ['m1; rm -rf /'] },
    { action: 'watch.undo', spec: { add: [{ id: 'm9', match: '*' }], remove: [] } },
    { action: 'watch.fix', spec: { problems: [] } },
  ], containers, now);
  assert.deepEqual(bad, []);
  const rm = validateSuggestions([{ action: 'watch.remove', ids: ['M1', 'a2'] }], containers, now);
  assert.deepEqual(rm[0].spec.ids, ['m1', 'a2']);
});

test('local actions run the watcher handler, not docker, and are audited', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'watch-'));
  const calls = [];
  const b = new ActionBook({
    run: async (...a) => { calls.push(a); return { code: 0, stdout: '', stderr: '' }; },
    auditPath: join(dir, 'audit.jsonl'),
    local: { 'watch.mute': async (o) => `muted ${o.target}`, 'watch.note': async () => { throw new Error('too many notes'); } },
  });
  const r = await b.approve(b.offer({ action: 'watch.mute', target: 'disk:*:full', spec: { match: 'disk:*:full' } }), 'o');
  assert.deepEqual(r, { ok: true, message: 'muted disk:*:full' });
  const n = await b.approve(b.offer({ action: 'watch.note', target: 'note', spec: { text: 't' } }), 'o');
  assert.equal(n.ok, false);
  assert.match(n.message, /too many notes/);
  assert.deepEqual(calls, []);
  const audit = (await readFile(join(dir, 'audit.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(audit.map((a) => a.result), ['ok', 'failed (too many notes)']);
});

test('at most three suggestions', () => {
  const many = ['plex', 'sonarr', 'a', 'b'].map((t) => ({ action: 'container.restart', target: t }));
  const v = validateSuggestions(many, [...containers, { name: 'a' }, { name: 'b' }]);
  assert.equal(v.length, 3);
});

async function book({ state = 'running', code = 0 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'watch-'));
  const calls = [];
  let now = 1_000_000;
  const run = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (args[0] === 'inspect') return state === null ? { code: 1, stdout: '', stderr: 'No such container' } : { code: 0, stdout: `${state}\n`, stderr: '' };
    return { code, stdout: 'plex\n', stderr: code ? 'boom' : '' };
  };
  const b = new ActionBook({ run, auditPath: join(dir, 'audit.jsonl'), now: () => now });
  return { b, calls, dir, tick: (ms) => { now += ms; } };
}

test('an approved offer runs the fixed docker command once and is audited', async () => {
  const { b, calls, dir } = await book();
  const id = b.offer({ action: 'container.restart', target: 'plex', reason: 'r' });
  const r = await b.approve(id, 'owner#1');
  assert.deepEqual(r, { ok: true, message: 'Done: restarted plex.' });
  assert.deepEqual(calls, ['docker inspect --format {{.State.Status}} plex', 'docker restart plex']);
  const again = await b.approve(id, 'owner#1');
  assert.equal(again.ok, false, 'one-time');
  assert.equal(calls.length, 2);
  const audit = (await readFile(join(dir, 'audit.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(audit[0].result, 'ok');
  assert.equal(audit[0].who, 'owner#1');
});

test('expired offers do nothing', async () => {
  const { b, calls, tick } = await book();
  const id = b.offer({ action: 'container.restart', target: 'plex' });
  tick(EXPIRY_MS + 1);
  const r = await b.approve(id, 'o');
  assert.equal(r.ok, false);
  assert.match(r.message, /expired/);
  assert.deepEqual(calls, []);
});

test('state is re-checked: start on a running container is skipped, a gone container too', async () => {
  let t = await book({ state: 'running' });
  let r = await t.b.approve(t.b.offer({ action: 'container.start', target: 'plex' }), 'o');
  assert.equal(r.ok, false);
  assert.match(r.message, /now running/);
  assert.deepEqual(t.calls, ['docker inspect --format {{.State.Status}} plex']);

  t = await book({ state: null });
  r = await t.b.approve(t.b.offer({ action: 'container.stop', target: 'plex' }), 'o');
  assert.match(r.message, /no longer exists/);
  assert.equal(t.calls.length, 1);
});

test(`rate limit: at most ${MAX_PER_HOUR} fixes an hour`, async () => {
  const { b, calls, tick } = await book();
  for (let i = 0; i < MAX_PER_HOUR; i++) {
    assert.equal((await b.approve(b.offer({ action: 'container.restart', target: 'plex' }), 'o')).ok, true);
  }
  const r = await b.approve(b.offer({ action: 'container.restart', target: 'plex' }), 'o');
  assert.match(r.message, /Limit reached/);
  tick(3_600_001);
  assert.equal((await b.approve(b.offer({ action: 'container.restart', target: 'plex' }), 'o')).ok, true);
  assert.equal(calls.filter((c) => c === 'docker restart plex').length, MAX_PER_HOUR + 1);
});

test('withdrawn offers cannot be approved; docker failures are reported', async () => {
  const { b } = await book({ code: 1 });
  const id = b.offer({ action: 'container.restart', target: 'plex' });
  b.withdraw([id]);
  assert.equal((await b.approve(id, 'o')).ok, false);
  const r = await b.approve(b.offer({ action: 'container.restart', target: 'plex' }), 'o');
  assert.equal(r.ok, false);
  assert.match(r.message, /boom/);
});
