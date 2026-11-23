// The Trains panel (trains design 6.4): two lists. Rolling stock is the
// layout's engines and cars: make a quick one, change it, bring one in from
// your roster or a club's, save one to a roster, or tick a few and make a
// train of them. Trains are cars in order: put one on the track with a
// click, turn it around, take it off again. Every change is one undo step
// and everyone editing the layout sees it at once. The desktop's
// ui/TrainsPanel.cpp is the twin.

import { useMemo, useState } from 'react';
import type * as Y from 'yjs';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { turnedAround, type FitCheck, type PlacedTrain, type RollingStock, type Train, type TrackNetwork } from '@cld/parts-catalog/browser';
import { api, type PartWire, type RosterStock } from '../api';
import { formatLength } from '../venues/designer/units';
import { useLengthUnit } from '../theme/PrefsProvider';
import { HelpButton } from '../help/HelpButton';
import { SaveToPicker } from '../owners/OwnerControls';
import { useEditorStore } from './editorStore';
import { FitChecksList } from './FitChecksList';
import type { namesOf } from './fitChecks';
import { StockEditor } from './StockEditor';
import { kmhToShown, speedToKmh, usesMiles } from './trainRun';
import {
  copyOf,
  forRoster,
  fromRoster,
  KIND_LABELS,
  newStock,
  newTrain,
  removeStock,
  removeTrain,
  rosterIsNewer,
  saveStock,
  saveTrain,
  stockLabel,
  trainLength,
  trainState,
  trainsWith,
  updatedFromRoster,
  type TrainState,
} from './trains';

interface Props {
  doc: Y.Doc;
  net: TrackNetwork | null;
  stock: readonly RollingStock[];
  trains: readonly Train[];
  placed: ReadonlyMap<string, PlacedTrain | null>;
  switchStates: Readonly<Record<string, number>>;
  parts: readonly PartWire[];
  isViewer: boolean;
  /** Signed in with a real account: rosters are offered. */
  canUseRoster: boolean;
  /** The fit checks for the trains on the map (routes' are in the Routes panel). */
  checks: readonly FitCheck[];
  names: ReturnType<typeof namesOf>;
}

const btn = 'rounded border border-border px-2 py-1 text-xs hover:bg-soft disabled:opacity-50';
const quiet = 'rounded px-2 py-1 text-xs hover:bg-soft';
const primary = 'h-9 rounded-control bg-accent px-3 text-xs font-bold text-accent-ink hover:bg-accent-hover disabled:opacity-50';

function Dot({ color }: { color: string }) {
  return <span aria-hidden className="h-3 w-3 shrink-0 rounded-sm border border-black/20" style={{ background: color }} />;
}

const STATE_TEXT: Record<TrainState, string> = {
  off: 'Not on the map',
  ok: 'On the track',
  offEnd: 'Runs off the end of the track',
  lost: 'Its track was moved or removed',
};

function StateChip({ state }: { state: TrainState }) {
  const tone =
    state === 'ok'
      ? 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200'
      : state === 'off'
        ? 'bg-soft text-muted'
        : 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200';
  return (
    <span data-testid="train-state" className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>
      {STATE_TEXT[state]}
    </span>
  );
}

