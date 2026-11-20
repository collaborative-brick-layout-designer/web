// The preview's choices made into the part: the desktop converter's
// convertPart (src/app/importserver/ImportServer.cpp): turn, line up, drop
// the unchecked connection points, then the part's XML and picture.

import { alignPart, finishPreview, rotatePart, webLink } from './align';
import { partXml } from './partXml';
import { traceOutlineStuds } from './pickShape';
import { importedPartKey, suggestedImportName, type PreparedPart } from './prepare';
import type { Image } from './rasterize';

export interface ConvertChoices {
  quarterTurns: number;
  align: '' | 'bottom' | 'box';
  nudge: [number, number];
  drop: number[];
  name: string;
  designer: string;
  designerUrl: string;
  author: string;
}

export interface MadePart {
  partKey: string;
  displayName: string;
  xml: string;
  sprite: Image;
  widthStuds: number;
  heightStuds: number;
  connections: number;
}

const MODEL_EXT = /\.(ldr|dat|mpd|io|lxf|lxfml)$/i;

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function convertPart(
  prepared: PreparedPart,
  choices: ConvertChoices,
  file: { name: string; lastModified: number | null; format: 'ldraw' | 'studio' | 'ldd' },
  date = today(),
): MadePart {
  if (!prepared.sprite) throw new Error(prepared.error || 'Nothing could be imported from this file.');
  const clamp = (v: number) => Math.max(-64, Math.min(64, Number.isFinite(v) ? v : 0));
  const turned = rotatePart(prepared, ((choices.quarterTurns % 4) + 4) % 4);
  const shown = alignPart(turned, choices.align, { x: clamp(choices.nudge[0]), y: clamp(choices.nudge[1]) });
  const result = finishPreview(shown, new Set(choices.drop));
  const designer = choices.designer.trim();
  const designerUrl = webLink(designer, choices.designerUrl);
  const name = choices.name.trim() || suggestedImportName(prepared);
  const shownName = name.replace(MODEL_EXT, '').trim();
  const sprite = result.sprite!;
  const pxPerStud = Math.max(1, Math.round(sprite.width / result.widthStuds));
  const xml = partXml({
    author: choices.author,
    displayName: shownName,
    sourceFile: file.name,
    format: file.format,
    sourceModified: file.lastModified,
    date,
    pxPerStud,
    quarterTurns: result.quarterTurns,
    align: result.align,
    nudge: result.nudgeStuds,
    // As they were before the alignment moved them (Re-import drops them first).
    droppedConnections: result.droppedConnections.map((p) => ({ x: p.x - result.alignShift.x, y: p.y - result.alignShift.y })),
    designer,
    designerUrl,
    connections: result.connections,
    pickShape: traceOutlineStuds(sprite, pxPerStud),
    snapMargin: result.snapMargin,
  });
  return { partKey: importedPartKey(name), displayName: shownName, xml, sprite, widthStuds: result.widthStuds, heightStuds: result.heightStuds, connections: result.connections.length };
}
