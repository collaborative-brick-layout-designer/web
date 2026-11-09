// Port of VenueDimensionsDialog.cpp — builds a venue polygon from a table of
// (length, angle, kind, label) segments. Angle convention: 0°=East, 90°=South,
// 180°=West, 270°=North (matches desktop). The polygon is closed automatically.

import { useState, type FormEvent } from 'react';
import type * as Y from 'yjs';
import { readSidecarFromDoc } from '@cld/ydoc';
import { setVenue } from './mutations';
import { venueAfterDraw } from './venueValidator';
import { useEscape } from './useEscape';

const STUDS_PER_FOOT = 38.09814081;
const STUDS_PER_INCH = STUDS_PER_FOOT / 12;

/** The lengths' units; 1 stud = 8 mm. */
export const VENUE_UNITS = [
  { id: 'ft', label: 'Feet (ft)', studs: STUDS_PER_FOOT },
  { id: 'in', label: 'Inches (in)', studs: STUDS_PER_INCH },
  { id: 'm', label: 'Meters (m)', studs: 125 },
  { id: 'cm', label: 'Centimeters (cm)', studs: 1.25 },
] as const;
export type VenueUnit = (typeof VENUE_UNITS)[number]['id'];

/** Studs in one `unit`. */
export function studsPerUnit(unit: VenueUnit): number {
  return VENUE_UNITS.find((u) => u.id === unit)!.studs;
}

const ANGLE_PRESETS = [
  { label: '→ East (0°)',   deg: 0   },
  { label: '↘ SE (45°)',    deg: 45  },
  { label: '↓ South (90°)', deg: 90  },
  { label: '↙ SW (135°)',   deg: 135 },
  { label: '← West (180°)', deg: 180 },
  { label: '↖ NW (225°)',   deg: 225 },
  { label: '↑ North (270°)',deg: 270 },
  { label: '↗ NE (315°)',   deg: 315 },
] as const;

const EDGE_KINDS = ['Wall', 'Door', 'Open'] as const;

interface Segment {
  length: string;
  angle: string;
  kind: 0 | 1 | 2;
  label: string;
}

interface Props {
  doc: Y.Doc;
  onClose: () => void;
}

const defaultSeg = (): Segment => ({ length: '10.00', angle: '→ East (0°)', kind: 0, label: '' });

function parseDeg(angle: string): number {
  const preset = ANGLE_PRESETS.find((p) => p.label === angle);
  if (preset) return preset.deg;
  const n = parseFloat(angle);
  return isNaN(n) ? 0 : n;
}

