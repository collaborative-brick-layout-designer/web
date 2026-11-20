import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore } from '../editorStore';

// The store reads localStorage at module initialisation time. jsdom provides
// a real localStorage so we interact with it directly.

function resetStore() {
  // Reset Zustand store to a clean state by resetting all persisted keys
  // and then forcing a re-initialisation. Vitest re-imports the module per
  // suite but within a single describe we use setState directly.
  useEditorStore.setState({
    tool: 'select',
    selection: [],
    activeLayerId: null,
    placePartKey: '',
    zoom: 1,
    panX: 0,
    panY: 0,
    snapStepStuds: 1,
    rotationStepDegrees: 90,
    liveSnap: null,
    snapMoving: null,
    connectionSnap: 'gentle',
    paintColor: '80008000',
    hudMouseStudX: null,
    hudMouseStudY: null,
    hudMapWidthStuds: null,
    hudMapHeightStuds: null,
    statusMessage: null,
    statusMessageTimerId: null,
    showConnectionPoints: true,
    showGrid: true,
    showBrickHulls: false,
    showBrickElevation: false,
    showRulerAttachPoints: false,
    alwaysShowConnections: false,
    wheelZoomFactor: 1,
    selectionTint: 'FFD700',
    showModuleNames: false,
    moduleFrameThickness: 2,
    showElectricCircuits: false,
    showSwitches: false,
    runMode: false,
    routeDraft: null,
    trainPlacing: null,
    showSidingLengths: false,
    spotlight: null,
    showExportWatermark: false,
    moduleLabelPercent: 100,
    venueLabelPx: 28,
    undoStackDepth: 100,
    reopenLastFile: false,
  });
}

describe('editorStore — tool', () => {
  beforeEach(resetStore);

  it('defaults to select', () => {
    expect(useEditorStore.getState().tool).toBe('select');
  });

  it('setTool changes the active tool', () => {
    useEditorStore.getState().setTool('rotate');
    expect(useEditorStore.getState().tool).toBe('rotate');
  });
});

describe('editorStore — selection', () => {
  beforeEach(resetStore);

  it('setSelection replaces the selection', () => {
    useEditorStore.getState().setSelection(['a', 'b']);
    expect(useEditorStore.getState().selection).toEqual(['a', 'b']);
    useEditorStore.getState().setSelection(['c']);
    expect(useEditorStore.getState().selection).toEqual(['c']);
  });

  it('toggleSelected adds an id when not selected (non-additive replaces)', () => {
    useEditorStore.getState().setSelection([]);
    useEditorStore.getState().toggleSelected('x', false);
    expect(useEditorStore.getState().selection).toEqual(['x']);
  });

  it('toggleSelected in additive mode adds without removing others', () => {
    useEditorStore.getState().setSelection(['a']);
    useEditorStore.getState().toggleSelected('b', true);
    expect(useEditorStore.getState().selection).toContain('a');
    expect(useEditorStore.getState().selection).toContain('b');
  });

  it('toggleSelected in additive mode removes an already-selected id', () => {
    useEditorStore.getState().setSelection(['a', 'b']);
    useEditorStore.getState().toggleSelected('a', true);
    expect(useEditorStore.getState().selection).not.toContain('a');
    expect(useEditorStore.getState().selection).toContain('b');
  });

  it('non-additive toggleSelected replaces with just that id', () => {
    useEditorStore.getState().setSelection(['a', 'b', 'c']);
    useEditorStore.getState().toggleSelected('d', false);
    expect(useEditorStore.getState().selection).toEqual(['d']);
  });
});

