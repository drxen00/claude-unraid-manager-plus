// Watcher settings, all from the container's environment (the Unraid
// template). Invalid values fail loudly at start instead of being guessed.

const SNOWFLAKE = /^\d{17,20}$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function int(value, fallback, min, max, name) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}, got "${value}"`);
  }
  return n;
}

// The code from Wraith → Space settings → Server panel:
// wpc1.<Wraith's address, base64url>.wpanel_<64 hex>
export function parseWraithCode(raw) {
  const code = String(raw ?? '').trim();
  if (!code) return null;
  const m = /^wpc1\.([A-Za-z0-9_-]+)\.(wpanel_[0-9a-f]{64})$/.exec(code);
  if (!m) throw new Error('WRAITH_PANEL_CODE is not a Wraith connection code (Space settings, Server panel, Make a connection code; copy all of it)');
  let url;
  try {
    url = new URL(Buffer.from(m[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('WRAITH_PANEL_CODE has a broken address in it; make a new code in Wraith');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(`WRAITH_PANEL_CODE points at ${url.origin}, which is not https`);
  }
  return { url: url.origin, token: m[2] };
}

export function loadConfig(env = process.env) {
  const token = (env.DISCORD_BOT_TOKEN ?? '').trim();
  const owner = (env.DISCORD_USER_ID ?? '').trim();
  const wraith = parseWraithCode(env.WRAITH_PANEL_CODE);
  // At least one place to report to: Discord, Wraith, or both.
  if (!token && !wraith) throw new Error('neither DISCORD_BOT_TOKEN nor WRAITH_PANEL_CODE is set');
  if (token && !SNOWFLAKE.test(owner)) {
    throw new Error('DISCORD_USER_ID must be your numeric Discord user ID (Developer Mode, right-click your name, Copy User ID)');
  }

  const reportTime = (env.REPORT_TIME ?? '08:00').trim().toLowerCase() || '08:00';
  if (reportTime !== 'off' && !HHMM.test(reportTime)) {
    throw new Error(`REPORT_TIME must be HH:MM (24 hour) or "off", got "${reportTime}"`);
  }

  const ignore = (env.WATCH_IGNORE ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    token,
    owner,
    discord: Boolean(token),
    wraith,
    // The root-only socket `wraith-link` asks for a link code on.
    adminSocket: env.WATCH_ADMIN_SOCKET || '/run/unraid-watch-admin/admin.sock',
    reportTime,
    intervalMinutes: int(env.CHECK_INTERVAL, 15, 5, 240, 'CHECK_INTERVAL'),
    diskWarnPercent: int(env.DISK_WARN_PERCENT, 90, 50, 99, 'DISK_WARN_PERCENT'),
    ignore,
    // On the workspace mount so rules and the host-fix key survive an image
    // update; root-only (main.mjs checks), so Claude's user cannot read it.
    stateDir: env.WATCH_STATE_DIR || '/workspace/.unraid-watch',
    claudeUser: env.CLAUDE_USER || 'claude',
    claudeHome: env.CLAUDE_HOME || '/home/claude',
    claudeCwd: env.WATCH_CLAUDE_CWD || '/workspace/watch',
    claudeTimeoutMs: int(env.WATCH_CLAUDE_TIMEOUT, 300, 30, 1800, 'WATCH_CLAUDE_TIMEOUT') * 1000,
    // Chat and Fix it runs wait for the owner's taps: up to 15 minutes each.
    fixTimeoutMs: int(env.WATCH_FIX_TIMEOUT, 2700, 300, 7200, 'WATCH_FIX_TIMEOUT') * 1000,
    fixSocket: env.UNRAID_FIX_SOCKET || '/run/unraid-watch/fix.sock',
    claudeGid: int(env.CLAUDE_GID, 100, 0, 65535, 'CLAUDE_GID'),
    sshHost: env.UNRAID_SSH_HOST || '',
    sshPort: int(env.UNRAID_SSH_PORT, 22, 1, 65535, 'UNRAID_SSH_PORT'),
    hostChecks: Boolean(env.UNRAID_SSH_HOST),
    apiUrl: env.UNRAID_API_URL || '',
    apiKey: env.UNRAID_API_KEY || '',
  };
}
