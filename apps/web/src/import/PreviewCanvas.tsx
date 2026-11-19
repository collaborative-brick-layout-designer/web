// The import preview's picture over the stud grid, with zoom and pan as the
// desktop's preview has them (previewView.ts): the wheel or a trackpad pinch
// zooms towards the pointer, a drag pans, two fingers pinch on a touch
// screen, and −, +, Fit and 100% sit above it. Only the picture is scaled:
// the stud grid, the part's middle and the connection points are drawn as
// lines on the screen, so they stay sharp at every zoom. The arrow keys
// move the model against the grid, as the desktop's preview does.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HelpButton } from '../help/HelpButton';
import type { PreviewFrame } from './previewMath';
import { contentBox, fit, frameBox, toScreen, wheelFactor, zoomAt, zoomPercent, zoomTo, type View } from './previewView';

interface Props {
  src: string;
  frame: PreviewFrame;
  turns: number;
  pxPerStud: number;
  dropped: Set<number>;
  /** The arrow keys over the picture: move the model by this many studs. */
  onNudge: (dx: number, dy: number) => void;
  step: number;
}

const zoomBtn = 'tap-target min-w-9 rounded-lg border border-line bg-panel px-2 py-1 text-sm text-ink hover:bg-soft';

export function PreviewCanvas({ src, frame, turns, pxPerStud, dropped, onNudge, step }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View | null>(null);
  // Fitted until the person zooms or pans (the desktop's autoFit_).
  const autoFit = useRef(true);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pps = Math.max(1, pxPerStud);

  // The picture's room: it fills the space the dialog gives it.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      // jsdom and a hidden dialog have no size: a sensible stand-in.
      setSize({ w: r.width || 640, h: r.height || 400 });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const content = contentBox(frame);
  const contentKey = `${content.x},${content.y},${content.width},${content.height}`;
  // Fit while fitted; turning shows the whole turned model again.
  useEffect(() => {
    if (size.w === 0) return;
    if (autoFit.current || view === null) setView(fit(content, size.w, size.h));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refit on a new size or frame, not on every view change
  }, [size.w, size.h, contentKey]);
  const lastTurns = useRef(turns);
  useEffect(() => {
    if (lastTurns.current === turns) return;
    lastTurns.current = turns;
    autoFit.current = true;
    if (size.w) setView(fit(content, size.w, size.h));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a turn refits here
  }, [turns]);

  const userView = useCallback((next: (v: View) => View) => {
    autoFit.current = false;
    setView((v) => (v ? next(v) : v));
  }, []);

  // The wheel needs a listener that isn't passive, to keep the page still.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const f = wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey);
      userView((v) => zoomAt(v, f, e.clientX - r.left, e.clientY - r.top, pps));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [pps, userView]);

  function local(e: React.PointerEvent) {
    const r = box.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    box.current?.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, local(e));
  }
  function onPointerMove(e: React.PointerEvent) {
    const ps = pointers.current;
    const before = ps.get(e.pointerId);
    if (!before) return;
    const now = local(e);
    if (ps.size === 1) {
      userView((v) => ({ ...v, tx: v.tx + now.x - before.x, ty: v.ty + now.y - before.y }));
    } else if (ps.size === 2) {
      const other = [...ps.entries()].find(([id]) => id !== e.pointerId)![1];
      const d0 = Math.hypot(before.x - other.x, before.y - other.y);
      const d1 = Math.hypot(now.x - other.x, now.y - other.y);
      const mid0 = { x: (before.x + other.x) / 2, y: (before.y + other.y) / 2 };
      const mid1 = { x: (now.x + other.x) / 2, y: (now.y + other.y) / 2 };
      userView((v) => {
        const z = d0 > 0 ? zoomAt(v, d1 / d0, mid0.x, mid0.y, pps) : v;
        return { ...z, tx: z.tx + mid1.x - mid0.x, ty: z.ty + mid1.y - mid0.y };
      });
    }
    ps.set(e.pointerId, now);
  }
  function onPointerUp(e: React.PointerEvent) {
    pointers.current.delete(e.pointerId);
  }
  function onKeyDown(e: React.KeyboardEvent) {
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const a = arrows[e.key];
    if (a) {
      e.preventDefault();
      onNudge(a[0] * step, a[1] * step);
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      zoomBy(1.25);
    } else if (e.key === '-') {
      e.preventDefault();
      zoomBy(1 / 1.25);
    } else if (e.key === '0') {
      e.preventDefault();
      fitAll();
    }
  }
  function zoomBy(f: number) {
    userView((v) => zoomAt(v, f, size.w / 2, size.h / 2, pps));
  }
  function fitAll() {
    autoFit.current = true;
    setView(fit(content, size.w, size.h));
  }
  function actualSize() {
    userView((v) => zoomTo(v, pps, size.w, size.h, pps));
  }

  const v = view;
  const percent = v ? zoomPercent(v, pps) : 100;
  const fb = frameBox(frame);
  const frameTL = v ? toScreen(v, fb.x, fb.y) : { x: 0, y: 0 };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Zoom">
        <button type="button" className={zoomBtn} aria-label="Zoom out" title="Zoom out (or scroll down over the picture)" onClick={() => zoomBy(1 / 1.25)}>
          −
        </button>
        <span className="min-w-14 text-center tabular-nums text-muted" data-testid="import-zoom" aria-live="polite">
          {percent}%
        </span>
        <button type="button" className={zoomBtn} aria-label="Zoom in" title="Zoom in (or scroll up over the picture)" onClick={() => zoomBy(1.25)}>
          +
        </button>
        <button type="button" className={zoomBtn} title="Show the whole model" onClick={fitAll}>
          Fit
        </button>
        <button type="button" className={zoomBtn} title="One pixel of the picture to one pixel of the screen" onClick={actualSize}>
          100%
        </button>
        <HelpButton helpKey="import.zoom" />
      </div>
      <div
        ref={box}
        tabIndex={0}
        role="img"
        aria-label="The part, over the stud grid. Drag to move around, scroll or pinch to zoom, arrow keys move the model against the grid."
        data-testid="import-picture"
        data-zoom={percent}
        data-px-per-stud={v ? v.k.toFixed(3) : ''}
        data-grid-left={frameTL.x.toFixed(2)}
        data-grid-top={frameTL.y.toFixed(2)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        className="relative min-h-[45vh] flex-1 cursor-grab touch-none select-none overflow-hidden rounded-lg border border-line outline-none focus-visible:ring-2 focus-visible:ring-accent active:cursor-grabbing md:min-h-0"
        // A checkerboard behind the picture, so its see-through parts show (as the desktop's preview).
        style={{ background: 'repeating-conic-gradient(#dcdcdc 0% 25%, #ffffff 0% 50%) 0 0 / 16px 16px' }}
      >
        {v && <Drawing src={src} frame={frame} turns={turns} dropped={dropped} v={v} w={size.w} h={size.h} pps={pps} />}
      </div>
    </div>
  );
}

