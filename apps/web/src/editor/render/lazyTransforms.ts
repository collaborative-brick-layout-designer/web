// When the view moves (the stage's place changes, at the end of a pan say),
// Konva goes through every node under the stage to mark its cached place
// on screen (its absolute transform) out of date, and tells each one: on
// 7,520 parts that walk was about 35 ms of the pan's end at 4x slowed CPU,
// though a pan's end draws only the few parts the pan brought in.
//
// Under a sheet of parts (a Group marked `partsIndexed`, BrickLayer), that
// walk stops at the sheet: the sheet's own place is marked out of date, and
// a count is bumped. A node under such a sheet checks its kept place when
// it's asked for it: kept from before the last bump, it's worked out again
// (from its parent's, as Konva does). Nodes elsewhere are walked as before.
//
// Nothing in the editor listens for a part's `absoluteTransformChange`
// (Konva tells each node as it walks); a Transformer on a part would.

import Konva from 'konva';

/** Whether sheets of parts stop the walk (tests compare with the walk). */
export const lazyTransforms = { enabled: true, bumps: 0 };

/** Bumped each time a sheet's place changes without its parts being walked. */
let epoch = 0;

type Cached = { dirty?: boolean; __epoch?: number };
type NodeInternals = {
  _cache: Record<string, Cached | undefined>;
  _clearSelfAndDescendantCache: (attr?: string) => void;
  getAbsoluteTransform: (top?: Konva.Node) => Konva.Transform & Cached;
};

let installed = false;

/** Whether a node is inside a sheet of parts (not the sheet itself). */
function underSheet(node: Konva.Node): boolean {
  for (let p = node.parent; p; p = p.parent) if (p.attrs.partsIndexed) return true;
  return false;
}

export function installLazyTransforms(): void {
  if (installed) return;
  installed = true;
  const container = Konva.Container.prototype as unknown as NodeInternals;
  const node = Konva.Node.prototype as unknown as NodeInternals;
  const walk = container._clearSelfAndDescendantCache;
  const own = node._clearSelfAndDescendantCache;
  container._clearSelfAndDescendantCache = function (this: Konva.Container, attr?: string) {
    if (attr === 'absoluteTransform' && this.attrs.partsIndexed && lazyTransforms.enabled) {
      // Its own place, and its own event; its parts check theirs when asked.
      own.call(this, attr);
      epoch++;
      lazyTransforms.bumps++;
      return;
    }
    walk.call(this, attr);
  };
  const get = node.getAbsoluteTransform;
  node.getAbsoluteTransform = function (this: Konva.Node & NodeInternals, top?: Konva.Node) {
    if (top) return get.call(this, top);
    if (epoch !== 0) {
      const kept = this._cache.absoluteTransform;
      if (kept && !kept.dirty && kept.__epoch !== epoch) {
        // Kept from before a sheet's place changed: out of date if it's in a sheet.
        if (underSheet(this)) kept.dirty = true;
        else kept.__epoch = epoch;
      }
    }
    const at = get.call(this, top);
    at.__epoch = epoch;
    return at;
  };
}
