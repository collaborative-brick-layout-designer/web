// Map > Background Color dialog — port of MainWindowMapMenu.cpp:48-60:
// a color picker with an alpha channel (QColorDialog::ShowAlphaChannel),
// written to the .bbm as desktop does (lowercase `aarrggbb`).

import { useState } from 'react';
import type * as Y from 'yjs';
import type { ColorSpec } from '@cld/model';
import { setBackgroundColor } from './mutations';
import { argbSpec, hexAlpha } from './background';
import { useEscape } from './useEscape';

interface Props {
  current: ColorSpec;
  doc: Y.Doc;
  onClose: () => void;
}

export function BackgroundColorDialog({ current, doc, onClose }: Props) {
  useEscape(onClose);
  const initial = hexAlpha(current);
  const [rgb, setRgb] = useState(initial.hex);
  const [alpha, setAlpha] = useState(initial.alpha);

  function commit() {
    setBackgroundColor(doc, argbSpec(rgb, alpha));
    onClose();
  }

  return (
    <div
      role="dialog" aria-label="Background color"
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-black/60"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[24rem] rounded-lg border border-line bg-panel p-5 shadow-xl"
      >
        <h2 className="text-base font-semibold">Background color</h2>
        <div className="mt-4 flex items-center gap-3 text-sm">
          <input
            type="color"
            aria-label="Background color"
            value={rgb}
            onChange={(e) => setRgb(e.target.value)}
            className="h-10 w-20 cursor-pointer rounded-lg border border-border bg-transparent"
          />
          <span className="font-mono text-xs uppercase">{rgb}</span>
        </div>
        <label className="mt-3 flex items-center gap-3 text-xs text-muted">
          Alpha
          <input
            type="range"
            min={0}
            max={255}
            value={alpha}
            aria-label="Alpha"
            onChange={(e) => setAlpha(parseInt(e.target.value, 10))}
            className="flex-1"
          />
          <span className="w-8 text-right tabular-nums">{alpha}</span>
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1 text-sm hover:bg-soft"
          >
            Cancel
          </button>
          <button
            onClick={commit}
            className="rounded-lg bg-accent text-accent-ink px-3 py-1 text-sm hover:bg-accent-hover"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
