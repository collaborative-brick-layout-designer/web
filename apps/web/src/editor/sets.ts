// Sets from the parts library (a <group> XML, such as flex.group) as real
// BlueBrick groups — the desktop's core/Groups.h and edit/Sets.cpp. An
// item (brick or group) names its parent group with `myGroup`; a group
// from the library has a part number, a user's group none.

import type { BbmMap, Brick, Group, LayerBrick } from '@cld/model';
import type { SidecarModule } from '@cld/bbm';
import { connectionHingeAngle } from '@cld/parts-catalog/browser';
import type { PartWire } from '../api';
import { areaSize, connectionWorld, pivotOf, rotated, type Pt } from './brickGeometry';
import { cloneGroups, groupChain } from '@cld/modules';

type Parts = ReadonlyMap<string, PartWire>;
const partOf = (parts: Parts, key: string) => parts.get(key.toLowerCase());
/**
 * The id a placed part or set goes by: BlueBrick's upper-cased key, or a
 * custom part's `custom:<id>` as is, as placing one part does.
 */
const placedKey = (p: PartWire) => (p.source === 'custom' ? p.key : p.key.toUpperCase());

/**
 * The part a set's sub-part `subKey` names, never the set itself or a set
 * it sits in (`outer`): a set named like one of its own parts would
 * otherwise find itself for that part and nest copies of itself. Then the
 * part with that number is used, or none.
 */
export function subpartOf(parts: Parts, subKey: string, outer: readonly PartWire[]): PartWire | undefined {
  const found = partOf(parts, subKey);
  if (!found || !outer.includes(found)) return found;
  const want = subKey.toLowerCase();
  for (const p of parts.values()) {
    if (p.kind !== 'group' && (p.key.toLowerCase() === want || p.partNumber.toLowerCase() === want)) return p;
  }
  return undefined;
}

// (groupChain and cloneGroups are shared with the server: @cld/modules replace.ts.)
export { cloneGroups, groupChain };

/** The outermost group above an item whose parent is `id`, or ''. */
export function topGroupId(groups: readonly Group[] | undefined, id: string | undefined): string {
  const chain = groupChain(groups, id);
  return chain.length > 0 ? chain[chain.length - 1]!.id : '';
}

/** Ids of every brick of `layer` under the same outermost group as `brick` (just itself when loose). */
export function groupMates(layer: Pick<LayerBrick, 'bricks' | 'groups'>, brick: Pick<Brick, 'id' | 'myGroup'>): string[] {
  const top = topGroupId(layer.groups, brick.myGroup);
  if (!top) return [brick.id];
  return layer.bricks.filter((b) => topGroupId(layer.groups, b.myGroup) === top).map((b) => b.id);
}

/**
 * Every part under the same outermost group as an item whose parent is
 * `groupId`, on whichever sheet holds that group (a set inside a set, or
 * inside a user's group, picks whole); [] when there's no such group.
 * What a click or a press-and-drag on a part of a set takes.
 */
export function groupMembersOf(map: Pick<BbmMap, 'layers'>, groupId: string): string[] {
  if (!groupId) return [];
  for (const layer of map.layers) {
    if (layer.type !== 'brick' || !layer.groups?.some((g) => g.id === groupId)) continue;
    return groupMates(layer, { id: '', myGroup: groupId }).filter((id) => id !== '');
  }
  return [];
}

/** `ids` with every brick of the same outermost groups (a set picks whole, as in BlueBrick). */
export function expandToGroups(ids: readonly string[], map: Pick<BbmMap, 'layers'> | null | undefined): string[] {
  if (!map || ids.length === 0) return [...ids];
  const want = new Set(ids);
  const out = [...ids];
  for (const layer of map.layers) {
    if (layer.type !== 'brick' || !layer.groups?.length) continue;
    const tops = new Set<string>();
    for (const b of layer.bricks) if (want.has(b.id) && b.myGroup) tops.add(topGroupId(layer.groups, b.myGroup));
    tops.delete('');
    if (tops.size === 0) continue;
    for (const b of layer.bricks)
      if (!want.has(b.id) && b.myGroup && tops.has(topGroupId(layer.groups, b.myGroup))) {
        want.add(b.id);
        out.push(b.id);
      }
  }
  return out;
}

/**
 * BlueBrick's LibraryBrickList: the part numbers a part list or a budget
 * counts — a set once (its top named group, TopNamedItem), a loose brick
 * by itself.
 */
