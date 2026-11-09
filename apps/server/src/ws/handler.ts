// y-websocket protocol handler. Routes the standard message types over
// a single WebSocket per (layout, client):
//
//   message-type   payload                  reply (server)
//   ──────────────────────────────────────────────────────────────────
//   sync          encoding/decoding via    sync step 2 + any local
//                 y-protocols/sync         updates the client is missing
//   awareness     awareness updates        broadcast to other clients
//
// Reference: y-websocket's bin/utils.js and the y-protocols documentation.
// This file is small because Yjs's protocol library does the heavy lifting.

import type { WebSocket } from '@fastify/websocket';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { DocSession } from './docHub.js';
import { CLOSE_LAYOUT_GONE, MAX_AWARENESS_BYTES, docHub } from './docHub.js';
import {
  MESSAGE_AWARENESS,
  MESSAGE_SYNC,
  encodeAwarenessUpdate,
  sendBytes,
} from './protocol.js';
import { resolveResourceRole } from '../access/resolveResourceRole.js';
import { isCredentialActive, revokedReason, type Credential } from '../auth/credentials.js';
import { writeAuditEvent } from '../audit/writeAuditEvent.js';
import { checkIncomingDecoded, type MergeCheck } from './mergeGuard.js';
import { checkStateVector, checkUpdate } from './updateGuard.js';
import {
  MAX_PENDING_BYTES,
  MAX_PENDING_DS_BYTES,
  copyPayer,
  mayLeaveForeignWaits,
  newForeignWaits,
  noteForeignWaits,
  pendingBytes,
  pendingDsBytes,
  restorePending,
  savePending,
} from './pending.js';
import { newPace, workBudget, type Pace } from './pacing.js';
import { concerns, onAccessChanged, suspendedIn } from './liveAccess.js';
import { COPY_BUDGET_SPENT, checkGridSizesDecoded, heldValueProblem } from './gridGuard.js';
import { backgroundUrlProblem } from './backgroundGuard.js';
import { decodeIncoming, guardWork, type DecodedUpdate } from './decoded.js';
import { MAX_HELD_UPDATES, deletesPresent, waitsOn } from './held.js';
import { MAX_UPDATE_WORK, yjsWork } from './yjsWork.js';
import { deviceName } from '../auth/session.js';

/**
 * Close code and reason for an update refused because it would merge
 * another layout into this one (ws/mergeGuard.ts). 1008 is a close both
 * apps already treat as final: the desktop stops reconnecting and keeps
 * its copy as an unsaved file, the web says so instead of retrying, so the
 * same update isn't sent again and again.
 */
export const CLOSE_MERGE_REFUSED = 1008;
export const MERGE_REFUSED_REASON = 'layout_merge_refused';

/**
 * Close reason for an update refused because the apps can't read it
 * (ws/updateGuard.ts: the desktop's own check), or because it depends on
 * more changes the layout doesn't have than a room holds (ws/pending.ts).
 * The same 1008 as above, so neither app sends it again; the name is the
 * one the desktop gives an update it can't read.
 */
export const UPDATE_REFUSED_REASON = 'unreadable_update';

/**
 * How often we re-check whether the connected user still has access to
 * this layout (and that their session / token is still live). Catches
 * the "admin removes a collaborator while they're editing" case so a
 * removed user can't keep editing until they refresh. 30s is short
 * enough that real users barely notice; long enough that the database
 * load is negligible. Mutable only so tests can shorten it.
 */
export const wsTiming = { revalidateMs: 30_000 };

export interface WsAuth {
  /** Credential the socket authenticated with; re-checked periodically. */
  credential?: Credential | undefined;
  /**
   * Cap the connection at viewer regardless of the user's layout role —
   * an API token without the `layouts:write` scope.
   */
  readOnly?: boolean;
  /** Who is on the other end, for the audit log: the User-Agent. */
  client?: string | undefined;
}