function Drawing({ src, frame, turns, dropped, v, w, h, pps }: { src: string; frame: PreviewFrame; turns: number; dropped: Set<number>; v: View; w: number; h: number; pps: number }) {
  // The picture as drawn (before turning) is imageStuds turned back.
  const odd = turns % 2 === 1;
  const iw = odd ? frame.imageStuds.height : frame.imageStuds.width;
  const ih = odd ? frame.imageStuds.width : frame.imageStuds.height;
  const turn =
    turns === 1 ? `translate(${ih} 0) rotate(90)` : turns === 2 ? `translate(${iw} ${ih}) rotate(180)` : turns === 3 ? `translate(0 ${iw}) rotate(270)` : '';

  // The stud grid, in screen pixels (only what's in view; every stud while
  // they're at least 4 px apart, else just the frame's edge).
  const fb = frameBox(frame);
  const a = toScreen(v, fb.x, fb.y);
  const b = toScreen(v, fb.x + fb.width, fb.y + fb.height);
  const lines: React.ReactNode[] = [];
  if (v.k >= 4) {
    const i0 = Math.max(1, Math.ceil(-a.x / v.k));
    const i1 = Math.min(frame.widthStuds - 1, Math.floor((w - a.x) / v.k));
    for (let i = i0; i <= i1; i++) {
      const x = a.x + i * v.k;
      lines.push(<line key={`x${i}`} x1={x} y1={Math.max(0, a.y)} x2={x} y2={Math.min(h, b.y)} />);
    }
    const j0 = Math.max(1, Math.ceil(-a.y / v.k));
    const j1 = Math.min(frame.heightStuds - 1, Math.floor((h - a.y) / v.k));
    for (let j = j0; j <= j1; j++) {
      const y = a.y + j * v.k;
      lines.push(<line key={`y${j}`} x1={Math.max(0, a.x)} y1={y} x2={Math.min(w, b.x)} y2={y} />);
    }
  }
  // The part's middle: where it's held when placed.
  const mid = toScreen(v, fb.x + fb.width / 2, fb.y + fb.height / 2);
  const zoom = v.k / pps;
  return (
    <svg width={w} height={h} className="absolute inset-0 block" aria-hidden>
      <g transform={`translate(${v.tx} ${v.ty}) scale(${v.k})`}>
        <image href={src} width={iw} height={ih} transform={turn} preserveAspectRatio="none" style={{ imageRendering: zoom >= 4 ? 'pixelated' : 'auto' }} />
      </g>
      <g stroke="rgba(0,120,255,0.45)" strokeWidth={1} shapeRendering="crispEdges" data-testid="import-grid">
        {lines}
        <rect x={a.x} y={a.y} width={b.x - a.x} height={b.y - a.y} fill="none" stroke="rgba(0,120,255,0.8)" />
      </g>
      <g stroke="rgb(0,120,255)" strokeWidth={1.5} data-testid="import-origin">
        <line x1={mid.x - 6} y1={mid.y} x2={mid.x + 6} y2={mid.y} />
        <line x1={mid.x} y1={mid.y - 6} x2={mid.x} y2={mid.y + 6} />
      </g>
      {frame.connections.map((c, i) => {
        const p = toScreen(v, c.x + frame.widthStuds / 2 + fb.x, c.y + frame.heightStuds / 2 + fb.y);
        const ang = (c.angle * Math.PI) / 180;
        const on = !dropped.has(i);
        // The desktop's marks: a ring 0.6 stud across, a line 2 studs out; never smaller than a finger can see.
        const r = Math.max(5, 0.6 * v.k);
        const len = Math.max(14, 2 * v.k);
        return (
          <g key={i} stroke={on ? 'rgb(220,30,30)' : 'rgb(140,140,140)'} strokeWidth={2} fill="none" strokeDasharray={on ? undefined : '4 3'} data-testid="import-connection-mark">
            <circle cx={p.x} cy={p.y} r={r} />
            <line x1={p.x} y1={p.y} x2={p.x + Math.cos(ang) * len} y2={p.y + Math.sin(ang) * len} />
          </g>
        );
      })}
    </svg>
  );
}
