// Who may write what while an operating session runs (Live Ops design 4.2,
// 4.3; @cld/parts-catalog opsSession.ts). Checked on every update before it
// is applied, against the room's document as it is then: who is in the
// crew, which jobs are out and which parts a place covers are read from
// the layout before the update, never from what the update writes, so an
// update can't give itself a role and use it.
//
// Viewers (the narrow exception Aaron approved, 2026-11-25): a viewer in
// the running session's crew may write only
//   - where cuts and trains stand: a train's `position`, `units`, `over`,
//     `emptiedAt`; a new record only as a cut; a delete only of an empty cut;
//   - a car's `opsCut`;
//   - switch settings;
//   - new entries of the running session's log, with their own user id;
// each within their role's reach (opsReach). Anything else, and anything
// that can't be told exactly from the update and the room (a change that
// would wait for others the room doesn't have, two structs for one id, an
// unknown parent or neighbour, a delete of something else, content of
// another kind, another person's client id), refuses the whole update.
// Read-only API tokens and suspended people get no exception at all
// (handler.ts passes `crew: false`).
//
// Everyone, while a session runs:
//   - the map's sheets (`layers`, `layerData`) are locked, the host's and
//     the owner's too: they pause the session to change them;
//   - people other than the host and the owner move cars and flip
//     switches only within their role's reach (an editor who isn't crew:
//     not at all).
// Everyone, always:
//   - a log entry is written once, by whoever it says (`by` is the sender),
//     for a session that is running or paused; it isn't changed afterwards,
//     and it is deleted only with a session that isn't running or paused;
//   - a session's `host` is whoever writes it; a second session can't be
//     started while one runs.
//
// A false refusal costs a reload; a wrong yes would let a viewer change the
// layout. So whatever can't be placed exactly is refused.

import * as Y from 'yjs';
import { readPlacesFromDoc, readRecordsFromDoc, readSidecarCache, OPS_JOBS_KEY, OPS_LOG_KEY, OPS_SESSIONS_KEY, ROLLING_STOCK_KEY, SWITCH_STATES_KEY, TRAINS_KEY } from '@cld/ydoc';
import { asJob, asSession, mayFlip, mayMove, mayPut, opsReach, reachPlaces, runningSessions, type OpsReach, type OpsSession } from '@cld/parts-catalog/browser';
import { findStruct, type DecodedUpdate } from './decoded.js';
import { pendingMayLand } from './pending.js';

/** Who sends an update, as the guard needs it. */
export interface OpsSender {
  userId: string;
  role: 'owner' | 'editor' | 'viewer';
  /** A viewer who may be crew: not a read-only token, not suspended. */
  crew: boolean;
  /** The client ids this connection's presence holds (DocSession.awarenessOwners). */
  ownsClient: (client: number) => boolean;
  /** The client ids viewers have written with in this room, and whose they are. */
  claims: Map<number, string>;
}

/** The root maps whose changes are the map's sheets and their parts. */
const SHEET_ROOTS = new Set(['layers', 'layerData']);
/** A train's or cut's fields a crew writes when it moves cuts. */
const MOVE_FIELDS = new Set(['position', 'units', 'over', 'emptiedAt']);
/** The fields a new cut is made with (cuts.ts writes the whole record). */
const NEW_CUT_FIELDS = new Set(['id', 'name', 'trackKind', 'units', 'position', 'color', 'speed', 'cut', 'over', 'emptiedAt']);
const LOG_FIELDS = new Set(['id', 'session', 'at', 'by', 'kind', 'what', 'from', 'to', 'note']);
/** Fields the guard checks for everyone: a log entry's author and session, a session's host and status. */
const CHECKED_FIELDS = new Set(['by', 'session', 'host', 'status']);

type Path = readonly string[];

type MetaMap = { _map?: Map<string, Y.Item> } | undefined;

function liveMap(doc: Y.Doc, key: string): Y.Map<unknown> | null {
  const item = (doc.share.get('meta') as unknown as MetaMap)?._map?.get(key);
  return item && !item.deleted && item.content instanceof Y.ContentType && item.content.type instanceof Y.Map ? (item.content.type as Y.Map<unknown>) : null;
}

