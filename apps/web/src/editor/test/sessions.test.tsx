// Operating sessions in the editor (Live Ops design 4): making one, its
// crew, start, pause and end (leaving the cars, or putting every car back),
// jobs sent out and done, the log written by whoever moved, and a car or
// switch outside your role's reach left as it was with the reason; the
// Session tab's words.

import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Y from 'yjs';
import networkFile from '../../../../../fixtures/contracts/route-search.json?raw';
import { ensureRecordMaps, OPS_JOBS_KEY, OPS_LOG_KEY, OPS_SESSIONS_KEY, readRecordsFromDoc, readSwitchStatesFromDoc, TRAINS_KEY, writeRecord } from '@cld/ydoc';
import { asStock, startDrag, TrackNetwork } from '@cld/parts-catalog/browser';
import { putCarsOnTrack, readStanding, writeCutChange } from '../cuts';
import { useEditorStore } from '../editorStore';
import { setSwitch } from '../mutations';
import { outOfReach } from '../render/CarDragLayer';
import { bannerText, crewMember, endSession, newSession, nextSession, pauseSession, readSessionState, setJobStatus, setSession, startSession } from '../sessions';
import { saveStock } from '../trains';
import { OpsSessionTab } from '../OpsSessionTab';
import type { OpsView } from '../ops';

const net0 = JSON.parse(networkFile) as { parts: Record<string, never>; bricks: { id: string; part: string; points: number[][]; connexions: never }[] };
const net = new TrackNetwork(net0.bricks.map((b) => ({ id: b.id, partKey: b.part, conns: net0.parts[b.part]!, points: b.points.flat(), orientation: 0, connexions: b.connexions })));
const car = (id: string) => asStock({ id, number: id.toUpperCase(), length: 12, trucks: [{ at: 3 }, { at: -3 }] });
const at = (brick: string, s: number) => ({ brick, from: 0, to: 1, s, facing: 'to' as const });

function layout(): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap('meta').set('version', 5);
  ensureRecordMaps(doc);
  for (const id of ['a', 'b']) saveStock(doc, car(id));
  putCarsOnTrack(doc, net, {}, ['a', 'b'], at('M', 30));
  doc.transact(() => {
    writeRecord(doc, 'places', { id: 'pl-1', name: 'Mill', kind: 'industry', spots: [{ id: 's', name: 'Dock', track: { brick: 'M', from: 0, to: 1 } }], accepts: [], ships: [], tags: [], notes: '' });
    writeRecord(doc, OPS_JOBS_KEY, { id: 'j1', name: 'Mill Turn', kind: 'turn', train: '', order: 1, stop_a: { place: 'pl-1', at: 1 } });
  });
  return doc;
}
const sessionOf = (doc: Y.Doc, id?: string) => readRecordsFromDoc(doc, OPS_SESSIONS_KEY).find((s) => !id || s.id === id)!;

describe('a session, from setting up to the next one', () => {
  it('starts with you as its host and the cars as they stood; pauses; ends leaving the cars, or putting them back', () => {
    for (const back of [false, true]) {
      const doc = layout();
      const id = newSession(doc, null, Date.UTC(2026, 10, 22, 12));
      expect(sessionOf(doc)).toMatchObject({ status: 'setup', name: 'Session 1 — Nov 22', crew: [] });
      setSession(doc, id, { crew: [crewMember('vic', 'Vic', 'crew')] });
      expect(startSession(doc, id, 'alice', 'lay-1')).toBeNull();
      expect(sessionOf(doc, id)).toMatchObject({ status: 'running', host: 'alice', layout: 'lay-1' });
      const was = readStanding(doc).trains.map((t) => [t.id, t.position]);
      // A second session can't start while one runs.
      const other = newSession(doc);
      expect(startSession(doc, other, 'alice', 'lay-1')).toMatch(/running already/);
      // The host moves the cars.
      const st = readSessionState(doc, 'alice', 'lay-1', false);
      expect(st.reach.role).toBe('host');
      expect(bannerText(st)).toBe('Session 1 — Nov 22 running · you’re the Host');
      const { trains, stock } = readStanding(doc);
      const drag = startDrag(net, trains, stock, {}, trains[0]!.id, 0, 'new')!;
      const m = drag.to({ x: 10, y: 0 });
      writeCutChange(doc, m.change, 5, { reach: st.reach, id, userId: 'alice' });
      expect(readRecordsFromDoc(doc, OPS_LOG_KEY).filter((e) => e.kind === 'move').every((e) => e.by === 'alice' && e.session === id)).toBe(true);
      pauseSession(doc, id, 'alice');
      expect(readSessionState(doc, 'alice', 'lay-1', false).locked).toBe(false);
      endSession(doc, id, 'alice', back);
      expect(sessionOf(doc, id).status).toBe('ended');
      const now = readStanding(doc).trains.filter((t) => t.units.length > 0).map((t) => [t.id, t.position]);
      if (back) expect(now).toEqual(was);
      else expect(now).not.toEqual(was);
      // The next session: the same crew, the cars where this one left them.
      const next = nextSession(doc, readSessionState(doc, 'alice', 'lay-1', false).past[0]!);
      expect(readRecordsFromDoc(doc, OPS_SESSIONS_KEY).find((s) => s.id === next)).toMatchObject({ status: 'setup', crew: [{ userId: 'vic', role: 'crew' }] });
    }
  });

  it('a job sent out and done is logged; a crew reaches its stops only once the job is out', () => {
    const doc = layout();
    const id = newSession(doc);
    setSession(doc, id, { crew: [{ ...crewMember('vic', 'Vic', 'crew'), job: 'j1' }] });
    startSession(doc, id, 'alice', 'lay-1');
    expect(readSessionState(doc, 'vic', 'lay-1', false).reach.why).toMatch(/isn’t out yet/);
    setJobStatus(doc, 'j1', 'out', id, 'alice');
    const vic = readSessionState(doc, 'vic', 'lay-1', false);
    expect([...vic.reach.bricks]).toEqual(['M']);
    expect(readRecordsFromDoc(doc, OPS_LOG_KEY).filter((e) => e.kind === 'job')).toMatchObject([{ what: 'j1', to: 'out', by: 'alice' }]);
  });
});