describe('editorStore — zoom and pan', () => {
  beforeEach(resetStore);

  it('setZoom clamps to the desktop range [0.02, 40] (MapView.cpp:77-78)', () => {
    useEditorStore.getState().setZoom(0);
    expect(useEditorStore.getState().zoom).toBe(0.02);

    useEditorStore.getState().setZoom(100);
    expect(useEditorStore.getState().zoom).toBe(40);

    useEditorStore.getState().setZoom(0.05);
    expect(useEditorStore.getState().zoom).toBe(0.05);
    useEditorStore.getState().setZoom(20);
    expect(useEditorStore.getState().zoom).toBe(20);

    useEditorStore.getState().setZoom(2);
    expect(useEditorStore.getState().zoom).toBe(2);
  });

  it('setPan sets panX and panY', () => {
    useEditorStore.getState().setPan(100, 200);
    expect(useEditorStore.getState().panX).toBe(100);
    expect(useEditorStore.getState().panY).toBe(200);
  });

  it('zoomAround keeps world coord under anchor stable', () => {
    // Set up: zoom=1, pan=(0,0). Anchor at screen (100, 100).
    // World coord = (100 - 0) / 1 = (100, 100).
    useEditorStore.getState().setPan(0, 0);
    useEditorStore.getState().setZoom(1);
    useEditorStore.getState().zoomAround(2, 100, 100);

    const { zoom, panX, panY } = useEditorStore.getState();
    expect(zoom).toBe(2);
    // screen anchor → world: (100 - panX) / 2 should equal 100.
    // panX = 100 - 100*2 = -100, panY = -100.
    expect(panX).toBeCloseTo(-100);
    expect(panY).toBeCloseTo(-100);
  });

  it('zoomAround is a no-op if zoom would not change', () => {
    useEditorStore.getState().setPan(50, 50);
    useEditorStore.getState().setZoom(1);
    useEditorStore.getState().zoomAround(1, 200, 200);
    // pan must stay the same since newZoom === currentZoom.
    expect(useEditorStore.getState().panX).toBe(50);
    expect(useEditorStore.getState().panY).toBe(50);
  });
});

describe('editorStore — snap', () => {
  beforeEach(resetStore);

  it('setSnapStep stores and clamps to >=0', () => {
    useEditorStore.getState().setSnapStep(8);
    expect(useEditorStore.getState().snapStepStuds).toBe(8);

    useEditorStore.getState().setSnapStep(-5);
    expect(useEditorStore.getState().snapStepStuds).toBe(0);
  });

  it('setRotationStep stores and clamps to >=0.1', () => {
    useEditorStore.getState().setRotationStep(45);
    expect(useEditorStore.getState().rotationStepDegrees).toBe(45);

    useEditorStore.getState().setRotationStep(0);
    expect(useEditorStore.getState().rotationStepDegrees).toBeCloseTo(0.1);
  });
});

describe('editorStore — appearance toggles', () => {
  beforeEach(resetStore);

  it('setShowGrid toggles the grid flag', () => {
    useEditorStore.getState().setShowGrid(false);
    expect(useEditorStore.getState().showGrid).toBe(false);
    useEditorStore.getState().setShowGrid(true);
    expect(useEditorStore.getState().showGrid).toBe(true);
  });

  it('setSelectionTint sanitises the hex string', () => {
    useEditorStore.getState().setSelectionTint('ff0000');
    expect(useEditorStore.getState().selectionTint).toBe('FF0000');
  });

  it('setSelectionTint pads short strings', () => {
    useEditorStore.getState().setSelectionTint('abc');
    expect(useEditorStore.getState().selectionTint).toBe('ABC000');
  });

  it('setWheelZoomFactor clamps to [0.1, 10]', () => {
    useEditorStore.getState().setWheelZoomFactor(0.001);
    expect(useEditorStore.getState().wheelZoomFactor).toBeCloseTo(0.1);

    useEditorStore.getState().setWheelZoomFactor(999);
    expect(useEditorStore.getState().wheelZoomFactor).toBe(10);
  });

  it('setModuleFrameThickness clamps to [0.5, 20] in half-pixel steps (PreferencesDialog.cpp:200-207)', () => {
    useEditorStore.getState().setModuleFrameThickness(0);
    expect(useEditorStore.getState().moduleFrameThickness).toBe(0.5);

    useEditorStore.getState().setModuleFrameThickness(2.7);
    expect(useEditorStore.getState().moduleFrameThickness).toBe(2.5);

    useEditorStore.getState().setModuleFrameThickness(100);
    expect(useEditorStore.getState().moduleFrameThickness).toBe(20);
  });
});

