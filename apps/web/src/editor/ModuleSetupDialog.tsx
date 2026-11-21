// A module's table and power (@cld/modules setup.ts): what it stands on and
// how tall, and what it needs from the wall, for the layout's coordinator.
// Store and show only. Each change is saved at once: on a placed module in
// the layout (and for everyone else on it), or on a Module library module
// on the server. The desktop's ModuleSetupDialog is the same.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type * as Y from 'yjs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { VenueLengthUnit } from '@cld/bbm';
import { readSidecarFromDoc } from '@cld/ydoc';
import {
  MAX_OUTLETS,
  MAX_WATTS,
  PLUG_SIDES,
  TABLE_TYPES,
  setupOf,
  withPower,
  withTable,
  type ModulePower,
  type ModuleSetup,
  type ModuleTable,
  type PlugSide,
  type TableType,
} from '@cld/modules';
import { api, type ModuleSummary } from '../api';
import { HelpButton } from '../help/HelpButton';
import { useLengthUnit } from '../theme/PrefsProvider';
import { useYjsSnapshot } from './useYjsSnapshot';
import { updateSidecarModule } from './mutations';
import { formatHeight, parseHeightMm, PLUG_SIDE_LABEL, TABLE_TYPE_HINT, TABLE_TYPE_LABEL } from './moduleSetupText';

const UNIT_HINT: Record<VenueLengthUnit, string> = {
  ftin: 'In inches, like 30 3/4 or 32"',
  m: 'In centimeters, like 78 or 78.1 cm',
  studs: 'In studs, like 98',
};

/** The table and power of a placed module in this layout. */
export function PlacedModuleSetupDialog({ doc, moduleId, onClose }: { doc: Y.Doc; moduleId: string; onClose: () => void }) {
  // Follows the module as it changes, here or from someone else.
  useYjsSnapshot(doc);
  const sidecar = readSidecarFromDoc(doc);
  const unit = useLengthUnit();
  const mod = sidecar?.modules?.find((m) => m.id === moduleId) ?? null;
  useEffect(() => {
    if (!mod) onClose();
  }, [mod, onClose]);
  if (!mod) return null;
  return (
    <ModuleSetupDialog
      name={mod.name || '(module)'}
      setup={setupOf(mod) ?? {}}
      unit={unit}
      onChange={(next) => updateSidecarModule(doc, moduleId, (m) => withPower(withTable(m, next.table ?? null), next.power ?? null))}
      onClose={onClose}
    />
  );
}

/** The table and power of a Module library module (its owner or an editor changes them). */
export function LibraryModuleSetupDialog({ module, onClose }: { module: ModuleSummary; onClose: () => void }) {
  const unit = useLengthUnit();
  const qc = useQueryClient();
  const [setup, setSetup] = useState<ModuleSetup>(module.setup ?? {});
  const save = useMutation({
    mutationFn: (next: ModuleSetup) => api.modules.setSetup(module.id, next.table || next.power ? next : null),
    onSettled: () => qc.invalidateQueries({ queryKey: ['modules'] }),
  });
  return (
    <ModuleSetupDialog
      name={module.title}
      setup={setup}
      unit={unit}
      note="Saved in the Module library. Layouts get it when they add this module or update it from the Module library."
      error={save.isError ? 'Not saved. Check your connection and try again.' : null}
      onChange={(next) => {
        setSetup(next);
        save.mutate(next);
      }}
      onClose={onClose}
    />
  );
}

interface Props {
  name: string;
  setup: ModuleSetup;
  unit: VenueLengthUnit;
  note?: string;
  error?: string | null;
  onChange: (next: ModuleSetup) => void;
  onClose: () => void;
}

const FIELD = 'w-full rounded-lg border border-border bg-soft px-2 py-1 text-sm';

