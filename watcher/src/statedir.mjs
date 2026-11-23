// The watcher's state directory: the owner's rules, the audit log and the
// host-fix SSH key. It sits on the workspace mount so it survives an image
// update, but Claude's user owns /workspace and so can rename anything in it
// and put a folder or a link of its own in its place, at any time.
//
// So the directory is checked once (a real directory, owned by root, no
// access for group or others), anything else is moved aside, and it is then
// opened and used only through that open handle: /proc/<pid>/fd/<n> always
// means the directory that was checked, even if it is renamed later. Inside
// it, a root-only directory, Claude's user can neither read nor plant files.
import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';

export async function pinStateDir(dir, { uid = 0, log = console.error, now = Date.now } = {}) {
  if (process.platform !== 'linux') {
    // Development on another system: no /proc, nothing to defend.
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let fd;
    try {
      // O_NOFOLLOW: a link is refused (ELOOP), never followed; O_DIRECTORY:
      // a file or anything else is refused (ENOTDIR).
      fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch (err) {
      if (err.code !== 'ELOOP' && err.code !== 'ENOTDIR') throw err;
    }
    if (fd !== undefined) {
      const st = fstatSync(fd);
      if (st.isDirectory() && st.uid === uid && (st.mode & 0o077) === 0) return `/proc/${process.pid}/fd/${fd}`;
      closeSync(fd);
    }
    const aside = `${dir}.untrusted-${now()}-${attempt}`;
    await rename(dir, aside);
    log(`unraid-watch: ${dir} was not a root-only folder; moved it to ${aside} and started clean (rules and the host-fix key are new)`);
  }
  throw new Error(`${dir}: could not get a root-only state folder`);
}
