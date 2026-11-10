// The Venue Designer's right-hand panel: the selected part's fields (label,
// kind, sizes and position in the chosen unit, way up for stairs, amps and
// volts, estimated), or the venue's own when nothing is selected. Lengths
// are typed like anywhere else in the designer (12'6", 3.2m).

import { useEffect, useId, useState, type Dispatch, type ReactNode } from 'react';
import type { Venue, VenueObstacleKind } from '@cld/bbm';
import { venueOf, type Action, type DesignerState } from './designerState';
import { bbox, dist, estimateCount, polylineLength, resizeObstacle, roomSize, updatePart, type Pt, type Selection } from './model';
import { formatArea, formatLength, parseLength, type LengthUnit } from './units';
import { HelpButton } from '../../help/HelpButton';
import type { HelpKey } from '../../help/helpTexts';


const field = 'h-9 w-full rounded-md border border-neutral-600 bg-soft px-2.5 text-sm';
const label = 'flex flex-col gap-1 text-xs text-muted';
const heading = 'text-[11px] font-semibold uppercase tracking-wider text-muted';

/** A text box for a length: shows it in `unit`, applies what's typed on Enter or leaving the box. */
function LengthField({ name, studs, unit, onChange, help }: { name: string; studs: number; unit: LengthUnit; onChange: (studs: number) => void; help?: HelpKey }) {
  const id = useId();
  const shown = formatLength(studs, unit);
  const [text, setText] = useState(shown);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    setText(shown);
    setBad(false);
  }, [shown]);
  const apply = () => {
    if (text === shown) return;
    const v = parseLength(text, unit);
    if (v === null || v < 0) return setBad(true);
    onChange(v);
  };
  const input = (
    <input
      id={id}
      value={text}
      aria-invalid={bad}
      onChange={(e) => setText(e.target.value)}
      onBlur={apply}
      onKeyDown={(e) => {
        if (e.key === 'Enter') apply();
        if (e.key === 'Escape') e.currentTarget.blur();
      }}
      className={`${field} font-mono ${bad ? 'border-red-500' : ''}`}
    />
  );
  if (help) {
    // The "?" sits beside the name, outside the <label>, so it isn't part of the box's name.
    return (
      <div className={label}>
        <span className="flex items-center gap-1.5">
          <label htmlFor={id}>{name}</label>
          <HelpButton helpKey={help} target={`[id="${id}"]`} />
        </span>
        {input}
      </div>
    );
  }
  return (
    <label className={label}>
      {name}
      {input}
    </label>
  );
}

function TextField({ name, value, onChange, autoFocus }: { name: string; value: string; onChange: (s: string) => void; autoFocus?: boolean }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className={label}>
      {name}
      <input
        value={text}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== value && onChange(text)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && text !== value) onChange(text);
          if (e.key === 'Escape') e.currentTarget.blur();
        }}
        className={field}
      />
    </label>
  );
}

function Estimated({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm pointer-coarse:min-h-11">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      Estimated, not measured yet
    </label>
  );
}

const KIND_NAMES: Record<string, string> = { edge: 'Wall', obstacle: 'Obstacle', power: 'Power point', note: 'Note', dimension: 'Measurement' };
const OBSTACLE_KINDS: { value: VenueObstacleKind | ''; name: string }[] = [
  { value: 'column', name: 'Column' },
  { value: 'stairs', name: 'Stairs' },
  { value: 'elevator', name: 'Elevator' },
  { value: 'counter', name: 'Counter' },
  { value: 'railing', name: 'Railing' },
  { value: '', name: 'Other' },
];
const WAYS: { deg: number; name: string }[] = [
  { deg: 270, name: 'North' },
  { deg: 0, name: 'East' },
  { deg: 90, name: 'South' },
  { deg: 180, name: 'West' },
];

