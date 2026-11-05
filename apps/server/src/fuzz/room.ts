// Fuzz target "room": the input is a room to start from and a run of
// y-websocket messages from up to four connections, each handled by the
// live handler (ws/handler.ts handleMessage) the way a socket's messages
// are. That covers the update guard, the work, grid and drawing-settings
// and merge guards, applying to the room (pending structs included), sync
// step 1 and 2, and presence.
//
// Input: byte 0 picks the room (roomStates), byte 1 makes connection i a viewer
// when bit i is set; then messages, each a byte whose low two bits name the
// connection, a length (lib0 varUint, cut to what is left) and that many
// bytes. A message of length 0 reconnects that connection.
//
// What must hold, after every message:
//   - handling it takes less than the time budget, and throws only when it
//     left the room as it was;
//   - a connection is only ever closed with a code and reason both apps
//     know (1008 unreadable_update / layout_merge_refused, 1013 slow_down);
//   - a viewer changes nothing;
//   - every update relayed to the other connections, and every answer to
//     sync step 1, passes the desktop's guard and work limit, and a desktop
//     that only ever got the relayed updates applies each of them;
//   - what waits for missing changes stays within its limits, with the
//     updates held back until the edit before them arrives (ws/held.ts);
//   - no drawing setting or grid size is out of range that wasn't already;
//   - presence entries carry the sender's own user id, at most
//     MAX_AWARENESS_IDS per connection;
//   - the grid guard's exact answer, when it gives one, never takes what
//     the answer worked out on a copy refuses (on the smaller rooms).
// And at the end:
//   - the whole room passes the desktop's guard (a desktop opening it);
//   - the desktop that only got relayed updates holds the same state;
//   - the room reopens from its snapshot, and from the update log the server
//     stored, to the same state (see reopen for the one difference allowed);
//   - the room stays usable: an editor who syncs it can edit it, and a
//     client's shape-2 conversion (rulersInPlace, an area's offset) is taken
//     when the room held no drawing problems.

import './env.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import type { WebSocket } from '@fastify/websocket';
import { readBbm } from '@cld/bbm';
import { bbmToDoc, rulersInPlace, markShapeInPlace, cellOffsetOf } from '@cld/ydoc';
import { DocSession, MAX_AWARENESS_IDS } from '../ws/docHub.js';
import { handleMessage, type Sender } from '../ws/handler.js';
import { newPace, resetCopyBudgets } from '../ws/pacing.js';
import { MAX_PENDING_BYTES, MAX_PENDING_DS_BYTES, pendingBytes, pendingDsBytes } from '../ws/pending.js';
import { MAX_HELD_UPDATES } from '../ws/held.js';
import { checkUpdate } from '../ws/updateGuard.js';
import { decodeIncoming } from '../ws/decoded.js';
import { UNSURE, checkGridSizesOnCopy, drawingProblems, exactVerdict } from '../ws/gridGuard.js';
import { PropertyFailure, clocksInRange, desktopReads, fail, fromHex, fuzzData, serverDir, stateKey, timed, updateGuardContract } from './common.js';

// ---- rooms ------------------------------------------------------------------

/** A layout read from a .bbm fixture, written by one client (so its bytes are the same every run). */
function bbmRoom(file: string, client: number): Uint8Array {
  const doc = new Y.Doc();
  doc.clientID = client;
  bbmToDoc(readBbm(readFileSync(resolve(serverDir(), '../../packages/bbm/tests/fixtures', file), 'utf8')).map, doc);
  return Y.encodeStateAsUpdate(doc);
}

/** The drawing-settings room after a client's shape-2 conversion (rulers as maps, an area offset). */
function shape2Room(base: Uint8Array): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, base);
  doc.clientID = 106;
  convertShape(doc);
  return Y.encodeStateAsUpdate(doc);
}

