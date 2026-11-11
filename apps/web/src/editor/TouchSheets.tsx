// Touch editing's bottom sheets beyond "Add part": the sheets (layers)
// list, to add, delete, show / hide, fade, rename and reorder from a
// phone or tablet, with controls big enough for a finger. Every change goes through the same mutations as
// the Sheets panel, so undo and live sync just work.

import { useEffect, useState, type ReactNode } from 'react';
import type * as Y from 'yjs';
import type { BbmMap, Layer } from '@cld/model';
import { useEditorStore } from './editorStore';
import { addLayer, deleteLayer, moveLayer, renameLayer, setLayerTransparency, setLayerVisible } from './mutations';
import { confirmDelete } from '../ui/ConfirmDialog';
import { SHEET_KINDS, deleteSheetWording, sheetContents } from './sheetContents';
import { displaySheetName, renamedSheet } from './activeSheet';

/** A sheet that slides up from the bottom, over a dimmed map, with a title and Close. */
export function BottomSheet({ title, onClose, children, footer }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
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
        aria-label={title}
        className={`absolute inset-x-0 bottom-0 flex max-h-[80dvh] flex-col rounded-t-2xl border-t border-line bg-panel text-ink shadow-pop transition-transform duration-200 ease-out ${open ? 'translate-y-0' : 'translate-y-full'}`}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-line" aria-hidden />
        <div className="flex items-center gap-2 px-4 pt-2">
          <h2 className="flex-1 text-lg font-bold">{title}</h2>
          <button type="button" onClick={onClose} className="min-h-11 rounded-control px-4 text-sm font-bold hover:bg-soft">
            Close
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 pt-2">{children}</div>
        {footer && <div className="border-t border-line px-4 py-2">{footer}</div>}
      </div>
    </div>
  );
}

