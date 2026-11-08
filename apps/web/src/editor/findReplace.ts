// Find & Replace logic — port of the search / replace passes in desktop
// `FindDialog.cpp`. Pure over a projected `BbmMap`; the replace step
// writes through the regular mutations inside ONE transaction so it is a
// single undo step (desktop wraps it in a "Find & Replace" undo macro,
// FindDialog.cpp:150-189).

import type * as Y from 'yjs';
import type { BbmMap } from '@cld/model';
import { editBrick, editTextCell } from './mutations';
import { LOCAL_ORIGIN } from './useLayoutDoc';
import type { AnnoSelection } from './editorStore';
import { textKey } from './mixedSelection';
import { displaySheetName } from './activeSheet';

export type FindScope = 'part' | 'text';

export interface FindHit {
  layerId: string;
  /** Set for part-number hits. */
  brickId?: string;
  /** Set for text-cell hits (text cells have no id; addressed by index). */
  textIndex?: number;
  /** The searched field's current value (part number or cell text). */
  value: string;
  preview: string;
}

/** Every brick (part scope) or text cell (text scope) whose field contains `needle`, in layer order. */
export function findHits(map: BbmMap, needle: string, scope: FindScope, matchCase: boolean): FindHit[] {
  const n0 = needle.trim();
  if (!n0) return [];
  const cmp = matchCase ? (s: string) => s : (s: string) => s.toLowerCase();
  const n = cmp(n0);
  const out: FindHit[] = [];
  for (const layer of map.layers) {
    if (scope === 'part' && layer.type === 'brick') {
      for (const b of layer.bricks) {
        if (cmp(b.partNumber).includes(n)) {
          out.push({ layerId: layer.id, brickId: b.id, value: b.partNumber, preview: `${b.partNumber}  ·  ${displaySheetName(layer.name)}` });
        }
      }
    } else if (scope === 'text' && layer.type === 'text') {
      for (let i = 0; i < layer.textCells.length; i++) {
        const t = layer.textCells[i]!;
        if (cmp(t.text).includes(n)) {
          out.push({ layerId: layer.id, textIndex: i, value: t.text, preview: `"${t.text}"  ·  ${displaySheetName(layer.name)}` });
        }
      }
    }
  }
  return out;
}

/**
 * The canvas selection for a set of hits: matched bricks plus matched
 * text cells (mixed selection). Desktop's search selects every match in
 * the scene as you type (FindDialog.cpp:70-103).
 */
export function hitsSelection(hits: readonly FindHit[]): { bricks: string[]; anno: AnnoSelection } {
  const bricks: string[] = [];
  const texts: string[] = [];
  for (const h of hits) {
    if (h.brickId) bricks.push(h.brickId);
    else if (h.textIndex !== undefined) texts.push(textKey(h.layerId, h.textIndex));
  }
  return { bricks, anno: { rulers: [], labels: [], texts } };
}

/**
 * Replace every occurrence of `needle` in `hay` (Qt `QString::replace`
 * with the chosen case sensitivity). `replacement` is literal — no `$`
 * patterns.
 */
export function replaceInString(hay: string, needle: string, replacement: string, matchCase: boolean): string {
  if (!needle) return hay;
  if (matchCase) return hay.split(needle).join(replacement);
  return hay.replace(new RegExp(escapeRegex(needle), 'gi'), () => replacement);
}

/**
 * Apply the replacement to `hits` in one transaction (one undo step).
 * Part hits rewrite the brick's part number in place, keeping its
 * position and orientation (desktop `EditBrickCommand`); text hits
 * rewrite the cell's text. Returns how many items changed.
 */
export function replaceHits(
  doc: Y.Doc,
  hits: FindHit[],
  needle: string,
  replacement: string,
  matchCase: boolean,
): number {
  const n = needle.trim();
  if (!n) return 0;
  let count = 0;
  doc.transact(() => {
    for (const h of hits) {
      const next = replaceInString(h.value, n, replacement, matchCase);
      if (next === h.value) continue;
      if (h.brickId !== undefined) {
        if (!next.trim()) continue; // never blank a part number
        editBrick(doc, h.layerId, h.brickId, { partNumber: next });
      } else if (h.textIndex !== undefined) {
        editTextCell(doc, h.layerId, h.textIndex, next);
      } else {
        continue;
      }
      count++;
    }
  }, LOCAL_ORIGIN);
  return count;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
