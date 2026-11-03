// Fuzz target "guard": the input is one update or state vector, as the
// guard sees it on the wire (ws/updateGuard.ts).
//
//   - the guard answers (refused or not) within the time budget, and never
//     throws;
//   - an update it takes and Yjs reads, applied to a document of its own the
//     way the server applies one, leaves a document and relays updates the
//     desktop's guard takes (no clock past 2^31 - 1, within its work limit);
//   - a state vector it takes is answered (sync step 2) with an update the
//     desktop takes.

import * as Y from 'yjs';
import { checkStateVector, checkUpdate, updateClientBlocks } from '../ws/updateGuard.js';
import { decodeIncoming } from '../ws/decoded.js';
import { MAX_UPDATE_WORK, yjsWork } from '../ws/yjsWork.js';
import { clocksInRange, desktopReads, fail, fromHex, timed, updateGuardContract } from './common.js';

let answering: Y.Doc | null = null;

/** The document a state vector is answered from: the drawing-settings contract's room. */
function answeringDoc(): Y.Doc {
  if (!answering) {
    answering = new Y.Doc();
    Y.applyUpdate(answering, fromHex(updateGuardContract().drawingSettings.base));
  }
  return answering;
}

export function fuzzGuard(data: Uint8Array): void {
  updateGuardContract();
  const why = timed('the update guard', () => checkUpdate(data));
  const svWhy = timed('the state vector guard', () => checkStateVector(data));
  const blocks = updateClientBlocks(data);
  if ((blocks === null) !== (why !== null)) fail('updateClientBlocks and checkUpdate disagree on whether the update can be read');

  if (svWhy === null) {
    // writeSyncStep2: the server's answer to sync step 1.
    let answer: Uint8Array | null = null;
    timed('answering the state vector', () => {
      try {
        answer = Y.encodeStateAsUpdate(answeringDoc(), data);
      } catch {
        /* the handler drops a message it can't answer */
      }
    });
    if (answer) desktopReads(answer, 'the answer to a state vector', null);
  }

  if (why !== null) return;
  const decoded = timed('decoding it', () => decodeIncoming(data));
  if (!decoded) return; // Yjs refuses it on its own
  if (yjsWork(null, decoded) > MAX_UPDATE_WORK) return; // refused for its work
  const doc = new Y.Doc();
  const relayed: Uint8Array[] = [];
  doc.on('update', (u: Uint8Array) => relayed.push(u));
  try {
    timed('applying it', () => {
      try {
        Y.applyUpdate(doc, data);
      } catch {
        /* the handler logs it; what Yjs integrated before it threw is still relayed */
      }
    });
    clocksInRange(doc, 'the document it makes');
    for (const u of relayed) desktopReads(u, 'the update relayed for it', null);
    desktopReads(Y.encodeStateAsUpdate(doc), 'the document it makes', null);
  } finally {
    doc.destroy();
  }
}