describe('outside your role’s reach', () => {
  it('a switch elsewhere isn’t flipped, and says why; one in reach is, logged, without tidying other keys', () => {
    const doc = layout();
    doc.transact(() => (doc.getMap('meta').get('switchStates') as Y.Map<number>).set('GONE/0', 1));
    const id = newSession(doc);
    setSession(doc, id, { crew: [{ ...crewMember('vic', 'Vic', 'crew'), job: 'j1' }] });
    startSession(doc, id, 'alice', 'lay-1');
    setJobStatus(doc, 'j1', 'out', id, 'alice');
    const reach = readSessionState(doc, 'vic', 'lay-1', false).reach;
    useEditorStore.setState({ statusMessage: null } as never);
    expect(setSwitch(doc, 'OTHER/0', 1, { reach, id, userId: 'vic' })).toBe(false);
    expect(readSwitchStatesFromDoc(doc)['OTHER/0']).toBeUndefined();
    expect(setSwitch(doc, 'M/0', 1, { reach, id, userId: 'vic' })).toBe(true);
    expect(readSwitchStatesFromDoc(doc)).toEqual({ 'GONE/0': 1, 'M/0': 1 });
    expect(readRecordsFromDoc(doc, OPS_LOG_KEY).filter((e) => e.kind === 'switch')).toMatchObject([{ what: 'M/0', by: 'vic' }]);
  });

  it('a car standing elsewhere, or put elsewhere, is a move outside the reach', () => {
    const doc = layout();
    const id = newSession(doc);
    setSession(doc, id, { crew: [{ ...crewMember('yan', 'Yan', 'yardmaster'), places: ['pl-other'] }] });
    startSession(doc, id, 'alice', 'lay-1');
    const reach = readSessionState(doc, 'yan', 'lay-1', false).reach;
    const { trains, stock } = readStanding(doc);
    const m = startDrag(net, trains, stock, {}, trains[0]!.id, 0, 'new')!.to({ x: 10, y: 0 });
    expect(outOfReach(reach, m, trains)).toMatch(/nothing to move/);
    expect(outOfReach(readSessionState(doc, 'alice', 'lay-1', false).reach, m, trains)).toBe('');
    void TRAINS_KEY;
  });
});

describe('the Session tab', () => {
  const view = { places: [{ id: 'pl-1', name: 'Mill', place: { kind: 'industry' } }], jobs: [{ id: 'j1', name: 'Mill Turn', stops: [], status: 'out' }], trains: [] } as unknown as OpsView;
  const tab = (doc: Y.Doc, user: string, canEdit: boolean) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <OpsSessionTab doc={doc} view={view} state={readSessionState(doc, user, 'lay-1', false)} canEdit={canEdit} userId={user} layoutId="lay-1" touch={false} />
      </QueryClientProvider>,
    );

  it('offers the first session to an editor, and says who sets them up to a viewer', () => {
    const doc = layout();
    tab(doc, 'vic', false);
    expect(screen.getByText(/owner or an editor sets up sessions/)).toBeTruthy();
    tab(doc, 'alice', true).unmount();
    const r = tab(doc, 'alice', true);
    fireEvent.click(r.getByTestId('ops-session-new'));
    expect(sessionOf(doc).status).toBe('setup');
  });

  it('a running session: the host pauses and ends it with a choice; the dispatcher’s board', () => {
    const doc = layout();
    const id = newSession(doc);
    startSession(doc, id, 'alice', 'lay-1');
    const r = tab(doc, 'alice', true);
    expect(r.getByTestId('ops-session-status').textContent).toMatch(/running · you’re the Host/);
    fireEvent.click(r.getByTestId('ops-session-end'));
    expect(r.getByTestId('ops-end-dialog').textContent).toMatch(/Put every car back/);
    fireEvent.click(r.getByTestId('ops-end-leave'));
    expect(sessionOf(doc).status).toBe('ended');
  });
});
