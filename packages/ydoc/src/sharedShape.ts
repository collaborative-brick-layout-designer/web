// Doc shape 4 (meta.schemaVersion 4): shared, read-only modules
// (docs/shared-modules.md).
//
// A placed module whose sidecar value has `shared` (next to its link,
// `libraryModuleId`) is locked: its parts are its owner's, and the apps let
// people move, turn and remove it as a whole, nothing else. A build that
// doesn't know the field would let its parts be changed, and the server
// would then refuse its changes and end its connection, again and again.
// So a layout moves to shape 4 with its first shared module, and builds
// that read only 3 are told plainly that it needs a newer version.
//
// The stamp is its own step, never undone, as in shapes 2 and 3. Any app
// (and the server, on opening a room) that finds a shared module in a doc
// stamped lower stamps it again. A layout without shared modules stays in
// the shape it has. Files are unchanged: the sidecar keeps the field, and
// an older app opening the file sees an ordinary module.

import * as Y from 'yjs';
import { SHAPE_ORIGIN } from './shape.js';

/** The shape that has shared (read-only) modules. */
export const DOC_SHAPE_SHARED = 4;

const SIDECAR_ITEMS = 'sidecarItems';
const MODULE_PREFIX = 'm:';

/** Whether a module's sidecar value marks it shared: `shared` is an object, and it follows a library module. */
export function hasSharedMark(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return !!o.shared && typeof o.shared === 'object' && !Array.isArray(o.shared) && typeof o.libraryModuleId === 'string' && o.libraryModuleId !== '';
}

/** Whether the doc holds a shared module: among its module items, or in the sidecar blob. */
export function holdsSharedModule(doc: Y.Doc): boolean {
  const items = doc.getMap<unknown>(SIDECAR_ITEMS);
  for (const [k, v] of items) if (k.startsWith(MODULE_PREFIX) && hasSharedMark(v)) return true;
  const cache = doc.getMap('meta').get('cache') as { modules?: unknown } | undefined;
  return !!cache && typeof cache === 'object' && Array.isArray(cache.modules) && cache.modules.some(hasSharedMark);
}

/**
 * Stamp the doc shape 4 when it holds a shared module under a lower stamp.
 * Its own transaction, never undone. Returns whether it wrote.
 */
export function stampShared(doc: Y.Doc): boolean {
  const meta = doc.getMap('meta');
  const v = meta.get('schemaVersion');
  if (typeof v === 'number' && v >= DOC_SHAPE_SHARED) return false;
  // A doc that was never seeded has nothing to stamp.
  if (meta.get('version') === undefined && v === undefined) return false;
  if (!holdsSharedModule(doc)) return false;
  doc.transact(() => meta.set('schemaVersion', DOC_SHAPE_SHARED), SHAPE_ORIGIN);
  return true;
}

const stampWaiting = new WeakSet<Y.Doc>();

/** stampShared once the transaction being made ends (a write inside one can't stamp untracked). */
export function stampSharedAfter(doc: Y.Doc): void {
  if (stampWaiting.has(doc)) return;
  stampWaiting.add(doc);
  doc.once('afterTransaction', () => {
    stampWaiting.delete(doc);
    stampShared(doc);
  });
}
