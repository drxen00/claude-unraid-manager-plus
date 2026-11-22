// Turns each run's findings into incidents: new problems, problems that got
// worse, and problems that went away. One message per problem, not one per
// check: an open incident is only reported again when its severity rises.

const RANK = { warning: 1, critical: 2 };

// A finding must be missing this many runs in a row before it counts as
// resolved, so a flapping check does not produce resolve/alert pairs.
export const RESOLVE_AFTER = 2;

export function emptyState() {
  return { open: {} };
}

/**
 * @param state    { open: { [key]: incident } } from the last run
 * @param findings this run's findings
 * @param failed   Map of sources whose collector failed this run: their open
 *                 incidents are kept as they are, neither resolved nor counted
 * @returns { state, raised, resolved } raised: new or worse; resolved: gone
 */
export function diff(state, findings, failed = new Map(), now = Date.now()) {
  const open = { ...state.open };
  const raised = [];
  const resolved = [];
  const seen = new Set();

  for (const f of findings) {
    seen.add(f.key);
    const prev = open[f.key];
    if (!prev) {
      const inc = { ...f, firstSeen: now, lastSeen: now, reported: f.severity, missing: 0 };
      open[f.key] = inc;
      raised.push(inc);
    } else {
      const worse = RANK[f.severity] > RANK[prev.reported];
      const inc = { ...prev, ...f, firstSeen: prev.firstSeen, lastSeen: now, missing: 0, reported: worse ? f.severity : prev.reported };
      open[f.key] = inc;
      if (worse) raised.push(inc);
    }
  }

  for (const [key, inc] of Object.entries(open)) {
    if (seen.has(key) || failed.has(inc.source)) continue;
    const missing = (inc.missing ?? 0) + 1;
    if (missing >= RESOLVE_AFTER) {
      delete open[key];
      resolved.push(inc);
    } else {
      open[key] = { ...inc, missing };
    }
  }

  return { state: { open }, raised, resolved };
}

// Collector failures become incidents of their own, so "I can't check the
// array" is reported once instead of silently hiding problems.
export function failureFindings(failed) {
  const out = [];
  for (const [source, error] of failed) {
    out.push({ source: `watch:${source}`, key: `watch:${source}:failed`, severity: 'warning', title: `The watcher can't check ${source}`, detail: error || 'no error text' });
  }
  return out;
}

export function openIncidents(state) {
  return Object.values(state.open).sort((a, b) => (RANK[b.severity] - RANK[a.severity]) || a.firstSeen - b.firstSeen);
}
