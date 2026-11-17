// The library entries of a placed module's ⋯ menus (the map's context
// menu, the Modules panel and the phone's module sheet show the same):
// Save to Module library…, Update Module library version… and Update from Module library.

import { useMemo } from 'react';
import type * as Y from 'yjs';
import { useQuery } from '@tanstack/react-query';
import type { SidecarModule } from '@cld/bbm';
import { api } from '../api';
import { useEditorStore } from './editorStore';
import { libraryState, pullFromLibrary } from './moduleLibrary';
import { indexParts } from './partIndex';
import { sharedModulesLayout } from './sharedModules';

export interface ModuleMenuEntry {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Why it's greyed out, or more about it. */
  title?: string;
}

/** Update from Module library, with what happened said in the status bar or a notice. */
export async function pullWithNotice(doc: Y.Doc, m: SidecarModule, parts: Map<string, import('../api').PartWire> | null): Promise<void> {
  const st = useEditorStore.getState();
  try {
    const layoutId = sharedModulesLayout();
    const r = await pullFromLibrary(doc, m.id, { parts, activeLayerId: st.activeLayerId, layoutId });
    if (typeof r === 'object') {
      // The server put it in for everyone: Undo doesn't take it back, Go back does.
      const from = r.from;
      st.showNotice(
        `“${m.name || 'The module'}” is now version ${r.version}.`,
        'done',
        15000,
        from && layoutId
          ? {
              label: `Go back to version ${from}`,
              run: () => void api.sharedModules.apply(layoutId, m.id, { version: from }).catch((e: unknown) => st.showNotice(e instanceof Error ? e.message : String(e), 'error', 8000)),
            }
          : undefined,
      );
    } else if (r === 'updated') st.showStatusMessage(`Updated “${m.name || 'module'}” from the Module library`, 5000);
    else if (r === 'up-to-date') st.showNotice(`“${m.name || 'This module'}” already matches the Module library.`);
  } catch (e) {
    st.showNotice(`Couldn’t update from the Module library: ${(e as Error).message}`, 'error', 10000);
  }
}

/** The library entries for a placed module (none while it is being edited part by part). */
export function useLibraryEntries(doc: Y.Doc): (m: SidecarModule) => ModuleMenuEntry[] {
  const modules = useQuery({ queryKey: ['modules'], queryFn: api.modules.list });
  const catalog = useQuery({ queryKey: ['parts-catalog'], queryFn: api.parts.catalog, staleTime: 5 * 60 * 1000 });
  const parts = useMemo(() => (catalog.data ? indexParts(catalog.data.parts) : null), [catalog.data]);
  return (m) => {
    const open = (kind: 'save' | 'publish') => () => useEditorStore.getState().setModuleDialog({ kind, moduleId: m.id });
    const save: ModuleMenuEntry = { id: 'library-save', label: 'Save to Module library…', onSelect: open('save'), title: 'Save a copy to your Module library or a club’s, to use in other layouts' };
    const state = libraryState(m, modules.data?.modules);
    if (state.kind !== 'linked') return [save];
    const out: ModuleMenuEntry[] = [
      {
        id: 'library-publish',
        label: 'Update Module library version…',
        onSelect: open('publish'),
        disabled: !state.canPublish,
        title: state.canPublish ? `Make this layout’s copy version ${state.latest + 1} of “${state.title}”` : `You can’t change “${state.title}” in the Module library`,
      },
    ];
    if (state.newer) {
      out.push({
        id: 'library-pull',
        label: `Update from Module library (v${state.latest})`,
        onSelect: () => void pullWithNotice(doc, m, parts),
        title: `Replace this module’s parts with version ${state.latest} from the Module library`,
      });
    }
    if (!state.canPublish) out.push(save);
    return out;
  };
}
