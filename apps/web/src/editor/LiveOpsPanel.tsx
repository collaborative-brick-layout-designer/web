// The Live Ops panel (Live Ops design 6): what each car does next. Cars:
// where each is and goes, its home, and Set aside. Waybills: each car's
// orders, by hand or made for every car at once. Jobs: one crew's work
// each, with its switch list, which follows every move. Cars that can't be
// routed are listed above, each with why. On a phone it's a bottom sheet.
// The desktop's ui/LiveOpsPanel.cpp is the twin.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type * as Y from 'yjs';
import {
  brokenStops, currentLeg, currentSlot, isEngine, JOB_KINDS, OPS_LIMITS, WAYBILL_SLOTS,
  type Job, type RollingStock, type TrackNetwork, type Waybill,
} from '@cld/parts-catalog/browser';
import { HelpButton } from '../help/HelpButton';
import { confirmDelete } from '../ui/ConfirmDialog';
import { LOAD_LABELS } from './CarBar';
import { showSpot } from './fitChecks';
import {
  addJob, addMadeWaybills, addStop, addWaybill, cantText, carName, giveWaybill, GONE_PLACE, JOB_KIND_HINT, JOB_KIND_LABEL, legText, moveJob, moveStop, placeName, previewWaybills,
  removeJob, removeStop, removeWaybill, restartWaybill, saveJob, saveWaybill, setCarOps, spotName, turnCar, type OpsView,
} from './ops';
import { openPlaces } from './places';
import { stockLabel } from './trains';

export type OpsTab = 'cars' | 'waybills' | 'jobs';

interface Props {
  doc: Y.Doc;
  net: TrackNetwork | null;
  states: Readonly<Record<string, number>>;
  view: OpsView;
  isViewer: boolean;
  /** Asked for from elsewhere (a car's bar): its tab, waybill or job. */
  open?: { tab?: OpsTab; waybill?: string; job?: string; n: number } | null;
  onTrains: () => void;
  touch?: boolean;
  /** On a phone: showing something on the map closes the sheet. */
  onShown?: () => void;
}

const btn = 'rounded border border-border px-2 py-1 text-xs hover:bg-soft disabled:opacity-50';
const primary = 'h-9 rounded-control bg-accent px-3 text-xs font-bold text-accent-ink hover:bg-accent-hover disabled:opacity-50';
const field = 'w-full rounded border border-border bg-bg px-2 py-1 text-sm font-normal disabled:opacity-70';
const card = 'rounded-card border border-line bg-panel p-2';
const label = 'flex flex-col gap-0.5 text-xs font-semibold';

export function LiveOpsPanel(props: Props) {
  const { view, isViewer, open, touch = false, doc, onTrains } = props;
  const [tab, setTab] = useState<OpsTab>('cars');
  const [waybill, setWaybill] = useState<string | null>(null);
  const [job, setJob] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    if (open.tab) setTab(open.tab);
    if (open.waybill) {
      setTab('waybills');
      setWaybill(open.waybill);
    }
    if (open.job) {
      setTab('jobs');
      setJob(open.job);
    }
  }, [open]);
  const w = waybill ? view.waybills.get(waybill) : undefined;
  const j = job ? view.jobs.find((x) => x.id === job) : undefined;
  const cars = useMemo(() => [...view.stock.values()].filter((s) => !isEngine(s)).sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }) || stockLabel(a).localeCompare(stockLabel(b))), [view.stock]);
  const show = (car: string) => {
    const p = view.points.get(car);
    if (!p) return;
    showSpot(p);
    props.onShown?.();
  };
  const openWaybill = (id: string) => {
    setTab('waybills');
    setWaybill(id);
  };
  const tabs: [OpsTab, string][] = [['cars', 'Cars'], ['waybills', 'Waybills'], ['jobs', 'Jobs']];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 text-sm" data-testid="ops-panel">
      <div role="tablist" aria-label="Live Ops" className="flex gap-1">
        {tabs.map(([id, text]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} data-testid={`ops-tab-${id}`} onClick={() => {
            // (A tab opens on its list, as on the desktop.)
            setTab(id);
            setWaybill(null);
            setJob(null);
          }} className={`flex-1 rounded-control px-2 text-xs font-semibold ${touch ? 'h-11' : 'h-8'} ${tab === id ? 'bg-accent text-accent-ink' : 'bg-soft hover:bg-line'}`}>
            {text}
          </button>
        ))}
      </div>
      {view.places.length === 0 ? (
        <Nothing text="Cars go to places: industries, yards, staging and interchanges. There are none on this layout yet." button={isViewer ? null : 'Open Places'} onClick={() => openPlaces({ module: null })} />
      ) : cars.length === 0 ? (
        <Nothing text="There are no cars on this layout yet." button={isViewer ? null : 'Open Trains'} onClick={onTrains} />
      ) : (
        <>
          <CantRoute view={view} show={show} openWaybill={openWaybill} />
          {tab === 'cars' && <Cars {...props} cars={cars} show={show} openWaybill={openWaybill} />}
          {tab === 'waybills' && (w ? <WaybillEditor key={w.id} {...props} w={w} cars={cars} onBack={() => setWaybill(null)} /> : <Waybills {...props} cars={cars} onOpen={setWaybill} />)}
          {tab === 'jobs' && (j ? <JobEditor key={j.id} {...props} job={j} show={show} onBack={() => setJob(null)} /> : <Jobs view={view} isViewer={isViewer} doc={doc} touch={touch} onOpen={setJob} />)}
        </>
      )}
    </div>
  );
}

