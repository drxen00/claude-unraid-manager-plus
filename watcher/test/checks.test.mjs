import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  arrayFindings, collect, containerFindings, diskFindings, notificationFindings,
  parseDf, parseDockerPs, parseMdcmd,
} from '../src/checks.mjs';

const PS = [
  { Names: 'plex', State: 'running', Status: 'Up 3 hours', Image: 'plex' },
  { Names: 'sonarr', State: 'running', Status: 'Up 2 hours (unhealthy)', Image: 'sonarr' },
  { Names: 'radarr', State: 'restarting', Status: 'Restarting (1) 5 seconds ago', Image: 'radarr' },
  { Names: 'lidarr', State: 'exited', Status: 'Exited (0) 3 hours ago', Image: 'lidarr' },
  { Names: 'tautulli', State: 'exited', Status: 'Exited (1) 10 minutes ago', Image: 'tautulli' },
  { Names: 'stopped', State: 'exited', Status: 'Exited (137) 1 hour ago', Image: 'x' },
  { Names: 'oomed', State: 'exited', Status: 'Exited (137) 1 hour ago', Image: 'x' },
  { Names: 'termed', State: 'exited', Status: 'Exited (143) 1 hour ago', Image: 'x' },
  { Names: 'conjurr', State: 'created', Status: 'Created', Image: 'x' },
  { Names: 'claude-docker-proxy', State: 'restarting', Status: 'Restarting', Image: 'x' },
  { Names: 'ignored', State: 'exited', Status: 'Exited (2) now', Image: 'x' },
].map((r) => JSON.stringify(r)).join('\n') + '\nnot json\n';

test('docker ps lines parse, bad lines are skipped', () => {
  const rows = parseDockerPs(PS);
  assert.equal(rows.length, 11);
  assert.deepEqual(rows[0], { name: 'plex', state: 'running', status: 'Up 3 hours', image: 'plex' });
});

test('container findings: crashes, restarts, unhealthy; normal stops and own containers are quiet', () => {
  const f = containerFindings(parseDockerPs(PS), { ignore: ['ignored'], oomKilled: new Set(['oomed']) });
  const keys = f.map((x) => x.key).sort();
  assert.deepEqual(keys, [
    'container:oomed:exited',
    'container:radarr:restarting',
    'container:sonarr:unhealthy',
    'container:tautulli:exited',
  ]);
  assert.equal(f.find((x) => x.key === 'container:radarr:restarting').severity, 'critical');
  assert.match(f.find((x) => x.key === 'container:oomed:exited').title, /ran out of memory/);
  assert.match(f.find((x) => x.key === 'container:tautulli:exited').title, /exit code 1/);
});

test('array: stopped array and disabled disks are critical; empty slots are fine', () => {
  const ok = parseMdcmd('mdState=STARTED\nrdevStatus.0=DISK_NP_DSBL\nrdevName.0=\nrdevStatus.1=DISK_OK\nrdevStatus.29=DISK_NP\n');
  assert.deepEqual(arrayFindings(ok), []);
  const dsbl = parseMdcmd('mdState=STARTED\nrdevStatus.2=DISK_DSBL\nrdevName.2=sdc\n');
  const f = arrayFindings(dsbl);
  assert.equal(f.length, 1);
  assert.equal(f[0].title, 'Array disk2 (sdc) is DISK_DSBL');
  assert.equal(arrayFindings(parseMdcmd('mdState=STOPPED\n'))[0].key, 'array:state:STOPPED');
  assert.deepEqual(arrayFindings({}), []);
});

const DF = `Filesystem      Size  Used Avail Use% Mounted on
rootfs           32G  1.1G   31G   4% /
/dev/md1p1      7.3T  7.2T   60G  99% /mnt/disk1
/dev/md2p1      1.9T  1.6T  300G  85% /mnt/disk2
/dev/md3p1      3.7T  3.4T  300G  92% /mnt/disk3
/dev/nvme0n1p1  1.9T  210G  1.7T  11% /mnt/cache
shfs             13T   12T  500G  97% /mnt/user
shfs             13T   12T  500G  97% /mnt/user0
/dev/sdx1       100G   99G    1G  99% /mnt/disks/usb
/dev/loop2       20G   15G    5G  73% /var/lib/docker
`;

