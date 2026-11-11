// Touch editing on phones (and the selection bar on tablets): the View /
// Edit switch, Undo / Redo, the bar of actions for the picked parts and
// the "Add part" sheet. Every action goes through the same canvas actions
// and mutations as the mouse and keyboard, so undo and live sync just work.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type PartWire } from '../api';
import { useEditorStore } from './editorStore';
import { indexParts } from './partIndex';
import { fuzzyScore, PartThumbnail } from './PartsPanel';
import { pushRecent } from './touchGesture';
import { isTouchDrawTool, TouchDrawBar } from './TouchTools';

const RECENT_KEY = 'cld:recentParts';
const MAX_RESULTS = 60;

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

function writeRecent(keys: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(keys));
  } catch {
    // Storage blocked: the list lasts as long as the page.
  }
}

/** View / Edit in the phone header. View is the default; people who can't edit never see this. */
export function ModeSwitch({ edit, onChange }: { edit: boolean; onChange: (edit: boolean) => void }) {
  const item = (on: boolean) =>
    `min-h-11 min-w-14 rounded-full px-3.5 text-sm font-bold ${on ? 'bg-accent text-accent-ink' : 'text-ink hover:bg-soft'}`;
  return (
    <div
      role="radiogroup"
      aria-label="View or edit"
      data-testid="mode-switch"
      data-tour="view.edit"
      className="flex shrink-0 items-center rounded-full border border-line bg-bg p-0.5"
    >
      <button type="button" role="radio" aria-checked={!edit} className={item(!edit)} onClick={() => onChange(false)}>
        View
      </button>
      <button type="button" role="radio" aria-checked={edit} className={item(edit)} onClick={() => onChange(true)}>
        Edit
      </button>
    </div>
  );
}

interface Actions {
  rotate: (cw: boolean) => void;
  duplicate: (beside?: boolean) => void;
  delete: () => void;
}

function BarButton({ label, short, onClick, children, pressed, danger, testId }: {
  label: string;
  /** Shown under the icon when the full label is too long for a phone's bar (it stays the button's name). */
  short?: string;
  onClick: () => void;
  children: ReactNode;
  pressed?: boolean;
  danger?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      {...(pressed !== undefined ? { 'aria-pressed': pressed } : {})}
      {...(testId ? { 'data-testid': testId } : {})}
      onClick={onClick}
      // Sized to its word (not equal shares), so nine fit across a Pixel 7 without the words running into each other.
      className={`flex min-h-14 min-w-11 shrink-0 grow flex-col items-center justify-center gap-0.5 rounded-control px-0.5 text-[11px] font-bold leading-tight ${
        pressed ? 'bg-accent text-accent-ink' : danger ? 'text-red-600 hover:bg-soft dark:text-red-400' : 'text-ink hover:bg-soft'
      }`}
    >
      {children}
      <span className="whitespace-nowrap">{short ?? label}</span>
    </button>
  );
}

