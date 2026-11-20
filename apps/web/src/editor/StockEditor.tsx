// One engine or car being made or changed (trains design 2.3, 6.4). The
// simple form asks only for what a quick car needs: a number or name, its
// kind, its length and its color. More opens the rest: width, where the
// trucks sit, the couplers, power, the track it runs on, a part's picture
// for its top view, and notes. The desktop's ui/StockDialog.cpp is the twin.

import { useEffect, useMemo, useState } from 'react';
import { partStockLength, STOCK_KINDS, type RollingStock } from '@cld/parts-catalog/browser';
import type { PartWire } from '../api';
import { formatLength } from '../venues/designer/units';
import { useLengthUnit } from '../theme/PrefsProvider';
import { HelpButton } from '../help/HelpButton';
import { KIND_LABELS, withLength } from './trains';

interface Props {
  initial: RollingStock;
  isNew: boolean;
  /** Parts that can be a car's top view (two coupler connections). */
  parts: readonly PartWire[];
  onSave: (s: RollingStock) => void;
  onCancel: () => void;
}

const field = 'h-8 w-full rounded border border-border bg-bg px-2 text-sm';

/** Library parts that look like rolling stock: two magnet couplers. */
export function stockParts(parts: readonly PartWire[] | undefined): PartWire[] {
  return (parts ?? []).filter((p) => p.kind === 'leaf' && partStockLength(p.connections) !== null);
}

function Num({ label, value, onChange, min, max, step = 1, testId }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; step?: number; testId?: string }) {
  const [text, setText] = useState(String(value));
  // Follow changes made elsewhere (a picked part sets the length).
  useEffect(() => {
    setText((t) => (parseFloat(t) === value ? t : String(value)));
  }, [value]);
  return (
    <label className="block text-xs">
      <span className="text-muted">{label}</span>
      <input
        type="number"
        className={field}
        value={text}
        min={min}
        max={max}
        step={step}
        data-testid={testId}
        onChange={(e) => {
          setText(e.target.value);
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v) && v >= min && v <= max) onChange(v);
        }}
      />
    </label>
  );
}

