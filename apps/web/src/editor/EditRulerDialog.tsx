// Edit-Ruler properties dialog — port of `editRulerDialog`
// (EditDialogs.cpp:157-296). Surfaces every field on the ruler item:
//   - line color / thickness
//   - displayDistance / displayUnit / unit (combo)
//   - guideline color / thickness / dash pattern
//   - measure font (family, size, bold, italic) / measure font color
//   - linear-only: allowOffset / offsetDistance / Detach endpoint buttons
//   - circular-only: radius / Detach center button
//
// Commits via `editRulerItem` + `attachRulerEndpoint` mutations.

import { useState } from 'react';
import type * as Y from 'yjs';
import type {
  CircularRulerItem,
  ColorSpec,
  FontSpec,
  LinearRulerItem,
  RulerItem,
} from '@cld/model';
import { RULER_LIMITS, attachRulerEndpoint, editRulerItem } from './mutations';
import { ColorAlphaInput } from './ColorAlphaInput';
import { colorSpecToArgb } from './layerOptions';
import { HelpButton } from '../help/HelpButton';
import { useEscape } from './useEscape';

interface Props {
  item: RulerItem;
  layerId: string;
  doc: Y.Doc;
  onClose: () => void;
}

/** The distance's unit, in the words the desktop's ruler uses (EditDialogs.cpp). */
const RULER_UNITS = [
  { value: 0, label: 'Studs' },
  { value: 1, label: 'LDraw units (LDU)' },
  { value: 2, label: 'Straight tracks (16 studs)' },
  { value: 3, label: 'AFOL modules (96 studs)' },
  { value: 4, label: 'Meters' },
  { value: 5, label: 'Feet' },
];