const svg = { width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const Eye = () => (<svg {...svg}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>);
const EyeOff = () => (<svg {...svg}><path d="M3 3l18 18" /><path d="M10.6 5.1A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6" /></svg>);
const Pencil = () => (<svg {...svg}><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>);
const Up = () => (<svg {...svg}><path d="M6 15l6-6 6 6" /></svg>);
const Down = () => (<svg {...svg}><path d="M6 9l6 6 6-6" /></svg>);
const Trash = () => (<svg {...svg}><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" /></svg>);
const Plus = () => (<svg {...svg}><path d="M12 5v14M5 12h14" /></svg>);

const KIND: Record<Layer['type'], string> = { grid: 'Grid', brick: 'Parts', text: 'Text', area: 'Area', ruler: 'Rulers' };

const iconBtn =
  'flex size-11 shrink-0 items-center justify-center rounded-control text-ink hover:bg-soft disabled:opacity-30';

async function askDeleteSheet(doc: Y.Doc, layer: Layer) {
  if (!(await confirmDelete(displaySheetName(layer.name), deleteSheetWording(layer, 'You can undo this with Undo.')))) return;
  deleteLayer(doc, layer.id);
  const { activeLayerId, setActiveLayer } = useEditorStore.getState();
  if (activeLayerId === layer.id) setActiveLayer(null);
}

function SheetRow({ layer, doc, first, last, active, onMoveHere }: {
  layer: Layer;
  doc: Y.Doc;
  first: boolean;
  last: boolean;
  active: boolean;
  /** Put the picked parts on this sheet (only on other part sheets, with parts picked). */
  onMoveHere?: (() => void) | undefined;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(displaySheetName(layer.name));
  const label = layer.name ? displaySheetName(layer.name) : KIND[layer.type];
  const save = () => {
    const next = renamedSheet(layer.name, name);
    if (next) renameLayer(doc, layer.id, next);
    setRenaming(false);
  };
  return (
    <li data-sheet={layer.id} className={`rounded-control px-1 pb-1 ${active ? 'bg-soft' : ''}`}>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label={`${layer.visible ? 'Hide' : 'Show'} ${label}`}
          aria-pressed={layer.visible}
          onClick={() => setLayerVisible(doc, layer.id, !layer.visible)}
          className={iconBtn}
        >
          {layer.visible ? <Eye /> : <EyeOff />}
        </button>
        {renaming ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label={`New name for ${label}`}
              maxLength={120}
              // 16 px, so iOS doesn't zoom in on the field.
              className="h-11 min-w-0 flex-1 rounded-control border border-line bg-bg px-3 text-base"
            />
            <button type="submit" className="min-h-11 shrink-0 rounded-control bg-accent px-3 text-sm font-bold text-accent-ink">
              Save
            </button>
          </form>
        ) : (
          <>
            <button
              type="button"
              onClick={() => useEditorStore.getState().setActiveLayer(layer.id)}
              aria-current={active ? 'true' : undefined}
              className={`min-h-11 min-w-0 flex-1 text-left ${layer.visible ? '' : 'text-muted'}`}
            >
              <span className="block truncate text-base font-bold">{label}</span>
              <span className="block truncate text-xs text-muted">
                {KIND[layer.type]} · {sheetContents(layer)}
                {active ? ' · picked sheet' : ''}
              </span>
            </button>
            <button type="button" aria-label={`Move ${label} up`} disabled={first} onClick={() => moveLayer(doc, layer.id, 'up')} className={iconBtn}>
              <Up />
            </button>
            <button type="button" aria-label={`Move ${label} down`} disabled={last} onClick={() => moveLayer(doc, layer.id, 'down')} className={iconBtn}>
              <Down />
            </button>
          </>
        )}
      </div>
      {!renaming && (
        <div className="flex items-center gap-1">
          {/* Lined up under the name, past the eye button. */}
          <label className="flex min-h-11 min-w-0 flex-1 items-center gap-2 pl-12 text-xs text-muted">
            <span className="shrink-0">Solid</span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={layer.transparency}
              onChange={(e) => setLayerTransparency(doc, layer.id, parseInt(e.target.value, 10))}
              aria-label={`How solid ${label} is`}
              aria-valuetext={`${layer.transparency}%`}
              className="h-11 min-w-0 flex-1 accent-accent"
            />
            <span className="w-9 shrink-0 text-right tabular-nums">{layer.transparency}%</span>
          </label>
          <button
            type="button"
            aria-label={`Rename ${label}`}
            onClick={() => {
              setName(displaySheetName(layer.name));
              setRenaming(true);
            }}
            className={iconBtn}
          >
            <Pencil />
          </button>
          <button type="button" aria-label={`Delete ${label}`} onClick={() => void askDeleteSheet(doc, layer)} className={`${iconBtn} text-danger`}>
            <Trash />
          </button>
        </div>
      )}
      {onMoveHere && !renaming && (
        // Its own line, so the Solid slider keeps its width.
        <div className="pl-12 pr-1 pt-1">
          <button type="button" onClick={onMoveHere} data-testid="move-here" className="min-h-11 w-full rounded-control bg-accent px-3 text-sm font-bold text-accent-ink hover:bg-accent-hover">
            Move here
          </button>
        </div>
      )}
    </li>
  );
}

/** Pick the kind of sheet to add: big rows that say what each kind is for. */
function AddSheetChoices({ doc, onDone }: { doc: Y.Doc; onDone: () => void }) {
  return (
    <div role="group" aria-label="Add a sheet" className="flex flex-col gap-1">
      <p className="text-sm font-bold">What will go on the new sheet?</p>
      {SHEET_KINDS.map(({ kind, label, about }) => (
        <button
          key={kind}
          type="button"
          onClick={() => {
            const id = addLayer(doc, kind);
            useEditorStore.getState().setActiveLayer(id);
            onDone();
          }}
          className="min-h-11 rounded-control border border-line px-3 py-1.5 text-left hover:bg-soft"
        >
          <span className="block text-base font-bold">{label}</span>
          <span className="block text-xs text-muted">{about}</span>
        </button>
      ))}
      <button type="button" onClick={onDone} className="min-h-11 rounded-control px-3 text-sm font-bold hover:bg-soft">
        Cancel
      </button>
    </div>
  );
}

/** The sheets, topmost first (as the Sheets panel lists them): add, delete, show / hide, fade, rename and reorder by touch. */
export function SheetsSheet({ map, doc, onClose, onMovePicked }: {
  map: BbmMap;
  doc: Y.Doc;
  onClose: () => void;
  /** Move the picked parts to that part sheet, or (null) to a new one. */
  onMovePicked?: ((sheetId: string | null) => void) | undefined;
}) {
  const activeLayerId = useEditorStore((s) => s.activeLayerId);
  const selection = useEditorStore((s) => s.selection);
  const [adding, setAdding] = useState(false);
  const rows = [...map.layers].reverse();
  // The picked parts: which sheets they're on, so each other part sheet can take them.
  const picked = new Set(selection);
  const pickedOn = onMovePicked && picked.size > 0
    ? new Set(map.layers.filter((l) => l.type === 'brick' && l.bricks.some((b) => picked.has(b.id))).map((l) => l.id))
    : new Set<string>();
  const onlyOn = pickedOn.size === 1 ? map.layers.find((l) => pickedOn.has(l.id)) : undefined;
  return (
    <BottomSheet
      title="Sheets"
      onClose={onClose}
      footer={
        adding ? (
          <AddSheetChoices doc={doc} onDone={() => setAdding(false)} />
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-control bg-accent px-4 text-sm font-bold text-accent-ink hover:bg-accent-hover"
          >
            <Plus />
            Add a sheet
          </button>
        )
      }
    >
      <p className="mb-2 text-sm text-muted">
        Sheets are like see-through pages. The top one is drawn over the others. Slide “Solid” down to fade a sheet.
      </p>
      {pickedOn.size > 0 && (
        <div role="status" data-testid="picked-sheet" className="mb-2 flex flex-col gap-2 rounded-control bg-accent-soft p-3 text-sm text-ink">
          <p>
            {selection.length === 1 ? 'The picked part is' : `The ${selection.length} picked parts are`} on{' '}
            {onlyOn ? <span className="font-bold">{onlyOn.name || KIND[onlyOn.type]}</span> : `${pickedOn.size} sheets`}. Tap “Move here” on
            another parts sheet to put {selection.length === 1 ? 'it' : 'them'} on top of it. Bring to front and Send to back only change the order inside a sheet.
          </p>
          <button
            type="button"
            onClick={() => { onMovePicked?.(null); onClose(); }}
            className="min-h-11 self-start rounded-control border border-line bg-panel px-3 text-sm font-bold text-accent-text"
          >
            Move to a new sheet
          </button>
        </div>
      )}
      <ul className="flex flex-col gap-1" aria-label="Sheets, top first">
        {rows.map((layer, i) => (
          <SheetRow
            key={layer.id}
            layer={layer}
            doc={doc}
            first={i === 0}
            last={i === rows.length - 1}
            active={layer.id === activeLayerId}
            onMoveHere={
              pickedOn.size > 0 && layer.type === 'brick' && !(onlyOn && onlyOn.id === layer.id)
                ? () => { onMovePicked?.(layer.id); onClose(); }
                : undefined
            }
          />
        ))}
      </ul>
      {rows.length === 0 && <p className="py-4 text-center text-sm text-muted">No sheets yet. Add one below.</p>}
    </BottomSheet>
  );
}

/** Edit a label's or a text's words by touch: a big text box and Save. */
export function TextEditSheet({ title, initial, onSave, onClose }: {
  title: string;
  initial: string;
  onSave: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  const empty = text.trim().length === 0;
  return (
    <BottomSheet
      title={title}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="min-h-11 rounded-control px-4 text-sm font-bold hover:bg-soft">
            Cancel
          </button>
          <button
            type="button"
            disabled={empty}
            onClick={() => {
              if (text !== initial) onSave(text);
              onClose();
            }}
            className="min-h-11 rounded-control bg-accent px-5 text-sm font-bold text-accent-ink hover:bg-accent-hover disabled:opacity-40"
          >
            Save
          </button>
        </div>
      }
    >
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Text"
        rows={4}
        // 16 px, so iOS doesn't zoom in on the field.
        className="w-full rounded-control border border-line bg-bg p-3 text-base"
      />
      {empty && <p className="mt-1 text-sm text-muted">Type some words, or use Delete to remove it.</p>}
    </BottomSheet>
  );
}
