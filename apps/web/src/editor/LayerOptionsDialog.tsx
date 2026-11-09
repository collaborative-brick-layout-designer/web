// Layer Options dialog — port of the desktop dialog built in
// MainWindow.cpp:146-265 (opened by double-clicking a layer row,
// LayerPanel.cpp:145). Common fields: name, transparency, visibility,
// hull. Per kind: Grid (cell size, line thickness, sub-divisions,
// display grid / sub-grid / cell-index labels, colors), Brick
// (elevation labels), Area (paint cell size). The form model and the
// diffing live in layerOptions.ts; OK writes one undo step.

import { useState } from 'react';
import type * as Y from 'yjs';
import type { Layer } from '@cld/model';
import {
  applyLayerOptions,
  formFromLayer,
  layerOptionsPatch,
  type GridOptions,
  type LayerOptionsForm,
} from './layerOptions';
import { ColorAlphaInput } from './ColorAlphaInput';
import { HelpButton } from '../help/HelpButton';

interface Props {
  layer: Layer;
  doc: Y.Doc;
  onClose: () => void;
}

const KIND_TITLE: Record<Layer['type'], string> = {
  grid: 'Grid sheet',
  brick: 'Parts sheet',
  text: 'Text sheet',
  area: 'Area sheet',
  ruler: 'Ruler sheet',
};

export function LayerOptionsDialog({ layer, doc, onClose }: Props) {
  const [form, setForm] = useState<LayerOptionsForm>(() => formFromLayer(layer));
  const set = <K extends keyof LayerOptionsForm>(k: K, v: LayerOptionsForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const setGrid = <K extends keyof GridOptions>(k: K, v: GridOptions[K]) =>
    setForm((f) => (f.grid ? { ...f, grid: { ...f.grid, [k]: v } } : f));

  function commit() {
    applyLayerOptions(doc, layer.id, layerOptionsPatch(layer, form));
    onClose();
  }

  const rowCls = 'flex items-center justify-between gap-4 py-1.5';
  const labelCls = 'text-xs text-muted w-40 shrink-0';
  const inputCls = 'flex-1 rounded-lg border border-border bg-soft px-2 py-1 text-xs';
  const sectionCls = 'mt-3 border-t border-line pt-2 text-[11px] font-semibold uppercase tracking-wider text-muted';
  const num = (v: string, fallback: number) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
  };

  const check = (label: string, checked: boolean, onChange: (v: boolean) => void) => (
    <label className={rowCls}>
      <span className={labelCls}>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-accent"
      />
    </label>
  );
  const number = (
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (v: number) => void,
    suffix?: string,
  ) => (
    <label className={rowCls}>
      <span className={labelCls}>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(num(e.target.value, value))}
        className={inputCls}
      />
      {suffix && <span className="text-xs text-muted">{suffix}</span>}
    </label>
  );
  const color = (label: string, value: string, onChange: (v: string) => void) => (
    <label className={rowCls}>
      <span className={labelCls}>{label}</span>
      <ColorAlphaInput label={label} value={value} onChange={onChange} />
    </label>
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Sheet options"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
        else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') commit();
      }}
    >
      <div
        className="max-h-[90vh] w-104 overflow-y-auto rounded-lg border border-border bg-panel p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center gap-2">
          <h2 className="text-sm font-semibold text-ink">Sheet options</h2>
          <HelpButton helpKey="dialog.sheetOptions" />
        </div>

        <div className="flex flex-col gap-0.5">
          <label className={rowCls}>
            <span className={labelCls}>Name</span>
            <input
              type="text"
              autoFocus
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              className={inputCls}
            />
          </label>
          {number('Opacity (%)', form.transparency, 0, 100, (v) => set('transparency', v))}
          {check('Visible', form.visible, (v) => set('visible', v))}
          {check('Display selection hulls', form.hullVisible, (v) => set('hullVisible', v))}
          {color('Hull color', form.hullArgb, (v) => set('hullArgb', v))}
          {number('Hull thickness (px)', form.hullThickness, 1, 20, (v) => set('hullThickness', v))}

          {(form.grid || form.displayBrickElevation !== undefined || form.areaCellSize !== undefined) && (
            <div className={sectionCls}>{KIND_TITLE[layer.type]}</div>
          )}

          {form.grid && (
            <>
              {number('Cell size', form.grid.gridSizeInStud, 1, 512, (v) => setGrid('gridSizeInStud', v), 'studs')}
              {number('Grid line thickness', form.grid.gridThickness, 1, 20, (v) => setGrid('gridThickness', v))}
              {number('Sub-divisions per cell', form.grid.subDivisionNumber, 2, 32, (v) => setGrid('subDivisionNumber', v))}
              {check('Display grid', form.grid.displayGrid, (v) => setGrid('displayGrid', v))}
              {check('Display sub-grid', form.grid.displaySubGrid, (v) => setGrid('displaySubGrid', v))}
              {check('Display cell index labels', form.grid.displayCellIndex, (v) => setGrid('displayCellIndex', v))}
              {color('Grid color', form.grid.gridArgb, (v) => setGrid('gridArgb', v))}
              {color('Sub-grid color', form.grid.subGridArgb, (v) => setGrid('subGridArgb', v))}
              {color('Cell index color', form.grid.cellIndexArgb, (v) => setGrid('cellIndexArgb', v))}
            </>
          )}

          {form.displayBrickElevation !== undefined &&
            check('Display brick elevation labels', form.displayBrickElevation, (v) => set('displayBrickElevation', v))}

          {form.areaCellSize !== undefined && (
            <>
              {number('Paint cell size', form.areaCellSize, 1, 256, (v) => set('areaCellSize', v), 'studs')}
              <p className="py-1 text-[11px] leading-snug text-muted">
                Changing cell size on a sheet with painted cells leaves existing cells at their old
                indexing — paint over to clean up.
              </p>
            </>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2 border-t border-border pt-4">
          <button onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs text-muted hover:bg-soft">
            Cancel
          </button>
          <button
            onClick={commit}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs text-accent-ink hover:bg-accent-hover"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
