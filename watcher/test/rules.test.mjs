import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addAlert, addMute, addNote, emptyPrefs, evaluate, listRules, mutedBy, normalizePrefs,
  parseMuteArgs, partition, removeRules, restoreRules, step, validCondition, validMatch, validTime,
} from '../src/rules.mjs';

const DAY = 86_400_000;
const T0 = Date.parse('2026-11-22T12:00:00Z');
const disk1 = { key: 'disk:disk1:full', title: 'disk1 is 98% full' };
const disk2 = { key: 'disk:disk2:full', title: 'disk2 is 91% full' };
const img = { key: 'notify:abc123', title: 'Unraid: docker.img is 73% full' };
const plex = { key: 'container:plex:exited', title: 'plex crashed (exit code 1)' };
const arr = { key: 'array:state:STOPPED', title: 'Array is STOPPED' };

function facts(over = {}) {
  return {
    containers: [{ name: 'plex', state: 'exited', status: 'Exited (1) 5 minutes ago' }, { name: 'sonarr', state: 'running', status: 'Up 1 hour (unhealthy)' }],
    disks: [{ name: 'disk1', pct: 98 }, { name: 'disk2', pct: 91 }, { name: 'cache', pct: 11 }],
    md: { mdState: 'STARTED', mdResyncPos: '0' },
    notifications: [{ id: 'n1', subject: 'docker.img 73% full', text: 'Warning docker.img 73% full' }],
    open: [disk1, plex],
    ...over,
  };
}

test('mutes match ids and titles with *, case-insensitively; array problems always show', () => {
  let p = addMute(emptyPrefs(), { match: 'disk:*:full' }, T0).prefs;
  p = addMute(p, { match: '*DOCKER.IMG*' }, T0).prefs;
  p = { ...p, mutes: [...p.mutes, { id: 'm99', match: 'array:*' }] }; // even if one sneaks in
  const { shown, muted } = partition(p, [disk1, disk2, img, plex, arr]);
  assert.deepEqual(shown, [plex, arr]);
  assert.deepEqual(muted, [disk1, disk2, img]);
  assert.throws(() => addMute(emptyPrefs(), { match: 'array:state:STOPPED' }), /cannot be muted/);
  assert.equal(mutedBy(p, arr), undefined);
});

test('validation refuses what the watcher cannot check or should not do', () => {
  for (const bad of ['*', ' ** ', '', 'a'.repeat(121), 'x$(rm)', 'a\nb']) assert.equal(validMatch(bad), null, bad);
  assert.equal(validMatch('*', { allowAll: true }), '*');
  assert.equal(validTime('2026-11-21T00:00:00Z', T0), null, 'past');
  assert.equal(validTime('2028-01-01T00:00:00Z', T0), null, 'over a year');
  assert.equal(validTime('Friday', T0), null);
  assert.equal(validTime('2026-11-27T09:00:00-06:00', T0), Date.parse('2026-11-27T15:00:00Z'));
  assert.equal(validCondition({ type: 'disk', percent: 0 }), null);
  assert.deepEqual(validCondition({ type: 'disk', percent: 99 }), { type: 'disk', disk: '*', op: '>=', percent: 99 });
  assert.equal(validCondition({ type: 'container', name: '*', state: 'running' }), null);
  assert.equal(validCondition({ type: 'shell', cmd: 'ls' }), null);
  assert.equal(validCondition('disk'), null);
});