export function libraryItems(layer: Pick<LayerBrick, 'bricks' | 'groups'>): string[] {
  const out: string[] = [];
  const counted = new Set<string>();
  for (const b of layer.bricks) {
    let named: Group | null = null;
    for (const g of groupChain(layer.groups, b.myGroup)) {
      if (!g.partNumber) break;
      named = g;
    }
    if (!named) out.push(b.partNumber);
    else if (!counted.has(named.id)) {
      counted.add(named.id);
      out.push(named.partNumber!);
    }
  }
  return out;
}

export interface SetBrick {
  partNumber: string;
  displayArea: { x: number; y: number; width: number; height: number };
  orientation: number;
  myGroup: string;
}

export interface ExpandedSet {
  bricks: SetBrick[];
  /** The outermost group first. */
  groups: Group[];
}

const normalised = (deg: number) => {
  let a = deg % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
};
const angleGap = (a: number, b: number) => Math.abs(normalised(a - b));

/**
 * `key` placed with its set-local origin at `centre` (studs), turned
 * `angle` degrees, as BlueBrick's Group(string) constructor builds it:
 * every sub-part at its world transform (its XML position is its box
 * centre), nested sets as child groups. Empty when `key` isn't a set.
 * `sizeOf` gives a part's box at an angle (default: its footprint).
 */
export function expandSet(
  parts: Parts,
  key: string,
  centre: Pt,
  angle: number,
  newId: () => string,
  sizeOf: (part: PartWire | undefined, angle: number) => { width: number; height: number } = (p, a) => areaSize(p, a),
): ExpandedSet {
  const out: ExpandedSet = { bricks: [], groups: [] };
  const top = partOf(parts, key);
  if (!top || top.kind !== 'group' || top.subparts.length === 0) return out;
  const visit = (set: PartWire, at: Pt, turn: number, parent: string, outer: readonly PartWire[]) => {
    const group: Group = { id: newId(), partNumber: placedKey(set), myGroup: parent };
    out.groups.push(group);
    const inside = [...outer, set];
    for (const sp of set.subparts) {
      const r = rotated({ x: sp.x, y: sp.y }, turn);
      const pos = { x: at.x + r.x, y: at.y + r.y };
      const turned = turn + sp.angle;
      const sub = subpartOf(parts, sp.subKey, inside);
      if (sub && sub.kind === 'group' && inside.length < 16) {
        visit(sub, pos, turned, group.id, inside);
        continue;
      }
      const orientation = normalised(turned);
      const size = sizeOf(sub, orientation);
      out.bricks.push({
        partNumber: sub ? placedKey(sub) : sp.subKey.toUpperCase(),
        displayArea: { x: pos.x - size.width / 2, y: pos.y - size.height / 2, width: size.width, height: size.height },
        orientation,
        myGroup: group.id,
      });
    }
  };
  visit(top, centre, angle, '', []);
  return out;
}

/** A connection of a placed set's part. */
export interface SetEnd<B> {
  brick: B;
  connection: number;
}

/**
 * Where to add the next part beside a placed set `setKey` made of `bricks`
 * (the desktop's edit::setAnchorOrder): every connection of its parts, in
 * the order to try them. The set's connections are numbered in sub-part
 * order, as BlueBrick counts them, and its GroupConnectionPreferenceList is
 * followed from connection 0 (flex.group: 0, then 2, its two rail ends);
 * the rest follow in order.
 */
export function setAnchorOrder<B extends Pick<Brick, 'partNumber'>>(parts: Parts, setKey: string, bricks: readonly B[]): SetEnd<B>[] {
  // The parts in sub-part order: each takes the first free slot with its
  // part number; any left over (not the set's) come last.
  let n = 0;
  const leaves = expandSet(parts, setKey, { x: 0, y: 0 }, 0, () => `slot${n++}`).bricks;
  const ordered: (B | undefined)[] = leaves.map(() => undefined);
  const extra: B[] = [];
  for (const b of bricks) {
    const i = leaves.findIndex((l, k) => !ordered[k] && l.partNumber.toLowerCase() === b.partNumber.toLowerCase());
    if (i >= 0) ordered[i] = b;
    else extra.push(b);
  }
  const all: SetEnd<B>[] = [];
  for (const b of [...ordered, ...extra]) {
    if (!b) continue;
    const count = parts.get(b.partNumber.toLowerCase())?.connections.length ?? 0;
    for (let c = 0; c < count; c++) all.push({ brick: b, connection: c });
  }
  const next = partOf(parts, setKey)?.groupNextPreferred ?? {};
  const taken = new Set<number>();
  const out: SetEnd<B>[] = [];
  for (let i: number | undefined = 0; i !== undefined && i >= 0 && i < all.length && !taken.has(i); i = next[i]) {
    taken.add(i);
    out.push(all[i]!);
  }
  all.forEach((e, i) => {
    if (!taken.has(i)) out.push(e);
  });
  return out;
}