/** Where a refused or flagged update came from, for the log and the audit. */
export interface Sender {
  layoutId: string;
  userId: string;
  client: string;
  credential?: Credential | undefined;
  /** What this connection has already logged or audited: each once per connection. */
  noted: Set<string>;
  /** How fast this connection may send (ws/pacing.ts). */
  pace: Pace;
}

/** Close code and reason for a connection sending faster than ws/pacing.ts allows: "try again later". */
export const CLOSE_SLOW_DOWN = 1013;
export const SLOW_DOWN_REASON = 'slow_down';

/**
 * Per-connection lifecycle. The handler does NOT close the WS itself;
 * callers handle close + access denial. Returns the function to call when
 * the socket disconnects (cleans up listeners and detaches from the hub).
 *
 * `role` is the user's resolved role on this layout. Viewers receive the
 * full sync stream (so they can see live edits) and may send sync step 1
 * (the "what am I missing?" request that makes the server answer with the
 * doc), but the server drops any sync step 2 / update they send —
 * preventing a hostile viewer from corrupting the doc. Awareness updates
 * are still accepted from viewers (their own presence only, see
 * DocSession.applyClientAwareness): cursor/selection is cosmetic.
 *
 * Persisting and broadcasting doc / awareness updates is done ONCE per
 * layout by the DocSession (see DocSession.startBroadcasting); this
 * function only wires the per-socket message handling and bookkeeping.
 */
