// Add-Text / Edit-Text dialog — port of
// `editTextDialog` (EditDialogs.cpp `editTextDialog`) + the Edit ▸
// Insert ▸ Text... entry (MainWindowMenus.cpp:430-439).
//
// We accept a single shape with optional `existing` to switch between
// "create new at centre" and "edit existing at index".

import { useState } from 'react';
import type { TextCell } from '@cld/model';
import { ColorAlphaInput } from './ColorAlphaInput';
import { colorSpecToArgb } from './layerOptions';
import { useEscape } from './useEscape';

export interface TextDialogResult {
  text: string;
  fontFamily: string;
  fontSize: number;
  isBold: boolean;
  isItalic: boolean;
  /** AARRGGBB hex (uppercase, no leading #). */
  colorArgb: string;
  /** Degrees, clockwise positive. */
  rotation: number;
}

interface Props {
  initial?: TextCell;
  onClose: () => void;
  onCommit: (r: TextDialogResult) => void;
  /** Edit mode: remove the text cell (desktop DeleteTextCellCommand). */
  onDelete?: () => void;
}

export function TextDialog({ initial, onClose, onCommit, onDelete }: Props) {
  useEscape(onClose);
  const [text, setText] = useState(initial?.text ?? '');
  // Text draws in the app's map font whatever family the file names
  // (render/fontStack.ts): no font to pick; the family is kept as it is.
  const fontFamily = initial?.font.family ?? 'Arial';
  // New text: Arial 12 pt, like desktop (MapView::addTextAtScenePos).
  const [fontSize, setFontSize] = useState(initial?.font.size ?? 12);
  const styleStr = (initial?.font.style ?? '').toLowerCase();
  const [isBold, setIsBold] = useState(styleStr.includes('bold'));
  const [isItalic, setIsItalic] = useState(styleStr.includes('italic'));
  // Initial color with alpha; a known color (e.g. "Red") resolves to its value.
  const initArgb = initial ? colorSpecToArgb(initial.fontColor) : 'FF000000';
  const [colorArgb, setColorArgb] = useState(initArgb.toUpperCase());
  const [rotation, setRotation] = useState(initial?.orientation ?? 0);


  return (
    <div
      role="dialog"
      aria-label={initial ? 'Edit text' : 'Add text'}
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-line bg-panel p-5 shadow-xl"
      >
        <h2 className="text-base font-semibold">{initial ? 'Edit text' : 'Add text'}</h2>
        <div className="mt-4 grid grid-cols-[8rem_1fr] gap-2 text-sm">
          <label className="self-center" htmlFor="text-text">Text:</label>
          <textarea
            id="text-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            autoFocus
            className="rounded-lg border border-border bg-soft px-2 py-1"
          />
          <label className="self-center" htmlFor="text-size">Size (pt):</label>
          <input
            id="text-size"
            type="number"
            value={fontSize}
            onChange={(e) => {
              const n = parseFloat(e.target.value);
              if (Number.isFinite(n)) setFontSize(n);
            }}
            min={1}
            step={1}
            className="rounded-lg border border-border bg-soft px-2 py-1"
          />
          <span className="self-center">Style:</span>
          <div className="flex items-center gap-3 text-xs">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={isBold}
                onChange={(e) => setIsBold(e.target.checked)}
              />
              Bold
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={isItalic}
                onChange={(e) => setIsItalic(e.target.checked)}
              />
              Italic
            </label>
          </div>
          <span className="self-center">Color:</span>
          <ColorAlphaInput label="Text color" value={colorArgb} onChange={(v) => setColorArgb(v.toUpperCase())} />
          <label className="self-center" htmlFor="text-angle">Angle (°):</label>
          <input
            id="text-angle"
            type="number"
            value={rotation}
            onChange={(e) => {
              const n = parseFloat(e.target.value);
              if (Number.isFinite(n)) setRotation(n);
            }}
            step={1}
            className="rounded-lg border border-border bg-soft px-2 py-1"
          />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          {onDelete && (
            <button
              onClick={onDelete}
              className="mr-auto rounded-lg border border-red-900 px-3 py-1 text-sm text-red-300 hover:bg-red-950/40"
            >
              Delete
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1 text-sm hover:bg-soft"
          >
            Cancel
          </button>
          <button
            disabled={text.trim().length === 0}
            onClick={() =>
              onCommit({
                text,
                fontFamily,
                fontSize,
                isBold,
                isItalic,
                colorArgb,
                rotation,
              })
            }
            className="rounded-lg bg-accent text-accent-ink px-3 py-1 text-sm hover:bg-accent-hover disabled:opacity-30"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
