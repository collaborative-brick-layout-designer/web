// Imported first by index.ts, before anything opens the database: a
// restore an admin asked for (Admin › Backups) is put in place here, at
// start, while nothing has the database open (ops/dbBackups.ts).

import { env } from '../env.js';
import { applyPendingRestore, type LastRestore } from './dbBackups.js';

export const restoredAtStart: LastRestore | null = await applyPendingRestore(env.dbPath, env.backupsDir, (line) => console.log(line));
