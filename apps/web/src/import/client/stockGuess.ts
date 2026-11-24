// The truck guess for an imported model (trains design 3.3, Phase 6): its
// parts seen from above, in the frame the picture is drawn in (x, y = -LDraw
// z, LDD's own axes y = z; 20 LDU a stud), its footprint and the picture's
// middle. The desktop's ImportPipeline does the same (stockGuessFor).

import { guessStock, type StockGuess } from '@cld/parts-catalog/browser';
import type { LDrawReadResult } from './ldrawReader';
import type { Rect } from './rasterize';

const LDU_PER_STUD = 20;

/** The model's parts from above, studs. */
export function topDownRefs(read: Pick<LDrawReadResult, 'parts' | 'lddAxes'>): { id: string; x: number; y: number }[] {
  return read.parts.map((p) => ({ id: p.filename, x: p.x / LDU_PER_STUD, y: (read.lddAxes ? p.z : -p.z) / LDU_PER_STUD }));
}

/** The guess for a model drawn as `spriteStuds`, its mesh `bounds` (studs, the same frame). */
export function stockGuessFor(read: Pick<LDrawReadResult, 'parts' | 'lddAxes'>, bounds: Rect, spriteStuds: Rect): StockGuess {
  return guessStock(topDownRefs(read), bounds, { x: spriteStuds.x + spriteStuds.width / 2, y: spriteStuds.y + spriteStuds.height / 2 });
}
