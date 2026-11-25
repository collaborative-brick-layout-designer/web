// The car picked on the map (Live Ops design 2.2, 2.3): which it is, what
// it is coupled to, its load, and the way off the track. It works the same
// with a finger as with a mouse; the desktop shows the same in a menu.

import { useEffect } from 'react';
import type * as Y from 'yjs';
import { loadOf, standingIn, type Load, type RollingStock, type TrackNetwork, type Train } from '@cld/parts-catalog/browser';
import { HelpButton } from '../help/HelpButton';
import { setLoad, takeCarOff } from './cuts';
import { useEditorStore } from './editorStore';
import { stockLabel } from './trains';

export const LOAD_LABELS: Record<Load, string> = { '': 'Doesn’t apply', empty: 'Empty', loaded: 'Loaded' };

export function CarBar({ doc, net, trains, stock, states }: { doc: Y.Doc; net: TrackNetwork; trains: readonly Train[]; stock: ReadonlyMap<string, RollingStock>; states: Readonly<Record<string, number>> }) {
  const car = useEditorStore((s) => s.pickedCar);
  const s = car ? stock.get(car) : undefined;
  const at = car ? standingIn(car, trains) : undefined;
  const close = () => useEditorStore.getState().setPickedCar(null);
  // Taken off the track (here, by someone else, or undone): nothing to show.
  const gone = !!car && (!s || !at);
  useEffect(() => {
    if (gone) useEditorStore.getState().setPickedCar(null);
  }, [gone]);
  useEffect(() => {
    if (!car) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [car]);
  if (!car || !s || !at) return null;
  const others = at.units.length - 1;
  return (
    <div role="group" aria-label={`Car ${stockLabel(s)}`} data-testid="car-bar" data-no-gesture className="pointer-events-auto absolute left-1/2 top-3 z-20 flex max-w-[calc(100%-24px)] -translate-x-1/2 flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-card border border-line bg-panel px-3 py-2 text-sm shadow-pop">
      <span className="font-semibold">{stockLabel(s)}</span>
      <span className="text-xs text-muted" data-testid="car-coupled">
        {others === 0 ? 'On its own' : others === 1 ? 'Coupled to 1 other' : `Coupled to ${others} others`}
      </span>
      <HelpButton helpKey="ops.cut" />
      <div role="radiogroup" aria-label="Load" className="flex items-center gap-1 text-xs">
        <span className="text-muted">Load</span>
        {(['', 'empty', 'loaded'] as const).map((l) => (
          <button key={l} type="button" role="radio" aria-checked={loadOf(s) === l} data-testid={`car-load-${l || 'none'}`} className={`h-9 rounded-control border px-2 ${loadOf(s) === l ? 'border-accent bg-accent text-accent-ink' : 'border-border hover:bg-soft'}`} onClick={() => setLoad(doc, s.id, l)}>
            {LOAD_LABELS[l]}
          </button>
        ))}
        <HelpButton helpKey="ops.load" />
      </div>
      <button type="button" className="h-9 rounded-control border border-border px-2 text-xs hover:bg-soft" data-testid="car-off" onClick={() => takeCarOff(doc, net, states, s.id)}>
        Take off the track
      </button>
      <button type="button" className="h-9 rounded px-2 text-xs hover:bg-soft" onClick={close}>
        Close
      </button>
    </div>
  );
}
