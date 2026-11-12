// Which part pictures a layout needs: one URL per distinct part on its
// visible brick layers, so the loading card knows the full total up front.

import type { BbmMap, Brick } from '@cld/model';
import { spriteUrlFor, type PartWire } from '../../api';

function urlOf(b: Brick, partsByKey: Map<string, PartWire>): string {
  const meta = partsByKey.get(b.partNumber.toLowerCase());
  return meta ? spriteUrlFor(meta) : '';
}

export function layoutSpriteUrls(map: BbmMap, partsByKey: Map<string, PartWire>): Set<string> {
  const urls = new Set<string>();
  for (const l of map.layers) {
    if (l.type !== 'brick' || !l.visible) continue;
    for (const b of l.bricks) {
      const url = urlOf(b, partsByKey);
      if (url) urls.add(url);
    }
  }
  return urls;
}

/** One sheet's pictures as last counted: its parts then, and how many of them use each picture. */
interface SheetCount {
  bricks: readonly Brick[];
  uses: Map<string, number>;
}

/**
 * `layoutSpriteUrls`, kept up to date between calls: a sheet whose parts
 * are the same objects as last time, in the same places, isn't gone
 * through again, and in a sheet with as many parts as before only the
 * parts that aren't the same objects are (each is a new object after a
 * change: useDocMap). Going through every part after each change took
 * about 6 ms of it on 7,520 parts at 4x slowed CPU.
 */
export function layoutSpriteUrlsKept(): (map: BbmMap, partsByKey: Map<string, PartWire>) => Set<string> {
  let parts: Map<string, PartWire> | null = null;
  let sheets = new Map<string, SheetCount>();
  return (map, partsByKey) => {
    if (partsByKey !== parts) {
      parts = partsByKey;
      sheets = new Map();
    }
    const next = new Map<string, SheetCount>();
    const urls = new Set<string>();
    for (const l of map.layers) {
      if (l.type !== 'brick' || !l.visible) continue;
      let sheet = sheets.get(l.id);
      if (!sheet || sheet.bricks.length !== l.bricks.length) {
        const uses = new Map<string, number>();
        for (const b of l.bricks) {
          const url = urlOf(b, partsByKey);
          if (url) uses.set(url, (uses.get(url) ?? 0) + 1);
        }
        sheet = { bricks: l.bricks, uses };
      } else if (sheet.bricks !== l.bricks) {
        const uses = sheet.uses;
        for (let i = 0; i < l.bricks.length; i++) {
          const was = sheet.bricks[i]!;
          const now = l.bricks[i]!;
          if (was === now) continue;
          const a = urlOf(was, partsByKey);
          const b = urlOf(now, partsByKey);
          if (a === b) continue;
          if (a) {
            const n = uses.get(a)! - 1;
            if (n > 0) uses.set(a, n);
            else uses.delete(a);
          }
          if (b) uses.set(b, (uses.get(b) ?? 0) + 1);
        }
        sheet = { bricks: l.bricks, uses };
      }
      next.set(l.id, sheet);
      for (const url of sheet.uses.keys()) urls.add(url);
    }
    sheets = next;
    return urls;
  };
}
