// Doc shape 5 (meta.schemaVersion 5): updates of shared modules that keep
// the ids of unchanged parts (docs/shared-modules.md, phase 3).
//
// Before this, an update put every part of a shared module in again, new.
// Now the server keeps the parts that didn't change (@cld/modules
// keepIds.ts). That leaves a person's earlier undo steps pointing at parts
// that are still there: undoing a move of the module would move the kept
// parts back and leave the new ones, and undoing placing it would take the
// kept parts away and leave the rest. Builds that read shape 5 finish such
// an undo for the whole module (@cld/modules settle.ts; the desktop's
// edit/SharedSettle.cpp); older ones can't, so a layout moves to 5 with its
// first such update, and they are told it needs a newer version.
//
// The stamp is its own step, never undone, as in shapes 2 to 4, with a
// mark (`meta.keptIds`) so that a lower stamp written at the same moment
// is raised again on opening. Files are unchanged.

import * as Y from 'yjs';
import { SHAPE_ORIGIN } from './shape.js';

/** The shape whose shared-module updates keep unchanged parts. */
export const DOC_SHAPE_KEEP_IDS = 5;

/** The mark an update that kept parts leaves in `meta`. */
export const KEPT_IDS_MARK = 'keptIds';

/**
 * Mark the doc as having had an update that kept parts, and stamp it shape
 * 5. Its own transaction, never undone. Returns whether it wrote.
 */
export function stampKeepIds(doc: Y.Doc): boolean {
  const meta = doc.getMap('meta');
  const v = meta.get('schemaVersion');
  const stamped = typeof v === 'number' && v >= DOC_SHAPE_KEEP_IDS;
  if (stamped && meta.get(KEPT_IDS_MARK) === true) return false;
  doc.transact(() => {
    if (meta.get(KEPT_IDS_MARK) !== true) meta.set(KEPT_IDS_MARK, true);
    if (!stamped) meta.set('schemaVersion', DOC_SHAPE_KEEP_IDS);
  }, SHAPE_ORIGIN);
  return true;
}

/** Stamp shape 5 again on a doc marked as having had such an update under a lower stamp (two stamps at the same moment). */
export function restampKeepIds(doc: Y.Doc): boolean {
  const meta = doc.getMap('meta');
  if (meta.get(KEPT_IDS_MARK) !== true) return false;
  const v = meta.get('schemaVersion');
  if (typeof v === 'number' && v >= DOC_SHAPE_KEEP_IDS) return false;
  doc.transact(() => meta.set('schemaVersion', DOC_SHAPE_KEEP_IDS), SHAPE_ORIGIN);
  return true;
}
