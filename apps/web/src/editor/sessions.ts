// Operating sessions in the editor (Live Ops design 2.5, 4): the sessions
// and the log read from the doc, what you may move and flip in the running
// one (opsReach, the same rules the server holds everyone to), and the
// edits: make a session, its crew, start, pause, end and the next one, a
// job sent out and done, and the log. The desktop's src/edit/OpsSessionCommands.cpp
// does the same.

import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { OPS_JOBS_KEY, OPS_LOG_KEY, OPS_SESSIONS_KEY, readRecordsFromDoc, readSidecarCache, readPlacesFromDoc, ROLLING_STOCK_KEY, TRAINS_KEY, writeRecord } from '@cld/ydoc';
import {
  asJob,
  asLogEntry,
  asSession,
  opsReach,
  putBack,
  reachPlaces,
  runningSessions,
  sessionStart,
  SESSION_LIMITS,
  type CrewMember,
  type LogEntry,
  type OpsReach,
  type OpsSession,
} from '@cld/parts-catalog/browser';
import { makeId } from '@cld/ydoc';
import { LOCAL_ORIGIN } from './useLayoutDoc';

export interface SessionState {
  sessions: readonly OpsSession[];
  /** The session that runs ('' none). */
  running: OpsSession | null;
  /** The newest that isn't ended (to start or carry on), else null. */
  current: OpsSession | null;
  past: readonly OpsSession[];
  log: readonly LogEntry[];
  /** What you may move and flip now. */
  reach: OpsReach;
  /** The map's sheets are locked: a session runs. */
  locked: boolean;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The places as a role's reach covers them: a module's places, its parts; a layout's, its spots' track. */
function placesForReach(doc: Y.Doc) {
  const cache = readSidecarCache(doc);
  const modules = (Array.isArray(cache?.modules) ? (cache.modules as Record<string, unknown>[]) : []).map((m) => ({
    members: Array.isArray(m?.members) ? (m.members as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    places: Array.isArray(m?.places) ? (m.places as unknown[]).filter((p): p is { id: string } => !!p && typeof (p as { id?: unknown }).id === 'string') : [],
  }));
  return reachPlaces(modules, readPlacesFromDoc(doc));
}

export function readSessionState(doc: Y.Doc, userId: string, layoutId: string, owner: boolean): SessionState {
  const sessions = readRecordsFromDoc(doc, OPS_SESSIONS_KEY)
    .map((r) => asSession(r))
    .sort((a, b) => b.startedAt - a.startedAt || cmp(a.id, b.id));
  const running = runningSessions(sessions);
  const jobs = readRecordsFromDoc(doc, OPS_JOBS_KEY).map((r) => ({ ...asJob(r), status: r.status }));
  const reach = opsReach({ sessions, jobs, places: placesForReach(doc), userId, layoutId, owner });
  const log = readRecordsFromDoc(doc, OPS_LOG_KEY)
    .map((r) => asLogEntry(r))
    .sort((a, b) => a.at - b.at || cmp(a.id, b.id));
  return {
    sessions,
    running: running[0] ?? null,
    current: running[0] ?? sessions.find((s) => s.status !== 'ended') ?? null,
    past: sessions.filter((s) => s.status === 'ended'),
    log,
    reach,
    locked: running.length > 0,
  };
}

/** The session state, read again whenever the doc changes (anyone's edit). */
export function useLiveSessionState(doc: Y.Doc | null, userId: string, layoutId: string, owner: boolean): SessionState | null {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!doc) return;
    const on = () => setVersion((v) => v + 1);
    doc.on('update', on);
    return () => doc.off('update', on);
  }, [doc]);
  return useSessionState(doc, version, userId, layoutId, owner);
}

/** `version` changes when the doc does. */
export function useSessionState(doc: Y.Doc | null, version: unknown, userId: string, layoutId: string, owner: boolean): SessionState | null {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (doc ? readSessionState(doc, userId, layoutId, owner) : null), [doc, version, userId, layoutId, owner]);
}

/** The words for a role. */
export function roleName(role: string): string {
  return role === 'host' ? 'Host' : role === 'dispatcher' ? 'Dispatcher' : role === 'yardmaster' ? 'Yardmaster' : role === 'crew' ? 'Crew' : '';
}

/** "Session 12 running · you're the Yardmaster" */
export function bannerText(s: SessionState): string {
  if (!s.running) return '';
  const role = roleName(s.reach.role);
  return role ? `${s.running.name} running · you’re the ${role}` : `${s.running.name} running · you’re watching`;
}

/** Make a session to set up. One undo step. */
export function newSession(doc: Y.Doc, copyFrom: OpsSession | null = null, now = Date.now()): string {
  const id = `os-${makeId()}`;
  const n = readRecordsFromDoc(doc, OPS_SESSIONS_KEY).length + 1;
  const date = new Date(now).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  doc.transact(
    () =>
      writeRecord(doc, OPS_SESSIONS_KEY, {
        id,
        name: `Session ${n} — ${date}`,
        status: 'setup',
        seed: Math.floor((now / 1000) % 100000),
        layout: '',
        host: '',
        crew: copyFrom ? copyFrom.crew.map((c) => ({ ...c })) : [],
        clockFast: copyFrom?.clockFast ?? 0,
        clockStart: copyFrom?.clockStart ?? '',
        startedAt: 0,
        endedAt: 0,
        start: null,
      }),
    LOCAL_ORIGIN,
  );
  return id;
}

