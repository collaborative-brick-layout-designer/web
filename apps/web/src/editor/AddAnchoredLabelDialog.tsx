// Add Anchored Label dialog — port of the desktop's AddAnchoredLabelCommand
// (LabelCommands.cpp) + the "Insert → Anchored Label..." menu entry
// (MainWindowMenus.cpp:440-472).
//
// New labels are World (kind=0) or Brick (kind=1) anchored, like desktop's
// Insert menu; editing a Group/Module label (kind=2/3) keeps its kind.
// The default font is desktop's FontSpec default (8.25 pt Microsoft Sans
// Serif, core/FontSpec.h) and sizes are points.
//
// When a single brick is selected, the dialog defaults to Brick-anchor mode
// with that brick's id pre-filled and a (2, -2) stud offset. Otherwise it
// defaults to World, placed at the current viewport centre
// (MainWindowMenus.cpp:447-457).

import { useState } from 'react';
import type * as Y from 'yjs';
import type { AnchoredLabel } from '@cld/bbm';
import { addAnchoredLabel, deleteAnchoredLabel, editAnchoredLabel, makeId } from './mutations';
import { labelColorHex, labelColorToSave } from './labelColor';
import { DEFAULT_LABEL_FONT, labelFontStyle } from './mixedSelection';
import { HelpButton } from '../help/HelpButton';
import { useEscape } from './useEscape';

interface Props {
  doc: Y.Doc;
  /** Id of the single currently-selected brick, or null. */
  defaultTargetId: string | null;
  /** When set, the dialog is in edit mode — pre-populates fields and calls editAnchoredLabel. */
  initialLabel?: AnchoredLabel;
  /** World-stud position of the viewport centre — the default World-label offset. */
  viewCentre?: { x: number; y: number };
  onClose: () => void;
}

/** Brick-anchored labels start just up-right of the brick (desktop offsetStuds = (2, -2)). */
const BRICK_OFFSET = { x: 2, y: -2 };

