// The browser's model importer, off the page's thread (docs/model-import.md,
// "In the browser"): reads the model, fetches the library files it uses,
// draws it as the desktop's converter does, and makes the part (or the
// layout) when asked. The page cancels by ending the worker.

import { MapLibrary } from '@cld/parts-catalog/browser';
import { catalogFromParts } from '../../editor/catalogFromParts';
import { convertPart } from './convert';
import { isLayoutFile, layoutBbm, readLayout, type LayoutSummary } from './layout';
import { SubfileLoop } from './meshLoader';
import { importedPartKey, suggestedImportName, type PreparedPart } from './prepare';
import { formatOf, prepareModel } from './prepareModel';
import type { FromWorker, ToWorker } from './protocol';
import { toRgba, type Image } from './rasterize';
import { RemoteLibrary } from './remoteSource';

// The worker's own scope (typed by hand: the page's DOM types and the
// worker's can't share one program).
const scope = self as unknown as { postMessage(m: FromWorker): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null; location: Location };

const send = (m: FromWorker) => scope.postMessage(m);

let file: File | null = null;
let text = '';
let prepared: PreparedPart | null = null;
let layout: { map: ReturnType<typeof readLayout>['map']; summary: LayoutSummary } | null = null;

/** A PNG of the picture (the browser's own encoder). */
export async function pngOf(img: Image): Promise<Blob> {
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser can’t draw off screen.');
  ctx.putImageData(new ImageData(toRgba(img), img.width, img.height), 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

async function analyse(msg: Extract<ToWorker, { type: 'analyse' }>) {
  file = msg.file;
  send({ type: 'progress', phase: 'reading' });
  const bytes = new Uint8Array(await msg.file.arrayBuffer());
  text = formatOf(msg.file.name) === 'ldraw' ? new TextDecoder().decode(bytes) : '';
  const parts = new MapLibrary(catalogFromParts(msg.parts));
  const source = new RemoteLibrary(msg.library.name, msg.library.version, scope.location.origin);
  let layoutError: string | null = null;
  if (isLayoutFile(msg.file.name)) {
    try {
      layout = readLayout(msg.file.name, text, parts);
    } catch (e) {
      layoutError = (e as Error).message;
    }
  }
  prepared = await prepareModel(msg.file.name, bytes, {
    source,
    parts,
    onFetch: (p) => send({ type: 'progress', phase: 'fetching', done: p.done, total: p.total }),
    onDraw: () => send({ type: 'progress', phase: 'drawing' }),
  });
  if (prepared.error && !layout) {
    send({ type: 'failed', message: prepared.error, fallback: false });
    return;
  }
  const suggested = suggestedImportName(prepared);
  const p = prepared.sprite && !prepared.error ? prepared : null;
  send({
    type: 'analysed',
    analysis: {
      format: formatOf(msg.file.name),
      kindLabel: prepared.kindLabel,
      title: prepared.title,
      designer: prepared.designer,
      suggestedName: suggested,
      partKey: importedPartKey(suggested),
      partError: p ? null : prepared.error,
      part: p
        ? {
            widthStuds: p.widthStuds,
            heightStuds: p.heightStuds,
            pxPerStud: p.widthStuds > 0 ? Math.trunc(p.sprite!.width / p.widthStuds) : 0,
            contentStuds: p.contentStuds,
            baseOnGrid: p.baseOnGrid,
            snapMargin: p.snapMargin,
            connections: p.connections,
            stats: p.stats,
            warnings: p.warnings,
            preview: await pngOf(p.sprite!),
          }
        : null,
      layout: layout?.summary ?? null,
      layoutError,
    },
  });
}

async function convert(msg: Extract<ToWorker, { type: 'convert' }>) {
  if (msg.mode === 'parts') {
    if (!layout) throw new Error('Only .ldr and .mpd files can be placed as separate parts.');
    send({ type: 'made-layout', bbm: layoutBbm(layout.map), sheets: layout.summary.sheets, bricks: layout.summary.bricks });
    return;
  }
  if (!prepared?.sprite || !file) throw new Error('Nothing could be imported from this file.');
  const made = convertPart(prepared, msg.choices, { name: file.name, lastModified: file.lastModified || null, format: formatOf(file.name) });
  send({ type: 'made-part', partKey: made.partKey, displayName: made.displayName, xml: made.xml, png: await pngOf(made.sprite), widthStuds: made.widthStuds, heightStuds: made.heightStuds, connections: made.connections });
}

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  (msg.type === 'analyse' ? analyse(msg) : convert(msg)).catch((err: unknown) => {
    const loop = err instanceof SubfileLoop;
    // A model problem is the model's; anything else (memory, a missing
    // browser feature, the network) the server may manage.
    send({ type: 'failed', message: (err as Error)?.message ?? String(err), fallback: !loop });
  });
};