/** What a client's first ruler edit and area move do to a shape-1 layout (@cld/ydoc shape.ts). */
export function convertShape(doc: Y.Doc): void {
  let layerData: Y.Map<unknown>;
  try {
    layerData = doc.getMap('layerData');
    doc.getMap('meta');
  } catch {
    return; // the input made one of them something other than a map
  }
  for (const layer of [...layerData.values()]) {
    if (!(layer instanceof Y.Map)) continue;
    if (layer.get('rulerItems') instanceof Y.Array) rulersInPlace(doc, layer);
    if (layer.get('areas') instanceof Y.Array) {
      markShapeInPlace(doc);
      const off = cellOffsetOf(layer);
      doc.transact(() => layer.set('cellOffset', { x: off.x + 1, y: off.y }));
    }
  }
}

let rooms: Uint8Array[] | null = null;

/**
 * The rooms an input starts from: empty; a small layout and a large one read
 * from .bbm files; the contract's grid and drawing-settings rooms; that one
 * after a shape-2 conversion; and a layout as the desktop (yrs) writes it.
 */
export function roomStates(): Uint8Array[] {
  if (rooms) return rooms;
  const c = updateGuardContract();
  const drawing = fromHex(c.drawingSettings.base);
  rooms = [
    Y.encodeStateAsUpdate(new Y.Doc()),
    bbmRoom('oracle/sleepers.bbm', 101),
    fromHex(c.gridSize.base),
    drawing,
    shape2Room(drawing),
    bbmRoom('tight-corner.bbm', 104),
    new Uint8Array(readFileSync(fuzzData('seeds', 'desktop-tight-corner.ydoc'))),
  ];
  return rooms;
}

// ---- connections --------------------------------------------------------------

const USERS = ['alice', 'bob', 'alice', 'carol'] as const;
const CLOSES = new Set(['1008 unreadable_update', '1008 layout_merge_refused', '1013 slow_down']);

/** A socket as the handler sees it, keeping what it was sent and how it was closed. */
class FakeSocket {
  readonly OPEN = 1;
  readyState = 1;
  sent: Uint8Array[] = [];
  closed: string | null = null;
  send(bytes: Uint8Array): void {
    if (this.readyState !== this.OPEN) fail('the server sent on a closed socket');
    this.sent.push(bytes);
  }
  close(code?: number, reason?: string): void {
    if (this.closed !== null) return;
    this.closed = `${code} ${reason}`;
    this.readyState = 3;
  }
}

interface Conn {
  ws: FakeSocket;
  sender: Sender;
  role: 'editor' | 'viewer';
}

function connect(session: DocSession, i: number, role: Conn['role'], userId: string = USERS[i]!): Conn {
  const ws = new FakeSocket();
  session.clients.add(ws);
  session.clientUsers.set(ws, userId);
  return { ws, role, sender: { layoutId: session.layoutId, userId, client: `fuzz-${i}`, noted: new Set(), pace: newPace() } };
}

/** What the handler's cleanup does when a socket goes (handler.ts attachWsHandlers). */
function disconnect(session: DocSession, conn: Conn): void {
  const owned = session.releaseAwareness(conn.ws);
  if (owned.length > 0) awarenessProtocol.removeAwarenessStates(session.awareness, owned, conn.ws);
  session.clients.delete(conn.ws);
  session.clientUsers.delete(conn.ws);
  session.held.drop(conn.ws);
}

// ---- one input ------------------------------------------------------------------

/** A sync step 2 or update message's update, or null. */
function updateOf(msg: Uint8Array): Uint8Array | null {
  try {
    const d = decoding.createDecoder(msg);
    if (decoding.readVarUint(d) !== 0) return null;
    const t = decoding.readVarUint(d);
    if (t !== syncProtocol.messageYjsSyncStep2 && t !== syncProtocol.messageYjsUpdate) return null;
    return decoding.readVarUint8Array(d);
  } catch {
    return null;
  }
}

/** FUZZ_DEBUG=1: say what each message did (stderr), for working out a finding. */
const DEBUG = process.env.FUZZ_DEBUG === '1';

/** Grid checks on a copy smaller than this are compared with the exact answer. */
const DIFF_ROOM_BYTES = 64 * 1024;

/** How often the exact grid answer refused what the copy took (reported, not a failure). */
export const stats = { exactStricter: 0, messages: 0 };

