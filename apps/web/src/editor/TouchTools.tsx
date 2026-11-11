// Measuring and painting areas by touch, on phones and tablets.
//
//  - The touch bar's Tools button opens a sheet: Measure a distance,
//    Measure a circle, Paint areas, Erase areas.
//  - A ruler: tap where it starts, tap where it ends (a circle: its middle,
//    then its edge). It's then picked, with round handles on its ends to
//    drag; Done in the bar finishes.
//  - Painting: one finger paints (or erases) the area squares it passes
//    over, a tap paints one; two fingers still move and zoom the map. The
//    bar says so, has the colors, Paint / Erase, and Done.
//
// While one of these is on, the touch bar is this bar (TouchDrawBar).

import { useEffect, useState } from 'react';
import { useEditorStore, type Tool } from './editorStore';

/** The tools a finger can draw with. */
export const TOUCH_DRAW_TOOLS: readonly Tool[] = ['rulerLinear', 'rulerCircular', 'paint', 'erase'];

export function isTouchDrawTool(tool: Tool): boolean {
  return TOUCH_DRAW_TOOLS.includes(tool);
}

const TOOLS: { tool: Tool; label: string; help: string }[] = [
  { tool: 'rulerLinear', label: 'Measure a distance', help: 'Tap where it starts, then where it ends.' },
  { tool: 'rulerCircular', label: 'Measure a circle', help: 'Tap the middle, then a point on its edge.' },
  { tool: 'paint', label: 'Paint areas', help: 'Drag a finger to color the floor under the layout.' },
  { tool: 'erase', label: 'Erase areas', help: 'Drag a finger to take the color off again.' },
];

/** The sheet the touch bar's Tools button opens. */
export function TouchToolsSheet({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(id);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const pick = (tool: Tool) => {
    const st = useEditorStore.getState();
    st.setSelection([]);
    useEditorStore.setState({ touchSelectMore: false, touchSelectArea: false });
    st.setTool(tool);
    onClose();
  };
  return (
    <div className="fixed inset-0 z-40" data-no-gesture>
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${open ? 'opacity-100' : 'opacity-0'}`}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Measure and paint"
        data-testid="touch-tools-sheet"
        className={`absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-2xl border-t border-line bg-panel text-ink shadow-pop transition-transform duration-200 ease-out ${open ? 'translate-y-0' : 'translate-y-full'}`}
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))', paddingLeft: 'env(safe-area-inset-left)', paddingRight: 'env(safe-area-inset-right)' }}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-line" aria-hidden />
        <div className="flex items-center gap-2 px-4 pt-2">
          <h2 className="min-w-0 flex-1 truncate text-lg font-bold">Measure and paint</h2>
          <button type="button" onClick={onClose} className="min-h-11 rounded-control px-4 text-sm font-bold hover:bg-soft">
            Close
          </button>
        </div>
        <ul className="flex flex-col gap-1 px-2 pt-1">
          {TOOLS.map((t) => (
            <li key={t.tool}>
              <button
                type="button"
                data-testid={`touch-tool-${t.tool}`}
                onClick={() => pick(t.tool)}
                className="flex min-h-14 w-full flex-col items-start justify-center rounded-control px-3 py-1 text-left hover:bg-soft"
              >
                <span className="text-base font-semibold">{t.label}</span>
                <span className="text-sm text-muted">{t.help}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Paint colors a finger can pick from (AARRGGBB, half see-through like the desktop's default). */
const SWATCHES: { name: string; argb: string }[] = [
  { name: 'Green', argb: '8000A000' },
  { name: 'Blue', argb: '800060FF' },
  { name: 'Gray', argb: '80808080' },
  { name: 'Brown', argb: '80A0522D' },
  { name: 'Yellow', argb: '80FFD000' },
  { name: 'Red', argb: '80E02020' },
];

/** The touch bar while measuring or painting: what to do, in words, and how to stop. */
export function TouchDrawBar() {
  const tool = useEditorStore((s) => s.tool);
  const started = useEditorStore((s) => !!s.touchRulerStart);
  const color = useEditorStore((s) => s.paintColor);
  const done = () => useEditorStore.getState().setTool('select');
  const ruler = tool === 'rulerLinear' || tool === 'rulerCircular';
  const words = ruler
    ? tool === 'rulerLinear'
      ? started ? 'Now tap where the ruler ends.' : 'Tap where the ruler starts.'
      : started ? 'Now tap a point on the circle’s edge.' : 'Tap the middle of the circle.'
    : tool === 'paint'
      ? 'Drag a finger to paint. Two fingers move the map.'
      : 'Drag a finger to erase. Two fingers move the map.';
  return (
    <div
      role="toolbar"
      aria-label={ruler ? 'Measuring' : 'Painting areas'}
      data-testid="touch-draw-bar"
      data-keep-clear
      className="absolute inset-x-0 bottom-0 z-10 border-t border-line bg-panel/95 px-2 pt-1 shadow-pop backdrop-blur"
      style={{ paddingLeft: 'max(0.5rem, env(safe-area-inset-left))', paddingRight: 'max(0.5rem, env(safe-area-inset-right))', paddingBottom: 'max(0.25rem, env(safe-area-inset-bottom))' }}
      data-no-gesture
    >
      <p role="status" className="px-1 pb-1 text-center text-sm font-semibold text-ink">{words}</p>
      {/* A phone on its side is short: the colors and the buttons share a row, so more of the map stays in view. */}
      <div className="flex flex-col [@media(max-height:480px)]:flex-row [@media(max-height:480px)]:items-center [@media(max-height:480px)]:justify-center [@media(max-height:480px)]:gap-4">
      {tool === 'paint' && (
        <div role="radiogroup" aria-label="Paint color" className="flex items-center justify-center gap-2 pb-1">
          {SWATCHES.map((s) => {
            const on = color.slice(-6).toUpperCase() === s.argb.slice(-6);
            return (
              <button
                key={s.name}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={s.name}
                title={s.name}
                onClick={() => useEditorStore.getState().setPaintColor(`${color.slice(0, 2) || '80'}${s.argb.slice(-6)}`.toUpperCase())}
                className={`size-9 shrink-0 rounded-full border-2 ${on ? 'border-ink ring-2 ring-accent' : 'border-line'}`}
                style={{ background: `#${s.argb.slice(-6)}` }}
              />
            );
          })}
        </div>
      )}
      <div className="flex items-center justify-center gap-2 pb-1">
        {!ruler && (
          <div role="radiogroup" aria-label="Paint or erase" className="flex rounded-control border border-line p-0.5">
            {(['paint', 'erase'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={tool === t}
                onClick={() => useEditorStore.getState().setTool(t)}
                className={`min-h-11 rounded-control px-4 text-sm font-bold ${tool === t ? 'bg-accent text-accent-ink' : 'text-ink hover:bg-soft'}`}
              >
                {t === 'paint' ? 'Paint' : 'Erase'}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={done}
          className="min-h-12 min-w-28 rounded-control bg-accent px-6 text-base font-bold text-accent-ink hover:bg-accent-hover"
        >
          {ruler ? 'Cancel' : 'Done'}
        </button>
      </div>
      </div>
    </div>
  );
}
