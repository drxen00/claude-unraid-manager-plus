import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addMute, addNote, describeMute, emptyPrefs, expireMutes, mutedBy, normalizePrefs,
  parseMuteArgs, partition, removeEntry, validMatch,
} from '../src/prefs.mjs';

const DAY = 86_400_000;
const disk1 = { key: 'disk:disk1:full', title: 'disk1 is 98% full' };
const disk2 = { key: 'disk:disk2:full', title: 'disk2 is 91% full' };
const img = { key: 'notify:abc123', title: 'Unraid: docker.img is 73% full' };
const plex = { key: 'container:plex:exited', title: 'plex stopped (exit code 1)' };

test('mute patterns match ids and titles, case-insensitively, with *', () => {
  let p = addMute(emptyPrefs(), { match: 'disk:*:full', days: null }, 0).prefs;
  p = addMute(p, { match: '*DOCKER.IMG*', days: null }, 0).prefs;
  const { shown, muted } = partition(p, [disk1, disk2, img, plex], 1);
  assert.deepEqual(shown, [plex]);
  assert.deepEqual(muted, [disk1, disk2, img]);
  assert.equal(mutedBy(p, plex, 1), undefined);
});

test('dangerous or odd patterns are refused', () => {
  for (const bad of ['*', ' ** ', '', 'a'.repeat(121), 'x$(rm)', 'a\nb']) assert.equal(validMatch(bad), null, bad);
  assert.equal(validMatch(' disk:disk1:full '), 'disk:disk1:full');
  assert.throws(() => addMute(emptyPrefs(), { match: '*' }), /not allowed/);
  assert.throws(() => addMute(emptyPrefs(), { match: 'x', days: 0 }), /1 to 365/);
  assert.throws(() => addMute(emptyPrefs(), { match: 'x', days: 1.5 }), /1 to 365/);
});

test('timed mutes expire and are returned once; re-muting replaces', () => {
  let p = addMute(emptyPrefs(), { match: 'disk:disk1:full', days: 7 }, 0).prefs;
  assert.ok(mutedBy(p, disk1, 6 * DAY));
  assert.equal(mutedBy(p, disk1, 7 * DAY), undefined);
  const e = expireMutes(p, 7 * DAY);
  assert.deepEqual(e.expired.map((m) => m.match), ['disk:disk1:full']);
  assert.deepEqual(e.prefs.mutes, []);
  assert.equal(expireMutes(e.prefs, 8 * DAY).expired.length, 0);

  p = addMute(p, { match: 'DISK:disk1:full', days: null }, DAY).prefs;
  assert.equal(p.mutes.length, 1);
  assert.equal(p.mutes[0].until, null);
  assert.match(describeMute(p.mutes[0]), /until you unmute/);
});

test('notes: trimmed, de-duplicated, bounded; entries removable by number or all', () => {
  let p = addNote(emptyPrefs(), "  Don't mention   parity ").prefs;
  p = addNote(p, "don't mention parity").prefs;
  assert.deepEqual(p.notes.map((n) => n.text), ["Don't mention parity"]);
  assert.throws(() => addNote(p, 'x'.repeat(301)), /1 to 300/);
  p = addNote(p, 'Only warn about disks at 99%').prefs;
  const r = removeEntry(p, 'notes', '1');
  assert.deepEqual(r.prefs.notes.map((n) => n.text), ['Only warn about disks at 99%']);
  assert.throws(() => removeEntry(p, 'notes', '3'), /1 to 2/);
  assert.deepEqual(removeEntry(p, 'notes', 'ALL').prefs.notes, []);
});

test('typed mute arguments: duration at the end, plain words become *word*', () => {
  assert.deepEqual(parseMuteArgs('docker.img', null), { match: '*docker.img*', days: null });
  assert.deepEqual(parseMuteArgs('docker.img for 3 days', null), { match: '*docker.img*', days: 3 });
  assert.deepEqual(parseMuteArgs('disk:*:full 30d', 7), { match: 'disk:*:full', days: 30 });
  assert.deepEqual(parseMuteArgs('plex forever', 7), { match: '*plex*', days: null });
  assert.deepEqual(parseMuteArgs('disk full', 7), { match: '*disk full*', days: 7 });
});

test('broken prefs files load as empty', () => {
  assert.deepEqual(normalizePrefs(null), emptyPrefs());
  assert.deepEqual(normalizePrefs({ mutes: [null, { match: 1 }, { match: 'a' }], notes: 'x' }), { mutes: [{ match: 'a' }], notes: [] });
});