function Nothing({ text, button, onClick }: { text: string; button: string | null; onClick: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2 text-muted" data-testid="ops-nothing">
      <p>{text}</p>
      {button && (
        <button type="button" className={primary} onClick={onClick}>
          {button}
        </button>
      )}
    </div>
  );
}

function CantRoute({ view, show, openWaybill }: { view: OpsView; show: (car: string) => void; openWaybill: (id: string) => void }) {
  const list = view.routing.cantRoute;
  if (list.length === 0) return null;
  return (
    <section aria-label="Can’t route" data-testid="ops-cant" className="rounded-card border border-amber-500/60 bg-amber-50 p-2 dark:bg-amber-950/40">
      <h3 className="flex items-center gap-1 text-xs font-semibold">
        Can’t route ({list.length}) <HelpButton helpKey="ops.cantRoute" />
      </h3>
      <ul className="mt-1 flex max-h-48 flex-col gap-1 overflow-y-auto text-xs">
        {list.map((c) => (
          <li key={c.car} data-car={c.car} className="flex flex-wrap items-center gap-1">
            <span className="min-w-0 flex-1">
              <b>{carName(view, c.car)}</b>: {cantText(view, c)}
            </span>
            {view.points.has(c.car) && (
              <button type="button" className={btn} onClick={() => show(c.car)}>
                Show me
              </button>
            )}
            {view.pockets.has(c.car) && (
              <button type="button" className={btn} onClick={() => openWaybill(view.pockets.get(c.car)!.id)}>
                Waybill
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PlaceSelect({ view, value, onChange, none, disabled, name, only, testid }: { view: OpsView; value: string; onChange: (v: string) => void; none: string; disabled?: boolean; name?: string; only?: (id: string) => boolean; testid?: string }) {
  return (
    <select aria-label={name} value={value} disabled={disabled} data-testid={testid} className={field} onChange={(e) => onChange(e.target.value)}>
      <option value="">{none}</option>
      {value && !view.placeById.has(value) && <option value={value}>{GONE_PLACE}</option>}
      {view.places.filter((p) => p.id === value || !only || only(p.id)).map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

/** Where a car goes and who takes it: "Loaded to Mill, with Cannery Turn". */
function nextText(view: OpsView, car: string): string {
  const to = view.to.get(car);
  if (!to) return 'Nowhere to go: it stays.';
  const leg = to.why === 'waybill' ? currentLeg(view.pockets.get(car)!) : null;
  const text = leg ? legText(view, leg) : `Home to ${placeName(view, to.place)}`;
  const r = view.routing.cars.get(car);
  if (!r) return view.routing.arrived.includes(car) ? `${text}: it’s there` : text;
  const job = view.jobs.find((j) => j.id === r.job)?.name || 'a job';
  return r.jobs > 1 ? `${text}, with ${job} first` : `${text}, with ${job}`;
}

/** Delivered: the waybill turns. A place off the layout takes the car off the track. */
function Delivered({ doc, net, states, view, car, touch }: Pick<Props, 'doc' | 'net' | 'states' | 'view' | 'touch'> & { car: string }) {
  const w = view.pockets.get(car);
  if (!w || currentSlot(w) === 0) return null;
  const to = view.to.get(car);
  const place = to ? view.placeById.get(to.place) : undefined;
  const leaves = !!place && place.place.spots.length === 0;
  return (
    <button type="button" data-testid="ops-delivered" className={btn + (touch ? ' min-h-11' : '')} title="The waybill turns to its next leg, and the load with it." onClick={() => turnCar(doc, car, leaves ? { place: place.id, net, states } : undefined)}>
      {leaves && !view.routing.arrived.includes(car) ? 'It has left the layout' : 'Delivered'}
    </button>
  );
}

function Cars({ doc, net, states, view, isViewer, cars, show, openWaybill, touch = false }: Props & { cars: readonly RollingStock[]; show: (car: string) => void; openWaybill: (id: string) => void }) {
  const arrived = new Set(view.routing.arrived);
  const off = view.places.filter((p) => p.place.spots.length === 0);
  return (
    <ul className="flex flex-col gap-1.5" aria-label="Cars">
      {cars.map((s) => {
        const at = view.at.get(s.id);
        const w = view.pockets.get(s.id);
        const onTrack = view.trains.some((t) => t.position && t.units.some((u) => u.stock === s.id));
        return (
          <li key={s.id} data-car={s.id} className={card}>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-semibold">{stockLabel(s)}</span>
              {s.type && <span className="text-xs text-muted">{s.type}</span>}
              {view.points.has(s.id) && (
                <button type="button" className={btn} onClick={() => show(s.id)}>
                  Show me
                </button>
              )}
            </div>
            <p className="text-xs text-muted">
              <span data-testid="ops-car-at">{at ? `At ${spotName(view, at.place, at.spot)}` : onTrack ? 'On the track, at no place' : 'Not on the track'}</span>
              {' · '}
              <span data-testid="ops-car-next">{nextText(view, s.id)}</span>
            </p>
            <div className="mt-1 flex flex-wrap items-end gap-2">
              {!isViewer && arrived.has(s.id) && <Delivered doc={doc} net={net} states={states} view={view} car={s.id} touch={touch} />}
              {w ? (
                <button type="button" className={btn} onClick={() => openWaybill(w.id)}>
                  Waybill
                </button>
              ) : (
                !isViewer && (
                  <button
                    type="button"
                    className={btn}
                    data-testid="ops-car-waybill"
                    disabled={view.waybills.size >= OPS_LIMITS.waybills}
                    onClick={() => {
                      const id = addWaybill(doc, s.id);
                      if (id) openWaybill(id);
                    }}
                  >
                    New waybill
                  </button>
                )
              )}
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={s.opsHold === true} disabled={isViewer} data-testid="ops-hold" onChange={(e) => setCarOps(doc, s.id, { opsHold: e.target.checked })} />
                Set aside
              </label>
              <HelpButton helpKey="ops.hold" />
            </div>
            <div className="mt-1 grid grid-cols-2 gap-2">
              <label className={label}>
                Home
                <PlaceSelect view={view} value={s.opsHome ?? ''} none="None" disabled={isViewer} testid="ops-home" onChange={(v) => setCarOps(doc, s.id, { opsHome: v })} />
              </label>
              {!onTrack && (off.length > 0 || s.opsAt) && (
                <label className={label}>
                  Where it is
                  <PlaceSelect view={view} value={s.opsAt ?? ''} none="Nowhere" disabled={isViewer} testid="ops-at" only={(id) => off.some((p) => p.id === id)} onChange={(v) => setCarOps(doc, s.id, { opsAt: v })} />
                </label>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Waybills({ doc, view, isViewer, cars, onOpen, touch = false }: Props & { cars: readonly RollingStock[]; onOpen: (id: string) => void }) {
  const [making, setMaking] = useState(false);
  const holder = new Map([...view.pockets].map(([car, w]) => [w.id, car]));
  const list = [...view.waybills.values()].sort((a, b) => Number(holder.has(b.id)) - Number(holder.has(a.id)) || carName(view, holder.get(a.id) ?? '').localeCompare(carName(view, holder.get(b.id) ?? ''), undefined, { numeric: true }) || (a.id < b.id ? -1 : 1));
  const full = view.waybills.size >= OPS_LIMITS.waybills;
  return (
    <>
      {!isViewer && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={primary} data-testid="ops-make" disabled={full || making} onClick={() => setMaking(true)}>
            Make waybills…
          </button>
          <button
            type="button"
            className={btn}
            data-testid="ops-new-waybill"
            disabled={full}
            onClick={() => {
              const id = addWaybill(doc);
              if (id) onOpen(id);
            }}
          >
            New waybill
          </button>
          <HelpButton helpKey="ops.waybill" />
        </div>
      )}
      {making && !isViewer && <MakeWaybills doc={doc} view={view} cars={cars} onDone={() => setMaking(false)} />}
      {list.length === 0 && !making && <p className="text-muted">No waybills yet. A waybill says where a car goes next: make one for every car at once, or write one.</p>}
      <ul className="flex flex-col gap-1.5" aria-label="Waybills">
        {list.map((w) => {
          const car = holder.get(w.id);
          const leg = currentLeg(w);
          return (
            <li key={w.id} data-waybill={w.id} className={card}>
              <button type="button" className={'block w-full truncate text-left font-semibold hover:underline' + (touch ? ' min-h-11' : '')} onClick={() => onOpen(w.id)}>
                {car ? carName(view, car) : 'Waiting for a car'}
              </button>
              <p className="text-xs text-muted">{leg ? (car ? nextText(view, car) : legText(view, leg)) : w.legs.some(Boolean) ? 'Finished' : 'No legs yet'}</p>
            </li>
          );
        })}
      </ul>
    </>
  );
}

const newSeed = () => Math.floor(Math.random() * 4294967296);

function MakeWaybills({ doc, view, cars, onDone }: { doc: Y.Doc; view: OpsView; cars: readonly RollingStock[]; onDone: () => void }) {
  const [seed, setSeed] = useState(newSeed);
  const made = useMemo(() => previewWaybills(view, seed), [view, seed]);
  const without = (why: string) => made.skipped.filter((s) => s.why === why).length;
  const n = (k: number) => (k === 1 ? '1 car' : `${k} cars`);
  const skipped = [
    without('noType') ? `${n(without('noType'))} without a type (set it in Trains).` : '',
    without('noPlaces') ? `${n(without('noPlaces'))} no two places send out and take in (set what each place sends out and takes in).` : '',
    without('full') ? `${n(without('full'))} with no room left at the places they’d go to.` : '',
  ].filter(Boolean);
  return (
    <section aria-label="Make waybills" data-testid="ops-making" className={card + ' flex flex-col gap-2'}>
      <h3 className="flex items-center gap-1 font-semibold">
        Make waybills <HelpButton helpKey="ops.make" />
      </h3>
      {made.made.length === 0 ? (
        <p className="text-xs text-muted">{made.skipped.length === 0 ? (cars.some((s) => s.opsHold === true) ? 'Every car that isn’t set aside has a waybill.' : 'Every car has a waybill.') : 'No car can get one:'}</p>
      ) : (
        <ul className="max-h-56 overflow-y-auto text-xs" aria-label="Waybills to make">
          {made.made.map((m) => (
            <li key={m.car}>
              <b>{carName(view, m.car)}</b>: {m.legs.map((l) => legText(view, l)).join(', then ')}
            </li>
          ))}
        </ul>
      )}
      {skipped.length > 0 && (
        <ul className="text-xs text-muted" data-testid="ops-skipped">
          {made.made.length > 0 && <li>Left without:</li>}
          {skipped.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={primary}
          data-testid="ops-make-add"
          disabled={made.made.length === 0}
          onClick={() => {
            addMadeWaybills(doc, made);
            onDone();
          }}
        >
          {made.made.length === 1 ? 'Add 1 waybill' : `Add ${made.made.length} waybills`}
        </button>
        <button type="button" className={btn} data-testid="ops-shuffle" disabled={made.made.length === 0} onClick={() => setSeed(newSeed())}>
          Shuffle
        </button>
        {without('noPlaces') > 0 && (
          <button type="button" className={btn} onClick={() => openPlaces({ module: null })}>
            Open Places
          </button>
        )}
        <button type="button" className={btn} onClick={onDone}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/** Text saved when left (or on Enter): one undo step, and someone else's change shows at once. */
function TextField({ name, value, max, disabled, onSave, testid, required = false }: { name: string; value: string; max: number; disabled: boolean; onSave: (v: string) => void; testid?: string; required?: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const save = () => {
    const v = draft.trim();
    if (v === value || (required && !v)) setDraft(value);
    else onSave(v);
  };
  return (
    <input
      aria-label={name}
      value={draft}
      maxLength={max}
      readOnly={disabled}
      data-testid={testid}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') save();
        else if (e.key === 'Escape') setDraft(value);
        if (e.key === 'Enter' || e.key === 'Escape') e.stopPropagation();
      }}
      className={field}
    />
  );
}

function Head({ text, onBack, touch, children }: { text: string; onBack: () => void; touch: boolean; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <button type="button" className={btn + (touch ? ' min-h-11' : '')} data-testid="ops-back" onClick={onBack}>
        ← {text}
      </button>
      {children}
    </div>
  );
}

function WaybillEditor({ doc, net, states, view, isViewer, w, cars, onBack, touch = false }: Props & { w: Waybill; cars: readonly RollingStock[]; onBack: () => void }) {
  const car = [...view.pockets].find(([, x]) => x.id === w.id)?.[0] ?? '';
  const slot = currentSlot(w);
  const save = (fields: Record<string, unknown>) => saveWaybill(doc, w.id, fields);
  return (
    <div className="flex flex-col gap-2" data-testid="ops-waybill">
      <Head text="All waybills" onBack={onBack} touch={touch}>
        <HelpButton helpKey="ops.waybill" />
      </Head>
      <label className={label}>
        Car
        <select value={car} disabled={isViewer} data-testid="ops-waybill-car" className={field} onChange={(e) => giveWaybill(doc, w.id, e.target.value)}>
          <option value="">Waiting for a car</option>
          {cars.map((s) => (
            <option key={s.id} value={s.id}>
              {stockLabel(s)}
              {view.pockets.has(s.id) && s.id !== car ? ' (has a waybill)' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className={label}>
        From
        <PlaceSelect view={view} value={w.from} none="Not said" disabled={isViewer} onChange={(from) => save({ from })} />
      </label>
      <ol className="flex flex-col gap-1.5" aria-label="Legs">
        {Array.from({ length: WAYBILL_SLOTS }, (_, i) => i + 1).map((k) => {
          const l = w.legs[k - 1] ?? null;
          const spots = l ? (view.placeById.get(l.to)?.place.spots ?? []) : [];
          const spotGone = !!l && l.spot !== '' && !spots.some((s) => s.id === l.spot);
          return (
            <li key={k} data-slot={k} className={card + (slot === k ? ' border-accent' : '')}>
              <div className="flex items-center gap-2 text-xs font-semibold">
                <label className="flex items-center gap-1">
                  <input type="radio" name={`leg-${w.id}`} checked={slot === k} disabled={isViewer || !l} data-testid="ops-leg-now" onChange={() => save({ leg: k })} />
                  {`Leg ${k}`}
                </label>
                {slot === k && <span className="text-accent">Now</span>}
              </div>
              <PlaceSelect view={view} value={l?.to ?? ''} none="Not used" name={`Leg ${k} goes to`} disabled={isViewer} testid="ops-leg-to" onChange={(to) => save({ [`to${k}`]: to, [`spot${k}`]: '' })} />
              {l && (
                <div className="mt-1 grid grid-cols-2 gap-2">
                  <label className={label}>
                    Spot
                    <select value={l.spot} disabled={isViewer} data-testid="ops-leg-spot" className={field} onChange={(e) => save({ [`spot${k}`]: e.target.value })}>
                      <option value="">Any</option>
                      {spotGone && <option value={l.spot}>One that was deleted (any)</option>}
                      {spots.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name || 'A spot'}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={label}>
                    Load
                    <select value={l.load} disabled={isViewer} data-testid="ops-leg-load" className={field} onChange={(e) => save({ [`load${k}`]: e.target.value })}>
                      {(['', 'empty', 'loaded'] as const).map((v) => (
                        <option key={v} value={v}>
                          {LOAD_LABELS[v]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className={label + ' col-span-2'}>
                    Note
                    <TextField name={`Leg ${k} note`} value={l.note} max={OPS_LIMITS.note} disabled={isViewer} onSave={(v) => save({ [`note${k}`]: v })} />
                  </label>
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {!isViewer && (
        <div className="flex flex-wrap gap-2">
          {car && <Delivered doc={doc} net={net} states={states} view={view} car={car} touch={touch} />}
          {slot === 0 && w.legs.some(Boolean) && (
            <button type="button" className={btn} data-testid="ops-restart" onClick={() => restartWaybill(doc, w.id)}>
              Start it again
            </button>
          )}
          <button
            type="button"
            className={btn + ' text-red-700 dark:text-red-300'}
            data-testid="ops-waybill-delete"
            onClick={() => {
              void confirmDelete('this waybill', { removes: car ? `The waybill for ${carName(view, car)}.` : 'The waybill.', keeps: 'The car stays where it is.', undoable: true }).then((ok) => {
                if (!ok) return;
                removeWaybill(doc, w.id);
                onBack();
              });
            }}
          >
            Delete this waybill
          </button>
        </div>
      )}
    </div>
  );
}

const moves = (list: { setOut: unknown[]; pickUp: unknown[] }[]) => list.reduce((n, s) => n + s.setOut.length + s.pickUp.length, 0);

function Jobs({ doc, view, isViewer, onOpen, touch }: { doc: Y.Doc; view: OpsView; isViewer: boolean; onOpen: (id: string) => void; touch: boolean }) {
  return (
    <>
      {!isViewer && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={primary}
            data-testid="ops-new-job"
            disabled={view.jobs.length >= OPS_LIMITS.jobs}
            onClick={() => {
              const id = addJob(doc);
              if (id) onOpen(id);
            }}
          >
            New job
          </button>
          <HelpButton helpKey="ops.job" />
        </div>
      )}
      {view.jobs.length === 0 && <p className="text-muted">No jobs yet. A job is one crew’s work: the places it stops at, in order. Cars with a waybill are given to the first job that can take them.</p>}
      <ul className="flex flex-col gap-1.5" aria-label="Jobs">
        {view.jobs.map((j, i) => {
          const n = moves(view.routing.lists.get(j.id) ?? []);
          return (
            <li key={j.id} data-job={j.id} className={card + ' flex items-center gap-2'}>
              <div className="min-w-0 flex-1">
                <button type="button" className={'block w-full truncate text-left font-semibold hover:underline' + (touch ? ' min-h-11' : '')} onClick={() => onOpen(j.id)}>
                  {j.name || 'A job'}
                </button>
                <p className="truncate text-xs text-muted" data-testid="ops-job-moves">
                  {JOB_KIND_LABEL[j.kind] ?? j.kind} · {j.stops.length === 1 ? '1 stop' : `${j.stops.length} stops`} · {n === 0 ? 'no work' : n === 1 ? '1 move' : `${n} moves`}
                </p>
              </div>
              {!isViewer && <UpDown name={j.name} first={i === 0} last={i === view.jobs.length - 1} touch={touch} onMove={(d) => moveJob(doc, j.id, d)} />}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function UpDown({ name, first, last, onMove, touch }: { name: string; first: boolean; last: boolean; onMove: (d: -1 | 1) => void; touch: boolean }) {
  const cls = btn + (touch ? ' h-11 w-11' : '');
  return (
    <span className="flex gap-1">
      <button type="button" className={cls} disabled={first} aria-label={`Move ${name} up`} onClick={() => onMove(-1)}>
        ↑
      </button>
      <button type="button" className={cls} disabled={last} aria-label={`Move ${name} down`} onClick={() => onMove(1)}>
        ↓
      </button>
    </span>
  );
}

function JobEditor({ doc, view, isViewer, job, show, onBack, touch = false }: Props & { job: Job; show: (car: string) => void; onBack: () => void }) {
  const kinds = (JOB_KINDS as readonly string[]).includes(job.kind) ? JOB_KINDS : [...JOB_KINDS, job.kind];
  const broken = new Set(brokenStops(job.stops.map((s) => s.place), view.opsPlaces));
  const trains = view.trains.filter((t) => !t.cut);
  const list = view.routing.lists.get(job.id) ?? [];
  return (
    <div className="flex flex-col gap-2" data-testid="ops-job">
      <Head text="All jobs" onBack={onBack} touch={touch}>
        <HelpButton helpKey="ops.job" />
      </Head>
      <label className={label}>
        Name
        <TextField name="Name" value={job.name} max={OPS_LIMITS.name} disabled={isViewer} required testid="ops-job-name" onSave={(name) => saveJob(doc, job.id, { name })} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className={label}>
          Kind
          <select value={job.kind} disabled={isViewer} data-testid="ops-job-kind" className={field} onChange={(e) => saveJob(doc, job.id, { kind: e.target.value })}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {JOB_KIND_LABEL[k] ?? k}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Train
          <select value={job.train} disabled={isViewer} data-testid="ops-job-train" className={field} onChange={(e) => saveJob(doc, job.id, { train: e.target.value })}>
            <option value="">None yet</option>
            {job.train && !trains.some((t) => t.id === job.train) && <option value={job.train}>A train that was deleted</option>}
            {trains.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name || 'Train'}
              </option>
            ))}
          </select>
        </label>
      </div>
      {JOB_KIND_HINT[job.kind] && <p className="text-xs text-muted">{JOB_KIND_HINT[job.kind]}</p>}
      <section aria-label="Stops" className="flex flex-col gap-1">
        <h4 className="text-xs font-semibold">Stops</h4>
        <ol className="flex flex-col gap-1" data-testid="ops-stops">
          {job.stops.map((s, i) => (
            <li key={s.id} className="flex flex-col text-xs">
              <span className="flex items-center gap-1">
                <span className="w-4 text-right text-muted">{i + 1}</span>
                <span className={'min-w-0 flex-1 truncate' + (view.placeById.has(s.place) ? '' : ' text-amber-700 dark:text-amber-300')}>{placeName(view, s.place)}</span>
                {!isViewer && (
                  <>
                    <UpDown name={placeName(view, s.place)} first={i === 0} last={i === job.stops.length - 1} touch={touch} onMove={(d) => moveStop(doc, job.id, s.id, d)} />
                    <button type="button" className={btn + (touch ? ' h-11' : '')} aria-label={`Remove ${placeName(view, s.place)}`} onClick={() => removeStop(doc, job.id, s.id)}>
                      ×
                    </button>
                  </>
                )}
              </span>
              {broken.has(i) && <span className="pl-5 text-amber-700 dark:text-amber-300">No track joins the stop before to {placeName(view, s.place)}.</span>}
            </li>
          ))}
        </ol>
        {!isViewer && job.stops.length < OPS_LIMITS.stops && (
          <PlaceSelect view={view} value="" none={job.stops.length ? 'Add a stop…' : 'Add its first stop…'} name="Add a stop" testid="ops-add-stop" onChange={(p) => p && addStop(doc, job.id, p)} />
        )}
      </section>
      <section aria-label="Switch list" data-testid="ops-switch-list" className={card}>
        <h4 className="flex items-center gap-1 text-xs font-semibold">
          Switch list <HelpButton helpKey="ops.switchList" />
        </h4>
        {moves(list) === 0 ? (
          <p className="text-xs text-muted">{job.stops.length === 0 ? 'Add the places it stops at.' : 'Nothing to do: no car goes by this job now.'}</p>
        ) : (
          <ol className="flex flex-col gap-1 text-xs">
            {list.map((s, i) =>
              s.setOut.length + s.pickUp.length === 0 ? null : (
                <li key={i} data-stop={i}>
                  <b>
                    {i + 1}. {placeName(view, s.place)}
                  </b>
                  <ul className="pl-4">
                    {s.setOut.map((m) => (
                      <ListCar key={`o${m.car}`} view={view} car={m.car} show={show} text={`Set out ${carName(view, m.car)}${m.spot ? ` at ${view.placeById.get(s.place)?.place.spots.find((x) => x.id === m.spot)?.name || 'a spot'}` : ''}`} />
                    ))}
                    {s.pickUp.map((m) => (
                      <ListCar key={`p${m.car}`} view={view} car={m.car} show={show} text={`Pick up ${carName(view, m.car)} for ${placeName(view, m.to)}`} />
                    ))}
                  </ul>
                </li>
              ),
            )}
          </ol>
        )}
      </section>
      {!isViewer && (
        <button
          type="button"
          className={btn + ' self-start text-red-700 dark:text-red-300'}
          data-testid="ops-job-delete"
          onClick={() => {
            void confirmDelete(job.name || 'this job', { removes: 'The job and its list of stops.', keeps: 'Its cars and their waybills stay; another job takes them, or they’re listed under Can’t route.', undoable: true }).then((ok) => {
              if (!ok) return;
              removeJob(doc, job.id);
              onBack();
            });
          }}
        >
          Delete this job
        </button>
      )}
    </div>
  );
}

function ListCar({ view, car, show, text }: { view: OpsView; car: string; show: (car: string) => void; text: string }) {
  return (
    <li className="flex items-center gap-1" data-car={car}>
      <span className="min-w-0 flex-1">{text}</span>
      {view.points.has(car) && (
        <button type="button" className="rounded px-1 text-[11px] underline" onClick={() => show(car)}>
          Show me
        </button>
      )}
    </li>
  );
}
