// The Venue Designer: a full-screen editor for one venue. Tools on the
// left, the drawing in the middle, the inspector on the right, layer
// toggles above and the cursor, venue size and hint below. It edits a copy;
// `onSave` gets the result (a library venue, or the layout's venue).

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { Venue } from '@cld/bbm';
import { DesignerCanvas, type View } from './DesignerCanvas';
import { Inspector } from './Inspector';
import { initialState, reducer, TOOLS, venueOf, type Layer } from './designerState';
import { estimateCount, roomSize, type Pt } from './model';
import { calibrate, loadPlan, planOf, withPlan, type FloorPlan } from './plan';
import { formatArea, formatLength, parseLength, STUDS_PER_INCH, type LengthUnit } from './units';
import { HelpButton } from '../../help/HelpButton';
import { HelpMenu } from '../../editor/EditorChrome';
import { askConfirm } from '../../ui/ConfirmDialog';

const FT = 12 * STUDS_PER_INCH;
const LAYERS: { layer: Layer; name: string }[] = [
  { layer: 'plan', name: 'Floor plan' },
  { layer: 'obstacles', name: 'Obstacles' },
  { layer: 'power', name: 'Power' },
  { layer: 'dimensions', name: 'Measurements' },
  { layer: 'notes', name: 'Notes' },
  { layer: 'estimates', name: 'Estimates' },
];
// Keys a length or a size is typed with while drawing.
const TYPING = /^[0-9.'"′″ /xX×a-zA-Z]$/;

export function VenueDesigner({
  initial,
  subtitle,
  saveLabel = 'Save venue',
  onSave,
  onClose,
}: {
  initial: Venue;
  subtitle?: string;
  saveLabel?: string;
  onSave: (v: Venue) => Promise<void> | void;
  onClose: () => void;
}) {
  const [state, dispatch] = useReducer(reducer, initial, initialState);
  const [view, setView] = useState<View | null>(null);
  const [cursor, setCursor] = useState<Pt | null>(null);
  const [planMoving, setPlanMoving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Venue>(initial);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const venue = venueOf(state);
  const plan = planOf(venue);
  const dirty = venue !== saved;
  const drawing = state.draft.length > 0 || state.cut !== null;

  // Keyboard: tool keys, lengths typed while drawing, Enter / Esc, Delete,
  // undo / redo, duplicate. Ignored while typing in a text box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? 'redo' : 'undo' });
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        dispatch({ type: 'redo' });
        return;
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        dispatch({ type: 'duplicate' });
        return;
      }
      if (mod) return;
      if (e.key === 'Escape') return dispatch({ type: 'escape' });
      if (e.key === 'Enter') return dispatch({ type: 'enter' });
      if (drawing) {
        if (e.key === 'Backspace') {
          e.preventDefault();
          return dispatch({ type: 'type', text: state.typed.slice(0, -1) });
        }
        if (TYPING.test(e.key) && (state.typed !== '' || /[0-9.]/.test(e.key))) {
          e.preventDefault();
          return dispatch({ type: 'type', text: state.typed + e.key });
        }
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection) {
        e.preventDefault();
        return dispatch({ type: 'delete' });
      }
      const tool = TOOLS.find((x) => x.key === e.key.toLowerCase());
      if (tool) dispatch({ type: 'tool', tool: tool.tool });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawing, state.typed, state.selection]);

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [dirty]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(venue);
      setSaved(venue);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const close = async () => {
    if (dirty && !(await askConfirm({
      title: 'Close without saving?',
      removes: 'Your changes to the venue are thrown away.',
      undo: 'This can’t be undone.',
      confirmLabel: 'Discard changes',
    }))) return;
    onClose();
  };

  const setPlan = useCallback((p: FloorPlan | null) => dispatch({ type: 'edit', venue: withPlan(venue, p) }), [venue]);
  const pickPlan = async (file: File | undefined) => {
    if (!file) return;
    try {
      // First placed at the view's top-left, 150 ft wide; calibrate it next.
      const at = view ? { x: (40 - view.x) / view.scale, y: (40 - view.y) / view.scale } : { x: 0, y: 0 };
      setPlan(await loadPlan(file, at, 150 * FT));
      dispatch({ type: 'tool', tool: 'calibrate' });
    } catch (err) {
      setError(`Could not load the floor plan: ${(err as Error).message}`);
    }
  };

  const size = roomSize(venue);
  const estimates = estimateCount(venue);
  const hint =
    state.message ||
    (state.tool === 'calibrate'
      ? state.calibration.length < 2
        ? 'Click two points on the floor plan whose real distance you know'
        : 'Enter the real distance between the two points in the inspector'
      : planMoving
        ? 'Drag to move the floor plan'
        : (TOOLS.find((t) => t.tool === state.tool)?.hint ?? ''));

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-bg text-ink">
      {/* On a phone or a tablet held upright the buttons wrap under the name
          (one row squeezed "Save to layout" out of its button on an iPad). */}
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-panel px-3 pb-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] lg:flex-nowrap lg:px-4 lg:py-0 [&_button]:whitespace-nowrap">
        <div className="min-w-0 basis-full lg:basis-auto lg:flex-1">
          <div className="truncate font-semibold">
            {venue.name || 'Venue'}
            {dirty && <span className="ml-2 text-xs font-normal text-amber-300">unsaved</span>}
          </div>
          {subtitle && <div className="truncate text-xs text-muted">{subtitle}</div>}
        </div>
        <label data-tour="room.units" className="flex items-center gap-2 text-sm text-neutral-300">
          Units
          <select
            value={state.unit}
            onChange={(e) => dispatch({ type: 'unit', unit: e.target.value as LengthUnit })}
            className="h-8 rounded-md border border-neutral-600 bg-soft px-2 text-sm"
          >
            <option value="ftin">Feet &amp; inches</option>
            <option value="m">Meters</option>
            <option value="studs">Studs</option>
          </select>
        </label>
        <HelpButton helpKey="room.units" />
        <label data-tour="room.snap" className="flex items-center gap-2 text-sm text-neutral-300 pointer-coarse:min-h-11" title="Snap to corners, walls, 45° and whole inches (hold Shift for any angle)">
          <input type="checkbox" checked={state.snap} onChange={(e) => dispatch({ type: 'snap', on: e.target.checked })} />
          Snap
        </label>
        <HelpButton helpKey="room.snap" />
        <button type="button" onClick={() => dispatch({ type: 'undo' })} disabled={!state.history.past.length} className="h-9 rounded-md border border-neutral-600 px-3 text-sm hover:bg-soft disabled:opacity-40">
          Undo
        </button>
        <button type="button" onClick={() => dispatch({ type: 'redo' })} disabled={!state.history.future.length} className="h-9 rounded-md border border-neutral-600 px-3 text-sm hover:bg-soft disabled:opacity-40">
          Redo
        </button>
        <button type="button" data-tour="room.floorPlan" onClick={() => fileInput.current?.click()} className="h-9 rounded-md border border-neutral-600 px-3 text-sm hover:bg-soft">
          {plan ? 'Replace floor plan…' : 'Floor plan…'}
        </button>
        <HelpButton helpKey="room.floorPlan" />
        <input ref={fileInput} type="file" accept="image/*" className="hidden" aria-label="Floor plan image" onChange={(e) => void pickPlan(e.target.files?.[0]).then(() => (e.target.value = ''))} />
        <button type="button" data-tour="roomDesigner.save" onClick={() => void save()} disabled={saving || !dirty} className="h-9 rounded-md bg-accent text-accent-ink px-4 text-sm font-medium hover:bg-accent-hover disabled:opacity-50">
          {saving ? 'Saving…' : saveLabel}
        </button>
        <button type="button" onClick={close} className="h-9 rounded-md border border-neutral-600 px-3 text-sm hover:bg-soft">
          Close
        </button>
        <HelpMenu />
      </header>
      {error && <div className="border-b border-red-900 bg-red-950/60 px-4 py-2 text-sm text-red-200">{error}</div>}
      {/* Upright on a phone (or a narrow tablet): tools in a row along the
          top, the map, then the inspector underneath. */}
      <div className="flex min-h-0 flex-1 max-md:portrait:flex-col">
        <nav
          aria-label="Tools"
          data-tour="room.tools"
          data-scroll-x
          className="flex w-20 shrink-0 flex-col gap-1 overflow-y-auto border-r border-line bg-panel p-2 max-md:landscape:w-16 max-md:portrait:w-auto max-md:portrait:flex-row max-md:portrait:overflow-x-auto max-md:portrait:overflow-y-hidden max-md:portrait:border-b max-md:portrait:border-r-0 max-md:portrait:p-1"
        >
          <div className="flex shrink-0 items-center justify-center py-1">
            <HelpButton helpKey="room.tools" target='nav[aria-label="Tools"]' />
          </div>
          {TOOLS.map((t) => (
            <button
              key={t.tool}
              type="button"
              title={t.hint}
              aria-pressed={state.tool === t.tool}
              onClick={() => {
                setPlanMoving(false);
                dispatch({ type: 'tool', tool: t.tool });
              }}
              className={`flex h-12 shrink-0 flex-col items-center justify-center rounded-lg text-xs max-md:portrait:min-w-16 ${state.tool === t.tool ? 'bg-accent-hover/20 font-semibold text-blue-200' : 'text-neutral-300 hover:bg-soft'}`}
            >
              {t.label}
              <span className="font-mono text-[10px] text-muted">{t.key.toUpperCase()}</span>
            </button>
          ))}
        </nav>
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-panel/60 px-4 py-1 text-sm text-neutral-300">
            <span className="flex items-center gap-1.5 font-semibold">
              Show
              <HelpButton helpKey="room.show" target="main > div" />
            </span>
            {LAYERS.map((l) => (
              <label key={l.layer} className="flex items-center gap-1.5 pointer-coarse:min-h-11">
                <input type="checkbox" checked={state.show[l.layer]} onChange={(e) => dispatch({ type: 'show', layer: l.layer, on: e.target.checked })} />
                {l.name}
              </label>
            ))}
            <span className="flex-1" />
            {estimates > 0 && <span className="text-amber-300">{estimates} estimate{estimates === 1 ? '' : 's'} left to measure</span>}
          </div>
          <div className="relative min-h-0 flex-1">
            <DesignerCanvas
              state={state}
              dispatch={dispatch}
              view={view}
              setView={setView}
              planMoving={planMoving}
              onPlanMoved={setPlan}
              onCursor={setCursor}
            />
            <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-lg border border-border bg-panel/90 p-1 text-sm">
              <button type="button" aria-label="Zoom out" onClick={() => view && setView({ ...view, scale: view.scale / 1.25 })} className="h-8 w-8 rounded hover:bg-soft">
                −
              </button>
              <button type="button" aria-label="Zoom in" onClick={() => view && setView({ ...view, scale: view.scale * 1.25 })} className="h-8 w-8 rounded hover:bg-soft">
                +
              </button>
              <button type="button" onClick={() => setView(null)} className="h-8 rounded px-2 hover:bg-soft">
                Fit
              </button>
            </div>
          </div>
          <footer className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-6 gap-y-0.5 border-t border-line bg-panel px-4 pb-[env(safe-area-inset-bottom)] text-xs text-muted">
            <span className="font-mono pointer-coarse:hidden">{cursor ? `${formatLength(cursor.x, state.unit)}, ${formatLength(cursor.y, state.unit)}` : '—'}</span>
            {size && (
              <span>
                Venue {formatLength(size.w, state.unit)} × {formatLength(size.h, state.unit)} · {formatArea(size.area, state.unit)}
              </span>
            )}
            <span className={`min-w-0 truncate ${state.message ? 'text-amber-300' : ''}`}>
              {state.typed ? `Typing ${state.typed} — Enter to apply` : hint}
            </span>
          </footer>
        </main>
        <Inspector
          state={state}
          dispatch={dispatch}
          extra={
            plan && (
              <PlanPanel
                plan={plan}
                calibration={state.calibration}
                unit={state.unit}
                moving={planMoving}
                onMove={(on) => {
                  setPlanMoving(on);
                  if (on) dispatch({ type: 'tool', tool: 'select' });
                }}
                onCalibrate={() => {
                  setPlanMoving(false);
                  dispatch({ type: 'tool', tool: 'calibrate' });
                }}
                onApply={(real) => {
                  const [a, b] = state.calibration;
                  if (a && b) setPlan(calibrate(plan, a, b, real));
                  dispatch({ type: 'tool', tool: 'select' });
                }}
                onChange={setPlan}
              />
            )
          }
        />
      </div>
    </div>
  );
}

