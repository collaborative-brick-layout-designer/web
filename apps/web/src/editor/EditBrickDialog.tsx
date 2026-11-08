// Per-brick properties dialog — port of `editBrickDialog`
// (EditDialogs.cpp:82-155). Fields:
//   - Part number (free text — empty keeps current)
//   - X / Y (studs, top-left of displayArea)
//   - Rotation (degrees)
//   - Altitude
//   - Active connection point # (clamped to part's free-conn count)

import { useState } from 'react';
import type { Brick } from '@cld/model';
import type * as Y from 'yjs';
import { editBrick } from './mutations';
import type { PartWire } from '../api';
import { useEscape } from './useEscape';

interface Props {
  brick: Brick;
  layerId: string;
  doc: Y.Doc;
  meta: PartWire | undefined;
  onClose: () => void;
}

export function EditBrickDialog({ brick, layerId, doc, meta, onClose }: Props) {
  useEscape(onClose);
  const [partNumber, setPartNumber] = useState(brick.partNumber);
  const [x, setX] = useState(brick.displayArea.x);
  const [y, setY] = useState(brick.displayArea.y);
  const [orientation, setOrientation] = useState(brick.orientation);
  const [altitude, setAltitude] = useState(brick.altitude);
  const nConn = meta?.connections.length ?? 0;
  const [activeConn, setActiveConn] = useState(
    Math.min(brick.activeConnectionPointIndex, Math.max(0, nConn - 1)),
  );

  function commit() {
    editBrick(doc, layerId, brick.id, {
      partNumber: partNumber || brick.partNumber,
      x,
      y,
      orientation,
      altitude,
      activeConnectionPointIndex: activeConn,
    });
    onClose();
  }

  return (
    <div
      role="dialog" aria-label="Part properties"
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-black/60"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-md rounded-lg border border-line bg-panel p-5 shadow-xl"
      >
        <h2 className="text-base font-semibold">Edit brick</h2>
        <p className="mt-1 text-xs text-muted">id {brick.id}</p>
        {meta?.designer && (
          // Credit for whoever built an imported model (desktop import dialog).
          <p className="mt-1 text-sm" data-testid="part-designer">
            Designed by{' '}
            {meta.designer.url ? (
              <a href={meta.designer.url} target="_blank" rel="noreferrer noopener" className="font-semibold text-accent-text underline">
                {meta.designer.name}
              </a>
            ) : (
              <span className="font-semibold">{meta.designer.name}</span>
            )}
          </p>
        )}
        <div className="mt-4 grid grid-cols-[10rem_1fr] gap-2 text-sm">
          <label className="self-center">Part:</label>
          <input
            value={partNumber}
            onChange={(e) => setPartNumber(e.target.value)}
            placeholder={brick.partNumber}
            className="rounded-lg border border-border bg-soft px-2 py-1"
          />
          <label className="self-center">X (studs):</label>
          <NumberField value={x} setValue={setX} step={0.5} />
          <label className="self-center">Y (studs):</label>
          <NumberField value={y} setValue={setY} step={0.5} />
          <label className="self-center">Angle (°):</label>
          <NumberField value={orientation} setValue={setOrientation} step={1} />
          <label className="self-center">Altitude:</label>
          <NumberField value={altitude} setValue={setAltitude} step={1} />
          <label className="self-center">Active conn #:</label>
          <NumberField
            value={activeConn}
            setValue={(v) => setActiveConn(Math.max(0, Math.min(nConn - 1, Math.round(v))))}
            step={1}
            disabled={nConn === 0}
          />
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1 text-sm hover:bg-soft"
          >
            Cancel
          </button>
          <button
            onClick={commit}
            className="rounded-lg bg-accent text-accent-ink px-3 py-1 text-sm hover:bg-accent-hover"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

function NumberField({
  value,
  setValue,
  step,
  disabled,
}: {
  value: number;
  setValue: (v: number) => void;
  step: number;
  disabled?: boolean;
}) {
  return (
    <input
      type="number"
      value={value}
      step={step}
      disabled={disabled}
      onChange={(e) => {
        const n = parseFloat(e.target.value);
        if (Number.isFinite(n)) setValue(n);
      }}
      className="rounded-lg border border-border bg-soft px-2 py-1 disabled:opacity-50"
    />
  );
}