/** The set (a named outermost group) that `ids` are exactly the parts of, in `layer`; null otherwise. */
export function selectedSet(layer: Pick<LayerBrick, 'bricks' | 'groups'>, ids: readonly string[]): { setKey: string; bricks: Brick[] } | null {
  if (ids.length < 2) return null;
  const chosen = layer.bricks.filter((b) => ids.includes(b.id));
  if (chosen.length !== ids.length) return null;
  const top = topGroupId(layer.groups, chosen[0]!.myGroup);
  const set = top ? layer.groups?.find((g) => g.id === top) : undefined;
  if (!set?.partNumber) return null;
  if (chosen.some((b) => topGroupId(layer.groups, b.myGroup) !== top)) return null;
  if (layer.bricks.filter((b) => topGroupId(layer.groups, b.myGroup) === top).length !== chosen.length) return null;
  return { setKey: set.partNumber, bricks: chosen };
}

/** A module that is exactly one placed set. */
export interface SetModule {
  moduleId: string;
  setKey: string;
  layerId: string;
  groups: Group[];
  /** Member brick id → its group. */
  parentOf: Map<string, string>;
}

type Member = Pick<Brick, 'id' | 'partNumber' | 'displayArea' | 'orientation' | 'connexions'>;

function matchByLayout(parts: Parts, leaves: readonly SetBrick[], members: readonly Member[]): number[] | null {
  // Sprite centres: unlike the box centre, they turn with the part.
  const centre = (b: Pick<Brick, 'displayArea' | 'orientation' | 'partNumber'>) => pivotOf(b, partOf(parts, b.partNumber));
  const first = leaves[0]!;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  for (const anchor of members) {
    if (!same(anchor.partNumber, first.partNumber)) continue;
    const turn = anchor.orientation - first.orientation;
    const fc = rotated(centre(first), turn);
    const ac = centre(anchor);
    const shift = { x: ac.x - fc.x, y: ac.y - fc.y };
    const used = new Array<boolean>(members.length).fill(false);
    const pick: number[] = [];
    let ok = true;
    for (const leaf of leaves) {
      const w = rotated(centre(leaf), turn);
      const want = { x: w.x + shift.x, y: w.y + shift.y };
      const m = members.findIndex(
        (mb, i) =>
          !used[i] &&
          same(mb.partNumber, leaf.partNumber) &&
          Math.hypot(centre(mb).x - want.x, centre(mb).y - want.y) <= 0.02 &&
          angleGap(mb.orientation, leaf.orientation + turn) <= 0.1,
      );
      if (m < 0) { ok = false; break; }
      used[m] = true;
      pick.push(m);
    }
    if (ok) return pick;
  }
  return null;
}

/** A set of distinct parts joined by hinges: each joint linked between the members, bent within its hinge angle. */
function matchByJoints(parts: Parts, leaves: readonly SetBrick[], members: readonly Member[]): number[] | null {
  const pick: number[] = [];
  for (const leaf of leaves) {
    const found = members.flatMap((m, i) => (m.partNumber.toLowerCase() === leaf.partNumber.toLowerCase() ? [i] : []));
    if (found.length !== 1) return null;
    pick.push(found[0]!);
  }
  let joints = 0;
  let hinged = false;
  for (let a = 0; a < leaves.length; a++) {
    const pa = partOf(parts, leaves[a]!.partNumber);
    if (!pa) return null;
    for (let b = a + 1; b < leaves.length; b++) {
      const pb = partOf(parts, leaves[b]!.partNumber);
      if (!pb) return null;
      for (let i = 0; i < pa.connections.length; i++) {
        for (let j = 0; j < pb.connections.length; j++) {
          const type = pa.connections[i]!.type;
          if (!type || type !== pb.connections[j]!.type) continue;
          const wa = connectionWorld(leaves[a]!, pa, i);
          const wb = connectionWorld(leaves[b]!, pb, j);
          if (Math.hypot(wa.x - wb.x, wa.y - wb.y) > 0.05) continue;
          const A = members[pick[a]!]!;
          const B = members[pick[b]!]!;
          const link = A.connexions[i]?.linkedTo;
          if (!link || link !== B.connexions[j]?.id) return null;
          const hinge = connectionHingeAngle(type);
          hinged ||= hinge > 0;
          const setTurn = leaves[b]!.orientation - leaves[a]!.orientation;
          if (angleGap(B.orientation - A.orientation, setTurn) > hinge + 0.1) return null;
          joints++;
        }
      }
    }
  }
  return hinged && joints >= leaves.length - 1 ? pick : null;
}