/** The exact grid answer must not take what the copy refuses. */
function compareGridChecks(state: Uint8Array, update: Uint8Array): void {
  if (state.length > DIFF_ROOM_BYTES || checkUpdate(update) !== null) return;
  const decoded = decodeIncoming(update);
  if (!decoded) return;
  const copy = new Y.Doc();
  try {
    Y.applyUpdate(copy, state);
    const exact = exactVerdict(copy, update, decoded);
    if (exact === UNSURE) return;
    const onCopy = checkGridSizesOnCopy(copy, update);
    if (exact === null && onCopy !== null) fail(`the exact grid check takes an update the copy refuses (${onCopy})`);
    if (exact !== null && onCopy === null) stats.exactStricter += 1;
  } finally {
    copy.destroy();
  }
}

/** Parse the input into the room, the viewers and the messages. */
export function parseRoomInput(data: Uint8Array): { room: number; viewers: number; messages: [number, Uint8Array][] } {
  const room = data.length > 0 ? data[0]! : 0;
  const viewers = data.length > 1 ? data[1]! : 0;
  const messages: [number, Uint8Array][] = [];
  let p = 2;
  while (p < data.length && messages.length < 64) {
    const c = data[p++]! & 3;
    let len = 0;
    let scale = 1;
    for (let i = 0; i < 4 && p < data.length; i++) {
      const b = data[p++]!;
      len += (b & 0x7f) * scale;
      scale *= 128;
      if (b < 0x80) break;
    }
    len = Math.min(len, data.length - p);
    messages.push([c, data.subarray(p, p + len)]);
    p += len;
  }
  return { room, viewers, messages };
}

/** Encode messages in the input format (seeds.ts). */
export function encodeRoomInput(room: number, viewers: number, messages: [number, Uint8Array][]): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeUint8(enc, room);
  encoding.writeUint8(enc, viewers);
  for (const [c, m] of messages) {
    encoding.writeUint8(enc, c);
    encoding.writeVarUint(enc, m.length);
    encoding.writeUint8Array(enc, m);
  }
  return encoding.toUint8Array(enc);
}

/**
 * `allTaken`: the input is only what real clients send, so no connection
 * may be closed and nothing may be left held back at the end (the replay
 * test's check that the guards refuse no real edit).
 */
