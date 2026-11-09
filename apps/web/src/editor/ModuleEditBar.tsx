// The bar over the map while a module is edited: "Editing module ‹name›",
// who else is in it ("Sam is here too", from presence), and Done. Under
// it, for a module on several sheets, which sheet new parts go on, and,
// when some of its sheets are hidden, a Show button. The desktop's
// MapView shows the same bar.

import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import { readSidecarFromDoc } from '@cld/ydoc';
import { useEditorStore } from './editorStore';
import { onePerPerson, useRemotePeers } from './useAwareness';
import { hereTooText } from './moduleEdit';
import { leaveModuleEdit } from './moduleActions';
import { HelpButton } from '../help/HelpButton';
import { useDocMap } from './useDocMap';
import { moduleSheetsUsed, pickedPartsSheet } from './moduleSheets';
import { setLayerVisible } from './mutations';

export function ModuleEditBar({ doc, awareness }: { doc: Y.Doc; awareness: Awareness | null }) {
  const editingId = useEditorStore((s) => s.editingModuleId);
  const peers = useRemotePeers(awareness);
  const map = useDocMap(doc);
  const activeLayerId = useEditorStore((s) => s.activeLayerId);
  if (!editingId) return null;
  const mod = readSidecarFromDoc(doc)?.modules?.find((m) => m.id === editingId);
  if (!mod) return null;
  const uses = map ? moduleSheetsUsed(map, mod.members) : [];
  const hidden = uses.filter((u) => !u.visible);
  const pickedId = map ? pickedPartsSheet(map, activeLayerId) : null;
  const picked = map?.layers.find((l) => l.id === pickedId);
  const others = hereTooText(onePerPerson(peers).filter((p) => p.state.editingModule === editingId).map((p) => p.state.user.displayName));
  return (
    <div
      role="status"
      data-testid="module-edit-bar"
      className="pointer-events-none absolute inset-x-0 top-2 z-20 flex flex-col items-center gap-1 px-4"
    >
      <div className="pointer-events-auto flex max-w-full items-center gap-3 rounded-full border border-line bg-panel/95 py-1.5 pl-4 pr-1.5 text-sm text-ink shadow-lg">
        <span className="min-w-0 truncate">
          Editing module <strong className="font-semibold">{mod.name || '(module)'}</strong>
        </span>
        {others && (
          <span data-testid="module-edit-others" className="truncate text-xs text-muted">
            {others}
          </span>
        )}
        <HelpButton helpKey="module.edit" />
        <button
          type="button"
          onClick={leaveModuleEdit}
          className="rounded-full bg-accent px-3 py-1 text-sm font-medium text-accent-ink hover:bg-accent-hover"
          title="Back to the whole layout (Esc)"
        >
          Done
        </button>
      </div>
      {(uses.length > 1 || hidden.length > 0) && (
        <div
          data-testid="module-edit-sheets"
          className="pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-full border border-line bg-panel/95 px-3 py-1 text-xs text-muted shadow"
        >
          {uses.length > 1 && (
            <span>
              This module uses {uses.length} sheets.
              {picked && (
                <>
                  {' '}New parts go on <b className="text-ink">{picked.name || 'untitled'}</b> (the picked sheet).
                </>
              )}
            </span>
          )}
          {hidden.length > 0 && (
            <span className="flex items-center gap-1">
              {hidden.length === uses.length
                ? uses.length === 1 ? 'Its sheet is hidden.' : 'Its sheets are hidden.'
                : `${hidden.length} of its sheets ${hidden.length === 1 ? 'is' : 'are'} hidden.`}
              <button
                type="button"
                onClick={() => hidden.forEach((h) => setLayerVisible(doc, h.id, true))}
                className="tap-target rounded-full px-2 py-0.5 font-semibold text-accent-text hover:bg-soft"
              >
                {hidden.length === 1 ? 'Show it' : 'Show them'}
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