/** The units of a train being made or changed. */
function TrainEditor({
  initial,
  stock,
  onSave,
  onCancel,
}: {
  initial: Train;
  stock: readonly RollingStock[];
  onSave: (t: Train) => void;
  onCancel: () => void;
}) {
  const unit = useLengthUnit();
  const [t, setT] = useState(initial);
  const [speedText, setSpeedText] = useState(() => String(kmhToShown(initial.speed, unit)));
  const [adding, setAdding] = useState(stock[0]?.id ?? '');
  const byId = useMemo(() => new Map(stock.map((s) => [s.id, s])), [stock]);
  const move = (i: number, d: number) =>
    setT((cur) => {
      const units = [...cur.units];
      const j = i + d;
      if (j < 0 || j >= units.length) return cur;
      [units[i], units[j]] = [units[j]!, units[i]!];
      return { ...cur, units };
    });
  return (
    <form
      className="flex flex-col gap-2 rounded-card border border-line bg-panel p-2"
      data-testid="train-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (t.units.length) onSave({ ...t, name: t.name.trim() || 'Train' });
      }}
    >
      <div className="flex items-center gap-1 font-semibold">
        {initial.units.length ? 'Change train' : 'New train'}
        <HelpButton helpKey="trains.newTrain" />
      </div>
      <label className="block text-xs">
        <span className="text-muted">Name</span>
        <input className="h-8 w-full rounded border border-border bg-bg px-2 text-sm" aria-label="Train name" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} autoFocus />
      </label>
      <ol className="flex flex-col gap-1" aria-label="Cars in the train, front first">
        {t.units.map((u, i) => {
          const s = byId.get(u.stock);
          return (
            <li key={i} className="flex items-center gap-1 rounded border border-border px-1 py-0.5 text-xs" data-unit={u.stock}>
              <span className="w-4 text-right text-muted">{i + 1}</span>
              {s && <Dot color={s.look.color} />}
              <span className="min-w-0 flex-1 truncate">{s ? stockLabel(s) : 'A car that was deleted'}</span>
              <button type="button" className={quiet} aria-pressed={u.reversed} title="Turn this car around" onClick={() => setT({ ...t, units: t.units.map((x, k) => (k === i ? { ...x, reversed: !x.reversed } : x)) })}>
                {u.reversed ? '⇠ Turned' : '⇢'}
              </button>
              <button type="button" className={quiet} aria-label={`Move car ${i + 1} forward`} disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </button>
              <button type="button" className={quiet} aria-label={`Move car ${i + 1} back`} disabled={i === t.units.length - 1} onClick={() => move(i, 1)}>
                ↓
              </button>
              <button type="button" className={quiet} aria-label={`Take car ${i + 1} out`} onClick={() => setT({ ...t, units: t.units.filter((_, k) => k !== i) })}>
                ✕
              </button>
            </li>
          );
        })}
      </ol>
      {stock.length === 0 ? (
        <p className="text-xs text-muted">This layout has no cars yet. Make one in Rolling stock first.</p>
      ) : (
        <div className="flex gap-1">
          <select className="h-8 min-w-0 flex-1 rounded border border-border bg-bg px-1 text-xs" aria-label="Car to add" value={adding} onChange={(e) => setAdding(e.target.value)}>
            {stock.map((s) => (
              <option key={s.id} value={s.id}>
                {stockLabel(s)}
              </option>
            ))}
          </select>
          <button type="button" className={btn} data-testid="train-add-unit" disabled={!adding} onClick={() => setT({ ...t, units: [...t.units, { stock: adding, reversed: false }] })}>
            Add to the end
          </button>
        </div>
      )}
      <label className="flex items-center gap-1 text-xs">
        <span className="text-muted">Speed</span>
        <input
          type="number"
          min={1}
          max={500}
          step={1}
          aria-label="Train speed"
          data-testid="train-speed"
          className="h-8 w-20 rounded border border-border bg-bg px-2 text-sm"
          value={speedText}
          onChange={(e) => {
            setSpeedText(e.target.value);
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v > 0 && v <= 500) setT({ ...t, speed: Math.round(speedToKmh(v, unit) * 100) / 100 });
          }}
        />
        <span className="text-muted">{usesMiles(unit) ? 'mph' : 'km/h'} at scale</span>
        <HelpButton helpKey="trains.speed" />
      </label>
      <p className="text-xs text-muted">Length {formatLength(trainLength(t, byId), unit)}</p>
      <div className="flex gap-2">
        <button type="submit" className={primary} disabled={t.units.length === 0} data-testid="train-save">
          Save train
        </button>
        <button type="button" className={quiet} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Your roster and your clubs': add one to this layout, or update the layout's copy. */