export function fuzzRoom(data: Uint8Array, { allTaken = false } = {}): void {
  const states = roomStates();
  const { room, viewers, messages } = parseRoomInput(data);
  const base = states[room % states.length]!;
  resetCopyBudgets();

  const session = new DocSession('fuzz-room');
  const mirror = new Y.Doc(); // a desktop that only ever gets what the room relays
  try {
    Y.applyUpdate(session.doc, base);
    Y.applyUpdate(mirror, base);
    const conns: Conn[] = [0, 1, 2, 3].map((i) => connect(session, i, viewers & (1 << i) ? 'viewer' : 'editor'));
    const seen = drawingProblems(session.doc);
    const startedClean = seen.size === 0;
    const log: Uint8Array[] = []; // what the server stores (DocSession.queuePersist)

    let relayed: Uint8Array[] = [];
    session.doc.on('update', (u: Uint8Array) => relayed.push(u));

    for (const [c, msg] of messages) {
      stats.messages += 1;
      if (msg.length === 0) {
        disconnect(session, conns[c]!);
        conns[c] = connect(session, c, conns[c]!.role);
        continue;
      }
      const conn = conns[c]!;
      // The socket's 'message' listener: nothing more from a closed one, then the pace.
      if (conn.ws.readyState !== conn.ws.OPEN) continue;
      if (!conn.sender.pace.messages.take(1) || !conn.sender.pace.bytes.take(msg.length)) {
        conn.ws.close(1013, 'slow_down');
        continue;
      }
      const update = conn.role === 'editor' ? updateOf(msg) : null;
      // (Only on the small rooms: the copy costs the room's size.)
      if (update && base.length <= DIFF_ROOM_BYTES) compareGridChecks(Y.encodeStateAsUpdate(session.doc), update);
      const sentBefore = conn.ws.sent.length;
      relayed = [];
      let threw: unknown = null;
      timed('handling a message', () => {
        try {
          handleMessage(conn.ws as unknown as WebSocket, session, msg, conn.role, conn.sender);
        } catch (err) {
          if (err instanceof PropertyFailure) throw err;
          threw = err;
        }
      });

      if (DEBUG) {
        const pending = session.doc.store.pendingStructs;
        process.stderr.write(
          `[room] c${c} ${conn.role} ${msg.length} bytes: closed ${conn.ws.closed ?? '-'}, relayed ${relayed.length}, threw ${threw === null ? '-' : String(threw)}, ` +
            `state ${stateKey(session.doc)}, pending ${pendingBytes(session.doc)} bytes waiting on ${JSON.stringify([...(pending?.missing ?? [])])}\n`,
        );
      }
      if (threw !== null && relayed.length > 0) fail(`handling a message threw after it changed the room: ${String(threw)}`);
      if (conn.ws.closed !== null && !CLOSES.has(conn.ws.closed)) fail(`a connection was closed with ${conn.ws.closed}`);
      if (allTaken) {
        // (An update held back lands with another connection's message: its own connection is the one refused.)
        for (const other of conns) if (other.ws.closed !== null) fail(`a real client's message was refused (${other.ws.closed})`);
      }
      if (conn.role === 'viewer' && relayed.length > 0) fail('a viewer changed the room');
      for (const u of relayed) {
        desktopReads(u, 'a relayed update', mirror);
        try {
          Y.applyUpdate(mirror, u);
        } catch (err) {
          fail(`a desktop could not apply a relayed update: ${String(err)}`);
        }
        log.push(u);
      }
      for (const out of conn.ws.sent.slice(sentBefore)) checkReply(out);
      if (pendingBytes(session.doc) > MAX_PENDING_BYTES) fail(`the room holds ${pendingBytes(session.doc)} bytes waiting`);
      if (pendingDsBytes(session.doc) > MAX_PENDING_DS_BYTES) fail(`the room holds ${pendingDsBytes(session.doc)} bytes of deletions waiting`);
      if (session.held.count > MAX_HELD_UPDATES) fail(`the room holds back ${session.held.count} updates`);
      if (session.held.bytes + pendingBytes(session.doc) > MAX_PENDING_BYTES) {
        fail(`the room holds back ${session.held.bytes} bytes, with ${pendingBytes(session.doc)} waiting`);
      }
      for (const holder of session.held.holders()) {
        const ws = holder as FakeSocket;
        if (ws.closed !== null || !session.clients.has(ws)) fail('the room holds back an update of a closed connection');
      }
      if (relayed.length > 0) {
        for (const p of drawingProblems(session.doc)) {
          if (!seen.has(p)) fail(`an update left ${p} out of range`);
        }
      }
      checkPresence(session);
    }

    if (allTaken && session.held.count > 0) fail(`${session.held.count} updates of real clients were never applied`);

    // ---- the room as a desktop opens it, and as the server reopens it ----
    const full = Y.encodeStateAsUpdate(session.doc);
    clocksInRange(session.doc, 'the room');
    desktopReads(full, 'the whole room', null);
    if (stateKey(mirror) !== stateKey(session.doc)) fail('a desktop that got every relayed update holds a different state');
    reopen(full, [], session.doc, 'its snapshot', true);
    reopen(base, log.length ? [Y.mergeUpdates(log)] : [], session.doc, 'its update log', false);

    // ---- still usable ----
    const editor = connect(session, 0, 'editor', 'honest');
    const client = new Y.Doc();
    try {
      Y.applyUpdate(client, full);
      const edits: Uint8Array[] = [];
      client.on('update', (u: Uint8Array) => edits.push(u));
      try {
        client.getMap('fuzzProbe').set('edit', 1);
      } catch {
        /* the input made fuzzProbe something other than a map */
      }
      if (startedClean && drawingProblems(client).size === 0) convertShape(client);
      for (const u of edits) {
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, 0);
        syncProtocol.writeUpdate(enc, u);
        relayed = [];
        timed('an editor\'s edit', () => handleMessage(editor.ws as unknown as WebSocket, session, encoding.toUint8Array(enc), 'editor', editor.sender));
        if (editor.ws.closed !== null) fail(`the room refused a client's edit after the input (${editor.ws.closed})`);
      }
      if (Y.getState(session.doc.store, client.clientID) !== Y.getState(client.store, client.clientID)) {
        fail('a client\'s edit after the input did not land');
      }
    } finally {
      client.destroy();
    }
  } finally {
    session.awareness.destroy();
    session.doc.destroy();
    mirror.destroy();
  }
}

