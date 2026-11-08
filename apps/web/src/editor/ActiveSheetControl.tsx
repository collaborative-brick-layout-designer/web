// "Adding to: <sheet> ▾" in the edit toolbar: always says which sheet new
// parts go on, and switches it. Reads the live doc, so a rename, a delete,
// an undo or a collaborator's edit shows at once. The menu also holds
// "Fade other sheets while editing" (render/sheetFade.ts).

import { useEffect, useState } from 'react';
import type * as Y from 'yjs';
import { useEditorStore } from './editorStore';
import { useDocMap } from './useDocMap';
import { dropdownAnchor } from './viewHelpers';
import { placementTarget, SHEET_GLYPH, SHEET_KIND, sheetName } from './activeSheet';
import { HelpButton } from '../help/HelpButton';

const MENU_WIDTH = 256;

export function ActiveSheetControl({ doc }: { doc: Y.Doc }) {
  const map = useDocMap(doc);
  const activeLayerId = useEditorStore((s) => s.activeLayerId);
  const setActiveLayer = useEditorStore((s) => s.setActiveLayer);
  const fadeOthers = useEditorStore((s) => s.fadeOtherSheets);
  const setFadeOthers = useEditorStore((s) => s.setFadeOtherSheets);
  const [anchor, setAnchor] = useState<React.CSSProperties | null>(null);

  useEffect(() => {
    if (!anchor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAnchor(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [anchor]);

  const layers = map?.layers ?? [];
  const { active, target, redirected } = placementTarget(layers, activeLayerId);
  // Topmost first, as in the Sheets panel.
  const rows = [...layers].reverse();
  const tip = !active
    ? 'No sheet is picked. Click to pick one.'
    : redirected
      ? `“${sheetName(active)}” is a ${SHEET_KIND[active.type]} sheet, so new parts go on “${target ? sheetName(target) : 'a new parts sheet'}”. Click to pick another sheet.`
      : `New parts go on “${sheetName(active)}”. Click to pick another sheet.`;

  return (
    <span className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        data-testid="active-sheet-control"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        title={tip}
        onClick={(e) => setAnchor(anchor ? null : dropdownAnchor(e.currentTarget, window.innerWidth, MENU_WIDTH))}
        className="flex max-w-[18rem] items-center gap-1.5 rounded-lg border-2 border-accent bg-accent-soft px-2 py-0.5 text-xs text-ink hover:bg-soft"
      >
        <span className="text-muted">Adding to:</span>
        {active && (
          <span aria-hidden="true" className="w-3 text-center font-bold text-accent-text">
            {SHEET_GLYPH[active.type]}
          </span>
        )}
        <span data-testid="active-sheet-name" className="min-w-0 truncate font-bold text-accent-text">
          {active ? sheetName(active) : 'no sheet'}
        </span>
        {active && !active.visible && (
          <span className="shrink-0 rounded-full bg-amber-900 px-1.5 text-[10px] font-bold text-amber-300">hidden</span>
        )}
        <span aria-hidden="true" className="text-muted">▾</span>
      </button>
      <HelpButton helpKey="toolbar.activeSheet" />
      {anchor && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setAnchor(null)} />
          <ul
            role="menu"
            aria-label="Pick the sheet to add to"
            data-testid="active-sheet-menu"
            className="fixed z-[45] max-h-[60vh] overflow-y-auto rounded-lg border border-border bg-panel py-1 text-xs shadow-lg"
            style={{ ...anchor, width: MENU_WIDTH }}
          >
            {rows.map((l) => {
              const on = l.id === activeLayerId;
              return (
                <li key={l.id} role="none">
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={on}
                    onClick={() => {
                      setActiveLayer(l.id);
                      setAnchor(null);
                    }}
                    className={
                      'flex w-full items-center gap-2 px-3 py-1.5 text-left pointer-coarse:min-h-11 ' +
                      (on ? 'bg-accent-soft font-bold text-accent-text' : 'hover:bg-soft')
                    }
                  >
                    <span aria-hidden="true" className="w-3 text-center">{on ? '✓' : ''}</span>
                    <span aria-hidden="true" className="w-3 text-center text-muted">{SHEET_GLYPH[l.type]}</span>
                    <span className="min-w-0 flex-1 truncate">{sheetName(l)}</span>
                    {!l.visible && <span className="text-[10px] text-muted">hidden</span>}
                    <span className="text-[10px] font-normal text-muted">{SHEET_KIND[l.type]}</span>
                  </button>
                </li>
              );
            })}
            <li role="none" className="mt-1 flex items-center gap-1 border-t border-border px-3 pt-1">
              <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1 pointer-coarse:min-h-11">
                <input
                  type="checkbox"
                  role="menuitemcheckbox"
                  data-testid="fade-other-sheets"
                  checked={fadeOthers}
                  onChange={(e) => setFadeOthers(e.target.checked)}
                  className="accent-accent"
                />
                <span>Fade other sheets while editing</span>
              </label>
              <HelpButton helpKey="sheets.fadeOthers" />
            </li>
          </ul>
        </>
      )}
    </span>
  );
}
