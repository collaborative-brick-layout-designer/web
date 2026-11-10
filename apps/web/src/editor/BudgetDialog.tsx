// Port of BudgetDialog.cpp — modeless budget editor.
// Reads/writes BlueBrick `.bbb` XML (Budget > PartList > Part id="…"), see budgetFile.ts.
// Usage counts are computed from the live Yjs doc. Rows with used > limit are highlighted.
// The limits themselves are stored in the doc's meta (`setBudgetLimits`), so
// they persist and sync; .bbb Open/Save import and export them.

import { noticeDownloaded, useEditorStore } from './editorStore';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { BbmMap } from '@cld/model';
import { mergeBudgets, parseBbb, writeBbb, type BudgetEntry } from './budgetFile';
import { budgetRows } from './budgetUsage';
import { HelpButton } from '../help/HelpButton';

interface Props {
  map: BbmMap | null;
  limits: Map<string, number>;
  onLimitsChange: (limits: Map<string, number>) => void;
  /** Current id for an old part number read from a .bbb (BlueBrick getActualPartNumber); identity by default. */
  resolvePart?: (id: string) => string;
  /** The part's name from the parts library, shown beside its number. */
  partName?: (id: string) => string | undefined;
  /** How far from the right edge it opens (the right dock's width), so it never covers the Parts panel. */
  clearRight?: string;
  onClose: () => void;
}

