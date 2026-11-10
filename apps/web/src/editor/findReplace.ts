// Find & Replace logic — port of the search / replace passes in desktop
// `FindDialog.cpp`. Pure over a projected `BbmMap`; the replace step
// writes through the regular mutations inside ONE transaction so it is a
// single undo step (desktop wraps it in a "Find & Replace" undo macro,
// FindDialog.cpp:150-189).

import type * as Y from 'yjs';
import type { BbmMap } from '@cld/model';
import type { PartWire } from '../api';
import { editBrick, editTextCell } from './mutations';
import { mapLineWidth } from './render/mapText';
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
  /** A part's name from the library (part hits), when it has one. */
  name?: string;
}

/** The library entry for a part number (catalog key, bare number or old name: partIndex.ts). */
export type PartLookup = ReadonlyMap<string, PartWire>;

/**
 * Every brick (part scope) or text cell (text scope) whose field contains
 * `needle`, in layer order. With the library, a part matches by its name
 * too ("straight" finds 2865.8, "9V Straight Track").
 */
export function findHits(map: BbmMap, needle: string, scope: FindScope, matchCase: boolean, parts?: PartLookup): FindHit[] {
  const n0 = needle.trim();
  if (!n0) return [];
  const cmp = matchCase ? (s: string) => s : (s: string) => s.toLowerCase();
  const n = cmp(n0);
  const out: FindHit[] = [];
  for (const layer of map.layers) {
    if (scope === 'part' && layer.type === 'brick') {
      for (const b of layer.bricks) {
        const name = parts?.get(b.partNumber.toLowerCase())?.description || undefined;
        if (cmp(b.partNumber).includes(n) || (name !== undefined && cmp(name).includes(n))) {
          out.push({
            layerId: layer.id,
            brickId: b.id,
            value: b.partNumber,
            preview: `${name ? `${name} (${b.partNumber})` : b.partNumber}  ·  ${displaySheetName(layer.name)}`,
            ...(name ? { name } : {}),
          });
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
 * What a hit becomes: the matched text replaced inside it, or, for a part
 * found by its name (the number doesn't hold the text), the whole part
 * number. Null when nothing would change.
 */
export function replacedValue(h: FindHit, needle: string, replacement: string, matchCase: boolean): string | null {
  const n = needle.trim();
  if (!n) return null;
  const inValue = matchCase ? h.value.includes(n) : h.value.toLowerCase().includes(n.toLowerCase());
  const next = h.brickId !== undefined && !inValue ? replacement.trim() : replaceInString(h.value, n, replacement, matchCase);
  if (next === h.value) return null;
  if (h.brickId !== undefined && !next.trim()) return null; // never blank a part number
  return next;
}

/** The new part numbers `hits` would get that the library doesn't have (each once). */
export function unknownReplacements(hits: readonly FindHit[], needle: string, replacement: string, matchCase: boolean, parts: PartLookup): string[] {
  const out = new Set<string>();
  for (const h of hits) {
    if (h.brickId === undefined) continue;
    const next = replacedValue(h, needle, replacement, matchCase);
    if (next !== null && !parts.has(next.toLowerCase())) out.add(next);
  }
  return [...out];
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
  if (!needle.trim()) return 0;
  let count = 0;
  doc.transact(() => {
    for (const h of hits) {
      const next = replacedValue(h, needle, replacement, matchCase);
      if (next === null) continue;
      if (h.brickId !== undefined) {
        editBrick(doc, h.layerId, h.brickId, { partNumber: next });
      } else if (h.textIndex !== undefined) {
        editTextCell(doc, h.layerId, h.textIndex, next, mapLineWidth());
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
