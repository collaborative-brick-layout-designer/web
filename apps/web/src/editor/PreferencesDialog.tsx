// Preferences dialog — port of desktop PreferencesDialog.cpp.
// Only the Editing and Appearance tabs are implemented; Import/Library/
// General tabs are deferred until those systems exist in the web port.

import { useState } from 'react';
import { useEditorStore, SNAP_STEPS, ROTATION_STEPS } from './editorStore';
import { useEscape } from './useEscape';

type Tab = 'general' | 'editing' | 'appearance';

interface Props {
  onClose: () => void;
}

export function PreferencesDialog({ onClose }: Props) {
  useEscape(onClose);
  const [tab, setTab] = useState<Tab>('editing');

  const snapStepStuds = useEditorStore((s) => s.snapStepStuds);
  const rotationStepDegrees = useEditorStore((s) => s.rotationStepDegrees);
  const paintColor = useEditorStore((s) => s.paintColor);
  const setSnapStep = useEditorStore((s) => s.setSnapStep);
  const setRotationStep = useEditorStore((s) => s.setRotationStep);
  const setPaintColor = useEditorStore((s) => s.setPaintColor);

  const wheelZoomFactor = useEditorStore((s) => s.wheelZoomFactor);
  const setWheelZoomFactor = useEditorStore((s) => s.setWheelZoomFactor);
  const undoStackDepth = useEditorStore((s) => s.undoStackDepth);
  const setUndoStackDepth = useEditorStore((s) => s.setUndoStackDepth);
  const reopenLastFile = useEditorStore((s) => s.reopenLastFile);
  const setReopenLastFile = useEditorStore((s) => s.setReopenLastFile);
  const budgetDefaultInfinite = useEditorStore((s) => s.budgetDefaultInfinite);
  const setBudgetDefaultInfinite = useEditorStore((s) => s.setBudgetDefaultInfinite);
  const warnBudgetLimitation = useEditorStore((s) => s.warnBudgetLimitation);
  const setWarnBudgetLimitation = useEditorStore((s) => s.setWarnBudgetLimitation);
  const selectionTint = useEditorStore((s) => s.selectionTint);
  const setSelectionTint = useEditorStore((s) => s.setSelectionTint);
  const showModuleNames = useEditorStore((s) => s.showModuleNames);
  const moduleFrameThickness = useEditorStore((s) => s.moduleFrameThickness);
  const setShowModuleNames = useEditorStore((s) => s.setShowModuleNames);
  const setModuleFrameThickness = useEditorStore((s) => s.setModuleFrameThickness);

  const showElectricCircuits = useEditorStore((s) => s.showElectricCircuits);
  const showExportWatermark = useEditorStore((s) => s.showExportWatermark);
  const moduleLabelPercent = useEditorStore((s) => s.moduleLabelPercent);
  const venueLabelPx = useEditorStore((s) => s.venueLabelPx);
  const setShowElectricCircuits = useEditorStore((s) => s.setShowElectricCircuits);
  const setShowExportWatermark = useEditorStore((s) => s.setShowExportWatermark);
  const setModuleLabelPercent = useEditorStore((s) => s.setModuleLabelPercent);
  const setVenueLabelPx = useEditorStore((s) => s.setVenueLabelPx);
  const showGrid = useEditorStore((s) => s.showGrid);
  const showConnectionPoints = useEditorStore((s) => s.showConnectionPoints);
  const showBrickHulls = useEditorStore((s) => s.showBrickHulls);
  const showBrickElevation = useEditorStore((s) => s.showBrickElevation);
  const showRulerAttachPoints = useEditorStore((s) => s.showRulerAttachPoints);
  const alwaysShowConnections = useEditorStore((s) => s.alwaysShowConnections);
  const setShowGrid = useEditorStore((s) => s.setShowGrid);
  const setShowConnectionPoints = useEditorStore((s) => s.setShowConnectionPoints);
  const setShowBrickHulls = useEditorStore((s) => s.setShowBrickHulls);
  const setShowBrickElevation = useEditorStore((s) => s.setShowBrickElevation);
  const setShowRulerAttachPoints = useEditorStore((s) => s.setShowRulerAttachPoints);
  const setAlwaysShowConnections = useEditorStore((s) => s.setAlwaysShowConnections);

  // Paint color is stored as AARRGGBB hex — convert to/from #rrggbb for
  // the color picker. We always write back with FF alpha (fully opaque)
  // for the base color; the "50% alpha" default is kept for new maps only.
  const pickerColor = `#${paintColor.slice(-6)}`;
  function onPickerChange(hex: string) {
    // hex = "#rrggbb" → store as "FFrrggbb"
    setPaintColor(`FF${hex.slice(1)}`);
  }

  const tabCls = (t: Tab) =>
    'px-3 py-1.5 text-xs rounded-t ' +
    (tab === t ? 'bg-soft text-ink' : 'text-muted hover:text-neutral-300');


  const rowCls = 'flex items-center justify-between gap-4 py-1.5';
  const labelCls = 'text-xs text-muted w-40';
  const checkRowCls = 'flex items-center gap-2 py-1';

  return (
    <div role="dialog" aria-label="Preferences" aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-136 rounded-lg border border-border bg-panel shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Tab bar */}
        <div className="flex border-b border-border px-4 pt-3">
          <button className={tabCls('general')} onClick={() => setTab('general')}>General</button>
          <button className={tabCls('editing')} onClick={() => setTab('editing')}>Editing</button>
          <button className={tabCls('appearance')} onClick={() => setTab('appearance')}>Appearance</button>
        </div>

        {/* Tab content */}
        <div className="p-5">
          {tab === 'general' && (
            <div className="flex flex-col gap-1">
              <div className={rowCls}>
                <span className={labelCls}>Wheel zoom speed</span>
                <div className="flex flex-1 items-center gap-2">
                  <input
                    aria-label="Wheel zoom speed"
                    type="range"
                    min={0.2}
                    max={3}
                    step={0.05}
                    value={wheelZoomFactor}
                    onChange={(e) => setWheelZoomFactor(parseFloat(e.target.value))}
                    className="flex-1 accent-accent"
                  />
                  <span className="w-8 text-right text-xs tabular-nums text-muted">
                    {wheelZoomFactor.toFixed(2)}×
                  </span>
                </div>
              </div>
              <p className="mt-1 text-[10px] text-neutral-600">
                Mirrors <code>general/wheelZoomFactor</code>. Default 1.00×. Higher = faster zoom.
              </p>
              {/* PreferencesDialog.cpp:69 budget/defaultInfinite, general/warnBudgetLimitation */}
              <div className={rowCls}>
                <span className={labelCls}>Parts without a budget</span>
                <select
                  aria-label="Parts without a budget"
                  value={budgetDefaultInfinite ? 'unlimited' : 'forbidden'}
                  onChange={(e) => setBudgetDefaultInfinite(e.target.value === 'unlimited')}
                  className="rounded-lg border border-border bg-soft px-2 py-0.5 text-sm"
                >
                  <option value="unlimited">Unlimited</option>
                  <option value="forbidden">Forbidden (budget 0)</option>
                </select>
              </div>
              <div className={rowCls}>
                <span className={labelCls}>Warn when the budget refuses a part</span>
                <input
                  type="checkbox"
                  aria-label="Warn when the budget refuses a part"
                  checked={warnBudgetLimitation}
                  onChange={(e) => setWarnBudgetLimitation(e.target.checked)}
                  className="accent-accent"
                />
              </div>
              <div className={rowCls}>
                <span className={labelCls}>Reopen last layout on startup</span>
                <input
                  aria-label="Reopen last layout on startup"
                  type="checkbox"
                  checked={reopenLastFile}
                  onChange={(e) => setReopenLastFile(e.target.checked)}
                  className="accent-accent"
                />
              </div>
              <div className={rowCls}>
                <span className={labelCls}>Undo stack depth</span>
                <div className="flex flex-1 items-center gap-2">
                  <input
                    aria-label="Undo stack depth"
                    type="number"
                    min={0}
                    max={1000}
                    step={10}
                    value={undoStackDepth}
                    onChange={(e) => setUndoStackDepth(parseInt(e.target.value, 10) || 0)}
                    className="w-20 rounded-lg border border-border bg-soft px-2 py-1 text-xs"
                  />
                  <span className="text-[10px] text-neutral-600">0 = unlimited</span>
                </div>
              </div>
            </div>
          )}

          {tab === 'editing' && (
            <div className="flex flex-col gap-1">
              <div className={rowCls}>
                <span className={labelCls}>Default snap step</span>
                <select
                  aria-label="Default snap step"
                  value={snapStepStuds}
                  onChange={(e) => setSnapStep(Number(e.target.value))}
                  className="rounded-lg border border-border bg-soft px-2 py-1 text-xs"
                >
                  {SNAP_STEPS.map((s) => (
                    <option key={s} value={s}>{s === 0 ? 'Off' : `${s} stud${s !== 1 ? 's' : ''}`}</option>
                  ))}
                </select>
              </div>
              <div className={rowCls}>
                <span className={labelCls}>Default turn step</span>
                <select
                  aria-label="Default turn step"
                  value={rotationStepDegrees}
                  onChange={(e) => setRotationStep(Number(e.target.value))}
                  className="rounded-lg border border-border bg-soft px-2 py-1 text-xs"
                >
                  {ROTATION_STEPS.map((r) => (
                    <option key={r} value={r}>{r}°</option>
                  ))}
                </select>
              </div>
              <div className={rowCls}>
                <span className={labelCls}>Default paint color</span>
                <input
                  aria-label="Default paint color"
                  type="color"
                  value={pickerColor}
                  onChange={(e) => onPickerChange(e.target.value)}
                  className="h-7 w-12 cursor-pointer rounded-lg border border-border bg-soft p-0.5"
                />
              </div>
            </div>
          )}

          {tab === 'appearance' && (
            <div className="flex flex-col gap-0.5">
              {[
                { label: 'Show grid', value: showGrid, set: setShowGrid },
                { label: 'Show connection points', value: showConnectionPoints, set: setShowConnectionPoints },
                { label: 'Show brick hull outlines', value: showBrickHulls, set: setShowBrickHulls },
                { label: 'Show brick elevation labels', value: showBrickElevation, set: setShowBrickElevation },
                { label: 'Show ruler attach points', value: showRulerAttachPoints, set: setShowRulerAttachPoints },
                { label: 'Always show connection points', value: alwaysShowConnections, set: setAlwaysShowConnections },
                { label: 'Show module names and frames', value: showModuleNames, set: setShowModuleNames },
                { label: 'Show electric circuits', value: showElectricCircuits, set: setShowElectricCircuits },
                { label: 'Add the author, club and event to exported pictures', value: showExportWatermark, set: setShowExportWatermark },
              ].map(({ label, value, set }) => (
                <label key={label} className={checkRowCls}>
                  <input
                    type="checkbox"
                    checked={value}
                    onChange={(e) => set(e.target.checked)}
                    className="accent-accent"
                  />
                  <span className="text-xs text-neutral-300">{label}</span>
                </label>
              ))}
              <div className="flex items-center justify-between gap-4 py-1.5">
                <span className="text-xs text-muted">Selection tint color</span>
                <input
                  aria-label="Selection tint color"
                  type="color"
                  value={`#${selectionTint}`}
                  onChange={(e) => setSelectionTint(e.target.value.slice(1))}
                  className="h-7 w-12 cursor-pointer rounded-lg border border-border bg-soft p-0.5"
                />
              </div>
              <div className="flex items-center justify-between gap-4 py-1.5">
                <span className="text-xs text-muted">Module frame thickness (px)</span>
                <input
                  type="number"
                  aria-label="Module frame thickness (px)"
                  min={0.5}
                  max={20}
                  step={0.5}
                  value={moduleFrameThickness}
                  onChange={(e) => setModuleFrameThickness(parseFloat(e.target.value) || 5)}
                  className="w-20 rounded-lg border border-border bg-soft px-2 py-1 text-xs"
                />
              </div>
              <div className="flex items-center justify-between gap-4 py-1.5">
                <span
                  className="text-xs text-muted"
                  title="Module name size as a percentage of the module's long axis"
                >
                  Module label size (% of long axis)
                </span>
                <input
                  aria-label="Module label size (% of long axis)"
                  type="number"
                  min={5}
                  max={100}
                  step={5}
                  value={moduleLabelPercent}
                  onChange={(e) => setModuleLabelPercent(parseInt(e.target.value, 10) || 35)}
                  className="w-20 rounded-lg border border-border bg-soft px-2 py-1 text-xs"
                />
              </div>
              <div className="flex items-center justify-between gap-4 py-1.5">
                <span className="text-xs text-muted">Venue label size (px)</span>
                <input
                  aria-label="Venue label size (px)"
                  type="number"
                  min={4}
                  max={200}
                  step={1}
                  value={venueLabelPx}
                  onChange={(e) => setVenueLabelPx(parseInt(e.target.value, 10) || 28)}
                  className="w-20 rounded-lg border border-border bg-soft px-2 py-1 text-xs"
                />
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end border-t border-border px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg bg-accent px-4 py-1.5 text-xs text-accent-ink hover:bg-accent-hover"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
