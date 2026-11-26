// CPU, memory, load and uptime for the Wraith panel's #system, read from
// /proc. A container shares the host's kernel, so /proc/stat, /proc/meminfo,
// /proc/loadavg and /proc/uptime describe the Unraid server itself (Unraid
// runs no lxcfs). The parsers are pure, so tests feed them fixtures.
import { readFile } from 'node:fs/promises';
import { cpus } from 'node:os';

/** First line of /proc/stat → { busy, total } jiffies. */
export function parseCpuLine(text) {
  const line = String(text).split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const n = line.trim().split(/\s+/).slice(1).map(Number);
  if (n.length < 4 || n.some((x) => !Number.isFinite(x))) return null;
  // user nice system idle iowait irq softirq steal (guest is inside user)
  const idle = n[3] + (n[4] ?? 0);
  const total = n.slice(0, 8).reduce((a, b) => a + b, 0);
  return { busy: total - idle, total };
}

export function cpuPercent(prev, cur) {
  if (!prev || !cur) return 0;
  const dt = cur.total - prev.total;
  if (dt <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(((cur.busy - prev.busy) / dt) * 1000) / 10));
}

/** /proc/meminfo → { total, used, percent } in bytes; used leaves out cache. */
export function parseMeminfo(text) {
  const kb = {};
  for (const line of String(text).split('\n')) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (m) kb[m[1]] = Number(m[2]);
  }
  if (!kb.MemTotal) return null;
  const avail = kb.MemAvailable ?? (kb.MemFree ?? 0) + (kb.Buffers ?? 0) + (kb.Cached ?? 0);
  const total = kb.MemTotal * 1024;
  const used = Math.max(0, total - avail * 1024);
  return { total, used, percent: Math.round((used / total) * 1000) / 10 };
}

export function parseLoadavg(text) {
  const f = String(text).trim().split(/\s+/).slice(0, 3).map(Number);
  return f.length === 3 && f.every(Number.isFinite) ? f : [0, 0, 0];
}

export function parseUptime(text) {
  const s = Number(String(text).trim().split(/\s+/)[0]);
  return Number.isFinite(s) ? Math.round(s) : 0;
}

const UNIT = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5 };

/** "3.6T" (df -h) → bytes. */
export function parseSize(s) {
  const m = /^([\d.]+)([BKMGTP]?)i?B?$/i.exec(String(s).trim());
  if (!m) return 0;
  return Math.round(Number(m[1]) * (UNIT[(m[2] || 'B').toUpperCase()] ?? 1));
}

/** The disks and pools df reported → one total for the overview. */
export function diskTotals(rows) {
  let total = 0;
  let used = 0;
  for (const r of rows ?? []) {
    total += parseSize(r.size);
    used += parseSize(r.used);
  }
  return { total, used, percent: total ? Math.round((used / total) * 1000) / 10 : 0 };
}

/**
 * Samples every few seconds and keeps the last hour, for the overview's
 * numbers and its little graph. read(path) is swappable for tests.
 */
export class SysSampler {
  constructor({ read = (p) => readFile(p, 'utf8'), everyMs = 10_000, keep = 360, now = () => Date.now() } = {}) {
    this.read = read;
    this.everyMs = everyMs;
    this.keep = keep;
    this.now = now;
    this.prevCpu = null;
    this.cpu = 0;
    this.mem = null;
    this.history = [];
    this.timer = null;
  }

  async sample() {
    try {
      const [stat, mem] = await Promise.all([this.read('/proc/stat'), this.read('/proc/meminfo')]);
      const cur = parseCpuLine(stat);
      this.cpu = cpuPercent(this.prevCpu, cur);
      this.prevCpu = cur;
      this.mem = parseMeminfo(mem);
      this.history.push({ t: this.now(), cpu: this.cpu, mem: this.mem?.percent ?? 0 });
      while (this.history.length > this.keep) this.history.shift();
    } catch {
      // Not Linux (tests on Windows) or /proc unreadable: the numbers stay at 0.
    }
  }

  start() {
    void this.sample();
    this.timer = setInterval(() => void this.sample(), this.everyMs);
    this.timer.unref?.();
  }

  async info({ hostname, disks }) {
    const [load, up] = await Promise.all([
      this.read('/proc/loadavg').then(parseLoadavg, () => [0, 0, 0]),
      this.read('/proc/uptime').then(parseUptime, () => 0),
    ]);
    return {
      hostname,
      platform: 'Unraid',
      uptime: up,
      cores: cpus().length,
      cpu: this.cpu,
      load,
      mem: this.mem ?? { total: 0, used: 0, percent: 0 },
      disk: diskTotals(disks),
    };
  }
}