function RosterPicker({ doc, stock, onClose }: { doc: Y.Doc; stock: readonly RollingStock[]; onClose: () => void }) {
  const qc = useQueryClient();
  const roster = useQuery({ queryKey: ['rolling-stock'], queryFn: () => api.rollingStock.list() });
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const removeEntry = async (e: RosterStock) => {
    try {
      await api.rollingStock.remove(e.id);
      setMessage(`Took “${e.number || e.name}” off the roster. Layouts keep their copies.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'It couldn’t be taken off the roster. Try again.');
    }
    setConfirmDelete(null);
    void qc.invalidateQueries({ queryKey: ['rolling-stock'] });
  };
  const entries = roster.data?.stock ?? [];
  const add = (e: RosterStock) => {
    const mine = copyOf(e.id, stock);
    if (mine) {
      saveStock(doc, updatedFromRoster(mine, e.record));
      setMessage(`Updated “${e.number || e.name}” from the roster.`);
    } else {
      saveStock(doc, fromRoster(e.record));
      setMessage(`Added “${e.number || e.name}” to this layout.`);
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-card border border-line bg-panel p-2" data-testid="roster-picker">
      <div className="flex items-center gap-1 font-semibold">
        From a roster <HelpButton helpKey="trains.roster" />
        <button type="button" className={`${quiet} ml-auto`} onClick={onClose}>
          Done
        </button>
      </div>
      {message && (
        <p role="status" className="rounded-md bg-soft px-2 py-1 text-xs">
          {message}
        </p>
      )}
      {roster.isLoading ? (
        <p className="text-xs text-muted">Loading your rosters…</p>
      ) : roster.isError ? (
        <p className="text-xs text-red-700 dark:text-red-300">Your rosters couldn’t be loaded. Check your connection and try again.</p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-muted">Your roster is empty. Save a car from this layout to your roster, or a club’s, to use it in other layouts.</p>
      ) : (
        <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto" aria-label="Roster">
          {entries.map((e) => {
            const mine = copyOf(e.id, stock);
            const newer = mine ? rosterIsNewer(mine, e) : false;
            return (
              <li key={e.id} className="flex items-center gap-2 rounded border border-border px-2 py-1 text-xs" data-roster={e.id}>
                <Dot color={typeof (e.record.look as { color?: unknown } | undefined)?.color === 'string' ? ((e.record.look as { color: string }).color) : '#888888'} />
                <span className="min-w-0 flex-1 truncate">
                  {[e.number, e.name].filter(Boolean).join(' ') || 'Unnamed'}
                  <span className="text-muted"> · {e.owner?.kind === 'org' ? e.owner.name : 'Yours'}</span>
                </span>
                {mine && !newer ? (
                  <span className="text-muted">In this layout</span>
                ) : (
                  <button type="button" className={btn} onClick={() => add(e)}>
                    {newer ? 'Update' : 'Add'}
                  </button>
                )}
                {e.canManage &&
                  (confirmDelete === e.id ? (
                    <span className="flex items-center gap-1">
                      <button type="button" className="rounded bg-red-700 px-2 py-1 font-semibold text-white" onClick={() => void removeEntry(e)}>
                        Take off
                      </button>
                      <button type="button" className={quiet} onClick={() => setConfirmDelete(null)}>
                        Keep
                      </button>
                    </span>
                  ) : (
                    <button type="button" className={quiet} aria-label={`Take ${[e.number, e.name].filter(Boolean).join(' ') || 'it'} off the roster`} onClick={() => setConfirmDelete(e.id)}>
                      ✕
                    </button>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Save a layout car to a roster (yours or a club's), or its changes back to the roster it came from. */
function SaveToRoster({ doc, s, onClose }: { doc: Y.Doc; s: RollingStock; onClose: () => void }) {
  const qc = useQueryClient();
  const orgs = useQuery({ queryKey: ['orgs'], queryFn: api.orgs.list });
  const roster = useQuery({ queryKey: ['rolling-stock'], queryFn: () => api.rollingStock.list() });
  const linked = s.libraryId ? roster.data?.stock.find((e) => e.id === s.libraryId) : undefined;
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = (e: RosterStock) => {
    // The layout's copy now points at the roster's entry, at its version.
    saveStock(doc, { ...s, libraryId: e.id, libraryVersion: e.version });
    void qc.invalidateQueries({ queryKey: ['rolling-stock'] });
    onClose();
  };
  const run = async (f: () => Promise<RosterStock>) => {
    setBusy(true);
    setError(null);
    try {
      done(await f());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'It couldn’t be saved. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-1 flex flex-col gap-2 rounded border border-border p-2 text-xs" data-testid="save-to-roster">
      {linked?.canManage && (
        <button type="button" className={btn} disabled={busy} onClick={() => void run(() => api.rollingStock.update(linked.id, forRoster(s)))}>
          Save changes to {linked.owner?.kind === 'org' ? `${linked.owner.name}’s roster` : 'your roster'}
        </button>
      )}
      <SaveToPicker value={target} onChange={setTarget} orgs={orgs.data?.orgs} kind="module" />
      <div className="flex gap-1">
        <button type="button" className={btn} disabled={busy} data-testid="save-to-roster-go" onClick={() => void run(() => api.rollingStock.create(forRoster(s), target || undefined))}>
          {linked ? 'Save as a new roster car' : 'Save to roster'}
        </button>
        <button type="button" className={quiet} onClick={onClose}>
          Cancel
        </button>
      </div>
      {error && <p className="text-red-700 dark:text-red-300">{error}</p>}
    </div>
  );
}

export function TrainsPanel({ doc, net, stock, trains, placed, switchStates, parts, isViewer, canUseRoster, checks, names }: Props) {
  const unit = useLengthUnit();
  const placing = useEditorStore((s) => s.trainPlacing);
  const [tab, setTab] = useState<'trains' | 'stock'>(() => (stock.length === 0 ? 'stock' : 'trains'));
  const [editingStock, setEditingStock] = useState<{ s: RollingStock; isNew: boolean } | null>(null);
  const [editingTrain, setEditingTrain] = useState<Train | null>(null);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [savingToRoster, setSavingToRoster] = useState<string | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const byId = useMemo(() => new Map(stock.map((s) => [s.id, s])), [stock]);
  const roster = useQuery({ queryKey: ['rolling-stock'], queryFn: () => api.rollingStock.list(), enabled: canUseRoster && !isViewer && stock.some((s) => !!s.libraryId) });
  const rosterById = useMemo(() => new Map((roster.data?.stock ?? []).map((e) => [e.id, e])), [roster.data]);
  const hasTrack = !!net && net.brickIds.length > 0;

  const tabBtn = (id: 'trains' | 'stock', label: string, n: number) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      data-testid={`trains-tab-${id}`}
      onClick={() => setTab(id)}
      className={`flex-1 rounded px-2 py-1 text-xs font-semibold ${tab === id ? 'bg-accent text-accent-ink' : 'hover:bg-soft'}`}
    >
      {label} ({n})
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 text-sm" data-testid="trains-panel">
      <div role="tablist" aria-label="Trains or rolling stock" data-tour="trainsPanel.tabs" className="flex gap-1">
        {tabBtn('trains', 'Trains', trains.length)}
        {tabBtn('stock', 'Rolling stock', stock.length)}
      </div>
      {message && (
        <p role="status" className="rounded-md bg-soft px-2 py-1 text-xs">
          {message}
        </p>
      )}

      {tab === 'stock' && (
        <>
          {!isViewer && !editingStock && (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className={primary} data-testid="stock-new" onClick={() => setEditingStock({ s: newStock({}, stock), isNew: true })}>
                New car
              </button>
              <HelpButton helpKey="trains.newStock" />
              {canUseRoster && (
                <button type="button" className={btn} data-testid="roster-open" data-tour="trains.roster" onClick={() => setRosterOpen(!rosterOpen)}>
                  From a roster
                </button>
              )}
            </div>
          )}
          {editingStock && (
            <StockEditor
              key={editingStock.s.id}
              initial={editingStock.s}
              isNew={editingStock.isNew}
              parts={parts}
              onCancel={() => setEditingStock(null)}
              onSave={(s) => {
                saveStock(doc, s);
                setEditingStock(null);
                setMessage(editingStock.isNew ? `Added ${stockLabel(s)}.` : `Saved ${stockLabel(s)}.`);
              }}
            />
          )}
          {rosterOpen && canUseRoster && !isViewer && <RosterPicker doc={doc} stock={stock} onClose={() => setRosterOpen(false)} />}
          {stock.length === 0 ? (
            <p className="text-muted">No rolling stock yet. Press New car: a number and a length is all a quick car needs.</p>
          ) : (
            <>
              <ul className="flex flex-col gap-1.5" aria-label="Rolling stock">
                {stock.map((s) => {
                  const inTrains = trainsWith(s.id, trains);
                  const entry = s.libraryId ? rosterById.get(s.libraryId) : undefined;
                  return (
                    <li key={s.id} data-stock={s.id} className="rounded-card border border-line bg-panel p-2">
                      <div className="flex items-center gap-2">
                        {!isViewer && (
                          <input
                            type="checkbox"
                            aria-label={`Pick ${stockLabel(s)} for a new train`}
                            checked={ticked.includes(s.id)}
                            onChange={(e) => setTicked(e.target.checked ? [...ticked, s.id] : ticked.filter((x) => x !== s.id))}
                          />
                        )}
                        <Dot color={s.look.color} />
                        <span className="min-w-0 flex-1 truncate font-semibold" title={stockLabel(s)}>
                          {stockLabel(s)}
                        </span>
                        <span className="text-xs text-muted" data-testid="stock-length-shown">
                          {formatLength(s.length, unit)}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted">
                        <span>{KIND_LABELS[s.kind]}</span>
                        {inTrains.length > 0 && <span>In {inTrains.map((t) => t.name).join(', ')}</span>}
                        {s.libraryId && <span>{entry && rosterIsNewer(s, entry) ? 'The roster has a newer version' : 'From a roster'}</span>}
                      </div>
                      {!isViewer && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          <button type="button" className={quiet} onClick={() => setEditingStock({ s, isNew: false })}>
                            Change
                          </button>
                          {entry && rosterIsNewer(s, entry) && (
                            <button
                              type="button"
                              className={btn}
                              onClick={() => {
                                saveStock(doc, updatedFromRoster(s, entry.record));
                                setMessage(`Updated ${stockLabel(s)} from the roster.`);
                              }}
                            >
                              Update from roster
                            </button>
                          )}
                          {canUseRoster && (
                            <button type="button" className={quiet} onClick={() => setSavingToRoster(savingToRoster === s.id ? null : s.id)}>
                              Save to roster
                            </button>
                          )}
                          {confirmDelete === s.id ? (
                            <span className="flex flex-wrap items-center gap-1 text-xs">
                              {inTrains.length ? `Delete it and take it out of ${inTrains.length === 1 ? inTrains[0]!.name : `${inTrains.length} trains`}?` : `Delete ${stockLabel(s)}?`}
                              <button type="button" className="rounded bg-red-700 px-2 py-1 font-semibold text-white" onClick={() => { removeStock(doc, s.id, trains); setConfirmDelete(null); }}>
                                Delete
                              </button>
                              <button type="button" className={quiet} onClick={() => setConfirmDelete(null)}>
                                Keep
                              </button>
                            </span>
                          ) : (
                            <button type="button" className={quiet} onClick={() => setConfirmDelete(s.id)}>
                              Delete
                            </button>
                          )}
                        </div>
                      )}
                      {savingToRoster === s.id && <SaveToRoster doc={doc} s={s} onClose={() => setSavingToRoster(null)} />}
                    </li>
                  );
                })}
              </ul>
              {!isViewer && ticked.length > 0 && (
                <button
                  type="button"
                  className={primary}
                  data-testid="train-from-ticked"
                  onClick={() => {
                    const t = newTrain(`Train ${trains.length + 1}`, ticked.filter((id) => byId.has(id)).map((id) => ({ stock: id, reversed: false })), trains);
                    saveTrain(doc, t);
                    setTicked([]);
                    setTab('trains');
                    setMessage(`Made ${t.name} from ${t.units.length === 1 ? '1 car' : `${t.units.length} cars`}. Put it on the track to see it.`);
                  }}
                >
                  Make a train of {ticked.length === 1 ? 'this car' : `these ${ticked.length} cars`}
                </button>
              )}
            </>
          )}
        </>
      )}

      {tab === 'trains' && (
        <>
          {!isViewer && !editingTrain && (
            <div className="flex items-center gap-2">
              <button type="button" className={primary} data-testid="train-new" onClick={() => setEditingTrain(newTrain('', [], trains))}>
                New train
              </button>
              <HelpButton helpKey="trains.newTrain" />
            </div>
          )}
          {editingTrain && (
            <TrainEditor
              key={editingTrain.id}
              initial={editingTrain}
              stock={stock}
              onCancel={() => setEditingTrain(null)}
              onSave={(t) => {
                saveTrain(doc, t);
                setEditingTrain(null);
                setMessage(`Saved ${t.name}.`);
              }}
            />
          )}
          {trains.some((t) => t.position) && (
            <FitChecksList checks={checks.filter((c) => c.train)} names={names} allClear="Every train on the track fits: nothing too long, too tight or too close." />
          )}
          {trains.length === 0 ? (
            <p className="text-muted">
              No trains yet. {stock.length === 0 ? 'Make a car or two in Rolling stock first, then put them together here.' : 'Press New train, or tick cars in Rolling stock and make a train of them.'}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5" aria-label="Trains">
              {trains.map((t) => {
                const p = placed.get(t.id);
                const state = trainState(t, p);
                const isPlacing = placing === t.id;
                return (
                  <li key={t.id} data-train={t.id} className="rounded-card border border-line bg-panel p-2">
                    <div className="flex items-center gap-2">
                      <Dot color={t.color} />
                      <span className="min-w-0 flex-1 truncate font-semibold">{t.name || 'Untitled train'}</span>
                      <span className="text-xs text-muted" data-testid="train-length">
                        {formatLength(trainLength(t, byId), unit)}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                      <StateChip state={state} />
                      <span>{t.units.length === 1 ? '1 car' : `${t.units.length} cars`}</span>
                    </div>
                    {!isViewer && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        <span className="flex items-center gap-0.5">
                          <button
                            type="button"
                            className={btn}
                            data-testid="train-place"
                            aria-pressed={isPlacing}
                            disabled={!hasTrack || t.units.length === 0}
                            title={hasTrack ? undefined : 'There’s no track on this layout yet.'}
                            onClick={() => useEditorStore.getState().setTrainPlacing(isPlacing ? null : t.id)}
                          >
                            {isPlacing ? 'Click the track…' : t.position ? 'Move' : 'Put on the track'}
                          </button>
                          <HelpButton helpKey="trains.putOnTrack" />
                        </span>
                        {t.position && net && (
                          <span className="flex items-center gap-0.5">
                            <button
                              type="button"
                              className={btn}
                              data-testid="train-turn"
                              onClick={() => {
                                saveTrain(doc, turnedAround(net, t, byId, switchStates));
                                setMessage(`${t.name} turned around.`);
                              }}
                            >
                              Turn around
                            </button>
                            <HelpButton helpKey="trains.turnAround" />
                          </span>
                        )}
                        {t.position && (
                          <button type="button" className={quiet} onClick={() => saveTrain(doc, { ...t, position: null })}>
                            Take off the track
                          </button>
                        )}
                        <button type="button" className={quiet} onClick={() => setEditingTrain(t)}>
                          Change
                        </button>
                        {confirmDelete === t.id ? (
                          <span className="flex items-center gap-1 text-xs">
                            Delete {t.name}? Its cars stay.
                            <button type="button" className="rounded bg-red-700 px-2 py-1 font-semibold text-white" onClick={() => { removeTrain(doc, t.id); setConfirmDelete(null); }}>
                              Delete
                            </button>
                            <button type="button" className={quiet} onClick={() => setConfirmDelete(null)}>
                              Keep
                            </button>
                          </span>
                        ) : (
                          <button type="button" className={quiet} onClick={() => setConfirmDelete(t.id)}>
                            Delete
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
