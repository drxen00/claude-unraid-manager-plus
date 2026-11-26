// wraith-link: prints a one-time code that links your Wraith account to this
// server's panel. Run as root (docker exec -it claude-unraid-manager
// wraith-link); asks the watcher over its root-only socket.
import { connect } from 'node:net';

const path = process.env.WATCH_ADMIN_SOCKET || '/run/unraid-watch-admin/admin.sock';

if (process.getuid?.() !== 0) {
  console.error('wraith-link: run it as root: docker exec -it claude-unraid-manager wraith-link');
  process.exit(77);
}

const c = connect(path);
let out = '';
c.setEncoding('utf8');
c.on('connect', () => c.write('link\n'));
c.on('data', (d) => { out += d; });
c.on('error', (e) => {
  console.error(`wraith-link: the watcher is not answering (${e.code ?? e.message}).`);
  console.error('wraith-link: is "Wraith connection code" set in the template? Check: docker logs claude-unraid-manager');
  process.exit(69);
});
c.on('end', () => {
  let r;
  try { r = JSON.parse(out); } catch { r = null; }
  if (!r?.code) {
    console.error(`wraith-link: unexpected answer from the watcher: ${out.trim().slice(0, 200)}`);
    process.exit(70);
  }
  const mins = Math.round((r.expires - Date.now()) / 60_000);
  console.log('');
  console.log(`  Link code:  ${r.code}`);
  console.log('');
  console.log(`  In Wraith, open one of this server's panel channels (#system or #alerts)`);
  console.log(`  and type the code into "Link your panel account". It works once, for ${mins} minutes.`);
  if (r.linked) console.log('  (A Wraith account is linked already; linking again replaces it.)');
  console.log('');
});
