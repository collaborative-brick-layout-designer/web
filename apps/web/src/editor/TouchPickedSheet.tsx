// What else can be done with the picked parts on a phone or tablet (the
// touch bar's More actions button): Copy, Cut and Paste, Save as set…,
// Group, Ungroup, Select connected, Bring to front, Send to back and Move
// to a sheet…, as the map's right-click menu has them. Phones have no right-click menu and no
// Map menu bar, so without this sheet these had no way in by touch.

import { useEffect, useState } from 'react';
import { useEditorStore } from './editorStore';

export interface PickedActions {
  /** Copy the picked parts, to paste in this layout or another (the same clipboard as Ctrl+C). */
  copy: () => void;
  cut: () => void;
  /** Paste what was copied, in the middle of the view. */
  paste: () => void;
  saveAsSet: () => void;
  group: () => void;
  ungroup: () => void;
  /** What Ungroup would do: nothing grouped (hidden), split, or only sets always used whole (greyed out). */
  ungroupState: () => 'nothing' | 'splits' | 'whole';
  selectConnected: () => void;
  reorder: (to: 'front' | 'back') => void;
  /** Opens the sheets list, where the picked parts can move to a sheet. */
  moveToSheet: () => void;
}

interface Entry {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Why it's greyed out. */
  title?: string;
}

export function TouchPickedSheet({ actions, onClose }: { actions: PickedActions; onClose: () => void }) {
  const parts = useEditorStore((s) => s.selection.length);
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
  // Nothing picked any more (someone else deleted them): nothing to do.
  useEffect(() => {
    if (parts === 0) onClose();
  }, [parts, onClose]);

  const ungroup = actions.ungroupState();
  const entries: Entry[] = [
    { id: 'copy', label: 'Copy', onSelect: actions.copy },
    { id: 'cut', label: 'Cut', onSelect: actions.cut },
    { id: 'paste', label: 'Paste', onSelect: actions.paste },
    { id: 'save-set', label: 'Save as set…', onSelect: actions.saveAsSet },
    ...(parts >= 2 ? [{ id: 'group', label: 'Group', onSelect: actions.group }] : []),
    ...(ungroup === 'splits' ? [{ id: 'ungroup', label: 'Ungroup', onSelect: actions.ungroup }] : []),
    ...(ungroup === 'whole'
      ? [{ id: 'ungroup', label: 'Ungroup', onSelect: actions.ungroup, disabled: true, title: 'This set is always used whole, so it can’t be split.' }]
      : []),
    { id: 'select-connected', label: 'Select connected', onSelect: actions.selectConnected },
    { id: 'front', label: 'Bring to front', onSelect: () => actions.reorder('front') },
    { id: 'back', label: 'Send to back', onSelect: () => actions.reorder('back') },
    { id: 'move-sheet', label: 'Move to a sheet…', onSelect: actions.moveToSheet },
  ];
  const title = parts === 1 ? '1 part picked' : `${parts} parts picked`;
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
        aria-label="More actions"
        data-testid="touch-picked-sheet"
        className={`absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-2xl border-t border-line bg-panel text-ink shadow-pop transition-transform duration-200 ease-out ${open ? 'translate-y-0' : 'translate-y-full'}`}
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-line" aria-hidden />
        <div className="flex items-center gap-2 px-4 pt-2">
          <h2 className="min-w-0 flex-1 truncate text-lg font-bold">{title}</h2>
          <button type="button" onClick={onClose} className="min-h-11 rounded-control px-4 text-sm font-bold hover:bg-soft">
            Close
          </button>
        </div>
        <ul className="flex flex-col gap-1 px-2 pt-1">
          {entries.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                disabled={e.disabled}
                data-testid={`touch-picked-${e.id}`}
                onClick={() => {
                  onClose();
                  e.onSelect();
                }}
                className="flex min-h-12 w-full items-center rounded-control px-3 text-left text-base font-semibold hover:bg-soft disabled:opacity-40"
              >
                {e.label}
              </button>
              {e.disabled && e.title && <p className="px-3 pb-1 text-xs text-muted">{e.title}</p>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