const defaultLook = (m: SidecarModule) =>
  !m.pinned && m.showName !== false && !m.outlineColor && !m.nameColor && m.sameColor !== false && !m.sourceFile;

/**
 * Modules that older versions made of placed sets and that are still
 * exactly one: one brick layer; the set's parts (through nested sets) and
 * nothing else, none already grouped; at the set's relative positions and
 * angles (0.02 stud, 0.1 degree), or for a set of distinct parts joined
 * by hinges (flex track), linked at each joint and bent within its hinge
 * angle; still named after the set; unpinned, with the default look.
 */
export function findSetModules(map: BbmMap, modules: readonly SidecarModule[], parts: Parts, newId: () => string): SetModule[] {
  const out: SetModule[] = [];
  if (modules.length === 0) return out;
  const setsByName = new Map<string, string[]>();
  const add = (name: string, key: string) => {
    const k = name.trim().toLowerCase();
    if (k) setsByName.set(k, [...(setsByName.get(k) ?? []), key]);
  };
  for (const p of parts.values()) {
    if (p.kind !== 'group' || p.subparts.length === 0) continue;
    add(p.key, p.key);
    add(p.description, p.key);
  }
  for (const mod of modules) {
    if (!defaultLook(mod) || mod.members.length === 0) continue;
    const candidates = [...new Set(setsByName.get(mod.name.trim().toLowerCase()) ?? [])];
    if (candidates.length === 0) continue;
    const ids = new Set(mod.members);
    let layerId = '';
    const members: Member[] = [];
    let ok = true;
    for (const layer of map.layers) {
      if (layer.type !== 'brick') continue;
      for (const b of layer.bricks) {
        if (!ids.has(b.id)) continue;
        if ((layerId && layerId !== layer.id) || b.myGroup) ok = false;
        layerId = layer.id;
        members.push(b);
      }
    }
    if (!ok || members.length !== ids.size) continue;
    for (const key of candidates) {
      const set = expandSet(parts, key, { x: 0, y: 0 }, 0, newId);
      if (set.bricks.length !== members.length) continue;
      const want = set.bricks.map((b) => b.partNumber.toUpperCase()).sort();
      const have = members.map((b) => b.partNumber.toUpperCase()).sort();
      if (want.join('\n') !== have.join('\n')) continue;
      const pick = matchByLayout(parts, set.bricks, members) ?? matchByJoints(parts, set.bricks, members);
      if (!pick) continue;
      out.push({
        moduleId: mod.id,
        setKey: key,
        layerId,
        groups: set.groups,
        parentOf: new Map(set.bricks.map((b, l) => [members[pick[l]!]!.id, b.myGroup])),
      });
      break;
    }
  }
  return out;
}

/**
 * Sets used whole (`<CanUngroup>false`, joined at hinges: flex track) whose
 * parts lie loose on a brick layer, in no group, still joined at their
 * hinge: the halves layouts made before sets were groups hold. Each comes
 * back with no `moduleId` (the desktop's findLooseSets). Parts in `skip`
 * (already becoming a set) are left alone; parts already in a group never
 * are taken, so it finds nothing the second time, here or on the desktop.
 */
