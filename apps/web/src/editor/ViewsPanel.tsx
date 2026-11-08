// The Views panel: saved views of the layout (savedViews.ts). Tap a view
// to see it; add one, rename it, choose "Fit whole layout" or "Use this
// area", pick its sheets, share a picture of it, or delete it. Everyone
// on the layout sees the same views; viewers can look and share, not
// change them.

import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import type { SavedView } from '@cld/bbm';
import type { StudRect } from './exportRender';
import { addSavedView, deleteSavedView, makeId, readSavedViews, updateSavedView } from './mutations';
import { newView } from './savedViews';
import { confirmDelete } from '../ui/ConfirmDialog';
import { displaySheetName } from './activeSheet';

export interface ViewsPanelProps {
  doc: Y.Doc;
  isViewer: boolean;
  /** The sheets the layout has (not the grid), for the sheet picker. */
  sheets: { id: string; name: string }[];
  /** The view being looked at, if any. */
  activeViewId: string | null;
  /** The map area on screen now, in studs. */
  screenRect: () => StudRect | null;
  /** Whether the grid shows now (a new view starts with the same). */
  gridShown: boolean;
  onGoTo: (view: SavedView) => void;
  onShowEverything: () => void;
  /** Show a view's sheets, grid and labels without moving the map. */
  onApply: (view: SavedView) => void;
  /** Stop showing the view, leaving the map where it is. */
  onLeave: () => void;
  onShare: (view: SavedView) => void;
  onExportAll: () => void;
  /** Progress text while "Export all views" runs. */
  exporting?: string | null;
  /** Phones: everything sized for fingers. */
  touch?: boolean;
}

const BTN =
  'inline-flex min-h-9 items-center justify-center rounded-control border border-line px-3 text-sm text-ink hover:bg-soft pointer-coarse:min-h-11 disabled:opacity-40';
const PRIMARY =
  'inline-flex min-h-9 items-center justify-center rounded-control bg-accent px-3 text-sm font-bold text-accent-ink hover:bg-accent-hover pointer-coarse:min-h-11';

export function viewSummary(view: SavedView, sheetCount: number): string {
  const area = view.fit ? 'Whole layout' : 'One area';
  const sheets = view.sheets === null ? 'all sheets' : view.sheets.length === 1 ? '1 sheet' : `${view.sheets.length} of ${sheetCount} sheets`;
  return `${area} · ${sheets}`;
}