/** What the server sends a connection: a sync step 2 the desktop reads, presence it can parse. */
function checkReply(out: Uint8Array): void {
  const d = decoding.createDecoder(out);
  const type = decoding.readVarUint(d);
  if (type === 0) {
    const t = decoding.readVarUint(d);
    const payload = decoding.readVarUint8Array(d);
    if (t === syncProtocol.messageYjsSyncStep2) desktopReads(payload, 'an answer to sync step 1', null);
  } else if (type === 1) {
    const a = decoding.createDecoder(decoding.readVarUint8Array(d));
    const n = decoding.readVarUint(a);
    for (let i = 0; i < n; i++) {
      decoding.readVarUint(a);
      decoding.readVarUint(a);
      JSON.parse(decoding.readVarString(a));
    }
  } else fail(`the server sent a message of type ${type}`);
}

/** Every presence entry is owned by a connection and carries that connection's user. */
function checkPresence(session: DocSession): void {
  for (const [id, state] of session.awareness.getStates()) {
    if (id === session.awareness.clientID) continue;
    const owner = session.awarenessOwners.get(id);
    const userId = owner === undefined ? undefined : session.clientUsers.get(owner);
    if (userId === undefined) fail(`presence entry ${id} has no owner`);
    const user = (state as { user?: { id?: unknown } }).user;
    if (user?.id !== userId) fail(`presence entry ${id} says it is ${String(user?.id)}, not ${userId}`);
  }
  for (const ids of session.clientAwarenessIds.values()) {
    if (ids.size > MAX_AWARENESS_IDS) fail(`a connection owns ${ids.size} presence entries`);
  }
}

/** The clients whose changes wait in `doc` (pending structs). */
function waitingClients(doc: Y.Doc): Set<number> {
  const p = doc.store.pendingStructs;
  return new Set(p ? Y.decodeUpdateV2(p.update).structs.map((st) => st.id.client) : []);
}

/**
 * The room reopened (DocSession.hydrate) from `snapshot` and `updates`
 * holds `room`'s state (besides what upgradeDoc adds on opening), and what
 * it holds passes the desktop's guard.
 *
 * From its snapshot, a client's changes that wait in the room may land:
 * the snapshot holds them merged with what the room has, and a waiting
 * change that starts inside a run the room has is written as its new tail,
 * placed after the room's last change of that run instead of where it
 * waited (Yjs mergeUpdates). Such a client may be further on reopened;
 * every other client must be where it was.
 */
function reopen(snapshot: Uint8Array, updates: Uint8Array[], room: Y.Doc, from: string, waitingMayLand: boolean): void {
  const again = new DocSession('fuzz-reopen');
  try {
    timed(`reopening the room from ${from}`, () => again.load(snapshot, updates));
    const own = again.doc.clientID;
    const was = new Map(Y.decodeStateVector(Y.encodeStateVector(room)));
    const now = new Map(Y.decodeStateVector(Y.encodeStateVector(again.doc)));
    const waiting = waitingMayLand ? waitingClients(room) : new Set<number>();
    for (const client of new Set([...was.keys(), ...now.keys()])) {
      if (client === own) continue;
      const a = was.get(client) ?? 0;
      const b = now.get(client) ?? 0;
      if (b < a || (b > a && !waiting.has(client))) fail(`the room reopened from ${from} holds client ${client} at ${b}, not ${a}`);
    }
    desktopReads(Y.encodeStateAsUpdate(again.doc), `the room reopened from ${from}`, null);
  } finally {
    again.awareness.destroy();
    again.doc.destroy();
  }
}