export function findLooseSets(map: BbmMap, parts: Parts, newId: () => string, skip: ReadonlySet<string> = new Set()): SetModule[] {
  const out: SetModule[] = [];
  const kinds: { key: string; parts: string }[] = [];
  const setParts = new Set<string>();
  const seenKeys = new Set<string>();
  for (const p of parts.values()) {
    if (p.kind !== 'group' || p.canUngroup !== false || p.subparts.length === 0 || seenKeys.has(p.key)) continue;
    seenKeys.add(p.key);
    const set = expandSet(parts, p.key, { x: 0, y: 0 }, 0, newId);
    if (set.bricks.length < 2) continue;
    const names = set.bricks.map((b) => b.partNumber.toUpperCase());
    for (const n of names) setParts.add(n);
    kinds.push({ key: p.key, parts: names.sort().join('\n') });
  }
  if (kinds.length === 0) return out;
  for (const layer of map.layers) {
    if (layer.type !== 'brick') continue;
    const loose = (b: Brick) => !b.myGroup && !skip.has(b.id) && setParts.has(b.partNumber.toUpperCase());
    // Loose set parts by their connections' ids.
    const byConnection = new Map<string, number>();
    layer.bricks.forEach((b, i) => {
      if (loose(b)) for (const c of b.connexions) if (c.id) byConnection.set(c.id, i);
    });
    const seen = new Array<boolean>(layer.bricks.length).fill(false);
    layer.bricks.forEach((first, i) => {
      if (seen[i] || !loose(first)) return;
      // The parts joined to it at hinges, and to those, and so on.
      const joined = [i];
      seen[i] = true;
      for (let n = 0; n < joined.length && joined.length <= 16; n++) {
        const b = layer.bricks[joined[n]!]!;
        const conns = partOf(parts, b.partNumber)?.connections ?? [];
        const count = Math.min(conns.length, b.connexions.length);
        for (let c = 0; c < count; c++) {
          if (connectionHingeAngle(conns[c]!.type) <= 0) continue;
          const j = byConnection.get(b.connexions[c]!.linkedTo ?? '');
          if (j === undefined || seen[j]) continue;
          seen[j] = true;
          joined.push(j);
        }
      }
      if (joined.length < 2) return;
      const members = joined.map((j) => layer.bricks[j]!);
      const have = members.map((b) => b.partNumber.toUpperCase()).sort().join('\n');
      for (const kind of kinds) {
        if (kind.parts !== have) continue;
        const set = expandSet(parts, kind.key, { x: 0, y: 0 }, 0, newId);
        const pick = matchByJoints(parts, set.bricks, members);
        if (!pick) continue;
        out.push({
          moduleId: '',
          setKey: kind.key,
          layerId: layer.id,
          groups: set.groups,
          parentOf: new Map(set.bricks.map((b, l) => [members[pick[l]!]!.id, b.myGroup])),
        });
        break;
      }
    });
  }
  return out;
}

/** What the editor says after findSetModules / findLooseSets made sets again (the desktop's notice). */
export function setsAgainNotice(fromModules: number, loose: number): string {
  const what: string[] = [];
  if (fromModules > 0) {
    what.push(`${fromModules === 1 ? 'A set such as flex track was' : `${fromModules} sets such as flex track were`} kept as ${fromModules === 1 ? 'a module' : 'modules'} by an older version.`);
  }
  if (loose > 0) what.push(`${loose === 1 ? 'A flex track piece had' : `${loose} flex track pieces had`} come apart into loose halves.`);
  const n = fromModules + loose;
  return `${what.join(' ')} ${n === 1 ? 'It is now a set' : 'They are now sets'}: each one selects, moves and counts as one part, as in BlueBrick. Undo (Ctrl+Z) puts ${n === 1 ? 'it' : 'them'} back as before.`;
}

/**
 * What Ungroup would do to `selection`: nothing grouped, split something,
 * or only sets that are always used whole (`canUngroup` says no).
 */
export function ungroupState(
  map: Pick<BbmMap, 'layers'> | null | undefined,
  selection: readonly string[],
  canUngroup: (group: Group) => boolean,
): 'nothing' | 'splits' | 'whole' {
  if (!map) return 'nothing';
  const want = new Set(selection);
  let grouped = false;
  for (const layer of map.layers) {
    if (layer.type !== 'brick' || !layer.groups?.length) continue;
    for (const b of layer.bricks) {
      if (!want.has(b.id) || !b.myGroup) continue;
      const top = layer.groups.find((g) => g.id === topGroupId(layer.groups, b.myGroup));
      if (!top) continue;
      grouped = true;
      if (canUngroup(top)) return 'splits';
    }
  }
  return grouped ? 'whole' : 'nothing';
}
