// Who may move and flip what in an operating session, putting cars back,
// and the log played again, against the shared contract
// (fixtures/contracts/ops-session.json): the desktop's
// tests/track/OpsSessionTest.cpp checks the same, so both apps grey out the
// same things the server refuses (apps/server/src/ws/opsGuard.ts).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { asJob } from './ops.js';
import {
  asLogEntry,
  asSession,
  carsInMotion,
  mayFlip,
  mayMove,
  opsReach,
  putBack,
  replayLog,
  sessionStart,
  sessionSummary,
  sheetsLocked,
  SESSION_LIMITS,
  switchBrick,
  type ReachPlace,
} from './opsSession.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../fixtures/contracts');
const FILE = join(DIR, 'ops-session.json');
type Rec = Record<string, unknown> & { id: string };
const doc = JSON.parse(readFileSync(FILE, 'utf8')) as {
  limits: unknown;
  jobs: Rec[];
  places: ReachPlace[];
  switches: string[];
  positions: Record<string, unknown>;
  trains: string[];
  reach: { name: string; sessions: Rec[]; layoutId: string; owner: string; users: string[]; expect: unknown }[];
  start: { trains: Rec[]; cars: Rec[] };
  now: { trains: Rec[]; cars: Rec[] };
  log: Rec[];
  expect: unknown;
};
const writing = process.env.BLD_WRITE_CONTRACTS === '1';
const same = (c: { expect: unknown }, got: unknown) => {
  if (writing) c.expect = got;
  else expect(got).toEqual(c.expect);
};
afterAll(() => {
  if (writing) writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n');
});
const jobs = doc.jobs.map((r) => ({ ...asJob(r), status: r.status }));

describe('the limits', () => {
  it('are the contract’s', () => {
    if (writing) doc.limits = SESSION_LIMITS;
    expect(doc.limits).toEqual(SESSION_LIMITS);
  });
});

describe('each role against each key', () => {
  for (const c of doc.reach)
    it(c.name, () => {
      const sessions = c.sessions.map((r) => asSession(r));
      const out: Record<string, unknown> = {};
      for (const userId of c.users) {
        const reach = opsReach({ sessions, jobs, places: doc.places, userId, layoutId: c.layoutId, owner: userId === c.owner });
        out[userId || '(a guest)'] = {
          all: reach.all,
          role: reach.role,
          bricks: [...reach.bricks].sort(),
          trains: [...reach.trains].sort(),
          why: reach.why,
          flips: doc.switches.filter((k) => mayFlip(reach, k)),
          moves: doc.trains.flatMap((id) => Object.entries(doc.positions).filter(([, p]) => mayMove(reach, id, p)).map(([where]) => `${id} ${where}`)),
        };
      }
      same(c, { locked: sheetsLocked(sessions), people: out });
    });
});

describe('ending, and the log', () => {
  it('puts every car back, plays the log again, and sums the session up', () => {
    const start = sessionStart(doc.start.trains, doc.start.cars);
    const log = doc.log.map((r) => asLogEntry(r));
    same(doc, {
      switchBrick: doc.switches.map(switchBrick),
      start,
      putBack: putBack(start, doc.now.trains, doc.now.cars),
      replay: replayLog(start, log, 's1'),
      summary: sessionSummary('s1', log, jobs),
      inMotion: carsInMotion(doc.now.trains, (id) => id === 'cut-1'),
    });
    // Putting back, then reading again, leaves nothing to put back.
    const back = putBack(start, doc.now.trains, doc.now.cars);
    const trains = doc.now.trains.map((t) => ({ ...t, ...(back.trains.find((b) => b.id === t.id) ?? {}), ...(back.emptied.includes(t.id) ? { units: [] } : {}) }));
    const cars = doc.now.cars.map((c) => ({ ...c, opsCut: back.cars[c.id] ?? c.opsCut }));
    expect(putBack(start, trains, cars)).toEqual({ trains: [], cars: {}, emptied: [] });
  });
});
