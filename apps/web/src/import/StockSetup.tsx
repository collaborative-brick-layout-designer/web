// Trains › Import a model…: where the model's trucks and couplers are
// (trains design 3.3, Phase 6). The model from above, front to the right,
// with a marker on each truck and coupler. The importer guessed them from
// the model's wheels, bogies and magnets; drag a marker (or type the
// number) to fix one before the car is made. The desktop's StockImportDialog
// draws the same.

import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import type { StockGuess } from '@cld/parts-catalog/browser';
import { HelpButton } from '../help/HelpButton';

export interface StockSetupValue {
  /** Coupler to coupler, studs. */
  length: number;
  width: number;
  bodyLength: number;
  /** [front, rear]: studs from the middle, + towards the front. */
  trucks: [number, number];
}

interface Props {
  /** The model's picture as imported (before any turn). */
  src: string;
  /** Clockwise quarter turns shown. */
  turns: number;
  /** The picture's size in studs once turned. */
  widthStuds: number;
  heightStuds: number;
  value: StockSetupValue;
  onChange: (v: StockSetupValue) => void;
  from: StockGuess['trucksFrom'];
  couplersFound: boolean;
}

const STEP = 0.25;
const snap = (v: number) => Math.round(v / STEP) * STEP;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** The words under the picture: what the guess came from. */
export function guessNote(from: StockGuess['trucksFrom'], couplersFound: boolean): string {
  const trucks =
    from === 'bogies'
      ? 'We found the trucks from the model’s bogies.'
      : from === 'wheels'
        ? 'We found the trucks from the model’s wheels.'
        : 'We couldn’t find wheels, so the trucks are a quarter of the way in from each end.';
  const couplers = couplersFound ? 'The couplers are its magnets.' : 'No magnets were found, so the couplers are just past each end.';
  return `${trucks} ${couplers} Drag a marker to fix it.`;
}

export function StockSetup({ src, turns, widthStuds, heightStuds, value, onChange, from, couplersFound }: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const dragging = useRef<'front' | 'rear' | 'coupler' | null>(null);
  const W = widthStuds;
  const H = heightStuds;
  // The picture as imported, before the turn.
  const odd = turns % 2 === 1;
  const w0 = odd ? H : W;
  const h0 = odd ? W : H;
  const pad = 3;
  const limit = W / 2 + pad - 0.5;
  const [front, rear] = value.trucks;
  const half = value.length / 2;

  const studX = (e: PointerEvent) => {
    const el = svg.current;
    const m = el?.getScreenCTM();
    if (!el || !m) return null;
    const p = el.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    return p.matrixTransform(m.inverse()).x;
  };
  const setMarker = (which: 'front' | 'rear' | 'coupler', x: number) => {
    const v = Math.max(-limit, Math.min(limit, snap(x)));
    if (which === 'front') onChange({ ...value, trucks: [v, rear] });
    else if (which === 'rear') onChange({ ...value, trucks: [front, v] });
    else {
      const length = Math.max(2, Math.abs(v) * 2);
      onChange({ ...value, length, bodyLength: Math.max(1, round2(length - 2)) });
    }
  };
  const down = (which: 'front' | 'rear' | 'coupler') => (e: PointerEvent) => {
    dragging.current = which;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const move = (e: PointerEvent) => {
    if (!dragging.current) return;
    const x = studX(e);
    if (x !== null) setMarker(dragging.current, x);
  };
  const up = () => {
    dragging.current = null;
  };
  const keys = (which: 'front' | 'rear' | 'coupler', at: number) => (e: KeyboardEvent) => {
    const step = e.shiftKey ? 1 : STEP;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') setMarker(which, at + step);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') setMarker(which, at - step);
    else return;
    e.preventDefault();
  };

  const truck = (which: 'front' | 'rear', at: number, label: string) => (
    <g
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuenow={at}
      aria-valuemin={-limit}
      aria-valuemax={limit}
      aria-valuetext={`${at} studs from the middle`}
      data-testid={`stock-truck-${which}`}
      className="cursor-ew-resize outline-none focus-visible:[&>circle]:stroke-accent"
      onPointerDown={down(which)}
      onKeyDown={keys(which, at)}
    >
      <line x1={at} x2={at} y1={-H / 2 - 1} y2={H / 2 + 1} stroke="#1F2937" strokeWidth={0.7} strokeLinecap="round" />
      <circle cx={at} cy={-H / 2 - 1.6} r={1} fill="#F59E0B" stroke="#1F2937" strokeWidth={0.25} />
      <text x={at} y={-H / 2 - 1.25} fontSize={1.1} textAnchor="middle" fill="#111827" fontWeight={700} style={{ pointerEvents: 'none' }}>
        {which === 'front' ? 'F' : 'R'}
      </text>
    </g>
  );
  const coupler = (x: number, which: 'front' | 'rear') => (
    <circle
      key={which}
      role="slider"
      tabIndex={0}
      aria-label={which === 'front' ? 'Front coupler' : 'Rear coupler'}
      aria-valuenow={x}
      aria-valuetext={`Couplers ${value.length} studs apart`}
      data-testid={`stock-coupler-${which}`}
      className="cursor-ew-resize"
      cx={x}
      cy={0}
      r={0.9}
      fill="#2563EB"
      stroke="white"
      strokeWidth={0.25}
      onPointerDown={down('coupler')}
      onKeyDown={keys('coupler', which === 'front' ? x : -x)}
    />
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-testid="stock-setup">
      <svg
        ref={svg}
        role="group"
        aria-label="The model from above, front to the right, with its trucks and couplers"
        className="min-h-48 w-full flex-1 touch-none select-none rounded-lg border border-line bg-[repeating-conic-gradient(#0000000d_0_25%,transparent_0_50%)] [background-size:16px_16px]"
        viewBox={`${-W / 2 - pad} ${-H / 2 - pad} ${W + 2 * pad} ${H + 2 * pad}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        {/* The track under it, for scale. */}
        <line x1={-W / 2 - pad} x2={W / 2 + pad} y1={0} y2={0} stroke="#9CA3AF" strokeWidth={0.2} strokeDasharray="1 0.6" />
        <image href={src} x={-w0 / 2} y={-h0 / 2} width={w0} height={h0} transform={`rotate(${(turns % 4) * 90})`} preserveAspectRatio="none" />
        <rect x={-value.bodyLength / 2} y={-value.width / 2} width={value.bodyLength} height={value.width} rx={0.6} fill="none" stroke="#2563EB" strokeWidth={0.2} strokeDasharray="0.8 0.5" />
        <line x1={-half} x2={half} y1={0} y2={0} stroke="#2563EB" strokeWidth={0.2} />
        {truck('rear', rear, 'Rear truck')}
        {truck('front', front, 'Front truck')}
        {coupler(half, 'front')}
        {coupler(-half, 'rear')}
        <text x={W / 2 + pad - 0.3} y={H / 2 + pad - 0.6} fontSize={1.2} textAnchor="end" fill="currentColor">
          Front →
        </text>
      </svg>
      <p className="flex items-start gap-1 text-muted" data-testid="stock-guess-note">
        {guessNote(from, couplersFound)} <HelpButton helpKey="trains.importModel" />
      </p>
    </div>
  );
}
