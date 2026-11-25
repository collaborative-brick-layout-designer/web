// Places in the editor (Live Ops Phase 1): where they are kept as modules
// are made, taken apart, copied, saved to the Module library and added from
// it (each one undo step); a shared module's can't be changed; and the
// Places panel.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as Y from 'yjs';
import { modulePlaces, withPlaces, type Place, type SidecarModule } from '@cld/bbm';
import { readPlacesFromDoc, readSidecarFromDoc } from '@cld/ydoc';
import { moduleBatchesFromBytes } from '@cld/modules';
import { absorbIntoEditedModule } from '../moduleActions';
import { blueBrickLeavesOut } from '../DownloadAsDialog';
import { moduleContents } from '../moduleLibrary';
import { cloneModuleBricks, createSidecarModule, deleteModuleWithParts, ensureBrickLayer, flattenSidecarModule, importBricksAsModule, placeBrick, replaceModuleParts, updateSidecarModule } from '../mutations';
import { countsText, openPlaces, placeGroups, savePlace, spotNow, withSpotOn, type PlaceGroup } from '../places';
import { PlacesPanel } from '../PlacesPanel';
import { onSharedLock } from '../sharedLock';
import { createUndoManager } from '../useUndoManager';
import { projectDoc } from '../useDocMap';
import { useEditorStore } from '../editorStore';

const place = (id: string, brick: string | null, over: Partial<Place> = {}): Place => ({
  id, name: 'Acme Cannery', kind: 'industry', spots: brick ? [{ id: 's1', name: 'Dock', track: { brick, from: 0, to: 1 } }] : [], accepts: [], ships: [], tags: [], notes: '', ...over,
});

function layout() {
  const doc = new Y.Doc();
  const layer = ensureBrickLayer(doc);
  const a = placeBrick(doc, layer, { partNumber: '2865', x: 0, y: 0, width: 16, height: 8 });
  const b = placeBrick(doc, layer, { partNumber: '2865', x: 16, y: 0, width: 16, height: 8 });
  return { doc, layer, a, b };
}
const modules = (doc: Y.Doc) => readSidecarFromDoc(doc)?.modules ?? [];
const spotOf = (p: Place | undefined) => p?.spots[0]?.track?.brick;

beforeEach(() => useEditorStore.setState({ placeOpen: null, placePick: null, placesModule: null, placeFresh: null, editingModuleId: null }));
afterEach(() => {
  cleanup();
  onSharedLock(() => undefined);
});

