// File access for the root watcher inside folders Claude's user owns (its
// home, with the chat transcripts). Claude's user can put a link, a FIFO or
// a hard link to a root file there at any time, so the watcher only reads
// and deletes regular files that Claude's user owns, and never follows a
// link at the last step. A link earlier in the path can only lead to more of
// Claude's own files, which it could read anyway.
//
// Writing there is not done as root at all: uploads are written by Claude's
// user (main.mjs), so a link cannot turn them into a root write.
import { constants } from 'node:fs';
import { lstat, open, readdir, unlink } from 'node:fs/promises';

const refused = (path, why) => Object.assign(new Error(`${path}: ${why}`), { code: 'EOWNED' });

export function ownedFs(uid, { maxBytes = 20 * 1024 * 1024 } = {}) {
  async function check(path) {
    const st = await lstat(path);
    if (!st.isFile()) throw refused(path, 'not a regular file');
    if (st.uid !== uid) throw refused(path, "not owned by Claude's user");
    return st;
  }
  return {
    readdir: (path, opts) => readdir(path, opts),
    stat: check,
    async readFile(path) {
      // O_NOFOLLOW: a link swapped in after the check is refused; O_NONBLOCK:
      // a FIFO cannot hang the watcher. The open file itself is checked again.
      const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const st = await fh.stat();
        if (!st.isFile()) throw refused(path, 'not a regular file');
        if (st.uid !== uid) throw refused(path, "not owned by Claude's user");
        if (st.size > maxBytes) throw refused(path, 'too large');
        return await fh.readFile({ encoding: 'utf8' });
      } finally {
        await fh.close();
      }
    },
    async unlink(path) {
      await check(path);
      await unlink(path);
    },
  };
}
