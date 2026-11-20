// An .ldr / .mpd's parts placed one by one, as the desktop's File › Open
// places them (the converter's readLDrawMap + writeBbm): the shared map
// reader (@cld/parts-catalog's readLDrawMap, checked against vanilla
// BlueBrick) and .bbm writer.

import type { BbmMap } from '@cld/model';
import { writeBbm } from '@cld/bbm/browser';
import { readLDrawMap, type MapLibrary } from '@cld/parts-catalog/browser';

export interface LayoutSummary {
  sheets: number;
  bricks: number;
  warnings: string[];
  partlyRead: boolean;
}

export function isLayoutFile(name: string): boolean {
  return /\.(ldr|mpd)$/i.test(name);
}

export function readLayout(name: string, text: string, lib: MapLibrary): { map: BbmMap; summary: LayoutSummary } {
  const read = readLDrawMap(text, lib, { mpd: /\.mpd$/i.test(name) });
  let sheets = 0;
  let bricks = 0;
  for (const l of read.map.layers) {
    if (l.type !== 'brick') continue;
    sheets++;
    bricks += l.bricks.length;
  }
  return { map: read.map, summary: { sheets, bricks, warnings: read.warnings, partlyRead: false } };
}

export function layoutBbm(map: BbmMap): string {
  return writeBbm(map);
}