test('conditions evaluate against facts; unknown sources are null, not false', () => {
  const f = facts();
  assert.equal(evaluate({ type: 'disk', disk: '*', op: '>=', percent: 98 }, f).value, true);
  assert.equal(evaluate({ type: 'disk', disk: '*', op: '>=', percent: 98 }, f).detail, 'disk1 is 98% full');
  assert.equal(evaluate({ type: 'disk', disk: 'disk2', op: '<=', percent: 80 }, f).value, false);
  assert.equal(evaluate({ type: 'container', name: 'plex', state: 'running' }, f).value, false);
  assert.equal(evaluate({ type: 'container', name: 'plex', state: 'stopped' }, f).value, true);
  assert.equal(evaluate({ type: 'container', name: 'sonarr', state: 'healthy' }, f).value, false);
  assert.equal(evaluate({ type: 'container', name: 'ghost', state: 'gone' }, f).value, true);
  assert.equal(evaluate({ type: 'problem', match: 'container:plex:*', is: 'open' }, f).value, true);
  assert.equal(evaluate({ type: 'problem', match: 'container:plex:*', is: 'cleared' }, f).value, false);
  assert.equal(evaluate({ type: 'array', is: 'not syncing' }, f).value, true);
  assert.equal(evaluate({ type: 'array', is: 'syncing' }, facts({ md: { mdState: 'STARTED', mdResyncPos: '12345' } })).value, true);
  assert.deepEqual(evaluate({ type: 'notification', match: '*docker.img*' }, f).ids, ['n1']);
  assert.equal(evaluate({ type: 'time', at: T0 + 1 }, f, T0).value, false);
  assert.equal(evaluate({ type: 'time', at: T0 }, f, T0).value, true);
  const blind = facts({ disks: null, containers: null, md: null, notifications: null });
  for (const c of [{ type: 'disk', disk: '*', op: '>=', percent: 1 }, { type: 'container', name: 'plex', state: 'gone' }, { type: 'array', is: 'started' }, { type: 'notification', match: '*x*' }]) {
    assert.equal(evaluate(c, blind).value, null, c.type);
  }
});

test('"don\'t tell me about disk space until a disk hits 99%, or Friday": lifted by whichever comes first', () => {
  const friday = Date.parse('2026-11-27T15:00:00Z');
  let p = addMute(emptyPrefs(), { match: 'disk:*:full', until: friday, untilWhen: { type: 'disk', disk: '*', op: '>=', percent: 99 } }, T0).prefs;
  let s = step(p, facts(), T0 + DAY);
  assert.deepEqual(s.lifted, []);
  assert.equal(s.prefs.mutes.length, 1);
  s = step(s.prefs, facts({ disks: [{ name: 'disk1', pct: 99 }] }), T0 + 2 * DAY);
  assert.deepEqual(s.lifted.map((l) => [l.rule.match, l.detail]), [['disk:*:full', 'disk1 is 99% full']]);
  assert.deepEqual(s.prefs.mutes, []);

  p = addMute(emptyPrefs(), { match: 'disk:*:full', until: friday }, T0).prefs;
  s = step(p, facts({ disks: null }), friday);
  assert.equal(s.lifted[0].detail, 'its time ran out');
});

test('"let me know when plex is back": fires once on the change, not while already true', () => {
  let p = addAlert(emptyPrefs(), { when: { type: 'container', name: 'plex', state: 'running' }, say: 'plex is back up' }, facts(), T0).prefs;
  let s = step(p, facts(), T0 + 1);
  assert.deepEqual(s.fired, []);
  s = step(s.prefs, facts({ containers: null }), T0 + 2);
  assert.deepEqual(s.fired, [], 'unknown keeps waiting');
  const up = facts({ containers: [{ name: 'plex', state: 'running', status: 'Up 1 minute' }] });
  s = step(s.prefs, up, T0 + 3);
  assert.deepEqual(s.fired.map((f) => [f.rule.say, f.detail]), [['plex is back up', 'plex: Up 1 minute']]);
  assert.deepEqual(s.prefs.alerts, [], 'once');

  // Already running when set: waits for stop and start again.
  p = addAlert(emptyPrefs(), { when: { type: 'container', name: 'plex', state: 'running' } }, up, T0).prefs;
  assert.equal(p.alerts[0].last, true);
  assert.deepEqual(step(p, up, T0 + 1).fired, []);
});