export function ModuleSetupDialog({ name, setup, unit, note, error, onChange, onClose }: Props) {
  const table = setup.table ?? null;
  const power = setup.power ?? null;
  const shownHeight = table?.heightMm !== undefined ? formatHeight(table.heightMm, unit) : '';
  const [height, setHeight] = useState(shownHeight);
  const [heightBad, setHeightBad] = useState(false);
  // Someone else's change (or an undo) shows here too.
  useEffect(() => {
    setHeight(shownHeight);
    setHeightBad(false);
  }, [shownHeight]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const setTable = (t: ModuleTable | null) => {
    const { table: _t, ...rest } = setup;
    onChange(t ? { ...rest, table: t } : rest);
  };
  const setPower = (p: ModulePower | null) => {
    const { power: _p, ...rest } = setup;
    onChange(p ? { ...rest, power: p } : rest);
  };

  function commitHeight() {
    if (!table) return;
    if (!height.trim()) {
      setHeightBad(false);
      if (table.heightMm !== undefined) {
        const { heightMm: _h, measuredTo: _m, ...rest } = table;
        setTable(rest);
      }
      return;
    }
    const mm = parseHeightMm(height, unit);
    setHeightBad(mm === null);
    if (mm !== null && mm !== table.heightMm) setTable({ ...table, heightMm: mm });
    else if (mm !== null) setHeight(shownHeight);
  }

  const num = (v: string, max: number, whole: boolean): number | undefined => {
    const n = Number(v);
    if (!v.trim() || !Number.isFinite(n) || n < 0) return undefined;
    return Math.min(max, whole ? Math.round(n) : n);
  };

  const powerChoice = !power ? '' : power.needed ? 'yes' : 'no';

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Table and power: ${name}`}
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div onClick={(e) => e.stopPropagation()} className="w-[24rem] max-w-full rounded-lg border border-line bg-panel p-5 shadow-xl">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold" title={name}>
            Table and power · {name}
          </h2>
          <HelpButton helpKey="dialog.moduleSetup" />
        </div>
        {note && <p className="mt-1 text-xs text-muted">{note}</p>}

        <fieldset className="mt-4 space-y-2">
          <legend className="text-xs font-semibold uppercase tracking-wider text-muted">Table</legend>
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-muted">Type</span>
            <select
              data-testid="setup-table-type"
              className={FIELD}
              value={table?.type ?? ''}
              onChange={(e) => {
                const type = e.target.value as TableType | '';
                setTable(type ? { ...(table ?? {}), type } : null);
              }}
            >
              <option value="">Not set</option>
              {TABLE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TABLE_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
            {table && <span className="mt-1 block text-xs text-muted">{TABLE_TYPE_HINT[table.type]}</span>}
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs text-muted">Height</span>
            <input
              data-testid="setup-height"
              className={FIELD}
              disabled={!table}
              value={height}
              placeholder={table ? UNIT_HINT[unit] : 'Pick a table type first'}
              aria-invalid={heightBad}
              onChange={(e) => setHeight(e.target.value)}
              onBlur={commitHeight}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitHeight();
              }}
            />
            {heightBad && (
              <span role="alert" className="mt-1 block text-xs text-danger">
                That isn’t a height we can read. {UNIT_HINT[unit]}.
              </span>
            )}
          </label>
          {table?.heightMm !== undefined && (
            <div className="flex gap-4 text-sm" role="radiogroup" aria-label="Measured to">
              <label className="flex items-center gap-1.5">
                <input type="radio" name="measuredTo" checked={table.measuredTo !== 'rail'} onChange={() => { const { measuredTo: _m, ...rest } = table; setTable(rest); }} />
                To the table top
              </label>
              <label className="flex items-center gap-1.5">
                <input type="radio" name="measuredTo" data-testid="setup-to-rail" checked={table.measuredTo === 'rail'} onChange={() => setTable({ ...table, measuredTo: 'rail' })} />
                To the top of the rails
              </label>
            </div>
          )}
        </fieldset>

        <fieldset className="mt-4 space-y-2">
          <legend className="text-xs font-semibold uppercase tracking-wider text-muted">Power</legend>
          <select
            data-testid="setup-power"
            aria-label="Power"
            className={FIELD}
            value={powerChoice}
            onChange={(e) => {
              const v = e.target.value;
              setPower(v === '' ? null : v === 'no' ? { needed: false } : { needed: true, outlets: power?.outlets ?? 1, ...(power?.watts !== undefined ? { watts: power.watts } : {}), ...(power?.plugSide ? { plugSide: power.plugSide } : {}) });
            }}
          >
            <option value="">Not set</option>
            <option value="no">Doesn’t need power</option>
            <option value="yes">Needs power</option>
          </select>
          {power?.needed && (
            <div className="grid grid-cols-3 gap-2">
              <label className="block text-sm">
                <span className="mb-1 block text-xs text-muted">Outlets</span>
                <input
                  data-testid="setup-outlets"
                  type="number"
                  min={0}
                  max={MAX_OUTLETS}
                  step={1}
                  className={FIELD}
                  value={power.outlets ?? 1}
                  onChange={(e) => {
                    const n = num(e.target.value, MAX_OUTLETS, true);
                    if (n !== undefined) setPower({ ...power, outlets: n });
                  }}
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-xs text-muted">About how many watts</span>
                <input
                  data-testid="setup-watts"
                  type="number"
                  min={0}
                  max={MAX_WATTS}
                  step={10}
                  className={FIELD}
                  value={power.watts ?? ''}
                  placeholder="Not known"
                  onChange={(e) => {
                    const n = num(e.target.value, MAX_WATTS, true);
                    const { watts: _w, ...rest } = power;
                    setPower(n === undefined ? rest : { ...power, watts: n });
                  }}
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-xs text-muted">Plug side</span>
                <select
                  data-testid="setup-plug-side"
                  className={FIELD}
                  value={power.plugSide ?? ''}
                  onChange={(e) => {
                    const side = e.target.value as PlugSide | '';
                    const { plugSide: _s, ...rest } = power;
                    setPower(side ? { ...power, plugSide: side } : rest);
                  }}
                >
                  <option value="">Not set</option>
                  {PLUG_SIDES.map((s) => (
                    <option key={s} value={s}>
                      {PLUG_SIDE_LABEL[s]}
                    </option>
                  ))}
                </select>
              </label>
              <p className="col-span-3 text-xs text-muted">Front is the side people watch from.</p>
            </div>
          )}
        </fieldset>

        {error && (
          <p role="alert" className="mt-3 text-xs text-danger">
            {error}
          </p>
        )}
        <div className="mt-5 flex items-center justify-between gap-2">
          <button
            type="button"
            disabled={!table && !power}
            onClick={() => onChange({})}
            className="rounded-lg border border-border px-3 py-1 text-sm hover:bg-soft disabled:cursor-default disabled:opacity-40"
          >
            Clear all
          </button>
          <button
            type="button"
            data-testid="setup-done"
            onClick={() => {
              commitHeight();
              onClose();
            }}
            className="rounded-lg bg-accent px-3 py-1 text-sm text-accent-ink hover:bg-accent-hover"
          >
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
