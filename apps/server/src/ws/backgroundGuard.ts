// Where a layout's background picture may come from: this server's own
// copy of it (`/api/layouts/<id>/background-image`, the upload route), or
// nowhere (no `url`, or an empty one: a desktop sidecar keeps a local
// `path` instead). Everyone who opens a layout loads its picture, so an
// address on another host would tell that host who opened it and when.
//
// The sidecar lives in the document's `meta.cache`, one plain value
// written whole (@cld/ydoc writeSidecarCache). An update or a document
// that would leave it pointing anywhere else is refused, unless the
// layout already pointed there before (a layout saved that way can still
// be edited: every module or label edit writes the sidecar again).

import * as Y from 'yjs';
import { decodeDoc, readSidecarCache } from '@cld/ydoc';
import { decodeIncoming, type DecodedUpdate } from './decoded.js';

/** The one background-image address a layout may have. */
export const backgroundImageUrl = (layoutId: string) => `/api/layouts/${layoutId}/background-image`;

/** Whether `url` (a sidecar's `backgroundImage.url`) is one layout `layoutId` may load. */
export function allowedBackgroundUrl(url: unknown, layoutId: string): boolean {
  return url === undefined || url === null || url === '' || url === backgroundImageUrl(layoutId);
}

/** The `backgroundImage.url` a sidecar value carries (undefined: none). */
function urlOf(sidecar: unknown): unknown {
  if (!sidecar || typeof sidecar !== 'object' || Array.isArray(sidecar) || sidecar instanceof Y.AbstractType) return undefined;
  const bg = (sidecar as Record<string, unknown>).backgroundImage;
  if (!bg || typeof bg !== 'object' || Array.isArray(bg)) return undefined;
  return (bg as Record<string, unknown>).url;
}

/** The background address a document's sidecar holds now (undefined: none). */
export function docBackgroundUrl(doc: Y.Doc): unknown {
  return urlOf(readSidecarCache(doc));
}

/**
 * Null when `update` leaves the layout's background picture at an address
 * it may load (or where it already was); else why not, for the log. Every
 * plain value the update writes and keeps is looked at: only one of them
 * can end up as `meta.cache`, and a value elsewhere that looks like a
 * sidecar with a foreign address is no edit either app makes.
 */
export function backgroundUrlProblem(doc: Y.Doc | null, layoutId: string, decoded: DecodedUpdate): string | null {
  return problemIn(decoded, layoutId, () => (doc ? docBackgroundUrl(doc) : undefined));
}

/** backgroundUrlProblem, with the address the layout had before read only when needed. */
function problemIn(decoded: DecodedUpdate, layoutId: string, before: () => unknown): string | null {
  let was: unknown;
  let wasRead = false;
  for (const s of decoded.structs) {
    if (!(s instanceof Y.Item)) continue;
    const c = s.content;
    let values: unknown[];
    if (c instanceof Y.ContentAny) values = c.arr;
    else if (c instanceof Y.ContentEmbed) values = [c.embed];
    else continue;
    for (let j = 0; j < values.length; j++) {
      const url = urlOf(values[j]);
      if (allowedBackgroundUrl(url, layoutId)) continue;
      // A value the update itself deletes never becomes the sidecar.
      const clock = s.id.clock + j;
      if ((decoded.ds.clients.get(s.id.client) ?? []).some((r) => r.clock <= clock && clock < r.clock + r.len)) continue;
      if (!wasRead) {
        was = before();
        wasRead = true;
      }
      if (url === was) continue;
      return "it points the background image at an address other than this layout's own";
    }
  }
  return null;
}

/**
 * The same for a whole document that replaces a stored one (a snapshot
 * PUT): `stored` gives the stored document, read only when the new one
 * holds an address it may not load.
 */
export async function snapshotBackgroundProblem(bytes: Uint8Array, id: string, stored: () => Promise<Uint8Array | null>): Promise<string | null> {
  const decoded = decodeIncoming(bytes);
  // Unreadable: the update guard refuses it on its own.
  if (!decoded || problemIn(decoded, id, () => undefined) === null) return null;
  const was = await stored();
  let url: unknown;
  if (was) {
    const doc = decodeDoc(was);
    try {
      url = docBackgroundUrl(doc);
    } finally {
      doc.destroy();
    }
  }
  return problemIn(decoded, id, () => url);
}

/**
 * For a sidecar as JSON (a new layout's): drop a background address it
 * may not load, keeping the rest. Returns whether it dropped one.
 */
export function dropForeignBackgroundUrl(raw: Record<string, unknown>, layoutId: string): boolean {
  const bg = raw.backgroundImage;
  if (!bg || typeof bg !== 'object' || Array.isArray(bg)) return false;
  const o = bg as Record<string, unknown>;
  if (allowedBackgroundUrl(o.url, layoutId)) return false;
  delete o.url;
  return true;
}
