// Id + schema-version helpers shared by every writer of the layout doc
// (server seeding, the web editor, and — later — the desktop sync client).

import * as Y from 'yjs';
import { DOC_BASE_SCHEMA } from './shape.js';
import { stampMemberKeys } from './moduleMembers.js';

/**
 * Version of the Y.Doc layout shape, stored as `meta.schemaVersion`.
 * Bump when a change needs readers (notably the desktop live-sync client)
 * to know the doc is newer than they understand.
 *
 *   1 — text cells carry a stable `id`.
 *   2 — ruler items are Y.Maps, area sheets may have a `cellOffset`, parts
 *       and rulers may be ordered by `z` (shape.ts). A doc is stamped 1
 *       when made and moves to 2 only when an edit needs it.
 *   3 — a module's part changes are `p:` keys of `sidecarItems`
 *       (moduleMembers.ts). A doc moves to 3 with its first such key.
 */
export const DOC_SCHEMA_VERSION = 3;

/**
 * The oldest `meta.schemaVersion` this code still reads. Raise it only
 * when a change drops support for older docs; compat/compat.json (shared
 * with the desktop app) records both numbers.
 */
export const DOC_MIN_READABLE = 1;

/**
 * Whether a reader that writes `schemaVersion` and reads back to
 * `minReadable` can safely sync a doc stamped `docSchema`. An unstamped
 * doc (from before schema versions) is read and upgraded in place.
 */
export function canReadDoc(
  docSchema: unknown,
  schemaVersion: number = DOC_SCHEMA_VERSION,
  minReadable: number = DOC_MIN_READABLE,
): boolean {
  if (docSchema === undefined || docSchema === null) return true;
  if (typeof docSchema !== 'number') return false;
  return docSchema >= minReadable && docSchema <= schemaVersion;
}

/**
 * Generate a fresh decimal-numeric id (bricks, layers, groups, text
 * cells, ...).
 *
 * Vanilla BlueBrick ids must be parseable as `ulong`, so we emit a random
 * 63-bit unsigned integer in decimal. The previous `Date.now() + rand(0..999)`
 * scheme collided constantly when many ids were minted in the same
 * millisecond (a 50-brick paste produced duplicates in ~65% of runs).
 */
export function makeId(): string {
  const a = new BigUint64Array(1);
  crypto.getRandomValues(a);
  // Drop the top bit so the value also fits a signed 64-bit long, and
  // avoid the (astronomically unlikely) zero id.
  const v = a[0]! >> 1n;
  return (v === 0n ? 1n : v).toString();
}

/**
 * Bring a doc written before `DOC_SCHEMA_VERSION` up to date in place:
 * give every Y.Map text cell that lacks one a stable `id`, and stamp
 * `meta.schemaVersion`. Legacy plain-object cells are left alone (the
 * web editor converts them to Y.Maps, with an id, on first edit).
 * A doc holding module part keys under a lower stamp is stamped shape 3.
 * Only touches a doc that has been seeded (has `meta.version`), and
 * makes no change — no Yjs update — when there is nothing to do.
 * Returns true when it changed anything.
 */
export function upgradeDoc(doc: Y.Doc, origin?: unknown): boolean {
  const meta = doc.getMap('meta');
  if (meta.get('version') === undefined) return false;
  const missing: Y.Map<unknown>[] = [];
  const layerData = doc.getMap<Y.Map<unknown>>('layerData');
  for (const yLayer of layerData.values()) {
    if (!(yLayer instanceof Y.Map) || yLayer.get('type') !== 'text') continue;
    const cells = yLayer.get('textCells');
    if (!(cells instanceof Y.Array)) continue;
    for (const cell of cells.toArray()) {
      if (cell instanceof Y.Map && typeof cell.get('id') !== 'string') missing.push(cell);
    }
  }
  const stamp = meta.get('schemaVersion') === undefined;
  if (missing.length > 0 || stamp) {
    doc.transact(() => {
      for (const cell of missing) cell.set('id', makeId());
      if (stamp) meta.set('schemaVersion', DOC_BASE_SCHEMA);
    }, origin);
  }
  // Module part keys under a lower stamp (moduleMembers.ts): shape 3.
  const stamped = stampMemberKeys(doc);
  return missing.length > 0 || stamp || stamped;
}