describe('where places are kept', () => {
  it('making a module takes the places on its parts, ungrouping gives them back, each undone whole', () => {
    const { doc, a, b } = layout();
    savePlace(doc, null, place('p1', a));
    savePlace(doc, null, place('p2', null, { kind: 'staging', name: 'World' }));
    const um = createUndoManager(doc);
    const id = createSidecarModule(doc, 'Depot', [a, b])!;
    expect(modulePlaces(modules(doc)[0]!).map((p) => p.id)).toEqual(['p1']);
    expect(readPlacesFromDoc(doc).map((p) => p.id)).toEqual(['p2']);
    um.undo();
    expect(modules(doc)).toEqual([]);
    expect(readPlacesFromDoc(doc).map((p) => p.id)).toEqual(['p1', 'p2']);
    um.redo();
    um.stopCapturing();
    flattenSidecarModule(doc, id);
    expect(readPlacesFromDoc(doc).map((p) => p.id).sort()).toEqual(['p1', 'p2']);
  });

  it('deleting a module with its parts takes its places with it', () => {
    const { doc, a, b } = layout();
    savePlace(doc, null, place('p1', a));
    deleteModuleWithParts(doc, createSidecarModule(doc, 'Depot', [a, b])!);
    expect(readPlacesFromDoc(doc)).toEqual([]);
  });

  it('a duplicate’s places are on its own track, under ids of their own', () => {
    const { doc, a, b } = layout();
    savePlace(doc, null, place('p1', b));
    createSidecarModule(doc, 'Depot', [a, b]);
    cloneModuleBricks(doc, modules(doc)[0]!);
    const copy = modules(doc)[1]!;
    const [p] = modulePlaces(copy);
    expect(p).toMatchObject({ name: 'Acme Cannery', source: 'p1' });
    expect(p!.id).not.toBe('p1');
    expect(spotOf(p)).toBe(copy.members[1]);
  });

  it('saved to the Module library and added to another layout: the cannery is there', () => {
    const { doc, a, b } = layout();
    savePlace(doc, null, place('p1', b));
    createSidecarModule(doc, 'Depot', [a, b]);
    const mod = modules(doc)[0]!;
    const { bytes } = moduleContents(projectDoc(doc)!, mod.members, false, modulePlaces(mod))!;
    const other = layout();
    const { moduleId, ids } = importBricksAsModule(other.doc, moduleBatchesFromBytes(bytes), { name: 'Depot' })!;
    const placed = modules(other.doc).find((m) => m.id === moduleId)!;
    expect(spotOf(modulePlaces(placed)[0])).toBe(ids[1]);
    // Updated from the library: the same place here, on the new parts.
    const was = modulePlaces(placed)[0]!.id;
    const next = moduleBatchesFromBytes(bytes);
    next[0]!.places![0]!.name = 'Cannery Row';
    const now = replaceModuleParts(other.doc, moduleId, next, () => other.layer)!;
    const [p] = modulePlaces(modules(other.doc).find((m) => m.id === moduleId)!);
    expect(p).toMatchObject({ id: was, name: 'Cannery Row' });
    expect(spotOf(p)).toBe(now[1]);
    // A version without places leaves an ordinary module its own, without the track that went.
    replaceModuleParts(other.doc, moduleId, next.map(({ places: _none, ...x }) => x), () => other.layer);
    const [kept] = modulePlaces(modules(other.doc).find((m) => m.id === moduleId)!);
    expect(kept).toMatchObject({ id: was });
    expect(spotOf(kept)).toBeUndefined();
  });

  it('a module dropped into the one being edited gives it its places', () => {
    const { doc, a, b } = layout();
    const home = createSidecarModule(doc, 'Home', [a])!;
    const dropped = createSidecarModule(doc, 'Dropped', [b])!;
    savePlace(doc, dropped, place('p1', b));
    useEditorStore.setState({ editingModuleId: home });
    absorbIntoEditedModule(doc, [b]);
    expect(modules(doc).map((m) => [m.name, modulePlaces(m).map((p) => p.id)])).toEqual([['Home', ['p1']]]);
  });

  it('a .bbm leaves them out, and says so', () => {
    expect(blueBrickLeavesOut({ schemaVersion: 1, bbmHashSha256: '', layoutPlaces: [place('p1', null)] })).toEqual(['places']);
    expect(blueBrickLeavesOut({ schemaVersion: 1, bbmHashSha256: '', modules: [{ id: 'm', name: '', members: [], transform: [], places: [place('p1', null)] }] })).toEqual(['modules', 'places']);
  });
});

describe('a shared module’s places', () => {
  it('can’t be changed, and the person is told why', () => {
    const { doc, a, b } = layout();
    const id = createSidecarModule(doc, 'Depot', [a, b])!;
    updateSidecarModule(doc, id, (m) => withPlaces({ ...m, libraryModuleId: '5f0c0c0e-5d0e-4c55-9a43-1f3a2c9f7d10', libraryVersion: 1, shared: { by: 'alice' } } as SidecarModule, [place('p1', a)]));
    const told = vi.fn();
    onSharedLock((_s, what) => told(what));
    savePlace(doc, id, place('p1', a, { name: 'Mine' }));
    expect(told).toHaveBeenCalledWith('places');
    expect(modulePlaces(modules(doc)[0]!)[0]!.name).toBe('Acme Cannery');
    expect(placeGroups(doc)[1]).toMatchObject({ locked: true });
  });
});

