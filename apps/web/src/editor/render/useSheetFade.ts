// The live fade for each sheet (render/sheetFade.ts), from the editor store.

import { useCallback } from 'react';
import { useEditorStore } from '../editorStore';
import { sheetFadeOpacity } from './sheetFade';

/** The fade for each sheet, live as the setting or the active sheet changes. Off for a viewer, who isn't editing. */
export function useSheetFade(isViewer = false): (layerId: string) => number {
  const fadeOn = useEditorStore((s) => s.fadeOtherSheets) && !isViewer;
  const activeLayerId = useEditorStore((s) => s.activeLayerId);
  return useCallback((layerId: string) => sheetFadeOpacity(layerId, fadeOn, activeLayerId), [fadeOn, activeLayerId]);
}