export async function attachWsHandlers(
  ws: WebSocket,
  layoutId: string,
  userId: string,
  role: 'owner' | 'editor' | 'viewer' = 'editor',
  auth: WsAuth = {},
): Promise<() => Promise<void>> {
  const { credential, readOnly = false } = auth;
  const sender: Sender = { layoutId, userId, client: auth.client ?? '', credential, noted: new Set(), pace: newPace() };
  // A suspended person, or a suspended owner's layout, is read-only; checked
  // again with the role (below).
  const [suspendedNow, session] = await Promise.all([suspendedIn(userId, layoutId), docHub.getOrCreate(layoutId)]);
  let suspended = suspendedNow;
  const cap = (r: 'owner' | 'editor' | 'viewer') => (readOnly || suspended ? 'viewer' : r);
  docHub.attach(session, ws, userId);
  if (session.closed) {
    // The layout was deleted between hydrate and attach.
    ws.close(CLOSE_LAYOUT_GONE, 'layout_deleted');
    return async () => {
      await docHub.detach(session, ws);
    };
  }

  // 1. Send the current state to the new client (sync step 1).
  sendSyncStep1(ws, session);

  // 2. Send the current awareness so the new client knows about peers.
  if (session.awareness.getStates().size > 0) {
    sendBytes(
      ws,
      encodeAwarenessUpdate(session.awareness, [...session.awareness.getStates().keys()]),
    );
  }

  // 3. Doc and awareness updates (persist + fan-out) are handled by the
  //    session's single listeners.

  // 4. Wire up message handling.
  let currentRole = cap(role);
  ws.on('message', (data: Buffer) => {
    // Nothing more is read from a connection being closed (what follows a
    // refused update, a revoked sign-in's last messages).
    if (ws.readyState !== ws.OPEN) return;
    // Pacing (ws/pacing.ts): past it the connection is closed with 1013
    // "try again later"; both apps reconnect and their sync step 2 brings
    // whatever was not taken, so nothing is lost.
    if (!sender.pace.messages.take(1) || !sender.pace.bytes.take(data.length)) {
      slowDown(ws, session, sender, data.length);
      return;
    }
    try {
      handleMessage(ws, session, new Uint8Array(data), currentRole, sender);
    } catch {
      // Drop malformed messages silently — Yjs protocol errors should
      // never propagate to the client.
    }
  });

  // 5. Access checks: every revalidateMs, and at once when a route changes
  //    who may open this layout (ws/liveAccess.ts). A removed user is
  //    disconnected; a downgraded or suspended one is held to viewer.
  const checkOnce = async (): Promise<void> => {
    // The session / token may have expired or been revoked (logout
    // elsewhere, admin "revoke all", token revoked on the Devices page)
    // without us hearing about it.
    if (credential !== undefined && !(await isCredentialActive(credential))) {
      ws.close(1008, revokedReason(credential));
      return;
    }
    const { role: refreshedRole } = await resolveResourceRole(userId, 'layout', layoutId);
    if (refreshedRole === null) {
      // Access revoked. Close with our "not_found" code so the client
      // surfaces the same error as a stale page reload would.
      ws.close(4404, 'access_revoked');
      return;
    }
    suspended = await suspendedIn(userId, layoutId);
    // Role downgraded (or upgraded), or suspended: later messages are
    // handled at the new tier. The user still has access, so the
    // connection stays; the editor's UI catches up when it refetches the
    // layout.
    currentRole = cap(refreshedRole);
  };
  let checking = false;
  let checkAgain = false;
  const check = async (): Promise<void> => {
    if (checking) {
      checkAgain = true;
      return;
    }
    checking = true;
    try {
      do {
        checkAgain = false;
        try {
          await checkOnce();
        } catch {
          /* DB transient — try again next time */
        }
      } while (checkAgain);
    } finally {
      checking = false;
    }
  };
  const revalidateTimer = setInterval(() => void check(), wsTiming.revalidateMs);
  const stopListening = onAccessChanged((c) => {
    if (concerns(c, userId, layoutId)) void check();
  });

  return async () => {
    clearInterval(revalidateTimer);
    stopListening();
    // Remove this client's own awareness entries (only those it still
    // owns) so others see them disappear.
    const owned = session.releaseAwareness(ws);
    if (owned.length > 0 && !session.closed) {
      awarenessProtocol.removeAwarenessStates(session.awareness, owned, ws);
    }
    await docHub.detach(session, ws);
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * One message from a connection that is open and within its pace (the
 * socket's 'message' listener above). Exported for the fuzz harness
 * (src/fuzz/room.ts), which sends it messages the way that listener does.
 */
export function handleMessage(
  ws: WebSocket,
  session: DocSession,
  msg: Uint8Array,
  role: 'owner' | 'editor' | 'viewer',
  sender: Sender,
): void {
  const decoder = decoding.createDecoder(msg);
  const messageType = decoding.readVarUint(decoder);
  switch (messageType) {
    case MESSAGE_SYNC: {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      const syncType = decoding.readVarUint(decoder);
      if (syncType === syncProtocol.messageYjsSyncStep1) {
        // A read ("send me what I'm missing"): how every client, viewers
        // included, gets the document at all. One no app writes is dropped.
        // Answered a few times per connection, then at most every
        // step1EveryMs (ws/pacing.ts): the apps ask once per connection.
        const stateVector = decoding.readVarUint8Array(decoder);
        if (checkStateVector(stateVector) !== null) return;
        if (!sender.pace.step1.take(1)) return;
        syncProtocol.writeSyncStep2(encoder, session.doc, stateVector);
      } else if (syncType === syncProtocol.messageYjsSyncStep2 || syncType === syncProtocol.messageYjsUpdate) {
        // The client's own state / edits: write paths. A viewer's are
        // dropped (a hostile viewer can't corrupt the doc).
        if (role === 'viewer') return;
        const update = decoding.readVarUint8Array(decoder);
        // Checked before it is applied, so a refused one leaves the doc as
        // it was: first that both apps can read it, then what it holds.
        const unreadable = checkUpdate(update);
        if (unreadable !== null) {
          refuseUpdate(ws, session, sender, update.length, 'unreadable', unreadable);
          return;
        }
        // Decoded once for the checks that read its structs (ws/decoded.ts).
        // One Yjs can't decode passes them; Yjs refuses it on its own below.
        const decoded = decodeIncoming(update);
        // What applying it costs (ws/yjsWork.ts): within a limit per
        // update, and per person (ws/pacing.ts workBudget: past it, they slow down).
        if (decoded) {
          const work = yjsWork(session.doc, decoded);
          if (work > MAX_UPDATE_WORK) {
            refuseUpdate(ws, session, sender, update.length, 'unreadable', `applying it would take ${work} steps, more than ${MAX_UPDATE_WORK}`);
            return;
          }
          const allowance = workBudget(sender.userId);
          if (!allowance.available()) {
            slowDown(ws, session, sender, update.length);
            return;
          }
          allowance.charge(work);
        }
        // One that would leave some of it waiting for an earlier edit and
        // delete something the room has is held whole until that edit
        // arrives (ws/held.ts), then checked and applied as one.
        if (decoded && holdIfEarly(ws, session, sender, update, decoded)) return;
        if (takeUpdate(ws, session, sender, update, decoded)) landHeld(session);
      }
      if (encoding.length(encoder) > 1) {
        sendBytes(ws, encoding.toUint8Array(encoder));
      }
      break;
    }
    case MESSAGE_AWARENESS: {
      // Presence: only this connection's own entries, within limits (DocSession.applyClientAwareness).
      const update = decoding.readVarUint8Array(decoder);
      if (update.length > MAX_AWARENESS_BYTES) return;
      session.applyClientAwareness(ws, update);
      break;
    }
    default:
      // Unknown message type — ignore.
      break;
  }
}

/**
 * The checks of an update that read the room (grid and drawing settings,
 * merges), applying it, and the limits on what it leaves waiting: for one
 * that just arrived, and for one held until the edit before it arrived
 * (landHeld). False when it was refused (the connection is then closed).
 */
function takeUpdate(ws: WebSocket, session: DocSession, sender: Sender, update: Uint8Array, decoded: DecodedUpdate | null): boolean {
  // The few it works out on a copy of the layout count against the
  // sender's copy budget (ws/pacing.ts): past it, they slow down. One
  // that lands changes waiting on another editor counts against the
  // room's and theirs instead (ws/pending.ts copyPayer).
  const payer = copyPayer(session.doc, decoded, sender.userId);
  const copied = guardWork.copyBytes;
  const badGrid = decoded ? checkGridSizesDecoded(session.doc, update, decoded, payer.available) : null;
  payer.charge(guardWork.copyBytes - copied);
  if (badGrid === COPY_BUDGET_SPENT) {
    slowDown(ws, session, sender, update.length);
    return false;
  }
  if (badGrid !== null) {
    refuseUpdate(ws, session, sender, update.length, 'unreadable', badGrid);
    return false;
  }
  // The background picture only ever comes from this server (backgroundGuard.ts).
  const badBackground = decoded ? backgroundUrlProblem(session.doc, session.layoutId, decoded) : null;
  if (badBackground !== null) {
    refuseUpdate(ws, session, sender, update.length, 'unreadable', badBackground);
    return false;
  }
  const check = checkIncomingDecoded(session.doc, update, decoded);
  if (check.refuse) {
    refuseMerge(ws, session, sender, check);
    return false;
  }
  if (check.suspicious) flagUpdate(session, sender, check);
  const pending = savePending(session.doc);
  try {
    // Origin = this socket, so our own broadcasts skip this client.
    Y.applyUpdate(session.doc, update, ws);
  } catch (err) {
    if (once(sender, 'apply_error')) {
      console.error(
        `[ws] could not apply an update to layout ${session.layoutId} from user ${sender.userId} ` +
          `(${sender.client || 'unknown client'}; later ones from this connection aren't logged): ${String(err)}`,
      );
    }
  }
  // What it left waiting for changes the room doesn't have is kept up
  // to a limit (ws/pending.ts), with the updates the room holds back
  // (ws/held.ts). Past it, what this update left goes; what it
  // integrated stays (stored and sent like any edit).
  const nowPending = pendingBytes(session.doc);
  if (nowPending + session.held.bytes > MAX_PENDING_BYTES && nowPending > pending.bytes) {
    restorePending(session.doc, pending);
    refuseUpdate(ws, session, sender, update.length, 'incomplete', `it leaves ${nowPending} bytes waiting for changes the layout doesn't have`);
    return false;
  }
  // Deletions waiting are read again with every update: far less of them.
  const nowDs = pendingDsBytes(session.doc);
  if (nowDs > MAX_PENDING_DS_BYTES && nowDs > (pending.ds?.length ?? 0)) {
    restorePending(session.doc, pending);
    refuseUpdate(ws, session, sender, update.length, 'incomplete', `it leaves ${nowDs} bytes of deletions waiting for changes the layout doesn't have`);
    return false;
  }
  // Changes left waiting on another editor's: only while the room's
  // budget for them lasts (ws/pending.ts), and on whoever left them.
  const foreign = newForeignWaits(session.doc, pending, decoded);
  if (foreign.length > 0) {
    if (!mayLeaveForeignWaits(session.doc)) {
      restorePending(session.doc, pending);
      refuseUpdate(ws, session, sender, update.length, 'incomplete', 'it leaves changes waiting for another editor\'s, past what the layout takes for now');
      return false;
    }
    noteForeignWaits(session.doc, foreign, sender.userId);
  }
  return true;
}

/**
 * Hold `update` back if some of it would wait for an earlier edit the room
 * doesn't have and it deletes something the room has (ws/held.ts): applied
 * now, the deletion would land before what replaces it. True when it was
 * held or refused. A drawing setting it writes out of range, where that can
 * be told now, is refused at once; the rest is checked when it lands.
 */
function holdIfEarly(ws: WebSocket, session: DocSession, sender: Sender, update: Uint8Array, decoded: DecodedUpdate): boolean {
  const waitsFor = waitsOn(session.doc, decoded);
  if (!waitsFor || !deletesPresent(session.doc, decoded.ds)) return false;
  const bad = heldValueProblem(session.doc, decoded);
  if (bad !== null) {
    refuseUpdate(ws, session, sender, update.length, 'unreadable', bad);
    return true;
  }
  const { held } = session;
  if (held.count >= MAX_HELD_UPDATES || held.bytes + pendingBytes(session.doc) + update.length > MAX_PENDING_BYTES) {
    // Past what a room holds: "try again later". The app reconnects and its
    // sync step 2 brings this and the edit it waits for together.
    closeSlowDown(ws, session);
    if (once(sender, 'held_full')) {
      console.warn(
        `[ws] closed a connection to layout ${session.layoutId} from user ${sender.userId} (${sender.client || 'unknown client'}): ` +
          `the room holds ${held.count} updates (${held.bytes} bytes) waiting for the edits before them`,
      );
    }
    return true;
  }
  held.add({ client: ws, sender, update, decoded, waitsFor });
  return true;
}

/** Apply the held updates whose earlier edits have now arrived (each may let others land). */
function landHeld(session: DocSession): void {
  for (let entry = session.held.takeReady(session.doc); entry; entry = session.held.takeReady(session.doc)) {
    const ws = entry.client as WebSocket;
    if (ws.readyState !== ws.OPEN || !session.clients.has(ws)) continue;
    takeUpdate(ws, session, entry.sender, entry.update, entry.decoded);
  }
}

/**
 * What an audit event says about the sender's app: "Desktop app 2.0.12" or
 * a rough browser name ("Firefox on Linux"), never the user agent, which
 * the layout's viewers can read (docs/PRIVACY-DATA.md).
 */
export function auditClient(userAgent: string): string | null {
  const desktop = /(?:Collaborative)?BrickLayoutDesigner\/(\S+)/.exec(userAgent);
  if (desktop) return `Desktop app ${desktop[1]}`;
  return deviceName(userAgent || undefined);
}

function mergePayload(sender: Sender, check: MergeCheck): Record<string, unknown> {
  return {
    client: auditClient(sender.client),
    via: sender.credential?.kind ?? null,
    updateBytes: check.updateBytes,
    foreignLayers: check.foreignLayers,
    unseenClients: check.unseenClients,
    layoutLayers: check.docLayers,
  };
}

/**
 * The update would merge another layout's layers into this one: drop it
 * whole, end this connection with a reason both apps know, and say so in
 * the log and the audit.
 */
function refuseMerge(ws: WebSocket, session: DocSession, sender: Sender, check: MergeCheck): void {
  session.held.drop(ws);
  console.warn(
    `[ws] refused an update to layout ${session.layoutId} from user ${sender.userId} (${sender.client || 'unknown client'}): ` +
      `it adds ${check.foreignLayers} layer entries from another layout (${check.updateBytes} bytes, ` +
      `${check.unseenClients} unseen clients; the layout has ${check.docLayers} layers)`,
  );
  try {
    ws.close(CLOSE_MERGE_REFUSED, MERGE_REFUSED_REASON);
  } catch {
    /* already closed */
  }
  writeAuditEvent({
    layoutId: session.layoutId,
    userId: sender.userId,
    eventType: 'layout_merge_refused',
    payload: mergePayload(sender, check),
  }).catch((err) => console.error('[ws] could not write the layout_merge_refused audit event', err));
}

/** Sending faster than ws/pacing.ts allows: close with 1013 "try again later" (the apps reconnect), logged once. */
function slowDown(ws: WebSocket, session: DocSession, sender: Sender, bytes: number): void {
  closeSlowDown(ws, session);
  if (!once(sender, 'slow_down')) return;
  console.warn(
    `[ws] closed a connection to layout ${session.layoutId} from user ${sender.userId} (${sender.client || 'unknown client'}): ` +
      `it sent faster than allowed (last message ${bytes} bytes)`,
  );
}

/** Close with 1013 "try again later"; what the connection held back goes (its next sync step 2 brings it again). */
function closeSlowDown(ws: WebSocket, session: DocSession): void {
  session.held.drop(ws);
  try {
    ws.close(CLOSE_SLOW_DOWN, SLOW_DOWN_REASON);
  } catch {
    /* already closed */
  }
}

/** True the first time this connection notes `what`. */
function once(sender: Sender, what: string): boolean {
  if (sender.noted.has(what)) return false;
  sender.noted.add(what);
  return true;
}

/**
 * The update can't be read by both apps, or leaves too much waiting for
 * changes the layout doesn't have: drop it, end this connection with a
 * reason both apps treat as final, and say so once in the log and the audit.
 */
function refuseUpdate(
  ws: WebSocket,
  session: DocSession,
  sender: Sender,
  updateBytes: number,
  kind: 'unreadable' | 'incomplete',
  why: string,
): void {
  session.held.drop(ws);
  try {
    ws.close(CLOSE_MERGE_REFUSED, UPDATE_REFUSED_REASON);
  } catch {
    /* already closed */
  }
  if (!once(sender, 'update_refused')) return;
  console.warn(
    `[ws] refused an update to layout ${session.layoutId} from user ${sender.userId} (${sender.client || 'unknown client'}): ${why} (${updateBytes} bytes)`,
  );
  writeAuditEvent({
    layoutId: session.layoutId,
    userId: sender.userId,
    eventType: 'layout_update_refused',
    payload: { client: auditClient(sender.client), via: sender.credential?.kind ?? null, updateBytes, kind, why },
  }).catch((err) => console.error('[ws] could not write the layout_update_refused audit event', err));
}

/** Applied, but unusual enough for the admins to see (mergeGuard.ts); once per connection. */
function flagUpdate(session: DocSession, sender: Sender, check: MergeCheck): void {
  if (!once(sender, 'merge_suspected')) return;
  console.warn(
    `[ws] layout ${session.layoutId}: an update from user ${sender.userId} (${sender.client || 'unknown client'}) ` +
      `brings items from ${check.unseenClients} clients this layout has never seen (${check.updateBytes} bytes); applied`,
  );
  writeAuditEvent({
    layoutId: session.layoutId,
    userId: sender.userId,
    eventType: 'layout_merge_suspected',
    payload: mergePayload(sender, check),
  }).catch((err) => console.error('[ws] could not write the layout_merge_suspected audit event', err));
}

function sendSyncStep1(ws: WebSocket, session: DocSession): void {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, session.doc);
  sendBytes(ws, encoding.toUint8Array(encoder));
}