describe('words and spots', () => {
  it('counts', () => {
    expect(countsText([{ kind: 'industry', count: 2 }, { kind: 'yard', count: 1 }, { kind: 'port', count: 3 }])).toBe('2 industries, 1 yard, 3 port');
  });
  it('a spot without track, or whose track went, says nothing it can’t tell', () => {
    const p = place('p1', 'gone');
    expect(spotNow(null, [], null, p, p.spots[0]!)).toMatchObject({ at: null, capacity: null });
    expect(spotNow(null, [], null, p, { id: 's', name: '', capacity: 4 }).capacity).toBe(4);
  });
  it('a spot picked again keeps its name; a new one is named', () => {
    const p = withSpotOn(withSpotOn(place('p1', 'a'), 's1', { brick: 'b', from: 1, to: 0, s: 2 }), null, { brick: 'c', from: 0, to: 1, s: 0 });
    expect(p.spots.map((s) => [s.name, s.track])).toEqual([['Dock', { brick: 'b', from: 1, to: 0 }], ['Spot 2', { brick: 'c', from: 0, to: 1 }]]);
  });
});

describe('the Places panel', () => {
  function Panel({ doc, isViewer = false, groups }: { doc: Y.Doc; isViewer?: boolean; groups?: PlaceGroup[] }) {
    return <PlacesPanel doc={doc} groups={groups ?? placeGroups(doc)} spots={new Map()} hasTrack isViewer={isViewer} carTypes={['Boxcar ', 'milk tank']} />;
  }

  it('says what a place is, makes one off the layout, and changes it one undo step a field', () => {
    const { doc } = layout();
    const um = createUndoManager(doc);
    const { rerender } = render(<Panel doc={doc} />);
    expect(screen.getByTestId('places-panel').textContent).toContain('No places yet.');
    fireEvent.click(screen.getByTestId('place-new-off'));
    rerender(<Panel doc={doc} />);
    expect(screen.getByTestId('place-kind')).toHaveProperty('value', 'staging');
    um.stopCapturing();
    fireEvent.change(screen.getByTestId('place-name'), { target: { value: 'The world' } });
    fireEvent.keyDown(screen.getByTestId('place-name'), { key: 'Enter' });
    rerender(<Panel doc={doc} />);
    const words = screen.getByTestId('place-accepts').querySelector('input')!;
    fireEvent.change(words, { target: { value: 'reefer, Reefer ,milk tank,' } });
    expect(readPlacesFromDoc(doc)[0]).toMatchObject({ name: 'The world', accepts: ['reefer', 'milk tank'] });
    um.undo();
    expect(readPlacesFromDoc(doc)[0]).toMatchObject({ name: 'Place 1', accepts: [] });
    // Someone else deleted it: the list again, nothing stuck.
    doc.getMap('meta').delete('places');
    rerender(<Panel doc={doc} />);
    expect(screen.getByTestId('places-panel')).toBeTruthy();
  });

  it('New place asks for track; a module’s Places… shows only its own', () => {
    const { doc, a, b } = layout();
    savePlace(doc, null, place('p0', null, { name: 'Elsewhere' }));
    const id = createSidecarModule(doc, 'Depot', [a, b])!;
    useEditorStore.getState().setPlacesModule(id);
    const { rerender } = render(<Panel doc={doc} />);
    expect(screen.queryByText('Elsewhere')).toBeNull();
    fireEvent.click(screen.getByTestId('place-new'));
    expect(useEditorStore.getState().placePick).toEqual({ owner: id, place: null, spot: null });
    useEditorStore.getState().setPlacePick(null);
    fireEvent.click(screen.getByText('Show all'));
    rerender(<Panel doc={doc} />);
    expect(screen.getByText('Elsewhere')).toBeTruthy();
  });

  it('a viewer sees a place, and can’t change it', () => {
    const { doc, a } = layout();
    savePlace(doc, null, place('p1', a));
    useEditorStore.getState().setPlaceOpen({ owner: null, id: 'p1' });
    render(<Panel doc={doc} isViewer />);
    expect(screen.getByTestId('place-name')).toHaveProperty('readOnly', true);
    for (const t of ['spot-pick', 'spot-add', 'place-delete']) expect(screen.queryByTestId(t)).toBeNull();
  });

  it('openPlaces asks the editor for it', () => {
    const heard = vi.fn();
    window.addEventListener('cld:open-places', (e) => heard((e as CustomEvent).detail), { once: true });
    openPlaces({ module: 'm1' });
    expect(heard).toHaveBeenCalledWith({ module: 'm1' });
  });
});
