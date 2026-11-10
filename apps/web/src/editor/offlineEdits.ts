// Parts changed while offline, and whether someone else's change replaced
// them once the layout was back in step (full review area 4, Unclear UI 3:
// an offline move of a part someone else deleted meanwhile vanished
// without a word).

import * as Y from 'yjs';

/** "2 of your offline changes were replaced by someone else's." */
export function replacedText(n: number, of: number): string {
  if (of === 1) return "Your offline change was replaced by someone else's change to the same part.";
  return `${n} of your ${of} offline changes were replaced by someone else's changes to the same parts.`;
}

export class OfflineEditWatch {
  /** Part id → how this page left it. */
  private readonly touched = new Map<string, string>();

  get size(): number {
    return this.touched.size;
  }

  /** A local change made while not in step: note the parts it changed, as they are now. */
  note(tr: Y.Transaction): void {
    for (const type of tr.changed.keys()) {
      if (!(type instanceof Y.Map) || !(type.parent instanceof Y.Array)) continue;
      const id = type.get('id');
      if (typeof id === 'string') this.touched.set(id, JSON.stringify(type.toJSON()));
    }
  }

  /** In step again: how many of the parts changed offline someone else has since changed or removed. Forgets them. */
  settle(doc: Y.Doc): { replaced: number; of: number } {
    const of = this.touched.size;
    if (of === 0) return { replaced: 0, of: 0 };
    const now = new Map<string, string>();
    doc.getMap('layerData').forEach((layer) => {
      if (!(layer instanceof Y.Map)) return;
      const bricks = layer.get('bricks');
      if (!(bricks instanceof Y.Array)) return;
      bricks.forEach((b) => {
        if (b instanceof Y.Map && this.touched.has(b.get('id') as string)) now.set(b.get('id') as string, JSON.stringify(b.toJSON()));
      });
    });
    let replaced = 0;
    for (const [id, mine] of this.touched) if (now.get(id) !== mine) replaced++;
    this.touched.clear();
    return { replaced, of };
  }
}
