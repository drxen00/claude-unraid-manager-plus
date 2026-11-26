// The Wraith server panel: this server dials out to Wraith (Socket.IO,
// namespace /panel-connector) with the connection code from Wraith's
// Space settings → Server panel, and answers the panel channels' requests
// down that one socket (panel.mjs). Nothing on the Unraid side listens on
// the network. Wire format: docs/SPACE_PANELS.md in the Wraith repository.
//
// Runs inside the watcher (root), so Claude's user can read neither the
// code nor the linked account.
import { createServer } from 'node:net';
import { chmod, unlink } from 'node:fs/promises';
import { io } from 'socket.io-client';

/** Socket.IO caps one message at 1 MB; leave room for the envelope. */
export const MAX_ANSWER = 900 * 1024;

export function encodeAnswer({ status, json }) {
  let body = JSON.stringify(json ?? null);
  if (Buffer.byteLength(body) > MAX_ANSWER) {
    body = JSON.stringify({ error: 'too_large', message: 'That answer is too big to send to Wraith.' });
    status = 502;
  }
  return { status, contentType: 'application/json', body };
}

/**
 * opts: { url, token, api: createPanelApi(...), linkedUser(): string|null,
 *         onName(name), log, connect = io }
 * Returns { emitEvent(user, event), attention(event), close() }.
 */
export function startWraith({ url, token, api, linkedUser, onName = () => {}, log = console, connect = io }) {
  const subscribed = new Set();
  const socket = connect(`${url}/panel-connector`, {
    path: '/socket.io',
    transports: ['websocket'],
    auth: { token },
    reconnectionDelay: 2_000,
    reconnectionDelayMax: 60_000,
  });

  let refusedOnce = false;
  socket.on('connect', () => {
    refusedOnce = false;
    log.log(`unraid-watch: Wraith: connected to ${url}`);
  });
  socket.on('ready', (p) => {
    if (typeof p?.name === 'string') onName(p.name.slice(0, 64));
  });
  socket.on('disconnect', (reason) => {
    subscribed.clear();
    log.log(`unraid-watch: Wraith: disconnected (${reason})${reason === 'io server disconnect' ? '; the code was probably replaced in Wraith' : ''}`);
  });
  socket.on('connect_error', (e) => {
    if (e?.message === 'not_accepted') {
      if (!refusedOnce) log.error('unraid-watch: Wraith refused the connection code. Make a new one (Space settings, Server panel) and put it in the template.');
      refusedOnce = true;
    }
  });

  socket.on('request', async (req, ack) => {
    if (typeof ack !== 'function') return;
    try {
      const res = await api.handle({ method: req?.method, path: req?.path, user: req?.user, json: req?.json });
      ack(encodeAnswer(res));
    } catch (e) {
      log.error(`unraid-watch: Wraith request ${req?.method} ${req?.path} failed: ${e?.stack ?? e}`);
      ack(encodeAnswer({ status: 500, json: { error: 'server_error', message: 'Something went wrong on the server.' } }));
    }
  });
  // Live events go to the linked owner only, and only while they watch.
  socket.on('subscribe', (p) => { if (typeof p?.user === 'string') subscribed.add(p.user); });
  socket.on('unsubscribe', (p) => { subscribed.delete(p?.user); });

  return {
    emitEvent(user, event) {
      if (!user || !subscribed.has(user) || user !== linkedUser()) return;
      socket.emit('event', { user, event });
    },
    /** A panel.alert for the linked owner's phone (Wraith applies its own mutes on top). */
    attention(event) {
      const user = linkedUser();
      if (!user || !socket.connected) return;
      socket.emit('attention', { type: 'panel.alert', wraithUser: user, ...event });
    },
    close() { socket.close(); },
  };
}

/**
 * The root-only socket `wraith-link` talks to: one line in ("link"), a
 * fresh code out. Its folder is root 0700 (entrypoint.sh), and the socket
 * itself is 0600, so Claude's user cannot ask for a code.
 */
export async function serveAdminSocket(path, { issueCode, linked }) {
  await unlink(path).catch(() => {});
  const server = createServer((c) => {
    c.setEncoding('utf8');
    let buf = '';
    c.on('data', (d) => {
      buf += d;
      if (buf.length > 100) return c.destroy();
      if (!buf.includes('\n')) return;
      const cmd = buf.trim();
      if (cmd === 'link') {
        const { code, expires } = issueCode();
        c.end(JSON.stringify({ code, expires, linked: linked() }) + '\n');
      } else {
        c.end(JSON.stringify({ error: 'unknown command' }) + '\n');
      }
    });
    c.on('error', () => {});
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  await chmod(path, 0o600);
  return server;
}
