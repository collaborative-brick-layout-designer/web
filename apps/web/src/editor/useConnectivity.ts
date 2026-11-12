// Debounced connectivity recompute. Listens to doc updates, waits for the
// drag/edit to settle, then runs the O(N) bucketing algorithm.
//
// Triggers: our own edits (LOCAL_ORIGIN) and our own undo/redo (origin is
// the Y.UndoManager). Remote updates are ignored — the collaborator who
// made the edit recomputes on their side and the result syncs over.
//
// Connectivity is a *derived* projection of the bricks (PLAN.md §3.2). The
// recompute mutates `Brick.connexions[i].linkedTo` on a throwaway
// projection and writes only the changed values back into Yjs under
// CONNECTIVITY_ORIGIN. That origin is deliberately NOT tracked by the
// UndoManager: the write-back lands ~250ms after the edit (after the
// undo capture window closes), so tracking it produced a separate undo
// step and the first Ctrl+Z after a move appeared to do nothing. Links
// are instead re-derived after undo/redo, at once (not debounced), so the
// restored parts are never drawn, or clicked, with the undone edit's links.
//
// Before connectivity, the first pass (and every remote update, including
// the initial sync) repairs stale brick boxes: earlier builds kept a
// brick's displayArea size when turning or placing it, which BlueBrick
// shows shifted. Like desktop fixStaleAreas on every load, such boxes are
// resized to the part's footprint, keeping the sprite where it was drawn.

import { useEffect, useMemo } from 'react';
import * as Y from 'yjs';
import { rebuildConnectivity, type Catalog } from '@cld/parts-catalog/browser';
import { docToBbm } from '@cld/ydoc';
import { LOCAL_ORIGIN } from './useLayoutDoc';
import type { PartWire } from '../api';
import { catalogFromParts } from './catalogFromParts';

export { catalogFromParts };
import type { RectangleF } from '@cld/model';
import { staleAreaFix } from './brickGeometry';
import { indexParts } from './partIndex';

const DEBOUNCE_MS = 250;

/**
 * Origin of the connectivity write-back transaction. Not in the
 * UndoManager's trackedOrigins, so links never form their own undo step.
 */
export const CONNECTIVITY_ORIGIN = Symbol('cld-connectivity-origin');

export function useConnectivity(doc: Y.Doc | null, parts: PartWire[] | undefined): void {
  const partIndex = useMemo(() => indexParts(parts), [parts]);
  const catalog: Catalog = useMemo(() => catalogFromParts(parts), [parts]);

  useEffect(() => {
    if (!doc) return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function schedule() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(runRecompute, DEBOUNCE_MS);
    }

    function runRecompute() {
      if (!doc) return;
      // (A look through every part: what someone else changed is in it.)
      changes.take();
      if (partIndex.size > 0) fixStaleAreasInDoc(doc, partIndex);
      recomputeConnectivity(doc, catalog);
    }

    // Someone else's edits: only the parts they changed are looked at (it
    // looked through every part after each one: about 34 ms on 7,520 parts
    // at 4x slowed CPU). The first look, at the first sync, is of them all.
    const changes = watchPartChanges(doc);
    let staleTimer: ReturnType<typeof setTimeout> | null = null;
    function scheduleStaleFix() {
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        const only = changes.take();
        if (doc && partIndex.size > 0) fixStaleAreasInDoc(doc, partIndex, only);
      }, DEBOUNCE_MS);
    }

    function onUpdate(_u: Uint8Array, origin: unknown) {
      if (origin === CONNECTIVITY_ORIGIN) return;
      if (origin instanceof Y.UndoManager) {
        // An undo or redo puts the parts back at once, so their links come
        // back with them, before anything draws or is clicked: a debounced
        // recompute left the moves' links in place for a while (longer on
        // a busy phone), so the bend handle of a joint a flex move had
        // opened stayed in the middle of the restored run and caught the
        // double-click meant for a part.
        if (timer) clearTimeout(timer);
        timer = null;
        runRecompute();
        return;
      }
      if (origin !== LOCAL_ORIGIN) {
        scheduleStaleFix();
        return;
      }
      schedule();
    }

    doc.on('update', onUpdate);
    // Run once on mount (or when catalog becomes available) so that bricks
    // already in the doc get their connexions populated without needing to
    // trigger a mutation first.
    schedule();
    return () => {
      doc.off('update', onUpdate);
      changes.stop();
      if (timer) clearTimeout(timer);
      if (staleTimer) clearTimeout(staleTimer);
    };
  }, [doc, catalog, partIndex]);
}

/**
 * Recompute connectivity for the whole doc and write changed links back
 * under CONNECTIVITY_ORIGIN. Exported for tests.
 */
export function recomputeConnectivity(doc: Y.Doc, catalog: Catalog): void {
  if (catalog.size === 0) return;
  try {
    const map = docToBbm(doc);
    rebuildConnectivity(map, catalog);
    // The mutate-in-place result needs to be projected back. The
    // simplest faithful path is to re-seed the doc; the smaller path
    // is to write only the changed `linkedTo` values directly. We
    // take the small path because re-seeding loses Yjs identity (and
    // therefore breaks UndoManager's stack).
    doc.transact(() => writeBackConnexions(doc, map), CONNECTIVITY_ORIGIN);
  } catch {
    // Transient parse failures (e.g. mid-import) are fine — we'll
    // try again on the next mutation.
  }
}