describe('editorStore — status message', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('showStatusMessage sets the message', () => {
    useEditorStore.getState().showStatusMessage('Hello');
    expect(useEditorStore.getState().statusMessage).toBe('Hello');
  });

  it('auto-clears the message after the duration', () => {
    useEditorStore.getState().showStatusMessage('Temp', 1000);
    expect(useEditorStore.getState().statusMessage).toBe('Temp');
    vi.advanceTimersByTime(1001);
    expect(useEditorStore.getState().statusMessage).toBeNull();
  });

  it('replaces an earlier timer when called twice', () => {
    useEditorStore.getState().showStatusMessage('First', 500);
    useEditorStore.getState().showStatusMessage('Second', 1000);
    vi.advanceTimersByTime(600);
    // 'First' timer has fired but 'Second' is still alive.
    expect(useEditorStore.getState().statusMessage).toBe('Second');
    vi.advanceTimersByTime(500);
    expect(useEditorStore.getState().statusMessage).toBeNull();
  });
});

describe('showNotice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a busy notice until something replaces it', () => {
    useEditorStore.getState().showNotice('Making…', 'busy');
    vi.advanceTimersByTime(60_000);
    expect(useEditorStore.getState().notice).toMatchObject({ text: 'Making…', kind: 'busy' });
  });

  it('clears a result after its time, but not a newer notice', () => {
    useEditorStore.getState().showNotice('Saved', 'done', 1000);
    vi.advanceTimersByTime(500);
    useEditorStore.getState().showNotice('Saved again', 'done', 1000);
    vi.advanceTimersByTime(600);
    expect(useEditorStore.getState().notice?.text).toBe('Saved again');
    vi.advanceTimersByTime(500);
    expect(useEditorStore.getState().notice).toBeNull();
  });
});

describe('editorStore — misc setters', () => {
  beforeEach(resetStore);

  it('setActiveLayer sets the active layer id', () => {
    useEditorStore.getState().setActiveLayer('layer-xyz');
    expect(useEditorStore.getState().activeLayerId).toBe('layer-xyz');
    useEditorStore.getState().setActiveLayer(null);
    expect(useEditorStore.getState().activeLayerId).toBeNull();
  });

  it('setPlacePart records the part key', () => {
    useEditorStore.getState().setPlacePart('ts_track18s.0');
    expect(useEditorStore.getState().placePartKey).toBe('ts_track18s.0');
  });

  it('setLiveSnap stores and clears the snap ring position', () => {
    useEditorStore.getState().setLiveSnap({ studX: 5, studY: 10 });
    expect(useEditorStore.getState().liveSnap).toEqual({ studX: 5, studY: 10 });
    useEditorStore.getState().setLiveSnap(null);
    expect(useEditorStore.getState().liveSnap).toBeNull();
  });

  it('setHudMouse stores world-space cursor position', () => {
    useEditorStore.getState().setHudMouse(3.5, 7.25);
    expect(useEditorStore.getState().hudMouseStudX).toBe(3.5);
    expect(useEditorStore.getState().hudMouseStudY).toBe(7.25);
  });

  it('setHudMapBounds stores map dimensions', () => {
    useEditorStore.getState().setHudMapBounds(120, 80);
    expect(useEditorStore.getState().hudMapWidthStuds).toBe(120);
    expect(useEditorStore.getState().hudMapHeightStuds).toBe(80);
  });
});

describe('Use as Model (BlueBrick)', () => {
  it('asks the parts list for the part, a new request each time', async () => {
    const { useEditorStore } = await import('../editorStore');
    useEditorStore.getState().useAsModel('2865.8');
    const first = useEditorStore.getState().modelPart!;
    expect(first.key).toBe('2865.8');
    useEditorStore.getState().useAsModel('2865.8');
    expect(useEditorStore.getState().modelPart!.seq).toBe(first.seq + 1);
  });
});
