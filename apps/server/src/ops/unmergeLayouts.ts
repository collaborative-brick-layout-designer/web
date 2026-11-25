// Undo layouts that were merged into each other.
//
// An older desktop app kept its Yjs doc when it opened another server
// layout, so the second layout was read into a doc that still held the
// first, and sync sent the first one's content to the second one's room
// (desktop #171 fixes the cause). Opened one after another, layouts can
// end up holding each other's layers, bricks, sidecar and meta.
//
// Yjs item ids (client, clock) are unique to the doc that made them, so the
// same id in two layouts can only come from such a merge. Given each
// layout's current doc and a reference copy from before the merge (a
// backup), every item a layout's reference holds is its own; one only
// another layout's reference holds is foreign. Items made after the
// reference are judged by where they sit: inside an own layer or brick
// they are own (a real edit), at the top level by the layer id, sidecar
// module or label they name.
//
// The repair is surgical: one ordinary Yjs update per layout that deletes
// the foreign items and, where a foreign value won a map key over the
// layout's own (meta.author and the like), sets the own value again from
// the reference. Never a new doc: Yjs deletions are tombstones, so a stale
// client that still holds the merged state can't bring the deleted items
// back, which a wholesale replacement would let it do.

import { createHash } from 'node:crypto';
import * as Y from 'yjs';
import { RECORD_MAPS, repairSidecarCache } from '@cld/ydoc';

export interface UnmergeInput {
  id: string;
  title: string;
  /** The layout's doc now: snapshot plus any pending updates. */
  current: Uint8Array;
  /** Its doc from before the merge (a backup); null when there's none. */
  reference: Uint8Array | null;
}

export interface LayerSummary {
  id: string;
  name: string;
  type: string;
  bricks: number;
  groups: number;
  textCells: number;
  areaCells: number;
  rulers: number;
}

export interface DocSummary {
  layers: LayerSummary[];
  /** Layer ids in the order list that have no layer data. */
  orphanLayerIds: string[];
  meta: Record<string, unknown>;
  modules: number;
  labels: number;
}

export interface Removal {
  /** Where it was: `layers[3]`, `layerData.42`, `meta.cache`, ... */
  path: string;
  /** What it is, for people: "layer Tracks (brick, 1024 bricks)". */
  what: string;
  /** Title of the layout it belongs to, or why it was judged foreign. */
  from: string;
}

export interface Restore {
  path: string;
  /** The foreign value that won the key (JSON, cut short). */
  was: string;
  /** The layout's own value, set again (JSON, cut short). */
  now: string;
}

export interface LayoutPlan {
  id: string;
  title: string;
  removals: Removal[];
  restores: Restore[];
  /** Things the repair left alone because it couldn't tell whose they are. */
  unresolved: string[];
  /** Items made after the reference, by client, and where they sit. */
  newClients: { client: number; items: number; alsoIn: string[] }[];
  before: DocSummary;
  after: DocSummary;
  reference: DocSummary | null;
  /** The repair as one Yjs update; empty when nothing needs doing. */
  update: Uint8Array;
  /** sha256 of `update`, to check the applied repair is the one reviewed. */
  fingerprint: string;
}

type Home = { kind: 'own' } | { kind: 'foreign'; from: string } | { kind: 'unknown'; why: string };

// Any shared type; Yjs types its event handlers per kind, so `unknown` won't do.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YType = Y.AbstractType<any>;

const OWN: Home = { kind: 'own' };
const ARRAY_ROOTS = new Set(['layers']);
const SIDECAR_ITEMS = 'sidecarItems';

/** The client id the repair writes with: fixed per layout, so a dry run and the real run make the same update. */
export function repairClientId(layoutId: string): number {
  const h = createHash('sha256').update(`unmerge:${layoutId}`).digest();
  return (h.readUInt32BE(0) & 0x3fffffff) + 1;
}

function decode(bytes: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, bytes);
  return doc;
}

/** Every root type of a decoded doc, typed: `layers` is an array, the rest maps. */
function roots(doc: Y.Doc): Map<string, YType> {
  const out = new Map<string, YType>();
  for (const name of [...doc.share.keys()]) {
    const raw = doc.share.get(name)!;
    const isArray = ARRAY_ROOTS.has(name) || (raw._start !== null && raw._map.size === 0);
    out.set(name, isArray ? doc.getArray(name) : doc.getMap(name));
  }
  return out;
}

