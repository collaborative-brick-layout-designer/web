// The small "→ <sheet>" tag that rides beside the pointer while a part is
// dragged from the Parts panel over the map, so where it lands is never a
// surprise. Set by the canvas's dragover (editorStore.dropTag).

import { useEditorStore } from './editorStore';

export function DropSheetTag() {
  const tag = useEditorStore((s) => s.dropTag);
  if (!tag) return null;
  return (
    <div
      data-testid="drop-sheet-tag"
      aria-hidden="true"
      className={
        'pointer-events-none fixed z-50 max-w-64 truncate rounded-full px-2.5 py-0.5 text-xs font-bold shadow-md ' +
        (tag.hidden ? 'bg-amber-900 text-amber-300 ring-1 ring-amber-500' : 'bg-accent text-accent-ink')
      }
      style={{ left: tag.x + 18, top: tag.y + 18 }}
    >
      → {tag.sheet}
      {tag.hidden ? ' (hidden)' : ''}
    </div>
  );
}