function PlanPanel({
  plan,
  calibration,
  unit,
  moving,
  onMove,
  onCalibrate,
  onApply,
  onChange,
}: {
  plan: FloorPlan;
  calibration: Pt[];
  unit: LengthUnit;
  moving: boolean;
  onMove: (on: boolean) => void;
  onCalibrate: () => void;
  onApply: (realStuds: number) => void;
  onChange: (p: FloorPlan | null) => void;
}) {
  const [real, setReal] = useState('');
  const [bad, setBad] = useState(false);
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
        Floor plan
        <HelpButton helpKey="room.calibrate" target="section" />
      </div>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Opacity {Math.round(plan.opacity * 100)}%
        <input type="range" min={0.1} max={1} step={0.05} value={plan.opacity} onChange={(e) => onChange({ ...plan, opacity: Number(e.target.value) })} />
      </label>
      {calibration.length === 2 ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = parseLength(real, unit);
            if (v === null || v <= 0) return setBad(true);
            setBad(false);
            onApply(v);
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-muted">
            Real distance between the two points
            <input
              autoFocus
              value={real}
              onChange={(e) => setReal(e.target.value)}
              placeholder={`e.g. 40' 4"`}
              aria-invalid={bad}
              className={`h-9 rounded-md border bg-soft px-2.5 font-mono text-sm ${bad ? 'border-red-500' : 'border-neutral-600'}`}
            />
          </label>
          <button type="submit" className="h-9 rounded-md bg-accent text-accent-ink text-sm font-medium hover:bg-accent-hover">
            Scale the floor plan
          </button>
        </form>
      ) : (
        <p className="text-xs text-muted">
          1 image pixel = {formatLength(plan.studsPerPx, unit)}. Calibrate by clicking two points you know the distance between.
        </p>
      )}
      <div className="flex gap-2">
        <button type="button" onClick={onCalibrate} className="h-9 flex-1 rounded-md border border-neutral-600 text-sm hover:bg-soft">
          Calibrate
        </button>
        <button type="button" aria-pressed={moving} onClick={() => onMove(!moving)} className={`h-9 flex-1 rounded-md border text-sm ${moving ? 'border-accent bg-accent-hover/20' : 'border-neutral-600 hover:bg-soft'}`}>
          Move
        </button>
        <button type="button" onClick={() => onChange(null)} className="h-9 flex-1 rounded-md border border-neutral-600 text-sm hover:bg-soft">
          Remove
        </button>
      </div>
    </section>
  );
}