function short(v: unknown, max = 120): string {
  let s: string;
  try {
    s = JSON.stringify(v instanceof Y.AbstractType ? v.toJSON() : v) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max)}… (${s.length} chars)` : s;
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

function arrLen(m: Y.Map<unknown>, key: string): number {
  const v = m.get(key);
  return v instanceof Y.Array ? v.length : 0;
}

function sidecarIdsOf(cache: unknown): { modules: string[]; labels: string[] } {
  const c = (cache && typeof cache === 'object' ? cache : {}) as Record<string, unknown>;
  const ids = (list: unknown) =>
    Array.isArray(list)
      ? list.map((v) => (v && typeof v === 'object' ? (v as { id?: unknown }).id : undefined)).filter((x): x is string => typeof x === 'string')
      : [];
  return { modules: ids(c.modules), labels: ids(c.anchoredLabels) };
}

export function summarize(doc: Y.Doc): DocSummary {
  const order = doc.getArray<string>('layers').toArray();
  const data = doc.getMap<unknown>('layerData');
  const layers: LayerSummary[] = [];
  const orphanLayerIds: string[] = [];
  for (const id of order) {
    const l = data.get(id);
    if (!(l instanceof Y.Map)) {
      orphanLayerIds.push(id);
      continue;
    }
    let areaCells = 0;
    const areas = l.get('areas');
    if (areas instanceof Y.Array) areaCells = areas.length;
    layers.push({
      id,
      name: String(l.get('name') ?? ''),
      type: String(l.get('type') ?? ''),
      bricks: arrLen(l, 'bricks'),
      groups: arrLen(l, 'groups'),
      textCells: arrLen(l, 'textCells'),
      areaCells,
      rulers: arrLen(l, 'rulers'),
    });
  }
  const metaMap = doc.getMap<unknown>('meta');
  const meta: Record<string, unknown> = {};
  for (const k of ['author', 'lug', 'event', 'date', 'comment', 'backgroundColor', 'nbItems', 'selectedLayerIndex', 'version', 'schemaVersion']) {
    if (metaMap.has(k)) meta[k] = metaMap.get(k);
  }
  const ids = sidecarIdsOf(metaMap.get('cache'));
  return { layers, orphanLayerIds, meta, modules: ids.modules.length, labels: ids.labels.length };
}

function describeLayer(v: unknown, id: string): string {
  if (!(v instanceof Y.Map)) return `layer ${id}`;
  const type = String(v.get('type') ?? '?');
  const parts: string[] = [type];
  const n = (k: string, label: string) => {
    const c = arrLen(v, k);
    if (c) parts.push(`${c} ${label}`);
  };
  n('bricks', 'bricks');
  n('groups', 'groups');
  n('textCells', 'texts');
  n('rulers', 'rulers');
  return `layer "${String(v.get('name') ?? '')}" (${parts.join(', ')})`;
}

// ---------------------------------------------------------------------------
// Whose is it
// ---------------------------------------------------------------------------

interface Context {
  self: UnmergeInput;
  all: UnmergeInput[];
  /** Per layout id: its reference's state vector. */
  refSV: Map<string, Map<number, number>>;
  /** Per layout id: layer ids its reference has. */
  refLayers: Map<string, Set<string>>;
  /** Per layout id: sidecar ids (`m:<id>`, `l:<id>`) its reference has. */
  refSidecar: Map<string, Set<string>>;
  /** Per layout id: layer ids its current doc has. */
  liveLayers: Map<string, Set<string>>;
  /** Per layout id: sidecar ids its current doc has. */
  liveSidecar: Map<string, Set<string>>;
  titles: Map<string, string>;
}

/** Layouts whose reference holds the item with this id. */
function refOwners(ctx: Context, client: number, clock: number): string[] {
  const out: string[] = [];
  for (const [id, sv] of ctx.refSV) {
    const n = sv.get(client);
    if (n !== undefined && clock < n) out.push(id);
  }
  return out;
}

/** Whose a top-level name (a layer id or a sidecar id) is, by who has it. */
function homeOfName(ctx: Context, name: string, ref: Map<string, Set<string>>, live: Map<string, Set<string>>, label: string): Home {
  const inRefs = [...ref].filter(([, s]) => s.has(name)).map(([id]) => id);
  if (inRefs.includes(ctx.self.id)) return OWN;
  if (inRefs.length > 0) return { kind: 'foreign', from: ctx.titles.get(inRefs[0]!)! };
  const inLive = [...live].filter(([, s]) => s.has(name)).map(([id]) => id);
  if (inLive.length === 1 && inLive[0] === ctx.self.id) return OWN;
  return { kind: 'unknown', why: `${label} ${name} is newer than the references and is in ${inLive.map((id) => ctx.titles.get(id)).join(', ')}` };
}

function homeOfSidecarValue(ctx: Context, value: unknown): Home {
  const ids = sidecarIdsOf(value);
  const names = [...ids.modules.map((i) => `m:${i}`), ...ids.labels.map((i) => `l:${i}`)];
  if (names.length === 0) return { kind: 'unknown', why: 'a sidecar with no modules or labels' };
  const votes = new Map<string, number>();
  for (const n of names) {
    const h = homeOfName(ctx, n, ctx.refSidecar, ctx.liveSidecar, 'sidecar item');
    const key = h.kind === 'own' ? '' : h.kind === 'foreign' ? h.from : '?';
    votes.set(key, (votes.get(key) ?? 0) + 1);
  }
  const [best] = [...votes].sort((a, b) => b[1] - a[1]);
  if (best![0] === '') return OWN;
  if (best![0] === '?') return { kind: 'unknown', why: 'a sidecar whose modules are newer than the references' };
  return { kind: 'foreign', from: best![0] };
}

/**
 * Whose one element is. By id first; an element newer than every
 * reference is own inside an own parent, and at the top level judged by
 * the name it carries.
 */
function homeOf(ctx: Context, client: number, clock: number, root: string | null, key: string | null, value: unknown): Home {
  // The maps every layout's room makes are the same struct in each (ydoc recordMaps.ts).
  if (RECORD_MAPS.some(([, c]) => c === client)) return OWN;
  const owners = refOwners(ctx, client, clock);
  if (owners.includes(ctx.self.id)) return OWN;
  if (owners.length > 0) return { kind: 'foreign', from: ctx.titles.get(owners[0]!)! };
  if (root === null) return OWN; // nested in an own parent
  switch (root) {
    case 'layers':
      return typeof value === 'string' ? homeOfName(ctx, value, ctx.refLayers, ctx.liveLayers, 'layer') : OWN;
    case 'layerData':
      return homeOfName(ctx, key!, ctx.refLayers, ctx.liveLayers, 'layer');
    case 'meta':
      if (key === 'cache') return homeOfSidecarValue(ctx, value);
      return OWN;
    case SIDECAR_ITEMS:
      if (key === '__blob') return OWN; // follows meta.cache, settled after
      return homeOfName(ctx, key!, ctx.refSidecar, ctx.liveSidecar, 'sidecar item');
    default:
      return OWN;
  }
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function layerIdsOf(doc: Y.Doc): Set<string> {
  return new Set([...doc.getArray<string>('layers').toArray(), ...doc.getMap('layerData').keys()]);
}

function sidecarNamesOf(doc: Y.Doc): Set<string> {
  const out = new Set<string>();
  const ids = sidecarIdsOf(doc.getMap('meta').get('cache'));
  for (const i of ids.modules) out.add(`m:${i}`);
  for (const i of ids.labels) out.add(`l:${i}`);
  for (const k of doc.getMap(SIDECAR_ITEMS).keys()) if (k !== '__blob') out.add(k);
  return out;
}

/** The parent type's item id in the reference, to read the own value from. */
function refParent(refDoc: Y.Doc, parent: YType, rootName: string | null): Y.Map<unknown> | null {
  if (rootName !== null) return refDoc.getMap(rootName);
  const item = parent._item;
  if (!item) return null;
  try {
    const refItem = Y.getItem(refDoc.store, item.id);
    if (refItem instanceof Y.Item && refItem.content instanceof Y.ContentType && refItem.content.type instanceof Y.Map) {
      return refItem.content.type as Y.Map<unknown>;
    }
  } catch {
    /* not in the reference */
  }
  return null;
}

function valueOf(item: Y.Item): unknown {
  const c = item.content.getContent();
  return c[c.length - 1];
}

export function planUnmerge(inputs: UnmergeInput[]): LayoutPlan[] {
  const refDocs = new Map<string, Y.Doc | null>();
  const liveDocs = new Map<string, Y.Doc>();
  for (const i of inputs) {
    refDocs.set(i.id, i.reference ? decode(i.reference) : null);
    liveDocs.set(i.id, decode(i.current));
  }
  const refSV = new Map<string, Map<number, number>>();
  const refLayers = new Map<string, Set<string>>();
  const refSidecar = new Map<string, Set<string>>();
  for (const [id, d] of refDocs) {
    if (!d) continue;
    refSV.set(id, Y.decodeStateVector(Y.encodeStateVector(d)));
    refLayers.set(id, layerIdsOf(d));
    refSidecar.set(id, sidecarNamesOf(d));
  }
  const liveLayers = new Map<string, Set<string>>();
  const liveSidecar = new Map<string, Set<string>>();
  const liveSV = new Map<string, Map<number, number>>();
  for (const [id, d] of liveDocs) {
    liveLayers.set(id, layerIdsOf(d));
    liveSidecar.set(id, sidecarNamesOf(d));
    liveSV.set(id, Y.decodeStateVector(Y.encodeStateVector(d)));
  }
  const titles = new Map(inputs.map((i) => [i.id, i.title]));

  return inputs.map((self) => {
    const ctx: Context = { self, all: inputs, refSV, refLayers, refSidecar, liveLayers, liveSidecar, titles };
    const doc = liveDocs.get(self.id)!;
    const refDoc = refDocs.get(self.id) ?? null;
    const before = summarize(doc);
    const removals: Removal[] = [];
    const restores: Restore[] = [];
    const unresolved: string[] = [];
    if (!refDoc) unresolved.push('no reference copy: nothing judged own by id');

    // Items newer than every reference, by client.
    const newClients: LayoutPlan['newClients'] = [];
    for (const [client, n] of liveSV.get(self.id)!) {
      const seen = Math.max(0, ...[...refSV.values()].map((sv) => sv.get(client) ?? 0));
      if (n <= seen) continue;
      const alsoIn = [...liveSV].filter(([id, sv]) => id !== self.id && (sv.get(client) ?? 0) > seen).map(([id]) => titles.get(id)!);
      newClients.push({ client, items: n - seen, alsoIn });
    }

    type MapAction = { map: Y.Map<unknown>; key: string; restore: { value: unknown } | null };
    type ArrayAction = { arr: Y.Array<unknown>; index: number; len: number };
    const mapActions: MapAction[] = [];
    const arrayActions: ArrayAction[] = [];
    let ownCacheKept = false;

    const visit = (type: YType, path: string, rootName: string | null) => {
      if (type instanceof Y.Map) {
        for (const [key, item] of type._map) {
          if (item.deleted) continue;
          const value = valueOf(item);
          const home = homeOf(ctx, item.id.client, item.id.clock, rootName, key, value);
          const p = `${path}.${key}`;
          if (home.kind === 'foreign') {
            const restore = ownPrior(item, type, rootName, p);
            mapActions.push({ map: type, key, restore });
            const what = rootName === 'layerData' ? describeLayer(value, key) : rootName === SIDECAR_ITEMS ? `sidecar entry ${key}` : `value ${short(value, 60)}`;
            if (restore) restores.push({ path: p, was: short(value), now: short(restore.value) });
            else removals.push({ path: p, what, from: home.from });
            continue;
          }
          if (home.kind === 'unknown') unresolved.push(`${p}: ${home.why}`);
          if (rootName === 'meta' && key === 'cache') ownCacheKept = true;
          if (item.content instanceof Y.ContentType) visit(item.content.type as YType, p, null);
        }
      } else if (type instanceof Y.Array) {
        let index = 0;
        for (let item = type._start; item; item = item.right) {
          if (item.deleted || !item.countable) continue;
          const values = item.content.getContent();
          for (let off = 0; off < values.length; off++, index++) {
            const value = values[off];
            const home = homeOf(ctx, item.id.client, item.id.clock + off, rootName, null, value);
            const p = `${path}[${index}]`;
            if (home.kind === 'foreign') {
              const last = arrayActions[arrayActions.length - 1];
              if (last && last.arr === type && last.index + last.len === index) last.len += 1;
              else arrayActions.push({ arr: type as Y.Array<unknown>, index, len: 1 });
              removals.push({ path: p, what: rootName === 'layers' ? `layer id ${short(value)} in the layer order` : short(value, 60), from: home.from });
              continue;
            }
            if (home.kind === 'unknown') unresolved.push(`${p}: ${home.why}`);
            if (value instanceof Y.AbstractType) visit(value as YType, p, null);
          }
        }
      }
    };

    /**
     * A foreign value won this key. The layout's own last value, when the
     * reference has it: the newest own item among the ones it beat.
     */
    const ownPrior = (winner: Y.Item, map: Y.Map<unknown>, rootName: string | null, p: string): { value: unknown } | null => {
      if (!refDoc) return null;
      let ownItem: Y.Item | null = null;
      let newerOwnLost = false;
      for (let it = winner.left; it; it = it.left) {
        const owners = refOwners(ctx, it.id.client, it.id.clock);
        if (owners.includes(self.id)) {
          ownItem = it;
          break;
        }
        if (owners.length === 0) newerOwnLost = true;
      }
      if (!ownItem) return null;
      if (newerOwnLost) unresolved.push(`${p}: an own value newer than the reference was overwritten too and can't be recovered; the reference value is used`);
      const refMap = refParent(refDoc, map, rootName);
      const key = winner.parentSub!;
      const refItem = refMap?._map.get(key);
      if (!refMap || !refItem || refItem.deleted) {
        unresolved.push(`${p}: the own value isn't in the reference; the key is removed instead`);
        return null;
      }
      return { value: refMap.get(key) };
    };

    for (const [name, type] of roots(doc)) visit(type, name, name);

    // sidecarItems.__blob goes with meta.cache: kept only with an own cache.
    const items = doc.getMap(SIDECAR_ITEMS);
    if (!ownCacheKept && items.has('__blob')) {
      mapActions.push({ map: items, key: '__blob', restore: null });
      removals.push({ path: `${SIDECAR_ITEMS}.__blob`, what: 'sidecar hash', from: 'the removed sidecar' });
    }

    const updates: Uint8Array[] = [];
    const onUpdate = (u: Uint8Array) => updates.push(u);
    doc.clientID = repairClientId(self.id);
    doc.on('update', onUpdate);
    doc.transact(() => {
      for (const a of mapActions) {
        if (a.restore) {
          const v = a.restore.value;
          a.map.set(a.key, v instanceof Y.AbstractType ? (v as YType & { clone(): unknown }).clone() : v);
        } else a.map.delete(a.key);
      }
      // Last index first per array, so earlier indexes stay valid.
      for (const a of [...arrayActions].reverse()) a.arr.delete(a.index, a.len);
    }, 'unmerge');
    if (ownCacheKept) repairSidecarCache(doc, 'unmerge');
    doc.off('update', onUpdate);
    const update = updates.length ? Y.mergeUpdates(updates) : new Uint8Array();

    return {
      id: self.id,
      title: self.title,
      removals,
      restores,
      unresolved,
      newClients,
      before,
      after: summarize(doc),
      reference: refDoc ? summarize(refDoc) : null,
      update,
      fingerprint: createHash('sha256').update(update).digest('hex'),
    };
  });
}

/** One fingerprint for a whole plan, to check the run applies what was reviewed. */
export function planFingerprint(plans: LayoutPlan[]): string {
  const h = createHash('sha256');
  for (const p of [...plans].sort((a, b) => (a.id < b.id ? -1 : 1))) h.update(`${p.id}:${p.fingerprint}\n`);
  return h.digest('hex').slice(0, 16);
}