export function EditRulerDialog({ item, layerId, doc, onClose }: Props) {
  useEscape(onClose);
  const [color, setColor] = useState<string>(colorSpecToArgb(item.color));
  const [lineThickness, setLineThickness] = useState(item.lineThickness);
  const [displayDistance, setDisplayDistance] = useState(item.displayDistance);
  const [displayUnit, setDisplayUnit] = useState(item.displayUnit);
  const [unit, setUnit] = useState(item.unit);
  const [guidelineColor, setGuidelineColor] = useState<string>(colorSpecToArgb(item.guidelineColor));
  const [guidelineThickness, setGuidelineThickness] = useState(item.guidelineThickness);
  const [dashCsv, setDashCsv] = useState(item.guidelineDashPattern.join(', '));
  const [fontFamily, setFontFamily] = useState(item.measureFont.family);
  const [fontSize, setFontSize] = useState(item.measureFont.size);
  const styleStr = (item.measureFont.style ?? '').toLowerCase();
  const [bold, setBold] = useState(styleStr.includes('bold'));
  const [italic, setItalic] = useState(styleStr.includes('italic'));
  const [fontColor, setFontColor] = useState<string>(colorSpecToArgb(item.measureFontColor));

  // Linear extras.
  const linear = item.kind === 'linear' ? (item as LinearRulerItem) : null;
  const [offsetDistance, setOffsetDistance] = useState(linear?.offsetDistance ?? 0);
  const [allowOffset, setAllowOffset] = useState(linear?.allowOffset ?? false);

  // Circular extras.
  const circular = item.kind === 'circular' ? (item as CircularRulerItem) : null;
  const [radius, setRadius] = useState(circular?.radius ?? 0);

  function commit() {
    const styleParts: string[] = [];
    if (bold) styleParts.push('Bold');
    if (italic) styleParts.push('Italic');
    const measureFont: FontSpec = {
      family: fontFamily,
      size: fontSize,
      style: styleParts.join(',') || 'Regular',
    };
    const dash = dashCsv
      .split(',')
      .map((s) => parseFloat(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    editRulerItem(doc, layerId, item.id, {
      color: colorOut(item.color, color),
      lineThickness,
      displayDistance,
      displayUnit,
      unit,
      guidelineColor: colorOut(item.guidelineColor, guidelineColor),
      guidelineThickness,
      guidelineDashPattern: dash,
      measureFont,
      measureFontColor: colorOut(item.measureFontColor, fontColor),
      ...(linear ? { offsetDistance, allowOffset } : {}),
      ...(circular ? { radius } : {}),
    });
    onClose();
  }

  function detachEndpoint(which: 0 | 1) {
    attachRulerEndpoint(doc, layerId, item.id, which, '');
  }

  return (
    <div
      role="dialog" aria-label="Ruler properties"
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-black/60"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-136 overflow-y-auto rounded-lg border border-line bg-panel p-5 shadow-xl"
      >
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">
            Edit {item.kind === 'linear' ? 'linear' : 'circular'} ruler
          </h2>
          <HelpButton helpKey="dialog.measure" />
        </div>

        <fieldset className="mt-4 space-y-2 rounded-lg border border-line p-3 text-sm">
          <legend className="px-1 text-xs uppercase tracking-wider text-muted">Line</legend>
          <Row label="Color">
            <ColorAlphaInput label="Line color" value={color} onChange={setColor} />
          </Row>
          <Row label="Thickness">
            <NumberField value={lineThickness} setValue={setLineThickness} step={0.5} min={RULER_LIMITS.lineThickness.min} max={RULER_LIMITS.lineThickness.max} />
          </Row>
        </fieldset>

        <fieldset className="mt-3 space-y-2 rounded-lg border border-line p-3 text-sm">
          <legend className="px-1 text-xs uppercase tracking-wider text-muted">Distance</legend>
          <Row label="Show distance">
            <input
              type="checkbox"
              checked={displayDistance}
              onChange={(e) => setDisplayDistance(e.target.checked)}
            />
          </Row>
          <Row label="Show unit">
            <input
              type="checkbox"
              checked={displayUnit}
              onChange={(e) => setDisplayUnit(e.target.checked)}
            />
          </Row>
          <Row label="Unit">
            <select
              value={unit}
              onChange={(e) => setUnit(parseInt(e.target.value, 10))}
              className="rounded-lg border border-border bg-soft px-2 py-1 text-xs"
            >
              {RULER_UNITS.map((u) => (
                <option key={u.value} value={u.value}>
                  {u.label}
                </option>
              ))}
            </select>
          </Row>
        </fieldset>

        <fieldset className="mt-3 space-y-2 rounded-lg border border-line p-3 text-sm">
          <legend className="px-1 text-xs uppercase tracking-wider text-muted">Label</legend>
          <Row label="Font">
            <input
              value={fontFamily}
              onChange={(e) => setFontFamily(e.target.value)}
              className="rounded-lg border border-border bg-soft px-2 py-1"
            />
          </Row>
          <Row label="Size">
            <NumberField value={fontSize} setValue={setFontSize} step={1} min={RULER_LIMITS.fontSize.min} max={RULER_LIMITS.fontSize.max} />
          </Row>
          <Row label="Style">
            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={bold} onChange={(e) => setBold(e.target.checked)} />
                Bold
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={italic} onChange={(e) => setItalic(e.target.checked)} />
                Italic
              </label>
            </div>
          </Row>
          <Row label="Color">
            <ColorAlphaInput label="Measure color" value={fontColor} onChange={setFontColor} />
          </Row>
        </fieldset>

        <fieldset className="mt-3 space-y-2 rounded-lg border border-line p-3 text-sm">
          <legend className="px-1 text-xs uppercase tracking-wider text-muted">Guidelines</legend>
          <Row label="Color">
            <ColorAlphaInput label="Guideline color" value={guidelineColor} onChange={setGuidelineColor} />
          </Row>
          <Row label="Thickness">
            <NumberField
              value={guidelineThickness}
              setValue={setGuidelineThickness}
              step={0.5}
              min={RULER_LIMITS.guidelineThickness.min}
              max={RULER_LIMITS.guidelineThickness.max}
            />
          </Row>
          <Row label="Dashes">
            <input
              aria-label="Dashes: dash and gap lengths in pixels, such as 4, 2 (empty for a solid line)"
              placeholder="4, 2"
              value={dashCsv}
              onChange={(e) => setDashCsv(e.target.value)}
              className="w-32 rounded-lg border border-border bg-soft px-2 py-1"
            />
          </Row>
        </fieldset>

        {linear && (
          <fieldset className="mt-3 space-y-2 rounded-lg border border-line p-3 text-sm">
            <legend className="px-1 text-xs uppercase tracking-wider text-muted">Linear</legend>
            <Row label="Allow offset">
              <input
                type="checkbox"
                checked={allowOffset}
                onChange={(e) => setAllowOffset(e.target.checked)}
              />
            </Row>
            <Row label="Offset (studs)">
              <NumberField value={offsetDistance} setValue={setOffsetDistance} step={0.5} min={-RULER_LIMITS.distance} max={RULER_LIMITS.distance} />
            </Row>
            <Row label="Start">
              <span className="text-xs text-muted">
                {linear.attachedBrick1Id ? 'Attached to a part' : 'Not attached'}
              </span>
              <button
                disabled={!linear.attachedBrick1Id}
                onClick={() => detachEndpoint(0)}
                className="rounded-lg border border-border px-2 py-0.5 text-xs hover:bg-soft disabled:opacity-30"
              >
                Detach
              </button>
            </Row>
            <Row label="End">
              <span className="text-xs text-muted">
                {linear.attachedBrick2Id ? 'Attached to a part' : 'Not attached'}
              </span>
              <button
                disabled={!linear.attachedBrick2Id}
                onClick={() => detachEndpoint(1)}
                className="rounded-lg border border-border px-2 py-0.5 text-xs hover:bg-soft disabled:opacity-30"
              >
                Detach
              </button>
            </Row>
          </fieldset>
        )}

        {circular && (
          <fieldset className="mt-3 space-y-2 rounded-lg border border-line p-3 text-sm">
            <legend className="px-1 text-xs uppercase tracking-wider text-muted">Circular</legend>
            <Row label="Radius (studs)">
              <NumberField value={radius} setValue={setRadius} step={0.5} min={0} max={RULER_LIMITS.distance} />
            </Row>
            <Row label="Center">
              <span className="text-xs text-muted">
                {circular.attachedBrickId ? 'Attached to a part' : 'Not attached'}
              </span>
              <button
                disabled={!circular.attachedBrickId}
                onClick={() => detachEndpoint(0)}
                className="rounded-lg border border-border px-2 py-0.5 text-xs hover:bg-soft disabled:opacity-30"
              >
                Detach
              </button>
            </Row>
          </fieldset>
        )}

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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <label className="w-32 text-xs text-muted">{label}</label>
      <div className="flex flex-1 items-center gap-2">{children}</div>
    </div>
  );
}

function NumberField({
  value,
  setValue,
  step,
  min,
  max,
}: {
  value: number;
  setValue: (v: number) => void;
  step: number;
  min?: number;
  max?: number;
}) {
  return (
    <input
      type="number"
      value={value}
      step={step}
      min={min}
      max={max}
      onChange={(e) => {
        const n = parseFloat(e.target.value);
        if (Number.isFinite(n)) setValue(n);
      }}
      className="w-24 rounded-lg border border-border bg-soft px-2 py-1"
    />
  );
}

/**
 * The color to write: the original when unchanged (so a known color
 * like "Black" stays named), else the edited `aarrggbb`, alpha included.
 */
function colorOut(original: ColorSpec, argb: string): ColorSpec {
  return argb === colorSpecToArgb(original) ? original : { kind: 'argb', argb };
}
