// Operating sessions (Live Ops design 2.5, 4): who plays which role, what
// each role may move and flip while a session runs, the session's log, and
// putting cars back where the session started. Worked out from the records
// alone, so both apps and the server (apps/server/src/ws/opsGuard.ts) agree.
//
// A session's fields are flat, as waybills and jobs are; its crew is one
// plain list (replaced whole). A log entry is a record of its own in
// `meta.opsLog`, written once and never changed.
//
// What a role reaches, while the session runs:
//   - the host (who started it) and the layout's owner: every car and switch;
//   - the dispatcher: every car and switch;
//   - a yardmaster: the cuts standing on their yards (the yard's module, or
//     its spots' track for a place on loose track), and the switches there;
//   - a crew: while their job is out, their job's train anywhere, the cuts
//     standing at their job's stops, and the switches there. The main line
//     between stops is the dispatcher's.
// Nobody changes the map's sheets while a session runs; the host pauses it.
//
// The desktop's src/track/OpsSession.cpp is the twin; both check
// fixtures/contracts/ops-session.json.

import type { Job } from './ops.js';

/** A job as a session reads it: its stops and train, and its status (the record's `status` field, JOB_STATUSES). */
export type OpsJobRecord = Job & { status?: unknown };

export const SESSION_STATUSES = ['setup', 'running', 'paused', 'ended'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export const CREW_ROLES = ['dispatcher', 'yardmaster', 'crew'] as const;
export type CrewRole = (typeof CREW_ROLES)[number];
export const JOB_STATUSES = ['waiting', 'out', 'done'] as const;
export const LOG_KINDS = ['move', 'switch', 'status', 'job'] as const;

/** What the apps hold a layout to; the server takes twice the counts. */
export const SESSION_LIMITS = {
  sessions: 50,
  crew: 100,
  /** Log entries a layout keeps, every session's. */
  log: 20_000,
  /** One log entry, as JSON. */
  logSize: 2048,
  /** One session with its starting snapshot, as JSON. */
  size: 1024 * 1024,
  /** The fastest fast clock. */
  clockFast: 24,
} as const;

export interface CrewMember {
  /** The person's account; '' for someone on this device only (the server gives them nothing). */
  userId: string;
  name: string;
  role: CrewRole;
  /** A yardmaster's yards. */
  places: string[];
  /** A crew's job. */
  job: string;
}

/** Where cars were when the session started: each cut's place on the track and its cars, and each car's cut. */
export interface SessionStart {
  trains: Record<string, { position: unknown; units: unknown }>;
  cars: Record<string, string>;
}

export interface OpsSession {
  id: string;
  name: string;
  status: SessionStatus;
  seed: number;
  /** The layout it was started in: a copy of the layout gives its crew nothing. */
  layout: string;
  /** Who started it. */
  host: string;
  crew: CrewMember[];
  /** The fast clock's speed (4 = four minutes a minute); 0: none. */
  clockFast: number;
  /** The fast clock's time when the session started, "HH:MM". */
  clockStart: string;
  startedAt: number;
  endedAt: number;
  start: SessionStart | null;
}

export interface LogEntry {
  id: string;
  session: string;
  at: number;
  by: string;
  kind: string;
  /** A cut's id, a switch's key, or a job's id. */
  what: string;
  from: unknown;
  to: unknown;
  note: string;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function asCrew(v: unknown): CrewMember[] {
  if (!Array.isArray(v)) return [];
  const out: CrewMember[] = [];
  for (const c of v.slice(0, 2 * SESSION_LIMITS.crew)) {
    if (!isObj(c)) continue;
    const role = text(c.role) as CrewRole;
    if (!CREW_ROLES.includes(role)) continue;
    out.push({ userId: text(c.userId), name: text(c.name), role, places: Array.isArray(c.places) ? c.places.filter((p): p is string => typeof p === 'string') : [], job: text(c.job) });
  }
  return out;
}

function asStart(v: unknown): SessionStart | null {
  if (!isObj(v) || !isObj(v.trains) || !isObj(v.cars)) return null;
  const trains: SessionStart['trains'] = {};
  for (const [id, t] of Object.entries(v.trains)) if (isObj(t)) trains[id] = { position: t.position ?? null, units: t.units ?? [] };
  const cars: Record<string, string> = {};
  for (const [id, c] of Object.entries(v.cars)) cars[id] = text(c);
  return { trains, cars };
}

/** A saved session read back. */
export function asSession(r: Readonly<Record<string, unknown>>): OpsSession {
  const status = text(r.status) as SessionStatus;
  return {
    id: text(r.id),
    name: text(r.name),
    status: SESSION_STATUSES.includes(status) ? status : 'setup',
    seed: num(r.seed),
    layout: text(r.layout),
    host: text(r.host),
    crew: asCrew(r.crew),
    clockFast: Math.max(0, Math.min(SESSION_LIMITS.clockFast, num(r.clockFast))),
    clockStart: text(r.clockStart),
    startedAt: num(r.startedAt),
    endedAt: num(r.endedAt),
    start: asStart(r.start),
  };
}

/** A saved log entry read back. */
export function asLogEntry(r: Readonly<Record<string, unknown>>): LogEntry {
  return { id: text(r.id), session: text(r.session), at: num(r.at), by: text(r.by), kind: text(r.kind), what: text(r.what), from: r.from ?? null, to: r.to ?? null, note: text(r.note) };
}

/** A job's status ('waiting' when it has none). */
export function jobStatus(job: { status?: unknown }): string {
  const s = text(job.status);
  return (JOB_STATUSES as readonly string[]).includes(s) ? s : 'waiting';
}

/** The sessions that are running (more than one only when two people started one at once). */
export function runningSessions(sessions: readonly OpsSession[]): OpsSession[] {
  return sessions.filter((s) => s.status === 'running').sort((a, b) => cmp(a.id, b.id));
}

/** Whether the map's sheets are locked: a session is running. */
export function sheetsLocked(sessions: readonly OpsSession[]): boolean {
  return runningSessions(sessions).length > 0;
}

/** A place as a role's reach sees it: the parts it covers (its module's parts, or its spots' track on loose track). */
export interface ReachPlace {
  id: string;
  bricks: readonly string[];
}

/** What someone may move and flip while a session runs. */
export interface OpsReach {
  /** Every car and switch. */
  all: boolean;
  /** Their role ('host' for the host and the owner); '' when they aren't in the running session. */
  role: '' | 'host' | CrewRole;
  /** The parts where they may move cuts and flip switches. */
  bricks: Set<string>;
  /** Trains they may move wherever they are (a crew's job's train). */
  trains: Set<string>;
  /** Why they may do nothing, in the words people see; '' when they may. */
  why: string;
}

const NONE = (why: string): OpsReach => ({ all: false, role: '', bricks: new Set(), trains: new Set(), why });

/**
 * What `userId` may move and flip in this layout. `owner`: they own the
 * layout. Read from the layout as it is (the server: as it was before the
 * update it checks), never from what an update writes.
 */
export function opsReach(input: {
  sessions: readonly OpsSession[];
  jobs: readonly OpsJobRecord[];
  places: readonly ReachPlace[];
  userId: string;
  layoutId: string;
  owner?: boolean;
}): OpsReach {
  const running = runningSessions(input.sessions);
  if (running.length === 0) return NONE('No session is running.');
  if (running.length > 1) return NONE('Two sessions are running; the host ends one.');
  const s = running[0]!;
  if (input.userId === '') return NONE('You aren’t in this session’s crew.');
  if (input.owner || s.host === input.userId) return { all: true, role: 'host', bricks: new Set(), trains: new Set(), why: '' };
  if (s.layout !== input.layoutId) return NONE('This session was started in another layout; the host starts it again here.');
  const me = s.crew.filter((c) => c.userId === input.userId);
  if (me.length === 0) return NONE('You aren’t in this session’s crew.');
  const reach: OpsReach = { all: false, role: me[0]!.role, bricks: new Set(), trains: new Set(), why: '' };
  const places = new Map(input.places.map((p) => [p.id, p]));
  const jobs = new Map(input.jobs.map((j) => [j.id, j]));
  let crewWaiting = false;
  for (const c of me) {
    if (c.role === 'dispatcher') return { all: true, role: 'dispatcher', bricks: new Set(), trains: new Set(), why: '' };
    if (c.role === 'yardmaster') {
      if (reach.role === 'crew') reach.role = 'yardmaster';
      for (const id of c.places) for (const b of places.get(id)?.bricks ?? []) reach.bricks.add(b);
      continue;
    }
    const job = jobs.get(c.job);
    if (!job) continue;
    if (jobStatus(job) !== 'out') {
      crewWaiting = true;
      continue;
    }
    if (job.train !== '') reach.trains.add(job.train);
    for (const stop of job.stops) for (const b of places.get(stop.place)?.bricks ?? []) reach.bricks.add(b);
  }
  if (reach.bricks.size === 0 && reach.trains.size === 0) reach.why = crewWaiting ? 'Your job isn’t out yet; the dispatcher sends it out.' : 'Your role has nothing to move yet.';
  return reach;
}

/** The part a switch's key ("<brick>/<heel>") is on. */
export function switchBrick(key: string): string {
  const at = key.lastIndexOf('/');
  return at > 0 ? key.slice(0, at) : '';
}

/** Whether `reach` may flip the switch at `key`. */
export function mayFlip(reach: OpsReach, key: string): boolean {
  return reach.all || reach.bricks.has(switchBrick(key));
}

/** Where a train or cut stands: the part its head is on ('' when it is off the map). */
export function standsOn(position: unknown): string {
  return isObj(position) && typeof position.brick === 'string' ? position.brick : '';
}

/** Whether `reach` may move the train or cut `id`, standing at `position` (where it is now). */
export function mayMove(reach: OpsReach, id: string, position: unknown): boolean {
  if (reach.all || reach.trains.has(id)) return true;
  const on = standsOn(position);
  return on !== '' && reach.bricks.has(on);
}

/** Whether `reach` may put the train or cut `id` at `position` (where it goes). Its own train goes anywhere. */
export function mayPut(reach: OpsReach, id: string, position: unknown): boolean {
  return mayMove(reach, id, position);
}

/** The places a reach is read from: a module's places cover the module's parts; a layout place, its spots' track. */
export function reachPlaces(modules: readonly { members: readonly string[]; places: readonly { id: string }[] }[], layoutPlaces: readonly { id: string; spots: readonly { track?: { brick: string } }[] }[]): ReachPlace[] {
  const out: ReachPlace[] = [];
  for (const m of modules) for (const p of m.places) out.push({ id: p.id, bricks: m.members });
  for (const p of layoutPlaces) out.push({ id: p.id, bricks: p.spots.flatMap((s) => (s.track ? [s.track.brick] : [])) });
  return out;
}

/** The snapshot a session starts from: every train's place and cars, and each car's cut. */
export function sessionStart(trains: readonly { id: string; position?: unknown; units?: unknown }[], cars: readonly { id: string; opsCut?: unknown }[]): SessionStart {
  const out: SessionStart = { trains: {}, cars: {} };
  for (const t of [...trains].sort((a, b) => cmp(a.id, b.id))) out.trains[t.id] = { position: t.position ?? null, units: t.units ?? [] };
  for (const c of [...cars].sort((a, b) => cmp(a.id, b.id))) out.cars[c.id] = text(c.opsCut);
  return out;
}

/** What "Put every car back where this session started" writes: the trains to set, the cars' cuts, and the cuts made since (emptied). */
export function putBack(start: SessionStart, trains: readonly { id: string; position?: unknown; units?: unknown }[], cars: readonly { id: string; opsCut?: unknown }[]): {
  trains: { id: string; position: unknown; units: unknown }[];
  cars: Record<string, string>;
  emptied: string[];
} {
  const out = { trains: [] as { id: string; position: unknown; units: unknown }[], cars: {} as Record<string, string>, emptied: [] as string[] };
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  for (const t of [...trains].sort((a, b) => cmp(a.id, b.id))) {
    const was = start.trains[t.id];
    if (!was) {
      if (Array.isArray(t.units) && t.units.length > 0) out.emptied.push(t.id);
      continue;
    }
    if (!same(was.position, t.position) || !same(was.units, t.units)) out.trains.push({ id: t.id, position: was.position, units: was.units });
  }
  for (const c of [...cars].sort((a, b) => cmp(a.id, b.id))) {
    const was = start.cars[c.id];
    if (was !== undefined && was !== text(c.opsCut)) out.cars[c.id] = was;
  }
  return out;
}

/**
 * The session's moves played again from where it started: each cut's place
 * after the log's moves, in the order they were made. What the log says a
 * cut was moved to wins over where it started.
 */
export function replayLog(start: SessionStart, log: readonly LogEntry[], session: string): Record<string, unknown> {
  const at: Record<string, unknown> = {};
  for (const [id, t] of Object.entries(start.trains)) at[id] = t.position;
  const moves = log.filter((e) => e.session === session && e.kind === 'move').sort((a, b) => a.at - b.at || cmp(a.id, b.id));
  for (const e of moves) at[e.what] = e.to;
  return at;
}

/** The summary when a session ends: moves made, cars that moved, and jobs not done. */
export function sessionSummary(session: string, log: readonly LogEntry[], jobs: readonly OpsJobRecord[]): { moves: number; cuts: number; switches: number; jobsLeft: string[] } {
  const mine = log.filter((e) => e.session === session);
  const moves = mine.filter((e) => e.kind === 'move');
  return {
    moves: moves.length,
    cuts: new Set(moves.map((e) => e.what)).size,
    switches: mine.filter((e) => e.kind === 'switch').length,
    jobsLeft: jobs.filter((j) => jobStatus(j) !== 'done').map((j) => j.id).sort(cmp),
  };
}

/** Cars standing away from where they belong when a session ends: cuts not on a spot (`onSpot` says which are). */
export function carsInMotion(trains: readonly { id: string; position?: unknown; units?: unknown }[], onSpot: (id: string) => boolean): string[] {
  return trains.filter((t) => standsOn(t.position) !== '' && Array.isArray(t.units) && t.units.length > 0 && !onSpot(t.id)).map((t) => t.id).sort(cmp);
}
