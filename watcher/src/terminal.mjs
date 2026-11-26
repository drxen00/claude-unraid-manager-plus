// The Wraith #terminal: a root shell on the Unraid host, one command at a
// time, for the linked owner. Off unless the owner turned it on twice: the
// template setting WRAITH_TERMINAL=host, and the host-shell line in the
// host's authorized_keys (wraith-terminal-setup prints it). The host logs
// every command it is given to syslog (tag claude-wraith-terminal).
//
// Each command is its own SSH connection with a pty, so Ctrl-C and friends
// work. The shell's directory carries over between commands (the command
// ends by printing it); variables do not. Full-screen programs (top, vim)
// do not work here; the Unraid web terminal is for those.
import { randomBytes } from 'node:crypto';

const KEYS = { interrupt: '\x03', eof: '\x04', suspend: '\x1a', quit: '\x1c', escape: '\x1b' };
export const MAX_OUTPUT = 512 * 1024;
const MAX_ENTRIES = 600;
const TRAILER = /\n?\x1eWRAITH (\d+) ([^\x1e]*)\x1e\s*$/;
// Colours, cursor moves, title sets: a chat window shows plain text.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;

export function cleanOutput(s) {
  return String(s).replace(ANSI, '').replace(/\r\n/g, '\n').replace(/\r/g, '');
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * What runs on the host for one command: the directory from last time, the
 * command on lines of its own (so a trailing comment cannot swallow the
 * rest), then its exit code and the directory it ended in, after a marker.
 */
export function buildScript(cwd, command) {
  return [
    'stty -echo 2>/dev/null',
    `cd -- ${shq(cwd)} 2>/dev/null || cd`,
    command,
    `__w=$?; printf '\\n\\036WRAITH %s %s\\036' "$__w" "$PWD"`,
  ].join('\n');
}

export function splitTrailer(text) {
  const m = TRAILER.exec(text);
  if (!m) return { text, exit: null, cwd: null };
  return { text: text.slice(0, m.index), exit: Number(m[1]), cwd: m[2] || null };
}

/**
 * spawnShell(script) → a child process (stdin, stdout, stderr, kill, on('close')).
 * emit(event): to the linked owner's open #terminal.
 */
export class HostTerminal {
  constructor({ spawnShell, emit = () => {}, now = () => Date.now(), home = '/root', audit = async () => {} }) {
    Object.assign(this, { spawnShell, emit, now, home, audit });
    this.cwd = home;
    this.entries = [];
    this.child = null;
    this.out = null;
  }

  state() {
    return { alive: true, ready: !this.child, running: Boolean(this.child), cwd: this.cwd, runAs: 'root' };
  }

  #add(entry) {
    const e = { id: randomBytes(8).toString('hex'), t: this.now(), ...entry };
    this.entries.push(e);
    while (this.entries.length > MAX_ENTRIES) this.entries.shift();
    this.emit({ type: 'term.entry', entry: e });
    return e;
  }

  #update(e) {
    this.emit({ type: 'term.update', entry: { ...e } });
  }

  history({ limit = 100, before = null } = {}) {
    let list = this.entries;
    if (before) {
      const i = list.findIndex((e) => e.id === before);
      list = i >= 0 ? list.slice(0, i) : [];
    }
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    return { entries: list.slice(-n), state: this.state() };
  }

  async input(text) {
    const value = String(text ?? '');
    if (this.child) {
      // Input for the running command (a prompt, a password, y/n).
      this.#add({ kind: 'stdin', text: value.replace(/./g, '•').slice(0, 200) || '⏎' });
      this.child.stdin.write(`${value}\n`);
      return { as: 'stdin' };
    }
    const command = value.trim();
    if (!command) throw Object.assign(new Error('Type a command.'), { code: 'empty' });
    if (command.length > 8000) throw Object.assign(new Error('That command is too long.'), { code: 'too_long' });
    await this.audit({ who: 'owner (Wraith terminal)', action: 'terminal.run', target: this.cwd, command: command.slice(0, 500) });
    this.#add({ kind: 'cmd', text: command, cwd: this.cwd });
    const out = this.#add({ kind: 'out', text: '', running: true, exit: null });
    this.out = out;
    let raw = '';
    let shown = 0;
    const child = this.spawnShell(buildScript(this.cwd, command));
    this.child = child;
    this.emit({ type: 'term.state', state: this.state() });
    let pending = null;
    const flush = () => {
      pending = null;
      // Everything from the end marker on (maybe half received) is not output.
      const cut = raw.indexOf('\x1e');
      const visible = cleanOutput(cut >= 0 ? raw.slice(0, cut) : raw);
      if (visible.length > MAX_OUTPUT) {
        out.text = visible.slice(0, MAX_OUTPUT);
        out.truncated = true;
      } else out.text = visible;
      if (out.text.length !== shown) {
        shown = out.text.length;
        this.#update(out);
      }
    };
    const onData = (d) => {
      if (raw.length < MAX_OUTPUT * 2) raw += d;
      pending ??= setTimeout(flush, 150);
    };
    child.stdout.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout.on('data', onData);
    child.stderr?.on('data', onData);
    child.stdin.on?.('error', () => {});
    child.on('close', (code) => {
      if (pending) clearTimeout(pending);
      const t = splitTrailer(cleanOutput(raw));
      out.text = t.text.length > MAX_OUTPUT ? t.text.slice(0, MAX_OUTPUT) : t.text.replace(/\n$/, '');
      if (t.text.length > MAX_OUTPUT) out.truncated = true;
      out.running = false;
      out.exit = t.exit ?? (code ?? null);
      if (t.cwd) this.cwd = t.cwd;
      this.child = null;
      this.out = null;
      this.#update(out);
      this.emit({ type: 'term.state', state: this.state() });
    });
    return { as: 'command' };
  }

  key(name) {
    const k = KEYS[name];
    if (!k) throw Object.assign(new Error('Unknown key.'), { code: 'bad_key' });
    if (!this.child) return false;
    this.child.stdin.write(k);
    return true;
  }

  clear() {
    this.entries = this.entries.filter((e) => e.running || (this.out && e === this.out));
    this.emit({ type: 'term.cleared' });
  }

  reset() {
    if (this.child) this.child.kill('SIGKILL');
    this.cwd = this.home;
    this.emit({ type: 'term.state', state: this.state() });
  }
}
