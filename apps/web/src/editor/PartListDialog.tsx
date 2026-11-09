// Export Part List — port of desktop MainWindow::onExportPartList
// (MainWindowFileIO.cpp:355-405, MainWindowToolsMenu.cpp:75-86): HTML with
// each part's picture, text or CSV; one table or one per layer; hidden
// layers in or out; budget columns when the layout has a budget.

import { useState } from 'react';
import type { BbmMap } from '@cld/model';
import type { PartWire } from '../api';
import { spriteUrlFor } from '../api';
import { noticeDownloaded, useEditorStore } from './editorStore';
import { buildPartList, partListCsv, partListHtml, partListText } from './partList';
import { ensureSprite } from './render/spriteCache';
import { HelpButton } from '../help/HelpButton';
import { useEscape } from './useEscape';

type Format = 'html' | 'txt' | 'csv';

const read = (key: string, fallback: boolean) => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === 'true';
  } catch {
    return fallback;
  }
};
const write = (key: string, v: boolean) => {
  try {
    localStorage.setItem(key, String(v));
  } catch {
    /* per-user convenience only */
  }
};

/** A part's picture as a PNG data URL, scaled to fit 160 px like desktop. */
async function pictureOf(part: PartWire | undefined): Promise<string | null> {
  const url = part ? spriteUrlFor(part) : '';
  if (!url) return null;
  try {
    const img = await ensureSprite(url, { count: false });
    const k = Math.min(1, 160 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * k));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * k));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

function download(name: string, type: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  noticeDownloaded(name);
}

interface Props {
  map: BbmMap;
  parts: ReadonlyMap<string, PartWire>;
  limits: ReadonlyMap<string, number>;
  layoutTitle: string;
  onClose: () => void;
}

export function PartListDialog({ map, parts, limits, layoutTitle, onClose }: Props) {
  useEscape(onClose);
  const [format, setFormat] = useState<Format>('html');
  const [split, setSplit] = useState(() => read('cld:partListSplitPerLayer', false));
  const [hidden, setHidden] = useState(() => read('cld:partListIncludeHiddenLayers', true));
  const [busy, setBusy] = useState(false);
  const defaultInfinite = useEditorStore((s) => s.budgetDefaultInfinite);
  const showStatusMessage = useEditorStore((s) => s.showStatusMessage);

  async function exportList() {
    const groups = buildPartList(map, parts, { splitPerLayer: split, includeHiddenLayers: hidden, limits, defaultBudgetIsInfinite: defaultInfinite });
    if (groups.length === 0 || (groups.length === 1 && groups[0]!.rows.length === 0)) {
      useEditorStore.getState().showNotice('There are no parts in this layout yet, so there’s nothing to list.', 'error');
      return;
    }
    const base = layoutTitle.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'parts';
    const title = `Part List for file "${base}.bbm"`;
    const hasBudget = limits.size > 0;
    setBusy(true);
    try {
      if (format === 'txt') download(`${base}.txt`, 'text/plain', partListText(map, groups, title, hasBudget));
      else if (format === 'csv') download(`${base}.csv`, 'text/csv', partListCsv(groups, hasBudget));
      else {
        const ids = new Set(groups.flatMap((g) => g.rows.map((r) => r.partNumber)));
        const pictures = new Map<string, string | null>();
        await Promise.all([...ids].map(async (id) => pictures.set(id, await pictureOf(parts.get(id.toLowerCase())))));
        download(`${base}.html`, 'text/html', partListHtml(map, groups, title, hasBudget, (id) => pictures.get(id) ?? null));
      }
      const kinds = groups.reduce((n, g) => n + g.rows.length, 0);
      const total = groups.reduce((n, g) => n + g.total.count, 0);
      showStatusMessage(`Exported ${kinds} part rows, ${total} bricks`, 5000);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Export Part List" className="fixed inset-0 z-50 grid place-items-center bg-black/60" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="w-md rounded-lg border border-line bg-panel p-5 shadow-xl">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">Export Part List</h2>
          <HelpButton helpKey="dialog.exportPartList" />
        </div>
        <fieldset className="mt-4 flex gap-4 text-sm">
          <legend className="sr-only">Format</legend>
          {(['html', 'txt', 'csv'] as const).map((f) => (
            <label key={f} className="flex items-center gap-1">
              <input type="radio" name="partlist-format" checked={format === f} onChange={() => setFormat(f)} />
              {f === 'html' ? 'HTML (with pictures)' : f === 'txt' ? 'Text' : 'CSV'}
            </label>
          ))}
        </fieldset>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={split} onChange={(e) => { setSplit(e.target.checked); write('cld:partListSplitPerLayer', e.target.checked); }} />
          Split by sheet
        </label>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={hidden} onChange={(e) => { setHidden(e.target.checked); write('cld:partListIncludeHiddenLayers', e.target.checked); }} />
          Include hidden sheets
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-border px-3 py-1 text-sm hover:bg-soft">Cancel</button>
          <button onClick={() => void exportList()} disabled={busy} className="rounded-lg bg-accent text-accent-ink px-3 py-1 text-sm hover:bg-accent-hover disabled:opacity-50">
            Export
          </button>
        </div>
      </div>
    </div>
  );
}