export function AddAnchoredLabelDialog({ doc, defaultTargetId, initialLabel, viewCentre, onClose }: Props) {
  useEscape(onClose);
  const isEdit = !!initialLabel;
  const initStyle = (initialLabel?.font.style ?? '').toLowerCase();
  const [text, setText] = useState(initialLabel?.text ?? '');
  // Every label draws in the app's map font (render/mapText.ts), so there's
  // no font to pick here; the family the file names is kept as it is.
  const fontFamily = initialLabel?.font.family ?? DEFAULT_LABEL_FONT.family;
  const [fontSize, setFontSize] = useState<number>(initialLabel?.font.size ?? DEFAULT_LABEL_FONT.size);
  const [isBold, setIsBold] = useState(initStyle.includes('bold'));
  const [isItalic, setIsItalic] = useState(initStyle.includes('italic'));
  // Known colors (desktop "Black" etc.) keep their spec unless the user
  // picks a new color, so an edit doesn't rewrite them as plain ARGB.
  const [colorArgb, setColorArgb] = useState(
    initialLabel ? `FF${labelColorHex(initialLabel.color)}` : 'FF000000'
  );
  const [colorTouched, setColorTouched] = useState(false);
  const [kind, setKind] = useState<AnchoredLabel['kind']>(
    initialLabel ? initialLabel.kind : defaultTargetId ? 1 : 0
  );
  const worldOffset = { x: round2(viewCentre?.x ?? 0), y: round2(viewCentre?.y ?? 0) };
  const initOffset = initialLabel?.offset ?? (kind === 1 ? BRICK_OFFSET : worldOffset);
  const [targetId, setTargetId] = useState(initialLabel?.targetId ?? defaultTargetId ?? '');
  const [offsetX, setOffsetX] = useState(initOffset.x);
  const [offsetY, setOffsetY] = useState(initOffset.y);
  const [rotation, setRotation] = useState(initialLabel?.rot ?? 0);
  const [minZoom, setMinZoom] = useState(initialLabel?.minZoom ?? 0);

  const rgb = `#${colorArgb.slice(2, 8)}`;

  function commit() {
    if (!text.trim()) return;
    const style = labelFontStyle(isBold, isItalic);
    const label: AnchoredLabel = {
      id: makeId(),
      text: text.trim(),
      font: { family: fontFamily, size: fontSize, style },
      color: labelColorToSave(initialLabel?.color, colorTouched, colorArgb),
      kind,
      targetId: kind === 0 ? '' : targetId.trim(),
      offset: { x: offsetX, y: offsetY },
      rot: rotation,
      minZoom,
    };
    if (isEdit && initialLabel) {
      // Keep the label's id so anything referencing it stays valid.
      editAnchoredLabel(doc, initialLabel.id, { ...label, id: initialLabel.id });
    } else {
      addAnchoredLabel(doc, label);
    }
    onClose();
  }

  const rowCls = 'flex items-center justify-between gap-4 py-1';
  const labelCls = 'text-xs text-muted w-36 shrink-0';
  const inputCls = 'flex-1 rounded-lg border border-border bg-soft px-2 py-1 text-xs';

  return (
    <div
      role="dialog" aria-label="Anchored label"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-panel p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-2">
          <h2 className="text-sm font-semibold text-ink">{isEdit ? 'Edit Anchored Label' : 'Add Anchored Label'}</h2>
          <HelpButton helpKey="dialog.label" />
        </div>

        <div className="flex flex-col gap-0.5">
          <div className={rowCls}>
            <label htmlFor="label-text" className={labelCls}>Text</label>
            <input
              id="label-text"
              type="text"
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') onClose(); }}
              className={inputCls}
            />
          </div>

          <div className={rowCls}>
            <label htmlFor="label-size" className={labelCls}>Size (pt)</label>
            <input id="label-size" type="number" min={1} max={200} step={0.25} value={fontSize} onChange={(e) => setFontSize(Math.max(1, parseFloat(e.target.value) || DEFAULT_LABEL_FONT.size))} className={inputCls} />
          </div>

          <div className={rowCls}>
            <span className={labelCls}>Style</span>
            <div className="flex flex-1 gap-3">
              <label className="flex items-center gap-1 text-xs text-neutral-300">
                <input type="checkbox" checked={isBold} onChange={(e) => setIsBold(e.target.checked)} className="accent-accent" />
                Bold
              </label>
              <label className="flex items-center gap-1 text-xs text-neutral-300">
                <input type="checkbox" checked={isItalic} onChange={(e) => setIsItalic(e.target.checked)} className="accent-accent" />
                Italic
              </label>
            </div>
          </div>

          <div className={rowCls}>
            <label htmlFor="label-color" className={labelCls}>Color</label>
            <input
              id="label-color"
              type="color"
              value={rgb}
              onChange={(e) => {
                setColorArgb(`FF${e.target.value.slice(1).toUpperCase()}`);
                setColorTouched(true);
              }}
              className="h-7 w-12 cursor-pointer rounded-lg border border-border bg-soft p-0.5"
            />
          </div>

          <div className={rowCls}>
            <label htmlFor="label-anchor" className={labelCls}>Where it sits</label>
            <select
              id="label-anchor"
              value={kind}
              onChange={(e) => {
                const k = Number(e.target.value) as AnchoredLabel['kind'];
                setKind(k);
                // A new label follows the anchor's default placement.
                if (!isEdit) {
                  const o = k === 1 ? BRICK_OFFSET : worldOffset;
                  setOffsetX(o.x);
                  setOffsetY(o.y);
                }
              }}
              className={inputCls}
            >
              <option value={0}>At a spot on the map</option>
              <option value={1}>On a part (moves with it)</option>
              {initialLabel?.kind === 2 && <option value={2}>On a group</option>}
              {initialLabel?.kind === 3 && <option value={3}>On a module</option>}
            </select>
          </div>

          {kind === 1 && (
            <div className={rowCls}>
              <label htmlFor="label-part" className={labelCls}>The part’s ID</label>
              <input id="label-part" type="text" value={targetId} onChange={(e) => setTargetId(e.target.value)} placeholder="Pick a part first, then add the label" className={inputCls} />
            </div>
          )}

          <div className={rowCls}>
            <span className={labelCls}>{kind === 1 ? 'From the part, across / down (studs)' : 'Across / down (studs)'}</span>
            <div className="flex flex-1 gap-2">
              <input type="number" aria-label={kind === 1 ? 'Studs across from the part' : 'Studs across'} value={offsetX} onChange={(e) => setOffsetX(parseFloat(e.target.value) || 0)} className={`${inputCls} w-0`} />
              <input type="number" aria-label={kind === 1 ? 'Studs down from the part' : 'Studs down'} value={offsetY} onChange={(e) => setOffsetY(parseFloat(e.target.value) || 0)} className={`${inputCls} w-0`} />
            </div>
          </div>

          <div className={rowCls}>
            <label htmlFor="label-angle" className={labelCls}>Angle (°)</label>
            <input id="label-angle" type="number" min={-360} max={360} value={rotation} onChange={(e) => setRotation(parseFloat(e.target.value) || 0)} className={inputCls} />
          </div>

          <div className={rowCls}>
            <label htmlFor="label-zoom" className={labelCls}>Show from zoom (%)</label>
            <input
              id="label-zoom"
              type="number"
              min={0}
              max={800}
              step={10}
              value={Math.round(minZoom * 100)}
              onChange={(e) => setMinZoom((parseFloat(e.target.value) || 0) / 100)}
              aria-describedby="label-zoom-hint"
              className={inputCls}
            />
          </div>
          <p id="label-zoom-hint" className="pl-40 text-[11px] text-muted">
            0 shows it at every zoom; 50 hides it when you zoom out below half size.
          </p>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          {isEdit && initialLabel && (
            <button
              onClick={() => {
                deleteAnchoredLabel(doc, initialLabel.id);
                onClose();
              }}
              className="mr-auto rounded-lg border border-red-900 px-3 py-1.5 text-xs text-red-300 hover:bg-red-950/40"
            >
              Delete
            </button>
          )}
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs text-muted hover:bg-soft">
            Cancel
          </button>
          <button
            onClick={commit}
            disabled={!text.trim()}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs text-accent-ink hover:bg-accent-hover disabled:opacity-50"
          >
            {isEdit ? 'Save' : 'Add Label'}
          </button>
        </div>
      </div>
    </div>
  );
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
