// Runs a program with fixed arguments (never through a shell) and collects
// its output. Every command the watcher runs goes through here, so tests can
// swap it for a fake.
import { spawn } from 'node:child_process';

export function run(cmd, args, { input, timeoutMs = 60_000, env, cwd } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    const child = spawn(cmd, args, { env: env ?? process.env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      if (!done) child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => {
      done = true;
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: String(err.message), timedOut: false });
    });
    child.on('close', (code, signal) => {
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? 128, stdout, stderr, timedOut: signal === 'SIGKILL' });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

// Run as Claude's unprivileged user, without the watcher's secrets.
export function asClaude(cfg, args, opts = {}) {
  return run('runuser', [
    '-u', cfg.claudeUser, '--',
    'env', '-u', 'UNRAID_API_KEY', '-u', 'DISCORD_BOT_TOKEN',
    `HOME=${cfg.claudeHome}`, `USER=${cfg.claudeUser}`, `LOGNAME=${cfg.claudeUser}`,
    ...args,
  ], opts);
}
