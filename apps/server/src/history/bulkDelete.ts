// Before an edit that deletes many parts at once (a whole sheet, a big
// selection, a mistake), the layout as it was goes into its version
// history, so it can be put back. Counted from the edit's delete set
// against the room's document before it is applied: list entries that are
// maps (parts, rulers, text cells) and still there. At most one such
// version per layout every few minutes.

import * as Y from 'yjs';
import type { DocSession } from '../ws/docHub.js';
import type { DecodedUpdate } from '../ws/decoded.js';
import { takeVersion } from './layoutVersions.js';
import { peekHistorySettings } from './settings.js';

const EVERY_MS = 5 * 60 * 1000;
const lastKept = new Map<string, number>();

/** List entries that are maps this delete set removes from `doc`, counting up to `stopAt`. */
export function deletedEntries(doc: Y.Doc, ds: DecodedUpdate['ds'], stopAt = Infinity): number {
  let n = 0;
  for (const [client, ranges] of ds.clients) {
    const structs = doc.store.clients.get(client);
    if (!structs || structs.length === 0) continue;
    for (const r of ranges) {
      const lastClock = structs[structs.length - 1]!.id.clock;
      if (r.clock > lastClock) continue;
      let i: number;
      try {
        i = Y.findIndexSS(structs, r.clock);
      } catch {
        continue;
      }
      for (; i < structs.length && structs[i]!.id.clock < r.clock + r.len; i++) {
        const s = structs[i];
        if (s instanceof Y.Item && !s.deleted && s.parentSub === null && s.parent instanceof Y.Array && s.content instanceof Y.ContentType && s.content.type instanceof Y.Map) {
          n += s.length;
          if (n >= stopAt) return n;
        }
      }
    }
  }
  return n;
}

/** How many parts one edit deletes before a version is kept: Admin › Backups sets it (50 by default). */
// Synchronous on purpose: the layout is read before the edit is applied.
export function keepBeforeBulkDelete(session: DocSession, decoded: DecodedUpdate, userId: string | null, now = Date.now()): void {
  if (decoded.ds.clients.size === 0) return;
  if (now - (lastKept.get(session.layoutId) ?? 0) < EVERY_MS) return;
  const { enabled, limits } = peekHistorySettings();
  if (!enabled) return;
  if (deletedEntries(session.doc, decoded.ds, limits.bulkDeleteParts) < limits.bulkDeleteParts) return;
  lastKept.set(session.layoutId, now);
  const state = Y.encodeStateAsUpdate(session.doc);
  void takeVersion({ layoutId: session.layoutId, state, reason: 'before-bulk-delete', by: userId }).catch((err: unknown) =>
    console.error('[history] could not keep a version before a big delete in layout %s', session.layoutId, err),
  );
}