export function Inspector({ state, dispatch, extra }: { state: DesignerState; dispatch: Dispatch<Action>; extra?: ReactNode }) {
  const v = venueOf(state);
  const sel = state.selection;
  const set = (next: Venue) => dispatch({ type: 'edit', venue: next });
  const patch = (s: Selection, p: Record<string, unknown>) => set(updatePart(v, s, p));
  const unit = state.unit;

  let body: ReactNode;
  if (!sel) body = <VenueFields venue={v} unit={unit} set={set} />;
  else if (sel.kind === 'edge' && v.edges[sel.index]) {
    const e = v.edges[sel.index]!;
    const len = polylineLength(e.poly);
    const setLength = (want: number) => {
      // Stretch the last segment along its direction.
      const n = e.poly.length;
      const a = e.poly[n - 2]!, b = e.poly[n - 1]!;
      const seg = dist(a, b);
      if (seg < 0.001) return;
      const k = (seg + want - len) / seg;
      if (k <= 0) return;
      const end: Pt = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
      patch(sel, { poly: [...e.poly.slice(0, -1), end], ...(e.kind === 1 ? { doorWidthStuds: want } : {}) });
    };
    body = (
      <>
        <TextField name="Label" value={e.label} onChange={(t) => patch(sel, { label: t })} />
        <label className={label}>
          Kind
          <select value={e.kind} onChange={(ev) => patch(sel, { kind: Number(ev.target.value), doorWidthStuds: Number(ev.target.value) === 1 ? len : 0 })} className={field}>
            <option value={0}>Wall</option>
            <option value={1}>Door</option>
            <option value={2}>Opening</option>
          </select>
        </label>
        <LengthField name="Length" studs={len} unit={unit} onChange={setLength} />
        <Estimated on={!!e.estimated} onChange={(on) => patch(sel, { estimated: on })} />
      </>
    );
  } else if (sel.kind === 'obstacle' && v.obstacles[sel.index]) {
    const o = v.obstacles[sel.index]!;
    const b = bbox(o.poly);
    const move = (dx: number, dy: number) => patch(sel, { poly: o.poly.map((p) => ({ x: p.x + dx, y: p.y + dy })) });
    body = (
      <>
        <TextField name="Label" value={o.label} onChange={(t) => patch(sel, { label: t })} />
        <label className={label}>
          Kind
          <select
            value={o.kind ?? ''}
            onChange={(ev) => {
              const k = ev.target.value as VenueObstacleKind | '';
              patch(sel, { kind: k || undefined, upDegrees: k === 'stairs' ? (o.upDegrees ?? 270) : undefined });
            }}
            className={field}
          >
            {OBSTACLE_KINDS.map((k) => (
              <option key={k.name} value={k.value}>
                {k.name}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <LengthField name="Width" studs={b.x1 - b.x0} unit={unit} onChange={(w) => set(resizeObstacle(v, sel.index, w, b.y1 - b.y0))} />
          <LengthField name="Depth" studs={b.y1 - b.y0} unit={unit} onChange={(d) => set(resizeObstacle(v, sel.index, b.x1 - b.x0, d))} />
          <LengthField name="From the left (x)" studs={b.x0} unit={unit} onChange={(x) => move(x - b.x0, 0)} />
          <LengthField name="From the top (y)" studs={b.y0} unit={unit} onChange={(y) => move(0, y - b.y0)} />
        </div>
        {o.kind === 'stairs' && (
          <div className={label}>
            Way up
            <div className="grid grid-cols-4 gap-1.5">
              {WAYS.map((w) => (
                <button
                  key={w.deg}
                  type="button"
                  aria-pressed={o.upDegrees === w.deg}
                  onClick={() => patch(sel, { upDegrees: w.deg })}
                  className={`h-9 rounded-md border text-sm ${o.upDegrees === w.deg ? 'border-accent bg-accent-hover/20 text-blue-200' : 'border-neutral-600 hover:bg-soft'}`}
                >
                  {w.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </>
    );
  } else if (sel.kind === 'power' && v.power?.[sel.index]) {
    const p = v.power[sel.index]!;
    const num = (s: string) => (s.trim() === '' ? undefined : Math.max(0, Number(s)) || undefined);
    body = (
      <>
        <TextField name="Label" value={p.label ?? ''} onChange={(t) => patch(sel, { label: t || undefined })} />
        <div className={label}>
          Where
          <div className="grid grid-cols-2 gap-1.5">
            {(['wall', 'floor'] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={p.kind === k}
                onClick={() => patch(sel, { kind: k })}
                className={`h-9 rounded-md border text-sm ${p.kind === k ? 'border-accent bg-accent-hover/20 text-blue-200' : 'border-neutral-600 hover:bg-soft'}`}
              >
                {k === 'wall' ? 'Wall outlet' : 'Floor outlet'}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <TextField name="Amps" value={p.amps ? String(p.amps) : ''} onChange={(t) => patch(sel, { amps: num(t) })} />
          <TextField name="Volts" value={p.volts ? String(p.volts) : ''} onChange={(t) => patch(sel, { volts: num(t) })} />
        </div>
      </>
    );
  } else if (sel.kind === 'note' && v.notes?.[sel.index]) {
    const n = v.notes[sel.index]!;
    body = (
      <>
        <TextField name="Text" value={n.text} autoFocus={n.text === 'Note'} onChange={(t) => t.trim() && patch(sel, { text: t.trim() })} />
        <Estimated on={!!n.estimated} onChange={(on) => patch(sel, { estimated: on })} />
      </>
    );
  } else if (sel.kind === 'dimension' && v.dimensions?.[sel.index]) {
    const d = v.dimensions[sel.index]!;
    const measured = formatLength(dist(d.from, d.to), unit);
    body = (
      <>
        <TextField name="Label" value={d.label ?? ''} onChange={(t) => patch(sel, { label: t || undefined })} />
        <p className="text-sm text-muted">
          Measures <span className="font-mono text-ink">{measured}</span>
          {d.label !== measured && (
            <button type="button" onClick={() => patch(sel, { label: measured })} className="ml-2 text-accent-text hover:underline">
              Use as label
            </button>
          )}
        </p>
        <Estimated on={!!d.estimated} onChange={(on) => patch(sel, { estimated: on })} />
      </>
    );
  }

  return (
    <aside
      aria-label="Inspector"
      className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-l border-line bg-panel p-4 max-md:landscape:w-60 max-md:portrait:max-h-[40%] max-md:portrait:w-full max-md:portrait:border-l-0 max-md:portrait:border-t max-md:portrait:pb-[max(1rem,env(safe-area-inset-bottom))]"
    >
      <div>
        <div className={heading}>{sel ? 'Selected' : 'Venue'}</div>
        <div className="text-lg font-semibold">{sel ? KIND_NAMES[sel.kind] : v.name || 'Venue'}</div>
      </div>
      {body}
      {extra}
      {sel && (
        <div className="mt-auto flex gap-2">
          <button type="button" onClick={() => dispatch({ type: 'duplicate' })} className="h-9 flex-1 rounded-md border border-neutral-600 text-sm hover:bg-soft">
            Duplicate
          </button>
          <button type="button" onClick={() => dispatch({ type: 'delete' })} className="h-9 flex-1 rounded-md border border-red-800 text-sm text-red-300 hover:bg-red-950/40">
            Delete
          </button>
        </div>
      )}
    </aside>
  );
}

function VenueFields({ venue, unit, set }: { venue: Venue; unit: LengthUnit; set: (v: Venue) => void }) {
  const size = roomSize(venue);
  const est = estimateCount(venue);
  return (
    <>
      <TextField name="Name" value={venue.name} onChange={(t) => set({ ...venue, name: t.trim() || venue.name })} />
      <LengthField name="Minimum walkway" help="room.walkway" studs={venue.minWalkwayStuds} unit={unit} onChange={(w) => set({ ...venue, minWalkwayStuds: w })} />
      <div className="grid grid-cols-2 gap-2 text-sm">
        <span className="text-muted">Size</span>
        <span className="font-mono">{size ? `${formatLength(size.w, unit)} × ${formatLength(size.h, unit)}` : '—'}</span>
        <span className="text-muted">Floor area</span>
        <span className="font-mono">{size ? formatArea(size.area, unit) : '—'}</span>
        <span className="text-muted">Walls, doors, openings</span>
        <span className="font-mono">{venue.edges.length}</span>
        <span className="text-muted">Obstacles</span>
        <span className="font-mono">{venue.obstacles.length}</span>
        <span className="text-muted">Power points</span>
        <span className="font-mono">{venue.power?.length ?? 0}</span>
        <span className="flex items-center gap-1.5 text-muted">
          Still estimated
          <HelpButton helpKey="room.estimates" />
        </span>
        <span className={`font-mono ${est ? 'text-amber-300' : ''}`}>{est}</span>
      </div>
      <p className="text-xs text-muted">Pick a tool on the left to draw. Select something to edit it here.</p>
    </>
  );
}