export function StockEditor({ initial, isNew, parts, onSave, onCancel }: Props) {
  const unit = useLengthUnit();
  const [s, setS] = useState<RollingStock>(initial);
  const [more, setMore] = useState(false);
  const [partQuery, setPartQuery] = useState('');
  const set = (patch: Partial<RollingStock>) => setS((cur) => ({ ...cur, ...patch }));
  const sorted = [...s.trucks].sort((a, b) => b.at - a.at);
  const front = sorted[0]!;
  const rear = sorted[sorted.length - 1]!;
  const choices = useMemo(() => {
    const q = partQuery.trim().toLowerCase();
    const all = stockParts(parts);
    return (q ? all.filter((p) => `${p.partNumber} ${p.description}`.toLowerCase().includes(q)) : all).slice(0, 40);
  }, [parts, partQuery]);
  const valid = s.length > 0 && front.at > rear.at && Math.abs(front.at) <= s.length / 2 && Math.abs(rear.at) <= s.length / 2;

  return (
    <form
      className="flex flex-col gap-2 rounded-card border border-line bg-panel p-2"
      data-testid="stock-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSave(s);
      }}
    >
      <div className="flex items-center gap-1 font-semibold">
        {isNew ? 'New car' : 'Change car'}
        <HelpButton helpKey="trains.newStock" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-xs">
          <span className="text-muted">Number</span>
          <input className={field} value={s.number} onChange={(e) => set({ number: e.target.value })} placeholder="4021" aria-label="Road number" autoFocus />
        </label>
        <label className="block text-xs">
          <span className="text-muted">Name</span>
          <input className={field} value={s.name} onChange={(e) => set({ name: e.target.value })} placeholder="Boxcar" aria-label="Name" />
        </label>
        <label className="block text-xs">
          <span className="text-muted">Kind</span>
          <select className={field} value={s.kind} aria-label="Kind" onChange={(e) => {
            const kind = e.target.value as RollingStock['kind'];
            set({ kind, powered: kind === 'engine' || kind === 'unit' ? true : s.powered, trackKind: kind === 'monorail' ? 'monorail' : s.trackKind === 'monorail' ? 'rail' : s.trackKind });
          }}>
            {STOCK_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs">
          <span className="text-muted">Color</span>
          <input type="color" className="h-8 w-full rounded border border-border bg-bg" value={s.look.color} aria-label="Color" onChange={(e) => set({ look: { ...s.look, color: e.target.value } })} />
        </label>
      </div>
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Num label="Length (studs, coupler to coupler)" value={s.length} min={4} max={400} step={0.5} testId="stock-length" onChange={(v) => setS((cur) => withLength(cur, v))} />
        </div>
        {unit !== 'studs' && <span className="pb-2 text-xs text-muted">{formatLength(s.length, unit)}</span>}
      </div>
      <button type="button" className="self-start text-xs font-semibold text-accent hover:underline" aria-expanded={more} onClick={() => setMore(!more)} data-testid="stock-more">
        {more ? 'Fewer details' : 'More details'}
      </button>
      {more && (
        <div className="flex flex-col gap-2" data-testid="stock-more-fields">
          <div className="grid grid-cols-2 gap-2">
            <Num label="Width (studs)" value={s.width} min={1} max={20} step={0.5} onChange={(v) => set({ width: v })} />
            <Num label="Body length (studs)" value={s.bodyLength} min={1} max={400} step={0.5} onChange={(v) => set({ bodyLength: v })} />
          </div>
          <div className="flex items-center gap-1 text-xs font-semibold">
            Trucks <HelpButton helpKey="trains.trucks" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Num
              label="Front truck, studs ahead of the middle"
              value={front.at}
              min={0}
              max={s.length / 2}
              step={0.5}
              testId="stock-front-truck"
              onChange={(v) => set({ trucks: [{ ...front, at: v }, rear] })}
            />
            <Num
              label="Rear truck, studs behind the middle"
              value={-rear.at}
              min={0}
              max={s.length / 2}
              step={0.5}
              testId="stock-rear-truck"
              onChange={(v) => set({ trucks: [front, { ...rear, at: -v }] })}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            {(['front', 'rear'] as const).map((end) => (
              <label key={end} className="block text-xs">
                <span className="text-muted">{end === 'front' ? 'Front coupler' : 'Rear coupler'}</span>
                <select
                  className={field}
                  value={s.couplers[end].type}
                  onChange={(e) => set({ couplers: { ...s.couplers, [end]: { ...s.couplers[end], type: e.target.value as 'magnet' | 'none' | 'fixed' } } })}
                >
                  <option value="magnet">Magnet</option>
                  <option value="fixed">Fixed bar</option>
                  <option value="none">None</option>
                </select>
              </label>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={s.powered} onChange={(e) => set({ powered: e.target.checked })} />
              Has a motor
            </label>
            <label className="block text-xs">
              <span className="text-muted">Runs on</span>
              <select className={field} value={s.trackKind === 'monorail' ? 'monorail' : 'rail'} onChange={(e) => set({ trackKind: e.target.value })}>
                <option value="rail">Train track</option>
                <option value="monorail">Monorail</option>
              </select>
            </label>
          </div>
          <fieldset className="flex flex-col gap-1 text-xs">
            <legend className="text-muted">Seen from above as</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="look" checked={s.look.mode === 'simple'} onChange={() => set({ look: { ...s.look, mode: 'simple' } })} />A box in its color
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="look" checked={s.look.mode === 'part'} onChange={() => set({ look: { ...s.look, mode: 'part' } })} />A part’s picture
            </label>
          </fieldset>
          {s.look.mode === 'part' && (
            <div className="flex flex-col gap-1" data-testid="stock-part-picker">
              <input className={field} placeholder="Search train parts" aria-label="Search train parts" value={partQuery} onChange={(e) => setPartQuery(e.target.value)} />
              {choices.length === 0 ? (
                <p className="text-xs text-muted">No train parts match. Parts with a coupler at each end show here.</p>
              ) : (
                <ul className="max-h-40 overflow-y-auto rounded border border-border" aria-label="Train parts">
                  {choices.map((p) => (
                    <li key={p.key}>
                      <button
                        type="button"
                        aria-pressed={s.look.partKey === p.key}
                        className={`block w-full truncate px-2 py-1 text-left text-xs hover:bg-soft ${s.look.partKey === p.key ? 'bg-soft font-semibold' : ''}`}
                        onClick={() => {
                          const len = partStockLength(p.connections);
                          setS((cur) => {
                            const next = len ? withLength(cur, Math.round(len * 100) / 100) : cur;
                            return { ...next, look: { ...next.look, mode: 'part', partKey: p.key } };
                          });
                        }}
                      >
                        {p.partNumber} {p.description}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted">Picking a part sets the length from its couplers.</p>
            </div>
          )}
          <label className="block text-xs">
            <span className="text-muted">Notes</span>
            <textarea className="w-full rounded border border-border bg-bg px-2 py-1 text-sm" rows={2} value={s.notes} onChange={(e) => set({ notes: e.target.value })} />
          </label>
        </div>
      )}
      {!valid && <p className="text-xs text-red-700 dark:text-red-300">The front truck must be ahead of the rear one, and both within the car’s length.</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={!valid} data-testid="stock-save" className="h-8 rounded-control bg-accent px-3 text-xs font-bold text-accent-ink hover:bg-accent-hover disabled:opacity-50">
          {isNew ? 'Add car' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} className="h-8 rounded px-3 text-xs hover:bg-soft">
          Cancel
        </button>
      </div>
    </form>
  );
}