export function BudgetDialog({ map, limits, onLimitsChange, resolvePart = (id) => id, partName, clearRight = '0px', onClose }: Props) {
  const setLimits = onLimitsChange;
  // It stays open beside the map, but takes the focus when it opens (and Esc
  // inside it closes it), so a keyboard can reach it.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus({ preventScroll: true });
  }, []);
  const [fileName, setFileName] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // One row per part placed or limited; part ids match case-insensitively.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rows = useMemo(() => budgetRows(map, limits), [map, limits, refreshKey]);
  const overBudgetCount = rows.filter((r) => r.limit !== undefined && r.used > r.limit).length;

  function handleNew() {
    setLimits(new Map());
    setFileName(null);
  }

  /**
   * Pick a .bbb and hand its entries — old part numbers already mapped to
   * the part that replaced them, first entry per part kept, as BlueBrick
   * reads the file — to `use`.
   */
  function pickBudgetFile(use: (entries: BudgetEntry[], name: string) => void) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.bbb,.xml';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      file.text().then((text) => {
        let entries: BudgetEntry[];
        try {
          entries = parseBbb(text);
        } catch (e) {
          useEditorStore.getState().showNotice(`Couldn’t open ${file.name}: ${(e as Error).message}`, 'error', 10000);
          return;
        }
        const out: BudgetEntry[] = [];
        const seen = new Set<string>();
        for (const e of entries) {
          const part = resolvePart(e.part);
          if (seen.has(part.toUpperCase())) continue;
          seen.add(part.toUpperCase());
          out.push({ part, limit: e.limit });
        }
        use(out, file.name);
      });
    };
    input.click();
  }

  const toMap = (entries: readonly BudgetEntry[]) => {
    const m = new Map<string, number>();
    for (const e of entries) if (e.limit >= 0) m.set(e.part, e.limit);
    return m;
  };

  function handleOpen() {
    pickBudgetFile((entries, name) => {
      setLimits(toMap(entries));
      setFileName(name);
    });
  }

  // Budget → Import and Merge (MainWindowBudgetMenu.cpp:73-80): the file's
  // limits are added to the current ones.
  function handleMerge() {
    pickBudgetFile((entries) => {
      const current = [...limits].map(([part, limit]) => ({ part, limit }));
      setLimits(toMap(mergeBudgets(current, entries)));
    });
  }

  function handleSave() {
    const entries: BudgetEntry[] = [...limits.entries()].map(([part, limit]) => ({ part, limit }));
    const xml = writeBbb(entries);
    const blob = new Blob([xml], { type: 'application/xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName ?? 'budget.bbb';
    a.click();
    noticeDownloaded(a.download);
    URL.revokeObjectURL(a.href);
  }

  function setLimit(part: string, value: string) {
    const next = new Map(limits);
    const trimmed = value.trim();
    if (trimmed === '') {
      next.delete(part);
    } else {
      const n = parseInt(trimmed, 10);
      if (!isNaN(n) && n >= 0) next.set(part, n);
    }
    setLimits(next);
  }

  return (
    <div
      ref={box}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
      role="dialog"
      aria-label="Budget"
      // On a phone it spans the screen's width, above the touch bar.
      style={{ '--budget-right': `calc(${clearRight} + 2rem)` } as CSSProperties}
      className="fixed inset-x-2 bottom-[calc(0.5rem+var(--touch-bar-h,0px))] z-40 flex flex-col rounded-lg border border-border bg-panel text-sm shadow-2xl sm:inset-x-auto sm:bottom-8 sm:right-(--budget-right) sm:w-[540px]"
    >
      {/* Title bar */}
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="flex items-center gap-2">
          <span className="font-semibold text-xs">
            Budget{fileName ? ` — ${fileName}` : ''}
          </span>
          <HelpButton helpKey="dialog.budget" />
        </span>
        <button onClick={onClose} aria-label="Close the budget" title="Close the budget" className="text-muted hover:text-ink text-base leading-none">×</button>
      </div>

      {/* Toolbar */}
      <div className="flex gap-2 border-b border-line px-3 py-2">
        {/* The budget lives in the layout, so desktop's New and Close both mean: no limits. */}
        <button onClick={handleNew} title="Remove every limit (desktop New / Close Budget)"
          className="rounded-lg border border-border px-2 py-0.5 text-xs hover:bg-soft">New</button>
        <button onClick={handleOpen}
          className="rounded-lg border border-border px-2 py-0.5 text-xs hover:bg-soft">Open…</button>
        <button onClick={handleMerge} title="Add the limits of another budget file to the current budget"
          className="rounded-lg border border-border px-2 py-0.5 text-xs hover:bg-soft">Import and Merge…</button>
        <button onClick={handleSave}
          className="rounded-lg border border-border px-2 py-0.5 text-xs hover:bg-soft">Save…</button>
        <button onClick={() => setRefreshKey((k) => k + 1)}
          className="rounded-lg border border-border px-2 py-0.5 text-xs hover:bg-soft" title="Re-count parts from current map">Refresh</button>
      </div>

      {/* Table */}
      <div className="overflow-auto" style={{ maxHeight: '340px' }}>
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-panel">
            <tr className="border-b border-line text-left text-muted">
              <th className="px-2 py-1">Part</th>
              <th className="px-2 py-1 text-right">Used</th>
              <th className="px-2 py-1">Limit (blank=unlimited)</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={3} className="px-2 py-3 text-center text-muted">
                  No parts in map or budget. Use "Open…" to load a .bbb file.
                </td>
              </tr>
            )}
            {rows.map(({ part, used, limit: lim, limitKey }) => {
              const limit = lim ?? -1;
              const over = limit >= 0 && used > limit;
              return (
                <tr key={part} className={over ? 'bg-red-950/60' : 'odd:bg-soft/30'}>
                  <td className="px-2 py-1">
                    {partName?.(part) ? (
                      <>
                        <span className="block">{partName(part)}</span>
                        <span className="block font-mono text-muted">{part}</span>
                      </>
                    ) : (
                      <span className="font-mono">{part}</span>
                    )}
                  </td>
                  <td className={`px-2 py-1 text-right ${over ? 'text-danger font-bold' : ''}`}>{used}</td>
                  <td className="px-2 py-1">
                    <input
                      type="number"
                      min="0"
                      placeholder="—"
                      aria-label={`Budget for ${part}`}
                      value={limit >= 0 ? limit : ''}
                      onChange={(e) => setLimit(limitKey ?? part, e.target.value)}
                      className="w-20 rounded-lg border border-border bg-soft px-1 py-0.5 text-xs"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Status */}
      <div className="border-t border-line px-3 py-1.5 text-xs">
        {overBudgetCount > 0
          ? <span className="text-danger">⚠ {overBudgetCount} part(s) over budget</span>
          : <span className="text-green-400">All parts within budget</span>}
      </div>
    </div>
  );
}