const plainRecord = (m: Y.Map<unknown> | null, id: string): Record<string, unknown> | null => {
  const r = m?.get(id);
  return r instanceof Y.Map ? (r.toJSON() as Record<string, unknown>) : null;
};

/** The sessions of the room as it is. */
export function roomSessions(doc: Y.Doc): OpsSession[] {
  if (!liveMap(doc, OPS_SESSIONS_KEY) && !(doc.getMap('meta').get('cache') as Record<string, unknown> | undefined)?.extras) return [];
  return readRecordsFromDoc(doc, OPS_SESSIONS_KEY).map((r) => asSession(r));
}

/** Whether a session runs in the room (cheap: most layouts have none). */
export function sessionRuns(doc: Y.Doc): boolean {
  const m = liveMap(doc, OPS_SESSIONS_KEY);
  if (!m || m.size === 0) return false;
  for (const v of m.values()) if (v instanceof Y.Map && v.get('status') === 'running') return true;
  return false;
}

/** What `userId` reaches in the room as it is (before the update). */
export function roomReach(doc: Y.Doc, layoutId: string, userId: string, owner: boolean): OpsReach {
  const sessions = roomSessions(doc);
  const cache = readSidecarCache(doc);
  const modules = (Array.isArray(cache?.modules) ? (cache.modules as Record<string, unknown>[]) : []).map((m) => ({
    members: Array.isArray(m?.members) ? (m.members as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    places: Array.isArray(m?.places) ? (m.places as unknown[]).filter((p): p is { id: string } => !!p && typeof (p as { id?: unknown }).id === 'string') : [],
  }));
  const places = reachPlaces(modules, readPlacesFromDoc(doc));
  const jobs = readRecordsFromDoc(doc, OPS_JOBS_KEY).map((r) => ({ ...asJob(r), status: r.status }));
  return opsReach({ sessions, jobs, places, userId, layoutId, owner });
}

/** The room's item at `id`, or null. */
function roomItem(doc: Y.Doc, id: Y.ID): Y.Item | null {
  if (id.clock >= Y.getState(doc.store, id.client)) return null;
  try {
    const it = Y.getItem(doc.store, id);
    return it instanceof Y.Item ? it : null;
  } catch {
    return null;
  }
}

/** Where an item of the room sits: [root, key, key...] for map values; [root] alone when it is in an array or text somewhere below. */
function roomPath(doc: Y.Doc, item: Y.Item): { root: string; path: Path | null } | null {
  const out: string[] = [];
  let mapOnly = true;
  let at: Y.Item | null = item;
  for (let depth = 0; at && depth < 64; depth++) {
    if (at.parentSub === null) mapOnly = false;
    else out.unshift(at.parentSub);
    const parent = at.parent as Y.AbstractType<unknown> | null;
    if (!parent) return null;
    if (parent._item === null) {
      for (const [name, t] of doc.share) if (t === parent) return { root: name, path: mapOnly ? [name, ...out] : null };
      return null;
    }
    at = parent._item;
  }
  return null;
}

/** What one update's new structs and real deletes are, placed in the room. */
interface Placed {
  /** Each new struct: its root, and its map path when it is a map value all the way up (else null). Null root: can't be told. */
  structs: { s: Y.Item; root: string | null; path: Path | null; parentNew: boolean }[];
  /** Items of the room (not yet deleted) that the update deletes. Null root: can't be told. */
  deletes: { item: Y.Item; root: string | null; path: Path | null }[];
  /** Something can't be told: a gap before a struct, a neighbour or parent nobody has, a delete of what the room doesn't have, a GC or skip that brings something. */
  unknown: boolean;
}

function place(doc: Y.Doc, decoded: DecodedUpdate, withDeletes: boolean): Placed {
  const out: Placed = { structs: [], deletes: [], unknown: decoded.overlapping };
  const state = (c: number) => Y.getState(doc.store, c);
  const inUpdate = (id: Y.ID): Y.Item | null => {
    const s = findStruct(decoded.byClient.get(id.client), id.clock);
    return s instanceof Y.Item ? s : null;
  };
  // Each client's new structs follow what the room has without a gap.
  for (const [c, list] of decoded.byClient) {
    let cur = state(c);
    for (const s of list) {
      const end = s.id.clock + s.length;
      if (end <= cur) continue; // the room has it
      if (s.id.clock > cur || !(s instanceof Y.Item)) {
        out.unknown = true;
        break;
      }
      cur = end;
    }
  }
  const memo = new Map<Y.Item, { root: string | null; path: Path | null }>();
  const where = (s: Y.Item, depth: number): { root: string | null; path: Path | null } => {
    const had = memo.get(s);
    if (had) return had;
    let res: { root: string | null; path: Path | null } = { root: null, path: null };
    memo.set(s, res);
    if (depth > 64) return res;
    const sub = s.parentSub;
    const extend = (up: { root: string | null; path: Path | null }): { root: string | null; path: Path | null } => ({
      root: up.root,
      path: up.path && sub !== null && up.path.length < 8 ? [...up.path, sub] : null,
    });
    if (typeof s.parent === 'string') {
      res = { root: s.parent, path: sub === null ? null : [s.parent, sub] };
    } else if (s.parent !== null) {
      const pid = s.parent as unknown as Y.ID;
      const there = roomItem(doc, pid);
      if (there) {
        const p = roomPath(doc, there);
        res = p ? extend({ root: p.root, path: p.path }) : res;
      } else {
        const up = inUpdate(pid);
        if (up && up.content instanceof Y.ContentType) res = extend(where(up, depth + 1));
      }
    } else {
      // Its parent is its neighbour's (Yjs leaves it out when one is given).
      const ref = s.origin ?? s.rightOrigin;
      if (ref) {
        const there = roomItem(doc, ref);
        if (there) {
          const p = roomPath(doc, there);
          res = p ? { root: p.root, path: p.path } : res;
        } else {
          const up = inUpdate(ref);
          if (up) res = where(up, depth + 1);
        }
      }
    }
    memo.set(s, res);
    return res;
  };
  const known = (id: Y.ID | null): boolean => id === null || !!roomItem(doc, id) || !!inUpdate(id);
  for (const [c, list] of decoded.byClient) {
    for (const s of list) {
      if (s.id.clock + s.length <= state(c) || !(s instanceof Y.Item)) continue;
      if (!known(s.origin) || !known(s.rightOrigin) || (s.parent !== null && typeof s.parent !== 'string' && !known(s.parent as unknown as Y.ID))) out.unknown = true;
      const w = where(s, 0);
      let parentNew = false;
      if (s.parent !== null && typeof s.parent !== 'string') parentNew = !roomItem(doc, s.parent as unknown as Y.ID);
      else if (s.parent === null) {
        const ref = s.origin ?? s.rightOrigin;
        if (ref) {
          const there = roomItem(doc, ref);
          parentNew = there ? false : true;
          if (there && there.parent instanceof Y.AbstractType && there.parent._item) parentNew = false;
        }
      }
      out.structs.push({ s, root: w.root, path: w.path, parentNew });
    }
  }
  // The room's items it deletes (what the room has deleted already, or
  // the update's own new structs, change nothing here).
  if (!withDeletes) return out;
  for (const [client, ranges] of decoded.ds.clients) {
    const have = state(client);
    for (const r of ranges) {
      const end = r.clock + r.len;
      if (end > have) {
        // Beyond the room: only the update's own structs may be there.
        for (let k = Math.max(r.clock, have); k < end; ) {
          const s = findStruct(decoded.byClient.get(client), k);
          if (!s) {
            out.unknown = true;
            break;
          }
          k = s.id.clock + s.length;
        }
      }
      for (let k = r.clock; k < Math.min(end, have); ) {
        const it = roomItem(doc, Y.createID(client, k));
        if (!it) {
          k += 1;
          continue;
        }
        if (!it.deleted) {
          const p = roomPath(doc, it);
          out.deletes.push({ item: it, root: p?.root ?? null, path: p?.path ?? null });
        }
        k = it.id.clock + it.length;
      }
    }
  }
  return out;
}

/** A value an item holds, when it is one plain value. */
function oneValue(s: Y.Item): { ok: boolean; value: unknown } {
  const c = s.content;
  if (c instanceof Y.ContentAny && c.arr.length === 1) return { ok: true, value: c.arr[0] };
  return { ok: false, value: undefined };
}

const isMapContent = (s: Y.Item) => s.content instanceof Y.ContentType && s.content.type instanceof Y.Map;

/**
 * Null when the update may be taken from this sender; else why not (for
 * the log). `layoutId` is the room's layout.
 */
export function opsProblem(doc: Y.Doc, decoded: DecodedUpdate, layoutId: string, who: OpsSender): string | null {
  const viewer = who.role === 'viewer';
  const runs = sessionRuns(doc);
  const touchesOps = viewer || runs || mayTouchLogOrSessions(doc, decoded);
  if (!touchesOps) return null;
  const sessionsLive = runs || roomSessions(doc).some((x) => x.status === 'paused');
  if (viewer && !who.crew) return 'a viewer can’t change the layout';
  if (viewer && !runs) return 'a viewer can’t change the layout when no session is running';
  if ((viewer || runs) && pendingMayLand(doc, decoded)) return 'it may bring in changes the layout holds back, while a session runs';
  const placed = place(doc, decoded, viewer || sessionsLive);
  // (An editor's change that waits for others can't be read here: one that names a log entry's or a session's checked fields is refused.)
  if (placed.unknown && !viewer && !runs && decoded.structs.some((s) => s instanceof Y.Item && s.parentSub !== null && CHECKED_FIELDS.has(s.parentSub) && !s.deleted)) return 'it writes a log entry or a session that can’t be checked (it depends on changes the layout doesn’t have)';
  if (placed.unknown && (viewer || runs)) return 'it can’t be checked against the running session (it depends on changes the layout doesn’t have)';

  const sessions = roomSessions(doc);
  const running = runningSessions(sessions);
  const reach = runs || viewer ? roomReach(doc, layoutId, who.userId, who.role === 'owner') : null;
  const free = !!reach && reach.role === 'host';
  const trains = liveMap(doc, TRAINS_KEY);
  const stock = liveMap(doc, ROLLING_STOCK_KEY);
  const logMap = liveMap(doc, OPS_LOG_KEY);

  // A viewer writes only with client ids of their own (their presence, and
  // new to the room or theirs already): never another person's.
  if (viewer) {
    for (const { s } of placed.structs) {
      const c = s.id.client;
      if (!who.ownsClient(c)) return 'a viewer writes with a client id that isn’t theirs';
      const claimed = who.claims.get(c);
      if (claimed !== undefined && claimed !== who.userId) return 'a viewer writes with another person’s client id';
      if (claimed === undefined && Y.getState(doc.store, c) > 0) return 'a viewer writes with a client id the layout knows already';
    }
  }

  // The cars a reach may take: those in its trains and cuts as they stand.
  let carsInReach: Set<string> | null = null;
  const reachCars = (): Set<string> => {
    if (carsInReach) return carsInReach;
    carsInReach = new Set();
    if (!trains || !reach) return carsInReach;
    for (const [id, v] of trains.entries()) {
      if (!(v instanceof Y.Map) || !mayMove(reach, id, v.get('position'))) continue;
      const units = v.get('units');
      if (Array.isArray(units)) for (const u of units) if (u && typeof (u as { stock?: unknown }).stock === 'string') carsInReach.add((u as { stock: string }).stock);
    }
    if (stock) for (const [id, v] of stock.entries()) if (v instanceof Y.Map && typeof v.get('opsCut') === 'string' && v.get('opsCut') !== '' && inReachTrain(v.get('opsCut') as string)) carsInReach.add(id);
    return carsInReach;
  };
  const inReachTrain = (id: string): boolean => {
    if (!reach) return false;
    if (reach.all) return true;
    const t = plainRecord(trains, id);
    return t ? mayMove(reach, id, t.position) : newCuts.has(id);
  };

  // Gated: where cars are and how switches are set, while a session runs, for everyone but the host and the owner.
  const gated = runs && !free;
  const newCuts = new Map<string, number>();
  for (const { s, path } of placed.structs) if (path?.length === 3 && path[0] === 'meta' && path[1] === TRAINS_KEY && !plainRecord(trains, path[2]!) && isMapContent(s)) newCuts.set(path[2]!, 0);
  const newLogs = new Map<string, { by: unknown; session: unknown; count: number }>();
  const written = new Set<string>();
  const recordStructs = new Map<string, number>();

  for (const { s, root, path, parentNew } of placed.structs) {
    if (runs && (root === null || SHEET_ROOTS.has(root))) return root === null ? 'it can’t be placed, while a session runs' : 'a session is running: the map’s sheets are locked (the host pauses it to change them)';
    if (!path) {
      if (viewer) return 'a viewer writes something other than cars and switches';
      continue;
    }
    if (path.length === 3) {
      const k = path.join('\u0000');
      recordStructs.set(k, (recordStructs.get(k) ?? 0) + 1);
    }
    if (path.length >= 4) written.add(path.slice(0, 4).join('\u0000'));
    else written.add(path.join('\u0000'));
    const [r, key, id, field] = path;
    const ops = r === 'meta' && (key === TRAINS_KEY || key === SWITCH_STATES_KEY || key === OPS_LOG_KEY || key === OPS_SESSIONS_KEY || (key === ROLLING_STOCK_KEY && field === 'opsCut'));
    if (viewer && (!ops || key === OPS_SESSIONS_KEY)) return 'a viewer writes something other than cars and switches';
    if (!ops || r !== 'meta') continue;
    const deletedNow = s.content instanceof Y.ContentDeleted;

    if (key === OPS_SESSIONS_KEY) {
      if (path.length !== 4 || deletedNow) continue;
      const { ok, value } = oneValue(s);
      if (field === 'host' && ok && value !== who.userId && value !== '') return 'it names someone else as a session’s host';
      if (field === 'status' && sessions.find((x) => x.id === id)?.status === 'ended' && value !== 'ended') return 'a session that has ended stays ended';
      if (field === 'status' && ok && value === 'running') {
        if (running.some((x) => x.id !== id)) return 'a session is running already';
        if (viewer) return 'a viewer can’t start a session';
        const hostNow = placed.structs.find(({ path: p, s: x }) => p?.length === 4 && p[1] === OPS_SESSIONS_KEY && p[2] === id && p[3] === 'host' && oneValue(x).ok);
        const host = hostNow ? oneValue(hostNow.s).value : sessions.find((x) => x.id === id)?.host;
        if (host !== who.userId) return 'whoever starts a session is its host';
      }
      continue;
    }
    if (key === OPS_LOG_KEY) {
      if (path.length === 2) {
        if (viewer || sessionsLive) return 'it replaces the session log';
        continue;
      }
      if (path.length === 3) {
        if (logMap?.has(id!)) return 'it changes an entry of the session log';
        if (!isMapContent(s) && !deletedNow) return 'it writes a log entry that isn’t one';
        const n = newLogs.get(id!) ?? { by: undefined, session: undefined, count: 0 };
        n.count += 1;
        newLogs.set(id!, n);
        continue;
      }
      if (path.length !== 4 || !parentNew || logMap?.has(id!)) return 'it changes an entry of the session log';
      if (deletedNow) continue;
      const { ok, value } = oneValue(s);
      if (!ok || !LOG_FIELDS.has(field!)) return 'it writes a log entry that isn’t one';
      const n = newLogs.get(id!) ?? { by: undefined, session: undefined, count: 0 };
      if (field === 'by') n.by = n.by === undefined || n.by === value ? value : NaN;
      if (field === 'session') n.session = n.session === undefined || n.session === value ? value : NaN;
      newLogs.set(id!, n);
      continue;
    }
    if (!gated && !viewer) continue;
    if (!reach || (!reach.all && reach.bricks.size === 0 && reach.trains.size === 0)) return `you can’t move cars or flip switches in this session${reach?.why ? ` (${reach.why})` : ''}`;
    if (key === SWITCH_STATES_KEY) {
      if (path.length !== 3) return 'it writes switch settings that aren’t one';
      if (!deletedNow && !oneValue(s).ok) return 'it writes switch settings that aren’t one';
      if (!mayFlip(reach, id!)) return 'that switch is outside your role’s reach';
      continue;
    }
    if (key === ROLLING_STOCK_KEY) {
      // (opsCut only, above.) The car has to be in a cut of theirs, and go to one.
      if (path.length !== 4 || !plainRecord(stock, id!)) return 'it moves a car that isn’t on the layout';
      if (!reach.all && !reachCars().has(id!)) return 'that car is outside your role’s reach';
      const { ok, value } = oneValue(s);
      if (!deletedNow && (!ok || (value !== '' && (typeof value !== 'string' || !inReachTrain(value))))) return 'it puts a car in a cut outside your role’s reach';
      continue;
    }
    // trains
    if (path.length === 2) return 'it replaces the layout’s trains';
    const had = plainRecord(trains, id!);
    if (path.length === 3) {
      if (had) return 'it replaces a train';
      if (!isMapContent(s) && !deletedNow) return 'it writes a train that isn’t one';
      newCuts.set(id!, (newCuts.get(id!) ?? 0) + 1);
      continue;
    }
    if (path.length !== 4) return 'it writes a train that isn’t one';
    if (deletedNow) continue;
    const { ok, value } = oneValue(s);
    if (!ok) return 'it writes a train that isn’t one';
    if (!had || parentNew) {
      if (!NEW_CUT_FIELDS.has(field!)) return 'a new cut has a field it can’t have';
      if (field === 'cut' && value !== true) return 'it makes a train, not a cut';
      if (field === 'position' && !mayPut(reach, id!, value)) return 'it puts a cut outside your role’s reach';
      if (field === 'units' && !unitsInReach(value, reach, reachCars())) return 'it takes cars outside your role’s reach';
      continue;
    }
    if (!MOVE_FIELDS.has(field!)) return 'it changes a train’s other fields while a session runs';
    if (!mayMove(reach, id!, had.position)) return 'that train or cut is outside your role’s reach';
    if (field === 'position' && !mayPut(reach, id!, value)) return 'it puts a cut outside your role’s reach';
    if (field === 'units' && !unitsInReach(value, reach, reachCars())) return 'it takes cars outside your role’s reach';
  }

  // (Only where the update's records are checked: an editor's train or car, with no session running, is theirs to write.)
  if (viewer || gated) for (const n of recordStructs.values()) if (n > 1) return 'it writes one record twice';
  // A new log entry: of a running or paused session, by whoever sends it.
  // Only an editor may bring in the log of a session that has ended (a
  // layout made from a file): such a log is history, its session done.
  for (const [id, n] of newLogs) {
    if (n.count > 1) return 'it writes one log entry twice';
    if (typeof n.session !== 'string') return `it writes a log entry without its session (${id.slice(0, 64)})`;
    const of = sessions.find((x) => x.id === n.session);
    if (of && (of.status === 'running' || of.status === 'paused')) {
      if (n.by !== who.userId) return 'it writes a log entry in someone else’s name';
      if (viewer && of.status !== 'running') return 'a viewer writes a log entry for a session that isn’t running';
      continue;
    }
    if (viewer) return 'a viewer writes a log entry for a session that isn’t running';
    const endedHere = of ? of.status === 'ended' && !placed.structs.some(({ path: p }) => p?.[1] === OPS_SESSIONS_KEY && p[2] === of.id && p[3] === 'status') : endsInUpdate(placed, n.session);
    if (!endedHere) return 'it writes a log entry for a session that isn’t running';
  }
  for (const [id, n] of viewer || gated ? newCuts : new Map<string, number>()) {
    if (n > 1) return 'it writes one cut twice';
    // A new cut says it is one.
    if (!placed.structs.some(({ path, s }) => path?.length === 4 && path[1] === TRAINS_KEY && path[2] === id && path[3] === 'cut' && oneValue(s).value === true)) return 'it makes a train, not a cut';
  }

  // What it deletes.
  for (const { root, path } of placed.deletes) {
    if (runs && (root === null || SHEET_ROOTS.has(root))) return root === null ? 'it deletes something that can’t be placed, while a session runs' : 'a session is running: the map’s sheets are locked (the host pauses it to change them)';
    if (!path) {
      if (viewer) return 'a viewer deletes something other than cars and switches';
      continue;
    }
    const [r, key, id, field] = path;
    if (r === 'meta' && key === OPS_LOG_KEY) {
      if (path.length <= 2) return 'it deletes the session log';
      const entry = plainRecord(logMap, id!);
      const of = sessions.find((x) => x.id === entry?.session);
      if (viewer || (of && (of.status === 'running' || of.status === 'paused'))) return 'it deletes an entry of the session log';
      if (path.length === 4 && !written.has(path.join('\u0000')) && liveMap(doc, OPS_LOG_KEY)?.get(id!) instanceof Y.Map) {
        // A field taken out of an entry that stays.
        const recordGoes = placed.deletes.some((d) => d.path?.length === 3 && d.path[1] === OPS_LOG_KEY && d.path[2] === id);
        if (!recordGoes) return 'it changes an entry of the session log';
      }
      continue;
    }
    const gatedKey = r === 'meta' && (key === TRAINS_KEY || key === SWITCH_STATES_KEY || (key === ROLLING_STOCK_KEY && field === 'opsCut'));
    if (viewer && !gatedKey) return 'a viewer deletes something other than cars and switches';
    if (!gatedKey || (!gated && !viewer)) continue;
    if (!reach) return 'you can’t move cars or flip switches in this session';
    if (key === SWITCH_STATES_KEY) {
      if (path.length !== 3 || !mayFlip(reach, id!)) return 'that switch is outside your role’s reach';
      continue;
    }
    if (key === ROLLING_STOCK_KEY) {
      // Only as it is written again.
      if (!written.has(path.join('\u0000'))) return 'it takes a car’s cut away';
      continue;
    }
    if (path.length === 2) return 'it deletes the layout’s trains';
    const had = plainRecord(trains, id!);
    if (!had) continue;
    if (!mayMove(reach, id!, had.position)) return 'that train or cut is outside your role’s reach';
    if (path.length === 3) {
      if (!reach.all && (had.cut !== true || (Array.isArray(had.units) && had.units.length > 0))) return 'it deletes a train or a cut with cars';
      continue;
    }
    // A field: only as it is written again, or with its record.
    const recordGoes = placed.deletes.some((d) => d.path?.length === 3 && d.path[1] === TRAINS_KEY && d.path[2] === id);
    if (!recordGoes && !written.has(path.slice(0, 4).join('\u0000'))) return 'it takes a field away from a train';
    if (!recordGoes && !MOVE_FIELDS.has(field!)) return 'it changes a train’s other fields while a session runs';
  }
  return null;
}

/** Whether the update makes session `id` with status 'ended' (and no other). */
function endsInUpdate(placed: Placed, id: string): boolean {
  let ended = false;
  for (const { s, path } of placed.structs) {
    if (path?.length !== 4 || path[1] !== OPS_SESSIONS_KEY || path[2] !== id || path[3] !== 'status') continue;
    if (oneValue(s).value !== 'ended') return false;
    ended = true;
  }
  return ended;
}

function unitsInReach(value: unknown, reach: OpsReach, cars: Set<string>): boolean {
  if (reach.all) return true;
  if (!Array.isArray(value)) return false;
  return value.every((u) => !!u && typeof u === 'object' && typeof (u as { stock?: unknown }).stock === 'string' && cars.has((u as { stock: string }).stock));
}

/** Whether an update may write the log or the sessions (their names are in its bytes, or the room has some): when not, and no session runs, nothing is checked. */
function mayTouchLogOrSessions(doc: Y.Doc, decoded: DecodedUpdate): boolean {
  if (liveMap(doc, OPS_LOG_KEY) || liveMap(doc, OPS_SESSIONS_KEY)) return true;
  return decoded.structs.some((s) => s instanceof Y.Item && s.parentSub !== null && (s.parentSub === OPS_LOG_KEY || s.parentSub === OPS_SESSIONS_KEY || CHECKED_FIELDS.has(s.parentSub)));
}

/** After a viewer's update is taken: its new client ids are theirs from now on. */
export function noteClaims(decoded: DecodedUpdate, who: OpsSender): void {
  if (who.role !== 'viewer') return;
  for (const c of decoded.byClient.keys()) if (!who.claims.has(c)) who.claims.set(c, who.userId);
}

/**
 * opsProblem, refusing when it throws, for a viewer or while a session
 * runs (a check that can't finish says no). For an editor with no session
 * running it lets the update through: only the log's and sessions' own
 * fields were left to check, and a broken check mustn't stop every edit.
 */
export function opsProblemSafe(doc: Y.Doc, decoded: DecodedUpdate, layoutId: string, who: OpsSender): string | null {
  try {
    return opsProblem(doc, decoded, layoutId, who);
  } catch (err) {
    let runs = true;
    try {
      runs = sessionRuns(doc);
    } catch {
      /* can't tell: refuse */
    }
    if (who.role === 'viewer' || runs) return `it can’t be checked against the running session (${String(err).slice(0, 80)})`;
    return null;
  }
}