export function ViewsPanel(props: ViewsPanelProps) {
  const { doc, isViewer, sheets, activeViewId, onGoTo, onShowEverything, onApply, onLeave, onShare, onExportAll, touch } = props;
  // Follow the doc: views change when anyone on the layout edits them.
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    doc.on('update', bump);
    return () => doc.off('update', bump);
  }, [doc]);
  const views = readSavedViews(doc);
  const [adding, setAdding] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const add = () => {
    if (adding === null) return;
    const view = newView(makeId(), adding || `View ${views.length + 1}`, { grid: props.gridShown });
    addSavedView(doc, view);
    setAdding(null);
    onGoTo(view);
  };

  return (
    <section aria-label="Views" className={`flex h-full min-h-0 w-full flex-col gap-2 overflow-y-auto bg-panel p-2 text-sm text-ink ${touch ? 'text-base' : ''}`}>
      {views.length === 0 && adding === null && (
        <p className="px-1 text-muted">
          No saved views yet. A view remembers a part of the layout, so you can show it, or share a picture of it, in one tap.
        </p>
      )}

      <ul className="flex flex-col gap-1.5" aria-label="Saved views">
        {views.map((view) => {
          const active = view.id === activeViewId;
          const open = openId === view.id && !isViewer;
          return (
            <li key={view.id} className={`rounded-card border ${active ? 'border-accent bg-soft' : 'border-line'}`}>
              {renaming?.id === view.id ? (
                <form
                  className="flex items-center gap-1.5 p-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    updateSavedView(doc, view.id, { name: renaming.name.trim() || view.name });
                    setRenaming(null);
                  }}
                >
                  <input
                    aria-label="View name"
                    autoFocus
                    value={renaming.name}
                    onChange={(e) => setRenaming({ id: view.id, name: e.target.value })}
                    onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)}
                    className="min-h-9 min-w-0 flex-1 rounded-control border border-line bg-bg px-2 text-base text-ink pointer-coarse:min-h-11 sm:text-sm"
                  />
                  <button type="submit" className={PRIMARY}>Save</button>
                </form>
              ) : (
                <div className="flex items-stretch">
                  <button
                    type="button"
                    onClick={() => (active ? onLeave() : onGoTo(view))}
                    aria-current={active ? 'true' : undefined}
                    title={active ? `Showing ${view.name}. Tap again to stop` : `Show ${view.name}`}
                    className="flex min-h-11 min-w-0 flex-1 flex-col justify-center rounded-card px-2.5 py-1.5 text-left hover:bg-soft"
                  >
                    <span className="truncate font-bold">{view.name || 'View'}</span>
                    <span className="truncate text-xs text-muted">{viewSummary(view, sheets.length)}</span>
                    {active && <span className="truncate text-xs font-semibold text-accent-text">On screen now · tap to stop</span>}
                  </button>
                  <button
                    type="button"
                    aria-label={`Share a picture of ${view.name}`}
                    title="Share a picture"
                    onClick={() => onShare(view)}
                    className="flex w-11 shrink-0 items-center justify-center rounded-card text-muted hover:bg-soft hover:text-ink"
                  >
                    <PictureIcon />
                  </button>
                  {!isViewer && (
                    <button
                      type="button"
                      aria-label={`Change ${view.name}`}
                      aria-expanded={open}
                      title={open ? 'Close the settings for this view' : 'Change what this view shows'}
                      onClick={() => setOpenId(open ? null : view.id)}
                      className={`flex shrink-0 items-center justify-center gap-0.5 rounded-card px-2 text-xs font-semibold hover:bg-soft hover:text-ink ${open ? 'text-ink' : 'text-muted'}`}
                    >
                      <span aria-hidden>Edit</span>
                      <ChevronIcon open={open} />
                    </button>
                  )}
                </div>
              )}
              {open && renaming?.id !== view.id && (
                <ViewOptions
                  view={view}
                  sheets={sheets}
                  onArea={(fit) => {
                    if (fit) {
                      updateSavedView(doc, view.id, { fit: true, rect: null });
                      return;
                    }
                    const r = props.screenRect();
                    if (!r) return;
                    updateSavedView(doc, view.id, { fit: false, rect: { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) } });
                  }}
                  onPatch={(patch) => {
                    updateSavedView(doc, view.id, patch);
                    // Changing a view never moves the map: it may be on the next area.
                    if (active) onApply({ ...view, ...patch });
                  }}
                  onRename={() => setRenaming({ id: view.id, name: view.name })}
                  onClose={() => setOpenId(null)}
                  onDelete={async () => {
                    const ok = await confirmDelete(view.name, {
                      removes: 'This saved view is deleted.',
                      keeps: 'The layout itself doesn’t change.',
                      undoable: 'You can undo this with Ctrl+Z.',
                    });
                    if (!ok) return;
                    deleteSavedView(doc, view.id);
                    setOpenId(null);
                    if (active) onShowEverything();
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>

      {adding !== null ? (
        <form
          className="flex flex-col gap-1.5 rounded-card border border-line p-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <label className="text-xs font-bold text-muted" htmlFor="new-view-name">
            Name the view
          </label>
          <input
            id="new-view-name"
            autoFocus
            value={adding}
            placeholder={`View ${views.length + 1}`}
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setAdding(null)}
            className="min-h-9 rounded-control border border-line bg-bg px-2 text-base text-ink pointer-coarse:min-h-11 sm:text-sm"
          />
          <p className="text-xs text-muted">It shows the whole layout. You can pick an area after.</p>
          <div className="flex gap-1.5">
            <button type="submit" className={PRIMARY}>Add view</button>
            <button type="button" className={BTN} onClick={() => setAdding(null)}>Cancel</button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {!isViewer && (
            <button type="button" className={PRIMARY} onClick={() => setAdding('')}>
              + Add view
            </button>
          )}
          {activeViewId && (
            <button type="button" className={BTN} onClick={onShowEverything}>
              Show everything
            </button>
          )}
        </div>
      )}

      <div className="mt-auto border-t border-line pt-2">
        <button
          type="button"
          className={`${BTN} w-full gap-2`}
          onClick={onExportAll}
          disabled={!!props.exporting}
          title="One picture of each view, in a zip file"
        >
          {props.exporting && <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" />}
          {props.exporting ?? (views.length > 0 ? 'Export all views' : 'Export a picture')}
        </button>
      </div>
    </section>
  );
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function ViewOptions({
  view,
  sheets,
  onArea,
  onPatch,
  onRename,
  onDelete,
  onClose,
}: {
  view: SavedView;
  sheets: { id: string; name: string }[];
  onArea: (fit: boolean) => void;
  onPatch: (patch: Partial<SavedView>) => void;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const allSheets = view.sheets === null;
  const toggleSheet = (id: string, on: boolean) => {
    const current = view.sheets ?? sheets.map((s) => s.id);
    const next = on ? [...new Set([...current, id])] : current.filter((s) => s !== id);
    onPatch({ sheets: sheets.filter((s) => next.includes(s.id)).map((s) => s.id) });
  };
  const check = 'size-5 accent-accent';
  const row = 'flex min-h-9 items-center gap-2 rounded px-1 pointer-coarse:min-h-11';
  return (
    <div className="flex flex-col gap-2 border-t border-line p-2" data-testid="view-options">
      <div role="group" aria-label="What the picture shows" className="grid grid-cols-2 gap-1 rounded-control bg-soft p-1">
        <button
          type="button"
          aria-pressed={view.fit}
          onClick={() => onArea(true)}
          className={`min-h-9 rounded-control px-2 text-sm pointer-coarse:min-h-11 ${view.fit ? 'bg-panel font-bold shadow-sm' : 'text-muted'}`}
        >
          Fit whole layout
        </button>
        <button
          type="button"
          aria-pressed={!view.fit}
          onClick={() => onArea(false)}
          title="Keep the part of the map on screen now"
          className={`min-h-9 rounded-control px-2 text-sm pointer-coarse:min-h-11 ${!view.fit ? 'bg-panel font-bold shadow-sm' : 'text-muted'}`}
        >
          Use this area
        </button>
      </div>
      {!view.fit && (
        <p className="text-xs text-muted">
          Move the map to the part you want, then tap “Use this area” again to keep it.
        </p>
      )}
      <label className={row}>
        <input type="checkbox" className={check} checked={view.grid} onChange={(e) => onPatch({ grid: e.target.checked })} />
        Show the grid
      </label>
      <label className={row}>
        <input type="checkbox" className={check} checked={view.labels} onChange={(e) => onPatch({ labels: e.target.checked })} />
        Show labels
      </label>
      <fieldset className="flex flex-col">
        <legend className="mb-0.5 text-xs font-bold text-muted">Sheets</legend>
        <label className={row}>
          <input
            type="checkbox"
            className={check}
            checked={allSheets}
            onChange={(e) => onPatch({ sheets: e.target.checked ? null : sheets.map((s) => s.id) })}
          />
          All sheets
        </label>
        {!allSheets &&
          sheets.map((s) => (
            <label key={s.id} className={`${row} pl-6`}>
              <input type="checkbox" className={check} checked={view.sheets!.includes(s.id)} onChange={(e) => toggleSheet(s.id, e.target.checked)} />
              <span className="truncate">{s.name ? displaySheetName(s.name) : 'Sheet'}</span>
            </label>
          ))}
      </fieldset>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className={BTN} onClick={onRename}>Rename</button>
        <button type="button" className={`${BTN} text-danger`} onClick={onDelete}>Delete</button>
        <button type="button" className={`${PRIMARY} ml-auto`} onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

export function PictureIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M21 16l-5-5-8 8" />
    </svg>
  );
}

/** A chevron that points down when closed and up when open. */
export function ChevronIcon({ open, size = 16 }: { open: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={`transition-transform ${open ? 'rotate-180' : ''}`}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