/**
 * Mirror updated `connexions[].linkedTo` and `activeConnectionPointIndex`
 * back into the Yjs structure.
 * Only writes when the value actually changed. Bricks are resolved via a
 * per-layer id index built once (a linear scan per brick was O(n^2):
 * ~8 s at 5k bricks).
 */
function writeBackConnexions(doc: Y.Doc, map: import('@cld/model').BbmMap): void {
  const layerData = doc.getMap('layerData');
  for (const layer of map.layers) {
    if (layer.type !== 'brick') continue;
    const yLayer = layerData.get(layer.id);
    if (!(yLayer instanceof Y.Map)) continue;
    const yBricks = yLayer.get('bricks');
    if (!(yBricks instanceof Y.Array)) continue;
    const byId = new Map<unknown, Y.Map<unknown>>();
    yBricks.forEach((b) => {
      // First occurrence wins, matching the old linear scan.
      if (b instanceof Y.Map && !byId.has(b.get('id'))) byId.set(b.get('id'), b);
    });
    for (const brick of layer.bricks) {
      const yBrick = byId.get(brick.id);
      if (!yBrick) continue;
      // The active connection moves when a link is made or broken
      // (BlueBrick's hand-over, rebuildConnectivity).
      if ((yBrick.get('activeConnectionPointIndex') ?? 0) !== brick.activeConnectionPointIndex) {
        yBrick.set('activeConnectionPointIndex', brick.activeConnectionPointIndex);
      }
      const current = (yBrick.get('connexions') ?? []) as { id: string; linkedTo: string }[];
      const next = brick.connexions;
      // Cheap deep-equal: same length, ids AND linkedTo strings.
      if (
        current.length === next.length &&
        current.every((c, i) => c.id === next[i]?.id && c.linkedTo === next[i]?.linkedTo)
      ) {
        continue;
      }
      yBrick.set('connexions', next.map((c) => ({ id: c.id, linkedTo: c.linkedTo })));
    }
  }
}

/** The parts changed since the last `take`: null when it's all of them (or not known). */
export interface PartChanges {
  bricks: Set<Y.Map<unknown>>;
}

/**
 * Follows which parts the doc's transactions change: a part's own fields,
 * or parts added to a sheet. A change to the
 * sheets themselves, or a sheet given a new list, is a change to all.
 * `take` gives what changed since the last one (null: all of them, as
 * the first time) and starts again.
 */
export function watchPartChanges(doc: Y.Doc): { take: () => PartChanges | null; stop: () => void } {
  let all = true;
  let bricks = new Set<Y.Map<unknown>>();
  const layerData: unknown = doc.getMap('layerData');
  const layers: unknown = doc.getArray('layers');
  const onTransaction = (tr: Y.Transaction) => {
    if (all) return;
    for (const [type, keys] of tr.changed) {
      if (type === layerData || type === layers) {
        all = true;
        return;
      }
      const item = type._item;
      if (!item) continue;
      if (type instanceof Y.Array) {
        // Parts added to a sheet: the entries made in this transaction.
        if (item.parentSub !== 'bricks') continue;
        for (let n = type._start; n; n = n.right) {
          if (n.deleted || n.id.clock < (tr.beforeState.get(n.id.client) ?? 0)) continue;
          for (const c of n.content.getContent()) if (c instanceof Y.Map) bricks.add(c as Y.Map<unknown>);
        }
        continue;
      }
      if (!(type instanceof Y.Map)) continue;
      if (item.parent === layerData) {
        if (keys.has('bricks')) {
          all = true;
          return;
        }
        continue;
      }
      const list = item.parent;
      if (list instanceof Y.Array && list._item?.parentSub === 'bricks') bricks.add(type as Y.Map<unknown>);
    }
  };
  doc.on('afterTransaction', onTransaction);
  return {
    take: () => {
      const out = all ? null : { bricks };
      all = false;
      bricks = new Set();
      return out;
    },
    stop: () => doc.off('afterTransaction', onTransaction),
  };
}

/**
 * Resize every brick whose displayArea doesn't match its part's footprint
 * (desktop fixStaleAreas), writing under CONNECTIVITY_ORIGIN so it is not
 * an undo step. With `only`, just the parts changed there are looked at.
 * Returns how many bricks changed. Exported for tests.
 */
export function fixStaleAreasInDoc(doc: Y.Doc, partIndex: ReadonlyMap<string, PartWire>, only: PartChanges | null = null): number {
  const fixes: Array<[Y.Map<unknown>, RectangleF]> = [];
  const look = (b: unknown) => {
    if (!(b instanceof Y.Map)) return;
    const partNumber = b.get('partNumber');
    const displayArea = b.get('displayArea') as RectangleF | undefined;
    if (typeof partNumber !== 'string' || !displayArea) return;
    const orientation = (b.get('orientation') as number) ?? 0;
    const fixed = staleAreaFix({ displayArea, orientation }, partIndex.get(partNumber.toLowerCase()));
    if (fixed) fixes.push([b, fixed]);
  };
  if (only) {
    for (const b of only.bricks) if (!b._item?.deleted) look(b);
  } else {
    doc.getMap('layerData').forEach((layer) => {
      if (!(layer instanceof Y.Map)) return;
      const bricks = layer.get('bricks');
      if (!(bricks instanceof Y.Array)) return;
      bricks.forEach(look);
    });
  }
  if (fixes.length > 0) {
    doc.transact(() => {
      for (const [b, area] of fixes) b.set('displayArea', area);
    }, CONNECTIVITY_ORIGIN);
  }
  return fixes.length;
}