/** Change a session's name, crew or clock. One undo step. */
export function setSession(doc: Y.Doc, id: string, fields: Partial<Pick<OpsSession, 'name' | 'crew' | 'clockFast' | 'clockStart'>>): void {
  const plain = JSON.parse(JSON.stringify(fields)) as Record<string, unknown>;
  doc.transact(() => writeRecord(doc, OPS_SESSIONS_KEY, { id, ...plain }), LOCAL_ORIGIN);
}

/** A log entry, by you, for the running or paused session. Call inside the caller's transaction. */
export function writeLog(doc: Y.Doc, session: string, by: string, kind: string, what: string, from: unknown, to: unknown, note = '', now = Date.now()): void {
  if (by === '') return;
  const id = `log-${makeId()}`;
  writeRecord(doc, OPS_LOG_KEY, { id, session, at: now, by, kind, what: what.slice(0, 256), from: from ?? null, to: to ?? null, note: note.slice(0, 200) });
}

/** Start a session, or carry on a paused one: you are its host. One undo step. */
export function startSession(doc: Y.Doc, id: string, userId: string, layoutId: string, now = Date.now()): string | null {
  const all = readRecordsFromDoc(doc, OPS_SESSIONS_KEY).map((r) => asSession(r));
  const s = all.find((x) => x.id === id);
  if (!s || s.status === 'ended' || s.status === 'running') return null;
  if (runningSessions(all).length > 0) return 'A session is running already.';
  if (readRecordsFromDoc(doc, OPS_LOG_KEY).length >= SESSION_LIMITS.log) return 'The session log is full; remove a past session first.';
  doc.transact(() => {
    const fields: Record<string, unknown> = { id, status: 'running', host: userId, layout: layoutId };
    if (s.status === 'setup') {
      fields.startedAt = now;
      fields.start = JSON.parse(JSON.stringify(sessionStart(readRecordsFromDoc(doc, TRAINS_KEY), readRecordsFromDoc(doc, ROLLING_STOCK_KEY))));
    }
    writeRecord(doc, OPS_SESSIONS_KEY, fields as { id: string });
    // (A log entry is for a session that runs or is paused already: carrying on is logged, the start is the session's startedAt.)
    if (s.status === 'paused') writeLog(doc, id, userId, 'status', id, 'paused', 'running', '', now);
  }, LOCAL_ORIGIN);
  return null;
}

/** Pause the running session (the sheets can be changed again). One undo step. */
export function pauseSession(doc: Y.Doc, id: string, userId: string, now = Date.now()): void {
  doc.transact(() => {
    writeLog(doc, id, userId, 'status', id, 'running', 'paused', '', now);
    writeRecord(doc, OPS_SESSIONS_KEY, { id, status: 'paused' });
  }, LOCAL_ORIGIN);
}

/** End a session: leave the cars where they are, or put every car back where it started. One undo step. */
export function endSession(doc: Y.Doc, id: string, userId: string, carsBack: boolean, now = Date.now()): void {
  const s = readRecordsFromDoc(doc, OPS_SESSIONS_KEY).map((r) => asSession(r)).find((x) => x.id === id);
  if (!s) return;
  doc.transact(() => {
    if (carsBack && s.start) {
      const back = putBack(s.start, readRecordsFromDoc(doc, TRAINS_KEY), readRecordsFromDoc(doc, ROLLING_STOCK_KEY));
      for (const t of back.trains) writeRecord(doc, TRAINS_KEY, JSON.parse(JSON.stringify({ id: t.id, position: t.position, units: t.units })) as { id: string });
      for (const id2 of back.emptied) writeRecord(doc, TRAINS_KEY, { id: id2, units: [], emptiedAt: now });
      const stock = doc.getMap('meta').get(ROLLING_STOCK_KEY);
      for (const [car, cut] of Object.entries(back.cars)) {
        const rec = stock instanceof Y.Map ? stock.get(car) : undefined;
        if (rec instanceof Y.Map) rec.set('opsCut', cut);
      }
    }
    if (s.status === 'running' || s.status === 'paused') writeLog(doc, id, userId, 'status', id, s.status, 'ended', carsBack ? 'Every car put back' : '', now);
    writeRecord(doc, OPS_SESSIONS_KEY, { id, status: 'ended', endedAt: now });
  }, LOCAL_ORIGIN);
}

/** Send a job out, or mark it done (or waiting again). One undo step. */
export function setJobStatus(doc: Y.Doc, job: string, status: 'waiting' | 'out' | 'done', session: string, userId: string, now = Date.now()): void {
  doc.transact(() => {
    writeRecord(doc, OPS_JOBS_KEY, { id: job, status });
    if (session) writeLog(doc, session, userId, 'job', job, null, status, '', now);
  }, LOCAL_ORIGIN);
}

/** The next session: its crew and clock copied over; the cars stay where this one left them. */
export function nextSession(doc: Y.Doc, from: OpsSession): string {
  return newSession(doc, from);
}

/** A crew member to add (a guest has no account: the server gives them nothing, so they use this device). */
export function crewMember(userId: string, name: string, role: CrewMember['role']): CrewMember {
  return { userId, name, role, places: [], job: '' };
}
