import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diff, emptyState, failureFindings, openIncidents, RESOLVE_AFTER } from '../src/incidents.mjs';

const f = (key, severity = 'warning', source = 'containers') => ({ key, severity, source, title: key, detail: '' });

test('a new problem is raised once, not on every run', () => {
  let d = diff(emptyState(), [f('a')], new Map(), 1);
  assert.deepEqual(d.raised.map((i) => i.key), ['a']);
  d = diff(d.state, [f('a')], new Map(), 2);
  assert.deepEqual(d.raised, []);
  assert.equal(d.state.open.a.firstSeen, 1);
  assert.equal(d.state.open.a.lastSeen, 2);
});

test('a problem that gets worse is raised again; one that improves is not', () => {
  let d = diff(emptyState(), [f('a', 'warning')]);
  d = diff(d.state, [f('a', 'critical')]);
  assert.deepEqual(d.raised.map((i) => i.severity), ['critical']);
  d = diff(d.state, [f('a', 'warning')]);
  assert.deepEqual(d.raised, []);
  d = diff(d.state, [f('a', 'critical')]);
  assert.deepEqual(d.raised, [], 'already reported as critical');
});

test(`resolved only after ${RESOLVE_AFTER} runs without it; a return resets the count`, () => {
  let d = diff(emptyState(), [f('a')]);
  d = diff(d.state, []);
  assert.deepEqual(d.resolved, []);
  d = diff(d.state, [f('a')]);
  assert.deepEqual(d.raised, []);
  d = diff(d.state, []);
  assert.deepEqual(d.resolved, []);
  d = diff(d.state, []);
  assert.deepEqual(d.resolved.map((i) => i.key), ['a']);
  assert.deepEqual(d.state.open, {});
});

test('a failed collector neither resolves nor counts its incidents', () => {
  let d = diff(emptyState(), [f('disk1', 'warning', 'disks')]);
  const failed = new Map([['disks', 'ssh down']]);
  for (let i = 0; i < 5; i++) d = diff(d.state, failureFindings(failed), failed);
  assert.ok(d.state.open.disk1);
  assert.equal(d.state.open.disk1.missing, 0);
  assert.ok(d.state.open['watch:disks:failed']);
});

test('collector failures become one incident each, resolved when it works again', () => {
  const failed = new Map([['array', 'timeout']]);
  let d = diff(emptyState(), failureFindings(failed), failed);
  assert.deepEqual(d.raised.map((i) => i.title), ["The watcher can't check array"]);
  d = diff(d.state, [], new Map());
  d = diff(d.state, [], new Map());
  assert.deepEqual(d.resolved.map((i) => i.key), ['watch:array:failed']);
});

test('open incidents are listed critical first', () => {
  let d = diff(emptyState(), [f('w', 'warning')], new Map(), 1);
  d = diff(d.state, [f('w', 'warning'), f('c', 'critical')], new Map(), 2);
  assert.deepEqual(openIncidents(d.state).map((i) => i.key), ['c', 'w']);
});