const svg = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const RotLeft = () => (<svg {...svg}><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 3v5h5" /></svg>);
const RotRight = () => (<svg {...svg}><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v5h-5" /></svg>);
const Copy = () => (<svg {...svg}><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></svg>);
const PasteIcon = () => (<svg {...svg}><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V3h6v1" /><path d="M9 11h6M9 15h4" /></svg>);
const RulerIcon = () => (<svg {...svg}><path d="M3 17L17 3l4 4L7 21z" /><path d="M7 13l2 2M10 10l2 2M13 7l2 2" /></svg>);
const Trash = () => (<svg {...svg}><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M6 6l1 15h10l1-15" /></svg>);
const Check = () => (<svg {...svg}><path d="M5 12l5 5L20 7" /></svg>);
const Plus = () => (<svg {...svg}><path d="M12 5v14M5 12h14" /></svg>);
const More = () => (<svg {...svg}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M17.5 14v7M14 17.5h7" /></svg>);
const Area = () => (<svg {...svg}><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /><path d="M9 9h6v6H9z" /></svg>);
const ModuleIcon = () => (<svg {...svg}><rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="4 3" /><rect x="8" y="8" width="8" height="8" rx="1" /></svg>);
const Dots = () => (<svg {...svg}><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>);
const Layers = () => (<svg {...svg}><path d="M12 3l9 5-9 5-9-5z" /><path d="M3 13l9 5 9-5" /></svg>);
const Pencil = () => (<svg {...svg}><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13 7l4 4" /></svg>);
const UndoIcon = () => (<svg {...svg}><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></svg>);
const RedoIcon = () => (<svg {...svg}><path d="M15 14l5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h3" /></svg>);

/** Undo / Redo, floating over the top corner of the map while editing by touch. */
export function TouchUndoRedo({ undo, top }: { undo: { canUndo: boolean; canRedo: boolean; undo: () => void; redo: () => void }; top: string }) {
  const btn = 'flex size-11 items-center justify-center rounded-full text-ink hover:bg-soft disabled:opacity-35';
  return (
    <div
      data-no-gesture
      className="absolute z-10 flex gap-1 rounded-full border border-line bg-panel p-0.5 shadow-pop"
      style={{ top, left: 'max(0.5rem, env(safe-area-inset-left))' }}
    >
      <button type="button" aria-label="Undo" title="Undo" disabled={!undo.canUndo} onClick={undo.undo} className={btn}>
        <UndoIcon />
      </button>
      <button type="button" aria-label="Redo" title="Redo" disabled={!undo.canRedo} onClick={undo.redo} className={btn}>
        <RedoIcon />
      </button>
    </div>
  );
}

/**
 * The bar along the bottom of the map while editing by touch. With parts
 * picked: Rotate left / right, Duplicate, Module (make one, or the picked
 * module's menu), More actions (Save as set, Group, Ungroup and the rest:
 * TouchPickedSheet: Copy, Cut and Paste are there too), Delete, Select
 * more, Select area and Done. With nothing picked: Add part, Paste, Tools
 * (measure and paint: TouchTools), Select more, Select area and Sheets.
 * While measuring or painting, the bar is TouchDrawBar.
 */
export function TouchActionBar({ actions, onAddPart, onPaste, onTools, onSheets, onEditText, onModule, onMore }: {
  actions: Actions;
  /** Opens the measure and paint tools (TouchToolsSheet). */
  onTools?: (() => void) | undefined;
  /** Paste what was copied (in this layout, another one, or another device), in the middle of the view. */
  onPaste?: (() => void) | undefined;
  /** The picked parts' other actions (TouchPickedSheet). */
  onMore?: (() => void) | undefined;
  /** The picked parts' module: Make a module, or the picked module's own menu. */
  onModule?: (() => void) | undefined;
  onAddPart?: (() => void) | undefined;
  /** Opens the sheets list (add, delete, show / hide, fade, rename, reorder). */
  onSheets?: (() => void) | undefined;
  /** Opens the text editor for the one picked label or text. */
  onEditText?: (() => void) | undefined;
}) {
  const parts = useEditorStore((s) => s.selection.length);
  const anno = useEditorStore((s) => s.annoSelection);
  const count = parts + anno.labels.length + anno.texts.length + anno.rulers.length;
  const oneText = parts === 0 && anno.rulers.length === 0 && anno.labels.length + anno.texts.length === 1;
  const more = useEditorStore((s) => s.touchSelectMore);
  const area = useEditorStore((s) => s.touchSelectArea);
  const drawing = useEditorStore((s) => isTouchDrawTool(s.tool));
  const oneRuler = parts === 0 && anno.labels.length + anno.texts.length === 0 && anno.rulers.length === 1;
  if (drawing && onAddPart) return <TouchDrawBar />;
  if (count === 0 && !onAddPart) return null;
  const toggleMore = () => useEditorStore.setState({ touchSelectMore: !more });
  const toggleArea = () => useEditorStore.setState({ touchSelectArea: !area });
  // With parts picked the bar is full, so it shows the short word.
  const areaButton = (short?: string) => (
    <BarButton label="Select area" {...(short ? { short } : {})} pressed={area} onClick={toggleArea} testId="select-area"><Area /></BarButton>
  );
  return (
    <div
      role="toolbar"
      aria-label={count > 0 ? `${count} picked` : 'Touch editing'}
      data-testid="touch-bar"
      data-keep-clear
      data-tour="touch.bar"
      className="absolute inset-x-0 bottom-0 z-10 border-t border-line bg-panel/95 pt-1 shadow-pop backdrop-blur"
      style={{ paddingLeft: 'max(0.25rem, env(safe-area-inset-left))', paddingRight: 'max(0.25rem, env(safe-area-inset-right))', paddingBottom: '0.25rem' }}
      // A tap here is a button press, never a gesture on the map below.
      data-no-gesture
    >
      {area && (
        <p role="status" className="px-2 pb-1 text-center text-xs font-semibold text-muted">
          Drag a box around the parts to pick. Two fingers move the map.
        </p>
      )}
      {!area && !oneRuler && count > 0 && (
        // How many are picked, and when taps add to them (a long press turns that on).
        <p role="status" data-testid="picked-count" className="px-2 pb-1 text-center text-xs font-semibold text-muted">
          {more ? `${count} picked · Select more is on: tap more parts to add them` : `${count} picked`}
        </p>
      )}
      {!area && oneRuler && (
        <p role="status" className="px-2 pb-1 text-center text-xs font-semibold text-muted">
          Drag the round handles to adjust the ruler. Tap Done when it’s right.
        </p>
      )}
      {count > 0 ? (
        // On the narrowest phones the row scrolls sideways rather than squeezing the words together.
        <div className="flex items-stretch overflow-x-auto [scrollbar-width:none]">
          {oneText && onEditText && <BarButton label="Edit text" onClick={onEditText} testId="edit-text"><Pencil /></BarButton>}
          {parts > 0 && (
            <>
              <BarButton label="Turn left" short="Left" onClick={() => actions.rotate(false)}><RotLeft /></BarButton>
              <BarButton label="Turn right" short="Right" onClick={() => actions.rotate(true)}><RotRight /></BarButton>
              <BarButton label="Duplicate" onClick={() => actions.duplicate(true)}><Copy /></BarButton>
              {onModule && <BarButton label="Module" onClick={onModule} testId="touch-module"><ModuleIcon /></BarButton>}
              {onMore && <BarButton label="More actions" short="Actions" onClick={onMore} testId="touch-more"><Dots /></BarButton>}
            </>
          )}
          <BarButton label="Delete" danger onClick={() => actions.delete()}><Trash /></BarButton>
          <BarButton label="Select more" short="More" pressed={more} onClick={toggleMore}><More /></BarButton>
          {areaButton('Area')}
          <BarButton
            label="Done"
            onClick={() => {
              useEditorStore.getState().setSelection([]);
              useEditorStore.setState({ touchSelectMore: false, touchSelectArea: false });
            }}
          >
            <Check />
          </BarButton>
        </div>
      ) : (
        <div className="flex items-stretch gap-0.5">
          <button
            type="button"
            onClick={onAddPart}
            data-testid="add-part"
            className="flex min-h-14 flex-[2_0_auto] items-center whitespace-nowrap justify-center gap-1.5 rounded-control bg-accent px-3 text-base font-bold text-accent-ink hover:bg-accent-hover"
          >
            <Plus />
            Add part
          </button>
          {onPaste && <BarButton label="Paste" onClick={onPaste} testId="touch-paste"><PasteIcon /></BarButton>}
          {onTools && <BarButton label="Measure and paint" short="Tools" onClick={onTools} testId="touch-tools"><RulerIcon /></BarButton>}
          {/* The short words, so six fit across a 360 px phone. */}
          <BarButton label="Select more" short="More" pressed={more} onClick={toggleMore}><More /></BarButton>
          {areaButton('Area')}
          {onSheets && <BarButton label="Sheets" onClick={onSheets} testId="touch-sheets"><Layers /></BarButton>}
        </div>
      )}
    </div>
  );
}

/**
 * "Add part": a sheet that slides up from the bottom, with a search box,
 * the parts placed most recently, and the parts that match. A tap places
 * the part in the middle of the screen, picked, ready to drag.
 */
export function AddPartSheet({ onPick, onClose }: { onPick: (part: PartWire) => void; onClose: () => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['parts-catalog'], queryFn: api.parts.catalog, staleTime: 60 * 1000 });
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState(false);
  const [recent] = useState(readRecent);
  const inputRef = useRef<HTMLInputElement>(null);
  // Slide in once mounted.
  useEffect(() => {
    const id = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(id);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const partsByKey = useMemo(() => indexParts(data?.parts), [data]);
  const recentParts = useMemo(
    () => recent.map((k) => partsByKey.get(k.toLowerCase())).filter((p): p is PartWire => !!p),
    [recent, partsByKey],
  );
  const results = useMemo(() => {
    if (!data) return [];
    const needle = filter.trim().toLowerCase();
    const scored: { score: number; part: PartWire }[] = [];
    for (const p of data.parts) {
      const score = fuzzyScore(needle, `${p.key} ${p.description}`.toLowerCase());
      if (score > 0) scored.push({ score, part: p });
    }
    scored.sort((a, b) => (needle && a.score !== b.score ? b.score - a.score : a.part.key.localeCompare(b.part.key)));
    return scored.slice(0, MAX_RESULTS).map((s) => s.part);
  }, [data, filter]);

  const pick = (p: PartWire) => {
    writeRecent(pushRecent(readRecent(), p.key));
    onPick(p);
  };

  return (
    <div className="fixed inset-0 z-40" data-no-gesture data-bottom-sheet>
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${open ? 'opacity-100' : 'opacity-0'}`}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add a part"
        className={`absolute inset-x-0 bottom-0 flex max-h-[80dvh] flex-col rounded-t-2xl border-t border-line bg-panel text-ink shadow-pop transition-transform duration-200 ease-out ${open ? 'translate-y-0' : 'translate-y-full'}`}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-line" aria-hidden />
        <div className="flex items-center gap-2 px-4 pt-2">
          <h2 className="flex-1 text-lg font-bold">Add a part</h2>
          <button type="button" onClick={onClose} className="min-h-11 rounded-control px-4 text-sm font-bold hover:bg-soft">
            Close
          </button>
        </div>
        <div className="px-4 pb-2 pt-1">
          <input
            ref={inputRef}
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search parts, like 2x4 or curve"
            aria-label="Search parts"
            // 16 px, so iOS doesn't zoom in on the field.
            className="h-11 w-full rounded-control border border-line bg-bg px-3 text-base"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
          {recentParts.length > 0 && !filter.trim() && (
            <section aria-label="Recent parts" className="mb-3">
              <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">Recent</h3>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {recentParts.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => pick(p)}
                    title={p.description}
                    aria-label={`${p.description || p.key} (recent)`}
                    className="flex min-h-11 w-20 shrink-0 flex-col items-center gap-1 rounded-control border border-line p-1.5 text-[11px] hover:bg-soft"
                  >
                    <PartThumbnail part={p} partsByKey={partsByKey} imgCls="h-10 w-10" />
                    <span className="w-full truncate">{p.partNumber}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
          <h3 className="mb-1 text-xs font-bold uppercase tracking-wide text-muted">{filter.trim() ? 'Matches' : 'All parts'}</h3>
          {isLoading && <p className="py-4 text-sm text-muted">Loading parts…</p>}
          {!isLoading && results.length === 0 && <p className="py-4 text-sm text-muted">No parts match “{filter}”.</p>}
          <ul className="flex flex-col gap-1">
            {results.map((p) => (
              <li key={p.key}>
                <button
                  type="button"
                  onClick={() => pick(p)}
                  data-part-key={p.key}
                  className="flex min-h-14 w-full items-center gap-3 rounded-control px-2 py-1 text-left hover:bg-soft"
                >
                  <PartThumbnail part={p} partsByKey={partsByKey} imgCls="h-11 w-11 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold">{p.description || p.partNumber}</span>
                    <span className="block truncate text-xs text-muted">{p.key}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {results.length === MAX_RESULTS && <p className="pt-2 text-xs text-muted">Type to find more.</p>}
        </div>
      </div>
    </div>
  );
}

