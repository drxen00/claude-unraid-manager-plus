// fix-mcp: a tiny MCP server (stdio, JSON-RPC, one message per line) that
// offers the fix tools to Claude. It runs as Claude's user, holds no secrets
// and changes nothing itself: each call is forwarded to the watcher's socket,
// where the owner allows or denies it in Discord. Listed in the root-owned
// managed MCP config by the entrypoint when the Discord watcher is set up.
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { APPROVAL_MS, FIX_HELP, FIX_TOOLS } from './fix.mjs';

const SOCKET = process.env.UNRAID_FIX_SOCKET || '/run/unraid-watch/fix.sock';
// Set in the managed MCP config when Wraith is on: offer the permission tool
// the Wraith chats use (--permission-prompt-tool mcp__fix__wraith_permission).
const WRAITH = process.env.UNRAID_WRAITH_PERM === '1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The Wraith chat this Claude runs for. The watcher starts each chat's
 * claude with WRAITH_CHAT_ID; Claude Code may not pass its environment on to
 * MCP servers, so the processes above this one are asked too (a few levels,
 * as far as Claude's user can read them). Without it, a change goes to the
 * Approvals list instead of the chat: still asked, just elsewhere.
 */
export function findOrigin({ env = process.env, ppid = process.ppid, read = (p) => readFileSync(p, 'utf8') } = {}) {
  if (UUID.test(env.WRAITH_CHAT_ID ?? '')) return env.WRAITH_CHAT_ID;
  let pid = ppid;
  for (let i = 0; i < 4 && pid > 1; i++) {
    try {
      const vars = read(`/proc/${pid}/environ`).split('\0');
      const hit = vars.find((v) => v.startsWith('WRAITH_CHAT_ID='))?.slice('WRAITH_CHAT_ID='.length);
      if (UUID.test(hit ?? '')) return hit;
      // Field 4 of /proc/<pid>/stat, after the "(name)" that may hold spaces.
      const stat = read(`/proc/${pid}/stat`);
      pid = Number(stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[1]);
    } catch {
      return null;
    }
  }
  return null;
}
const ORIGIN = findOrigin();

export const PERMISSION_TOOL = {
  description: 'Used by Claude Code itself to ask the owner, in their Wraith chat, whether a tool may run. Not for direct use.',
  inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name'] },
};
// Waiting for the owner plus the slowest fix (an image pull).
const CALL_TIMEOUT_MS = APPROVAL_MS + 20 * 60_000;

export function callWatcher(req, { socket = SOCKET, timeoutMs = CALL_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let buf = '';
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(r);
    };
    const conn = createConnection(socket);
    const timer = setTimeout(() => finish({ ok: false, text: 'No answer from the watcher in time. Nothing was changed.' }), timeoutMs);
    conn.setEncoding('utf8');
    conn.on('connect', () => conn.write(JSON.stringify(req) + '\n'));
    conn.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        const r = JSON.parse(buf.slice(0, nl));
        finish({ ok: Boolean(r.ok), text: String(r.text ?? '') });
      } catch {
        finish({ ok: false, text: 'The watcher sent an unreadable answer. Nothing was changed.' });
      }
    });
    conn.on('error', (err) => finish({ ok: false, text: `The Discord watcher is not reachable (${err.code ?? err.message}), so nothing can be changed right now.` }));
    conn.on('close', () => finish({ ok: false, text: 'The watcher closed the connection without an answer. Nothing was changed.' }));
  });
}

export async function handleMessage(msg, { call = callWatcher, wraith = WRAITH, origin = ORIGIN } = {}) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return null;
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null; // a notification: nothing to answer
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'unraid-fix', version: '1' },
        instructions: FIX_HELP,
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({
        tools: [
          ...Object.entries(FIX_TOOLS).map(([name, t]) => ({ name, description: `${t.description} ${FIX_HELP}`, inputSchema: t.inputSchema })),
          ...(wraith ? [{ name: 'wraith_permission', ...PERMISSION_TOOL }] : []),
        ],
      });
    case 'tools/call': {
      const name = String(params?.name ?? '');
      const known = Object.hasOwn(FIX_TOOLS, name) || (wraith && name === 'wraith_permission');
      if (!known) return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      const args = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      const r = await call({ tool: name, args, ...(origin ? { origin } : {}) });
      // The permission answer is exactly one text block holding its JSON.
      if (name === 'wraith_permission') return ok({ content: [{ type: 'text', text: r.ok ? r.text : JSON.stringify({ behavior: 'deny', message: r.text || 'No answer.' }) }] });
      return ok({ content: [{ type: 'text', text: r.text || (r.ok ? 'Done.' : 'Failed.') }], isError: !r.ok });
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

function serve() {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    const res = await handleMessage(msg);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  });
  rl.on('close', () => process.exit(0));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) serve();