test('repeat alerts keep firing on every new change; expired alerts are dropped', () => {
  let p = addAlert(emptyPrefs(), { when: { type: 'problem', match: 'container:plex:*' }, say: 'plex crashed again', repeat: true, expires: T0 + 7 * DAY }, facts({ open: [] }), T0).prefs;
  let s = step(p, facts(), T0 + 1);
  assert.equal(s.fired.length, 1);
  s = step(s.prefs, facts(), T0 + 2);
  assert.equal(s.fired.length, 0, 'still the same crash');
  s = step(s.prefs, facts({ open: [] }), T0 + 3);
  s = step(s.prefs, facts(), T0 + 4);
  assert.equal(s.fired.length, 1, 'crashed again');
  s = step(s.prefs, facts(), T0 + 7 * DAY);
  assert.deepEqual(s.expired.map((r) => r.say), ['plex crashed again']);
  assert.deepEqual(s.prefs.alerts, []);
});

test('notification alerts fire on new matching notifications only, info included', () => {
  let p = addAlert(emptyPrefs(), { when: { type: 'notification', match: '*parity*' }, say: 'Parity check finished' }, facts(), T0).prefs;
  let s = step(p, facts(), T0 + 1);
  assert.deepEqual(s.fired, []);
  const n = facts({ notifications: [...facts().notifications, { id: 'n2', subject: 'Parity check finished (0 errors)', text: 'Notice Parity check finished (0 errors)' }] });
  s = step(s.prefs, n, T0 + 2);
  assert.deepEqual(s.fired.map((f) => f.detail), ['Parity check finished (0 errors)']);
});

test('reminders: a time alert fires when the time comes', () => {
  const p = addAlert(emptyPrefs(), { when: { type: 'time', at: T0 + DAY }, say: 'Check the backup' }, facts(), T0).prefs;
  assert.deepEqual(step(p, facts(), T0 + 1).fired, []);
  assert.equal(step(p, facts(), T0 + DAY).fired[0].rule.say, 'Check the backup');
});

test('ids, listing, removing and undo', () => {
  let p = addMute(emptyPrefs(), { match: 'disk:*:full' }, T0).prefs;
  p = addAlert(p, { when: { type: 'container', name: 'plex', state: 'running' }, say: 'plex up' }, facts(), T0).prefs;
  p = addNote(p, "  Don't mention   parity ", T0).prefs;
  p = addNote(p, "don't mention parity", T0).prefs;
  assert.deepEqual([...p.mutes, ...p.alerts, ...p.notes].map((r) => r.id), ['m1', 'a2', 'n3']);
  const list = listRules(p);
  assert.match(list, /`m1` 🔕[^]*`a2` 🔔[^]*`n3` 📝 Note for every report: "Don't mention parity"/);
  const r = removeRules(p, ['a2', 'n3']);
  assert.deepEqual(r.removed.map((x) => x.id), ['a2', 'n3']);
  assert.throws(() => removeRules(r.prefs, ['a2']), /No rule/);
  const back = restoreRules(r.prefs, r.removed);
  assert.deepEqual([...back.mutes, ...back.alerts, ...back.notes].map((x) => x.id), ['m1', 'a2', 'n3']);
  assert.deepEqual(removeRules(p, ['all']).prefs.mutes, []);
  assert.throws(() => addNote(p, 'x'.repeat(301)), /1 to 300/);
});

test('typed mute arguments', () => {
  assert.deepEqual(parseMuteArgs('docker.img', null, T0), { match: '*docker.img*', until: null });
  assert.deepEqual(parseMuteArgs('docker.img for 3 days', null, T0), { match: '*docker.img*', until: T0 + 3 * DAY });
  assert.deepEqual(parseMuteArgs('disk:*:full 12h', 7, T0), { match: 'disk:*:full', until: T0 + 12 * 3_600_000 });
  assert.deepEqual(parseMuteArgs('plex forever', 7, T0), { match: '*plex*', until: null });
  assert.deepEqual(parseMuteArgs('disk full', 7, T0), { match: '*disk full*', until: T0 + 7 * DAY });
});

test('broken or old prefs files load safely and get ids', () => {
  assert.deepEqual(normalizePrefs(null), emptyPrefs());
  const p = normalizePrefs({ mutes: [null, { match: 1 }, { match: 'a' }], notes: 'x', alerts: [{ when: 'x' }] });
  assert.deepEqual(p.mutes.map((m) => [m.id, m.match]), [['m1', 'a']]);
  assert.deepEqual(p.alerts, []);
  assert.equal(p.next, 2);
});
