// While the server runs it holds `<database>.server`, a small file with its
// process id. The repair tools (unmerge, restore deleted parts, clamp
// drawing values) refuse to write while it's there and that process is
// alive: an open room's in-memory doc would overwrite the repair on its
// next save.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const serverLockPath = (dbPath: string) => `${resolve(dbPath)}.server`;

/** Taken when the server starts; the returned function lets it go (on close). */
export function holdServerLock(dbPath: string, pid = process.pid): () => void {
  const path = serverLockPath(dbPath);
  try {
    writeFileSync(path, `${pid}\n`);
  } catch {
    return () => {}; // a read-only folder: the tools fall back to asking
  }
  return () => {
    try {
      if (readFileSync(path, 'utf8').trim() === String(pid)) unlinkSync(path);
    } catch {
      /* gone */
    }
  };
}

/** The running server's process id for this database, or null (none, or one that stopped without letting go). */
export function runningServer(dbPath: string): number | null {
  const path = serverLockPath(dbPath);
  if (!existsSync(path)) return null;
  const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (err) {
    // EPERM: alive, someone else's. ESRCH: gone.
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? pid : null;
  }
}

/** The message a repair tool prints when it won't write, or null when it may. */
export function refuseWhileRunning(dbPath: string): string | null {
  const pid = runningServer(dbPath);
  return pid === null
    ? null
    : `refusing: the server is running on this database (process ${pid}, ${serverLockPath(dbPath)}). Stop it first: an open layout would overwrite the repair when it next saves.\n`;
}