test('df: only disks and pools, with thresholds', () => {
  const rows = parseDf(DF);
  assert.deepEqual(rows.map((r) => r.name), ['disk1', 'disk2', 'disk3', 'cache']);
  const f = diskFindings(rows, 90);
  assert.deepEqual(f.map((x) => [x.key, x.severity]), [['disk:disk1:full', 'critical'], ['disk:disk3:full', 'warning']]);
  assert.equal(f[0].detail, '7.2T used of 7.3T, 60G free');
});

test('notifications: warnings and alerts only', () => {
  const f = notificationFindings([
    { id: 'a1', importance: 'ALERT', subject: 'Disk 1 SMART failure', description: 'reallocated sectors' },
    { id: 'w1', importance: 'WARNING', title: 'docker.img 73% full' },
    { id: 'i1', importance: 'INFO', subject: 'Parity check finished' },
  ]);
  assert.deepEqual(f.map((x) => [x.key, x.severity]), [['notify:a1', 'critical'], ['notify:w1', 'warning']]);
  assert.equal(f[1].title, 'Unraid: docker.img 73% full');
});

test('collect: runs fixed commands, reports failed sources', async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'docker' && args[0] === 'ps') return { code: 0, stdout: PS, stderr: '' };
    if (cmd === 'docker' && args[0] === 'inspect') return { code: 0, stdout: args.at(-1) === 'oomed' ? 'true\n' : 'false\n', stderr: '' };
    return { code: 1, stdout: '', stderr: 'nope' };
  };
  const asClaude = async (_cfg, args) => {
    calls.push(`as-claude ${args.join(' ')}`);
    if (args.join(' ') === 'host mdcmd status') return { code: 0, stdout: 'mdState=STARTED\n', stderr: '' };
    return { code: 69, stdout: '', stderr: 'host checks not set up' };
  };
  const fetchFn = async (url, opts) => {
    assert.equal(opts.headers['x-api-key'], 'k');
    const body = JSON.parse(opts.body);
    assert.equal(body.variables.filter.type, 'UNREAD');
    return { ok: true, status: 200, json: async () => ({ data: { notifications: { list: [{ id: 'n', importance: 'ALERT', subject: 's' }] } } }) };
  };
  const cfg = { ignore: [], hostChecks: true, diskWarnPercent: 90, apiUrl: 'http://x/graphql', apiKey: 'k' };
  const res = await collect(cfg, { run, asClaude, fetchFn });
  assert.ok(calls.includes('docker ps -a --format {{json .}}'));
  assert.ok(calls.includes('docker inspect --format {{.State.OOMKilled}} oomed'));
  assert.ok(calls.includes('as-claude host df -h'));
  assert.ok(res.findings.some((f) => f.key === 'notify:n'));
  assert.ok(res.findings.some((f) => f.key === 'container:oomed:exited'));
  assert.equal(res.failed.get('disks'), 'host checks not set up');
  assert.equal(res.failed.has('array'), false);
  assert.equal(res.containers.length, 11);
  assert.equal(res.facts.md.mdState, 'STARTED');
  assert.equal(res.facts.disks, null, 'failed source is unknown, not empty');
  assert.equal(res.facts.containers.length, 11);
  assert.deepEqual(res.facts.notifications.map((n) => n.id), ['n']);
});

test('collect: skips host checks and API when not configured', async () => {
  const run = async () => ({ code: 0, stdout: '', stderr: '' });
  const asClaude = async () => { throw new Error('must not be called'); };
  const fetchFn = async () => { throw new Error('must not be called'); };
  const res = await collect({ ignore: [], hostChecks: false, apiUrl: '', apiKey: '' }, { run, asClaude, fetchFn });
  assert.deepEqual(res.findings, []);
  assert.equal(res.failed.size, 0);
});