export function VenueDimensionsDialog({ doc, onClose }: Props) {
  useEscape(onClose);
  const [unit, setUnit] = useState<VenueUnit>('ft');
  const [error, setError] = useState('');
  const [originX, setOriginX] = useState('0.00');
  const [originY, setOriginY] = useState('0.00');
  const [segments, setSegments] = useState<Segment[]>([defaultSeg()]);
  const [showRectPreset, setShowRectPreset] = useState(false);
  const [rectW, setRectW] = useState('30.00');
  const [rectD, setRectD] = useState('20.00');

  const inputCls = 'rounded-lg border border-border bg-soft px-2 py-1 text-xs';
  const labelCls = 'text-xs text-muted';

  function patchSeg(i: number, patch: Partial<Segment>) {
    setSegments((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  function addSegment() {
    setSegments((prev) => [...prev, defaultSeg()]);
  }

  function removeLast() {
    setSegments((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }

  function applyRectPreset() {
    const w = parseFloat(rectW) || 0;
    const d = parseFloat(rectD) || 0;
    setSegments([
      { length: w.toFixed(2), angle: '→ East (0°)',   kind: 0, label: '' },
      { length: d.toFixed(2), angle: '↓ South (90°)', kind: 0, label: '' },
      { length: w.toFixed(2), angle: '← West (180°)', kind: 0, label: '' },
      { length: d.toFixed(2), angle: '↑ North (270°)',kind: 0, label: '' },
    ]);
    setShowRectPreset(false);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const perUnit = studsPerUnit(unit);
    const pts: { x: number; y: number }[] = [];
    const metas: { kind: 0 | 1 | 2; label: string }[] = [];

    let cx = (parseFloat(originX) || 0) * perUnit;
    let cy = (parseFloat(originY) || 0) * perUnit;
    pts.push({ x: cx, y: cy });

    for (const seg of segments) {
      const len = (parseFloat(seg.length) || 0) * perUnit;
      if (len <= 0) continue;
      const rad = (parseDeg(seg.angle) * Math.PI) / 180;
      cx += Math.cos(rad) * len;
      cy += Math.sin(rad) * len;
      pts.push({ x: cx, y: cy });
      metas.push({ kind: seg.kind, label: seg.label });
    }

    if (pts.length < 3) {
      setError('Add at least two walls longer than zero. The outline closes back to the start by itself.');
      return;
    }
    setError('');

    // Drop closing vertex if it coincides with the origin.
    const last = pts[pts.length - 1]!;
    const first = pts[0]!;
    if (Math.hypot(last.x - first.x, last.y - first.y) < 0.5) pts.pop();

    const next = venueAfterDraw(
      readSidecarFromDoc(doc)?.venue,
      'outline',
      pts,
      metas,
    );
    if (next) setVenue(doc, next);
    onClose();
  }

  return (
    <div role="dialog" aria-label="Draw venue outline by dimensions" aria-modal="true" className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4 overflow-y-auto">
      <form
        onSubmit={submit}
        className="w-full max-w-2xl space-y-4 rounded-lg border border-line bg-panel p-6 text-sm"
      >
        <h3 className="text-lg font-semibold">Draw Venue Outline by Dimensions</h3>
        <p className="text-xs text-muted">
          Each row adds a vertex at the given distance and angle from the previous point.
          Angle: 0°=East, 90°=South, 180°=West, 270°=North. The polygon closes automatically.
        </p>

        <div className="flex flex-wrap gap-3">
          <label className="flex items-center gap-1.5">
            <span className={labelCls}>Unit:</span>
            <select
              value={unit}
              onChange={(e) => setUnit(e.target.value as VenueUnit)}
              className={inputCls}
            >
              {VENUE_UNITS.map((u) => (
                <option key={u.id} value={u.id}>{u.label}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <span className={labelCls}>Start X ({unit}):</span>
            <input
              type="number"
              step="0.01"
              className={`${inputCls} w-24`}
              value={originX}
              onChange={(e) => setOriginX(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-1.5">
            <span className={labelCls}>Start Y ({unit}):</span>
            <input
              type="number"
              step="0.01"
              className={`${inputCls} w-24`}
              value={originY}
              onChange={(e) => setOriginY(e.target.value)}
            />
          </label>
        </div>

        <div className="overflow-auto rounded-lg border border-line">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th className="w-6 px-2 py-1">#</th>
                <th className="px-2 py-1">Length ({unit})</th>
                <th className="px-2 py-1">Angle (°)</th>
                <th className="px-2 py-1">Kind</th>
                <th className="px-2 py-1">Label</th>
              </tr>
            </thead>
            <tbody>
              {segments.map((seg, i) => (
                <tr key={i} className="border-b border-line">
                  <td className="px-2 py-1 text-muted">{i + 1}</td>
                  <td className="px-2 py-1">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={seg.length}
                      onChange={(e) => patchSeg(i, { length: e.target.value })}
                      className="w-24 rounded-lg border border-border bg-soft px-1 py-0.5"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <select
                      value={seg.angle}
                      onChange={(e) => patchSeg(i, { angle: e.target.value })}
                      className="rounded-lg border border-border bg-soft px-1 py-0.5"
                    >
                      {ANGLE_PRESETS.map((p) => (
                        <option key={p.label} value={p.label}>{p.label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1">
                    <select
                      value={seg.kind}
                      onChange={(e) => patchSeg(i, { kind: Number(e.target.value) as 0 | 1 | 2 })}
                      className="rounded-lg border border-border bg-soft px-1 py-0.5"
                    >
                      {EDGE_KINDS.map((k, v) => (
                        <option key={v} value={v}>{k}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-1">
                    <input
                      value={seg.label}
                      onChange={(e) => patchSeg(i, { label: e.target.value })}
                      className="w-full min-w-24 rounded-lg border border-border bg-soft px-1 py-0.5"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex gap-2">
          <button type="button" onClick={addSegment}
            className="rounded-lg border border-border px-3 py-1 text-xs hover:bg-soft">
            Add segment
          </button>
          <button type="button" onClick={removeLast}
            className="rounded-lg border border-border px-3 py-1 text-xs hover:bg-soft">
            Remove last
          </button>
          <button type="button" onClick={() => setShowRectPreset(true)}
            className="rounded-lg border border-border px-3 py-1 text-xs hover:bg-soft"
            title="Quickly fill four segments for a W × D rectangle">
            Rectangle preset…
          </button>
        </div>

        {showRectPreset && (
          <div className="rounded-lg border border-border bg-soft/60 p-3 space-y-2">
            <p className="text-xs font-semibold">Rectangle preset</p>
            <div className="flex flex-wrap gap-3">
              <label className="flex items-center gap-1.5 text-xs">
                Width (E-W, {unit}):
                <input type="number" min="0" step="0.01" value={rectW}
                  onChange={(e) => setRectW(e.target.value)}
                  className="w-20 rounded-lg border border-border bg-panel px-1 py-0.5" />
              </label>
              <label className="flex items-center gap-1.5 text-xs">
                Depth (N-S, {unit}):
                <input type="number" min="0" step="0.01" value={rectD}
                  onChange={(e) => setRectD(e.target.value)}
                  className="w-20 rounded-lg border border-border bg-panel px-1 py-0.5" />
              </label>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={applyRectPreset}
                className="rounded-lg bg-accent text-accent-ink px-3 py-1 text-xs hover:bg-accent-hover">Apply</button>
              <button type="button" onClick={() => setShowRectPreset(false)}
                className="rounded-lg border border-border px-3 py-1 text-xs hover:bg-soft">Cancel</button>
            </div>
          </div>
        )}

        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose}
            className="rounded-lg border border-border px-4 py-1.5 text-sm hover:bg-soft">
            Cancel
          </button>
          <button type="submit"
            className="rounded-lg bg-accent text-accent-ink px-4 py-1.5 text-sm hover:bg-accent-hover">
            OK
          </button>
        </div>
      </form>
    </div>
  );
}
