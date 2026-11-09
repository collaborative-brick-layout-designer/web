// The page's own copy of a layout as a file or a new layout: what Save
// offers while offline, and what a refused copy (refusedCopies.ts) is kept
// as. Built from the local doc, not from the server.

import type * as Y from 'yjs';
import { writeBbm, writeSidecar } from '@cld/bbm';
import { docToBbm, readSidecarFromDoc } from '@cld/ydoc';
import type { PartWire } from '../api';
import { layoutFileDownload, layoutSourceHere, type LayoutImage } from '../layoutFile';
import { layoutPartFiles } from '../layoutParts';
import { noticeDownloaded } from './editorStore';
import { sameOriginImageUrl } from './background';

export function saveFile(file: { filename: string; type: string; data: Uint8Array }): void {
  const url = URL.createObjectURL(new Blob([file.data as BlobPart], { type: file.type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file.filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  noticeDownloaded(file.filename);
}

/** The local doc as .bbm text, sidecar text and background image. */
export async function localLayoutContents(doc: Y.Doc): Promise<{
  map: ReturnType<typeof docToBbm>;
  bbm: string;
  sidecar: string | null;
  background?: LayoutImage;
}> {
  const map = docToBbm(doc);
  const sidecar = readSidecarFromDoc(doc);
  let background: LayoutImage | undefined;
  // Only from this site, as the editor loads it (background.ts).
  const bgUrl = sameOriginImageUrl(sidecar?.backgroundImage?.url);
  if (bgUrl) {
    const res = await fetch(bgUrl, { credentials: 'include' });
    if (!res.ok) throw new Error(`the background image could not be fetched (${res.status})`);
    background = { type: res.headers.get('Content-Type') ?? '', data: new Uint8Array(await res.arrayBuffer()) };
  }
  return { map, bbm: writeBbm(map), sidecar: sidecar ? writeSidecar(sidecar) : null, ...(background ? { background } : {}) };
}

/**
 * Serialise the local doc as a .bld-layout (desktop's own save format)
 * and download it: the whole layout in one file, background image
 * included. Resolves whether it was downloaded.
 */
export async function downloadLocalLayout(
  doc: Y.Doc,
  layoutId: string,
  title: string,
  parts: readonly PartWire[] | undefined,
): Promise<boolean> {
  try {
    const { map, bbm, sidecar, background } = await localLayoutContents(doc);
    // The custom parts it uses travel with it.
    const partFiles = parts ? await layoutPartFiles(map, parts) : {};
    saveFile(
      await layoutFileDownload(title, {
        bbm,
        sidecar,
        ...(background ? { background } : {}),
        parts: partFiles,
        // Every web layout is on this server: the file says which one.
        source: layoutSourceHere(layoutId, title),
      }),
    );
    return true;
  } catch (e) {
    window.alert(`Could not build the layout file: ${(e as Error).message}`);
    return false;
  }
}
