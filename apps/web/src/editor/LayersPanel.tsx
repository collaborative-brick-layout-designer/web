// Layers panel — port of desktop's LayerPanel (`src/ui/LayerPanel.cpp`).
// Renders every layer in the doc with:
//   - kind glyph + index + kind name
//   - double-click a row → Layer Options (desktop LayerPanel.cpp:145);
//     rename inline via the context menu or F2 on the focused row
//   - visibility checkbox
//   - transparency slider
//   - active-row highlight (clicking sets the active layer)
//   - up/down/delete buttons
//
// Bottom row: + (Add Grid / Parts / Area / Text / Ruler) and a "Show all" /
// "Solo" pair.

import { useOnScreen } from './menuPosition';
import { useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import type { BbmMap, Layer } from '@cld/model';
import { useEditorStore } from './editorStore';
import {
  addLayer,
  deleteLayer,
  moveLayer,
  renameLayer,
  setLayerTransparency,
  setLayerVisible,
  showAllLayers,
  soloLayer,
  type LayerKind,
} from './mutations';
import { LayerOptionsDialog } from './LayerOptionsDialog';
import { confirmDelete } from '../ui/ConfirmDialog';
import { deleteSheetWording } from './sheetContents';
import { SHEET_GLYPH } from './activeSheet';

interface Props {
  map: BbmMap;
  doc: Y.Doc;
  isViewer: boolean;
}

const KIND_GLYPH = SHEET_GLYPH;

/** Number of items on a layer — parts on a parts (brick) layer, cells/areas/rulers on the others. */
function layerItemCount(layer: Layer): number | null {
  switch (layer.type) {
    case 'brick':
      return layer.bricks.length;
    case 'text':
      return layer.textCells.length;
    case 'area':
      return layer.areas.length;
    case 'ruler':
      return layer.rulerItems.length;
    case 'grid':
      return null;
  }
}

export function LayersPanel({ map, doc, isViewer }: Props) {
  const activeLayerId = useEditorStore((s) => s.activeLayerId);
  const setActiveLayer = useEditorStore((s) => s.setActiveLayer);
  const flashSheetId = useEditorStore((s) => s.flashSheetId);

  // map.layers is in **document order**. The desktop's LayerPanel
  // reverses for display so topmost (last drawn = highest z) is first.
  const rows = [...map.layers].reverse();

  return (
    <aside className="flex h-full min-h-0 w-full flex-col bg-panel text-sm">
      <div className="flex items-center justify-between border-b border-line px-2 py-1.5 text-xs uppercase tracking-wider text-muted">
        <span>Sheets</span>
        <span className="text-neutral-600">{map.layers.length}</span>
      </div>
      <ul className="flex-1 min-h-0 overflow-y-auto">
        {rows.map((layer) => (
          <LayerRow
            key={layer.id}
            layer={layer}
            doc={doc}
            isActive={layer.id === activeLayerId}
            flash={layer.id === flashSheetId}
            isViewer={isViewer}
            onActivate={() => setActiveLayer(layer.id)}
          />
        ))}
      </ul>
      {!isViewer && (
        <div className="flex flex-col gap-1 border-t border-line p-1">
          <div className="flex items-center gap-1">
            <AddLayerButton doc={doc} onAdd={setActiveLayer} />
            <button
              onClick={() => {
                if (!activeLayerId) return;
                moveLayer(doc, activeLayerId, 'up');
              }}
              disabled={!activeLayerId}
              className="rounded-lg px-2 py-0.5 text-xs hover:bg-soft disabled:opacity-30 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
              title="Move active sheet toward the top"
            >
              ▲
            </button>
            <button
              onClick={() => {
                if (!activeLayerId) return;
                moveLayer(doc, activeLayerId, 'down');
              }}
              disabled={!activeLayerId}
              className="rounded-lg px-2 py-0.5 text-xs hover:bg-soft disabled:opacity-30 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
              title="Move active sheet toward the bottom"
            >
              ▼
            </button>
            <button
              onClick={async () => {
                if (!activeLayerId) return;
                const id = activeLayerId;
                const layer = map.layers.find((l) => l.id === id);
                if (!layer) return;
                if (!(await confirmDelete(layer.name, deleteSheetWording(layer, 'You can undo this with Ctrl+Z.')))) return;
                deleteLayer(doc, id);
              }}
              disabled={!activeLayerId}
              className="rounded-lg px-2 py-0.5 text-xs hover:bg-red-900/40 disabled:opacity-30 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
              title="Delete active sheet"
            >
              ✕
            </button>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => showAllLayers(doc)}
              className="flex-1 rounded-lg py-0.5 text-xs hover:bg-soft pointer-coarse:min-h-11"
              title="Make all sheets visible"
            >
              Show all
            </button>
            <button
              onClick={() => {
                if (!activeLayerId) return;
                soloLayer(doc, activeLayerId);
              }}
              disabled={!activeLayerId}
              className="flex-1 rounded-lg py-0.5 text-xs hover:bg-soft disabled:opacity-30 pointer-coarse:min-h-11"
              title="Show only the active sheet, hide all others"
            >
              Solo
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

function LayerRow({
  layer,
  doc,
  isActive,
  flash,
  isViewer,
  onActivate,
}: {
  layer: Layer;
  doc: Y.Doc;
  isActive: boolean;
  flash: boolean;
  isViewer: boolean;
  onActivate: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(layer.name);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuStyle = useOnScreen(menuRef, ctxMenu);
  const itemCount = layerItemCount(layer);

  // Re-sync the draft when the layer's name changes externally (remote
  // collaborator rename, undo). Only when NOT actively editing — we
  // don't want to clobber the user's in-progress text on every Yjs
  // round-trip.
  useEffect(() => {
    if (!editing) setDraftName(layer.name);
  }, [layer.name, editing]);

  useEffect(() => {
    if (!ctxMenu) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setCtxMenu(null);
    }
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [ctxMenu]);

  function startRename() {
    setDraftName(layer.name);
    setEditing(true);
    setCtxMenu(null);
  }

  /** Events from the options dialog / rename box bubble through the row; ignore them. */
  const fromChildWidget = (t: EventTarget) =>
    t instanceof HTMLElement && (t.closest('[role="dialog"]') !== null || t.tagName === 'INPUT');

  return (
    <li
      tabIndex={0}
      onClick={onActivate}
      onDoubleClick={(e) => {
        // Desktop: itemDoubleClicked → layerOptionsRequested (LayerPanel.cpp:145).
        if (isViewer || editing || fromChildWidget(e.target)) return;
        setShowOptions(true);
      }}
      onKeyDown={(e) => {
        // F2 renames the focused row (QListWidget edit trigger).
        if (e.key !== 'F2' || isViewer || editing || fromChildWidget(e.target)) return;
        e.preventDefault();
        startRename();
      }}
      onContextMenu={(e) => {
        if (isViewer) return;
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY });
      }}
      title={
        isViewer
          ? undefined
          : `${isActive ? (layer.type === 'brick' ? 'Active sheet: new parts are placed here. ' : 'Active sheet. ') : 'Click to make this the active sheet. '}Double-click for sheet options, F2 to rename`
      }
      aria-current={isActive ? 'true' : undefined}
      data-active={isActive || undefined}
      data-flash={flash || undefined}
      className={
        'relative cursor-pointer border-b border-line/60 py-1.5 outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ' +
        // The active sheet: a filled band in the accent color with a thick
        // edge, so it never reads as a hover or a passing pick.
        (isActive
          ? 'border-l-4 border-l-accent bg-accent-soft pl-1 pr-2 '
          : 'border-l-4 border-l-transparent pl-1 pr-2 hover:bg-soft/60 ') +
        (flash ? 'animate-pulse ring-2 ring-inset ring-accent' : '')
      }
    >
      <div className="flex items-center gap-2">
        <span className="w-4 text-center text-muted" aria-hidden="true">
          {KIND_GLYPH[layer.type]}
        </span>
        {/* The label gives a finger a 44 px target round the small box. */}
        <label className="-my-1 flex shrink-0 cursor-pointer items-center justify-center pointer-coarse:-my-2.5 pointer-coarse:size-11" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={layer.visible}
            disabled={isViewer}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setLayerVisible(doc, layer.id, e.target.checked)}
            title="Visible"
            className="cursor-pointer"
          />
        </label>
        {editing ? (
          <input
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                renameLayer(doc, layer.id, draftName.trim() || layer.name);
                setEditing(false);
              } else if (e.key === 'Escape') {
                setDraftName(layer.name);
                setEditing(false);
              }
            }}
            onBlur={() => {
              renameLayer(doc, layer.id, draftName.trim() || layer.name);
              setEditing(false);
            }}
            className="flex-1 rounded-lg border border-border bg-soft px-1 py-0.5 text-xs"
          />
        ) : (
          <span
            className={
              'flex-1 truncate text-sm ' +
              (isActive ? 'font-bold text-accent-text ' : '') +
              (layer.visible ? '' : 'text-muted line-through')
            }
          >
            {layer.name || '(untitled)'}
          </span>
        )}
        {isActive && !editing && (
          <span
            data-testid="active-sheet-badge"
            className="shrink-0 rounded-full bg-accent px-1.5 py-px text-[10px] font-bold uppercase tracking-wide text-accent-ink"
          >
            Active
          </span>
        )}
        {!editing && itemCount !== null && (
          <span
            className="shrink-0 tabular-nums text-[10px] text-muted"
            title={layer.type === 'brick' ? `${itemCount} part${itemCount === 1 ? '' : 's'} on this sheet` : undefined}
          >
            {itemCount}
          </span>
        )}
      </div>
      <div className="ml-9 mt-1 flex items-center gap-2 text-[10px] text-muted">
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={layer.transparency}
          disabled={isViewer}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setLayerTransparency(doc, layer.id, parseInt(e.target.value, 10))}
          title="Transparency (0% transparent → 100% opaque)"
          className="flex-1 accent-accent pointer-coarse:h-11"
        />
        <span className="w-7 text-right tabular-nums">{layer.transparency}%</span>
      </div>
      {ctxMenu && (
        <div
          ref={menuRef}
          style={menuStyle}
          className="min-w-[170px] rounded-lg border border-border bg-panel py-1 text-xs shadow-lg"
          onContextMenu={(e) => e.preventDefault()}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="block w-full px-3 py-1 text-left hover:bg-neutral-700"
            onClick={() => { setLayerVisible(doc, layer.id, !layer.visible); setCtxMenu(null); }}
          >
            {layer.visible ? 'Hide sheet' : 'Show sheet'}
          </button>
          <button
            className="block w-full px-3 py-1 text-left hover:bg-neutral-700"
            onClick={() => { soloLayer(doc, layer.id); setCtxMenu(null); }}
          >
            Solo (hide others)
          </button>
          <button
            className="block w-full px-3 py-1 text-left hover:bg-neutral-700"
            onClick={() => { showAllLayers(doc); setCtxMenu(null); }}
          >
            Show all sheets
          </button>
          <hr className="my-1 border-border" />
          <button
            className="block w-full px-3 py-1 text-left hover:bg-neutral-700"
            onClick={() => { setCtxMenu(null); setShowOptions(true); }}
          >
            Sheet options…  <span className="float-right text-muted">dbl-click</span>
          </button>
          <button
            className="block w-full px-3 py-1 text-left hover:bg-neutral-700"
            onClick={startRename}
          >
            Rename…  <span className="float-right text-muted">F2</span>
          </button>
          <button
            className="block w-full px-3 py-1 text-left hover:bg-neutral-700"
            onClick={() => { moveLayer(doc, layer.id, 'up'); setCtxMenu(null); }}
          >
            Move up
          </button>
          <button
            className="block w-full px-3 py-1 text-left hover:bg-neutral-700"
            onClick={() => { moveLayer(doc, layer.id, 'down'); setCtxMenu(null); }}
          >
            Move down
          </button>
          <hr className="my-1 border-border" />
          <button
            className="block w-full px-3 py-1 text-left text-danger hover:bg-neutral-700"
            onClick={async () => {
              setCtxMenu(null);
              if (!(await confirmDelete(layer.name, deleteSheetWording(layer, 'You can undo this with Ctrl+Z.')))) return;
              deleteLayer(doc, layer.id);
            }}
          >
            Delete sheet
          </button>
          <hr className="my-1 border-border" />
          <button
            className="block w-full px-3 py-1 text-left text-muted hover:bg-neutral-700"
            onClick={() => setCtxMenu(null)}
          >
            Cancel
          </button>
        </div>
      )}
      {showOptions && (
        <LayerOptionsDialog
          layer={layer}
          doc={doc}
          onClose={() => setShowOptions(false)}
        />
      )}
    </li>
  );
}

// Same kinds as desktop's add-layer menu (LayerPanel.cpp:85-89).
const ADD_LAYER_OPTIONS: { kind: LayerKind; label: string }[] = [
  { kind: 'grid', label: 'Grid sheet' },
  { kind: 'brick', label: 'Parts sheet' },
  { kind: 'area', label: 'Area sheet' },
  { kind: 'text', label: 'Text sheet' },
  { kind: 'ruler', label: 'Ruler sheet' },
];

function AddLayerButton({ doc, onAdd }: { doc: Y.Doc; onAdd: (layerId: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-lg px-2 py-0.5 text-xs hover:bg-soft pointer-coarse:min-h-11"
        title="Add a new sheet"
      >
        + Add sheet
      </button>
      {open && (
        <ul
          className="absolute bottom-full left-0 z-10 mb-1 w-40 rounded-lg border border-border bg-panel text-xs shadow-sm"
          onClick={() => setOpen(false)}
        >
          {ADD_LAYER_OPTIONS.map(({ kind, label }) => (
            <li key={kind}>
              <button
                onClick={() => onAdd(addLayer(doc, kind))}
                className="block w-full px-2 py-1 text-left hover:bg-soft pointer-coarse:min-h-11"
              >
                {label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
