// Replacing a placed module's parts with another version's: the one step
// behind "Update", "Go back to version N" and "Put back the owner's
// version". The server runs it for live layouts (one writer, so two people
// pressing Update at once can't double the parts); the web runs it for a
// layout that isn't on a server.

import * as Y from 'yjs';
import type { Group } from '@cld/model';
import type { SidecarModule } from '@cld/bbm';
import { hasZOrder, itemsInOrder, makeId, pushOnTop, readSidecarCache, reorderByZ, stampKeepIds, writeSidecarCache } from '@cld/ydoc';
import type { BatchBrick, ModuleBatch } from './batches.js';
import type { PartLookup } from './geometry.js';
import { planKeep, versionKey, type PlanSheet } from './keepIds.js';

/** `id` and its parents, innermost first (cycles and dangling ids stop it). */
export function groupChain(groups: readonly Group[] | undefined, id: string | undefined): Group[] {
  if (!groups || groups.length === 0 || !id) return [];
  const byId = new Map(groups.map((g) => [g.id, g]));
  const chain: Group[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = id;
  while (cur && !seen.has(cur) && chain.length < 64) {
    const g = byId.get(cur);
    if (!g) break;
    seen.add(cur);
    chain.push(g);
    cur = g.myGroup;
  }
  return chain;
}

/**
 * Copies of `source`'s groups above `bricks` (copies still naming the old
 * groups) under fresh ids; returns the bricks moved to the new ids.
 */
export function cloneGroups<T extends { myGroup?: string }>(
  source: readonly Group[],
  bricks: readonly T[],
  newId: () => string,
): { bricks: T[]; groups: Group[] } {
  const renamed = new Map<string, string>();
  const groups: Group[] = [];
  const out = bricks.map((b) => {
    const chain = groupChain(source, b.myGroup);
    for (const g of chain) {
      if (renamed.has(g.id)) continue;
      renamed.set(g.id, newId());
      groups.push({ ...g, id: renamed.get(g.id)! });
    }
    return { ...b, myGroup: chain.length > 0 ? renamed.get(chain[0]!.id)! : '' };
  });
  for (const g of groups) g.myGroup = (g.myGroup && renamed.get(g.myGroup)) || '';
  return { bricks: out, groups };
}

/** A new part entry for the layout doc. */
export function brickEntry(b: BatchBrick, id: string): Y.Map<unknown> {
  const y = new Y.Map<unknown>();
  y.set('id', id);
  y.set('displayArea', { x: b.displayArea.x, y: b.displayArea.y, width: b.displayArea.width, height: b.displayArea.height });
  y.set('myGroup', b.myGroup ?? '');
  y.set('partNumber', b.partNumber);
  y.set('orientation', b.orientation ?? 0);
  y.set('activeConnectionPointIndex', 0);
  y.set('altitude', b.altitude ?? 0);
  y.set('connexions', []);
  return y;
}

/** Put parts (and the groups they name) on top of a parts sheet; returns the new part ids. Call inside a transaction. */
export function appendBricks(doc: Y.Doc, layerId: string, bricks: readonly BatchBrick[], groups: readonly Group[] = []): string[] {
  const layerData = doc.getMap('layerData').get(layerId);
  if (!(layerData instanceof Y.Map)) return [];
  const yBricks = layerData.get('bricks');
  if (!(yBricks instanceof Y.Array)) return [];
  const ids: string[] = [];
  const added = bricks.map((b) => {
    const id = makeId();
    ids.push(id);
    return brickEntry(b, id);
  });
  if (added.length > 0) pushOnTop(yBricks, added);
  const yGroups = layerData.get('groups');
  if (groups.length > 0 && yGroups instanceof Y.Array) {
    for (const g of groups) {
      const yGroup = new Y.Map<unknown>();
      yGroup.set('id', g.id);
      if (g.partNumber !== undefined) yGroup.set('partNumber', g.partNumber);
      yGroup.set('myGroup', g.myGroup ?? '');
      yGroups.push([yGroup]);
    }
  }
  return ids;
}

function sidecarModules(cache: Record<string, unknown> | null): SidecarModule[] {
  return Array.isArray(cache?.modules) ? (cache.modules as SidecarModule[]) : [];
}

/**
 * Replace a placed module's parts with `batches` (already where they go on
 * the map), keeping its id, name and look: its old parts are deleted from
 * every sheet (and the sets that only they were in), each batch goes on
 * the sheet `sheetFor` names, and the module then holds exactly the new
 * parts, with `patch` applied to its sidecar value. One transaction with
 * `origin`. Returns the new part ids, or null when the module isn't in
 * the layout (nothing is changed then).
 */
export function replaceModuleParts(
  doc: Y.Doc,
  moduleId: string,
  batches: readonly ModuleBatch[],
  sheetFor: (sheetName: string) => string,
  patch: Partial<SidecarModule> | ((m: SidecarModule) => SidecarModule) = {},
  origin?: unknown,
): string[] | null {
  const mod = sidecarModules(readSidecarCache(doc)).find((m) => m.id === moduleId);
  if (!mod) return null;
  const old = new Set(mod.members);
  const ids: string[] = [];
  doc.transact(() => {
    const layerData = doc.getMap('layerData');
    for (const layerId of doc.getArray<string>('layers').toArray()) {
      const l = layerData.get(layerId);
      if (!(l instanceof Y.Map)) continue;
      const bricks = l.get('bricks');
      if (!(bricks instanceof Y.Array)) continue;
      const freed = new Set<string>();
      for (let i = bricks.length - 1; i >= 0; i--) {
        const b = bricks.get(i);
        if (!(b instanceof Y.Map) || !old.has(b.get('id') as string)) continue;
        const g = b.get('myGroup');
        if (typeof g === 'string' && g) freed.add(g);
        bricks.delete(i, 1);
      }
      if (freed.size > 0) dropEmptyGroups(l, freed);
    }
    for (const batch of batches) {
      if (batch.bricks.length === 0) continue;
      const copied = cloneGroups(batch.groups ?? [], batch.bricks, makeId);
      ids.push(...appendBricks(doc, sheetFor(batch.layerName || 'Module'), copied.bricks, copied.groups));
    }
    const cache = readSidecarCache(doc) ?? {};
    writeSidecarCache(doc, {
      ...cache,
      modules: sidecarModules(cache).map((m) => {
        if (m.id !== moduleId) return m;
        const next = typeof patch === 'function' ? patch(m) : { ...m, ...patch };
        return { ...next, id: m.id, members: ids };
      }),
    });
  }, origin);
  return ids;
}

/**
 * Delete the groups a sheet no longer needs after parts left it: those in
 * `freed` (the groups the removed parts were in), and their parents, that
 * no part or other group is in any more.
 */
function dropEmptyGroups(layer: Y.Map<unknown>, freed: ReadonlySet<string>): void {
  const yGroups = layer.get('groups');
  const yBricks = layer.get('bricks');
  if (!(yGroups instanceof Y.Array) || !(yBricks instanceof Y.Array)) return;
  const parentOf = new Map<string, string>();
  for (const g of yGroups) if (g instanceof Y.Map) parentOf.set(g.get('id') as string, (g.get('myGroup') as string | undefined) ?? '');
  // Every group a removed part was under, up the chain.
  const candidates = new Set<string>();
  for (const id of freed) {
    let cur = id;
    for (let n = 0; cur && parentOf.has(cur) && !candidates.has(cur) && n < 64; n++) {
      candidates.add(cur);
      cur = parentOf.get(cur) ?? '';
    }
  }
  if (candidates.size === 0) return;
  // Every group something is still in: a part's, and up from there.
  const inUse = new Set<string>();
  const mark = (id: unknown): void => {
    let cur = typeof id === 'string' ? id : '';
    for (let n = 0; cur && !inUse.has(cur) && n < 64; n++) {
      inUse.add(cur);
      cur = parentOf.get(cur) ?? '';
    }
  };
  for (const b of yBricks) if (b instanceof Y.Map) mark(b.get('myGroup'));
  for (let i = yGroups.length - 1; i >= 0; i--) {
    const g = yGroups.get(i);
    if (!(g instanceof Y.Map)) continue;
    const id = g.get('id') as string;
    if (candidates.has(id) && !inUse.has(id)) yGroups.delete(i, 1);
  }
}

/** The layout's parts sheets, in layer order, as planKeep reads them (each bottom to top, with its sets). */
export function planSheets(doc: Y.Doc): PlanSheet[] {
  const out: PlanSheet[] = [];
  const layerData = doc.getMap('layerData');
  for (const layerId of doc.getArray<string>('layers').toArray()) {
    const l = layerData.get(layerId);
    if (!(l instanceof Y.Map)) continue;
    const bricks = l.get('bricks');
    if (!(bricks instanceof Y.Array)) continue;
    const yGroups = l.get('groups');
    const groups: Group[] = [];
    if (yGroups instanceof Y.Array) {
      for (const g of yGroups) {
        if (!(g instanceof Y.Map) || typeof g.get('id') !== 'string') continue;
        groups.push({ id: g.get('id') as string, ...(typeof g.get('partNumber') === 'string' ? { partNumber: g.get('partNumber') as string } : {}), myGroup: (g.get('myGroup') as string | undefined) ?? '' });
      }
    }
    const parts = itemsInOrder(bricks)
      .filter((b): b is Y.Map<unknown> => b instanceof Y.Map && typeof b.get('id') === 'string')
      .map((b) => {
        const a = (b.get('displayArea') as { x: number; y: number; width: number; height: number } | undefined) ?? { x: 0, y: 0, width: 0, height: 0 };
        return {
          id: b.get('id') as string,
          partNumber: typeof b.get('partNumber') === 'string' ? (b.get('partNumber') as string) : '',
          displayArea: { x: a.x, y: a.y, width: a.width, height: a.height },
          orientation: typeof b.get('orientation') === 'number' ? (b.get('orientation') as number) : 0,
          altitude: typeof b.get('altitude') === 'number' ? (b.get('altitude') as number) : 0,
          myGroup: typeof b.get('myGroup') === 'string' ? (b.get('myGroup') as string) : '',
        };
      });
    out.push({ id: layerId, parts, groups });
  }
  return out;
}

/**
 * Put `batches` (another version, already where it goes) in place of a
 * placed module's parts, keeping the parts that didn't change (keepIds.ts):
 * those not matched go, the version's parts not matched come in new, each
 * in its place in the drawing order, and the matched ones aren't touched.
 * The module keeps its id, name and look, holds the version's parts in its
 * order, and gets `patch`. One transaction with `origin`, after the doc is
 * stamped shape 5 (stampKeepIds) in its own, so builds that can't finish
 * an undo across it stop writing before it arrives. Returns the module's
 * parts, or null when it isn't in the layout.
 */
export function updateModuleParts(
  doc: Y.Doc,
  moduleId: string,
  batches: readonly ModuleBatch[],
  sheetFor: (sheetName: string) => string,
  partOf: PartLookup,
  patch: Partial<SidecarModule> | ((m: SidecarModule) => SidecarModule) = {},
  origin?: unknown,
): { members: string[]; kept: number; added: number; removed: number } | null {
  const mod = sidecarModules(readSidecarCache(doc)).find((m) => m.id === moduleId);
  if (!mod) return null;
  const next = batches.map((b) => ({ sheetId: sheetFor(b.layerName || 'Module'), bricks: b.bricks, groups: b.groups ?? [] }));
  const plan = planKeep(planSheets(doc), new Set(mod.members), next, partOf);
  const members: string[] = [];
  stampKeepIds(doc);
  doc.transact(() => {
    const layerData = doc.getMap('layerData');
    const gone = new Set(plan.removed);
    for (const layerId of doc.getArray<string>('layers').toArray()) {
      const l = layerData.get(layerId);
      if (!(l instanceof Y.Map)) continue;
      const bricks = l.get('bricks');
      if (!(bricks instanceof Y.Array)) continue;
      const freed = new Set<string>();
      for (let i = bricks.length - 1; i >= 0; i--) {
        const b = bricks.get(i);
        if (!(b instanceof Y.Map) || !gone.has(b.get('id') as string)) continue;
        const g = b.get('myGroup');
        if (typeof g === 'string' && g) freed.add(g);
        bricks.delete(i, 1);
      }
      if (freed.size > 0) dropEmptyGroups(l, freed);
    }
    // The new parts, each with its id and its sets (the kept parts' sets where they share them, else new copies).
    const fresh = new Map<string, Y.Map<unknown>>();
    const freshIds = new Map<string, string>();
    const made = new Map<string, string>();
    const setFor = (key: string, sheetId: string): string => {
      const chain = plan.newGroups.get(key) ?? [];
      let parent = '';
      // Outermost first, so each set's parent is there before it.
      for (let k = chain.length - 1; k >= 0; k--) {
        const token = chain[k]!;
        if (!token.startsWith('new:')) {
          parent = token;
          continue;
        }
        let id = made.get(token);
        if (id === undefined) {
          id = makeId();
          made.set(token, id);
          const [b, gid] = token.slice(4).split('/') as [string, string];
          const g = next[Number(b)]!.groups.find((x) => x.id === gid);
          const yGroups = (layerData.get(sheetId) as Y.Map<unknown> | undefined)?.get('groups');
          if (yGroups instanceof Y.Array) {
            const y = new Y.Map<unknown>();
            y.set('id', id);
            if (g?.partNumber !== undefined) y.set('partNumber', g.partNumber);
            y.set('myGroup', parent);
            yGroups.push([y]);
          }
        }
        parent = id;
      }
      return parent;
    };
    next.forEach((batch, b) => {
      batch.bricks.forEach((brick, i) => {
        const key = versionKey(b, i);
        const keptId = plan.kept.get(key);
        if (keptId !== undefined) {
          members.push(keptId);
          return;
        }
        const id = makeId();
        members.push(id);
        fresh.set(`new:${key}`, brickEntry({ ...brick, myGroup: setFor(key, batch.sheetId) }, id));
        freshIds.set(`new:${key}`, id);
      });
    });
    // Each sheet's new parts, where the plan puts them.
    for (const [sheetId, order] of plan.sheets) {
      if (!order.some((t) => fresh.has(t))) continue;
      const bricks = (layerData.get(sheetId) as Y.Map<unknown> | undefined)?.get('bricks');
      if (!(bricks instanceof Y.Array)) continue;
      // (A new entry's fields can't be read until it is in the document: its id from freshIds.)
      const ids = order.map((t) => freshIds.get(t) ?? t);
      if (hasZOrder(bricks)) {
        bricks.push(order.flatMap((t) => (fresh.has(t) ? [fresh.get(t)!] : [])));
        reorderByZ(bricks, ids);
      } else {
        order.forEach((t, at) => {
          const m = fresh.get(t);
          if (m) bricks.insert(Math.min(at, bricks.length), [m]);
        });
      }
    }
    const cache = readSidecarCache(doc) ?? {};
    writeSidecarCache(doc, {
      ...cache,
      modules: sidecarModules(cache).map((m) => {
        if (m.id !== moduleId) return m;
        const out = typeof patch === 'function' ? patch(m) : { ...m, ...patch };
        return { ...out, id: m.id, members };
      }),
    });
  }, origin);
  return { members, kept: plan.kept.size, added: plan.added.length, removed: plan.removed.length };
}
