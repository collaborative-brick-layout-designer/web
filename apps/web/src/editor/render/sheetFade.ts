// "Fade other sheets while editing": every sheet but the active one draws
// at FADED_SHEET_OPACITY. It is a viewer preference (editorStore
// fadeOtherSheets, kept in this browser only): never written to the layout,
// never synced. Each sheet's group is named SHEET_FADE so an export can
// draw it at full strength (renderMapToCanvas), whatever the setting says.

import { useCallback } from 'react';
import { useEditorStore } from '../editorStore';

/** Konva node name on each sheet's group that the fade dims. */
export const SHEET_FADE = 'sheet-fade';

/**
 * Konva attr on a SHEET_FADE group that also carries the sheet's own
 * transparency: the opacity it draws at with the fade off. Without it, 1.
 */
export const SHEET_FULL_OPACITY = 'sheetFullOpacity';

/** How strong a faded sheet draws: about a third. */
export const FADED_SHEET_OPACITY = 0.35;

/** The opacity a sheet's group draws at; 1 unless fading is on and it isn't the active sheet. */
export function sheetFadeOpacity(layerId: string, fadeOn: boolean, activeLayerId: string | null): number {
  return fadeOn && activeLayerId !== null && layerId !== activeLayerId ? FADED_SHEET_OPACITY : 1;
}

/** The fade for each sheet, live as the setting or the active sheet changes. Off for a viewer, who isn't editing. */
export function useSheetFade(isViewer = false): (layerId: string) => number {
  const fadeOn = useEditorStore((s) => s.fadeOtherSheets) && !isViewer;
  const activeLayerId = useEditorStore((s) => s.activeLayerId);
  return useCallback((layerId: string) => sheetFadeOpacity(layerId, fadeOn, activeLayerId), [fadeOn, activeLayerId]);
}
